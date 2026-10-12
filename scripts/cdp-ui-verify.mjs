/**
 * CDP UI verification for the workspace iteration:
 *  1. app boots, window.dsh present, host connects
 *  2. "打开项目文件夹…" opens the in-app directory modal (crumbs + entries)
 *  3. clicking an entry navigates; crumb navigates back
 *  4. "新建文件夹" inline input creates a folder via IPC and navigates into it
 *  5. "选择此文件夹" adopts it -> workspace appears in sidebar + auto session
 *  6. bogus moveSessionBefore rejects over IPC (error surfaces to caller)
 * Cleans up whatever it creates (workspace, auto session, temp folder, and any
 * home-dir workspace adopted by accident in earlier runs).
 * Exits non-zero on any failed step. Requires the app on :9222.
 */
const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.log('no page target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
const timeout = setTimeout(() => {
  console.log('TIMEOUT waiting for CDP')
  process.exit(1)
}, 120000)

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
  const testName = `__dsh_ui_test_${Date.now()}`
  let homePath = ''
  try {
    // 1. boot
    check('window.dsh typeof', await evaluate('typeof window.dsh').then(val), 'object')
    let status = ''
    for (let i = 0; i < 60; i++) {
      status = await evaluate("document.querySelector('.status')?.textContent || ''").then(val)
      if (status.includes('已连接')) break
      await sleep(1000)
    }
    check('host connected', status, /已连接/)

    // snapshot sessions to distinguish test-created ones at cleanup
    const sessionsBefore = await evaluate('window.dsh.listSessions().then(s => s.map(x => x.sessionId))', true).then(val)

    // 2. open the modal
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('打开项目文件夹'))?.click()`)
    await sleep(1200)
    check('modal visible', await evaluate('!!document.querySelector(\'.modal\')').then(val), true)
    check('crumbs present', (await evaluate("document.querySelectorAll('.crumb').length").then(val)) > 0, true)
    homePath = await evaluate("document.querySelector('.selected-path')?.textContent || ''").then(val)
    check('starts at home', homePath.length > 0, true)
    console.log('  home =', homePath)
    check('entries listed', (await evaluate("document.querySelectorAll('.dir-entry').length").then(val)) > 0, true)

    // 3. navigate into first entry, then back via crumb
    await evaluate("document.querySelector('.dir-entry')?.click()")
    await sleep(800)
    const nested = await evaluate("document.querySelector('.selected-path')?.textContent || ''").then(val)
    check('navigated into entry', nested !== homePath && nested.startsWith(homePath), true)
    console.log('  into =', nested)
    await evaluate("document.querySelectorAll('.crumb')[document.querySelectorAll('.crumb').length - 2]?.click()")
    await sleep(800)
    check('crumb navigates back', await evaluate("document.querySelector('.selected-path')?.textContent || ''").then(val), homePath)

    // 4. create a folder via the inline input (React controlled input needs the native setter)
    await evaluate(`[...document.querySelectorAll('.modal-footer button')].find(b => b.textContent === '新建文件夹')?.click()`)
    await sleep(300)
    await evaluate(`(() => {
      const i = document.querySelector('.new-folder-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(i, ${JSON.stringify(testName)})
      i.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(200)
    await evaluate(`document.querySelector('.new-folder-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await sleep(1500)
    const afterCreate = await evaluate("document.querySelector('.selected-path')?.textContent || ''").then(val)
    check('new folder created + navigated', afterCreate.includes(testName), true)
    console.log('  created =', afterCreate)

    // 5. pick it -> workspace adopted + auto session created + notice shown
    await evaluate(`[...document.querySelectorAll('.modal-footer button')].find(b => b.textContent === '选择此文件夹')?.click()`)
    await sleep(2500)
    check('modal closed', await evaluate("!document.querySelector('.modal')").then(val), true)
    const wsTitles = await evaluate("[...document.querySelectorAll('.workspace-title')].map(e => e.textContent)").then(val)
    check('workspace in sidebar', (wsTitles ?? []).some((t) => t.includes(testName)), true)
    check('adopt notice', await evaluate("document.querySelector('.settings-message.ok')?.textContent || ''").then(val), /已添加工作区/)
    const sessionsAfter = await evaluate('window.dsh.listSessions().then(s => s.map(x => x.sessionId))', true).then(val)
    const newSessions = (sessionsAfter ?? []).filter((s) => !(sessionsBefore ?? []).includes(s))
    check('auto session created', newSessions.length >= 1, true)

    // 6. bogus IPC call rejects (error reaches the caller)
    check(
      'bogus moveSessionBefore rejects over IPC',
      await evaluate("(async () => { try { await window.dsh.moveSessionBefore('ws-bogus', 'session-bogus'); return false } catch { return true } })()", true).then(val),
      true
    )
  } finally {
    // cleanup: workspaces pointing at the test folder or (from earlier buggy runs) the home dir,
    // plus blank sessions created inside them
    const cleanup = await evaluate(`(async () => {
      const out = []
      const ws = await window.dsh.listWorkspaces()
      for (const w of ws.items) {
        if (w.path.includes(${JSON.stringify(testName)}) || w.path === ${JSON.stringify(homePath)}) {
          await window.dsh.deleteWorkspace(w.workspaceId)
          out.push('ws:' + w.path)
        }
      }
      const sessions = await window.dsh.listSessions()
      for (const s of sessions) {
        const inTest = s.cwd && (s.cwd.includes(${JSON.stringify(testName)}) || s.cwd === ${JSON.stringify(homePath)})
        if (inTest && s.blank) {
          await window.dsh.archiveSession(s.sessionId)
          out.push('archived:' + s.sessionId)
        }
      }
      return out
    })()`, true).then(val)
    console.log('  cleanup:', JSON.stringify(cleanup))
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
    clearTimeout(timeout)
    process.exit(failures === 0 ? 0 : 1)
  }
}
ws.onerror = (e) => {
  console.log('WS ERROR:', e?.message ?? String(e))
  clearTimeout(timeout)
  process.exit(1)
}
