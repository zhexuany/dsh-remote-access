/**
 * Two HTTP faces onto one service:
 *
 *  - `createApiHandler` serves `/remote-access/*` on the Harness webserver so
 *    the in-app panel (local or remote browser) can drive it. Every request
 *    passes the Harness connection fence, so an unauthenticated visitor over
 *    the tunnel gets 401 instead of control.
 *  - `startControlServer` serves the same actions on a loopback-only socket
 *    with a per-process token, for the bundled CLI.
 */
import { createServer } from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { randomToken, writeJsonAtomic } from './util.js'

const MAX_BODY = 64 * 1024

export function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {}
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Coerce the body/query form of a boolean flag. */
function asBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !/^(0|false|no|off)$/i.test(String(value).trim())
}

/** Run one action against the service; shared by both HTTP faces. */
export async function dispatch(service, action, body = {}) {
  switch (action) {
    case 'status':
      await service.probeAccess()
      return service.status()
    case 'start':
      return service.start()
    case 'stop':
      return service.stop()
    case 'restart':
      return service.restart()
    case 'browser-access':
      // Kept so an older panel/CLI does not break, but the Host has no such
      // switch any more: the service answers with `unsupported: true` plus the
      // reason, and never with a latched error. `asBoolean` is still applied so
      // `on/off/true/false` keep normalising the same way.
      return service.setBrowserAccess(asBoolean(body?.enabled ?? body?.browserAccess, true))
    case 'link': {
      const status = service.status()
      return {
        link: status.link,
        localLink: status.localLink,
        state: status.state,
        tunnelUrl: status.tunnelUrl,
        access: status.access
      }
    }
    case 'logs': {
      const status = service.status()
      return { state: status.state, tunnelUrl: status.tunnelUrl, logs: status.logs ?? [] }
    }
    default:
      return { error: `unknown action "${action}"` }
  }
}

const ACTIONS = new Set(['status', 'start', 'stop', 'restart', 'link', 'logs', 'browser-access'])

export function createApiHandler({ service, connection, logger, prefix = '/remote-access' }) {
  return async function handle(request, response) {
    let url
    try {
      url = new URL(request.url ?? '/', 'http://dsh.invalid')
    } catch {
      sendJson(response, 400, { error: 'bad request url' })
      return
    }
    const action = url.pathname.slice(prefix.length).replace(/^\/+/, '').replace(/\/+$/, '') || 'status'
    if (!ACTIONS.has(action)) {
      sendJson(response, 404, { error: `unknown remote-access route "/${action}"` })
      return
    }
    if (!['GET', 'POST'].includes(request.method ?? 'GET')) {
      sendJson(response, 405, { error: 'method not allowed' })
      return
    }
    if (typeof connection?.requestRejection === 'function') {
      const rejection = connection.requestRejection(request)
      if (rejection !== undefined) {
        sendJson(response, rejection, { error: rejection === 401 ? 'authentication required' : 'host not trusted' })
        return
      }
    }
    try {
      const body = await readBody(request)
      const query = Object.fromEntries(url.searchParams.entries())
      const payload = await dispatch(service, action, { ...query, ...body })
      if (payload?.error && !payload.state) {
        sendJson(response, 409, payload)
        return
      }
      sendJson(response, 200, payload)
    } catch (error) {
      logger?.error(`remote-access ${action} failed: ${error?.message ?? error}`)
      sendJson(response, 500, { error: String(error?.message ?? error) })
    }
  }
}

/**
 * Loopback control socket for the CLI. The token is written next to the plugin
 * state (`control.json`, mode 0600) so the CLI can read it without arguments.
 */
export async function startControlServer({ service, remoteDir, logger, port = 0 }) {
  const token = randomToken(24)
  const server = createServer((request, response) => {
    const remote = request.socket.remoteAddress ?? ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!loopback) {
      sendJson(response, 403, { error: 'loopback only' })
      return
    }
    void (async () => {
      let url
      try {
        url = new URL(request.url ?? '/', 'http://127.0.0.1')
      } catch {
        sendJson(response, 400, { error: 'bad request url' })
        return
      }
      const provided = request.headers['x-remote-access-token'] ?? url.searchParams.get('token')
      if (provided !== token) {
        sendJson(response, 401, { error: 'control token required' })
        return
      }
      const action = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '') || 'status'
      if (!ACTIONS.has(action)) {
        sendJson(response, 404, { error: `unknown action "${action}"` })
        return
      }
      try {
        const body = await readBody(request)
        const query = Object.fromEntries(url.searchParams.entries())
        const payload = await dispatch(service, action, { ...query, ...body })
        sendJson(response, 200, payload)
      } catch (error) {
        logger?.error(`control ${action} failed: ${error?.message ?? error}`)
        sendJson(response, 500, { error: String(error?.message ?? error) })
      }
    })()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port }, resolve)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  await writeJsonAtomic(
    path.join(remoteDir, 'control.json'),
    { port: actualPort, token, pid: process.pid, startedAt: new Date().toISOString() },
    0o600
  )
  logger?.info(`control socket on http://127.0.0.1:${actualPort}`)
  return {
    port: actualPort,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/** Read the control socket credentials a previous host process wrote. */
export async function readControlCredentials(remoteDir) {
  try {
    const raw = await readFile(path.join(remoteDir, 'control.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed?.port || !parsed?.token) return null
    return { port: parsed.port, token: parsed.token, pid: parsed.pid }
  } catch {
    return null
  }
}
