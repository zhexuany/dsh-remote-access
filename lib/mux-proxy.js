/**
 * `/remote-access/mux` — the app-level compressed WebSocket proxy.
 *
 * Why this exists
 * ---------------
 * A conversation switch in the DSH Web GUI downloads the initial history
 * window as one JSON WebSocket frame. On a Cloudflare quick tunnel that frame
 * travels uncompressed: the edge does not echo `Sec-WebSocket-Extensions`, so
 * the gateway's `permessage-deflate` never negotiates, and a 1–3 MB window
 * costs seconds at tunnel throughput. HTTP responses are gzip'd by the edge;
 * WebSocket frames are not.
 *
 * This proxy keeps the gateway untouched: the browser client half opens a
 * WebSocket to this route instead of `/api/remote.mux`, this process connects
 * to the real local mux over loopback (forwarding the browser's cookie), and
 * every downlink text frame at or above `threshold` bytes is deflated with
 * `deflate-raw` and sent as a binary frame. The client half inflates binary
 * frames with `DecompressionStream('deflate-raw')` before the mux sees them.
 * The wire protocol above the socket stays the gateway's own JSON frames.
 *
 * Compression is negotiated through the query string (`?deflate=1`) rather
 * than an extension header, because a CDN edge may strip both extension
 * handshake headers. A client that cannot decompress simply omits the query
 * parameter and gets plain text frames.
 */

import zlib from 'node:zlib'
import { FrameParser, OP, encodeFrame, closePayload, parseClosePayload, clientHandshake, isWebSocketUpgrade, rejectUpgrade, writeUpgradeResponse } from './ws.js'

export const MUX_PROXY_PATH = '/remote-access/mux'

const UPSTREAM_MUX_PATH = '/api/remote.mux'
const DEFAULT_THRESHOLD = 1_024
const MAX_DOWNLINK_FRAME = 64 * 1024 * 1024
const RECENT_FRAME_SAMPLES = 8
// Headers copied from the browser's upgrade request to the loopback mux: the
// gateway admits a connection on its cookie (and, for tunnelled hosts, its
// trustedHosts entry), so the cookie must survive the hop unchanged.
const FORWARDED_HEADERS = ['cookie', 'origin', 'user-agent', 'accept-language', 'authorization', 'host']

/**
 * @param {object} options
 * @param {() => string} options.getOrigin loopback origin of this Host, e.g. `http://127.0.0.1:55627`
 * @param {object} [options.logger] createLogger-compatible logger
 * @param {object} [options.config] normalized plugin config
 */
export function createMuxProxy({ getOrigin, logger = null, config = {} }) {
  const compressionEnabled = config.muxCompression !== false
  const level = clampInt(config.muxCompressionLevel, 4, 1, 9)
  const threshold = clampInt(config.muxCompressionThresholdBytes, DEFAULT_THRESHOLD, 128, 1024 * 1024)
  const handshakeTimeoutMs = clampInt(config.muxHandshakeTimeoutMs, 8_000, 1_000, 60_000)

  const bridges = new Set()
  const stats = {
    connections: 0,
    activeConnections: 0,
    rejectedUpgrades: 0,
    failedUpstreams: 0,
    uplinkFrames: 0,
    uplinkBytes: 0,
    downlinkFrames: 0,
    downlinkRawBytes: 0,
    compressedFrames: 0,
    compressedBytes: 0,
    recentFrames: []
  }

  const log = (name, message) => {
    try {
      logger?.[name]?.(message)
    } catch {
      /* logging must never break the proxy */
    }
  }

  /** node:http `upgrade` listener body. */
  async function handleUpgrade(req, socket, head) {
    if (!isWebSocketUpgrade(req)) {
      stats.rejectedUpgrades += 1
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    let url
    try {
      url = new URL(req.url ?? MUX_PROXY_PATH, 'http://remote-access.local')
    } catch {
      stats.rejectedUpgrades += 1
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    const deflate = compressionEnabled && url.searchParams.get('deflate') === '1'

    let origin
    try {
      origin = new URL(getOrigin())
    } catch (error) {
      stats.failedUpstreams += 1
      log('warn', `mux proxy: no loopback origin yet: ${error?.message ?? error}`)
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const host = origin.hostname
    const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80))

    let upstream
    try {
      upstream = await clientHandshake({
        host,
        port,
        path: UPSTREAM_MUX_PATH,
        headers: forwardedHeaders(req),
        timeoutMs: handshakeTimeoutMs
      })
    } catch (error) {
      stats.failedUpstreams += 1
      log('warn', `mux proxy: upstream mux unavailable: ${error?.message ?? error}`)
      rejectUpgrade(socket, 502, 'Bad Gateway')
      return
    }

    try {
      writeUpgradeResponse(socket, req)
    } catch (error) {
      stats.failedUpstreams += 1
      upstream.socket.destroy()
      socket.destroy()
      return
    }
    const bridge = new MuxBridge({
      socket,
      upstream,
      head,
      deflate,
      level,
      threshold,
      stats,
      log,
      onClose: () => {
        bridges.delete(bridge)
        stats.activeConnections = bridges.size
      }
    })
    bridges.add(bridge)
    stats.connections += 1
    stats.activeConnections = bridges.size
    bridge.start()
  }

  function forwardedHeaders(req) {
    const headers = {}
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers?.[name]
      if (value !== undefined && value !== null && value !== '') headers[name] = value
    }
    return headers
  }

  function snapshot() {
    return {
      ...stats,
      recentFrames: stats.recentFrames.slice()
    }
  }

  function dispose() {
    for (const bridge of [...bridges]) bridge.destroy()
    bridges.clear()
    stats.activeConnections = 0
  }

  return { path: MUX_PROXY_PATH, handleUpgrade, stats: snapshot, dispose }
}

class MuxBridge {
  constructor({ socket, upstream, head, deflate, level, threshold, stats, log, onClose }) {
    this.socket = socket
    this.upstream = upstream
    this.head = head
    this.deflate = deflate
    this.level = level
    this.threshold = threshold
    this.stats = stats
    this.log = log
    this.onClose = onClose
    this.closed = false
    this.closeTimer = null
    this.sendChain = Promise.resolve()
    this.browserPaused = false
    this.upstreamPaused = false
    this.browserParser = new FrameParser({
      onMessage: (opcode, payload) => this.onBrowserMessage(opcode, payload),
      onControl: (opcode, payload) => this.onBrowserControl(opcode, payload),
      onError: (error) => this.fail(error)
    })
    this.upstreamParser = new FrameParser({
      onMessage: (opcode, payload) => this.onUpstreamMessage(opcode, payload),
      onControl: (opcode, payload) => this.onUpstreamControl(opcode, payload),
      onError: (error) => this.fail(error)
    })
  }

  start() {
    const { socket, upstream } = this
    socket.on('data', (chunk) => this.browserParser.push(chunk))
    socket.on('drain', () => {
      this.browserPaused = false
      if (this.upstreamPaused) this.upstream.socket.resume()
    })
    // An upgrade socket keeps its writable half open after the peer sends FIN,
    // so `close` alone would wait for the browser's TCP stack to time out.
    socket.on('end', () => this.destroy())
    socket.on('close', () => this.destroy())
    socket.on('error', () => this.destroy())
    upstream.socket.on('data', (chunk) => this.upstreamParser.push(chunk))
    upstream.socket.on('drain', () => {
      this.upstreamPaused = false
      if (this.browserPaused) this.socket.resume()
    })
    upstream.socket.on('end', () => this.destroy())
    upstream.socket.on('close', () => this.destroy())
    upstream.socket.on('error', () => this.destroy())
    if (this.head !== undefined && this.head !== null && this.head.length > 0) this.browserParser.push(this.head)
    if (upstream.leftover !== undefined && upstream.leftover !== null && upstream.leftover.length > 0) {
      this.upstreamParser.push(upstream.leftover)
    }
  }

  onBrowserMessage(opcode, payload) {
    this.stats.uplinkFrames += 1
    this.stats.uplinkBytes += payload.length
    this.writeUpstream(opcode, payload)
  }

  onBrowserControl(opcode, payload) {
    if (opcode === OP.PING) {
      this.writeBrowser(encodeFrame(OP.PONG, payload))
      return
    }
    if (opcode === OP.CLOSE) {
      this.writeUpstream(OP.CLOSE, payload)
      this.finish()
    }
  }

  onUpstreamMessage(opcode, payload) {
    this.stats.downlinkFrames += 1
    this.stats.downlinkRawBytes += payload.length
    // Compression is async; the chain keeps downlink frame order intact when a
    // large frame is deflated while later frames are already arriving.
    this.sendChain = this.sendChain
      .then(() => this.deliverUpstreamFrame(opcode, payload))
      .catch((error) => this.fail(error))
  }

  async deliverUpstreamFrame(opcode, payload) {
    if (this.closed || !this.socket.writable) return
    if (this.deflate && opcode === OP.TEXT && payload.length >= this.threshold) {
      const compressed = await deflateRaw(payload, this.level)
      if (this.closed || !this.socket.writable) return
      this.stats.compressedFrames += 1
      this.stats.compressedBytes += compressed.length
      this.recordFrame(payload.length, compressed.length)
      this.writeBrowser(encodeFrame(OP.BINARY, compressed))
      return
    }
    this.recordFrame(payload.length, payload.length)
    this.writeBrowser(encodeFrame(opcode, payload))
  }

  recordFrame(raw, wire) {
    const samples = this.stats.recentFrames
    samples.push({ at: Date.now(), raw, wire })
    if (samples.length > RECENT_FRAME_SAMPLES) samples.splice(0, samples.length - RECENT_FRAME_SAMPLES)
  }

  onUpstreamControl(opcode, payload) {
    if (opcode === OP.PING) {
      this.writeUpstream(OP.PONG, payload)
      return
    }
    if (opcode === OP.CLOSE) {
      this.writeBrowser(encodeFrame(OP.CLOSE, payload))
      this.finish()
    }
  }

  writeBrowser(frame) {
    if (this.closed || !this.socket.writable) return
    if (this.socket.write(frame) === false && !this.upstreamPaused) {
      this.upstreamPaused = true
      this.upstream.socket.pause()
    }
  }

  writeUpstream(opcode, payload) {
    if (this.closed || !this.upstream.socket.writable) return
    const frame = encodeFrame(opcode, payload, { mask: true })
    if (this.upstream.socket.write(frame) === false && !this.browserPaused) {
      this.browserPaused = true
      this.socket.pause()
    }
  }

  fail(error) {
    this.log('warn', `mux proxy: ${error?.message ?? error}`)
    if (this.closed) return
    try {
      this.writeBrowser(encodeFrame(OP.CLOSE, closePayload(1011, 'mux proxy failed')))
      this.writeUpstream(OP.CLOSE, closePayload(1011, 'mux proxy failed'))
    } catch {
      /* sockets may already be gone */
    }
    this.finish()
  }

  finish() {
    if (this.closeTimer !== null) return
    this.closed = true
    try {
      this.socket.end()
    } catch {
      /* already closed */
    }
    try {
      this.upstream.socket.end()
    } catch {
      /* already closed */
    }
    this.closeTimer = setTimeout(() => this.destroy(), 2_000)
    this.closeTimer.unref?.()
  }

  destroy() {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    this.closed = true
    this.socket.destroy()
    this.upstream.socket.destroy()
    this.onClose?.()
  }
}

function deflateRaw(payload, level) {
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(payload, { level }, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}
