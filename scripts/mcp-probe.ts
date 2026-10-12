/** Verify the MCP `--patch` injection: a dummy (unconnectable) MCP server with
 *  failOnStartupError:false must still let the host boot. */
import { startHost } from '../src/core/host'

async function main(): Promise<void> {
  const host = await startHost({
    mcpServers: [
      {
        transport: 'stdio',
        serverName: 'dummy',
        command: 'node',
        args: ['-e', ''],
        env: {},
        cwd: '.',
        toolCallTimeoutMs: 60000,
        failOnStartupError: false
      }
    ]
  })
  console.log(`[mcp] host booted at ${host.baseUrl} with MCP patch injected`)
  host.stop()
  process.exit(0)
}

main().catch((e) => {
  console.error('[mcp] FAILED:', e)
  process.exit(1)
})
