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
