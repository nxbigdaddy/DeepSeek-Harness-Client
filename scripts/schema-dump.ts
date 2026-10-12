/** Dump the settings schema shapes to inform the generic form renderer. */
import { startHost } from '../src/core/host'
import { NodeApiClient, ConnectionLoop } from '../src/core/client'
import { rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const u = (resp: any, label: string): any => {
  if (!resp?.result?.ok) throw new Error(`${label}: ${JSON.stringify(resp?.result?.error)}`)
  return resp.result.value
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describe(node: any, depth: number, maxDepth = 4): string {
  if (!node) return '?'
  const meta = node.meta ?? {}
  const parts: string[] = [node.type]
  if (meta.role) parts.push(`role=${meta.role}`)
  if (meta.default !== undefined) parts.push(`default=${JSON.stringify(meta.default)}`)
  if (node.type === 'object' && node.dict) {
    const keys = Object.keys(node.dict)
    if (depth >= maxDepth) return `${parts.join(' ')} {${keys.length} keys}`
    return `${parts.join(' ')} {\n${keys
      .map((k) => {
        const c = node.dict[k]
        const cm = c?.meta ?? {}
        const label = typeof cm.description === 'string' ? cm.description : k
        return '  '.repeat(depth + 1) + `${k} (${label}) : ${describe(c, depth + 1, maxDepth)}`
      })
      .join('\n')}\n${'  '.repeat(depth)}}`
  }
  if ((node.type === 'union' || node.type === 'intersect') && node.list) {
    return `${parts.join(' ')} [${node.list.map((m: any) => describe(m, depth + 1, 1)).join(' | ')}]`
  }
  if (node.type === 'array' && node.inner) return `${parts.join(' ')} [${describe(node.inner, depth + 1, 1)}]`
  if (node.type === 'dict' && node.inner) return `${parts.join(' ')} {*: ${describe(node.inner, depth + 1, 1)}}`
  if (node.type === 'const') return `${parts.join(' ')} = ${JSON.stringify(node.value)}`
  return parts.join(' ')
}

async function main(): Promise<void> {
  const host = await startHost({})
  const client = new NodeApiClient(host.baseUrl)
  const loop = new ConnectionLoop(client)
  loop.start()
  await new Promise((r) => setTimeout(r, 1500))

  const s = u(await client.settings.describe({}), 'settings.describe')
  for (const ns of s.namespaces) {
    console.log(`\n===== ${ns.ns} (${ns.applies}) =====`)
    try {
      console.log(describe(rehydrateSchema(ns.schema), 0))
    } catch (e) {
      console.log('rehydrate failed:', (e as Error).message)
    }
  }
  loop.stop()
  host.stop()
  process.exit(0)
}

main().catch((e) => {
  console.error('[schema-dump] FAILED:', e)
  process.exit(1)
})
