/**
 * RemoteAccess: one host-side service owning the tunnel, the API trust-fence
 * entry it needs, and the shareable browser link that carries this process's
 * launch token.
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import {
  RingLog,
  RotatingFileLog,
  authorityOf,
  locateHome,
  normalizeAuthority,
  nowIso,
  readJson,
  remoteAccessDir,
  randomToken,
  sleep,
  writeJsonAtomic,
  writeTextAtomic
} from './util.js'
import { FenceKeeper } from './fence.js'
import { PROVIDERS, TunnelSupervisor, resolveCloudflared } from './tunnel.js'

const TOKEN_PARAM = 'token'

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function num(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const provider = str(c.provider) || 'cloudflare-quick'
  if (!PROVIDERS[provider]) throw new Error(`remote-access: unknown provider "${provider}"`)
  const protocol = ['http2', 'quic', 'auto'].includes(str(c.protocol)) ? str(c.protocol) : 'http2'
  const keepAliveMs = Math.max(0, num(c.keepAliveMs, 65_000))
  const requestedProxyKeepAliveMs = num(c.proxyKeepAliveMs, keepAliveMs > 0 ? keepAliveMs - 5_000 : 0)
  const proxyKeepAliveMs = keepAliveMs > 0
    ? Math.max(1_000, Math.min(requestedProxyKeepAliveMs, Math.max(1_000, keepAliveMs - 1_000)))
    : 0
  // cloudflared keeps retrying a broken edge connection instead of exiting, so
  // the supervisor needs its own read on the public URL. `healthCheckMs: 0`
  // turns that watchdog off.
  const healthEvery = num(c.healthCheckMs, 15_000)
  const healthCheckMs = healthEvery <= 0 ? 0 : Math.max(5_000, healthEvery)
  return {
    enabled: c.enabled !== false,
    autoStart: c.autoStart === true,
    provider,
    protocol,
    cloudflaredPath: str(c.cloudflaredPath),
    hostname: str(c.hostname),
    publicUrl: str(c.publicUrl).replace(/\/+$/, ''),
    tunnelToken: str(c.tunnelToken),
    sshDestination: str(c.sshDestination),
    sshRemotePort: num(c.sshRemotePort, 0),
    command: Array.isArray(c.command) ? c.command.filter((a) => typeof a === 'string') : [],
    urlPattern: str(c.urlPattern),
    home: str(c.home),
    maxRestarts: Math.max(0, num(c.maxRestarts, 5)),
    startTimeoutMs: Math.max(5000, num(c.startTimeoutMs, 60_000)),
    extraTrustedHosts: (Array.isArray(c.extraTrustedHosts) ? c.extraTrustedHosts : [])
      .map((entry) => normalizeAuthority(entry))
      .filter(Boolean),
    logLines: Math.max(20, num(c.logLines, 200)),
    portWaitMs: Math.max(1000, num(c.portWaitMs, 60_000)),
    // cloudflared only prints connection-level events (edge registration,
    // reconnects) at `info`; `debug` adds the per-request chatter
    tunnelLogLevel: ['debug', 'info', 'warn', 'error', 'fatal'].includes(str(c.tunnelLogLevel))
      ? str(c.tunnelLogLevel)
      : 'info',
    tunnelLogFile: str(c.tunnelLogFile),
    tunnelLogBytes: Math.max(64_000, num(c.tunnelLogBytes, 1_000_000)),
    // Node closes an idle keep-alive connection after 5s. cloudflared pools
    // origin connections, so it can reuse one the origin just closed and the
    // request dies ("Unable to reach the origin service … EOF"). Advertise a
    // longer window instead; 0 leaves the server untouched.
    keepAliveMs,
    // cloudflared defaults to 90s, longer than the 65s origin keep-alive.
    // Close the proxy pool first so it cannot reuse an origin socket after
    // Node has retired it.
    proxyKeepAliveMs,
    // Ask the public URL, through the edge, whether the tunnel actually carries
    // traffic. Two dead edges in a row are normal on a WAN; `healthFailures` in
    // a row are not, and re-minting the tunnel beats waiting on a crashed edge.
    healthCheckMs,
    healthCheckTimeoutMs: Math.max(2_000, num(c.healthCheckTimeoutMs, 8_000)),
    healthDnsGraceMs: Math.max(0, num(c.healthDnsGraceMs, 120_000)),
    healthFailures: Math.max(1, Math.round(num(c.healthFailures, 3))),
    // Conversation switches travel as one giant JSON WebSocket frame. Through a
    // CDN edge that drops `Sec-WebSocket-Extensions` the gateway's
    // permessage-deflate never negotiates, so the frame crosses the tunnel
    // uncompressed. `/remote-access/mux` re-compresses it application-side.
    muxCompression: c.muxCompression !== false,
    muxCompressionLevel: Math.max(1, Math.min(9, Math.round(num(c.muxCompressionLevel, 4)))),
    muxCompressionThresholdBytes: Math.max(128, Math.min(1_048_576, Math.round(num(c.muxCompressionThresholdBytes, 1_024)))),
    muxHandshakeTimeoutMs: Math.max(1_000, Math.min(60_000, Math.round(num(c.muxHandshakeTimeoutMs, 8_000)))),
    // History windows replayed on a conversation switch carry every assistant
    // message's recorded streaming events even though the client renders the
    // collapsed message. Neutralising them removes roughly half of a real
    // window's JSON before it is compressed (lib/stream-strip.js).
    stripStreamingReplay: c.stripStreamingReplay !== false,
    // A history window deflates to a few hundred KB; splitting the payload into
    // bounded `DSHD1` chunks keeps one WebSocket frame from stalling the tunnel
    // and gives the client progress (lib/mux-chunk.js).
    muxChunkBytes: Math.max(16 * 1024, Math.min(1_048_576, Math.round(num(c.muxChunkBytes, 256 * 1024)))),
    // The client half memoises read-only startup RPCs (skills/commands/presets
    // and friends) so a conversation switch does not pay 5-6 extra round trips.
    // 0 disables the cache; the TTL is capped so external edits still show up.
    rpcCacheMs: Math.max(0, Math.min(300_000, Math.round(num(c.rpcCacheMs, 30_000)))),
    // Rounds of history asked for when a session opens. 0 keeps the upstream
    // default (500 counted messages / two turns). 60 trims about two thirds of
    // the bytes for long sessions; scrolling further up costs one more RTT each.
    initialWindowMessages: (() => {
      if (c.initialWindowMessages === undefined || c.initialWindowMessages === null) return 60
      const value = Math.round(num(c.initialWindowMessages, 0))
      if (value <= 0) return 0
      return Math.max(50, Math.min(500, value))
    })()
  }
}

export class RemoteAccessService {
  /**
   * @param {object} options
   * @param {object} options.ctx cordis context of the plugin
   * @param {object} options.webServer the Harness webserver service
   * @param {object} options.connection the Harness connection service
   * @param {Function} options.logger factory: createLogger(ring)
   */
  constructor({ ctx, webServer, connection, config, makeLogger }) {
    this.ctx = ctx
    this.webServer = webServer
    this.connection = connection
    this.config = config
    this.home = locateHome(ctx, config).home
    this.remoteDir = remoteAccessDir(this.home)
    this.stateFile = path.join(this.remoteDir, 'state.json')
    this.linkFile = path.join(this.remoteDir, 'link.txt')
    this.fileLog = new RotatingFileLog(
      config.tunnelLogFile ? path.resolve(config.tunnelLogFile) : path.join(this.remoteDir, 'tunnel.log'),
      config.tunnelLogBytes
    )
    // The ring holds the tail for the panel; every line it accepts also lands in
    // the file, so cloudflared's raw output and the plugin's own logging share
    // one durable timeline (the ring alone is capped and loses history).
    this.ring = new RingLog(config.logLines, this.fileLog)
    this.logger = makeLogger(this.ring)
    this.savedState = null
    this.link = null
    this.url = null
    this.controlToken = randomToken(24)
    this.supervisor = null
    // Diagnostic only: what a tokenless request from the tunnel authority gets
    // back. Never an error state, never latched — see probeAccess().
    this.access = { state: 'unknown', checkedAt: null }
    this.keepAlive = null
    this.disposed = false
    this.startPromise = null
    // Set by index.js once the webserver upgrade route is registered; status()
    // exposes its counters so a remote browser can prove frames were compressed.
    this.muxProxy = null
    this.applyServerTuning()
  }

  status() {
    const snap = this.supervisor?.snapshot() ?? { state: 'idle', url: null, attempts: 0, pid: null }
    return {
      plugin: 'dsh-remote-access',
      enabled: this.config.enabled,
      autoStart: this.config.autoStart,
      provider: this.config.provider,
      providerLabel: PROVIDERS[this.config.provider]?.label ?? this.config.provider,
      protocol: this.config.protocol,
      state: snap.state,
      tunnelUrl: snap.url,
      link: this.link,
      localLink: this.localLink(),
      linkParam: TOKEN_PARAM,
      authority: snap.url ? authorityOf(snap.url) : null,
      target: this.targetUrl(),
      attempts: snap.attempts,
      pid: snap.pid,
      startedAt: snap.startedAt,
      error: snap.error ?? null,
      health: snap.health ?? null,
      healthCheckMs: this.config.healthCheckMs,
      healthFailures: this.config.healthFailures,
      // Ordinary browsers reach this Host like any other client: the tunnel
      // authority must sit in `connection.trustedHosts` (this plugin publishes
      // it) and the request must carry this process's launch token (the share
      // link does). DSH Desktop 0.2.1-rc.3 removed the extra browser gate —
      // `webServer.setBrowserAccess()` and the `desktop-preferences.json →
      // browserAccess` switch it read no longer exist — so there is nothing
      // left to enable, and nothing to report as broken.
      access: {
        mode: 'token-link',
        state: this.access.state,
        checkedAt: this.access.checkedAt,
        // 'absent' = the Host has no browser-access switch at all
        gate: 'absent'
      },
      trustedHosts: this.fence?.entries ?? [],
      home: this.home,
      remoteDir: this.remoteDir,
      cloudflared: this.config.provider.startsWith('cloudflare') ? resolveCloudflared(this.config, this.remoteDir) : null,
      providers: Object.entries(PROVIDERS).map(([id, meta]) => ({ id, label: meta.label })),
      keepAliveMs: this.config.keepAliveMs,
      keepAlive: this.keepAlive,
      proxyKeepAliveMs: this.config.proxyKeepAliveMs,
      tunnelLogLevel: this.config.tunnelLogLevel,
      tunnelLogFile: this.fileLogPath(),
      muxCompression: this.config.muxCompression,
      stripStreamingReplay: this.config.stripStreamingReplay,
      muxChunkBytes: this.config.muxChunkBytes,
      rpcCacheMs: this.config.rpcCacheMs,
      mux: this.muxProxy?.stats() ?? null,
      initialWindowMessages: this.config.initialWindowMessages,
      logs: this.ring.list(80)
    }
  }

  /** Path of the durable tunnel log, or null when it was never configured. */
  fileLogPath() {
    return this.fileLog?.path ?? null
  }

  /**
   * Node closes an idle keep-alive connection after 5s (`Keep-Alive: timeout=5`)
   * while the tunnel edge pools origin connections for longer, so the edge keeps
   * reusing a socket the origin has just closed. Every such race surfaces as
   * `Unable to reach the origin service … EOF` / `context canceled` in the
   * tunnel log and as a lost request in the browser. Holding origin sockets open
   * past the edge's idle window removes the race. Tunes the live `node:http`
   * server behind the webserver service; `keepAliveMs: 0` disables the change.
   */
  applyServerTuning() {
    const wanted = this.config.keepAliveMs
    if (!wanted || wanted <= 0) {
      this.keepAlive = { applied: false, reason: 'disabled by keepAliveMs: 0' }
      return this.keepAlive
    }
    const server = this.webServer?.server
    if (!server || typeof server !== 'object') {
      this.keepAlive = { applied: false, reason: 'the webserver service exposes no server handle' }
      return this.keepAlive
    }
    try {
      const headers = Math.max(Number(server.headersTimeout) || 0, wanted + 5_000)
      server.keepAliveTimeout = wanted
      server.headersTimeout = headers
      this.keepAlive = { applied: true, keepAliveMs: wanted, headersTimeout: headers }
      this.logger.info(`origin keep-alive raised to ${wanted}ms (headersTimeout ${headers}ms)`)
    } catch (error) {
      this.keepAlive = { applied: false, reason: String(error?.message ?? error) }
      this.logger.warn(`origin keep-alive tuning failed: ${this.keepAlive.reason}`)
    }
    return this.keepAlive
  }

  targetUrl() {
    const port = this.webServer?.port
    return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null
  }

  /**
   * A share link for the loopback address, for `ssh -L` forwarding: the remote
   * machine tunnels a local port to this host and the request reaches the
   * webserver as `Host: 127.0.0.1:<port>`, which the API fence already trusts.
   */
  localLink() {
    const port = this.port()
    if (!port || typeof this.connection?.authenticatedUrl !== 'function') return null
    try {
      return this.connection.authenticatedUrl(`http://127.0.0.1:${port}/`)
    } catch {
      return null
    }
  }

  async waitForPort(timeoutMs = this.config.portWaitMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const port = this.port()
      if (port) return port
      if (Date.now() >= deadline) return null
      await sleep(400)
    }
  }

  port() {
    try {
      const port = this.webServer?.port
      return Number.isInteger(port) && port > 0 ? port : null
    } catch {
      return null
    }
  }

  /**
   * Ask the webserver, WITHOUT a token, what an ordinary browser would get.
   * Pure diagnostics: it tells the panel whether the fence is doing its job
   * (`token-required` is the healthy answer), and whether the tunnel authority
   * is really trusted (`refused` means it is not, so the share link would be
   * rejected too). A probe never writes an error into the status.
   */
  async probeAccess() {
    const port = this.port()
    if (!port) {
      this.access = { state: 'unknown', checkedAt: nowIso() }
      return this.access.state
    }
    let state = 'unknown'
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'sec-fetch-site': 'same-origin', accept: 'text/html' }
      })
      // 401 = trusted but unauthenticated: exactly what a tokenless browser
      // request should get, and what the share link's token lifts.
      if (response.status === 401) state = 'token-required'
      else if (response.status === 200 || response.status === 303) state = 'open'
      else if (response.status === 403) state = 'refused'
      await response.text().catch(() => '')
    } catch (error) {
      this.logger.debug(`access probe failed: ${error?.message ?? error}`)
    }
    this.access = { state, checkedAt: nowIso() }
    if (state === 'refused') {
      this.logger.warn(
        'the webserver refuses even a trusted-Host request without a token; check connection.trustedHosts before sharing the link'
      )
    }
    return state
  }

  /**
   * Formerly flipped DSH Desktop's ordinary-browser gate in memory.
   *
   * DSH Desktop 0.2.1-rc.3 removed that gate: `webServer.setBrowserAccess()`,
   * the `desktop-preferences.json → browserAccess` preference and the settings
   * page that wrote it are all gone. What decides access now is the API trust
   * fence (`connection.trustedHosts` + launch token), which this plugin already
   * satisfies for the tunnel authority and which the share link already carries.
   *
   * So there is nothing left to switch. Report that honestly — the caller gets
   * `unsupported: true` and an explanation instead of a fake success, and no
   * error is latched into `status()`, because a missing switch is not a fault
   * of this Host. `enabled` is accepted only so an older panel/CLI keeps
   * working.
   */
  async setBrowserAccess(_enabled) {
    await this.probeAccess()
    return {
      ...this.status(),
      unsupported: true,
      reason: 'this Host has no browser-access switch (removed in DSH Desktop 0.2.1-rc.3); the share link already opens in any browser'
    }
  }

  async init() {
    this.publishTrustedHosts()
    this.savedState = await readJson(this.stateFile, null)
    const wasStopped = this.savedState?.desired === 'stopped'
    this.logger.info(`state dir ${this.remoteDir}`)
    if (!this.config.enabled) {
      this.logger.warn('plugin disabled by config (`enabled: false`); no tunnel will start')
      return
    }
    if (this.config.autoStart && !wasStopped) {
      this.logger.info('autostart is on; starting the tunnel once the webserver is listening')
      void this.start().catch((error) => this.logger.error(`autostart failed: ${error?.message ?? error}`))
    } else if (wasStopped) {
      this.logger.info('the tunnel was stopped from the panel last time; leaving it off')
    }
  }

  publishTrustedHosts() {
    if (!this.fence) this.fence = new FenceKeeper(this.connection, this.logger)
    for (const entry of this.config.extraTrustedHosts) this.fence.add(entry)
    const named = normalizeAuthority(this.config.hostname)
    if (named) this.fence.add(named)
  }

  async start() {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.#start()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async #start() {
    if (!this.config.enabled) throw new Error('remote-access is disabled by config (`enabled: false`)')
    const port = await this.waitForPort()
    if (!port) throw new Error('the Harness webserver never reported a listening port')
    this.target = `http://127.0.0.1:${port}`
    // the live node:http handle only exists once a port is listening
    this.applyServerTuning()
    if (!this.supervisor) {
      this.supervisor = new TunnelSupervisor({
        config: this.config,
        target: this.target,
        remoteDir: this.remoteDir,
        logger: this.logger,
        ring: this.ring,
        onState: (snap) => void this.#onTunnelState(snap)
      })
    } else {
      this.supervisor.target = this.target
    }
    const snap = await this.supervisor.start()
    if (snap.state === 'failed') throw new Error(snap.error ?? 'tunnel failed to start')
    await this.probeAccess()
    return this.status()
  }

  async stop() {
    if (!this.supervisor) {
      await this.#persist({ desired: 'stopped' })
      return this.status()
    }
    const snap = await this.supervisor.stop()
    this.url = null
    this.link = null
    await this.fence?.clear()
    this.publishTrustedHosts()
    await rm(this.linkFile, { force: true })
    await this.#persist({ desired: 'stopped', url: null, state: snap.state })
    return this.status()
  }

  async restart() {
    if (!this.supervisor) return this.start()
    await this.stop()
    await sleep(400)
    return this.start()
  }

  async #onTunnelState(snap) {
    const previous = this.url
    this.url = snap.url ?? null
    if (snap.state === 'ready' && snap.url) {
      const authority = authorityOf(snap.url)
      if (previous && previous !== snap.url) this.fence?.remove(authorityOf(previous))
      this.fence?.add(authority)
      this.publishTrustedHosts()
      this.link = this.#shareLink(snap.url)
      await writeTextAtomic(this.linkFile, `${this.link}\n`, 0o600).catch((error) =>
        this.logger.warn(`cannot write link file: ${error?.message ?? error}`)
      )
      this.logger.info(`remote access ready: ${this.link}`)
    } else if (snap.state !== 'ready' && previous) {
      this.fence?.remove(authorityOf(previous))
      this.publishTrustedHosts()
      this.link = null
      await rm(this.linkFile, { force: true }).catch(() => {})
    }
    await this.#persist({ desired: snap.state === 'idle' ? 'stopped' : 'running', ...snap })
  }

  /** The launch token is this process's own credential; the tunnel authority rides along. */
  #shareLink(tunnelUrl) {
    try {
      const base = `${String(tunnelUrl).replace(/\/+$/, '')}/`
      const link = this.connection?.authenticatedUrl?.(base)
      return link ?? base
    } catch (error) {
      this.logger.warn(`cannot mint the share link: ${error?.message ?? error}`)
      return String(tunnelUrl)
    }
  }

  async #persist(patch) {
    this.savedState = { ...(this.savedState ?? {}), ...patch, updatedAt: nowIso() }
    await writeJsonAtomic(this.stateFile, this.savedState, 0o600).catch((error) =>
      this.logger.warn(`cannot write state file: ${error?.message ?? error}`)
    )
  }

  async dispose() {
    this.disposed = true
    try {
      await this.supervisor?.dispose()
    } catch (error) {
      this.logger.warn(`dispose failed: ${error?.message ?? error}`)
    }
    this.fence?.clear()
    this.publishTrustedHosts()
    await this.#persist({ desired: 'stopped' }).catch(() => {})
  }
}
