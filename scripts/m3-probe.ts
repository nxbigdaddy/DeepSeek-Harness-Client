/** Verify search + fork RPCs against a real host. */
import { startHost } from '../src/core/host'
import { NodeApiClient, ConnectionLoop } from '../src/core/client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const u = (resp: any, label: string): any => {
  if (!resp?.result?.ok) throw new Error(`${label}: ${JSON.stringify(resp?.result?.error)}`)
  return resp.result.value
}

async function main(): Promise<void> {
  const host = await startHost({})
  const client = new NodeApiClient(host.baseUrl)
  const loop = new ConnectionLoop(client)
  loop.start()
  await new Promise((r) => setTimeout(r, 1500))

  const sessions = u(await client.sessions.list({}), 'session.list')
  console.log(`[m3] sessions: ${sessions.items.length}`)

  if (sessions.items.length > 0) {
    const first = sessions.items[0]
    const fork = u(await client.sessions.fork({ sessionId: first.sessionId }), 'session.fork')
    console.log(`[m3] forked ${first.sessionId} -> ${fork.sessionId}`)
  }

  const search = u(await client.sessions.search({ query: '你好' }), 'session.search')
  console.log(`[m3] search('你好'): ${search.items.length} results, hasMore=${search.hasMore}`)
  for (const it of search.items.slice(0, 3)) console.log(`  - ${it.sessionId}: ${it.snippet.slice(0, 60)}`)

  loop.stop()
  host.stop()
  process.exit(0)
}

main().catch((e) => {
  console.error('[m3] FAILED:', e)
  process.exit(1)
})
