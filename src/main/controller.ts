/**
 * Main-process controller: owns the embedded host, the protocol client, and the
 * connection loop, and bridges them to the renderer over IPC.
 */
import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { startHost, type HostHandle } from '@core/host'
import { NodeApiClient, ConnectionLoop } from '@core/client'
import type {
  AgentPresetEntry,
  ConnectionConfig,
  CredentialView,
  DirectoryEntry,
  DownlinkFrame,
  DirectoryListing,
  HistoryResult,
  HostInfo,
  ModelSelection,
  PromptContentPart,
  PromptResult,
  SessionEventView,
  SessionModels,
  SessionSummary,
  SettingsDescribeResult,
  SettingsNamespace,
  SettingsPathOp,
  SkillEntry,
  SubagentEntry,
  Workspace,
  WorkspaceList
} from '@shared/ipc'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy/api/workspace'
import type { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = any

/** Brand a plain string as the compile-time-only `SessionId` brand. */
const sid = (id: string): SessionId => id as unknown as SessionId
/** Brand a plain string as the compile-time-only `WorkspaceId` brand. */
const wid = (id: string): WorkspaceId => id as unknown as WorkspaceId

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap(resp: AnyRecord, label: string): AnyRecord {
  if (!resp?.result?.ok) {
    const err = resp?.result?.error
    throw new Error(`${label}: ${err?.code ?? 'unknown'} ${err?.message ?? ''}`)
  }
  return resp.result.value
}

function mapWorkspace(w: AnyRecord): Workspace {
  return {
    workspaceId: w.workspaceId,
    path: w.path,
    title: w.title,
    sessionIds: w.sessionIds ?? [],
    createdAt: w.createdAt,
    updatedAt: w.updatedAt
  }
}

function mapSession(item: AnyRecord): SessionSummary {
  return {
    sessionId: item.sessionId,
    updatedAt: item.updatedAt,
    running: item.running,
    blank: item.blank,
    parentSessionId: item.parentSessionId,
    cwd: item.cwd,
    title: item.projections?.values?.title ?? undefined
  }
}

/** Cap on directory rows served to the picker modal (host browse uses its own budget). */
const MAX_DIR_ENTRIES = 500

/**
 * Local-fs directory listing for the in-app picker. Used when the composed
 * host picker is `native` (Windows/macOS loopback) and `host.listDirectory`
 * answers `directory-picker-unavailable`; for an embedded host the local fs
 * IS the host's fs. Directories only, dotfile-hidden flagged, root-to-target
 * crumbs mirroring the host browse shape.
 */
async function listLocalDirectory(path?: string): Promise<DirectoryListing> {
  const home = homedir()
  const target = resolve(path && path.trim() ? path : home)
  const dirents = await readdir(target, { withFileTypes: true })
  const entries: DirectoryEntry[] = []
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    entries.push({ name: d.name, path: join(target, d.name), hidden: d.name.startsWith('.') })
  }
  entries.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const crumbs: DirectoryEntry[] = []
  const chain: string[] = []
  let cur = target
  for (;;) {
    chain.push(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  const root = parse(target).root
  for (const p of chain.reverse()) {
    crumbs.push({ name: p === root ? p : basename(p), path: p, hidden: false })
  }
  return { path: target, home, crumbs, entries: entries.slice(0, MAX_DIR_ENTRIES), truncated: entries.length > MAX_DIR_ENTRIES }
}

/** Whether an unwrap()-ed host error is the picker-capability gap (native composition). */
function isPickerUnavailable(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes('directory-picker-unavailable')
}

export class Controller {
  private host: HostHandle | undefined
  private client: NodeApiClient | undefined
  private loop: ConnectionLoop | undefined
  private win: BrowserWindow | undefined
  private info: HostInfo = { baseUrl: '', port: 0, state: 'connecting' }
  private readyPromise: Promise<void> | null = null
  /** Set by stop(); a boot that completes after stop() must self-destruct its host. */
  private stopped = false
  /** Aborted by stop() to synchronously kill an in-flight host spawn. */
  private bootAbort: AbortController | null = null

  async start(win: BrowserWindow): Promise<void> {
    this.win = win
    this.readyPromise = this.enqueueReconnect()
    await this.readyPromise
  }

  /** Re-point pushes at a recreated window (macOS activate / window restore). */
  attachWindow(win: BrowserWindow): void {
    this.win = win
    this.pushHostInfo()
  }

  private configPath(): string {
    return join(app.getPath('userData'), 'client-config.json')
  }

  getConnectionConfig(): ConnectionConfig {
    try {
      return JSON.parse(readFileSync(this.configPath(), 'utf8'))
    } catch {
      return { mode: 'embedded' }
    }
  }

  async setConnectionConfig(cfg: ConnectionConfig): Promise<void> {
    writeFileSync(this.configPath(), JSON.stringify(cfg, null, 2), 'utf8')
    await this.enqueueReconnect()
  }

  /** Drop the connection and boot again (user-triggered recovery path). */
  async retryConnect(): Promise<void> {
    await this.enqueueReconnect()
  }

  /**
   * Serialize reconnects: two concurrent boots would spawn two embedded hosts
   * and two connection loops (port + frame duplication). Chain them instead;
   * the chain itself never dies because a failed boot still resolves it.
   */
  private reconnectChain: Promise<void> = Promise.resolve()

  private enqueueReconnect(): Promise<void> {
    const run = this.reconnectChain.then(() => this.reconnect())
    this.reconnectChain = run.catch(() => undefined)
    return run
  }

  private async reconnect(): Promise<void> {
    this.loop?.stop()
    this.host?.stop()
    this.host = undefined
    this.client = undefined
    this.info = { baseUrl: '', port: 0, state: 'connecting' }
    this.pushHostInfo()
    this.readyPromise = this.boot()
    await this.readyPromise
  }

  private async boot(): Promise<void> {
    try {
      const cfg = this.getConnectionConfig()
      if (cfg.mode === 'remote' && cfg.remoteUrl) {
        console.log(`[main] connecting to remote host ${cfg.remoteUrl}`)
        this.info.baseUrl = cfg.remoteUrl
        this.info.port = 0
        this.client = new NodeApiClient(cfg.remoteUrl)
      } else {
        this.bootAbort = new AbortController()
        const host = await this.spawnHostWithRetry(cfg.mcpServers ?? [], this.bootAbort.signal)
        // The app quit while the spawn was in flight: kill the fresh host
        // immediately instead of orphaning it on a dead parent.
        if (this.stopped) {
          host.stop()
          throw new Error('controller stopped during boot')
        }
        this.host = host
        this.info.baseUrl = host.baseUrl
        this.info.port = host.port
        this.client = new NodeApiClient(host.baseUrl)
      }
      this.loop = new ConnectionLoop(this.client, {
        onStateChange: (state) => {
          console.log(`[main] connection: ${state}`)
          this.info.state = state === 'connected' ? 'connected' : 'reconnecting'
          if (state === 'connected') this.info.error = undefined
          this.pushHostInfo()
        },
        onConnected: (description) => {
          console.log(`[main] connected to host (model=${description?.model ?? '?'})`)
          this.info.description = description
          this.info.state = 'connected'
          this.info.error = undefined
          this.pushHostInfo()
        },
        onMuxEnvelope: (envelope) => this.sendFrame('mux', envelope),
        onHostEnvelope: (envelope) => this.sendFrame('host', envelope)
      })
      this.loop.start()
    } catch (error) {
      // Boot failed for good (e.g. embedded host never came up): surface a
      // reconnecting-with-error state instead of leaving every later IPC call
      // to rethrow a stale rejected promise with no visible explanation.
      this.info.state = 'reconnecting'
      this.info.error = error instanceof Error ? error.message : String(error)
      this.pushHostInfo()
      throw error
    }
  }

  getHostInfo(): HostInfo {
    return { ...this.info }
  }

  /* ---------------- sessions ---------------- */

  async listSessions(): Promise<SessionSummary[]> {
    const value = unwrap(await (await this.ensureClient()).sessions.list({}), 'session.list')
    return value.items.map(mapSession)
  }

  async createSession(opts?: { cwd?: string; workspaceId?: string }): Promise<{ sessionId: string }> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.create({
        cwd: opts?.cwd,
        workspaceId: opts?.workspaceId ? wid(opts.workspaceId) : undefined
      }),
      'session.create'
    )
    return { sessionId: value.sessionId }
  }

  async prompt(sessionId: string, content: PromptContentPart[]): Promise<PromptResult> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.prompt({
        sessionId: sid(sessionId),
        mode: 'queue',
        content: content as never
      }),
      'session.prompt'
    )
    return { accepted: value.accepted, commandText: value.command?.text }
  }

  async cancel(sessionId: string): Promise<{ accepted: boolean }> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.cancel({ sessionId: sid(sessionId) }),
      'session.cancel'
    )
    return { accepted: value.accepted }
  }

  async history(sessionId: string, beforeSeq?: number, maxMessages?: number): Promise<HistoryResult> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.history({
        sessionId: sid(sessionId),
        beforeSeq,
        maxMessages
      }),
      'session.history'
    )
    const events: SessionEventView[] = value.events.map((entry: AnyRecord) => ({
      type: entry.event.type,
      seq: entry.event.seq,
      time: entry.event.time,
      data: entry.event.data,
      view: entry.view
    }))
    return { events, hasMore: value.hasMore, title: value.projections?.values?.title ?? undefined, plan: value.projections?.values?.plan ?? undefined, goal: value.projections?.values?.goal ?? undefined }
  }

  async sessionRename(sessionId: string, title: string): Promise<{ title: string }> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.rename({ sessionId: sid(sessionId), title }),
      'session.rename'
    )
    return { title: value.title }
  }

  async searchSessions(query: string): Promise<{ items: { sessionId: string; snippet: string }[]; hasMore: boolean }> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.search({ query }),
      'session.search'
    )
    return { items: value.items, hasMore: value.hasMore }
  }

  async forkSession(sessionId: string): Promise<{ sessionId: string }> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.fork({ sessionId: sid(sessionId) }),
      'session.fork'
    )
    return { sessionId: value.sessionId }
  }

  async attachment(sessionId: string, attachmentId: string): Promise<{ data: string; mediaType: string }> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.attachment({
        sessionId: sid(sessionId),
        attachmentId: attachmentId as never
      }),
      'session.attachment'
    )
    return { data: value.data, mediaType: value.attachment.mediaType }
  }

  async updateQueue(sessionId: string, itemId: string, action: { kind: 'remove' | 'steer' }): Promise<{ accepted: boolean }> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.updateQueue({
        sessionId: sid(sessionId),
        itemId: itemId as never,
        action: action as never
      }),
      'session.updateQueue'
    )
    return { accepted: value.accepted }
  }

  async sessionModels(sessionId: string): Promise<SessionModels> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.models({ sessionId: sid(sessionId) }),
      'session.models'
    )
    return this.mapSessionModels(value)
  }

  async sessionSelectModel(sessionId: string, provider: string, model: string): Promise<ModelSelection> {
    const value = unwrap(
      await (await this.ensureClient()).sessions.selectModel({
        sessionId: sid(sessionId),
        provider,
        model
      }),
      'session.selectModel'
    )
    return {
      provider: value.selected.provider,
      model: value.selected.model,
      reasoningEffort: value.selected.reasoningEffort
    }
  }

  async archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    const value = unwrap(
      await (await this.ensureClient()).workspace.archiveSession({ sessionId: sid(sessionId) }),
      'workspace.archiveSession'
    )
    return { archivedSessionIds: value.archivedSessionIds }
  }

  async respond(rpcId: string, value: unknown): Promise<{ accepted: boolean }> {
    const receipt = await (await this.ensureClient()).respond({
      type: 'client-response',
      rpcId: rpcId as unknown as RpcId,
      result: { ok: true, value }
    })
    return { accepted: receipt.accepted }
  }

  /* ---------------- goals ---------------- */

  private gRef(ref: { id: string; revision: number }): AnyRecord {
    return { id: ref.id as never, revision: ref.revision }
  }

  async goalCreate(sessionId: string, objective: string, maxGoalRounds?: number): Promise<{ id: string; revision: number }> {
    const value = unwrap(
      await (await this.ensureClient()).goals.create({ sessionId: sid(sessionId), objective, maxGoalRounds }),
      'goal.create'
    )
    return { id: value.ref.id, revision: value.ref.revision }
  }

  async goalEdit(sessionId: string, ref: { id: string; revision: number }, objective?: string, maxGoalRounds?: number): Promise<{ id: string; revision: number }> {
    const value = unwrap(
      await (await this.ensureClient()).goals.edit({ sessionId: sid(sessionId), ref: this.gRef(ref), objective, maxGoalRounds }),
      'goal.edit'
    )
    return { id: value.ref.id, revision: value.ref.revision }
  }

  async goalPause(sessionId: string, ref: { id: string; revision: number }): Promise<{ id: string; revision: number }> {
    const value = unwrap(
      await (await this.ensureClient()).goals.pause({ sessionId: sid(sessionId), ref: this.gRef(ref) }),
      'goal.pause'
    )
    return { id: value.ref.id, revision: value.ref.revision }
  }

  async goalResume(sessionId: string, ref: { id: string; revision: number }): Promise<{ id: string; revision: number }> {
    const value = unwrap(
      await (await this.ensureClient()).goals.resume({ sessionId: sid(sessionId), ref: this.gRef(ref) }),
      'goal.resume'
    )
    return { id: value.ref.id, revision: value.ref.revision }
  }

  async goalComplete(sessionId: string, ref: { id: string; revision: number }): Promise<{ id: string; revision: number }> {
    const value = unwrap(
      await (await this.ensureClient()).goals.complete({ sessionId: sid(sessionId), ref: this.gRef(ref) }),
      'goal.complete'
    )
    return { id: value.ref.id, revision: value.ref.revision }
  }

  async goalClear(sessionId: string, ref: { id: string; revision: number }): Promise<void> {
    unwrap(await (await this.ensureClient()).goals.clear({ sessionId: sid(sessionId), ref: this.gRef(ref) }), 'goal.clear')
  }

  /* ---------------- subagents ---------------- */

  async subagentList(parentSessionId: string): Promise<{ entries: SubagentEntry[]; parentAvailable: boolean }> {
    const value = unwrap(
      await (await this.ensureClient()).subagents.list({ parentSessionId: sid(parentSessionId) }),
      'subagent.list'
    )
    return { entries: value.entries, parentAvailable: value.parentAvailable }
  }

  async subagentHistory(parentSessionId: string, childSessionId: string, mode: string): Promise<HistoryResult> {
    const value = unwrap(
      await (await this.ensureClient()).subagents.history({
        parentSessionId: sid(parentSessionId),
        childSessionId: sid(childSessionId),
        mode: mode as never
      }),
      'subagent.history'
    )
    const events: SessionEventView[] = value.events.map((entry: AnyRecord) => ({
      type: entry.event.type,
      seq: entry.event.seq,
      time: entry.event.time,
      data: entry.event.data,
      view: entry.view
    }))
    return { events, hasMore: value.hasMore, title: value.projections?.values?.title ?? undefined, plan: value.projections?.values?.plan ?? undefined, goal: value.projections?.values?.goal ?? undefined }
  }

  async subagentPrompt(parentSessionId: string, childSessionId: string, text: string): Promise<void> {
    unwrap(
      await (await this.ensureClient()).subagents.prompt({
        parentSessionId: sid(parentSessionId),
        childSessionId: sid(childSessionId),
        mode: 'continuable',
        content: [{ type: 'text', text }]
      }),
      'subagent.prompt'
    )
  }

  async subagentInterrupt(parentSessionId: string, childSessionId: string): Promise<void> {
    unwrap(
      await (await this.ensureClient()).subagents.interrupt({
        parentSessionId: sid(parentSessionId),
        childSessionId: sid(childSessionId),
        mode: 'continuable'
      }),
      'subagent.interrupt'
    )
  }

  /* ---------------- skills / presets / credentials ---------------- */

  async skillsList(sessionId: string): Promise<{ skills: SkillEntry[] }> {
    const value = unwrap(await (await this.ensureClient()).skills.list({ sessionId: sid(sessionId) }), 'skill.list')
    return { skills: value.skills }
  }

  async agentPresetList(): Promise<{ presets: AgentPresetEntry[]; authorable: boolean; hasDocument: boolean }> {
    const value = unwrap(await (await this.ensureClient()).agentPresets.list({}), 'agentPreset.list')
    return { presets: value.presets, authorable: value.authorable, hasDocument: value.hasDocument }
  }

  async agentPresetSelect(sessionId: string, agentPreset: string): Promise<void> {
    unwrap(
      await (await this.ensureClient()).agentPresets.select({ sessionId: sid(sessionId), agentPreset }),
      'agentPreset.select'
    )
  }

  async credentialsDescribe(refs: string[]): Promise<{ credentials: Record<string, CredentialView> }> {
    const value = unwrap(await (await this.ensureClient()).credentials.describe({ refs }), 'credentials.describe')
    return { credentials: value.credentials }
  }

  async credentialsSet(ref: string, value: string): Promise<void> {
    unwrap(await (await this.ensureClient()).credentials.set({ ref, value }), 'credentials.set')
  }

  async credentialsUnset(ref: string): Promise<void> {
    unwrap(await (await this.ensureClient()).credentials.unset({ ref }), 'credentials.unset')
  }

  /* ---------------- workspaces ---------------- */

  async listWorkspaces(): Promise<WorkspaceList> {
    const value = unwrap(await (await this.ensureClient()).workspace.list({}), 'workspace.list')
    return {
      items: value.items.map(mapWorkspace),
      archivedSessionIds: value.archivedSessionIds ?? []
    }
  }

  async createWorkspace(path: string): Promise<{ workspace: Workspace; created: boolean }> {
    const value = unwrap(
      await (await this.ensureClient()).workspace.create({ path }),
      'workspace.create'
    )
    return { workspace: mapWorkspace(value.workspace), created: value.created }
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<Workspace> {
    const value = unwrap(
      await (await this.ensureClient()).workspace.rename({ workspaceId: wid(workspaceId), title }),
      'workspace.rename'
    )
    return mapWorkspace(value.workspace)
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    unwrap(
      await (await this.ensureClient()).workspace.delete({ workspaceId: wid(workspaceId) }),
      'workspace.delete'
    )
  }

  /** Reorder sessions within a workspace (anchor omitted = append to end). */
  async moveSessionBefore(workspaceId: string, sessionId: string, beforeSessionId?: string): Promise<void> {
    unwrap(
      await (await this.ensureClient()).workspace.insertSessionBefore({
        workspaceId: wid(workspaceId),
        sessionId: sid(sessionId),
        beforeSessionId: beforeSessionId ? sid(beforeSessionId) : undefined
      }),
      'workspace.insertSessionBefore'
    )
  }

  /** Reorder workspaces (anchor omitted = move to end). */
  async reorderWorkspace(workspaceId: string, beforeWorkspaceId?: string): Promise<void> {
    unwrap(
      await (await this.ensureClient()).workspace.insertBefore({
        workspaceId: wid(workspaceId),
        beforeWorkspaceId: beforeWorkspaceId ? wid(beforeWorkspaceId) : undefined
      }),
      'workspace.insertBefore'
    )
  }

  /* ---------------- host directory / path ---------------- */

  async pickDirectory(): Promise<{ path: string | null }> {
    const value = unwrap(await (await this.ensureClient()).host.pickDirectory({}), 'host.pickDirectory')
    return { path: value.path }
  }

  async listDirectory(path?: string): Promise<DirectoryListing> {
    try {
      const value = unwrap(
        await (await this.ensureClient()).host.listDirectory({ path }),
        'host.listDirectory'
      )
      return {
        path: value.path,
        home: value.home,
        crumbs: value.crumbs,
        entries: value.entries,
        truncated: value.truncated
      }
    } catch (error) {
      // Native-composed picker (Windows/macOS loopback) has no browse half:
      // serve the same shape from the local fs — identical machine for embedded.
      if (!isPickerUnavailable(error)) throw error
      return listLocalDirectory(path)
    }
  }

  async createDirectory(path: string, name: string): Promise<{ path: string }> {
    try {
      const value = unwrap(
        await (await this.ensureClient()).host.createDirectory({ path, name }),
        'host.createDirectory'
      )
      return { path: value.path }
    } catch (error) {
      if (!isPickerUnavailable(error)) throw error
      const clean = name.trim()
      if (!clean || /[\\/:*?"<>|]/.test(clean)) throw new Error(`createDirectory: invalid folder name "${name}"`)
      const full = join(path, clean)
      await mkdir(full)
      return { path: full }
    }
  }

  async openPath(path: string): Promise<void> {
    unwrap(await (await this.ensureClient()).host.openPath({ path }), 'host.openPath')
  }

  /* ---------------- settings ---------------- */

  async settingsDescribe(): Promise<SettingsDescribeResult> {
    const value = unwrap(await (await this.ensureClient()).settings.describe({}), 'settings.describe')
    return {
      writable: value.writable,
      hasDocument: value.hasDocument,
      namespaces: value.namespaces.map((n: AnyRecord): SettingsNamespace => ({
        ns: n.ns,
        applies: n.applies,
        revision: n.revision,
        secrets: n.secrets ?? [],
        schema: n.schema,
        value: n.value,
        user: n.user
      }))
    }
  }

  async settingsMutate(ns: string, ops: SettingsPathOp[], expectedRevision?: number): Promise<SettingsNamespace> {
    const value = unwrap(
      await (await this.ensureClient()).settings.mutate({ ns, ops, expectedRevision }),
      'settings.mutate'
    )
    return this.mapSettingsNamespace(value)
  }

  async settingsReplace(ns: string, section: object, expectedRevision?: number): Promise<SettingsNamespace> {
    const value = unwrap(
      await (await this.ensureClient()).settings.replace({ ns, section, expectedRevision }),
      'settings.replace'
    )
    return this.mapSettingsNamespace(value)
  }

  async settingsOpenDocument(): Promise<void> {
    unwrap(await (await this.ensureClient()).settings.openDocument({}), 'settings.openDocument')
  }

  async llmModels(): Promise<{ groups: SessionModels['groups'] }> {
    const value = unwrap(await (await this.ensureClient()).llm.models({}), 'llm.models')
    return { groups: value.groups }
  }

  /* ---------------- teardown ---------------- */

  /** Spawn the embedded host, retrying transient boot failures with backoff. */
  private async spawnHostWithRetry(mcpServers: unknown[], signal?: AbortSignal): Promise<HostHandle> {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.stopped) throw new Error('controller stopped during boot')
      try {
        return await startHost({
          mcpServers,
          captureLog: app.isPackaged,
          signal,
          // Packaged: process.cwd() is the install dir (possibly read-only) —
          // sessions without a workspace inherit the host cwd, so land on home.
          workspaceDir: app.isPackaged ? homedir() : undefined
        })
      } catch (error) {
        lastError = error
        this.info.state = 'reconnecting'
        this.info.error = `内嵌 host 启动失败,正在重试(${attempt + 1}/4):${error instanceof Error ? error.message : String(error)}`
        this.pushHostInfo()
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      }
    }
    throw lastError
  }

  stop(): void {
    this.stopped = true
    this.bootAbort?.abort()
    this.loop?.stop()
    this.host?.stop()
  }

  /* ---------------- private ---------------- */

  private mapSessionModels(value: AnyRecord): SessionModels {
    return {
      current: {
        provider: value.current.provider,
        model: value.current.model,
        reasoningEffort: value.current.reasoningEffort
      },
      routable: value.routable,
      groups: value.groups ?? [],
      failures: value.failures ?? []
    }
  }

  private mapSettingsNamespace(n: AnyRecord): SettingsNamespace {
    return {
      ns: n.ns,
      applies: n.applies,
      revision: n.revision,
      secrets: n.secrets ?? [],
      schema: n.schema,
      value: n.value,
      user: n.user
    }
  }

  private async ensureClient(): Promise<NodeApiClient> {
    if (this.readyPromise) await this.readyPromise
    if (!this.client) throw new Error('client is not ready yet')
    return this.client
  }

  private pushHostInfo(): void {
    this.sendToWin('dsh:hostInfo', { ...this.info })
  }

  private sendFrame(stream: 'mux' | 'host', envelope: AnyRecord): void {
    const frame: DownlinkFrame = {
      stream,
      rpcId: envelope?.rpcId ?? '',
      payload: envelope?.payload ?? { type: 'stream/error' }
    }
    this.sendToWin('dsh:frame', frame)
  }

  /** webContents.send throws on a destroyed contents (window closed mid-push). */
  private sendToWin(channel: string, payload: unknown): void {
    const wc = this.win?.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, payload)
  }
}
