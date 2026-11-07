/**
 * Minimal, dependency-free WebSocket protocol support (RFC 6455).
 *
 * dsh-remote-access owns a WebSocket proxy (`/remote-access/mux`) that sits
 * between a browser and this Host's own gateway mux. The plugin ships with no
 * runtime dependencies and cannot rely on `ws` living next to the package (the
 * profile installs it by symlink, so `ws` resolves to whatever happens to sit
 * above the checkout), so both halves of the wire protocol live here:
 *
 *   - a server handshake writer (the browser half of the proxy),
 *   - a client handshake caller (the upstream half of the proxy),
 *   - frame encoding/decoding with masking, fragmentation, and control frames.
 *
 * The proxy never negotiates a WebSocket extension: `permessage-deflate` is
 * offered by the browser, we simply do not echo it, and the upstream Host is
 * offered nothing. Application-level compression is layered above the framing
 * instead (see lib/mux-proxy.js), which also works when the Cloudflare edge
 * strips the extension header.
 */

import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OP = Object.freeze({
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
})

const CONTROL_OPCODES = new Set([OP.CLOSE, OP.PING, OP.PONG])
const DATA_OPCODES = new Set([OP.TEXT, OP.BINARY])

/** `Sec-WebSocket-Accept` for a client key. */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
}

/** Fresh 16-byte client key, base64. */
export function makeKey() {
  return randomBytes(16).toString('base64')
}

/**
 * Encode one (unfragmented) frame.
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {{mask?: boolean, fin?: boolean}} [options]
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload, options = {}) {
  const { mask = false, fin = true } = options
  const length = payload.length
  let headerLength = 2
  if (length >= 65_536) headerLength += 8
  else if (length >= 126) headerLength += 2
  if (mask) headerLength += 4
  const out = Buffer.allocUnsafe(headerLength + length)
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  let offset = 2
  if (length >= 65_536) {
    out[1] = 127
    out.writeBigUInt64BE(BigInt(length), 2)
    offset = 10
  } else if (length >= 126) {
    out[1] = 126
    out.writeUInt16BE(length, 2)
    offset = 4
  } else {
    out[1] = length
  }
  if (mask) {
    out[1] |= 0x80
    const key = randomBytes(4)
    key.copy(out, offset)
    offset += 4
    for (let i = 0; i < length; i += 1) out[offset + i] = payload[i] ^ key[i & 3]
  } else {
    payload.copy(out, offset)
  }
  return out
}

/** Close-frame payload (code + UTF-8 reason, truncated to 123 bytes). */
export function closePayload(code = 1000, reason = '') {
  const reasonBytes = Buffer.from(String(reason), 'utf8').subarray(0, 123)
  const out = Buffer.allocUnsafe(2 + reasonBytes.length)
  out.writeUInt16BE(code & 0xffff, 0)
  reasonBytes.copy(out, 2)
  return out
}

/** Decode a close-frame payload into `{ code, reason }`. */
export function parseClosePayload(payload) {
  if (payload.length < 2) return { code: 1005, reason: '' }
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') }
}

/**
 * Streaming frame decoder.
 *
 * Emits complete data messages (`onMessage(opcode, payload)`) and control
 * frames (`onControl(opcode, payload)`); fragmented data messages are joined
 * before emission. Throws through `onError` for protocol violations rather
 * than silently desynchronizing the stream.
 */
export class FrameParser {
  constructor({ onMessage, onControl, onError, maxPayload = 64 * 1024 * 1024 } = {}) {
    this.onMessage = onMessage
    this.onControl = onControl
    this.onError = onError
    this.maxPayload = maxPayload
    this.buffer = Buffer.alloc(0)
    this.fragments = null
    this.fragmentOpcode = 0
    this.fragmentBytes = 0
    this.failed = false
  }

  push(chunk) {
    if (this.failed || !chunk || chunk.length === 0) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (this.parseOne()) {
      /* keep draining */
    }
  }

  /** @returns {boolean} whether one full frame was consumed. */
  parseOne() {
    const buffer = this.buffer
    if (buffer.length < 2) return false
    const b0 = buffer[0]
    const b1 = buffer[1]
    const fin = (b0 & 0x80) !== 0
    const rsv = b0 & 0x70
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let length = b1 & 0x7f
    let offset = 2
    if (rsv !== 0) return this.fail(new Error('websocket: unsupported reserved bits'))
    if (length === 126) {
      if (buffer.length < 4) return false
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return false
      const wide = buffer.readBigUInt64BE(2)
      if (wide > BigInt(this.maxPayload)) return this.fail(new Error('websocket: frame exceeds maxPayload'))
      length = Number(wide)
      offset = 10
    }
    if (length > this.maxPayload) return this.fail(new Error('websocket: frame exceeds maxPayload'))
    if (masked) {
      if (buffer.length < offset + 4) return false
      offset += 4
    }
    if (buffer.length < offset + length) return false
    const payload = Buffer.allocUnsafe(length)
    buffer.copy(payload, 0, offset, offset + length)
    if (masked) {
      const key = buffer.subarray(offset - 4, offset)
      for (let i = 0; i < length; i += 1) payload[i] ^= key[i & 3]
    }
    this.buffer = buffer.subarray(offset + length)

    if (CONTROL_OPCODES.has(opcode)) {
      if (!fin) return this.fail(new Error('websocket: fragmented control frame'))
      if (length > 125) return this.fail(new Error('websocket: oversized control frame'))
      this.onControl?.(opcode, payload)
      return true
    }
    if (!DATA_OPCODES.has(opcode) && opcode !== OP.CONT) {
      return this.fail(new Error(`websocket: unknown opcode ${opcode}`))
    }
    if (opcode === OP.CONT) {
      if (this.fragments === null) return this.fail(new Error('websocket: continuation without a start frame'))
      this.fragmentBytes += length
      if (this.fragmentBytes > this.maxPayload) return this.fail(new Error('websocket: fragmented message exceeds maxPayload'))
      this.fragments.push(payload)
      if (fin) {
        const joined = Buffer.concat(this.fragments)
        const messageOpcode = this.fragmentOpcode
        this.fragments = null
        this.fragmentOpcode = 0
        this.fragmentBytes = 0
        this.onMessage?.(messageOpcode, joined)
      }
      return true
    }
    if (!fin) {
      this.fragments = [payload]
      this.fragmentOpcode = opcode
      this.fragmentBytes = length
      return true
    }
    this.onMessage?.(opcode, payload)
    return true
  }

  fail(error) {
    this.failed = true
    this.onError?.(error)
    return false
  }
}

/**
 * Perform the client half of a WebSocket opening handshake over TCP.
 *
 * @returns {Promise<{socket: net.Socket, status: number, headers: Record<string,string>, leftover: Buffer}>}
 */
export function clientHandshake({ host, port, path, headers = {}, timeoutMs = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const key = makeKey()
    const expectedAccept = acceptKey(key)
    let buffer = Buffer.alloc(0)
    let settled = false
    let timer = null

    const fail = (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const onClose = () => fail(new Error('websocket: upstream closed during handshake'))
    socket.setNoDelay(true)
    timer = setTimeout(() => fail(new Error('websocket: upstream handshake timed out')), timeoutMs)
    socket.on('error', fail)
    socket.on('close', onClose)

    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      const head = buffer.subarray(0, end).toString('latin1')
      const leftover = buffer.subarray(end + 4)
      const [statusLine, ...lines] = head.split('\r\n')
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)
      const status = statusMatch ? Number(statusMatch[1]) : 0
      const responseHeaders = {}
      for (const line of lines) {
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        responseHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      if (status !== 101) {
        socket.destroy()
        const error = new Error(`websocket: upstream refused the upgrade (HTTP ${status || '?'})`)
        error.status = status
        error.headers = responseHeaders
        return fail(error)
      }
      if (responseHeaders['sec-websocket-accept'] !== expectedAccept) {
        socket.destroy()
        return fail(new Error('websocket: upstream returned a bad Sec-WebSocket-Accept'))
      }
      if (responseHeaders['sec-websocket-extensions']) {
        // We never offer extensions, so a compressed upstream frame would be
        // undecodable. Refuse instead of streaming garbage.
        socket.destroy()
        return fail(new Error('websocket: upstream unexpectedly negotiated an extension'))
      }
      settled = true
      if (timer) clearTimeout(timer)
      socket.off('close', onClose)
      socket.on('error', () => {})
      resolve({ socket, status, headers: responseHeaders, leftover })
    }
    socket.on('data', onData)

    socket.on('connect', () => {
      const lines = [`GET ${path} HTTP/1.1`]
      const all = { ...headers }
      if (all.host === undefined || all.host === '') all.host = `${host}:${port}`
      lines.push(`Host: ${all.host}`)
      lines.push('Upgrade: websocket')
      lines.push('Connection: Upgrade')
      lines.push(`Sec-WebSocket-Key: ${key}`)
      lines.push('Sec-WebSocket-Version: 13')
      for (const [name, value] of Object.entries(all)) {
        if (name === 'host' || value === undefined || value === null) continue
        lines.push(`${canonicalHeader(name)}: ${String(value).replace(/[\r\n]+/g, ' ')}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
  })
}

/** Write the server half of the opening handshake for `req`. */
export function writeUpgradeResponse(socket, req, extraHeaders = {}) {
  const key = req.headers['sec-websocket-key']
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(String(key))}`
  ]
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value === undefined || value === null) continue
    lines.push(`${canonicalHeader(name)}: ${String(value).replace(/[\r\n]+/g, ' ')}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
}

/** Reject a websocket upgrade with a plain HTTP response, then close. */
export function rejectUpgrade(socket, status = 400, message = 'Bad Request', headers = {}) {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  const body = `${message}\n`
  const lines = [
    `HTTP/1.1 ${status} ${message}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`
  ]
  for (const [name, value] of Object.entries(headers)) lines.push(`${canonicalHeader(name)}: ${value}`)
  socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`)
  socket.end()
}

/** Validate that `req` is a well-formed WebSocket opening handshake. */
export function isWebSocketUpgrade(req) {
  if (req?.method !== 'GET') return false
  const upgrade = String(req.headers?.upgrade ?? '').toLowerCase()
  if (upgrade !== 'websocket') return false
  if (req.headers?.['sec-websocket-version'] !== '13') return false
  return typeof req.headers?.['sec-websocket-key'] === 'string' && req.headers['sec-websocket-key'].length > 0
}

function canonicalHeader(name) {
  return String(name)
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1).toLowerCase()))
    .join('-')
}
