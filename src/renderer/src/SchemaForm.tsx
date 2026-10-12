/**
 * Generic schemastery-schema form renderer for the settings surface.
 *
 * The editable model is a list of pending path operations (`SettingsPathOp`)
 * layered over the namespace's `user` section and finally the resolved
 * `value`. Saving submits exactly those ops via `settings.mutate`, which
 * materializes intermediate containers on the host — so the client never
 * needs copy-on-write array/dict handling, and untouched secrets are preserved.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { fieldLabel, enumLabel } from './locale'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SchemaNode = any

export interface SchemaFormProps {
  schema: SchemaNode
  /** Effective value at a path (pending ops → user → resolved). */
  getValue: (path: string[]) => unknown
  /** Whether a path is overridden (pending set op, or present in user). */
  isOverridden: (path: string[]) => boolean
  /** Upsert a set op at a path. */
  onChange: (path: string[], value: unknown) => void
  /** Upsert an unset op at a path (reset to defaults). */
  onReset: (path: string[]) => void
  /** Drop a pending op at a path (secret editor cleared before save). */
  onClearOp?: (path: string[]) => void
  /** Whether a secret slot at a path currently holds a value. */
  secretSet: (path: string[]) => boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defaultFor(schema: SchemaNode): any {
  const meta = schema?.meta ?? {}
  if (meta.default !== undefined) {
    try {
      return structuredClone(meta.default)
    } catch {
      return meta.default
    }
  }
  switch (schema?.type) {
    case 'object':
    case 'dict':
      return {}
    case 'array':
      return []
    case 'boolean':
      return false
    case 'number':
    case 'natural':
    case 'percent':
      return 0
    case 'string':
      return ''
    case 'const':
      return schema.value
    case 'union':
      return schema.list?.[0] ? defaultFor(schema.list[0]) : null
    default:
      return null
  }
}

function labelFor(key: string, _schema: SchemaNode): string {
  return fieldLabel(key)
}

function Field({ schema, path, form }: { schema: SchemaNode; path: string[]; form: SchemaFormProps }): ReactElement | null {
  if (!schema) return null
  const meta = schema.meta ?? {}
  if (meta.hidden) return null

  // Transparent node: render what it validates.
  if (schema.type === 'transform' && schema.inner) {
    return <Field schema={schema.inner} path={path} form={form} />
  }

  // Object
  if (schema.type === 'object' && schema.dict) {
    const keys = Object.keys(schema.dict)
    return (
      <div className="form-object">
        {keys.map((key) => (
          <Field key={key} schema={schema.dict[key]} path={[...path, key]} form={form} />
        ))}
      </div>
    )
  }

  // Enum: union of constants.
  if (
    schema.type === 'union' &&
    Array.isArray(schema.list) &&
    schema.list.length > 0 &&
    schema.list.every((m: SchemaNode) => m?.type === 'const')
  ) {
    const value = form.getValue(path)
    const current = String(value === undefined ? (meta.default ?? '') : value)
    const key = path[path.length - 1] ?? ''
    const overridden = form.isOverridden(path)
    return (
      <div className="form-field">
        <div className="form-field-head">
          <label>{labelFor(key, schema)}</label>
          {overridden ? (
            <button className="form-reset" onClick={() => form.onReset(path)}>
              重置
            </button>
          ) : null}
        </div>
        <select
          className="form-input"
          value={current}
          disabled={meta.disabled}
          onChange={(e) => {
            // option values are stringified; map back to the typed const so a
            // union of numbers/booleans isn't corrupted into strings on save.
            const hit = (schema.list as SchemaNode[]).find((m) => String(m.value) === e.target.value)
            form.onChange(path, hit ? hit.value : e.target.value)
          }}
        >
          {schema.list.map((m: SchemaNode) => (
            <option key={String(m.value)} value={String(m.value)}>
              {enumLabel(String(m.value))}
            </option>
          ))}
          {/* A stored value outside the const list would otherwise display as
              the first option while holding a different value. */}
          {!(schema.list as SchemaNode[]).some((m) => String(m.value) === current) ? (
            <option value={current} disabled>
              {`${current}(不在候选中)`}
            </option>
          ) : null}
        </select>
        {meta.comment ? <div className="form-hint">{String(meta.comment)}</div> : null}
      </div>
    )
  }

  // Array
  if (schema.type === 'array' && schema.inner) {
    const items = (form.getValue(path) ?? []) as unknown[]
    const key = path[path.length - 1] ?? ''
    return (
      <div className="form-field form-array">
        <div className="form-field-head">
          <label>{labelFor(key, schema)}</label>
          <button className="form-add" onClick={() => form.onChange(path, [...items, defaultFor(schema.inner)])}>
            + 添加
          </button>
        </div>
        {items.map((_, i) => (
          <div key={i} className="form-array-item">
            <div className="form-array-item-head">
              <span>#{i + 1}</span>
              <button className="form-reset" onClick={() => form.onChange(path, items.filter((_, j) => j !== i))}>
                删除
              </button>
            </div>
            <Field schema={schema.inner} path={[...path, String(i)]} form={form} />
          </div>
        ))}
        {meta.comment ? <div className="form-hint">{String(meta.comment)}</div> : null}
      </div>
    )
  }

  // Dict (key-value map)
  if (schema.type === 'dict' && schema.inner) {
    const value = form.getValue(path)
    const entries = value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>) : []
    const key = path[path.length - 1] ?? ''
    return (
      <div className="form-field form-dict">
        <div className="form-field-head">
          <label>{labelFor(key, schema)}</label>
          <button
            className="form-add"
            onClick={() => {
              const newKey = `key-${entries.length + 1}`
              form.onChange(path, { ...(value as Record<string, unknown>), [newKey]: defaultFor(schema.inner) })
            }}
          >
            + 添加
          </button>
        </div>
        {entries.map(([k]) => (
          <div key={k} className="form-dict-item">
            <div className="form-array-item-head">
              <span className="dict-key">{k}</span>
              <button
                className="form-reset"
                onClick={() => {
                  const next = { ...(value as Record<string, unknown>) }
                  delete next[k]
                  form.onChange(path, next)
                }}
              >
                删除
              </button>
            </div>
            <Field schema={schema.inner} path={[...path, k]} form={form} />
          </div>
        ))}
      </div>
    )
  }

  // Standalone const: display only.
  if (schema.type === 'const') {
    const key = path[path.length - 1] ?? ''
    return (
      <div className="form-field">
        <div className="form-field-head">
          <label>{labelFor(key, schema)}</label>
        </div>
        <div className="form-const">{String(schema.value)}</div>
      </div>
    )
  }

  // Non-const union / intersect / anything unhandled: JSON fallback.
  if (schema.type === 'union' || schema.type === 'intersect' || schema.type === 'any') {
    return <JsonFallbackField schema={schema} path={path} form={form} />
  }

  // Leaf: string / number / boolean / fallback.
  return <LeafField schema={schema} path={path} form={form} />
}

/**
 * Secret editor with a LOCAL draft: the old shape (`value=""` + push-on-change)
 * made a controlled input snap back to blank on every keystroke, so only the
 * last typed character ever reached the pending ops. Clearing the draft drops
 * the pending op entirely (nothing to save = leave the stored secret alone).
 */
function SecretInput({
  disabled,
  set,
  onCommit,
  onClear
}: {
  disabled: boolean
  set: boolean
  onCommit: (value: string) => void
  onClear: () => void
}): ReactElement {
  const [draft, setDraft] = useState('')
  return (
    <input
      type="password"
      className="form-input"
      disabled={disabled}
      value={draft}
      placeholder={set ? '已配置 · 留空保持不变' : '未配置'}
      onChange={(e) => {
        setDraft(e.target.value)
        if (e.target.value !== '') onCommit(e.target.value)
        else onClear()
      }}
    />
  )
}

/**
 * JSON fallback editor for non-const union/intersect/any. Keeps the raw text
 * in local state so intermediate (invalid) JSON isn't wiped by the controlled
 * value snapping back; only parseable text becomes a pending op. Resyncs from
 * the store when the value changes for reasons other than this field's own
 * pushes (namespace switch, save+reload).
 */
function JsonFallbackField({ schema, path, form }: { schema: SchemaNode; path: string[]; form: SchemaFormProps }): ReactElement {
  const key = path[path.length - 1] ?? ''
  const external = form.getValue(path)
  const externalText = external === undefined ? '' : JSON.stringify(external, null, 2)
  const [text, setText] = useState(externalText)
  const [invalid, setInvalid] = useState(false)
  const lastPushed = useRef<string | null>(null)

  useEffect(() => {
    if (externalText === lastPushed.current) return
    lastPushed.current = null
    setText(externalText)
    setInvalid(false)
  }, [externalText])

  return (
    <div className="form-field">
      <div className="form-field-head">
        <label>{labelFor(key, schema)}</label>
        {invalid ? <span className="json-invalid">JSON 无效,未纳入保存</span> : null}
      </div>
      <textarea
        className={`form-json ${invalid ? 'invalid' : ''}`}
        rows={6}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          try {
            const parsed = raw.trim() === '' ? null : JSON.parse(raw)
            lastPushed.current = JSON.stringify(parsed, null, 2)
            setInvalid(false)
            form.onChange(path, parsed)
          } catch {
            lastPushed.current = null
            setInvalid(true)
          }
        }}
      />
    </div>
  )
}

function LeafField({ schema, path, form }: { schema: SchemaNode; path: string[]; form: SchemaFormProps }): ReactElement {
  const meta = schema.meta ?? {}
  const key = path[path.length - 1] ?? ''
  const overridden = form.isOverridden(path)
  const value = form.getValue(path)
  const disabled = Boolean(meta.disabled)

  let control: ReactElement
  if (schema.type === 'boolean') {
    control = (
      <input
        type="checkbox"
        className="form-checkbox"
        disabled={disabled}
        checked={Boolean(value)}
        onChange={(e) => form.onChange(path, e.target.checked)}
      />
    )
  } else if (meta.role === 'secret') {
    const set = form.secretSet(path)
    control = (
      <SecretInput
        disabled={disabled}
        set={set}
        onCommit={(v) => form.onChange(path, v)}
        onClear={() => form.onClearOp?.(path)}
      />
    )
  } else if (schema.type === 'number' || schema.type === 'natural' || schema.type === 'percent') {
    control = (
      <input
        type="number"
        className="form-input"
        disabled={disabled}
        value={value === undefined || value === null ? '' : Number(value)}
        min={meta.min}
        max={meta.max}
        step={meta.step ?? (schema.type === 'natural' ? 1 : undefined)}
        onChange={(e) => {
          const n = e.target.value === '' ? null : Number(e.target.value)
          form.onChange(path, n)
        }}
      />
    )
  } else {
    // string (and any other primitive fallback)
    control = (
      <input
        type="text"
        className="form-input"
        disabled={disabled}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={meta.default !== undefined ? String(meta.default) : ''}
        onChange={(e) => form.onChange(path, e.target.value)}
      />
    )
  }

  return (
    <div className="form-field">
      <div className="form-field-head">
        <label>{labelFor(key, schema)}</label>
        {overridden ? (
          <button className="form-reset" onClick={() => form.onReset(path)}>
            重置
          </button>
        ) : (
          <span className="form-inherited">默认</span>
        )}
      </div>
      <div className="form-field-body">{control}</div>
      {meta.comment ? <div className="form-hint">{String(meta.comment)}</div> : null}
    </div>
  )
}

export function SchemaForm(props: SchemaFormProps): ReactElement {
  return (
    <div className="schema-form">
      <Field schema={props.schema} path={[]} form={props} />
    </div>
  )
}
