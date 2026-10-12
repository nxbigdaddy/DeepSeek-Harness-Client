import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { rehydrateSchema, getPath, hasPath } from '@deepseek-ai/dsh-client-schema-form'
import { SchemaForm } from './SchemaForm'
import { namespaceLabel } from './locale'
import type { SettingsDescribeResult, SettingsNamespace, SettingsPathOp } from '@shared/ipc'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i])
}

function findOp(ops: SettingsPathOp[], path: string[]): SettingsPathOp | undefined {
  return ops.find((o) => samePath(o.path, path))
}

export function SettingsView(): ReactElement {
  const [result, setResult] = useState<SettingsDescribeResult | null>(null)
  const [selectedNs, setSelectedNs] = useState<string | null>(null)
  const [ops, setOps] = useState<SettingsPathOp[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const load = async (): Promise<void> => {
    try {
      const r = await window.dsh.settingsDescribe()
      setResult(r)
      setSelectedNs((prev) => prev ?? r.namespaces[0]?.ns ?? null)
    } catch (e) {
      setError(errText(e))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const ns: SettingsNamespace | undefined = result?.namespaces.find((n) => n.ns === selectedNs)

  // Pure derivation — no setState inside useMemo (render-phase side effect).
  const schemaResult = useMemo(() => {
    if (!ns) return { schema: undefined as ReturnType<typeof rehydrateSchema> | undefined, error: '' }
    try {
      return { schema: rehydrateSchema(ns.schema), error: '' }
    } catch (e) {
      return { schema: undefined, error: `schema 解析失败: ${errText(e)}` }
    }
  }, [ns])
  const schema = schemaResult.schema

  useEffect(() => {
    setOps([])
    setMessage('')
    setError('')
    setConfirmReset(false)
  }, [selectedNs, result])

  useEffect(() => {
    if (!confirmReset) return
    const t = setTimeout(() => setConfirmReset(false), 3000)
    return () => clearTimeout(t)
  }, [confirmReset])

  const getValue = (path: string[]): unknown => {
    if (!ns) return undefined
    if (path.length === 0) return ns.value
    const op = findOp(ops, path)
    if (op && op.op === 'set') return op.value
    if (hasPath(ns.user ?? {}, path)) return getPath(ns.user, path)
    return getPath(ns.value, path)
  }

  const isOverridden = (path: string[]): boolean => {
    if (!ns || path.length === 0) return false
    const op = findOp(ops, path)
    if (op) return op.op === 'set'
    return hasPath(ns.user ?? {}, path)
  }

  const secretSet = (path: string[]): boolean => {
    if (!ns) return false
    return ns.secrets.some((s) => samePath(s.path, path) && s.set)
  }

  const onChange = (path: string[], value: unknown): void => {
    setOps((prev) => [...prev.filter((o) => !samePath(o.path, path)), { op: 'set', path, value }])
    setMessage('')
  }

  const onReset = (path: string[]): void => {
    setOps((prev) => [...prev.filter((o) => !samePath(o.path, path)), { op: 'unset', path }])
    setMessage('')
  }

  const onClearOp = (path: string[]): void => {
    setOps((prev) => prev.filter((o) => !samePath(o.path, path)))
    setMessage('')
  }

  const save = async (): Promise<void> => {
    if (!ns) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await window.dsh.settingsMutate(ns.ns, ops, ns.revision)
      setOps([])
      setMessage('已保存' + (ns.applies === 'restart' ? '(需重启 host 生效)' : ''))
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    if (!ns) return
    setBusy(true)
    setError('')
    try {
      await window.dsh.settingsReplace(ns.ns, {}, ns.revision)
      setOps([])
      setMessage('已重置为默认')
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
      setConfirmReset(false)
    }
  }

  const openDocument = async (): Promise<void> => {
    try {
      await window.dsh.settingsOpenDocument()
    } catch (e) {
      setError(errText(e))
    }
  }

  if (!result) {
    return <div className="settings-loading">{error || '加载设置…'}</div>
  }

  return (
    <div className="settings">
      <div className="settings-side">
        <div className="settings-side-header">
          <span>配置项</span>
          <button className="ghost-btn" onClick={() => void openDocument()} disabled={!result.hasDocument}>
            打开文件
          </button>
        </div>
        {result.namespaces.map((n) => (
          <button
            key={n.ns}
            className={`settings-ns ${n.ns === selectedNs ? 'active' : ''}`}
            onClick={() => {
              // Switching discards pending ops; don't lose them silently.
              if (n.ns === selectedNs) return
              if (ops.length > 0 && !window.confirm(`有 ${ops.length} 项未保存的修改,切换将丢弃。继续?`)) return
              setSelectedNs(n.ns)
            }}
          >
            <span className="ns-name" title={n.ns}>
              {namespaceLabel(n.ns)}
            </span>
            <span className={`ns-badge ${n.applies}`}>{n.applies === 'live' ? '即时' : '重启'}</span>
          </button>
        ))}
        {!result.writable ? <div className="settings-readonly">只读配置</div> : null}
      </div>

      <div className="settings-main">
        {ns && schema ? (
          <>
            <div className="settings-section">
              <SchemaForm
                schema={schema}
                getValue={getValue}
                isOverridden={isOverridden}
                onChange={onChange}
                onReset={onReset}
                onClearOp={onClearOp}
                secretSet={secretSet}
              />
            </div>
            <div className="settings-actions">
              <button className="send" onClick={() => void save()} disabled={busy || ops.length === 0}>
                {busy ? '保存中…' : `保存${ops.length > 0 ? ` (${ops.length} 项改动)` : ''}`}
              </button>
              {confirmReset ? (
                <button className="danger-btn" onClick={() => void reset()} disabled={busy}>
                  确认重置「{namespaceLabel(ns.ns)}」全部配置?
                </button>
              ) : (
                <button className="ghost-btn" onClick={() => setConfirmReset(true)} disabled={busy}>
                  全部重置为默认
                </button>
              )}
            </div>
            {message ? <div className="settings-message ok">{message}</div> : null}
            {error || schemaResult.error ? <div className="settings-message err">{error || schemaResult.error}</div> : null}
          </>
        ) : (
          <div className="welcome">没有可配置项。</div>
        )}
      </div>
    </div>
  )
}
