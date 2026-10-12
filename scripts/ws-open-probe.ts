/**
 * Verify "open an EXISTING project folder as a workspace" against a real host:
 *  1. workspace.create on an existing directory (this repo) -> adopted?
 *  2. workspace.create again on the same path -> created=false (idempotent)?
 *  3. workspace.create on a non-existent path -> what error?
 * Run with: npx tsx scripts/ws-open-probe.ts
 */
import { mkdtempSync } from 'node:fs'
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
  // Isolated DSH_HOME: probes must not write into the real user data dir.
  const host = await startHost({ dshHome: mkdtempSync(join(tmpdir(), 'dsh-probe-home-')) })
  console.log(`[probe] host ready at ${host.baseUrl}`)
  const client = new NodeApiClient(host.baseUrl)
  const loop = new ConnectionLoop(client, { onStateChange: (s) => console.log('[probe] conn', s) })
  loop.start()
  await new Promise((r) => setTimeout(r, 1500))

  try {
    const existingDir = process.cwd()
    console.log(`\n[1] workspace.create on EXISTING dir: ${existingDir}`)
    const first = u(await client.workspace.create({ path: existingDir }), 'workspace.create#1')
    console.log(`    -> created=${first.created} title="${first.workspace.title}" path=${first.workspace.path}`)

    console.log(`\n[2] workspace.create same path again (idempotency)`)
    const second = u(await client.workspace.create({ path: existingDir }), 'workspace.create#2')
    console.log(`    -> created=${second.created} sameId=${second.workspace.workspaceId === first.workspace.workspaceId}`)

    console.log(`\n[3] workspace.create on NON-EXISTENT path`)
    const mr = (await client.workspace.create({ path: join(existingDir, `no-such-dir-${Date.now()}`) }))?.result
    console.log(`    -> ok=${mr?.ok} error=${JSON.stringify(mr && !mr.ok ? mr.error : null)}`)

    console.log(`\n[4] host.listDirectory (browse capability composed?)`)
    const lr = (await client.host.listDirectory({}))?.result
    console.log(`    -> ok=${lr?.ok} error=${JSON.stringify(lr && !lr.ok ? lr.error : null)}`)

    // cleanup: remove the workspace we registered
    u(await client.workspace.delete({ workspaceId: first.workspace.workspaceId }), 'workspace.delete')
    console.log(`\n[cleanup] workspace deleted`)
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
