/**
 * CDP smoke for the settings/capabilities surfaces after the review-fix round:
 *  1. 设置 view renders namespaces + schema form without errors
 *  2. secret input keeps a full typed draft (the single-char regression)
 *  3. unsaved-ops namespace switch asks for confirmation (auto-dismiss)
 *  4. 能力 view renders; MCP JSON save with invalid JSON shows err styling
 * Requires the app on :9222.
 */
const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) process.exit(1)
const ws = new WebSocket(page.webSocketDebuggerUrl)
const timeout = setTimeout(() => {
  console.log('TIMEOUT')
  process.exit(1)
}, 90000)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
function evaluate(expression, awaitPromise = false) {
  return new Promise((resolve) => {
    const myId = ++id
    pending.set(myId, resolve)
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }))
  })
}
const val = (m) => m.result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, got, want) => {
  const ok = want instanceof RegExp ? want.test(String(got)) : got === want
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}`)
  if (!ok) failures++
}

ws.onopen = async () => {
  for (let i = 0; i < 60; i++) {
    const status = await evaluate("document.querySelector('.status')?.textContent || ''").then(val)
    if (status.includes('已连接')) break
    await sleep(1000)
  }
  check('host connected', await evaluate("document.querySelector('.status')?.textContent || ''").then(val), /已连接/)

  // 1. settings view renders
  await evaluate(`[...document.querySelectorAll('.view-tab')].find(b => b.textContent === '设置')?.click()`)
  await sleep(2500)
  const nsCount = await evaluate("document.querySelectorAll('.settings-ns').length").then(val)
  check('namespaces listed', nsCount > 0, true)
  check('schema form rendered', await evaluate("!!document.querySelector('.schema-form')").then(val), true)

  // 2. secret input draft regression: type 5 chars into a password field, value must hold all
  const secretCheck = await evaluate(`(() => {
    const input = document.querySelector('.schema-form input[type=password]')
    if (!input) return 'NO_SECRET_FIELD'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    for (const ch of 'sk-123'.split('')) {
      setter.call(input, input.value + ch)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return input.value
  })()`).then(val)
  if (secretCheck === 'NO_SECRET_FIELD') {
    console.log('SKIP secret draft (no secret field in this settings schema)')
  } else {
    check('secret draft keeps full text', secretCheck, 'sk-123')
  }

  // 3. unsaved ops guard: make an edit, then switch namespace -> confirm dialog (auto-accept)
  const guard = await evaluate(`(async () => {
    const checkbox = document.querySelector('.schema-form input[type=checkbox]') || document.querySelector('.schema-form input[type=text]')
    if (!checkbox) return 'NO_EDITABLE_FIELD'
    checkbox.click()
    await new Promise(r => setTimeout(r, 400))
    const saveBtn = [...document.querySelectorAll('.settings-actions button')].find(b => b.textContent.includes('保存'))
    const opsBefore = saveBtn?.textContent ?? ''
    window.confirm = () => false // refuse the switch
    const other = document.querySelectorAll('.settings-ns')[1]
    if (!other) return 'NO_OTHER_NS'
    other.click()
    await new Promise(r => setTimeout(r, 400))
    const activeAfter = document.querySelector('.settings-ns.active')?.textContent ?? ''
    const otherLabel = other.textContent ?? ''
    return { opsBefore, stayed: !activeAfter.includes(otherLabel.trim()) }
  })()`, true).then(val)
  if (typeof guard === 'string') {
    console.log('SKIP ops guard:', guard)
  } else {
    check('unsaved edits counted on save button', guard.opsBefore, /项改动/)
    check('switch refused keeps namespace', guard.stayed, true)
  }
  // undo the checkbox toggle to leave settings untouched
  await evaluate(`(() => { const c = document.querySelector('.schema-form input[type=checkbox]'); if (c) c.click() })()`)
  await sleep(300)

  // 4. capabilities view: invalid MCP JSON -> err styling
  await evaluate(`[...document.querySelectorAll('.view-tab')].find(b => b.textContent === '能力')?.click()`)
  await sleep(1500)
  await evaluate(`(() => {
    const t = document.querySelector('.json-editor')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(t, '{broken')
    t.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await evaluate(`[...document.querySelectorAll('.cap-section')].find(s => s.querySelector('h3')?.textContent === 'MCP 服务器')?.querySelector('button.send')?.click()`)
  await sleep(800)
  check('MCP invalid JSON shows err styling', await evaluate("!!document.querySelector('.cap-section .settings-message.err')").then(val), true)
  check('no global error bar from these flows', await evaluate("!document.querySelector('.error-bar')").then(val), true)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
  clearTimeout(timeout)
  process.exit(failures === 0 ? 0 : 1)
}
ws.onerror = () => process.exit(1)
