/** Boot check against a CDP port (usage: node scripts/cdp-boot-check.mjs [port]). */
const port = process.argv[2] ?? '9223'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null)
if (!targets) {
  console.log('CDP UNREACHABLE on', port)
  process.exit(1)
}
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.log('NO PAGE TARGET')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const ev = (expr) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  })
ws.onopen = async () => {
  for (let i = 0; i < 45; i++) {
    const m = await ev("document.querySelector('.status') ? document.querySelector('.status').textContent : ''")
    const s = m.result?.result?.value ?? ''
    if (s.includes('已连接')) {
      console.log('PACKAGED BOOT OK:', s)
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  const err = await ev("document.querySelector('.status-error') ? document.querySelector('.status-error').textContent : '(none)'")
  console.log('PACKAGED BOOT TIMEOUT; error =', err.result?.result?.value)
  process.exit(1)
}
ws.onerror = () => process.exit(1)
