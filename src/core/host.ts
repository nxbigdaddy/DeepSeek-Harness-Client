/**
 * Embedded DSH host management: find a free loopback port, spawn
 * `dsh web` as a child process, and poll its `/api` surface until ready.
 *
 * The child's stdout/stderr go to a per-run log file (via file descriptors, not
 * pipes, so a GUI app without a console still captures diagnostics and the
 * sandbox's named-pipe restriction never applies). If the host exits before it
 * becomes ready, the wait fails fast with the log tail.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)

/**
 * Build the `--patch` overlay: enable full-text session search (the web bundle
 * ships it with `openAt: never`), and insert one `dsh-mcp-client` row per
 * configured MCP server (the config object is inlined as JSON, which is valid
 * YAML).
 */
function writeHostPatch(mcpServers: unknown[]): string {
  const lines: string[] = [
    '# dsh-client overlay: enable full-text session search.',
    '- id: session-query-sqlite',
    '  config:',
    "    path: ':memory:'",
    '    openAt: first-search'
  ]
  if (mcpServers.length > 0) {
    lines.push('- insert:')
    mcpServers.forEach((cfg, i) => {
      lines.push(`    - id: mcp-client-${i}`)
      lines.push("      name: '@deepseek-ai/dsh-mcp-client'")
      lines.push(`      config: ${JSON.stringify(cfg)}`)
    })
  }
  return lines.join('\n') + '\n'
}

function writePatchFile(mcpServers: unknown[]): string {
  const p = join(tmpdir(), `dsh-client-${process.pid}.patch.yml`)
  writeFileSync(p, writeHostPatch(mcpServers), 'utf8')
  return p
}

export interface HostHandle {
  process: ChildProcess
  port: number
  baseUrl: string
  stop(): void
}

export function resolveDshBin(): string {
  // The package declares no `exports` map, so subpaths resolve directly.
  let pkgJson = require.resolve('@deepseek-ai/dsh/package.json')
  // In a packaged app node_modules lives under app.asar, but the spawned host
  // (ELECTRON_RUN_AS_NODE) can only read the unpacked copy on disk.
  pkgJson = pkgJson.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  const dir = join(pkgJson, '..')
  const bin = join(dir, 'lib', 'bin.js')
  if (!existsSync(bin)) {
    throw new Error(`dsh bin not found at ${bin}; is @deepseek-ai/dsh installed?`)
  }
  return bin
}

export function findFreePort(preferred = 3210): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (port: number): void => {
      const srv = createServer()
      srv.once('error', () => tryPort(port + 1))
      srv.once('listening', () => srv.close(() => resolve(port)))
      srv.listen(port, '127.0.0.1')
    }
    tryPort(preferred)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Raw `host.describe` probe: a 2xx means the web server's /api fence is up. */
async function probeApi(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A hung listener must not stall the readiness loop past its deadline.
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'dsh-client-probe',
        method: 'host.describe',
        payload: {}
      })
    })
    return res.ok
  } catch {
    return false
  }
}

export async function waitForApi(baseUrl: string, timeoutMs = 120_000, checkExit?: () => void): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeApi(baseUrl)) return
    checkExit?.()
    await sleep(500)
  }
  throw new Error(`host did not become ready within ${timeoutMs}ms at ${baseUrl}`)
}

export interface SpawnHostOptions {
  port?: number
  dshHome?: string
  workspaceDir?: string
  /** MCP server configs injected as `dsh-mcp-client` plugin rows. */
  mcpServers?: unknown[]
  /** Capture the host's output to a log file (packaged apps) instead of inheriting the console (dev). */
  captureLog?: boolean
  /** Abort signal: kills the spawned host tree synchronously (quit-during-boot orphan guard). */
  signal?: AbortSignal
}

export async function startHost(opts: SpawnHostOptions = {}): Promise<HostHandle> {
  const bin = resolveDshBin()
  const port = opts.port ?? (await findFreePort())
  const baseUrl = `http://127.0.0.1:${port}`
  const logPath = join(tmpdir(), `dsh-client-host-${process.pid}.log`)
  const patchPath = writePatchFile(opts.mcpServers ?? [])

  const env: NodeJS.ProcessEnv = { ...process.env }
  // Inside Electron main, `process.execPath` is the Electron binary, not Node.
  // ELECTRON_RUN_AS_NODE makes it execute the script exactly like `node` would;
  // under a plain Node process the flag is a harmless no-op.
  env.ELECTRON_RUN_AS_NODE = '1'
  if (opts.dshHome) env.DSH_HOME = opts.dshHome

  // `web` is the hardcoded alias for `--profile web`; launcher flags (`--patch`)
  // must come before the web app's own flags (--host/--port), which otherwise
  // start the pass-through inner arguments and swallow the patch flag.
  const args = [bin, 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', String(port)]
  const cwd = opts.workspaceDir ?? process.cwd()

  // POSIX: run the host in its own process group so stop() can kill the tree.
  const detached = process.platform !== 'win32'
  let child: ChildProcess
  let logStream: ReturnType<typeof createWriteStream> | undefined
  if (opts.captureLog) {
    logStream = createWriteStream(logPath, { flags: 'w' })
    // A log write failure (disk full, AV lock) must not crash the main process.
    logStream.on('error', (e) => console.error('[host] log stream error:', e))
    child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, detached })
    child.stdout?.pipe(logStream)
    child.stderr?.pipe(logStream)
  } else {
    child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: false, detached })
  }

  const killTree = (): void => {
    // Kill the whole tree so dsh's tool subprocesses don't orphan.
    if (process.platform === 'win32') {
      try {
        // Unhandled 'error' on the killer child (missing taskkill) would
        // otherwise crash the caller; spawn() itself never throws async.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
      } catch {
        child.kill()
      }
    } else {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill()
      }
    }
  }

  // Quit-during-boot: the caller's stop() aborts this signal synchronously,
  // killing the in-flight spawn before the process can exit without it.
  if (opts.signal) {
    if (opts.signal.aborted) {
      killTree()
      throw new Error('host spawn aborted')
    }
    opts.signal.addEventListener('abort', killTree, { once: true })
  }

  let exitInfo: { code: number | null } | null = null
  child.on('exit', (code) => {
    exitInfo = { code }
  })
  child.on('error', (error) => {
    console.error('[host] failed to spawn dsh web:', error)
    exitInfo = { code: null }
  })
  // End the log only once stdio is fully drained ('close'), never on 'exit':
  // late pipe flushes after 'exit' would hit write-after-end.
  child.on('close', () => {
    logStream?.end()
  })

  try {
    await waitForApi(baseUrl, 120_000, () => {
      if (exitInfo) {
        let tail = ''
        try {
          tail = readFileSync(logPath, 'utf8').slice(-2000)
        } catch {
          // log not readable yet
        }
        throw new Error(`内嵌 host 启动失败(退出码 ${exitInfo.code ?? '未知'})\n${tail}`)
      }
    })
  } catch (error) {
    // Never leak a host that failed to come up (timeout or early exit):
    // without this, spawn retries accumulate orphaned `dsh web` processes.
    killTree()
    throw error
  }

  return {
    process: child,
    port,
    baseUrl,
    stop(): void {
      killTree()
      // Best-effort temp artifact cleanup (patch overlay + captured log).
      try {
        rmSync(patchPath, { force: true })
      } catch {
        /* temp residue is harmless */
      }
    }
  }
}
