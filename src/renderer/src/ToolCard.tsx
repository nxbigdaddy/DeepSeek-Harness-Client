import { useEffect, useRef, type ReactElement } from 'react'
import type { TimelineItem } from './timeline'
import { diffLines } from './diff'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const KIND_ICON: Record<string, string> = {
  read: '📖',
  edit: '✏️',
  write: '✏️',
  delete: '🗑',
  move: '📦',
  search: '🔍',
  execute: '▶',
  fetch: '🌐',
  terminal: '⌨',
  diff: '📝',
  other: '🔧'
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: Any) => b?.type === 'text')
    .map((b: Any) => b.text)
    .join('\n')
}

function DiffBlock({ d }: { d: { path: string; oldText: string | null; newText: string } }): ReactElement {
  const lines = diffLines(d.oldText ?? '', d.newText)
  const isNew = d.oldText === null
  return (
    <div className="diff-block">
      <div className="diff-path">{isNew ? '+ ' : ''}{d.path}</div>
      <pre className="diff-lines">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.type}`}>
            <span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
            <span className="diff-text">{l.text || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

function TerminalBlock({ callView, resultView }: { callView: Any; resultView: Any }): ReactElement {
  const title = resultView?.title ?? callView?.title ?? ''
  const cwd = callView?.cwd
  const output = resultView?.output ?? ''
  const exitCode = resultView?.exitCode
  const signal = resultView?.signal
  return (
    <div className="terminal-block">
      {cwd ? <div className="terminal-cwd">{cwd}</div> : null}
      <div className="terminal-cmd">$ {title}</div>
      {output ? <pre className="terminal-output">{output}</pre> : null}
      {exitCode !== undefined || signal ? (
        <div className={`terminal-status ${exitCode === 0 ? 'ok' : 'err'}`}>
          {signal ? `信号 ${signal}` : `退出码 ${exitCode}`}
        </div>
      ) : null}
    </div>
  )
}

function ReadBlock({ view }: { view: Any }): ReactElement {
  return (
    <div className="read-block">
      <div className="diff-path">{view.path}</div>
      <pre className="read-lines">
        {view.lines?.map((l: Any) => (
          <div key={l.number} className="read-line">
            <span className="read-num">{l.number}</span>
            <span className="read-text">{l.text || ' '}</span>
          </div>
        ))}
      </pre>
      {view.totalLines ? <div className="read-meta">显示 {view.lines?.length ?? 0} / {view.totalLines} 行</div> : null}
    </div>
  )
}

function SearchBlock({ view }: { view: Any }): ReactElement {
  if (view.shape === 'paths') {
    return (
      <div className="search-block">
        {view.paths?.map((p: string) => (
          <div key={p} className="search-path">
            {p}
          </div>
        ))}
        {view.truncated ? <div className="read-meta">已截断,共 {view.total} 项</div> : null}
      </div>
    )
  }
  return (
    <div className="search-block">
      {view.files?.map((f: Any) => (
        <div key={f.path} className="search-file">
          <div className="diff-path">{f.path}</div>
          {f.matches?.map((m: Any, i: number) => (
            <div key={i} className="search-match">
              <span className="read-num">{m.lineNumber}</span>
              <span className="search-text">{m.line}</span>
            </div>
          ))}
        </div>
      ))}
      {view.truncated ? <div className="read-meta">已截断,共 {view.total} 处匹配</div> : null}
    </div>
  )
}

/** Tool-result URLs are untrusted content: only http(s) may render as a link. */
function safeHref(url: unknown): string | null {
  if (typeof url !== 'string') return null
  return /^https?:\/\//i.test(url) ? url : null
}

function WebBlock({ view }: { view: Any }): ReactElement {
  return (
    <div className="web-block">
      {view.answer ? <div className="web-answer">{view.answer}</div> : null}
      {view.sources?.map((s: Any, i: number) => {
        const href = safeHref(s?.url)
        return (
          <div key={i} className="web-source">
            {href ? (
              <a href={href} target="_blank" rel="noreferrer">
                {s.title || s.url}
              </a>
            ) : (
              <span>{s?.title || String(s?.url ?? '')}</span>
            )}
            {s.snippet ? <div className="web-snippet">{s.snippet}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

export function ToolCard({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }): ReactElement {
  const callView = item.callView as Any
  const resultView = item.resultView as Any
  const title = resultView?.title ?? callView?.title ?? item.name
  const kind = callView?.kind ?? (callView?.card === 'terminal' ? 'terminal' : 'other')
  const icon = KIND_ICON[kind] ?? '🔧'
  const status = item.status === 'running' ? '运行中…' : item.isError ? '出错' : '完成'

  let body: ReactElement | null = null
  if (callView?.card === 'diff' || resultView?.card === 'diff') {
    const diffs = resultView?.diffs ?? callView?.diffs ?? []
    body = (
      <div>
        {diffs.map((d: Any, i: number) => (
          <DiffBlock key={i} d={d} />
        ))}
      </div>
    )
  } else if (callView?.card === 'terminal' || resultView?.card === 'terminal') {
    body = <TerminalBlock callView={callView} resultView={resultView} />
  } else if (resultView?.card === 'read') {
    body = <ReadBlock view={resultView} />
  } else if (resultView?.card === 'search') {
    body = <SearchBlock view={resultView} />
  } else if (resultView?.card === 'web') {
    body = <WebBlock view={resultView} />
  } else {
    const rawInput = callView?.rawInput
    const resultText = item.resultText ?? contentText(resultView?.content)
    let argsPreview = ''
    if (rawInput !== undefined) {
      argsPreview = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2)
    } else {
      try {
        argsPreview = JSON.stringify(JSON.parse(item.arguments), null, 2)
      } catch {
        argsPreview = item.arguments
      }
    }
    body = (
      <div>
        {argsPreview ? <pre className="tool-body">{argsPreview}</pre> : null}
        {resultText ? (
          <div className="tool-result">
            <div className="tool-result-label">结果</div>
            <pre>{resultText.slice(0, 4000)}</pre>
          </div>
        ) : null}
      </div>
    )
  }

  // Uncontrolled <details>: a controlled `open` prop re-asserts on every
  // timeline rebuild and snaps shut a card the user opened (worst case: the
  // status flip to done collapses it mid-read). Follow the status only until
  // the user touches the summary.
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const userTouched = useRef(false)
  useEffect(() => {
    if (detailsRef.current && !userTouched.current) {
      detailsRef.current.open = item.status === 'running'
    }
  }, [item.status])

  return (
    <details className="tool-card" ref={detailsRef}>
      <summary onClick={() => (userTouched.current = true)}>
        <span className="tool-icon">{icon}</span>
        <span className="tool-name">{title}</span>
        <span className="tool-status">{status}</span>
      </summary>
      <div className="tool-card-body">{body}</div>
    </details>
  )
}
