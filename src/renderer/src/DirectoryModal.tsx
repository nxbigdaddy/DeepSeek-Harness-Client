import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { DirectoryListing } from '@shared/ipc'

interface DirectoryModalProps {
  open: boolean
  onClose: () => void
  /** Called with the confirmed directory path (adopt happens in the caller). */
  onPick: (path: string) => void
}

/**
 * In-app directory browser for "open project folder as workspace". Talks to
 * `listDirectory`/`createDirectory`, which the main process serves from the
 * host's browse capability when present and from the local fs otherwise
 * (embedded host == same machine). The host-native dialog stays available via
 * a footer escape hatch.
 */
export function DirectoryModal({ open, onClose, onPick }: DirectoryModalProps): ReactElement | null {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  // Request counter: rapid crumb/entry clicks must not apply out of order.
  const loadSeq = useRef(0)

  const load = useCallback(async (path?: string) => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const listing = await window.dsh.listDirectory(path)
      if (seq === loadSeq.current) setListing(listing)
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setCreating(false)
      setNewName('')
      setError('')
      void load(undefined)
    }
  }, [open, load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const submitNewFolder = async (): Promise<void> => {
    if (!listing || !newName.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const { path } = await window.dsh.createDirectory(listing.path, newName.trim())
      setCreating(false)
      setNewName('')
      await load(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const useSystemDialog = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const { path } = await window.dsh.pickDirectory()
      if (path) onPick(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal">
        <div className="modal-header">
          <span>打开项目文件夹</span>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="crumbs">
          {(listing?.crumbs ?? []).map((c, i, arr) => (
            <span key={c.path}>
              {i > 0 ? <span className="crumb-sep"> / </span> : null}
              <button className="crumb" disabled={i === arr.length - 1} onClick={() => void load(c.path)}>
                {c.name}
              </button>
            </span>
          ))}
        </div>

        <div className="dir-entries">
          {error ? <div className="settings-message err">{error}</div> : null}
          {loading ? (
            <div className="empty">加载中…</div>
          ) : (
            (listing?.entries ?? []).map((entry) => (
              <button
                key={entry.path}
                className={`dir-entry ${entry.hidden ? 'hidden-entry' : ''}`}
                onDoubleClick={() => void load(entry.path)}
                onClick={() => void load(entry.path)}
              >
                📁 {entry.name}
              </button>
            ))
          )}
          {!loading && !error && listing && listing.entries.length === 0 ? (
            <div className="empty">此文件夹没有子文件夹</div>
          ) : null}
          {listing?.truncated ? <div className="empty">条目过多,仅显示前 500 个</div> : null}
          {creating ? (
            <input
              className="inline-input new-folder-input"
              autoFocus
              placeholder="新文件夹名称,回车创建"
              value={newName}
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNewFolder()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                }
              }}
              onBlur={() => {
                if (!busy) {
                  setCreating(false)
                  setNewName('')
                }
              }}
            />
          ) : null}
        </div>

        <div className="modal-footer">
          <span className="selected-path" title={listing?.path ?? ''}>
            {listing?.path ?? ''}
          </span>
          <button className="ghost-btn" disabled={busy} onClick={() => setCreating(true)}>
            新建文件夹
          </button>
          <button className="ghost-btn" disabled={busy} onClick={() => void useSystemDialog()}>
            系统对话框…
          </button>
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button className="send" disabled={!listing || busy} onClick={() => listing && onPick(listing.path)}>
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  )
}
