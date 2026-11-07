/**
 * End-to-end test for `/remote-access/mux` without a Host or tunnel: a fake mux
 * upstream (a plain `node:http` upgrade socket speaking RFC 6455), the proxy in
 * front of it, and a real client handshake through the proxy. Proves that
 *
 *   - the browser's cookie and Host header reach the upstream mux,
 *   - `?deflate=1` turns a large text frame into `deflate-raw` binary and the
 *     client gets the exact original JSON back after inflating,
 *   - small frames and frames without `?deflate=1` stay plain text,
 *   - the counters status() exposes are wired.
 *
 * Run:  test/run-tests.sh            (or)
 *       node test/mux-proxy-unit.mjs
 */
import http from 'node:http'
import zlib from 'node:zlib'

import { createMuxProxy } from '../lib/mux-proxy.js'
import { clientHandshake, encodeFrame, FrameParser, OP, writeUpgradeResponse } from '../lib/ws.js'

const failures = []
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`)
}

const BIG_TEXT = JSON.stringify({
  type: 'item',
  streamId: 'stream-1',
  value: {
    type: 'snapshot',
    records: Array.from({ length: 80 }, (_, index) => ({
      seq: index,
      kind: 'assistant/message',
      text: 'history window content '.repeat(3)
    }))
  }
})
const SMALL_TEXT = JSON.stringify({ type: 'ack' })
if (Buffer.byteLength(BIG_TEXT) < 1_024) throw new Error('test frame must exceed the compression threshold')

// ── fake upstream mux ──────────────────────────────────────────────────────
const upstreamFrames = []
const upstreamSockets = new Set()
let upstreamCookie = null
let upstreamPath = null
let upstreamHost = null
const upstream = http.createServer((_req, res) => {
  res.writeHead(404)
  res.end()
})
upstream.on('upgrade', (req, socket) => {
  upstreamSockets.add(socket)
  socket.on('close', () => upstreamSockets.delete(socket))
  upstreamPath = req.url
  upstreamCookie = req.headers.cookie ?? null
  upstreamHost = req.headers.host ?? null
  writeUpgradeResponse(socket, req)
  const parser = new FrameParser({
    onMessage: (_opcode, payload) => {
      const text = payload.toString('utf8')
      upstreamFrames.push(text)
      if (text === 'hello') {
        // One frame above the threshold, one below it: only the big one is
        // expected to be re-encoded by the proxy.
        socket.write(encodeFrame(OP.TEXT, Buffer.from(BIG_TEXT)))
        socket.write(encodeFrame(OP.TEXT, Buffer.from(SMALL_TEXT)))
      }
    },
    onControl: (opcode) => {
      if (opcode === OP.CLOSE) socket.end()
    }
  })
  socket.on('data', (chunk) => parser.push(chunk))
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

// ── proxy ──────────────────────────────────────────────────────────────────
const proxy = createMuxProxy({
  getOrigin: () => `http://127.0.0.1:${upstreamPort}`,
  config: { muxCompression: true, muxCompressionLevel: 4, muxCompressionThresholdBytes: 1_024 }
})
const proxyServer = http.createServer((_req, res) => {
  res.writeHead(404)
  res.end()
})
proxyServer.on('upgrade', (req, socket, head) => {
  void proxy.handleUpgrade(req, socket, head)
})
await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
const proxyPort = proxyServer.address().port

/** Send one text frame and collect downlink messages until `count` arrive. */
async function exchange({ path, messages = 2, frames, timeoutMs = 5_000 }) {
  const client = await clientHandshake({
    host: '127.0.0.1',
    port: proxyPort,
    path,
    headers: { cookie: 'sid=abc123', host: 'junction-burke-solving-was.trycloudflare.com' },
    timeoutMs
  })
  const received = []
  const parser = new FrameParser({
    onMessage: (opcode, payload) => {
      received.push({ opcode, payload })
      if (received.length >= messages) finish()
    },
    onControl: (opcode) => {
      if (opcode === OP.CLOSE) finish()
    }
  })
  let done = false
  let finish
  const collected = new Promise((resolve) => {
    finish = () => {
      if (done) return
      done = true
      resolve()
    }
    setTimeout(finish, timeoutMs)
  })
  if (client.leftover.length > 0) parser.push(client.leftover)
  client.socket.on('data', (chunk) => parser.push(chunk))
  for (const frame of frames) client.socket.write(frame)
  await collected
  client.socket.destroy()
  return received
}

// ── compressed connection ──────────────────────────────────────────────────
const compressed = await exchange({
  path: '/remote-access/mux?deflate=1',
  messages: 2,
  frames: [encodeFrame(OP.TEXT, Buffer.from('hello'), { mask: true })]
})
check('upstream mux path is the gateway mux', upstreamPath === '/api/remote.mux', String(upstreamPath))
check('browser cookie reaches the upstream mux', upstreamCookie === 'sid=abc123', String(upstreamCookie))
check(
  'browser Host header reaches the upstream mux',
  upstreamHost === 'junction-burke-solving-was.trycloudflare.com',
  String(upstreamHost)
)
check('uplink text frame reaches the upstream mux', upstreamFrames.includes('hello'), upstreamFrames.join(','))
check(
  'large frame arrives as compressed binary',
  compressed[0]?.opcode === OP.BINARY,
  String(compressed[0]?.opcode)
)
const inflated = compressed[0] ? zlib.inflateRawSync(compressed[0].payload).toString('utf8') : ''
check('inflated binary frame equals the original JSON', inflated === BIG_TEXT, `${inflated.length}/${BIG_TEXT.length}`)
check(
  'binary frame is smaller than the text frame',
  (compressed[0]?.payload.length ?? 0) < Buffer.byteLength(BIG_TEXT),
  `${compressed[0]?.payload.length}/${Buffer.byteLength(BIG_TEXT)}`
)
check('small frame stays plain text', compressed[1]?.opcode === OP.TEXT && compressed[1]?.payload.toString('utf8') === SMALL_TEXT)

// ── uncompressed connection (no ?deflate=1) ────────────────────────────────
const plain = await exchange({
  path: '/remote-access/mux',
  messages: 2,
  frames: [encodeFrame(OP.TEXT, Buffer.from('hello'), { mask: true })]
})
check('without ?deflate=1 a large frame stays text', plain[0]?.opcode === OP.TEXT)
check('uncompressed large frame equals the original JSON', plain[0]?.payload.toString('utf8') === BIG_TEXT)

// ── counters ───────────────────────────────────────────────────────────────
await new Promise((resolve) => setTimeout(resolve, 150))
const stats = proxy.stats()
check('two proxied connections are counted', stats.connections === 2, String(stats.connections))
check('one compressed frame is counted', stats.compressedFrames === 1, String(stats.compressedFrames))
check('downlink raw bytes cover all three upstream frames', stats.downlinkRawBytes >= Buffer.byteLength(BIG_TEXT) * 2 + SMALL_TEXT.length)
check('compressed bytes are less than raw bytes', stats.compressedBytes > 0 && stats.compressedBytes < stats.downlinkRawBytes)
check('active connections are back to zero', stats.activeConnections === 0, String(stats.activeConnections))
check('recent frame samples are recorded', stats.recentFrames.length > 0)

// ── teardown ───────────────────────────────────────────────────────────────
proxy.dispose()
for (const socket of upstreamSockets) socket.destroy()
await new Promise((resolve) => proxyServer.close(resolve))
await new Promise((resolve) => upstream.close(resolve))

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('\nmux proxy passed')
