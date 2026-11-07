/**
 * 远程协作 / Remote access — expose this machine's DSH Harness Web GUI to a
 * browser on another network.
 *
 * The plugin owns three things and nothing else:
 *   1. a tunnel child process pointing at this process's webserver port;
 *   2. the tunnel authority published into `connection.trustedHosts`, without
 *      which the Harness API rejects every request that arrives through it;
 *   3. a shareable link that carries this process's own launch token, so the
 *      remote browser can mint the session cookie it needs.
 */
import { createLogger } from './lib/util.js'
import { RemoteAccessService, normalizeConfig } from './lib/service.js'
import { createApiHandler, startControlServer } from './lib/http.js'
import { createMuxProxy, MUX_PROXY_PATH } from './lib/mux-proxy.js'

export const inject = ['webServer', 'connection']

const API_PREFIX = '/remote-access'

export function apply(ctx, rawConfig) {
  const bootstrap = createLogger(undefined, 'remote-access')
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    bootstrap.error(`invalid configuration: ${error?.message ?? error}`)
    return
  }

  const service = new RemoteAccessService({
    ctx,
    config,
    webServer: ctx.webServer,
    connection: ctx.connection,
    makeLogger: (ring) => createLogger(ring, 'remote-access')
  })
  const logger = service.logger

  if (!config.enabled) {
    logger.warn('remote-access is disabled (`enabled: false`); registering nothing')
    return
  }

  const apiHandler = createApiHandler({ service, connection: ctx.connection, logger, prefix: API_PREFIX })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler }),
    'remote-access: HTTP API'
  )

  // The conversation-history WebSocket crosses the tunnel uncompressed: the CDN
  // edge does not echo `Sec-WebSocket-Extensions`, so the gateway never
  // negotiates permessage-deflate and a switch pays for the whole window in
  // plain JSON. Route it through a sibling upgrade path that deflates large
  // downlink frames, and tell the client half where to find it.
  const muxProxy = installMuxProxy(ctx, service, config, logger)
  installClientConfig(ctx, config, logger, muxProxy !== null)

  const controlPromise = startControlServer({ service, remoteDir: service.remoteDir, logger }).catch((error) => {
    logger.warn(`control socket unavailable: ${error?.message ?? error}`)
    return null
  })
  ctx.effect(
    () => () => {
      void controlPromise.then((control) => control?.close()).catch(() => {})
    },
    'remote-access: control socket'
  )

  ctx.effect(
    () => () => {
      void Promise.resolve()
        .then(() => service.dispose())
        .catch((error) => console.error('[remote-access] dispose failed', error))
    },
    'remote-access: tunnel lifecycle'
  )

  void service
    .init()
    .then((status) => {
      if (status) logger.info(`state: ${status.state}${status.link ? ` · ${status.link}` : ''}`)
    })
    .catch((error) => logger.error(`startup failed: ${error?.message ?? error}`))
}

/**
 * Register `/remote-access/mux` and attach its counters to the service status.
 * Returns null when this DSH build has no upgrade-route API.
 */
function installMuxProxy(ctx, service, config, logger) {
  if (!config.muxCompression) return null
  const webServer = ctx.webServer
  if (typeof webServer?.registerUpgrade !== 'function') {
    logger.warn('webserver has no registerUpgrade(); mux compression disabled')
    return null
  }
  const proxy = createMuxProxy({ getOrigin: () => loopbackOrigin(webServer), logger, config })
  try {
    ctx.effect(
      () =>
        webServer.registerUpgrade({
          path: MUX_PROXY_PATH,
          handler: (req, socket, head) => {
            void proxy.handleUpgrade(req, socket, head)
          }
        }),
      'remote-access: mux proxy'
    )
  } catch (error) {
    logger.warn(`mux proxy route unavailable: ${error?.message ?? error}`)
    return null
  }
  ctx.effect(() => () => proxy.dispose(), 'remote-access: mux proxy lifecycle')
  service.muxProxy = proxy
  return proxy
}

/** The origin a loopback client should dial; 0.0.0.0/:: are not dial targets. */
function loopbackOrigin(webServer) {
  const origin = new URL(webServer.getOrigin())
  if (origin.hostname === '0.0.0.0' || origin.hostname === '::' || origin.hostname === '[::]') {
    origin.hostname = '127.0.0.1'
  }
  return origin.origin
}

/**
 * Publish the client-half configuration into the page. The client bundle loads
 * once per browser session, before any conversation is opened, and cannot see
 * Host config otherwise.
 */
function installClientConfig(ctx, config, logger, muxProxy) {
  const webServer = ctx.webServer
  if (typeof webServer?.tapIndex !== 'function') return
  const payload = JSON.stringify({
    muxProxy,
    initialWindowMessages: config.initialWindowMessages
  }).replaceAll('<', '\\u003c')
  const tag = `<script>window.__REMOTE_ACCESS__=${payload}</script>`
  try {
    ctx.effect(
      () => {
        const dispose = webServer.tapIndex((html) =>
          typeof html === 'string' ? html.replace('</head>', `${tag}</head>`) : html
        )
        return typeof dispose === 'function' ? dispose : () => {}
      },
      'remote-access: client config injection'
    )
  } catch (error) {
    logger.warn(`client config injection unavailable: ${error?.message ?? error}`)
  }
}
