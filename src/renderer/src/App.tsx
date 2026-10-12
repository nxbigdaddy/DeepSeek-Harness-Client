import { useEffect, useState, type DragEvent, type ReactElement } from 'react'
import { useAppStore } from './store'
import { ChatView } from './ChatView'
import { SettingsView } from './SettingsView'
import { CapabilitiesView } from './CapabilitiesView'
import { DirectoryModal } from './DirectoryModal'
import { PromptLayer } from './Prompts'
import type { Workspace } from '@shared/ipc'

function statusLabel(state: string, port: number): string {
  if (state === 'connected') return `已连接 127.0.0.1:${port}`
  if (state === 'connecting') return '正在启动内嵌 host…'
  return '连接中断,重连中…'
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function shortId(id: string): string {
  return id.startsWith('session-') ? id.slice('session-'.length).slice(0, 8) : id.slice(0, 8)
}

/** Which half of a row the pointer is over (insert-before vs insert-after). */
function halfOf(e: DragEvent): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** Skip no-op reorders: dropping onto self, or onto the boundary already occupied. */
function isNoopMove(ids: string[], draggedId: string, anchorId: string | undefined): boolean {
  if (anchorId === draggedId) return true
  const sourceIndex = ids.indexOf(draggedId)
  const anchorIndex = anchorId === undefined ? ids.length : ids.indexOf(anchorId)
  return sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)
}

interface SessionDrag {
  sessionId: string
  workspaceId: string
}

interface SessionDropHint {
  workspaceId: string
  beforeSessionId?: string
}

export default function App(): ReactElement {
  const {
    host,
    sessions,
    titles,
    workspaces,
    archivedSessionIds,
    selectedId,
    view,
    setView,
    selectSession,
    newSession,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    moveSessionBefore,
    reorderWorkspace,
    lastError,
    dismissError,
    searchResults,
    searching,
    search,
    searchError,
    clearSearch,
    init
  } = useAppStore()

  const [editingWs, setEditingWs] = useState<string | null>(null)
  const [wsTitle, setWsTitle] = useState('')
  const [confirmDeleteWs, setConfirmDeleteWs] = useState<string | null>(null)
  const [wsError, setWsError] = useState('')
  const [wsNotice, setWsNotice] = useState<{ kind: 'ok' | 'info'; text: string } | null>(null)
  const [query, setQuery] = useState('')
  const [dirModalOpen, setDirModalOpen] = useState(false)
  const [sessionDrag, setSessionDrag] = useState<SessionDrag | null>(null)
  const [sessionDrop, setSessionDrop] = useState<SessionDropHint | null>(null)
  const [wsDrag, setWsDrag] = useState<string | null>(null)
  const [wsDrop, setWsDrop] = useState<{ beforeWorkspaceId?: string } | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const t = setTimeout(() => void search(query), 300)
    return () => clearTimeout(t)
  }, [query, search])

  useEffect(() => {
    if (confirmDeleteWs) {
      const t = setTimeout(() => setConfirmDeleteWs(null), 3000)
      return () => clearTimeout(t)
    }
  }, [confirmDeleteWs])

  useEffect(() => {
    if (wsNotice) {
      const t = setTimeout(() => setWsNotice(null), 4000)
      return () => clearTimeout(t)
    }
  }, [wsNotice])

  // Drag-state insurance: if the source row unmounts mid-drag (list refresh
  // from a host frame), its onDragEnd never fires — clear on global drop/end.
  useEffect(() => {
    if (!sessionDrag && !wsDrag) return
    const clear = (): void => {
      setSessionDrag(null)
      setSessionDrop(null)
      setWsDrag(null)
      setWsDrop(null)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [sessionDrag, wsDrag])

  const sessionsById = new Map(sessions.map((s) => [s.sessionId, s]))
  const workspaceBySession = new Map<string, string>()
  for (const w of workspaces) for (const sid of w.sessionIds) workspaceBySession.set(sid, w.workspaceId)
  const ungrouped = sessions.filter(
    (s) => !workspaceBySession.has(s.sessionId) && !archivedSessionIds.includes(s.sessionId)
  )
  const archived = sessions.filter((s) => archivedSessionIds.includes(s.sessionId))

  const adoptWorkspaceFolder = async (path: string): Promise<void> => {
    setWsError('')
    setWsNotice(null)
    try {
      const { workspace, created } = await createWorkspace(path)
      if (created) {
        setWsNotice({ kind: 'ok', text: `已添加工作区:${workspace.title}` })
        // Open-and-go: a freshly adopted folder starts with a session in it.
        await newSession({ workspaceId: workspace.workspaceId })
      } else {
        setWsNotice({ kind: 'info', text: `该文件夹已是工作区:${workspace.title}` })
      }
    } catch (e) {
      setWsError(e instanceof Error ? e.message : String(e))
    }
  }

  const openWorkspaceInExplorer = async (path: string): Promise<void> => {
    setWsError('')
    try {
      await window.dsh.openPath(path)
    } catch (e) {
      setWsError(e instanceof Error ? e.message : String(e))
    }
  }

  const commitWsRename = async (id: string): Promise<void> => {
    const t = wsTitle.trim()
    setEditingWs(null)
    if (t) await renameWorkspace(id, t)
  }

  const endSessionDrag = (): void => {
    setSessionDrag(null)
    setSessionDrop(null)
  }

  const endWorkspaceDrag = (): void => {
    setWsDrag(null)
    setWsDrop(null)
  }

  const renderSession = (s: { sessionId: string; running: boolean; updatedAt: number }): ReactElement => {
    const title = titles[s.sessionId] || `会话 ${shortId(s.sessionId)}`
    return (
      <button
        key={s.sessionId}
        className={`session-item ${s.sessionId === selectedId ? 'active' : ''}`}
        onClick={() => void selectSession(s.sessionId)}
      >
        <span className={`dot ${s.running ? 'running' : ''}`} />
        <span className="session-title">{title}</span>
        <span className="session-time">{formatTime(s.updatedAt)}</span>
      </button>
    )
  }

  /** A session row inside a workspace: draggable for in-workspace reorder. */
  const renderWorkspaceSession = (
    s: { sessionId: string; running: boolean; updatedAt: number },
    w: Workspace,
    index: number
  ): ReactElement => {
    const title = titles[s.sessionId] || `会话 ${shortId(s.sessionId)}`
    const dropBefore = sessionDrop?.workspaceId === w.workspaceId && sessionDrop.beforeSessionId === s.sessionId
    return (
      <button
        key={s.sessionId}
        className={[
          'session-item',
          s.sessionId === selectedId ? 'active' : '',
          dropBefore ? 'drop-before' : '',
          sessionDrag?.sessionId === s.sessionId ? 'dragging' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', s.sessionId)
          setSessionDrag({ sessionId: s.sessionId, workspaceId: w.workspaceId })
        }}
        onDragEnd={endSessionDrag}
        onDragOver={(e) => {
          if (!sessionDrag || sessionDrag.workspaceId !== w.workspaceId) return
          e.preventDefault()
          e.stopPropagation()
          const anchor = halfOf(e) === 'before' ? s.sessionId : w.sessionIds[index + 1]
          // dragover fires per mousemove; only setState on real changes.
          setSessionDrop((prev) =>
            prev?.workspaceId === w.workspaceId && prev.beforeSessionId === anchor
              ? prev
              : { workspaceId: w.workspaceId, beforeSessionId: anchor }
          )
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (sessionDrag && sessionDrag.workspaceId === w.workspaceId) {
            const anchor = halfOf(e) === 'before' ? s.sessionId : w.sessionIds[index + 1]
            if (!isNoopMove(w.sessionIds, sessionDrag.sessionId, anchor)) {
              void moveSessionBefore(w.workspaceId, sessionDrag.sessionId, anchor)
            }
          }
          endSessionDrag()
        }}
        onClick={() => void selectSession(s.sessionId)}
      >
        <span className={`dot ${s.running ? 'running' : ''}`} />
        <span className="session-title">{title}</span>
        <span className="session-time">{formatTime(s.updatedAt)}</span>
      </button>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-title">DSH Client</span>
          <span className={`status ${host.state}`}>{statusLabel(host.state, host.port)}</span>
          {host.error ? (
            <span className="status-error" title={host.error}>
              {host.error.slice(0, 160)}
            </span>
          ) : null}
          {host.state !== 'connected' ? (
            <button
              className="ghost-btn retry-btn"
              title="重启内嵌 host 并重新连接"
              onClick={() => void window.dsh.retryConnect().catch(() => undefined)}
            >
              重试连接
            </button>
          ) : null}
        </div>

        {lastError ? (
          <div className="error-bar" role="alert">
            <span className="error-text" title={lastError}>
              {lastError}
            </span>
            <button className="icon-btn" title="忽略" onClick={dismissError}>
              ✕
            </button>
          </div>
        ) : null}

        <div className="sidebar-actions">
          <button className="new-session" onClick={() => void newSession()}>
            + 新建会话
          </button>
          <button
            className="new-workspace"
            title="选择电脑上已有的项目文件夹作为工作区(也可在对话框中新建文件夹)"
            onClick={() => setDirModalOpen(true)}
          >
            📂 打开项目文件夹…
          </button>
        </div>

        <div className="search-box">
          <input
            className="search-input"
            placeholder="搜索会话内容…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() ? (
            <div className="search-results">
              {searching ? (
                <div className="empty">搜索中…</div>
              ) : searchError ? (
                <div className="settings-message err">{searchError.slice(0, 200)}</div>
              ) : searchResults && searchResults.length === 0 ? (
                <div className="empty">无结果</div>
              ) : (
                (searchResults ?? []).map((r) => (
                  <button
                    key={r.sessionId}
                    className="search-result"
                    onClick={() => {
                      void selectSession(r.sessionId)
                      clearSearch()
                      setQuery('')
                    }}
                  >
                    <span className="session-title">{titles[r.sessionId] || r.sessionId.slice(-8)}</span>
                    <span className="search-snippet">{r.snippet}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        <div className="session-list">
          {wsError ? <div className="settings-message err">{wsError}</div> : null}
          {wsNotice ? <div className={`settings-message ${wsNotice.kind}`}>{wsNotice.text}</div> : null}
          {workspaces.map((w, wIndex) => (
            <div key={w.workspaceId} className="workspace">
              <div
                className={[
                  'workspace-header',
                  wsDrop?.beforeWorkspaceId === w.workspaceId ? 'drop-before' : '',
                  wsDrag === w.workspaceId ? 'dragging' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                draggable={editingWs !== w.workspaceId}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', w.workspaceId)
                  setWsDrag(w.workspaceId)
                }}
                onDragEnd={endWorkspaceDrag}
                onDragOver={(e) => {
                  if (wsDrag && wsDrag !== w.workspaceId) {
                    e.preventDefault()
                    const anchor = halfOf(e) === 'before' ? w.workspaceId : workspaces[wIndex + 1]?.workspaceId
                    setWsDrop((prev) => (prev?.beforeWorkspaceId === anchor ? prev : { beforeWorkspaceId: anchor }))
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (wsDrag && wsDrag !== w.workspaceId) {
                    const anchor = halfOf(e) === 'before' ? w.workspaceId : workspaces[wIndex + 1]?.workspaceId
                    if (!isNoopMove(workspaces.map((x) => x.workspaceId), wsDrag, anchor)) {
                      void reorderWorkspace(wsDrag, anchor)
                    }
                  }
                  endWorkspaceDrag()
                }}
              >
                {editingWs === w.workspaceId ? (
                  <input
                    className="inline-input"
                    autoFocus
                    value={wsTitle}
                    onChange={(e) => setWsTitle(e.target.value)}
                    onBlur={() => void commitWsRename(w.workspaceId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitWsRename(w.workspaceId)
                      if (e.key === 'Escape') setEditingWs(null)
                    }}
                  />
                ) : (
                  <span className="workspace-title" title={w.path}>
                    📁 {w.title}
                  </span>
                )}
                <span className="workspace-actions">
                  <button
                    className="icon-btn"
                    title="在文件管理器中打开"
                    onClick={() => void openWorkspaceInExplorer(w.path)}
                  >
                    ↗
                  </button>
                  <button
                    className="icon-btn"
                    title="新建会话到此工作区"
                    onClick={() => void newSession({ workspaceId: w.workspaceId })}
                  >
                    +
                  </button>
                  <button
                    className="icon-btn"
                    title="重命名"
                    onClick={() => {
                      setEditingWs(w.workspaceId)
                      setWsTitle(w.title)
                    }}
                  >
                    ✎
                  </button>
                  {confirmDeleteWs === w.workspaceId ? (
                    <button
                      className="icon-btn danger"
                      title="确认删除(仅移除注册,不删文件)"
                      onClick={() => {
                        setConfirmDeleteWs(null)
                        void deleteWorkspace(w.workspaceId)
                      }}
                    >
                      确认
                    </button>
                  ) : (
                    <button className="icon-btn" title="移除工作区" onClick={() => setConfirmDeleteWs(w.workspaceId)}>
                      🗑
                    </button>
                  )}
                </span>
              </div>
              <div className="workspace-path" title={w.path}>
                {w.path}
              </div>
              {w.sessionIds.map((sid, index) => {
                const s = sessionsById.get(sid)
                if (!s || archivedSessionIds.includes(sid)) return null
                return renderWorkspaceSession(s, w, index)
              })}
              {sessionDrag?.workspaceId === w.workspaceId ? (
                <div
                  className={`ws-drop-tail ${sessionDrop?.workspaceId === w.workspaceId && sessionDrop.beforeSessionId === undefined ? 'active' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setSessionDrop((prev) =>
                      prev?.workspaceId === w.workspaceId && prev.beforeSessionId === undefined
                        ? prev
                        : { workspaceId: w.workspaceId, beforeSessionId: undefined }
                    )
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (sessionDrag && !isNoopMove(w.sessionIds, sessionDrag.sessionId, undefined)) {
                      void moveSessionBefore(w.workspaceId, sessionDrag.sessionId, undefined)
                    }
                    endSessionDrag()
                  }}
                />
              ) : null}
            </div>
          ))}

          {wsDrag ? (
            <div
              className={`ws-drop-tail ${wsDrop?.beforeWorkspaceId === undefined ? 'active' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setWsDrop((prev) => (prev?.beforeWorkspaceId === undefined ? prev : { beforeWorkspaceId: undefined }))
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (wsDrag && !isNoopMove(workspaces.map((x) => x.workspaceId), wsDrag, undefined)) {
                  void reorderWorkspace(wsDrag, undefined)
                }
                endWorkspaceDrag()
              }}
            />
          ) : null}

          {ungrouped.length > 0 ? (
            <div className="section-label">未分组</div>
          ) : null}
          {ungrouped.map(renderSession)}

          {archived.length > 0 ? (
            <details className="archived">
              <summary>已归档 ({archived.length})</summary>
              {archived.map(renderSession)}
            </details>
          ) : null}

          {sessions.length === 0 && workspaces.length === 0 ? <div className="empty">暂无会话</div> : null}
        </div>

        <div className="sidebar-footer">
          <button
            className={`view-tab ${view === 'chat' ? 'active' : ''}`}
            onClick={() => setView('chat')}
          >
            对话
          </button>
          <button
            className={`view-tab ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView('settings')}
          >
            设置
          </button>
          <button
            className={`view-tab ${view === 'capabilities' ? 'active' : ''}`}
            onClick={() => setView('capabilities')}
          >
            能力
          </button>
        </div>
      </aside>

      <main className="main">
        {view === 'chat' ? <ChatView /> : view === 'settings' ? <SettingsView /> : <CapabilitiesView />}
      </main>

      <DirectoryModal
        open={dirModalOpen}
        onClose={() => setDirModalOpen(false)}
        onPick={(path) => {
          setDirModalOpen(false)
          void adoptWorkspaceFolder(path)
        }}
      />

      <PromptLayer />
    </div>
  )
}
