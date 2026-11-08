/**
 * Tunnel supervision: one child process producing one public URL.
 *
 * Providers are described declaratively so a user can add their own command
 * (`provider: command`) without touching this file's logic.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACKAGE_ROOT, sleep } from './util.js'

const QUICK_URL = /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com/i
const ANY_URL = /https?:\/\/[a-z0-9][^\s"'<>]*/i

export const PROVIDERS = {
  'cloudflare-quick': {
    label: 'Cloudflare 快速隧道（免登录，随机域名，每次重启都会变）',
    needsCloudflared: true
  },
  'cloudflare-named': {
    label: 'Cloudflare 命名隧道（需 tunnel token + 固定域名）',
    needsCloudflared: true
  },
  ssh: {
    label: 'SSH 反向隧道（需一台公网服务器）',
    needsCloudflared: false
  },
  command: {
    label: '自定义命令（任何能输出公网 URL 的隧道工具）',
    needsCloudflared: false
  }
}

export function vendorCloudflaredPath() {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return path.join(PACKAGE_ROOT, 'vendor', `cloudflared-${platform}-${arch}`)
}

function executable(p) {
  if (typeof p !== 'string' || !p) return false
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveCloudflared(config, remoteDir) {
  const candidates = [
    config.cloudflaredPath,
    path.join(remoteDir, 'bin', 'cloudflared'),
    vendorCloudflaredPath(),
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared'
  ]
  for (const candidate of candidates) {
    if (executable(candidate)) return candidate
  }
  return 'cloudflared'
}

/** cloudflared edge addressing: `auto` keeps the binary default, `4`/`6` pin it. */
function edgeIpVersion(config) {
  const value = String(config?.edgeIpVersion ?? 'auto').trim()
  return ['4', '6', 'auto'].includes(value) ? value : 'auto'
}

/** Retries for connection/protocol errors before cloudflared gives up a stream. */
function retries(config) {
  const raw = config?.tunnelRetries
  const value = Number(raw === '' || raw === null ? 5 : (raw ?? 5))
  return Number.isFinite(value) ? Math.max(1, Math.min(20, Math.round(value))) : 5
}

/** cloudflared log level; `info` is where edge registration and reconnects show. */
function logLevel(config) {
  const level = String(config?.tunnelLogLevel || 'info')
  return ['debug', 'info', 'warn', 'error', 'fatal'].includes(level) ? level : 'info'
}

/** Build the spawn plan for one provider. Throws on unusable configuration. */
export function planTunnel(config, target, remoteDir) {
  const provider = String(config.provider || 'cloudflare-quick')
  if (!PROVIDERS[provider]) {
    throw new Error(`unknown provider "${provider}" (use ${Object.keys(PROVIDERS).join(', ')})`)
  }
  const protocol = String(config.protocol || 'http2')
  const head = (command) => ({ provider, command, args: [], env: {}, detect: () => null, publicUrl: null })

  if (provider === 'cloudflare-quick') {
    const plan = head(resolveCloudflared(config, remoteDir))
    plan.args = [
      'tunnel',
      '--no-autoupdate',
      '--protocol',
      protocol,
      '--loglevel',
      logLevel(config),
      '--url',
      target
    ]
    if (config.proxyKeepAliveMs > 0) {
      plan.args.splice(-2, 0, '--proxy-keepalive-timeout', `${Math.round(config.proxyKeepAliveMs / 1000)}s`)
    }
    if (edgeIpVersion(config) !== 'auto') plan.args.push('--edge-ip-version', edgeIpVersion(config))
    plan.args.push('--retries', String(retries(config)))
    plan.detect = (line) => {
      const match = line.match(QUICK_URL)
      return match ? match[0] : null
    }
    return plan
  }

  if (provider === 'cloudflare-named') {
    if (!config.tunnelToken) throw new Error('provider cloudflare-named needs `tunnelToken`')
    const plan = head(resolveCloudflared(config, remoteDir))
    // `--edge-ip-version` / `--retries` belong to the `tunnel` command, not to
    // `tunnel run` (cobra only inherits persistent flags), so they must sit
    // before the `run` subcommand: `cloudflared tunnel [options] run --token`.
    plan.args = [
      'tunnel',
      '--no-autoupdate',
      '--protocol',
      protocol,
      '--loglevel',
      logLevel(config),
      ...(edgeIpVersion(config) === 'auto' ? [] : ['--edge-ip-version', edgeIpVersion(config)]),
      '--retries',
      String(retries(config)),
      'run',
      '--token',
      String(config.tunnelToken)
    ]
    if (config.hostname) plan.args.push('--url', target)
    plan.publicUrl = config.publicUrl || (config.hostname ? `https://${config.hostname}` : null)
    plan.detect = (line) => {
      if (plan.publicUrl) return null
      const match = line.match(ANY_URL)
      return match ? match[0].replace(/\/+$/, '') : null
    }
    return plan
  }

  if (provider === 'ssh') {
    if (!config.sshDestination) throw new Error('provider ssh needs `sshDestination` (user@host)')
    const plan = head('ssh')
    const remotePort = Number(config.sshRemotePort) > 0 ? String(config.sshRemotePort) : '0'
    const localHost = new URL(target).hostname
    const localPort = new URL(target).port
    plan.args = [
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'BatchMode=yes',
      '-N',
      '-R', `${remotePort}:${localHost}:${localPort}`,
      String(config.sshDestination)
    ]
    plan.publicUrl = config.publicUrl || (config.hostname ? `https://${config.hostname}` : null)
    plan.detect = (line) => {
      // ssh prints "Allocated port 41234 for remote forward to 127.0.0.1:8000"
      const match = line.match(/Allocated port (\d+) for remote forward/i)
      if (match && !plan.publicUrl && config.hostname) {
        plan.publicUrl = `http://${config.hostname}:${match[1]}`
      }
      return null
    }
    return plan
  }

  // provider === 'command'
  const argv = Array.isArray(config.command) ? config.command.filter((a) => typeof a === 'string' && a) : []
  if (argv.length === 0) throw new Error('provider command needs a non-empty `command` array')
  const substituted = argv.map((arg) =>
    arg
      .replaceAll('{port}', new URL(target).port)
      .replaceAll('{host}', new URL(target).hostname)
      .replaceAll('{target}', target)
  )
  const plan = head(substituted[0])
  plan.args = substituted.slice(1)
  plan.publicUrl = config.publicUrl || (config.hostname ? `https://${config.hostname}` : null)
  const pattern = config.urlPattern ? new RegExp(config.urlPattern, 'i') : ANY_URL
  plan.detect = (line) => {
    const match = line.match(pattern)
    return match ? (match[1] || match[0]).replace(/\/+$/, '') : null
  }
  return plan
}

export class TunnelSupervisor {
  /**
   * @param {object} options
   * @param {object} options.config  normalized plugin config
   * @param {string} options.target  local origin the tunnel must point at
   * @param {string} options.remoteDir  plugin state directory
   * @param {import('./util.js').RingLog} options.ring
   * @param {(snapshot: object) => void} options.onState
   */
  constructor({ config, target, remoteDir, logger, ring, onState }) {
    this.config = config
    this.target = target
    this.remoteDir = remoteDir
    this.logger = logger
    this.ring = ring
    this.onState = onState
    this.state = 'idle'
    this.url = null
    this.error = null
    this.attempts = 0
    this.startedAt = null
    this.child = null
    this.desired = false
    this.plan = null
    this.waiters = []
    this.stopPromise = null
    this.restartTimer = null
    // Public-URL watchdog: a cloudflared edge connection can die without the
    // process exiting (notably a quick tunnel whose server-side record is gone:
    // `Unauthorized: Tunnel not found`), so the supervisor would otherwise keep
    // reporting `ready` while every request behind the URL fails.
    this.health = { checkedAt: null, ok: null, failures: 0, restarts: 0 }
    this.healthTimer = null
    this.healthSince = 0
    this.healthDnsLogged = false
    this.recycling = false
  }

  snapshot() {
    return {
      state: this.state,
      url: this.url,
      error: this.error,
      attempts: this.attempts,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      health: { ...this.health },
      target: this.target,
      provider: this.config.provider
    }
  }

  #setState(state, patch = {}) {
    this.state = state
    Object.assign(this, patch)
    const snap = this.snapshot()
    try {
      this.onState?.(snap)
    } catch (error) {
      this.logger?.warn(`state listener failed: ${error?.message ?? error}`)
    }
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve(snap)
    return snap
  }

  #waitFor(predicate, timeoutMs) {
    const current = this.snapshot()
    if (predicate(current)) return Promise.resolve(current)
    return new Promise((resolve) => {
      let settled = false
      const finish = (snap) => {
        if (settled) return
        if (!predicate(snap)) {
          this.waiters.push(finish)
          return
        }
        settled = true
        resolve(snap)
      }
      this.waiters.push(finish)
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (settled) return
          settled = true
          resolve(this.snapshot())
        }, timeoutMs)
      }
    })
  }

  #handleLine(line) {
    const text = line
    this.ring?.push(text)
    if (this.plan) {
      const found = this.plan.detect(text)
      if (found && found !== this.url) {
        this.url = found
        this.logger?.info(`tunnel URL: ${found}`)
        if (this.state === 'starting') {
          this.#setState('ready', { url: found, error: null, attempts: 0 })
          this.#startHealth()
        }
      }
    }
    if (this.state === 'starting' && this.plan?.publicUrl && /Registered tunnel connection|Allocated port|Connection established/i.test(text)) {
      this.url = this.plan.publicUrl
      this.#setState('ready', { url: this.url, error: null, attempts: 0 })
      this.#startHealth()
    }
  }

  /**
   * Start watching the public URL while the tunnel claims to be ready.
   *
   * cloudflared retries a broken edge connection forever instead of exiting, so
   * a dead quick tunnel (`Unauthorized: Tunnel not found`, an edge that keeps
   * closing, a rotated quick tunnel) leaves the supervisor `ready` and the
   * panel promising a link that answers 502/530/1033. The watchdog asks the
   * public URL itself, cheaply, and recycles the process when the URL stops
   * answering for `healthFailures` checks in a row, which mints a fresh quick
   * tunnel and a fresh link.
   */
  #startHealth() {
    this.#stopHealth()
    this.recycling = false
    this.health.failures = 0
    this.healthSince = Date.now()
    this.healthDnsLogged = false
    if (!(this.config.healthCheckMs > 0) || !this.url) return
    const tick = async () => {
      this.healthTimer = null
      if (this.state !== 'ready' || !this.url || !this.desired) return
      await this.#probeHealth()
      if (this.state === 'ready' && this.desired && !this.healthTimer) {
        this.healthTimer = setTimeout(tick, this.config.healthCheckMs)
        this.healthTimer.unref?.()
      }
    }
    this.healthTimer = setTimeout(tick, this.config.healthCheckMs)
    this.healthTimer.unref?.()
  }

  #stopHealth() {
    clearTimeout(this.healthTimer)
    this.healthTimer = null
  }

  async #probeHealth() {
    const url = this.url
    if (!url) return
    let status = 0
    let error = null
    try {
      const response = await fetch(`${String(url).replace(/\/+$/, '')}/`, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(this.config.healthCheckTimeoutMs)
      })
      status = response.status
      await response.text().catch(() => '')
    } catch (caught) {
      error = caught
    }
    const dnsCode = error?.cause?.code ?? error?.code ?? null
    const dnsFailure = isDnsResolutionError(error)
    // A quick tunnel's hostname is created when the edge connection comes up;
    // public DNS can lag behind by a minute or two. Restarting cloudflared
    // cannot fix resolution, so a resolution failure inside the grace window
    // is inconclusive rather than unhealthy.
    const dnsGraceMs = this.config.healthDnsGraceMs ?? 120_000
    if (dnsFailure && Date.now() - this.healthSince < dnsGraceMs) {
      this.health = { ...this.health, checkedAt: new Date().toISOString() }
      if (!this.healthDnsLogged) {
        this.healthDnsLogged = true
        this.logger?.info(
          `tunnel health check inconclusive (${dnsCode}); waiting for the fresh tunnel domain to resolve`
        )
      }
      return
    }
    this.healthDnsLogged = false
    const ok = isHealthyTunnelStatus(status)
    this.health = {
      checkedAt: new Date().toISOString(),
      ok,
      failures: ok ? 0 : this.health.failures + 1,
      restarts: this.health.restarts
    }
    if (ok) return
    const detail = error
      ? error?.name === 'TimeoutError'
        ? 'the check timed out'
        : String(error?.message ?? error)
      : `HTTP ${status}`
    this.logger?.warn(
      `tunnel health check failed (${detail}); ${this.health.failures}/${this.config.healthFailures} before a restart`
    )
    if (this.health.failures >= this.config.healthFailures) this.#recycleTunnel(detail)
  }

  /** Replace a process whose edge died without exiting, resetting the budget. */
  #recycleTunnel(detail) {
    if (this.recycling) return
    this.recycling = true
    this.#stopHealth()
    this.health.restarts += 1
    this.logger?.warn(`the public URL stopped answering (${detail}); restarting the tunnel for a fresh URL`)
    const child = this.child
    this.attempts = 0
    this.url = null
    this.#setState('restarting', {
      url: null,
      error: `the public URL stopped answering (${detail}); restarting the tunnel`
    })
    if (!child) {
      void this.#spawnOnly()
      return
    }
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 5_000)
    force.unref?.()
  }

  async start({ timeoutMs } = {}) {
    if (this.state === 'ready' || this.state === 'starting') return this.snapshot()
    this.desired = true
    clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.url = null
    this.error = null

    let plan
    try {
      plan = planTunnel(this.config, this.target, this.remoteDir)
    } catch (error) {
      this.logger?.error(`cannot start tunnel: ${error.message}`)
      return this.#setState('failed', { error: error.message })
    }
    this.plan = plan
    this.startedAt = new Date().toISOString()
    this.#setState('starting', { url: plan.publicUrl ?? null })

    this.logger?.info(`starting ${plan.provider}: ${plan.command} ${plan.args.join(' ')}`.replace(String(this.config.tunnelToken || '\u0000'), '***'))
    try {
      this.child = spawn(plan.command, plan.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        cwd: this.remoteDir
      })
    } catch (error) {
      return this.#setState('failed', { error: `spawn failed: ${error.message}` })
    }

    const child = this.child
    let buffer = ''
    const consume = (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) this.#handleLine(line)
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)

    child.once('error', (error) => {
      this.logger?.error(`tunnel process error: ${error.message}`)
      if (this.state === 'starting') this.#setState('failed', { error: error.message })
    })

    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.#stopHealth()
      const detail = signal ? `signal ${signal}` : `code ${code}`
      this.logger?.warn(`tunnel process exited (${detail})`)
      if (!this.desired) {
        this.#setState('idle', { url: null })
        return
      }
      if (this.attempts >= this.config.maxRestarts) {
        this.#setState('failed', { error: `tunnel exited (${detail}) and the restart budget is spent`, url: null })
        return
      }
      this.attempts += 1
      const delay = Math.min(30_000, 1000 * 2 ** (this.attempts - 1))
      this.#setState('restarting', { error: `tunnel exited (${detail}); retrying in ${Math.round(delay / 1000)}s` })
      this.restartTimer = setTimeout(() => {
        void this.#spawnOnly()
      }, delay)
      this.restartTimer.unref?.()
    })

    return this.#waitFor((s) => s.state === 'ready' || s.state === 'failed', timeoutMs ?? this.config.startTimeoutMs)
  }

  /** Restart after an unexpected exit, keeping `desired` and the attempt count. */
  async #spawnOnly() {
    this.restartTimer = null
    if (!this.desired) return
    const keepAttempts = this.attempts
    this.state = 'idle'
    await this.start()
    this.attempts = Math.max(this.attempts, keepAttempts)
  }

  async stop() {
    this.desired = false
    clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.#stopHealth()
    const child = this.child
    this.child = null
    this.plan = null
    if (!child) {
      this.attempts = 0
      const snap = this.#setState('idle', { url: null, error: null })
      return snap
    }
    this.#setState('stopping')
    this.stopPromise = new Promise((resolve) => {
      const done = () => resolve()
      child.once('exit', done)
      setTimeout(done, 5000)
    })
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    await this.stopPromise
    this.stopPromise = null
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      await sleep(250)
    }
    this.attempts = 0
    return this.#setState('idle', { url: null, error: null })
  }

  async restart() {
    await this.stop()
    await sleep(300)
    return this.start()
  }

  async dispose() {
    clearTimeout(this.restartTimer)
    this.restartTimer = null
    return this.stop()
  }
}

/**
 * Is this HTTP status an answer from *this Host* (reached through the tunnel)?
 *
 * A healthy tunnel carries the request to the DSH webserver, which answers with
 * the page (200/303), a token challenge (401), or a fence refusal (403). Cloud-
 * flare's own failures never look like that: an edge that cannot reach the
 * origin answers 502/503/530/1033.
 */
export function isDnsResolutionError(error) {
  const code = error?.cause?.code ?? error?.code ?? null
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN'
}

export function isHealthyTunnelStatus(status) {
  return status === 200 || status === 303 || status === 401 || status === 403
}

export function currentPlatformLabel() {
  return `${process.platform}-${os.arch()}`
}
