/** Verify tool-call `view` (ToolCallView/ToolResultView) flows from the host. */
import { startHost } from '../src/core/host'
import { NodeApiClient, ConnectionLoop } from '../src/core/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const u = (resp: any, label: string): any => {
  if (!resp?.result?.ok) throw new Error(`${label}: ${JSON.stringify(resp?.result?.error)}`)
  return resp.result.value
}

async function main(): Promise<void> {
  const host = await startHost({ workspaceDir: process.cwd() })
  const client = new NodeApiClient(host.baseUrl)

  let targetSessionId: SessionId = '' as unknown as SessionId
  let resolveDone: (() => void) | undefined
  const done = new Promise<void>((r) => (resolveDone = r))
  let sawStart = false
  const toolCalls: string[] = []

  const loop = new ConnectionLoop(client, {
    onMuxEnvelope: (env) => {
      const frame = env.payload
      if (frame?.type !== 'session/event' || frame.sessionId !== targetSessionId) return
      const ev = frame.event
      if (ev.type === 'turn/start') sawStart = true
      if (ev.type === 'tool/call') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = (frame.view as any)?.view
        toolCalls.push(`${ev.data.name} → callView.card=${v?.card ?? 'none'}`)
      }
      if (ev.type === 'tool/result') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = (frame.view as any)?.view
        toolCalls.push(`result → view.card=${v?.card ?? 'none'}`)
      }
      if (ev.type === 'turn/end' && sawStart) resolveDone?.()
    }
  })
  loop.start()
  await new Promise((r) => setTimeout(r, 1500))

  const created = u(await client.sessions.create({ cwd: process.cwd() }), 'session.create')
  targetSessionId = created.sessionId
  const p = u(
    await client.sessions.prompt({
      sessionId: targetSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '读取当前目录下的 package.json 文件,然后用一句话告诉我这个项目叫什么名字。' }]
    }),
    'session.prompt'
  )
  console.log('[m2] prompt accepted:', p.accepted)

  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 120_000))])
  console.log('[m2] tool views seen:')
  for (const t of toolCalls) console.log('  -', t)

  loop.stop()
  host.stop()
  process.exit(0)
}

main().catch((e) => {
  console.error('[m2] FAILED:', e)
  process.exit(1)
})
