/** Verify M4/M5 RPC surface (skills/presets/credentials/goals/subagents) against a real host. */
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
  const any = sessions.items[0]

  const created = u(await client.sessions.create({ cwd: process.cwd() }), 'session.create')
  console.log(`[m45] created attached session ${created.sessionId}`)

  const skills = u(await client.skills.list({ sessionId: created.sessionId }), 'skill.list')
  console.log(`[m45] skills: ${skills.skills.length} entries`)

  const presets = u(await client.agentPresets.list({}), 'agentPreset.list')
  console.log(`[m45] presets: ${presets.presets.length} (${presets.presets.map((p: any) => p.id).join(', ')})`)

  const creds = u(await client.credentials.describe({ refs: ['DEEPSEEK_API_KEY'] }), 'credentials.describe')
  console.log(`[m45] credentials: DEEPSEEK_API_KEY configured=${creds.credentials['DEEPSEEK_API_KEY']?.configured}`)

  const goal = u(await client.goals.create({ sessionId: created.sessionId, objective: 'probe goal', maxGoalRounds: 1 }), 'goal.create')
  console.log(`[m45] goal.create: ${goal.ref.id}@${goal.ref.revision}`)
  u(await client.goals.clear({ sessionId: created.sessionId, ref: goal.ref }), 'goal.clear')
  console.log('[m45] goal.clear ok')

  const subs = u(await client.subagents.list({ parentSessionId: any.sessionId }), 'subagent.list')
  console.log(`[m45] subagents of ${any.sessionId}: ${subs.entries.length} entries`)

  loop.stop()
  host.stop()
  process.exit(0)
}

main().catch((e) => {
  console.error('[m45] FAILED:', e)
  process.exit(1)
})
