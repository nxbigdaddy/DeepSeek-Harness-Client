import type { ReactElement } from 'react'
import { useAppStore } from './store'
import type { JobView } from '@shared/ipc'

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  stopping: '停止中',
  completed: '完成',
  killed: '已终止',
  failed: '失败'
}

export function JobsPanel({ sessionId }: { sessionId: string }): ReactElement | null {
  const jobs = useAppStore((s) => s.jobsBySession[sessionId] ?? [])
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'stopping')
  if (jobs.length === 0) return null

  return (
    <div className="jobs-panel">
      <div className="jobs-header">
        后台任务 {active.length > 0 ? `(${active.length} 运行中)` : ''}
      </div>
      <div className="jobs-list">
        {jobs.map((j: JobView) => (
          <div key={j.id} className="job-item">
            <span className={`job-status ${j.status}`}>{STATUS_LABEL[j.status] ?? j.status}</span>
            <span className="job-kind">{j.kind}</span>
            <span className="job-label" title={j.label}>
              {j.label}
            </span>
            {j.detail ? <span className="job-detail">{j.detail}</span> : null}
          </div>
        ))}
      </div>
    </div>
  )
}
