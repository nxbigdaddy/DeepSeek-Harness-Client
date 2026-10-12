/**
 * CDP drag & drop verification (async-stepped: React state must flush between
 * dragstart/dragover/drop, so each step awaits a real delay):
 *  1. create a temp workspace with two sessions via IPC
 *  2. drag the top session row onto the bottom row's lower half -> order swaps
 *  3. force the workspace to the end via IPC, then drag its header before the
 *     other workspace's header -> order swaps
 *  4. cleanup everything the test created
 */
const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) process.exit(1)

const ws = new WebSocket(page.webSocketDebuggerUrl)
const timeout = setTimeout(() => {
  console.log('TIMEOUT')
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

const findWorkspace = `(title) => [...document.querySelectorAll('.workspace')].find(w => w.querySelector('.workspace-title')?.textContent.includes(title))`
const readOrder = `(title) => {
  const el = (${findWorkspace})(title)
  return el ? [...el.querySelectorAll('.session-item .session-title')].map(e => e.textContent) : null
}`

ws.onopen = async () => {
  const testName = `__dsh_dnd_test_${Date.now()}`
  try {
    let status = ''
    for (let i = 0; i < 60; i++) {
      status = await evaluate("document.querySelector('.status')?.textContent || ''").then(val)
      if (status.includes('已连接')) break
      await sleep(1000)
    }
    check('host connected', status, /已连接/)

    const setup = await evaluate(`(async () => {
      const home = (await window.dsh.listDirectory()).home
      const { path } = await window.dsh.createDirectory(home, ${JSON.stringify(testName)})
      const { workspace } = await window.dsh.createWorkspace(path)
      const s1 = await window.dsh.createSession({ workspaceId: workspace.workspaceId })
      const s2 = await window.dsh.createSession({ workspaceId: workspace.workspaceId })
      return { path, workspaceId: workspace.workspaceId, s1: s1.sessionId, s2: s2.sessionId }
    })()`, true).then(val)
    console.log('  setup:', JSON.stringify(setup))
    await sleep(2500)

    const orderBefore = await evaluate(`(${readOrder})(${JSON.stringify(testName)})`).then(val)
    check('two sessions listed', (orderBefore ?? []).length, 2)
    console.log('  before:', JSON.stringify(orderBefore))

    // 2. session drag: start on row[0], then over/drop on row[1] lower half
    await evaluate(`(() => {
      const el = (${findWorkspace})(${JSON.stringify(testName)})
      const rows = [...el.querySelectorAll('.session-item')]
      window.__dt = new DataTransfer()
      rows[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
    })()`)
    await sleep(600)
    await evaluate(`(() => {
      const el = (${findWorkspace})(${JSON.stringify(testName)})
      const rows = [...el.querySelectorAll('.session-item')]
      const r = rows[1].getBoundingClientRect()
      const x = r.left + 10
      const y = r.top + r.height * 0.75
      rows[1].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: x, clientY: y }))
    })()`)
    await sleep(600)
    await evaluate(`(() => {
      const el = (${findWorkspace})(${JSON.stringify(testName)})
      const rows = [...el.querySelectorAll('.session-item')]
      const r = rows[1].getBoundingClientRect()
      const x = r.left + 10
      const y = r.top + r.height * 0.75
      rows[1].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: x, clientY: y }))
      rows[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt }))
    })()`)
    await sleep(2000)
    const orderAfter = await evaluate(`(${readOrder})(${JSON.stringify(testName)})`).then(val)
    console.log('  after:', JSON.stringify(orderAfter))
    check('session drag reorders', JSON.stringify(orderAfter), JSON.stringify([...(orderBefore ?? [])].reverse()))
    check('no error bar', await evaluate("!document.querySelector('.error-bar')").then(val), true)

    // 3. workspace drag: force test ws to the END first via IPC (known state)
    await evaluate(`(async () => {
      const ws = await window.dsh.listWorkspaces()
      const hit = ws.items.find(w => w.path.includes(${JSON.stringify(testName)}))
      await window.dsh.reorderWorkspace(hit.workspaceId, undefined)
    })()`, true)
    await sleep(1500)
    const wsTitles = "[...document.querySelectorAll('.workspace .workspace-title')].map(e => e.textContent.trim())"
    const wsBefore = await evaluate(wsTitles).then(val)
    check('forced to end', (wsBefore ?? []).findIndex((t) => t.includes(testName)), (wsBefore ?? []).length - 1)
    console.log('  ws before:', JSON.stringify(wsBefore))

    await evaluate(`(() => {
      const headers = [...document.querySelectorAll('.workspace .workspace-header')]
      const testH = headers.find(h => h.textContent.includes(${JSON.stringify(testName)}))
      window.__dt2 = new DataTransfer()
      testH.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt2 }))
    })()`)
    await sleep(600)
    await evaluate(`(() => {
      const headers = [...document.querySelectorAll('.workspace .workspace-header')]
      const otherH = headers.find(h => !h.textContent.includes(${JSON.stringify(testName)}))
      const r = otherH.getBoundingClientRect()
      otherH.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt2, clientX: r.left + 10, clientY: r.top + r.height * 0.25 }))
    })()`)
    await sleep(600)
    await evaluate(`(() => {
      const headers = [...document.querySelectorAll('.workspace .workspace-header')]
      const testH = headers.find(h => h.textContent.includes(${JSON.stringify(testName)}))
      const otherH = headers.find(h => !h.textContent.includes(${JSON.stringify(testName)}))
      const r = otherH.getBoundingClientRect()
      otherH.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt2, clientX: r.left + 10, clientY: r.top + r.height * 0.25 }))
      testH.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt2 }))
    })()`)
    await sleep(2000)
    const wsAfter = await evaluate(wsTitles).then(val)
    console.log('  ws after:', JSON.stringify(wsAfter))
    check('workspace drag reorders', (wsAfter ?? []).findIndex((t) => t.includes(testName)), 0)
  } finally {
    const cleanup = await evaluate(`(async () => {
      const out = []
      const ws = await window.dsh.listWorkspaces()
      for (const w of ws.items) {
        if (w.path.includes(${JSON.stringify(testName)})) {
          await window.dsh.deleteWorkspace(w.workspaceId)
          out.push('ws:' + w.title)
        }
      }
      for (const s of await window.dsh.listSessions()) {
        if (s.cwd && s.cwd.includes(${JSON.stringify(testName)}) && s.blank) {
          await window.dsh.archiveSession(s.sessionId)
          out.push('archived:' + s.sessionId.slice(0, 16))
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
ws.onerror = () => process.exit(1)
