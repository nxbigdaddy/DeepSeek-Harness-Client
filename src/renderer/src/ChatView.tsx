import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { useAppStore } from './store'
import { deriveTimeline, type TimelineItem } from './timeline'
import { ToolCard } from './ToolCard'
import { GoalBar } from './GoalBar'
import { JobsPanel } from './JobsPanel'
import { SubagentsPanel } from './SubagentsPanel'
import { SLASH_COMMANDS, type SlashCommand } from './commands'
import type { PromptContentPart, QueueItem, SessionModels } from '@shared/ipc'

interface Attachment {
  mediaType: string
  data: string
  name?: string
}

/** Prompt images ride base64 over IPC + WS frames; cap before they blow those up. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

function AttachmentImage({
  sessionId,
  attachmentId,
  mediaType,
  name
}: {
  sessionId: string
  attachmentId: string
  mediaType: string
  name?: string
}): ReactElement {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.dsh
      .attachment(sessionId, attachmentId)
      .then((r) => {
        if (alive) setSrc(`data:${r.mediaType || mediaType};base64,${r.data}`)
      })
      .catch(() => {
        if (alive) setSrc(null)
      })
    return () => {
      alive = false
    }
  }, [sessionId, attachmentId, mediaType])
  if (!src) return <div className="attachment-loading">🖼 {name ?? '图片加载中…'}</div>
  return <img className="attachment-img" src={src} alt={name ?? ''} />
}

function MessageItem({ item, sessionId }: { item: TimelineItem; sessionId: string }): ReactElement | null {
  if (item.kind === 'user') {
    return (
      <div className="row user">
        <div className="bubble">
          {item.text ? <div>{item.text}</div> : null}
          {item.images.length > 0 ? (
            <div className="attachment-row">
              {item.images.map((img) => (
                <AttachmentImage
                  key={img.attachmentId}
                  sessionId={sessionId}
                  attachmentId={img.attachmentId}
                  mediaType={img.mediaType}
                  name={img.name}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div className="row assistant">
        <div className="bubble">
          {item.reasoning ? (
            <details className="reasoning">
              <summary>思考过程</summary>
              <pre>{item.reasoning}</pre>
            </details>
          ) : null}
          <div className={`text ${item.finalized ? '' : 'streaming'}`}>
            {item.text || (item.finalized ? '' : '…')}
          </div>
        </div>
      </div>
    )
  }
  if (item.kind === 'tool') {
    return (
      <div className="row tool-row">
        <ToolCard item={item} />
      </div>
    )
  }
  return null
}

function ModelSelector({ models }: { models?: SessionModels }): ReactElement {
  const selectedId = useAppStore((s) => s.selectedId)
  const selectModel = useAppStore((s) => s.selectModel)
  if (!models || !selectedId) return <span className="model-current">…</span>

  const current = `${models.current.provider}::${models.current.model}`
  return (
    <select
      className="model-select"
      value={current}
      onChange={(e) => {
        const [provider, model] = e.target.value.split('::')
        if (provider && model) void selectModel(selectedId, provider, model)
      }}
      title={models.routable ? '选择模型' : '当前 provider 不可路由'}
    >
      {models.groups.map((g) => (
        <optgroup key={g.id} label={g.name}>
          {g.models.map((m) => (
            <option key={`${g.id}::${m.id}`} value={`${g.id}::${m.id}`}>
              {m.name || m.id}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

/** Stable empty list: `?? []` in the selector would re-render on every store change. */
const EMPTY_QUEUE: QueueItem[] = []

function QueueDock({ sessionId }: { sessionId: string }): ReactElement | null {
  const queue = useAppStore((s) => s.queueBySession[sessionId] ?? EMPTY_QUEUE)
  const removeQueueItem = useAppStore((s) => s.removeQueueItem)
  const steerQueueItem = useAppStore((s) => s.steerQueueItem)
  const visible = queue.filter((q) => q.placement !== 'context')
  if (visible.length === 0) return null
  return (
    <div className="queue-dock">
      {visible.map((q: QueueItem) => (
        <div key={q.id} className="queue-item">
          <span className={`queue-placement ${q.placement}`}>{q.placement === 'steering' ? '已插队' : '排队中'}</span>
          <span className="queue-text">{q.text.slice(0, 120)}</span>
          <button className="icon-btn" title="立即处理" onClick={() => void steerQueueItem(sessionId, q.id)}>
            ⏩
          </button>
          <button className="icon-btn" title="移除" onClick={() => void removeQueueItem(sessionId, q.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

export function ChatView(): ReactElement {
  const {
    selectedId,
    eventsBySession,
    runningBySession,
    hasMoreBySession,
    titles,
    plans,
    modelsBySession,
    send,
    cancel,
    loadOlder,
    forkSession,
    renameSession,
    archiveSession
  } = useAppStore()

  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [showSubagents, setShowSubagents] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /** Whether the user is already at the bottom; streaming only auto-scrolls then. */
  const nearBottomRef = useRef(true)

  useEffect(() => {
    setEditingTitle(false)
    setConfirmArchive(false)
    setAttachments([])
    nearBottomRef.current = true
  }, [selectedId])

  useEffect(() => {
    if (!confirmArchive) return
    const t = setTimeout(() => setConfirmArchive(false), 3000)
    return () => clearTimeout(t)
  }, [confirmArchive])

  const events = selectedId ? (eventsBySession[selectedId] ?? []) : []
  const timeline = useMemo(() => deriveTimeline(events), [events])
  const running = selectedId ? Boolean(runningBySession[selectedId]) : false
  const models = selectedId ? modelsBySession[selectedId] : undefined
  const title = selectedId ? (titles[selectedId] || `会话 ${selectedId.slice(-8)}`) : ''
  const plan = selectedId ? plans[selectedId] : undefined
  const hasMore = selectedId ? Boolean(hasMoreBySession[selectedId]) : false
  const showCommands = input.startsWith('/') && !input.includes(' ') && !input.includes('\n')
  const matching = showCommands ? SLASH_COMMANDS.filter((c) => c.name.startsWith(input.slice(1))) : []

  const runCommand = (c: SlashCommand): void => {
    if (c.input) {
      setInput(`/${c.name} `)
    } else {
      void send([{ type: 'text', text: `/${c.name}` }])
      setInput('')
    }
  }

  useEffect(() => {
    if (!nearBottomRef.current) return
    // 'auto' while streaming: smooth animations queue up and lag behind the
    // chunk rate; smooth is fine for discrete jumps (send, select, turn end).
    bottomRef.current?.scrollIntoView({ behavior: running ? 'auto' : 'smooth' })
  }, [events.length, running])

  if (!selectedId) {
    return <div className="welcome">选择或新建一个会话开始。</div>
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    const text = input.trim()
    if (!text && attachments.length === 0) return
    const content: PromptContentPart[] = []
    if (text) content.push({ type: 'text', text })
    for (const a of attachments) content.push({ type: 'image', mediaType: a.mediaType, data: a.data, name: a.name })
    const sentAttachments = attachments
    setInput('')
    setAttachments([])
    void send(content).then((ok) => {
      // Give the draft back when the prompt RPC failed — clearing the
      // composer unconditionally used to lose unsent text.
      if (!ok) {
        setInput(text)
        setAttachments(sentAttachments)
      }
    })
  }

  const commitTitle = (): void => {
    setEditingTitle(false)
    const t = titleDraft.trim()
    if (t) void renameSession(selectedId, t)
  }

  const onPickFile = (file: File): void => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      useAppStore
        .getState()
        .reportError(`图片「${file.name}」超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 上限(${(file.size / 1024 / 1024).toFixed(1)}MB)`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const m = /^data:([^;]+);base64,(.+)$/.exec(String(reader.result))
      if (m) setAttachments((prev) => [...prev, { mediaType: m[1], data: m[2], name: file.name }])
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="chat">
      <div className="chat-header">
        {editingTitle ? (
          <input
            className="title-input"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <span
            className="chat-title"
            title="点击重命名"
            onClick={() => {
              setTitleDraft(title)
              setEditingTitle(true)
            }}
          >
            {title}
          </span>
        )}
        <div className="chat-header-actions">
          {plan?.active ? <span className="plan-badge active">计划模式</span> : null}
          {plan?.pending ? <span className="plan-badge pending">计划待定</span> : null}
          <ModelSelector models={models} />
          {running ? <span className="running-badge">运行中</span> : null}
          <button className="ghost-btn" title="查看子代理" onClick={() => setShowSubagents(true)}>
            子代理
          </button>
          <button className="ghost-btn" title="从最近完成的回合分支出新会话" onClick={() => void forkSession(selectedId)}>
            分支
          </button>
          {confirmArchive ? (
            <button className="danger-btn" onClick={() => void archiveSession(selectedId)}>
              确认归档?
            </button>
          ) : (
            <button className="ghost-btn" onClick={() => setConfirmArchive(true)} title="归档会话">
              归档
            </button>
          )}
        </div>
      </div>

      <GoalBar sessionId={selectedId} />
      <JobsPanel sessionId={selectedId} />

      <div
        ref={messagesRef}
        className="messages"
        onScroll={(e) => {
          const el = e.currentTarget
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {hasMore ? (
          <div className="load-older">
            <button
              className="ghost-btn"
              onClick={() => {
                // Prepending older events grows scrollHeight; keep the
                // viewport pinned to the message the user was reading.
                const el = messagesRef.current
                const prevHeight = el?.scrollHeight ?? 0
                const prevTop = el?.scrollTop ?? 0
                void loadOlder(selectedId).then(() => {
                  requestAnimationFrame(() => {
                    if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
                  })
                })
              }}
            >
              加载更早的消息
            </button>
          </div>
        ) : null}
        {timeline.length === 0 ? (
          <div className="welcome">输入消息开始。</div>
        ) : (
          timeline.map((item) => <MessageItem key={`${item.kind}-${item.seq}`} item={item} sessionId={selectedId} />)
        )}
        {running ? (
          <div className="row assistant">
            <div className="bubble">
              <span className="cursor">▋</span>
            </div>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <QueueDock sessionId={selectedId} />

      <div className="composer-wrap">
        {showCommands && matching.length > 0 ? (
          <div className="command-palette">
            {matching.map((c) => (
              <button key={c.name} className="command-item" onClick={() => runCommand(c)}>
                <span className="command-name">/{c.name}</span>
                <span className="command-desc">{c.description}</span>
              </button>
            ))}
          </div>
        ) : null}
        <form className="composer" onSubmit={onSubmit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // isComposing: an IME candidate-confirm Enter must not send.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSubmit(e)
            }
          }}
          placeholder="输入消息,Enter 发送,Shift+Enter 换行"
          rows={2}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onPickFile(f)
            e.target.value = ''
          }}
        />
        <div className="composer-actions">
          <button type="button" className="ghost-btn" title="添加图片" onClick={() => fileRef.current?.click()}>
            🖼
          </button>
          {attachments.map((a, i) => (
            <span key={i} className="attach-chip" title={a.name}>
              🖼 {a.name ?? i + 1}
              <button
                type="button"
                className="attach-remove"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </span>
          ))}
          {running ? (
            <button type="button" className="cancel" onClick={() => void cancel()}>
              停止
            </button>
          ) : null}
          <button type="submit" className="send" disabled={!input.trim() && attachments.length === 0}>
            发送
          </button>
        </div>
      </form>
      </div>

      {showSubagents ? <SubagentsPanel parentSessionId={selectedId} onClose={() => setShowSubagents(false)} /> : null}
    </div>
  )
}
