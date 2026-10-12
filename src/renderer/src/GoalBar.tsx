import { useEffect, useState, type ReactElement } from 'react'
import { useAppStore } from './store'

const PHASE_LABEL: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  complete: '已完成'
}

export function GoalBar({ sessionId }: { sessionId: string }): ReactElement {
  const goal = useAppStore((s) => s.goals[sessionId])
  const goalCreate = useAppStore((s) => s.goalCreate)
  const goalEdit = useAppStore((s) => s.goalEdit)
  const goalPause = useAppStore((s) => s.goalPause)
  const goalResume = useAppStore((s) => s.goalResume)
  const goalComplete = useAppStore((s) => s.goalComplete)
  const goalClear = useAppStore((s) => s.goalClear)

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    if (!confirmClear) return
    const t = setTimeout(() => setConfirmClear(false), 3000)
    return () => clearTimeout(t)
  }, [confirmClear])

  if (creating) {
    return (
      <div className="goal-bar">
        <input
          className="form-input"
          autoFocus
          placeholder="输入目标描述(例如:把项目重构为模块化结构)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              void goalCreate(draft.trim())
              setDraft('')
              setCreating(false)
            }
            if (e.key === 'Escape') setCreating(false)
          }}
        />
        <button
          className="send"
          disabled={!draft.trim()}
          onClick={() => { void goalCreate(draft.trim()); setDraft(''); setCreating(false) }}
        >
          创建目标
        </button>
        <button className="ghost-btn" onClick={() => setCreating(false)}>
          取消
        </button>
      </div>
    )
  }

  if (!goal) {
    return (
      <div className="goal-bar">
        <button className="ghost-btn" onClick={() => { setDraft(''); setCreating(true) }}>
          🎯 创建目标
        </button>
      </div>
    )
  }

  const g = goal.goal
  return (
    <div className="goal-bar">
      <span className="goal-icon">🎯</span>
      {editing ? (
        <input
          className="form-input"
          autoFocus
          defaultValue={g.objective}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void goalEdit((e.target as HTMLInputElement).value.trim())
              setEditing(false)
            }
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span className="goal-objective" title="点击编辑目标" onClick={() => setEditing(true)}>
          {g.objective}
        </span>
      )}
      <span className={`goal-phase ${g.phase}`}>{PHASE_LABEL[g.phase] ?? g.phase}</span>
      <span className="goal-rounds">第 {goal.roundsStarted}/{g.maxGoalRounds} 轮</span>
      <div className="goal-actions">
        {g.phase === 'active' ? (
          <button className="ghost-btn" onClick={() => void goalPause()}>
            暂停
          </button>
        ) : g.phase === 'paused' ? (
          <button className="ghost-btn" onClick={() => void goalResume()}>
            继续
          </button>
        ) : null}
        {g.phase !== 'complete' ? (
          <button className="ghost-btn" onClick={() => void goalComplete()}>
            完成
          </button>
        ) : null}
        {confirmClear ? (
          <button
            className="danger-btn"
            onClick={() => {
              setConfirmClear(false)
              void goalClear()
            }}
          >
            确认清除?
          </button>
        ) : (
          <button className="ghost-btn" onClick={() => setConfirmClear(true)}>
            清除
          </button>
        )}
      </div>
      {g.blockedReason ? (
        <span className="goal-blocked" title={g.blockedReason.message}>
          ⚠ {g.blockedReason.code}
        </span>
      ) : null}
    </div>
  )
}
