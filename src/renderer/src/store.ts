import { create } from 'zustand'
import type {
  DownlinkFrame,
  GoalView,
  HostInfo,
  JobView,
  PendingApproval,
  PendingQuestion,
  PlanState,
  PromptContentPart,
  QueueItem,
  SessionEventView,
  SessionModels,
  SessionSearchItem,
  SessionSummary,
  Workspace
} from '@shared/ipc'

export type View = 'chat' | 'settings' | 'capabilities'

interface AppState {
  initialized: boolean
  host: HostInfo
  sessions: SessionSummary[]
  selectedId: string | null
  eventsBySession: Record<string, SessionEventView[]>
  runningBySession: Record<string, boolean>
  loadedSessions: Record<string, boolean>
  titles: Record<string, string | null>
  plans: Record<string, PlanState>
  workspaces: Workspace[]
  archivedSessionIds: string[]
  modelsBySession: Record<string, SessionModels>
  approvals: Record<string, PendingApproval>
  questions: Record<string, PendingQuestion>
  hasMoreBySession: Record<string, boolean>
  queueBySession: Record<string, QueueItem[]>
  jobsBySession: Record<string, JobView[]>
  goals: Record<string, GoalView | null>
  searchResults: SessionSearchItem[] | null
  searching: boolean
  searchError: string | null
  view: View
  /** Last user-action failure, surfaced as a dismissible bar (null = none). */
  lastError: string | null

  init(): Promise<void>
  refreshSessions(): Promise<void>
  refreshWorkspaces(): Promise<void>
  selectSession(id: string): Promise<void>
  loadHistory(id: string): Promise<void>
  loadOlder(id: string): Promise<void>
  newSession(opts?: { workspaceId?: string }): Promise<void>
  /** Returns false when the prompt RPC failed (so the composer can restore the draft). */
  send(content: PromptContentPart[]): Promise<boolean>
  cancel(): Promise<void>
  forkSession(id: string): Promise<void>
  search(query: string): Promise<void>
  clearSearch(): void
  removeQueueItem(sessionId: string, itemId: string): Promise<void>
  steerQueueItem(sessionId: string, itemId: string): Promise<void>
  goalCreate(objective: string, maxGoalRounds?: number): Promise<void>
  goalEdit(objective: string, maxGoalRounds?: number): Promise<void>
  goalPause(): Promise<void>
  goalResume(): Promise<void>
  goalComplete(): Promise<void>
  goalClear(): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  archiveSession(id: string): Promise<void>
  createWorkspace(path: string): Promise<{ workspace: Workspace; created: boolean }>
  renameWorkspace(id: string, title: string): Promise<void>
  deleteWorkspace(id: string): Promise<void>
  moveSessionBefore(workspaceId: string, sessionId: string, beforeSessionId?: string): Promise<void>
  reorderWorkspace(workspaceId: string, beforeWorkspaceId?: string): Promise<void>
  reportError(message: string): void
  dismissError(): void
  loadSessionModels(id: string): Promise<void>
  selectModel(id: string, provider: string, model: string): Promise<void>
  respondApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<void>
  respondQuestion(rpcId: string, answers: { id: string; selected: string[]; custom?: string }[]): Promise<void>
  setView(view: View): void
}

type Set = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void
type Get = () => AppState

/**
 * Log an action failure AND surface it in the UI. Interactive actions route
 * here instead of swallowing errors into the console; passive refreshes
 * (list/poll paths) stay console-only so transient reconnects don't spam.
 */
function reportStoreError(get: Get, context: string, error: unknown): void {
  console.error(`${context} failed:`, error)
  get().reportError(`${context}失败:${error instanceof Error ? error.message : String(error)}`)
}

/** Merge event lists by seq (dedupe, ascending). Live frames that arrived
 *  while a history RPC was in flight must survive the merge — wholesale
 *  replacement would drop them and seq-dedup would keep them dropped. */
function mergeEvents(a: SessionEventView[], b: SessionEventView[]): SessionEventView[] {
  const bySeq = new Map<number, SessionEventView>()
  for (const e of a) bySeq.set(e.seq, e)
  for (const e of b) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq)
}

/** Trailing-edge debounce for refresh fan-outs triggered by host frames. */
function debounced<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

/** init() reentrancy guard (initialized flips only after listeners are live). */
let initInFlight = false
/** Monotonic token dropping out-of-order search responses. */
let searchToken = 0
/** Host frames can arrive in bursts (status flaps, workspace churn); collapse. */
const queueRefreshSessions = debounced((get: Get) => void get().refreshSessions(), 150)
const queueRefreshWorkspaces = debounced((get: Get) => void get().refreshWorkspaces(), 150)

/**
 * Drop per-session caches (titles kept: archived rows still render them).
 * Without this, eventsBySession & friends grow monotonically for the app's
 * whole lifetime — archiving never released a byte.
 */
function dropSessionData(s: AppState, id: string, keepTitle = true): Partial<AppState> {
  const omit = <T>(rec: Record<string, T>): Record<string, T> => {
    const { [id]: _drop, ...rest } = rec
    return rest
  }
  return {
    eventsBySession: omit(s.eventsBySession),
    loadedSessions: omit(s.loadedSessions),
    hasMoreBySession: omit(s.hasMoreBySession),
    queueBySession: omit(s.queueBySession),
    jobsBySession: omit(s.jobsBySession),
    goals: omit(s.goals),
    plans: omit(s.plans),
    modelsBySession: omit(s.modelsBySession),
    runningBySession: omit(s.runningBySession),
    titles: keepTitle ? s.titles : omit(s.titles)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function messageText(msg: unknown): string {
  const content = (msg as any)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('')
}

function handleFrame(set: Set, get: Get, frame: DownlinkFrame): void {
  if (frame.stream === 'host') {
    const type = frame.payload.type
    const sessionId = frame.payload.sessionId as string | undefined
    if (type === 'host/session-status' && sessionId) {
      set((s) => ({
        runningBySession: { ...s.runningBySession, [sessionId]: Boolean(frame.payload.running) }
      }))
      queueRefreshSessions(get)
    } else if (type === 'host/session-added' || type === 'host/session-removed') {
      if (type === 'host/session-removed' && sessionId) {
        set((s) => dropSessionData(s, sessionId, false))
      }
      queueRefreshSessions(get)
      queueRefreshWorkspaces(get)
    } else if (
      type === 'host/workspace-changed' ||
      type === 'host/workspace-removed' ||
      type === 'host/workspace-order-changed' ||
      type === 'host/archived-sessions-changed'
    ) {
      queueRefreshWorkspaces(get)
    }
    return
  }

  // mux stream
  const type = frame.payload.type
  const sessionId = frame.payload.sessionId as string | undefined

  if (type === 'session/event') {
    const raw = frame.payload.event as SessionEventView
    const event: SessionEventView = { ...raw, view: frame.payload.view }
    const s = get()
    const existing = s.eventsBySession[sessionId as string] ?? []
    const last = existing[existing.length - 1]
    if (!last || last.seq < event.seq) {
      set({
        eventsBySession: { ...s.eventsBySession, [sessionId as string]: [...existing, event] }
      })
    }
    if (event.type === 'turn/start') {
      set((st) => ({ runningBySession: { ...st.runningBySession, [sessionId as string]: true } }))
    } else if (event.type === 'turn/end') {
      set((st) => ({ runningBySession: { ...st.runningBySession, [sessionId as string]: false } }))
      queueRefreshSessions(get)
    }
  } else if (type === 'session/projection') {
    const key = frame.payload.key as string
    const value = frame.payload.value
    if (key === 'title' && sessionId) {
      set((s) => ({ titles: { ...s.titles, [sessionId]: value as string | null } }))
    } else if (key === 'plan' && sessionId) {
      const p = value as PlanState
      set((s) => ({ plans: { ...s.plans, [sessionId]: p } }))
    } else if (key === 'goal' && sessionId) {
      set((s) => ({ goals: { ...s.goals, [sessionId]: value as GoalView | null } }))
    }
  } else if (type === 'session/jobs') {
    set((s) => ({
      jobsBySession: {
        ...s.jobsBySession,
        [sessionId as string]: (frame.payload.jobs as JobView[]) ?? []
      }
    }))
  } else if (type === 'session/queue') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (frame.payload.items as any[]) ?? []
    set((s) => ({
      queueBySession: {
        ...s.queueBySession,
        [sessionId as string]: items.map((it) => ({
          id: it.id as string,
          placement: it.placement as QueueItem['placement'],
          text: messageText(it.message)
        }))
      }
    }))
  } else if (type === 'session/subscribed') {
    const s = get()
    if (s.selectedId === sessionId && !s.loadedSessions[sessionId as string]) {
      void get().loadHistory(sessionId as string)
    }
  } else if (type === 'approval/requested') {
    const approvalId = frame.payload.approvalId as string
    set((s) => ({
      approvals: {
        ...s.approvals,
        [approvalId]: {
          rpcId: frame.rpcId,
          sessionId: sessionId as string,
          approvalId,
          toolName: (frame.payload.toolName as string) ?? 'tool',
          reason: frame.payload.reason as string | undefined
        }
      }
    }))
  } else if (type === 'approval/resolved') {
    const approvalId = frame.payload.approvalId as string
    set((s) => {
      const { [approvalId]: _drop, ...rest } = s.approvals
      return { approvals: rest }
    })
  } else if (type === 'question/requested') {
    set((s) => ({
      questions: {
        ...s.questions,
        [frame.rpcId]: {
          rpcId: frame.rpcId,
          sessionId: sessionId as string,
          questions: (frame.payload.questions as PendingQuestion['questions']) ?? []
        }
      }
    }))
  } else if (type === 'question/resolved') {
    const qid = frame.payload.questionRpcId as string
    set((s) => {
      const { [qid]: _drop, ...rest } = s.questions
      return { questions: rest }
    })
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  host: { baseUrl: '', port: 0, state: 'connecting' },
  sessions: [],
  selectedId: null,
  eventsBySession: {},
  runningBySession: {},
  loadedSessions: {},
  titles: {},
  plans: {},
  workspaces: [],
  archivedSessionIds: [],
  modelsBySession: {},
  approvals: {},
  questions: {},
  hasMoreBySession: {},
  queueBySession: {},
  jobsBySession: {},
  goals: {},
  searchResults: null,
  searching: false,
  searchError: null,
  view: 'chat',
  lastError: null,

  reportError: (message) => set({ lastError: message }),

  dismissError: () => set({ lastError: null }),

  init: async () => {
    // Guard with an in-flight flag and flip `initialized` only after the
    // listeners are registered: flipping it before the first await used to
    // brick the app silently when the boot IPC failed (no listeners, no retry).
    if (get().initialized || initInFlight) return
    initInFlight = true
    try {
      const dsh = window.dsh
      const host = await dsh.getHostInfo()
      set({ host })
      dsh.onHostInfo((info) => {
        const prev = get().host
        set({ host: info })
        // Reconnect compensation: frames were dropped while the link was
        // down, so pull everything fresh instead of trusting stale state
        // (running flags, queue, workspace membership, selected history).
        if (info.state === 'connected' && prev.state === 'reconnecting') {
          void get().refreshSessions()
          void get().refreshWorkspaces()
          const sel = get().selectedId
          if (sel) {
            void get().loadHistory(sel)
            void get().loadSessionModels(sel)
          }
        }
      })
      dsh.onFrame((frame) => handleFrame(set, get, frame))
      await Promise.all([get().refreshSessions(), get().refreshWorkspaces()])
      set({ initialized: true })
    } catch (error) {
      reportStoreError(get, '初始化', error)
    } finally {
      initInFlight = false
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await window.dsh.listSessions()
      const titles: Record<string, string | null> = {}
      for (const s of sessions) titles[s.sessionId] = s.title ?? null
      set((prev) => {
        // The list RPC carries the authoritative running flag; sync it so a
        // missed turn/end frame can't pin a session at "运行中" forever.
        const runningBySession = { ...prev.runningBySession }
        for (const s of sessions) runningBySession[s.sessionId] = s.running
        return { sessions, titles: { ...prev.titles, ...titles }, runningBySession }
      })
    } catch (error) {
      console.error('listSessions failed:', error)
    }
  },

  refreshWorkspaces: async () => {
    try {
      const { items, archivedSessionIds } = await window.dsh.listWorkspaces()
      set({ workspaces: items, archivedSessionIds })
    } catch (error) {
      console.error('listWorkspaces failed:', error)
    }
  },

  selectSession: async (id) => {
    set({ selectedId: id, view: 'chat' })
    if (!get().loadedSessions[id]) {
      await get().loadHistory(id)
    }
    await get().loadSessionModels(id)
  },

  loadHistory: async (id) => {
    try {
      const { events, title, plan, goal, hasMore } = await window.dsh.history(id)
      set((s) => ({
        // Merge, don't replace: live frames that arrived during the await
        // must survive (see mergeEvents).
        eventsBySession: { ...s.eventsBySession, [id]: mergeEvents(events, s.eventsBySession[id] ?? []) },
        loadedSessions: { ...s.loadedSessions, [id]: true },
        hasMoreBySession: { ...s.hasMoreBySession, [id]: hasMore },
        titles: title !== undefined ? { ...s.titles, [id]: title } : s.titles,
        plans: plan !== undefined ? { ...s.plans, [id]: plan } : s.plans,
        goals: goal !== undefined ? { ...s.goals, [id]: goal } : s.goals
      }))
    } catch (error) {
      reportStoreError(get, '加载历史', error)
    }
  },

  loadOlder: async (id) => {
    const existing = get().eventsBySession[id] ?? []
    const oldest = existing[0]?.seq
    if (oldest === undefined) return
    try {
      const { events, hasMore } = await window.dsh.history(id, oldest)
      set((s) => ({
        eventsBySession: { ...s.eventsBySession, [id]: mergeEvents(events, s.eventsBySession[id] ?? []) },
        hasMoreBySession: { ...s.hasMoreBySession, [id]: hasMore }
      }))
    } catch (error) {
      console.error('loadOlder failed:', error)
    }
  },

  newSession: async (opts) => {
    try {
      const { sessionId } = await window.dsh.createSession(opts)
      set((s) => ({
        selectedId: sessionId,
        view: 'chat',
        loadedSessions: { ...s.loadedSessions, [sessionId]: true },
        eventsBySession: { ...s.eventsBySession, [sessionId]: [] }
      }))
      await Promise.all([get().refreshSessions(), get().refreshWorkspaces()])
    } catch (error) {
      reportStoreError(get, '新建会话', error)
    }
  },

  send: async (content) => {
    const id = get().selectedId
    if (!id) return false
    try {
      await window.dsh.prompt(id, content)
      return true
    } catch (error) {
      reportStoreError(get, '发送消息', error)
      return false
    }
  },

  cancel: async () => {
    const id = get().selectedId
    if (!id) return
    try {
      await window.dsh.cancel(id)
    } catch (error) {
      reportStoreError(get, '停止生成', error)
    }
  },

  forkSession: async (id) => {
    try {
      const { sessionId } = await window.dsh.forkSession(id)
      set((s) => ({
        selectedId: sessionId,
        view: 'chat',
        loadedSessions: { ...s.loadedSessions, [sessionId]: true },
        eventsBySession: { ...s.eventsBySession, [sessionId]: [] }
      }))
      await Promise.all([get().refreshSessions(), get().refreshWorkspaces()])
      await get().loadHistory(sessionId)
    } catch (error) {
      reportStoreError(get, '分支会话', error)
    }
  },

  search: async (query) => {
    const q = query.trim()
    // Request token: slow earlier responses must not clobber newer queries.
    const token = ++searchToken
    if (!q) {
      set({ searchResults: null, searchError: null, searching: false })
      return
    }
    set({ searching: true, searchError: null })
    try {
      const { items } = await window.dsh.searchSessions(q)
      if (token === searchToken) set({ searchResults: items })
    } catch (error) {
      console.error('searchSessions failed:', error)
      if (token === searchToken) {
        set({ searchResults: [], searchError: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      if (token === searchToken) set({ searching: false })
    }
  },

  clearSearch: () => set({ searchResults: null, searchError: null }),

  removeQueueItem: async (sessionId, itemId) => {
    try {
      await window.dsh.updateQueue(sessionId, itemId, { kind: 'remove' })
      set((s) => ({
        queueBySession: {
          ...s.queueBySession,
          [sessionId]: (s.queueBySession[sessionId] ?? []).filter((q) => q.id !== itemId)
        }
      }))
    } catch (error) {
      reportStoreError(get, '移除排队消息', error)
    }
  },

  steerQueueItem: async (sessionId, itemId) => {
    try {
      await window.dsh.updateQueue(sessionId, itemId, { kind: 'steer' })
    } catch (error) {
      reportStoreError(get, '插队发送', error)
    }
  },

  goalCreate: async (objective, maxGoalRounds) => {
    const id = get().selectedId
    if (!id) return
    try {
      await window.dsh.goalCreate(id, objective, maxGoalRounds)
    } catch (error) {
      reportStoreError(get, '创建目标', error)
    }
  },

  goalEdit: async (objective, maxGoalRounds) => {
    const id = get().selectedId
    const goal = id ? get().goals[id] : undefined
    if (!id || !goal) return
    try {
      await window.dsh.goalEdit(id, { id: goal.goal.id, revision: goal.goal.revision }, objective, maxGoalRounds)
    } catch (error) {
      reportStoreError(get, '编辑目标', error)
    }
  },

  goalPause: async () => {
    const id = get().selectedId
    const goal = id ? get().goals[id] : undefined
    if (!id || !goal) return
    try {
      await window.dsh.goalPause(id, { id: goal.goal.id, revision: goal.goal.revision })
    } catch (error) {
      reportStoreError(get, '暂停目标', error)
    }
  },

  goalResume: async () => {
    const id = get().selectedId
    const goal = id ? get().goals[id] : undefined
    if (!id || !goal) return
    try {
      await window.dsh.goalResume(id, { id: goal.goal.id, revision: goal.goal.revision })
    } catch (error) {
      reportStoreError(get, '继续目标', error)
    }
  },

  goalComplete: async () => {
    const id = get().selectedId
    const goal = id ? get().goals[id] : undefined
    if (!id || !goal) return
    try {
      await window.dsh.goalComplete(id, { id: goal.goal.id, revision: goal.goal.revision })
    } catch (error) {
      reportStoreError(get, '完成目标', error)
    }
  },

  goalClear: async () => {
    const id = get().selectedId
    const goal = id ? get().goals[id] : undefined
    if (!id || !goal) return
    try {
      await window.dsh.goalClear(id, { id: goal.goal.id, revision: goal.goal.revision })
    } catch (error) {
      reportStoreError(get, '清除目标', error)
    }
  },

  renameSession: async (id, title) => {
    try {
      const { title: normalized } = await window.dsh.sessionRename(id, title)
      set((s) => ({ titles: { ...s.titles, [id]: normalized } }))
    } catch (error) {
      reportStoreError(get, '重命名会话', error)
    }
  },

  archiveSession: async (id) => {
    try {
      await window.dsh.archiveSession(id)
      set((s) => ({
        ...(get().selectedId === id ? { selectedId: null } : {}),
        ...dropSessionData(s, id)
      }))
      await Promise.all([get().refreshSessions(), get().refreshWorkspaces()])
    } catch (error) {
      reportStoreError(get, '归档会话', error)
    }
  },

  createWorkspace: async (path) => {
    // Let errors propagate: the sidebar surfaces them next to the button.
    const result = await window.dsh.createWorkspace(path)
    await get().refreshWorkspaces()
    return result
  },

  renameWorkspace: async (id, title) => {
    try {
      await window.dsh.renameWorkspace(id, title)
      await get().refreshWorkspaces()
    } catch (error) {
      reportStoreError(get, '重命名工作区', error)
    }
  },

  deleteWorkspace: async (id) => {
    try {
      await window.dsh.deleteWorkspace(id)
      await get().refreshWorkspaces()
    } catch (error) {
      reportStoreError(get, '移除工作区', error)
    }
  },

  moveSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
    try {
      await window.dsh.moveSessionBefore(workspaceId, sessionId, beforeSessionId)
      await get().refreshWorkspaces()
    } catch (error) {
      reportStoreError(get, '移动会话', error)
    }
  },

  reorderWorkspace: async (workspaceId, beforeWorkspaceId) => {
    try {
      await window.dsh.reorderWorkspace(workspaceId, beforeWorkspaceId)
      await get().refreshWorkspaces()
    } catch (error) {
      reportStoreError(get, '调整工作区顺序', error)
    }
  },

  loadSessionModels: async (id) => {
    try {
      const models = await window.dsh.sessionModels(id)
      set((s) => ({ modelsBySession: { ...s.modelsBySession, [id]: models } }))
    } catch (error) {
      console.error('sessionModels failed:', error)
    }
  },

  selectModel: async (id, provider, model) => {
    try {
      await window.dsh.sessionSelectModel(id, provider, model)
      await get().loadSessionModels(id)
    } catch (error) {
      reportStoreError(get, '切换模型', error)
    }
  },

  respondApproval: async (approvalId, outcome) => {
    const item = get().approvals[approvalId]
    if (!item) return
    set((s) => {
      const { [approvalId]: _drop, ...rest } = s.approvals
      return { approvals: rest }
    })
    try {
      await window.dsh.respond(item.rpcId, {
        sessionId: item.sessionId,
        approvalId: item.approvalId,
        outcome
      })
    } catch (error) {
      // Restore the card: the host still holds the approval pending, and
      // dropping it here would strand the turn with no way to answer.
      set((s) => ({ approvals: { ...s.approvals, [approvalId]: item } }))
      reportStoreError(get, '提交审批', error)
    }
  },

  respondQuestion: async (rpcId, answers) => {
    const item = get().questions[rpcId]
    if (!item) return
    set((s) => {
      const { [rpcId]: _drop, ...rest } = s.questions
      return { questions: rest }
    })
    try {
      await window.dsh.respond(rpcId, { sessionId: item.sessionId, answer: { answers } })
    } catch (error) {
      // Restore: the question is still pending on the host.
      set((s) => ({ questions: { ...s.questions, [rpcId]: item } }))
      reportStoreError(get, '提交回答', error)
    }
  },

  setView: (view) => set({ view })
}))
