/**
 * Shared IPC contract between the Electron main process, the preload bridge,
 * and the React renderer. Kept deliberately dependency-free so the renderer
 * never has to import the heavy `@deepseek-ai/dsh-*` type graph.
 */

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting'

export interface HostInfo {
  baseUrl: string
  port: number
  state: ConnectionState
  /** host.describe value, or undefined before the first successful handshake. */
  description?: Record<string, unknown>
  error?: string
}

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  cwd?: string
  title?: string
}

export interface PromptResult {
  accepted: boolean
  commandText?: string
}

export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }

export interface SessionSearchItem {
  sessionId: string
  snippet: string
}

export interface QueueItem {
  id: string
  placement: 'queued' | 'steering' | 'context'
  text: string
}

/** A raw session event forwarded verbatim to the renderer (opaque there). */
export interface SessionEventView {
  type: string
  seq: number
  time: number
  data: unknown
  view?: unknown
}

export interface HistoryResult {
  events: SessionEventView[]
  hasMore: boolean
  /** title projection value from the tail page, if present. */
  title?: string | null
  /** plan-mode projection from the tail page, if present. */
  plan?: { active: boolean; pending: boolean }
  /** goal projection from the tail page, if present. */
  goal?: GoalView | null
}

/**
 * One downlink frame forwarded from main to renderer. `payload` is the
 * `MuxFrame`/`HostFrame` discriminated union, kept loose because the renderer
 * narrows defensively by `type`.
 */
export interface DownlinkFrame {
  stream: 'mux' | 'host'
  rpcId: string
  payload: {
    type: string
    [key: string]: unknown
  }
}

/* ---------------- Approvals / Questions ---------------- */

export interface PendingApproval {
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  reason?: string
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
  intent?: { kind: string; approve?: string; [key: string]: unknown }
}

export interface PendingQuestion {
  rpcId: string
  sessionId: string
  questions: QuestionItem[]
}

export interface PlanState {
  active: boolean
  pending: boolean
}

/* ---------------- Goals / Subagents / Jobs ---------------- */

export interface GoalRef {
  id: string
  revision: number
}

export interface GoalSnapshot {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: { code: string; message: string }
  maxGoalRounds: number
}

export interface GoalView {
  goal: GoalSnapshot
  roundsStarted: number
  createdAt: number
  updatedAt: number
}

export type SubagentEntry =
  | {
      kind: 'child'
      id: string
      activity: 'running' | 'inactive'
      hasChildren: boolean
      mode: 'one-shot' | 'continuable'
      label?: string
    }
  | { kind: 'diagnostic'; id: string; reason: string }

export interface JobView {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
}

/* ---------------- Skills / Presets / Credentials ---------------- */

export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
}

export interface AgentPresetEntry {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

export interface CredentialView {
  configured: boolean
  source?: string
  writable: boolean
}

export interface ConnectionConfig {
  mode: 'embedded' | 'remote'
  remoteUrl?: string
  /** MCP server configs injected into the embedded host via `--patch`. */
  mcpServers?: unknown[]
}

/* ---------------- Workspace ---------------- */

export interface Workspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface WorkspaceList {
  items: Workspace[]
  archivedSessionIds: string[]
}

/* ---------------- Directory browsing ---------------- */

export interface DirectoryEntry {
  name: string
  path: string
  hidden: boolean
}

export interface DirectoryListing {
  path: string
  home: string
  crumbs: DirectoryEntry[]
  entries: DirectoryEntry[]
  truncated: boolean
}

/* ---------------- Settings ---------------- */

export interface SettingsSecret {
  path: string[]
  set: boolean
}

export interface SettingsNamespace {
  ns: string
  applies: 'live' | 'restart'
  revision: number
  secrets: SettingsSecret[]
  /** Serialized schemastery schema envelope ({uid, refs}); rehydrate with `new Schema(json)`. */
  schema: unknown
  /** Redacted resolved value (schema defaults → base → user layer). */
  value: unknown
  /** Redacted raw user section (what the user overrode). */
  user: unknown
}

export interface SettingsDescribeResult {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespace[]
}

export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/* ---------------- Models ---------------- */

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string }
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface SessionModels {
  current: ModelSelection
  routable: boolean
  groups: ModelProviderGroup[]
  failures: { id: string; name: string; message: string }[]
}

/* ---------------- Preload API surface ---------------- */

export interface DsApi {
  getHostInfo(): Promise<HostInfo>
  listSessions(): Promise<SessionSummary[]>
  createSession(opts?: { cwd?: string; workspaceId?: string }): Promise<{ sessionId: string }>
  prompt(sessionId: string, content: PromptContentPart[]): Promise<PromptResult>
  cancel(sessionId: string): Promise<{ accepted: boolean }>
  history(sessionId: string, beforeSeq?: number, maxMessages?: number): Promise<HistoryResult>
  searchSessions(query: string): Promise<{ items: SessionSearchItem[]; hasMore: boolean }>
  forkSession(sessionId: string): Promise<{ sessionId: string }>
  attachment(sessionId: string, attachmentId: string): Promise<{ data: string; mediaType: string }>
  updateQueue(sessionId: string, itemId: string, action: { kind: 'remove' | 'steer' }): Promise<{ accepted: boolean }>
  sessionRename(sessionId: string, title: string): Promise<{ title: string }>
  sessionModels(sessionId: string): Promise<SessionModels>
  /** The RPC answers only the new selection; callers wanting the catalog refetch sessionModels. */
  sessionSelectModel(sessionId: string, provider: string, model: string): Promise<ModelSelection>
  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }>
  /** Answer an approval/question server-request (echoes the frame's rpcId). */
  respond(rpcId: string, value: unknown): Promise<{ accepted: boolean }>

  listWorkspaces(): Promise<WorkspaceList>
  createWorkspace(path: string): Promise<{ workspace: Workspace; created: boolean }>
  renameWorkspace(workspaceId: string, title: string): Promise<Workspace>
  deleteWorkspace(workspaceId: string): Promise<void>
  /** Reorder a session within its workspace (anchor omitted = append to end). */
  moveSessionBefore(workspaceId: string, sessionId: string, beforeSessionId?: string): Promise<void>
  /** Reorder workspaces (anchor omitted = move to end). */
  reorderWorkspace(workspaceId: string, beforeWorkspaceId?: string): Promise<void>
  pickDirectory(): Promise<{ path: string | null }>
  listDirectory(path?: string): Promise<DirectoryListing>
  createDirectory(path: string, name: string): Promise<{ path: string }>
  openPath(path: string): Promise<void>

  settingsDescribe(): Promise<SettingsDescribeResult>
  settingsMutate(ns: string, ops: SettingsPathOp[], expectedRevision?: number): Promise<SettingsNamespace>
  settingsReplace(ns: string, section: object, expectedRevision?: number): Promise<SettingsNamespace>
  settingsOpenDocument(): Promise<void>
  llmModels(): Promise<{ groups: ModelProviderGroup[] }>

  goalCreate(sessionId: string, objective: string, maxGoalRounds?: number): Promise<GoalRef>
  goalEdit(sessionId: string, ref: GoalRef, objective?: string, maxGoalRounds?: number): Promise<GoalRef>
  goalPause(sessionId: string, ref: GoalRef): Promise<GoalRef>
  goalResume(sessionId: string, ref: GoalRef): Promise<GoalRef>
  goalComplete(sessionId: string, ref: GoalRef): Promise<GoalRef>
  goalClear(sessionId: string, ref: GoalRef): Promise<void>
  subagentList(parentSessionId: string): Promise<{ entries: SubagentEntry[]; parentAvailable: boolean }>
  subagentHistory(parentSessionId: string, childSessionId: string, mode: string): Promise<HistoryResult>
  subagentPrompt(parentSessionId: string, childSessionId: string, text: string): Promise<void>
  subagentInterrupt(parentSessionId: string, childSessionId: string): Promise<void>
  skillsList(sessionId: string): Promise<{ skills: SkillEntry[] }>
  agentPresetList(): Promise<{ presets: AgentPresetEntry[]; authorable: boolean; hasDocument: boolean }>
  agentPresetSelect(sessionId: string, agentPreset: string): Promise<void>
  credentialsDescribe(refs: string[]): Promise<{ credentials: Record<string, CredentialView> }>
  credentialsSet(ref: string, value: string): Promise<void>
  credentialsUnset(ref: string): Promise<void>
  getConnectionConfig(): Promise<ConnectionConfig>
  setConnectionConfig(cfg: ConnectionConfig): Promise<void>
  /** Drop the current connection and boot again (host-down recovery). */
  retryConnect(): Promise<void>

  /** Subscribe to downlink frames. Returns an unsubscribe function. */
  onFrame(cb: (frame: DownlinkFrame) => void): () => void
  /** Subscribe to host info changes. Returns an unsubscribe function. */
  onHostInfo(cb: (info: HostInfo) => void): () => void
}
