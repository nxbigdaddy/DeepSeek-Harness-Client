import { useState, type ReactElement } from 'react'
import { useAppStore } from './store'
import type { PendingApproval, PendingQuestion, QuestionItem } from '@shared/ipc'

function ApprovalCard({ item }: { item: PendingApproval }): ReactElement {
  const respondApproval = useAppStore((s) => s.respondApproval)
  return (
    <div className="prompt-card">
      <div className="prompt-title">工具执行请求</div>
      <div className="prompt-tool">🛠 {item.toolName}</div>
      {item.reason ? <pre className="prompt-detail">{item.reason}</pre> : null}
      <div className="prompt-actions">
        <button className="send" onClick={() => void respondApproval(item.approvalId, 'allowed-once')}>
          允许
        </button>
        <button className="danger-btn" onClick={() => void respondApproval(item.approvalId, 'rejected')}>
          拒绝
        </button>
      </div>
    </div>
  )
}

function QuestionCard({ item }: { item: PendingQuestion }): ReactElement {
  const respondQuestion = useAppStore((s) => s.respondQuestion)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})

  const toggle = (q: QuestionItem, label: string): void => {
    setSelected((prev) => {
      const cur = prev[q.id] ?? []
      if (q.multiSelect) {
        return { ...prev, [q.id]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      }
      return { ...prev, [q.id]: [label] }
    })
  }

  const submit = (): void => {
    const answers = item.questions.map((q) => ({
      id: q.id,
      selected: selected[q.id] ?? [],
      custom: custom[q.id] || undefined
    }))
    void respondQuestion(item.rpcId, answers)
  }

  // Every question needs at least one pick or a non-empty custom answer.
  const canSubmit = item.questions.every(
    (q) => (selected[q.id]?.length ?? 0) > 0 || (custom[q.id]?.trim() ?? '') !== ''
  )

  return (
    <div className="prompt-card">
      {item.questions.map((q) => {
        const isPlan = q.intent?.kind === 'plan-review'
        return (
          <div key={q.id} className="prompt-question">
            {q.header ? <div className="prompt-title">{q.header}</div> : null}
            <div className="prompt-q-text">{q.question}</div>
            {isPlan && q.detail ? (
              <pre className="prompt-plan">{q.detail}</pre>
            ) : q.detail ? (
              <pre className="prompt-detail">{q.detail}</pre>
            ) : null}
            {q.options && q.options.length > 0 ? (
              <div className="prompt-options">
                {q.options.map((o) => {
                  const active = (selected[q.id] ?? []).includes(o.label)
                  return (
                    <button
                      key={o.label}
                      className={`prompt-option ${active ? 'active' : ''}`}
                      onClick={() => toggle(q, o.label)}
                      title={o.description}
                    >
                      {q.multiSelect ? (active ? '☑' : '☐') : active ? '●' : '○'} {o.label}
                    </button>
                  )
                })}
              </div>
            ) : (
              <input
                className="form-input"
                placeholder="输入回答…"
                value={custom[q.id] ?? ''}
                onChange={(e) => setCustom((prev) => ({ ...prev, [q.id]: e.target.value }))}
              />
            )}
          </div>
        )
      })}
      <div className="prompt-actions">
        <button className="send" onClick={submit} disabled={!canSubmit} title={canSubmit ? '' : '每题至少选择一项或填写回答'}>
          提交
        </button>
      </div>
    </div>
  )
}

export function PromptLayer(): ReactElement | null {
  const approvals = useAppStore((s) => s.approvals)
  const questions = useAppStore((s) => s.questions)
  const approvalItems = Object.values(approvals)
  const questionItems = Object.values(questions)
  if (approvalItems.length === 0 && questionItems.length === 0) return null

  return (
    <div className="modal-overlay">
      <div className="modal prompt-modal">
        <div className="modal-header">
          <span>需要你的确认</span>
        </div>
        <div className="prompt-body">
          {approvalItems.map((a) => (
            <ApprovalCard key={a.approvalId} item={a} />
          ))}
          {questionItems.map((q) => (
            <QuestionCard key={q.rpcId} item={q} />
          ))}
        </div>
      </div>
    </div>
  )
}
