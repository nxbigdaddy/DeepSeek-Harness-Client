/**
 * Verify workspace ordering RPCs against a real host (no Electron):
 *  1. create two workspaces + two sessions in ws-A, one in ws-B
 *  2. workspace.insertSessionBefore: reorder sessions inside ws-A
 *  3. workspace.insertSessionBefore with a foreign session -> workspace-move-invalid
 *  4. workspace.insertBefore: reorder workspaces (before anchor + append-to-end)
 * Run with: npx tsx scripts/ws-order-probe.ts
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHost } from '../src/core/host'
import { NodeApiClient, ConnectionLoop } from '../src/core/client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const u = (resp: any, label: string): any => {
  if (!resp?.result?.ok) throw new Error(`${label}: ${JSON.stringify(resp?.result?.error)}`)
  return resp.result.value
}

async function run(): Promise<void> {
  // Isolated DSH_HOME: sessions created here must not pollute the real list.
  const host = await startHost({ dshHome: mkdtempSync(join(tmpdir(), 'dsh-probe-home-')) })
  console.log(`[probe] host ready at ${host.baseUrl}`)
  const client = new NodeApiClient(host.baseUrl)
  const loop = new ConnectionLoop(client, {})
  loop.start()
  await new Promise((r) => setTimeout(r, 1500))

  try {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ws-order-'))
    const dirA = join(root, 'proj-a')
    const dirB = join(root, 'proj-b')
    mkdirSync(dirA)
    mkdirSync(dirB)

    const wsA = u(await client.workspace.create({ path: dirA }), 'create A').workspace
  const wsB = u(await client.workspace.create({ path: dirB }), 'create B').workspace
  const s1 = u(await client.sessions.create({ workspaceId: wsA.workspaceId }), 's1').sessionId
  const s2 = u(await client.sessions.create({ workspaceId: wsA.workspaceId }), 's2').sessionId
  const s3 = u(await client.sessions.create({ workspaceId: wsB.workspaceId }), 's3').sessionId
  console.log(`[1] wsA=${wsA.title} sessions=[s1,s2], wsB=${wsB.title} sessions=[s3]`)

  let list = u(await client.workspace.list({}), 'list')
  const idsOf = (id: string): string[] => list.items.find((w: { workspaceId: string }) => w.workspaceId === id)?.sessionIds ?? []
  console.log(`    wsA order: ${JSON.stringify(idsOf(wsA.workspaceId).map((x: string) => (x === s1 ? 's1' : x === s2 ? 's2' : '?')))}`)

  // real reorder: initial order is newest-first [s2, s1]; move s1 to the front
  u(await client.workspace.insertSessionBefore({ workspaceId: wsA.workspaceId, sessionId: s1, beforeSessionId: s2 }), 'move s1 before s2')
  list = u(await client.workspace.list({}), 'list2')
  const order = idsOf(wsA.workspaceId)
  console.log(`[2] after insertSessionBefore(s1 before s2): ${JSON.stringify(order.map((x: string) => (x === s1 ? 's1' : x === s2 ? 's2' : '?')))}`)
  if (order[0] !== s1 || order[1] !== s2) throw new Error('in-workspace reorder did not stick')

  // and back via append-to-end (anchor omitted)
  u(await client.workspace.insertSessionBefore({ workspaceId: wsA.workspaceId, sessionId: s1 }), 'move s1 to end')
  list = u(await client.workspace.list({}), 'list2b')
  const order2 = idsOf(wsA.workspaceId)
  console.log(`[2b] after insertSessionBefore(s1, no anchor): ${JSON.stringify(order2.map((x: string) => (x === s1 ? 's1' : x === s2 ? 's2' : '?')))}`)
  if (order2[0] !== s2 || order2[1] !== s1) throw new Error('append-to-end reorder did not stick')

  // foreign session into ws-A must fail (cwd-bound membership)
  const foreign = await client.workspace.insertSessionBefore({ workspaceId: wsA.workspaceId, sessionId: s3 })
  const foreignErr = foreign?.result && !foreign.result.ok ? foreign.result.error : null
  console.log(`[3] foreign session into wsA -> ${foreignErr ? `${foreignErr.code} (rejected as expected)` : 'UNEXPECTEDLY OK'}`)
  if (!foreignErr) throw new Error('cross-workspace move should be rejected')

  // workspace reorder: force B to end first (known state), then A before B? no —
  // A is already before B at that point; move B before A (a real change), then B back to end.
  u(await client.workspace.insertBefore({ workspaceId: wsB.workspaceId }), 'B to end (setup)')
  const before = u(await client.workspace.list({}), 'list3').items.map((w: { title: string }) => w.title)
  if (before[before.length - 1] !== wsB.title) throw new Error('append-to-end setup failed')
  u(await client.workspace.insertBefore({ workspaceId: wsB.workspaceId, beforeWorkspaceId: wsA.workspaceId }), 'B before A')
  const mid = u(await client.workspace.list({}), 'list4').items.map((w: { title: string }) => w.title)
  u(await client.workspace.insertBefore({ workspaceId: wsB.workspaceId }), 'B to end')
  const end = u(await client.workspace.list({}), 'list5').items.map((w: { title: string }) => w.title)
  console.log(`[4] workspace order: ${JSON.stringify(before)} -> B before A -> ${JSON.stringify(mid)} -> B to end -> ${JSON.stringify(end)}`)
  const aIdx = mid.indexOf(wsA.title)
  if (mid.indexOf(wsB.title) !== aIdx - 1) throw new Error('insert-before anchor did not stick')
  if (end[end.length - 1] !== wsB.title) throw new Error('workspace append-to-end did not stick')

  // cleanup
  u(await client.workspace.delete({ workspaceId: wsA.workspaceId }), 'del A')
  u(await client.workspace.delete({ workspaceId: wsB.workspaceId }), 'del B')
  console.log('[cleanup] workspaces deleted\n[probe] ALL OK')
  } finally {
    loop.stop()
    host.stop()
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function main(): Promise<void> {
  try {
    await run()
  } catch (e) {
    console.error('[probe] FAILED:', e)
    process.exit(1)
  }
}

void main()
