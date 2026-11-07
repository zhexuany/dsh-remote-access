#!/usr/bin/env node
/**
 * Headless smoke test for the client half of dsh-remote-access.
 *
 * The documented failure mode for a UI plugin is a component that throws: the
 * slot goes blank with only a console line (`slot entry crashed in
 * 'settings.section'`). There is no react-dom in a Desktop install, so instead
 * of a DOM this test drives the bundle through a minimal renderer that runs the
 * component, its hooks and its effects, then inspects the tree it produced.
 *
 * It loads `client.js` exactly as the browser loader does — a classic script that
 * calls `window.__ModuleLoader__.load({ id, factory })` and receives React from
 * the module table — so a wrong registration id, a bad `require`, or an
 * exception inside the component all fail here.
 *
 * Offline it renders two server payloads: a healthy ready tunnel (`access.state
 * === 'token-required'`, i.e. the fence answers 401 without the launch token) and
 * the refused case (`403`, the tunnel authority is missing from trustedHosts).
 * `browser-access` no longer exists on the Host, so the panel must never post it.
 *
 *   node test/client-smoke.mjs
 *   node test/client-smoke.mjs --live http://127.0.0.1:18790 [--cookie name=value]
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Prefer the app that is actually installed; the module table only exists in a real install. */
const APP_ROOT =
  process.env.DSH_NEXT_APP_ROOT ||
  ['/Applications/DeepSeek Harness.app', '/Applications/DSH NEXT.app', path.join(os.homedir(), 'Applications/DeepSeek Harness.app')]
    .flatMap((app) => [
      path.join(app, 'Contents', 'Resources', 'app.asar'),
      path.join(app, 'Contents', 'Resources', 'app')
    ])
    .find((candidate) => existsSync(path.join(candidate, 'package.json'))) ||
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

const args = process.argv.slice(2)
const liveIndex = args.indexOf('--live')
const liveBase = liveIndex >= 0 ? args[liveIndex + 1] : null
const cookieIndex = args.indexOf('--cookie')
const liveCookie = cookieIndex >= 0 ? args[cookieIndex + 1] : null
const realFetch = globalThis.fetch.bind(globalThis)

const failures = []
function check(description, condition, detail) {
  if (condition) {
    process.stdout.write(`✓ ${description}\n`)
    return
  }
  failures.push(description)
  process.stdout.write(`✗ ${description}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

/* ---------------------------------------------------------------- fake React */

function createRenderer() {
  const state = { hooks: [], cursor: 0, effects: [], pending: [] }
  const isFn = (value) => typeof value === 'function'

  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => Object.is(item, b[index]))

  const React = {
    createElement(type, props, ...children) {
      const flat = children.length <= 1 ? children[0] : children
      return { type, props: { ...(props ?? {}), children: flat } }
    },
    useState(initial) {
      const index = state.cursor
      state.cursor += 1
      if (!(index in state.hooks)) state.hooks[index] = { value: isFn(initial) ? initial() : initial }
      const slot = state.hooks[index]
      return [
        slot.value,
        (next) => {
          const value = isFn(next) ? next(slot.value) : next
          if (!Object.is(value, slot.value)) {
            slot.value = value
            state.pending.push(true)
          }
        }
      ]
    },
    useRef(initial) {
      const index = state.cursor
      state.cursor += 1
      if (!(index in state.hooks)) state.hooks[index] = { current: initial }
      return state.hooks[index]
    },
    useMemo(factory, deps) {
      const index = state.cursor
      state.cursor += 1
      const previous = state.hooks[index]
      if (!previous || !sameDeps(previous.deps, deps)) state.hooks[index] = { deps, value: factory() }
      return state.hooks[index].value
    },
    useCallback(factory, deps) {
      const index = state.cursor
      state.cursor += 1
      const previous = state.hooks[index]
      if (!previous || !sameDeps(previous.deps, deps)) state.hooks[index] = { deps, value: factory }
      return state.hooks[index].value
    },
    useEffect(factory, deps) {
      const index = state.cursor
      state.cursor += 1
      const previous = state.hooks[index]
      const changed = !previous || !deps || !sameDeps(previous.deps, deps)
      state.hooks[index] = { deps, factory }
      if (changed) state.effects.push(factory)
    }
  }
  React.Fragment = Symbol('Fragment')

  /** Render a node, descending into function components. */
  function render(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node), props: {} }
    if (Array.isArray(node)) return { type: '#array', props: {}, children: node.map(render).filter(Boolean) }
    if (!node.type) return null
    if (isFn(node.type)) {
      const saved = state.cursor
      state.cursor = 0
      const produced = node.type(node.props ?? {})
      state.cursor = saved
      return { type: node.type.name || 'Component', props: node.props ?? {}, children: [render(produced)].filter(Boolean) }
    }
    return {
      type: String(node.type),
      props: node.props ?? {},
      children: [render(node.props?.children)].filter(Boolean)
    }
  }

  function collectText(node, out = []) {
    if (!node) return out
    if (node.type === '#text') out.push(node.text)
    for (const child of node.children ?? []) collectText(child, out)
    return out
  }

  return { React, render, collectText, state }
}

/* ------------------------------------------------------------------- harness */

function installGlobals(registration) {
  const captured = { registration: null, requires: [], timers: { intervals: [] } }
  const lang = process.env.TEST_LANG || 'zh-CN'
  /** Node >= 21 exposes a read-only `navigator`, so define rather than assign. */
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  define('window', {
    __ModuleLoader__: {
      mode: 'queue',
      load(value) {
        captured.registration = value
      }
    },
    addEventListener() {},
    removeEventListener() {},
    open() {}
  })
  define('document', {
    documentElement: { lang, getAttribute: (name) => (name === 'lang' ? lang : null) },
    baseURI: liveBase ? `${liveBase.replace(/\/+$/, '')}/` : 'http://127.0.0.1:18790/',
    title: '',
    addEventListener() {},
    removeEventListener() {}
  })
  define('navigator', { language: lang, clipboard: undefined })
  /** The panel polls on an interval: capture the tick so the test can drive it. */
  define('setInterval', (fn) => {
    captured.timers.intervals.push(fn)
    return captured.timers.intervals.length - 1
  })
  define('clearInterval', (id) => {
    if (typeof id === 'number') captured.timers.intervals[id] = null
  })
  globalThis.registration = registration
  return captured
}

async function loadBundle(captured, moduleTable) {
  const requireShim = (spec) => {
    captured.requires.push(spec)
    if (spec in moduleTable) return moduleTable[spec]
    throw new Error(`client-modules: require("${spec}") missed the module table (test harness)`)
  }
  await import(path.join(PACKAGE_ROOT, 'client.js'))
  if (!captured.registration) throw new Error('client.js did not call window.__ModuleLoader__.load')
  return captured.registration.factory(requireShim)
}

/** Offline server: the payload is keyed by the last path segment of the URL. */
function fakeFetch(payloads, calls) {
  return async (url) => {
    calls.push(String(url))
    const action = String(url).split(/[?#]/)[0].split('/').filter(Boolean).pop()
    const body = payloads[action] ?? payloads.status
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body)
    }
  }
}

async function liveFetch(url, calls) {
  calls.push(url)
  // The harness replaces globalThis.fetch; keep the real one to avoid recursing into ourselves.
  const response = await realFetch(url, {
    headers: liveCookie ? { cookie: liveCookie } : {}
  })
  const text = await response.text()
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    json: async () => JSON.parse(text),
    text: async () => text
  }
}

const SAMPLE = {
  plugin: 'dsh-remote-access',
  enabled: true,
  autoStart: true,
  provider: 'cloudflare-quick',
  providerLabel: 'Cloudflare 快速隧道（免登录，随机域名，每次重启都会变）',
  protocol: 'http2',
  state: 'ready',
  tunnelUrl: 'https://example-tunnel.trycloudflare.com',
  link: 'https://example-tunnel.trycloudflare.com/?token=abc123',
  localLink: 'http://127.0.0.1:18790/?token=abc123',
  authority: 'example-tunnel.trycloudflare.com',
  target: 'http://127.0.0.1:18790',
  attempts: 0,
  error: null,
  access: { mode: 'token-link', state: 'token-required', checkedAt: '2026-10-04T00:00:00.000Z', gate: 'absent' },
  trustedHosts: ['example-tunnel.trycloudflare.com'],
  home: '/Users/somebody/.dsh',
  remoteDir: '/Users/somebody/.dsh/remote-access',
  cloudflared: '/Users/somebody/.dsh/remote-access/bin/cloudflared',
  logs: ['2026-10-04T00:00:00.000Z [tunnel] tunnel URL: https://example-tunnel.trycloudflare.com'],
  providers: [{ id: 'cloudflare-quick', label: 'Cloudflare 快速隧道' }]
}

/** The panel as it looks when a tokenless request is refused with 403. */
const SAMPLE_REFUSED = { ...SAMPLE, access: { ...SAMPLE.access, state: 'refused' } }

async function main() {
  /* 1 — static policy scan (the authoring rules this plugin must obey) */
  const source = await readFile(path.join(PACKAGE_ROOT, 'client.js'), 'utf8')
  check('no Harness Client package import', !/dsh-client-ui-(primitives|dockkit|slots)/.test(source))
  check('does not touch document.body', !/document\.body/.test(source))
  check('no iframe', !/iframe/i.test(source))
  check('registers through __ModuleLoader__.load', /__ModuleLoader__\.load\(/.test(source))

  /* 2 — load the bundle the way the loader does */
  const renderer = createRenderer()
  const captured = installGlobals(renderer.React)
  const requireCache = createRequire(path.join(APP_ROOT, 'node_modules', 'x.js'))
  const moduleTable = { react: renderer.React }
  // The packaged app bundles React into its renderer assets instead of shipping a
  // resolvable `node_modules/react`, so a miss here is informational: the harness
  // serves its own React through the module table below.
  try {
    const real = requireCache('react')
    check('the app ships a react the module table can serve', typeof real?.createElement === 'function', real?.version)
  } catch (error) {
    process.stdout.write(`· the installed app has no resolvable react (${error.code || error.message}) — the harness shim serves the module table\n`)
  }
  const face = await loadBundle(captured, moduleTable)
  check('registration id is the package name', captured.registration.id === 'dsh-remote-access', captured.registration.id)
  check('require() asked only for react', captured.requires.every((spec) => spec === 'react'), captured.requires.join(', '))
  check('exports a cordis face (apply)', typeof face?.apply === 'function')
  check('injects "slots" and "connection"', JSON.stringify(face?.inject) === '["slots","connection"]', JSON.stringify(face?.inject))

  /* 3 — apply to a fake cordis context */
  let registered = null
  let injectedSlot = null
  const ctx = {
    slots: {
      inject(name, callback) {
        injectedSlot = name
        return callback()
      },
      register(options, Component) {
        registered = { options, Component }
        return () => {}
      }
    }
  }
  let applyError = null
  try {
    face.apply(ctx)
  } catch (error) {
    applyError = error
  }
  check('apply() completes', !applyError, applyError?.message)
  check('registers into settings.section', injectedSlot === 'settings.section', String(injectedSlot))
  check('registration is a list entry with an id', registered?.options?.id === 'remote-access')
  check('registration declares an order', typeof registered?.options?.order === 'number')
  const label = typeof registered?.options?.label === 'function' ? registered.options.label() : registered?.options?.label
  check('label is localized Chinese', typeof label === 'string' && /[\u4e00-\u9fa5]/.test(label), String(label))
  check('label follows the document language', label === '远程协作', String(label))
  check('component is a function', typeof registered?.Component === 'function')

  /* 4 — render: loading state, then the loaded state */
  const fetchCalls = []
  const requests = []
  let inflight = 0
  const payloads = { status: SAMPLE }
  const inner = liveBase ? (url) => liveFetch(url, fetchCalls) : fakeFetch(payloads, fetchCalls)
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null })
    inflight += 1
    try {
      return await inner(url)
    } finally {
      inflight -= 1
    }
  }

  let tree = null
  let quiet = 0
  const mount = () => renderer.render(renderer.React.createElement(registered.Component, {}))

  /** Run effects, then keep re-rendering until the panel is quiet AND no request is in flight. */
  async function settle() {
    for (let pass = 0; pass < 60; pass += 1) {
      const effects = renderer.state.effects.splice(0, renderer.state.effects.length)
      for (const effect of effects) await effect()
      await new Promise((resolve) => setTimeout(resolve, liveBase ? 120 : 40))
      const changed = effects.length > 0 || renderer.state.pending.length > 0
      renderer.state.pending.length = 0
      tree = mount()
      if (changed || inflight > 0) quiet = 0
      else if ((quiet += 1) >= 3 && pass >= 2) break
    }
    return tree
  }

  const clickables = () =>
    (function walk(node, out = []) {
      if (!node) return out
      if (typeof node.props?.onClick === 'function') out.push(node)
      for (const child of node.children ?? []) walk(child, out)
      return out
    })(tree)

  const clickByText = async (pattern) => {
    const target = clickables().find((node) => pattern.test(renderer.collectText(node).join(' ')))
    if (!target) return false
    target.props.onClick()
    renderer.state.pending.length = 0
    await settle()
    return true
  }

  /** Fire the panel's status poll and let the resulting render settle. */
  const poll = async () => {
    for (const fn of captured.timers.intervals) if (typeof fn === 'function') fn()
    await settle()
  }

  const valuesIn = (node, out = []) => {
    if (!node) return out
    if (typeof node.props?.value === 'string') out.push(node.props.value)
    for (const child of node.children ?? []) valuesIn(child, out)
    return out
  }

  let renderError = null
  try {
    tree = mount()
    await settle()
  } catch (error) {
    renderError = error
  }
  check('component renders without throwing', !renderError, renderError?.stack?.split('\n').slice(0, 3).join(' | '))
  if (renderError) return finish()

  let text = renderer.collectText(tree).join(' ')
  let values = valuesIn(tree)
  check('fetch went to the plugin API under baseURI', fetchCalls.some((url) => url.endsWith('/remote-access/status')), fetchCalls.join(', '))
  check('renders a tunneling state label', /(隧道|Tunnel)/.test(text))
  if (liveBase) {
    check('live payload reached the panel', !/无法连接|Cannot reach|failed/i.test(text), text.slice(0, 160))
  } else {
    check('shows the tunnel hostname', text.includes('example-tunnel.trycloudflare.com'))
    check('offers the share link in a copy field', values.some((value) => value.includes('?token=abc123') && value.startsWith('https://')), values.join(' | '))
    check('offers the loopback link for ssh -L', values.some((value) => value.startsWith('http://127.0.0.1:18790/?token=')), values.join(' | '))
    check('documents the ssh -L recipe', /ssh -N -L/.test(text), text.slice(0, 300))
  }
  check('offers a copy control', /(复制|Copy)/.test(text), text.slice(0, 200))

  /* 5 — a state-only interaction must re-render cleanly */
  check('a details toggle exists', clickables().some((node) => /详情|Details/.test(renderer.collectText(node).join(' '))), `${clickables().length} clickable nodes`)
  let clickError = null
  try {
    await clickByText(/详情|Details/)
  } catch (error) {
    clickError = error
  }
  check('details toggle re-renders without throwing', !clickError, clickError?.message)
  text = renderer.collectText(tree).join(' ')
  check('details disclose internals', /(127\.0\.0\.1|home|remoteDir|target|本机|路径)/i.test(text))

  /* 6 — the switch is gone: honest text, no button, no request */
  if (!liveBase) {
    text = renderer.collectText(tree).join(' ')
    check('the panel explains the switch no longer exists', /没有「允许在浏览器中打开」这个开关/.test(text), text.slice(0, 300))
    check('the healthy panel shows no refusal banner', !/探测被 403 拒绝/.test(text), text.slice(0, 300))
    check('the panel never posts browser-access', !requests.some((entry) => entry.url.endsWith('/remote-access/browser-access')), requests.map((entry) => entry.url).join(', '))

    payloads.status = SAMPLE_REFUSED
    tree = await settle()
    await poll()
    text = renderer.collectText(tree).join(' ')
    check('a refused probe raises the trustedHosts hint', /探测被 403 拒绝/.test(text) && /trustedHosts/.test(text), text.slice(0, 300))
    check('the refused panel offers no dead switch', !/临时打开网页访问/.test(text), text.slice(0, 300))

    payloads.status = SAMPLE
    tree = await settle()
    await poll()
    text = renderer.collectText(tree).join(' ')
    check('the banner clears once access is healthy again', !/探测被 403 拒绝/.test(text), text.slice(0, 300))
    check('no request used GET with a body', requests.every((entry) => entry.method !== 'GET' || entry.body === null))
  }

  process.stdout.write(`\n— panel text —\n${renderer.collectText(tree).join(' ').replace(/\s+/g, ' ').slice(0, 600)}\n`)
  return finish()
}

function finish() {
  process.stdout.write(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}\n`)
  for (const failure of failures) process.stdout.write(`  · ${failure}\n`)
  // The panel polls with setInterval; exit rather than wait for the event loop.
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exit(1)
})
