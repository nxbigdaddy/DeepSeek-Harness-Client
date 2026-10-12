/** Capture a screenshot of the running app via CDP (usage: node scripts/cdp-shot.mjs [out.png]). */
import { writeFileSync } from 'node:fs'

const out = process.argv[2] ?? 'cdp-shot.png'
const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) process.exit(1)

const ws = new WebSocket(page.webSocketDebuggerUrl)
const timeout = setTimeout(() => process.exit(1), 30000)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
function send(method, params = {}) {
  return new Promise((resolve) => {
    const myId = ++id
    pending.set(myId, resolve)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
}
ws.onopen = async () => {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log('saved', out)
  clearTimeout(timeout)
  process.exit(0)
}
ws.onerror = () => process.exit(1)
