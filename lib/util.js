/**
 * Small dependency-free helpers shared by the remote-access plugin halves.
 * Node builtins only: the plugin must load even when the Harness tree changes.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function nowIso() {
  return new Date().toISOString()
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Write JSON so a reader either sees the old file or the complete new one. */
export async function writeJsonAtomic(file, value, mode = 0o600) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await rename(tmp, file)
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeTextAtomic(file, text, mode = 0o600) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, { mode })
  await rename(tmp, file)
}

/** Bounded line buffer that keeps the newest entries. */
export class RingLog {
  constructor(limit = 200, mirror = null) {
    this.limit = limit
    /** optional RotatingFileLog: the ring is capped, the file keeps the history */
    this.mirror = mirror
    this.lines = []
  }

  push(line) {
    const text = String(line).replace(/\s+$/, '')
    if (!text) return
    this.lines.push({ at: nowIso(), text })
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit)
    this.mirror?.push(text)
  }

  list(limit = this.limit) {
    return this.lines.slice(-limit)
  }
}

/**
 * Append-only diagnostic log with a single rotation step. The in-memory ring is
 * capped, so a long-running tunnel leaves no durable record of what the tunnel
 * process actually said; this keeps the raw stream on disk instead.
 */
export class RotatingFileLog {
  constructor(file, maxBytes = 1_000_000) {
    this.file = file
    this.maxBytes = Math.max(64_000, Number(maxBytes) || 1_000_000)
    this.size = 0
    this.measured = false
    this.disabled = false
  }

  get path() {
    return this.file
  }

  push(line) {
    if (this.disabled) return
    const text = String(line ?? '').replace(/\s+$/, '')
    if (!text) return
    const record = `${nowIso()} ${text}\n`
    try {
      if (!this.measured) {
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
        try {
          this.size = statSync(this.file).size
        } catch {
          this.size = 0
        }
        this.measured = true
      }
      const bytes = Buffer.byteLength(record)
      if (this.size + bytes > this.maxBytes) {
        try {
          renameSync(this.file, `${this.file}.1`)
        } catch {
          /* nothing to rotate yet */
        }
        this.size = 0
      }
      appendFileSync(this.file, record, { mode: 0o600 })
      this.size += bytes
    } catch {
      // A diagnostic log must never take the tunnel down with it.
      this.disabled = true
    }
  }
}

/** A minimal console-shaped logger with a bounded tail for the UI. */
export function createLogger(ring, scope) {
  const emit = (level, args) => {
    const text = args.map((a) => (typeof a === 'string' ? a : safeInspect(a))).join(' ')
    ring?.push(`[${level}] ${text}`)
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(`[remote-access] ${text}`)
  }
  return {
    ring,
    scope,
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args)
  }
}

function safeInspect(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Resolve the Harness home and the active profile name without depending on a
 * Harness service: the installed package path itself encodes both
 * (`<home>/profiles/<profile>/node_modules/<pkg>`).
 */
export function locateHome(ctx, config = {}) {
  const candidates = []
  const push = (home, how) => {
    if (typeof home === 'string' && home.trim()) candidates.push({ home: path.resolve(home.trim()), how })
  }
  push(config.home, 'config')
  push(process.env.DSH_HOME, 'env:DSH_HOME')
  push(process.env.DSH_NEXT_HOME, 'env:DSH_NEXT_HOME')

  // `<home>/profiles/<profile>/node_modules/dsh-remote-access/lib/util.js`
  if (path.basename(path.resolve(PACKAGE_ROOT, '../..')) === 'profiles' || /[\\/]profiles[\\/]/.test(PACKAGE_ROOT)) {
    const m = PACKAGE_ROOT.match(/^(.*)[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/]/)
    if (m) candidates.push({ home: m[1], profile: m[2], how: 'package-path' })
  }

  try {
    const dir = ctx?.get?.('profileContext')?.dir
    const m = typeof dir === 'string' ? dir.match(/^(.*)[\\/]profiles[\\/]([^\\/]+)$/) : null
    if (m) candidates.push({ home: m[1], profile: m[2], how: 'profileContext' })
  } catch {
    /* service absent: ignore */
  }
  push(path.join(os.homedir(), '.dsh'), 'homedir-default')

  // A source checkout linked into a profile resolves PACKAGE_ROOT to the
  // checkout, so three levels up is the user's home, not the Harness home.
  // Keep this guess last; explicit/env/profile paths always win.
  push(path.resolve(PACKAGE_ROOT, '..', '..', '..'), 'package-path-guess')

  return candidates[0]
}

export function remoteAccessDir(home) {
  return path.join(home, 'remote-access')
}

export const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/** Accept only a bare `host` or `host:port` authority for the API trust fence. */
export function normalizeAuthority(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (!text) return undefined
  const [host, port, ...rest] = text.split(':')
  if (rest.length > 0) return undefined
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return undefined
  if (!HOSTNAME_PATTERN.test(host) && !/^[\d.]+$/.test(host)) return undefined
  return port === undefined ? host : `${host}:${port}`
}

/** Extract the authority (`host[:port]`) a URL points at. */
export function authorityOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  } catch {
    return undefined
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
