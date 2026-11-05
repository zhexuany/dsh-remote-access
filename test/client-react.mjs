/**
 * Real-React render test for the settings panel.
 *
 * The mini-React harness in test/client-smoke.mjs is dependency-free, but it
 * cannot catch React's own rules — most importantly a changing hook count
 * ("Rendered more hooks than during the previous render"), which silently
 * blanks a slot in the real GUI.
 *
 * This test renders client.js with the real react + react-dom into jsdom,
 * feeds it a stubbed /remote-access/status response, and fails if React
 * reports an error or the panel does not show the expected content.
 *
 * Usage: node test/client-react.mjs [--client <path>] [--mode ready|refused|unknown] [--delay <ms>]
 * Requires react, react-dom and jsdom (see .scratch/uitest or any node_modules
 * reachable from the repo root); exit 2 = dependencies missing.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const argv = process.argv.slice(2)
const readFlag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}
const clientPath = resolve(readFlag('--client', resolve(root, 'client.js')))
const mode = readFlag('--mode', 'ready')

// deps may live next to the plugin, in a scratch dir, or wherever the caller points
const depsCandidates = [
  process.env.DSH_REMOTE_ACCESS_TEST_DEPS,
  root,
  `${root}/../.scratch/uitest`,
  `${root}/../.test-deps`
].filter(Boolean)

const loadDep = (spec) => {
  let last
  for (const dir of depsCandidates) {
    try {
      return createRequire(`${resolve(dir)}/package.json`)(spec)
    } catch (cause) {
      last = cause
    }
  }
  throw last
}

let React, createRoot, jsdom
for (const spec of ['react', 'react-dom/client', 'jsdom']) {
  try {
    const loaded = loadDep(spec)
    if (spec === 'react') React = loaded
    else if (spec === 'jsdom') jsdom = loaded
    else createRoot = loaded.createRoot
  } catch (cause) {
    process.stderr.write(`client-react: cannot load ${spec} (${cause.message})\n`)
    process.stderr.write('client-react: install deps first, e.g. cd .scratch/uitest && pnpm add react@18.3.1 react-dom@18.3.1 jsdom\n')
    process.exit(2)
  }
}

const STATUS = {
  ready: {
    state: 'ready', provider: 'cloudflare-quick', providerLabel: 'Cloudflare 快速隧道',
    target: 'http://127.0.0.1:61733', tunnelUrl: 'https://example-tunnel.trycloudflare.com',
    link: 'https://example-tunnel.trycloudflare.com/?token=ABC', localLink: 'http://127.0.0.1:61733/?token=ABC',
    access: { mode: 'token-link', state: 'token-required', checkedAt: '2026-10-04T09:00:00.000Z', gate: 'absent' },
    trustedHosts: ['example-tunnel.trycloudflare.com'],
    logs: [{ at: '2026-10-04T09:00:00.000Z', text: 'tunnel URL: https://example-tunnel.trycloudflare.com' }]
  },
  refused: {
    state: 'ready', provider: 'cloudflare-quick', providerLabel: 'Cloudflare 快速隧道',
    target: 'http://127.0.0.1:61733', tunnelUrl: 'https://example-tunnel.trycloudflare.com',
    link: 'https://example-tunnel.trycloudflare.com/?token=ABC', localLink: 'http://127.0.0.1:61733/?token=ABC',
    access: { mode: 'token-link', state: 'refused', checkedAt: '2026-10-04T09:00:00.000Z', gate: 'absent' },
    trustedHosts: [], logs: []
  },
  unknown: {
    state: 'ready', provider: 'cloudflare-quick', providerLabel: 'Cloudflare 快速隧道',
    target: 'http://127.0.0.1:61733', tunnelUrl: 'https://example-tunnel.trycloudflare.com',
    link: 'https://example-tunnel.trycloudflare.com/?token=ABC', localLink: 'http://127.0.0.1:61733/?token=ABC',
    access: { mode: 'token-link', state: 'unknown', checkedAt: null, gate: 'absent' },
    trustedHosts: ['example-tunnel.trycloudflare.com'], logs: []
  }
}[mode]
if (!STATUS) {
  process.stderr.write(`client-react: unknown --mode ${mode}\n`)
  process.exit(2)
}

const failures = []
const errors = []
const check = (name, condition, detail) => {
  if (condition) process.stdout.write(`  ok   ${name}\n`)
  else {
    failures.push(name)
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`)
  }
}

// ---- browser environment -----------------------------------------------------
const dom = new jsdom.JSDOM('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:61733/'
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
globalThis.Event = window.Event
window.IS_REACT_ACT_ENVIRONMENT = true

// capture every React complaint, including hook-order violations
const capture = (...args) => {
  errors.push(args.map((value) => (value && value.message) ? value.message : String(value)).join(' '))
}
window.console.error = capture
window.console.warn = capture
const realError = console.error
console.error = capture
window.addEventListener('error', (event) => errors.push(String(event.message)))
process.on('uncaughtException', (error) => errors.push(String(error && error.message)))

// ---- module loader + fetch stub ---------------------------------------------
let registration = null
window.__ModuleLoader__ = {
  load(entry) {
    if (registration) throw new Error(`duplicate registration for ${entry && entry.id}`)
    registration = entry
  }
}

const requests = []
const resolveDelayMs = Number(readFlag('--delay', '120'))
const stubFetch = (url, options = {}) => {
  const target = String(url)
  requests.push({ url: target, method: options.method || 'GET' })
  const body = STATUS
  return new Promise((done) => {
    setTimeout(
      () => done({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) }),
      resolveDelayMs
    )
  })
}
globalThis.fetch = stubFetch
window.fetch = stubFetch

// ---- load the bundle ---------------------------------------------------------
await import(pathToFileURL(clientPath).href)
if (!registration) {
  process.stderr.write('client-react: client.js did not register through __ModuleLoader__\n')
  process.exit(1)
}

const requireFn = (spec) => {
  if (spec === 'react') return React
  throw new Error(`client-react: unexpected require("${spec}")`)
}
const face = registration.factory(requireFn)

let registered = null
const ctx = {
  slots: {
    inject(name, run) { check(`slot injected: ${name}`, name === 'settings.section'); run() },
    register(options, Component) { registered = { options, Component } }
  }
}
face.apply(ctx)

process.stdout.write(`client-react — ${clientPath.split('/').slice(-2).join('/')} mode=${mode}\n`)
check('registration id is the package name', registration.id === 'dsh-remote-access', registration.id)
check('face exposes apply + inject slots', typeof face.apply === 'function' && face.inject.includes('slots'))
check('slot entry registered', Boolean(registered && registered.Component))
check('label resolves to 远程协作', Boolean(registered) && registered.options.label() === '远程协作')

// ---- render -----------------------------------------------------------------
const container = document.getElementById('root')
const root_ = createRoot(container)
const tick = () => new Promise((done) => setTimeout(done, 25))

root_.render(React.createElement(registered.Component, { close() {} }))
await tick()
const first = container.textContent || ''
check('first render shows the title', first.includes('远程协作'), first.slice(0, 80))
// the status response is deliberately delayed: the first paint must survive with no data,
// and the second (with data + the access block) must not change the hook count
check('first paint renders before any status data', first.includes('未启动'), first.slice(0, 120))

for (let waited = 0; waited < 600; waited += 25) {
  await tick()
  if ((container.textContent || '').includes('已就绪')) break
}
const text = container.textContent || ''
const values = [...container.querySelectorAll('input')].map((node) => node.value)
process.stdout.write(`  · inputs: ${JSON.stringify(values)}\n`)
process.stdout.write(`  · rendered: ${text.replace(/\s+/g, ' ').slice(0, 200)}\n`)

check('status request went to /remote-access/status', requests.some((entry) => entry.url.includes('/remote-access/status')), JSON.stringify(requests))
check('status response is rendered (已就绪)', text.includes('已就绪'), text.slice(0, 160))
check('tunnel address is rendered', text.includes('example-tunnel.trycloudflare.com'))
check('share link is rendered', values.some((value) => value.includes('?token=ABC')), JSON.stringify(values))
check('loopback link is rendered', values.some((value) => value.includes('http://127.0.0.1:61733/?token=ABC')), JSON.stringify(values))
check('ssh -L hint is rendered', text.includes('ssh -N -L 8080:127.0.0.1:61733'))
if (mode === 'ready') {
  check(
    'the panel says the Desktop switch is gone',
    text.includes('没有「允许在浏览器中打开」这个开关') && !text.includes('临时打开网页访问'),
    text.slice(0, 240)
  )
}
if (mode === 'refused') check('refused probe raises the trustedHosts hint', text.includes('探测被 403 拒绝') && text.includes('trustedHosts'), text.slice(0, 240))
if (mode === 'unknown') check('an unknown probe renders without a banner', !text.includes('探测被 403 拒绝'), text.slice(0, 240))

const hookErrors = errors.filter((line) => /hooks|hook order|Rendered (more|fewer)/i.test(line))
check('React reported no hook-order violation', hookErrors.length === 0, hookErrors.join(' | '))
check('React rendered without any error', errors.length === 0, errors.slice(0, 2).join(' | '))

root_.unmount()
process.stdout.write(failures.length ? `client-react: ${failures.length} check(s) FAILED\n` : 'client-react: all checks passed\n')
process.exit(failures.length ? 1 : 0)
