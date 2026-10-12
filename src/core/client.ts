/**
 * Node-side DSH protocol client. Reuses DSH's own `AbstractApiClient` (all the
 * typed RPC invariants, envelope wrap/unwrap and zod validation come for free)
 * and only supplies the platform aspects: Node `fetch` for unary/respond and
 * `ws` WebSockets for the two downlink event streams.
 *
 * The browser `WebApiClient` (in @deepseek-ai/dsh-client-connection) is the
 * same shape; this is its Node twin, wired for the Electron main process.
 */
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { muxFrameSchema, hostFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import WebSocket from 'ws'
import type { z } from 'zod'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = any

export class NodeApiClient extends AbstractApiClient {
  constructor(
    private readonly baseUrl: string,
    timeoutMs?: number
  ) {
    super(timeoutMs)
  }

  protected resolveBase(): string {
    return this.baseUrl
  }

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init)
  }

  protected openMux(_payload: unknown, signal: AbortSignal, onOpen?: () => void) {
    return this.readWebSocket('/api/events.mux', signal, muxFrameSchema as z.ZodType<AnyRecord>, onOpen)
  }

  protected openHost(_payload: unknown, signal: AbortSignal, onOpen?: () => void) {
    return this.readWebSocket('/api/events.host', signal, hostFrameSchema as z.ZodType<AnyRecord>, onOpen)
  }

  private async *readWebSocket(
    path: string,
    signal: AbortSignal,
    frameSchema: z.ZodType<AnyRecord>,
    onOpen?: () => void
  ): AsyncGenerator<AnyRecord> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)

    const inbox: Array<{ kind: 'frame'; envelope: AnyRecord } | { kind: 'end' }> = []
    let wake: (() => void) | undefined
    const enqueue = (item: { kind: 'frame'; envelope: AnyRecord } | { kind: 'end' }): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }

    socket.on('open', () => onOpen?.())
    socket.on('message', (data: unknown) => {
      try {
        const text = toText(data)
        const full = serverRequestSchema.parse(JSON.parse(text))
        const frame = frameSchema.parse(full.payload)
        this.onEnvelope(full)
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
      } catch (error) {
        console.error(`[client] dropping malformed WebSocket frame on ${path}:`, error)
      }
    })
    socket.on('close', () => enqueue({ kind: 'end' }))
    socket.on('error', () => {
      // close always follows; nothing to do here
    })

    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close()
      }
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()

    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift()!
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeAllListeners()
      handleAbort()
    }
  }
}

export interface ConnectionSinks {
  onMuxEnvelope?: (envelope: AnyRecord) => void
  onHostEnvelope?: (envelope: AnyRecord) => void
  onConnected?: (description: AnyRecord) => void
  onStateChange?: (state: 'connected' | 'reconnecting') => void
}

/** Normalize a `ws` message payload (string / Buffer / Buffer[]) to UTF-8 text. */
function toText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return String(data)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}

const DEFAULTS = { backoffBaseMs: 500, backoffFactor: 2, backoffMaxMs: 10_000 }

/**
 * Connect/pump/reconnect loop, a faithful port of DSH's `ConnectionController`
 * (which lives in the browser bundle only). Opens both downlink streams, runs
 * the `host.describe` handshake, and reconnects with exponential backoff.
 */
export class ConnectionLoop {
  private running = false
  private current: AbortController | null = null
  private lastState: 'connected' | 'reconnecting' | null = null

  constructor(
    private readonly api: NodeApiClient,
    private readonly sinks: ConnectionSinks = {}
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.current?.abort()
    this.current = null
  }

  private emitState(state: 'connected' | 'reconnecting'): void {
    if (this.lastState === state) return
    this.lastState = state
    try {
      this.sinks.onStateChange?.(state)
    } catch (error) {
      console.error('[client] state sink threw:', error)
    }
  }

  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[client] connection sink threw:', error)
    }
  }

  private async loop(): Promise<void> {
    let attempt = 0
    while (this.running) {
      const ac = new AbortController()
      this.current = ac
      try {
        // Either stream ending (host restart, stream/error frame, socket drop)
        // must fail the whole attempt: aborting the attempt controller closes
        // the sibling socket too, so Promise.all settles and we reconnect.
        // Without this, one dead stream left the other open and the loop
        // waited forever on a half-dead connection.
        const onStreamEnd = (): void => {
          ac.abort(new Error('downlink stream ended'))
        }
        const pump = Promise.all([
          this.pumpStream(this.api.events.mux({}, ac.signal), this.sinks.onMuxEnvelope).then(onStreamEnd),
          this.pumpStream(this.api.events.host({}, ac.signal), this.sinks.onHostEnvelope).then(onStreamEnd)
        ])
        const description = await this.api.host.describe({}, ac.signal)
        const result = description.result
        if (!result.ok) {
          throw new Error(`host.describe failed: ${result.error.code}: ${result.error.message}`)
        }
        attempt = 0
        this.emitState('connected')
        this.callSink(() => this.sinks.onConnected?.(result.value))
        await pump
      } catch {
        // describe failed while both sockets are healthy, or any other
        // generation error: abort the attempt controller so the streams are
        // always torn down before the next attempt — otherwise old sockets
        // leak and duplicate frames pile up across retries.
        ac.abort()
        // connection generation failed or a stream ended; fall through to reconnect
      }
      if (!this.running) return
      this.emitState('reconnecting')
      attempt += 1
      const cap = Math.min(DEFAULTS.backoffMaxMs, DEFAULTS.backoffBaseMs * DEFAULTS.backoffFactor ** Math.max(0, attempt - 1))
      await sleep(cap / 2 + Math.random() * (cap / 2), ac.signal)
    }
  }

  private async pumpStream(
    stream: AsyncIterable<AnyRecord>,
    sink?: (envelope: AnyRecord) => void
  ): Promise<void> {
    try {
      for await (const envelope of stream) {
        if (envelope?.payload?.type === 'stream/error') break
        if (sink !== undefined) this.callSink(() => sink(envelope))
      }
    } catch {
      // stream ended abnormally; the loop's outer catch handles reconnect
    }
  }
}
