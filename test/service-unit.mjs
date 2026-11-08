/**
 * Host-side unit test for what the panel and CLI drive without any Host
 * process, tunnel, or network: the loopback link (`ssh -L` route), the
 * access probe that replaced the browser-access switch, and the fact that the
 * retired switch is an honest no-op rather than an error.
 *
 * Run:  test/run-tests.sh            (or)
 *       ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/DSH NEXT" test/service-unit.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { dispatch } from '../lib/http.js'
import { isDnsResolutionError, isHealthyTunnelStatus, planTunnel } from '../lib/tunnel.js'
import { RemoteAccessService, normalizeConfig } from '../lib/service.js'
import { createLogger, locateHome } from '../lib/util.js'

const failures = []
const results = []

function check(name, condition, detail) {
  results.push([name, Boolean(condition)])
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** `status().logs` is a list of `{at, text}` records. */
function logText(logs) {
  return (logs ?? []).map((line) => (typeof line === 'string' ? line : line?.text ?? '')).join('\n')
}

/** @returns {RemoteAccessService} */
function buildService({ port = 18790, withSwitch = true, withServer = true, home, config: overrides = {} }) {
  const switched = []
  const webServer = { port }
  if (withSwitch) {
    webServer.setBrowserAccess = (enabled) => {
      switched.push(enabled)
    }
  }
  // Node's own defaults: an idle origin socket dies after 5s, long before a
  // tunnel edge gives up on the pooled connection it is reusing.
  if (withServer) webServer.server = { keepAliveTimeout: 5000, headersTimeout: 60000 }
  const connection = {
    trustedHosts: [],
    authenticatedUrl: (base) => `${base}${base.includes('?') ? '&' : '?'}token=FIXEDTOKEN`
  }
  const config = normalizeConfig({ home, autoStart: false, ...overrides })
  const service = new RemoteAccessService({
    ctx: {},
    webServer,
    connection,
    config,
    makeLogger: (ring) => createLogger(ring, 'test')
  })
  return { service, switched, webServer, connection, config }
}

/** Serve a canned tokenless answer, the way the real fence would. */
function stubProbe(mode) {
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    if (mode === 'token-required') return { status: 401, async text() { return 'unauthorised' } }
    if (mode === 'open') return { status: 200, async text() { return '<html></html>' } }
    if (mode === 'refused') return { status: 403, async text() { return 'forbidden' } }
    throw new Error(`probe offline (${mode})`)
  }
  return () => {
    globalThis.fetch = real
  }
}

async function main() {
  const home = await mkdtemp(path.join(tmpdir(), 'remote-access-unit-'))
  const restore = stubProbe('token-required')

  try {
    /* 0 — a source checkout symlinked into a profile must not make the user's
       home directory the Harness home (official Desktop does not set DSH_HOME). */
    const savedDshHome = process.env.DSH_HOME
    const savedNextHome = process.env.DSH_NEXT_HOME
    delete process.env.DSH_HOME
    delete process.env.DSH_NEXT_HOME
    const located = locateHome({}, {})
    if (savedDshHome !== undefined) process.env.DSH_HOME = savedDshHome
    if (savedNextHome !== undefined) process.env.DSH_NEXT_HOME = savedNextHome
    check('locateHome falls back to ~/.dsh outside a profile manifest', located.home === path.join(homedir(), '.dsh'), located.home)
    check('autoStart defaults to false', normalizeConfig({}).autoStart === false, String(normalizeConfig({}).autoStart))
    check('autoStart true is honored', normalizeConfig({ autoStart: true }).autoStart === true, String(normalizeConfig({ autoStart: true }).autoStart))
    const healthDefaults = normalizeConfig({})
    check('the tunnel watchdog is on by default', healthDefaults.healthCheckMs === 15_000, String(healthDefaults.healthCheckMs))
    check('the watchdog waits for three failed checks', healthDefaults.healthFailures === 3, String(healthDefaults.healthFailures))
    check('the watchdog has a timeout', healthDefaults.healthCheckTimeoutMs === 8_000, String(healthDefaults.healthCheckTimeoutMs))
    check(
      'DNS lag after a fresh quick tunnel is not treated as a dead URL',
      healthDefaults.healthDnsGraceMs === 120_000 && normalizeConfig({ healthDnsGraceMs: 0 }).healthDnsGraceMs === 0,
      String(healthDefaults.healthDnsGraceMs)
    )
    check('healthCheckMs: 0 turns the watchdog off', normalizeConfig({ healthCheckMs: 0 }).healthCheckMs === 0, String(normalizeConfig({ healthCheckMs: 0 }).healthCheckMs))
    check('the watchdog interval has a floor', normalizeConfig({ healthCheckMs: 1000 }).healthCheckMs === 5_000, String(normalizeConfig({ healthCheckMs: 1000 }).healthCheckMs))
    const muxDefaults = normalizeConfig({})
    check('mux compression is on by default', muxDefaults.muxCompression === true)
    check('mux compression level defaults to 4', muxDefaults.muxCompressionLevel === 4, String(muxDefaults.muxCompressionLevel))
    check('frames below 1KB stay uncompressed', muxDefaults.muxCompressionThresholdBytes === 1_024)
    check('mux compression can be disabled', normalizeConfig({ muxCompression: false }).muxCompression === false)
    check('compression level is clamped to 1..9', normalizeConfig({ muxCompressionLevel: 99 }).muxCompressionLevel === 9)
    check('the initial window defaults to 60 messages', muxDefaults.initialWindowMessages === 60, String(muxDefaults.initialWindowMessages))
    check('initialWindowMessages: 0 keeps the upstream window', normalizeConfig({ initialWindowMessages: 0 }).initialWindowMessages === 0)
    check('the initial window never drops below 50', normalizeConfig({ initialWindowMessages: 10 }).initialWindowMessages === 50)
    check('the replay stream strip is on by default', muxDefaults.stripStreamingReplay === true)
    check('the downlink chunk defaults to 256 KiB', muxDefaults.muxChunkBytes === 262_144, String(muxDefaults.muxChunkBytes))
    check('muxChunkBytes is clamped to 16 KiB..1 MiB', normalizeConfig({ muxChunkBytes: 1 }).muxChunkBytes === 16_384 && normalizeConfig({ muxChunkBytes: 9_000_000 }).muxChunkBytes === 1_048_576)
    check('the RPC cache defaults to 30s', muxDefaults.rpcCacheMs === 30_000, String(muxDefaults.rpcCacheMs))
    check('rpcCacheMs: 0 disables the client RPC cache', normalizeConfig({ rpcCacheMs: 0 }).rpcCacheMs === 0)
    check('the remote directory picker is on by default', muxDefaults.remoteDirectoryPicker === true)
    check('the remote directory picker can be disabled', normalizeConfig({ remoteDirectoryPicker: false }).remoteDirectoryPicker === false)
    check(
      'a Host answer counts as a healthy probe',
      [200, 303, 401, 403].every((code) => isHealthyTunnelStatus(code)),
      'host statuses'
    )
    check(
      'a resolution failure is recognised',
      isDnsResolutionError({ cause: { code: 'ENOTFOUND' } }) &&
        isDnsResolutionError(Object.assign(new Error('fetch failed'), { code: 'EAI_AGAIN' })) &&
        !isDnsResolutionError(new Error('fetch failed')) &&
        !isDnsResolutionError(null),
      'dns codes'
    )
    check(
      'an edge failure is never a healthy probe',
      ![0, 500, 502, 503, 530, 1033].some((code) => isHealthyTunnelStatus(code)),
      'edge statuses'
    )

    /* 1 — status carries a loopback link minted for the ssh -L route */
    const primary = buildService({ home })
    let status = primary.service.status()
    check('status exposes a localLink for the loopback port', status.localLink === 'http://127.0.0.1:18790/?token=FIXEDTOKEN', String(status.localLink))
    check(
      'status reports the Host has no browser gate',
      status.access?.gate === 'absent' && status.access?.mode === 'token-link',
      JSON.stringify(status.access)
    )
    check('target is the loopback origin', status.target === 'http://127.0.0.1:18790', String(status.target))
    check(
      'status discloses the watchdog and its last result',
      status.health === null && status.healthCheckMs === 15_000 && status.healthFailures === 3,
      JSON.stringify({ health: status.health, healthCheckMs: status.healthCheckMs, healthFailures: status.healthFailures })
    )
    check('no trusted hosts before publish', status.trustedHosts.length === 0, JSON.stringify(status.trustedHosts))
    const runtimeTrust = buildService({ home })
    runtimeTrust.service.publishTrustedHosts()
    check('configured trusted hosts reach the connection fence', runtimeTrust.connection.trustedHosts.length === 0, JSON.stringify(runtimeTrust.connection.trustedHosts))
    runtimeTrust.service.fence.add('collecting-vii-reg-closely.trycloudflare.com')
    runtimeTrust.service.publishTrustedHosts()
    check('tunnel trusted host reaches the connection fence', runtimeTrust.connection.trustedHosts.includes('collecting-vii-reg-closely.trycloudflare.com'), JSON.stringify(runtimeTrust.connection.trustedHosts))
    runtimeTrust.service.fence.remove('collecting-vii-reg-closely.trycloudflare.com')
    runtimeTrust.service.publishTrustedHosts()
    check('removed tunnel host leaves the connection fence', !runtimeTrust.connection.trustedHosts.includes('collecting-vii-reg-closely.trycloudflare.com'), JSON.stringify(runtimeTrust.connection.trustedHosts))
 
     /* 2 — no port ⇒ no link, no probe guess */
    const portless = buildService({ port: 0, home })
    check('a host without a listening port has no localLink', portless.service.localLink() === null, String(portless.service.localLink()))
    check('a portless probe reports unknown', (await portless.service.probeAccess()) === 'unknown', portless.service.access.state)

    /* 3 — the probe classifies what a tokenless browser would get */
    const classifications = []
    for (const mode of ['token-required', 'open', 'refused', 'offline']) {
      const scoped = buildService({ home })
      const release = stubProbe(mode)
      classifications.push([mode, await scoped.service.probeAccess()])
      release()
    }
    check(
      'probe maps 401/200/403/offline to token-required/open/refused/unknown',
      classifications.every(([expected, actual]) => expected === actual || (expected === 'offline' && actual === 'unknown')),
      JSON.stringify(classifications)
    )

    // a healthy fence answers 401: authority trusted, launch token not yet presented
    const healthy = buildService({ home })
    const releaseHealthy = stubProbe('token-required')
    await healthy.service.probeAccess()
    releaseHealthy()
    const healthyStatus = healthy.service.status()
    check('a 401 probe is recorded as token-required', healthyStatus.access.state === 'token-required', JSON.stringify(healthyStatus.access))
    check('a probe stamps when it ran', typeof healthyStatus.access.checkedAt === 'string', JSON.stringify(healthyStatus.access))

    const refusedHost = buildService({ home })
    const releaseRefused = stubProbe('refused')
    await refusedHost.service.probeAccess()
    releaseRefused()
    const refusedStatus = refusedHost.service.status()
    check('a refused probe is recorded, not raised', refusedStatus.access.state === 'refused', JSON.stringify(refusedStatus.access))
    check('a refused probe never becomes status.error', refusedStatus.error === null, String(refusedStatus.error))
    check(
      'a refused probe is disclosed in the log',
      /refuses even a trusted-Host request/.test(logText(refusedStatus.logs)),
      JSON.stringify(refusedStatus.logs.slice(-2))
    )

    /* 4 — the retired switch is an honest no-op, never an error */
    const retired = await primary.service.setBrowserAccess(true)
    check('setBrowserAccess reports unsupported', retired.unsupported === true, String(retired.unsupported))
    check('setBrowserAccess explains itself', /removed in DSH Desktop 0\.2\.1-rc\.3/.test(String(retired.reason)), String(retired.reason))
    check('the retired switch never calls webServer.setBrowserAccess', primary.switched.length === 0, JSON.stringify(primary.switched))
    check('the retired switch latches no error', retired.error === null, String(retired.error))
    check('the retired switch changes no gate state', retired.access.gate === 'absent', JSON.stringify(retired.access))

    /* 5 — a host that never had the method answers identically */
    const unsupported = buildService({ home, withSwitch: false })
    const unsupportedStatus = await unsupported.service.setBrowserAccess(true)
    check(
      'a host without the switch is not an error either',
      unsupportedStatus.error === null && unsupportedStatus.unsupported === true,
      JSON.stringify({ error: unsupportedStatus.error, unsupported: unsupportedStatus.unsupported })
    )

    /* 6 — dispatch: the action surface shared by the API route and the CLI */
    const releaseDispatch = stubProbe('refused')
    const offAction = await dispatch(primary.service, 'browser-access', { enabled: 'off' })
    const onAction = await dispatch(primary.service, 'browser-access', { enabled: 'on' })
    check(
      'dispatch keeps answering the old action without an error',
      offAction.error === null && onAction.error === null,
      JSON.stringify({ off: offAction.error, on: onAction.error })
    )
    check(
      'dispatch still normalises on/off and reports unsupported',
      offAction.unsupported === true && onAction.unsupported === true,
      JSON.stringify({ off: offAction.unsupported, on: onAction.unsupported })
    )
    check('dispatch never reaches the retired webserver method', primary.switched.length === 0, JSON.stringify(primary.switched))
    const linkAction = await dispatch(primary.service, 'link', {})
    check('the link action carries the loopback link', linkAction.localLink === 'http://127.0.0.1:18790/?token=FIXEDTOKEN', JSON.stringify(linkAction))
    check('the link action carries the access report', linkAction.access?.gate === 'absent', JSON.stringify(linkAction.access))
    const statusAction = await dispatch(primary.service, 'status', {})
    releaseDispatch()
    check('the status action probes access', statusAction.access?.state === 'refused', JSON.stringify(statusAction.access))
    check('the status action surfaces no error', statusAction.error === null, String(statusAction.error))
    const logsAction = await dispatch(primary.service, 'logs', {})
    check('the logs action returns the ring lines', Array.isArray(logsAction.logs) && logsAction.logs.length > 0, String(logsAction.logs?.length))
    const unknown = await dispatch(primary.service, 'nope', {})
    check('an unknown action is refused by name', unknown.error === 'unknown action "nope"', JSON.stringify(unknown))

    /* 8 — origin keep-alive: the tunnel edge must not reuse a socket we closed */
    const tuned = buildService({ home })
    const tuning = tuned.service.status().keepAlive
    check('keep-alive tuning reports applied', tuning?.applied === true, JSON.stringify(tuning))
    check('keepAliveTimeout follows keepAliveMs', tuned.webServer.server.keepAliveTimeout === 65_000, String(tuned.webServer.server.keepAliveTimeout))
    check('headersTimeout is raised above keepAliveTimeout', tuned.webServer.server.headersTimeout === 70_000, String(tuned.webServer.server.headersTimeout))
    check('the tuning is disclosed in the log', /origin keep-alive raised to 65000ms/.test(logText(tuned.service.status().logs)), JSON.stringify(tuned.service.status().logs.slice(-2)))

    const custom = buildService({ home, config: { keepAliveMs: 30_000 } })
    check('a custom keepAliveMs is honoured', custom.webServer.server.keepAliveTimeout === 30_000 && custom.webServer.server.headersTimeout === 60_000, `${custom.webServer.server.keepAliveTimeout}/${custom.webServer.server.headersTimeout}`)

    const keepAliveOff = buildService({ home, config: { keepAliveMs: 0 } })
    check('keepAliveMs: 0 leaves the server alone', keepAliveOff.webServer.server.keepAliveTimeout === 5000 && keepAliveOff.service.status().keepAlive.applied === false, JSON.stringify(keepAliveOff.service.status().keepAlive))

    const headless = buildService({ home, withServer: false })
    check('a host without a server handle reports why', headless.service.status().keepAlive.applied === false && /no server handle/.test(String(headless.service.status().keepAlive.reason)), JSON.stringify(headless.service.status().keepAlive))

    /* 9 — one durable log file for plugin lines and raw tunnel output */
    const logFile = String(tuned.service.status().tunnelLogFile)
    check('status names the tunnel log', /remote-access[\\/]tunnel\.log$/.test(logFile), logFile)
    check('status names the tunnel log level', tuned.service.status().tunnelLogLevel === 'info', String(tuned.service.status().tunnelLogLevel))
    tuned.service.ring.push('INF Registered tunnel connection connIndex=0 protocol=http2')
    const tunnelLog = await readFile(logFile, 'utf8')
    check('raw tunnel output reaches the file', /INF Registered tunnel connection/.test(tunnelLog), tunnelLog.slice(-200))
    check('plugin log lines reach the same file', /origin keep-alive raised to 65000ms/.test(tunnelLog), tunnelLog.slice(-200))
    /* 10 — the proxy pool must retire before the origin socket */
    const planned = planTunnel(normalizeConfig({ home, provider: 'cloudflare-quick' }), 'http://127.0.0.1:18790', home)
    check('cloudflared proxy keepalive is shorter than origin keepalive', planned.args.includes('--proxy-keepalive-timeout') && planned.args.includes('60s'), JSON.stringify(planned.args))
  } finally {
    restore()
    await rm(home, { recursive: true, force: true })
  }

  for (const [name, ok] of results) process.stdout.write(`${ok ? '✓' : '✗'} ${name}\n`)
  process.stdout.write(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}\n`)
  for (const failure of failures) process.stdout.write(`  · ${failure}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exit(1)
})
