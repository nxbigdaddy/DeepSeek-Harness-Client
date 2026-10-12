import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { rehydrateSchema, getPath } from '@deepseek-ai/dsh-client-schema-form'
import { useAppStore } from './store'
import type { AgentPresetEntry, CredentialView, SettingsDescribeResult, SkillEntry } from '@shared/ipc'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkCredRefs(schema: any, value: unknown, path: string[], refs: Set<string>): void {
  if (!schema) return
  if (schema.meta?.role === 'credential-ref') {
    const v = getPath(value, path)
    if (typeof v === 'string' && v) refs.add(v)
    return
  }
  if (schema.type === 'object' && schema.dict) {
    for (const k of Object.keys(schema.dict)) walkCredRefs(schema.dict[k], value, [...path, k], refs)
  } else if (schema.type === 'array' && schema.inner) {
    const arr = getPath(value, path)
    if (Array.isArray(arr)) arr.forEach((_, i) => walkCredRefs(schema.inner, value, [...path, String(i)], refs))
  } else if (schema.type === 'dict' && schema.inner) {
    const obj = getPath(value, path)
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj as Record<string, unknown>)) walkCredRefs(schema.inner, value, [...path, k], refs)
    }
  } else if (schema.type === 'transform' && schema.inner) {
    walkCredRefs(schema.inner, value, path, refs)
  }
}

function discoverCredRefs(result: SettingsDescribeResult): string[] {
  const refs = new Set<string>()
  for (const ns of result.namespaces) {
    try {
      walkCredRefs(rehydrateSchema(ns.schema), ns.value ?? {}, [], refs)
    } catch {
      // skip namespaces that fail to rehydrate
    }
  }
  return [...refs].sort()
}

function SkillsSection(): ReactElement {
  const selectedId = useAppStore((s) => s.selectedId)
  const send = useAppStore((s) => s.send)
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!selectedId) return
    window.dsh
      .skillsList(selectedId)
      .then((r) => {
        setSkills(r.skills)
        setError('')
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg.includes('not found') || msg.includes('not attached') ? '技能列表需要已激活的会话:请新建会话或先发送一条消息。' : msg)
      })
  }, [selectedId])

  return (
    <section className="cap-section">
      <h3>技能</h3>
      {error ? <div className="settings-message err">{error.slice(0, 240)}</div> : null}
      {skills.length === 0 && !error ? <div className="empty">当前项目没有可用的技能。</div> : null}
      {skills.map((s) => (
        <div key={s.name} className="cap-row">
          <div className="cap-row-main">
            <span className="cap-title">/{s.name}</span>
            <span className="cap-desc">{s.description}</span>
            {s.whenToUse ? <span className="cap-hint">{s.whenToUse}</span> : null}
          </div>
          <button
            className="ghost-btn"
            disabled={!selectedId}
            onClick={() => selectedId && void send([{ type: 'text', text: `/${s.name}` }])}
          >
            调用
          </button>
        </div>
      ))}
    </section>
  )
}

function PresetsSection(): ReactElement {
  const selectedId = useAppStore((s) => s.selectedId)
  const [presets, setPresets] = useState<AgentPresetEntry[]>([])
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = async (): Promise<void> => {
    const r = await window.dsh.agentPresetList()
    setPresets(r.presets)
  }
  useEffect(() => {
    void load()
  }, [])

  const setDefault = async (id: string): Promise<void> => {
    try {
      await window.dsh.settingsMutate('agent-presets', [{ op: 'set', path: ['default'], value: id }])
      setMsg({ kind: 'ok', text: `已将默认预设设为 ${id}` })
      await load()
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    }
  }

  const applyToSession = async (id: string): Promise<void> => {
    if (!selectedId) return
    try {
      await window.dsh.agentPresetSelect(selectedId, id)
      setMsg({ kind: 'ok', text: `已将预设 ${id} 应用到当前会话` })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <section className="cap-section">
      <h3>Agent 预设</h3>
      {msg ? <div className={`settings-message ${msg.kind}`}>{msg.text}</div> : null}
      {presets.map((p) => (
        <div key={p.id} className="cap-row">
          <div className="cap-row-main">
            <span className="cap-title">
              {p.name || p.id} {p.isDefault ? '(默认)' : ''}
              {p.trust === 'user' ? ' · 本地' : ''}
              {p.broken ? ' · 损坏' : ''}
            </span>
            {p.description ? <span className="cap-desc">{p.description}</span> : null}
          </div>
          <button className="ghost-btn" onClick={() => void setDefault(p.id)} disabled={p.isDefault}>
            设为默认
          </button>
          <button
            className="ghost-btn"
            disabled={!selectedId}
            onClick={() => void applyToSession(p.id)}
          >
            应用到此会话
          </button>
        </div>
      ))}
    </section>
  )
}

function CredentialsSection(): ReactElement {
  const [refs, setRefs] = useState<string[]>([])
  const [views, setViews] = useState<Record<string, CredentialView>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const r = await window.dsh.settingsDescribe()
        const found = discoverCredRefs(r)
        setRefs(found)
        const c = await window.dsh.credentialsDescribe(found)
        setViews(c.credentials)
      } catch (e) {
        // Without this the section pretends "no credentials found" on failure.
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  const set = async (ref: string): Promise<void> => {
    setError('')
    try {
      await window.dsh.credentialsSet(ref, values[ref] ?? '')
      setValues((v) => ({ ...v, [ref]: '' }))
      setViews((old) => ({ ...old, [ref]: { configured: true, writable: old[ref]?.writable ?? true } }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const unset = async (ref: string): Promise<void> => {
    setError('')
    try {
      await window.dsh.credentialsUnset(ref)
      setViews((old) => ({ ...old, [ref]: { configured: false, writable: old[ref]?.writable ?? true } }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="cap-section">
      <h3>凭据</h3>
      {error ? <div className="settings-message err">{error.slice(0, 240)}</div> : null}
      {refs.length === 0 && !error ? <div className="empty">没有发现凭据引用。</div> : null}
      {refs.map((ref) => {
        const v = views[ref]
        return (
          <div key={ref} className="cap-row">
            <div className="cap-row-main">
              <span className="cap-title">{ref}</span>
              <span className="cap-desc">
                {v?.configured ? `已配置${v.source ? ` · 来源 ${v.source}` : ''}` : '未配置'}
                {v && !v.writable ? ' · 只读' : ''}
              </span>
            </div>
            <input
              className="form-input"
              type="password"
              placeholder="新值"
              value={values[ref] ?? ''}
              onChange={(e) => setValues((old) => ({ ...old, [ref]: e.target.value }))}
            />
            <button className="ghost-btn" onClick={() => void set(ref)} disabled={!v?.writable || !(values[ref] ?? '').trim()}>
              设置
            </button>
            <button className="ghost-btn" onClick={() => void unset(ref)} disabled={!v?.writable}>
              清除
            </button>
          </div>
        )
      })}
    </section>
  )
}

function ConnectionSection(): ReactElement {
  const [cfg, setCfg] = useState<{ mode: 'embedded' | 'remote'; remoteUrl?: string }>({ mode: 'embedded' })
  const [url, setUrl] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    void window.dsh
      .getConnectionConfig()
      .then((c) => {
        setCfg(c)
        setUrl(c.remoteUrl ?? '')
      })
      .catch(() => {})
  }, [])

  const save = async (): Promise<void> => {
    const mode = cfg.mode
    const remoteUrl = url.trim()
    if (mode === 'remote' && !remoteUrl) {
      setMsg({ kind: 'err', text: '远程模式需要填写 URL' })
      return
    }
    try {
      // Merge over the stored config: writing {mode, remoteUrl} alone would
      // silently wipe the MCP server list (whole-file replace on the host).
      const current = await window.dsh.getConnectionConfig()
      await window.dsh.setConnectionConfig(
        mode === 'remote' ? { ...current, mode, remoteUrl } : { ...current, mode }
      )
      setMsg({ kind: 'ok', text: '已保存并重连' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <section className="cap-section">
      <h3>连接</h3>
      <div className="cap-row">
        <div className="cap-row-main">
          <span className="cap-title">Host 来源</span>
          <span className="cap-desc">内嵌:本机自启动 dsh web;远程:连接指定 URL 的 host(需对方 --trusted-host 授权)。</span>
        </div>
        <select
          className="form-input"
          value={cfg.mode}
          onChange={(e) => setCfg({ mode: e.target.value as 'embedded' | 'remote', remoteUrl: url })}
        >
          <option value="embedded">内嵌 host</option>
          <option value="remote">远程 host</option>
        </select>
      </div>
      {cfg.mode === 'remote' ? (
        <div className="cap-row">
          <div className="cap-row-main">
            <span className="cap-title">远程 URL</span>
          </div>
          <input className="form-input" placeholder="http://192.168.1.10:3080" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
      ) : null}
      <div className="cap-row">
        <button className="send" onClick={() => void save()}>
          保存并重连
        </button>
      </div>
      {msg ? <div className={`settings-message ${msg.kind}`}>{msg.text}</div> : null}
    </section>
  )
}

function McpSection(): ReactElement {
  const [draft, setDraft] = useState('[]')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    void window.dsh
      .getConnectionConfig()
      .then((c) => setDraft(JSON.stringify(c.mcpServers ?? [], null, 2)))
      .catch(() => {})
  }, [])

  const save = async (): Promise<void> => {
    try {
      const parsed = JSON.parse(draft)
      if (!Array.isArray(parsed)) throw new Error('MCP 配置必须是 JSON 数组')
      const cfg = await window.dsh.getConnectionConfig()
      await window.dsh.setConnectionConfig({ ...cfg, mcpServers: parsed })
      setMsg({ kind: 'ok', text: '已保存并重连' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <section className="cap-section">
      <h3>MCP 服务器</h3>
      <div className="cap-desc">
        通过 host 的 <code>--patch</code> 注入 <code>dsh-mcp-client</code> 插件。每项为 stdio(
        <code>transport/serverName/command/args/env/cwd/toolCallTimeoutMs/failOnStartupError</code>)或
        streamable-http(<code>transport/serverName/url/headers/…</code>)。
      </div>
      <textarea className="json-editor" rows={10} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="settings-actions">
        <button className="send" onClick={() => void save()}>
          保存并重连
        </button>
      </div>
      {msg ? <div className={`settings-message ${msg.kind}`}>{msg.text}</div> : null}
    </section>
  )
}

export function CapabilitiesView(): ReactElement {
  return (
    <div className="capabilities">
      <ConnectionSection />
      <McpSection />
      <SkillsSection />
      <PresetsSection />
      <CredentialsSection />
    </div>
  )
}
