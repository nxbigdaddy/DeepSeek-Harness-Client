/**
 * Probe the newly-wired RPC surface against a real host (no Electron).
 * Run with: npx tsx scripts/probe.ts
 */
import { startHost } from '../src/core/host'
import { NodeApiClient, ConnectionLoop } from '../src/core/client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const u = (resp: any, label: string): any => {
  if (!resp?.result?.ok) throw new Error(`${label}: ${JSON.stringify(resp?.result?.error)}`)
  return resp.result.value
}

async function main(): Promise<void> {
  const host = await startHost({})
  console.log(`[probe] host ready at ${host.baseUrl}`)
  const client = new NodeApiClient(host.baseUrl)
  const loop = new ConnectionLoop(client, { onStateChange: (s) => console.log('[probe] conn', s) })
  loop.start()
  await new Promise((r) => setTimeout(r, 1500))

  const settings = u(await client.settings.describe({}), 'settings.describe')
  console.log(`[probe] settings: writable=${settings.writable} hasDocument=${settings.hasDocument} namespaces=[${settings.namespaces.map((n: any) => n.ns).join(', ')}]`)

  const workspaces = u(await client.workspace.list({}), 'workspace.list')
  console.log(`[probe] workspaces: ${workspaces.items.length} items, archived=${workspaces.archivedSessionIds?.length}`)
  for (const w of workspaces.items) console.log(`  - ${w.title} (${w.path}) sessions=${w.sessionIds.length}`)

  const llm = u(await client.llm.models({}), 'llm.models')
  console.log(`[probe] llm models groups=[${llm.groups.map((g: any) => `${g.name}(${g.models.length})`).join(', ')}]`)

  const sessions = u(await client.sessions.list({}), 'session.list')
  if (sessions.items.length > 0) {
    const first = sessions.items[0]
    const models = u(await client.sessions.models({ sessionId: first.sessionId }), 'session.models')
    console.log(`[probe] session.models current=${models.current.provider}/${models.current.model} routable=${models.routable}`)
  }

  loop.stop()
  host.stop()
  process.exit(0)
}

main().catch((e) => {
  console.error('[probe] FAILED:', e)
  process.exit(1)
})
