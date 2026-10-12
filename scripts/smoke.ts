/**
 * Smoke test for the embedded-host + protocol-client core, independent of
 * Electron. Boots `dsh web`, connects over the reused protocol layer, sends one
 * prompt, and streams the resulting events.
 *
 * Run with: npm run smoke
 */
import { startHost } from '../src/core/host'
import { NodeApiClient, ConnectionLoop } from '../src/core/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(content: any): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' || block?.type === 'reasoning')
    .map((block) => (block.type === 'reasoning' ? `[思考] ${block.text}` : block.text))
    .join('')
}

async function main(): Promise<void> {
  const workspaceDir = process.env.DSH_SMOKE_CWD ?? process.cwd()
  console.log('[smoke] booting embedded host…')
  const host = await startHost({ workspaceDir })
  console.log(`[smoke] host ready at ${host.baseUrl}`)

  const client = new NodeApiClient(host.baseUrl)
  let connectedResolve: (() => void) | undefined
  const connected = new Promise<void>((resolve) => {
    connectedResolve = resolve
  })

  let loop: ConnectionLoop | undefined
  try {
    loop = new ConnectionLoop(client, {
    onStateChange: (state) => console.log(`[smoke] connection: ${state}`),
    onConnected: (description) => {
      console.log('[smoke] connected, host description:', JSON.stringify(description).slice(0, 400))
      connectedResolve?.()
    },
    onMuxEnvelope: (envelope) => {
      void handleMux(envelope.payload)
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = []
  let targetSessionId: SessionId = '' as unknown as SessionId
  let resolveDone: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  let sawTurnStart = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleMux(frame: any): Promise<void> {
    if (frame?.type !== 'session/event') return
    const event = frame.event
    if (frame.sessionId !== targetSessionId) return
    events.push(event)
    switch (event.type) {
      case 'turn/start':
        sawTurnStart = true
        break
      case 'tool/call':
        console.log(`[smoke] tool call: ${event.data.name}`)
        break
      case 'assistant/message': {
        const text = extractText(event.data?.message?.content)
        if (text) console.log(`[smoke] assistant message: ${text.slice(0, 300)}`)
        break
      }
      case 'turn/end':
        if (sawTurnStart) resolveDone?.()
        break
    }
  }

    loop.start()
    await connected

    console.log('[smoke] listing sessions…')
    const listRes = await client.sessions.list({})
    console.log(`[smoke] existing sessions: ${listRes.result.ok ? listRes.result.value.items.length : listRes.result.error?.message}`)

    console.log('[smoke] creating session…')
    const createRes = await client.sessions.create({ cwd: workspaceDir })
    if (!createRes.result.ok) {
      throw new Error(`session.create failed: ${JSON.stringify(createRes.result)}`)
    }
    targetSessionId = createRes.result.value.sessionId
    console.log(`[smoke] session created: ${targetSessionId}`)

    console.log('[smoke] sending prompt…')
    const promptRes = await client.sessions.prompt({
      sessionId: targetSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '你好,请用一句话介绍你自己。' }]
    })
    if (!promptRes.result.ok) {
      throw new Error(`session.prompt failed: ${JSON.stringify(promptRes.result)}`)
    }
    console.log('[smoke] prompt accepted, waiting for turn to finish…')

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('smoke test timed out')), 180_000)
    )
    await Promise.race([done, timeout])

    console.log('[smoke] turn finished. Events seen:')
    for (const e of events) console.log(`  - ${e.type}`)
    const finalText = events
      .filter((e) => e.type === 'assistant/message')
      .map((e) => extractText(e.data?.message?.content))
      .join('\n')
    console.log(`[smoke] FINAL ANSWER:\n${finalText}`)
  } finally {
    // Every exit path (timeout, RPC failure, success) tears the host down;
    // the settle delay lets fire-and-forget taskkill finish before exit.
    loop?.stop()
    host.stop()
    await new Promise((r) => setTimeout(r, 500))
  }
}

main().catch((error) => {
  console.error('[smoke] FAILED:', error)
  process.exit(1)
})
