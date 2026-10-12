import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useAppStore } from './store'
import { deriveTimeline } from './timeline'
import { ToolCard } from './ToolCard'
import type { SubagentEntry } from '@shared/ipc'

type ChildEntry = Extract<SubagentEntry, { kind: 'child' }>

export function SubagentsPanel({ parentSessionId, onClose }: { parentSessionId: string; onClose: () => void }): ReactElement {
  const [entries, setEntries] = useState<SubagentEntry[]>([])
  const [selected, setSelected] = useState<ChildEntry | null>(null)
  const [transcript, setTranscript] = useState<ReturnType<typeof deriveTimeline>>([])
  const [followUp, setFollowUp] = useState('')
  const [error, setError] = useState('')
  /** Drops out-of-order transcript responses when entries are clicked in quick succession. */
  const transcriptSeq = useRef(0)

  const load = async (): Promise<void> => {
    try {
      const { entries } = await window.dsh.subagentList(parentSessionId)
      setEntries(entries)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load()
  }, [parentSessionId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openTranscript = async (e: ChildEntry): Promise<void> => {
    const seq = ++transcriptSeq.current
    setSelected(e)
    setTranscript([])
    try {
      const { events } = await window.dsh.subagentHistory(parentSessionId, e.id, e.mode)
      if (seq === transcriptSeq.current) setTranscript(deriveTimeline(events))
    } catch (err) {
      if (seq === transcriptSeq.current) setError(err instanceof Error ? err.message : String(err))
    }
  }

  const reportAction = (context: string) => (e: unknown) => {
    setError(`${context}:${e instanceof Error ? e.message : String(e)}`)
  }

  const children = entries.filter((e): e is ChildEntry => e.kind === 'child')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal subagents-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>子代理 ({children.length})</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="subagents-body">
          <div className="subagents-list">
            {error ? <div className="settings-message err">{error.slice(0, 200)}</div> : null}
            {children.length === 0 ? <div className="empty">暂无子代理</div> : null}
            {children.map((e) => (
              <button
                key={e.id}
                className={`subagent-item ${selected?.id === e.id ? 'active' : ''}`}
                onClick={() => void openTranscript(e)}
              >
                <span className={`dot ${e.activity === 'running' ? 'running' : ''}`} />
                <span className="session-title">{e.label || e.id.slice(-8)}</span>
                <span className="subagent-mode">{e.mode === 'continuable' ? '可续' : '一次性'}</span>
              </button>
            ))}
          </div>
          <div className="subagents-transcript">
            {selected ? (
              <>
                <div className="subagent-toolbar">
                  <span className="session-title">{selected.label || selected.id.slice(-8)}</span>
                  {selected.mode === 'continuable' && selected.activity === 'running' ? (
                    <button
                      className="danger-btn"
                      onClick={() => void window.dsh.subagentInterrupt(parentSessionId, selected.id).catch(reportAction('中断失败'))}
                    >
                      中断
                    </button>
                  ) : null}
                </div>
                <div className="subagent-messages">
                  {transcript.length === 0 ? (
                    <div className="empty">无内容</div>
                  ) : (
                    transcript.map((item) => {
                      if (item.kind === 'user') {
                        return (
                          <div key={`${item.kind}-${item.seq}`} className="row user">
                            <div className="bubble">{item.text}</div>
                          </div>
                        )
                      }
                      if (item.kind === 'assistant') {
                        return (
                          <div key={`${item.kind}-${item.seq}`} className="row assistant">
                            <div className="bubble">{item.text}</div>
                          </div>
                        )
                      }
                      return (
                        <div key={`${item.kind}-${item.seq}`} className="row tool-row">
                          <ToolCard item={item} />
                        </div>
                      )
                    })
                  )}
                </div>
                {selected.mode === 'continuable' ? (
                  <div className="subagent-followup">
                    <input
                      className="form-input"
                      placeholder="给子代理发后续消息…"
                      value={followUp}
                      onChange={(e) => setFollowUp(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && followUp.trim() && !e.nativeEvent.isComposing) {
                          void window.dsh.subagentPrompt(parentSessionId, selected.id, followUp.trim()).catch(reportAction('发送失败'))
                          setFollowUp('')
                        }
                      }}
                    />
                    <button
                      className="send"
                      disabled={!followUp.trim()}
                      onClick={() => {
                        void window.dsh.subagentPrompt(parentSessionId, selected.id, followUp.trim()).catch(reportAction('发送失败'))
                        setFollowUp('')
                      }}
                    >
                      发送
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="empty">选择一个子代理查看其执行记录。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
