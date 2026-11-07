/**
 * End-to-end test for `/remote-access/mux` without a Host or tunnel: a fake mux
 * upstream (a plain `node:http` upgrade socket speaking RFC 6455), the proxy in
 * front of it, and a real client handshake through the proxy. Proves that
 *
 *   - the browser's cookie and Host header reach the upstream mux,
 *   - `?deflate=1` turns a large history frame into `DSHD1`-chunked
 *     `deflate-raw` binary frames; reassembling the chunks by header index and
 *     inflating reproduces the stripped JSON exactly,
 *   - replayed `data.stream` is neutralised while `data.usage` survives, and
 *     non-assistant records are forwarded untouched,
 *   - small frames and frames without `?deflate=1` stay plain text (the plain
 *     path is not stripped: an old client still sees the original window),
 *   - a failure anywhere in the optional strip/deflate/chunk pipeline falls
 *     back to forwarding the original text frame,
 *   - the counters status() exposes are wired.
 *
 * Run:  test/run-tests.sh            (or)
 *       node test/mux-proxy-unit.mjs
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import zlib from 'node:zlib'

import { createMuxProxy, encodeDownlinkFrame } from '../lib/mux-proxy.js'
import { parseChunkHeader } from '../lib/mux-chunk.js'
import { clientHandshake, encodeFrame, FrameParser, OP, writeUpgradeResponse } from '../lib/ws.js'

const failures = []
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`)
}

// ── a realistic, chunk-sized history window ────────────────────────────────
// Replay streams carry weakly-compressible text so the deflated frame is well
// above one 16 KB chunk; that is what makes the chunk-order assertions real.
const noise = randomBytes(220_000).toString('hex')
let noiseOffset = 0
function noiseSlice() {
  const slice = noise.slice(noiseOffset, noiseOffset + 300)
  noiseOffset = (noiseOffset + 300) % (noise.length - 300)
  return slice
}

const ASSISTANT_MESSAGES = 120
const assistantRecords = Array.from({ length: ASSISTANT_MESSAGES }, (_, index) => ({
  type: 'event',
  event: {
    type: 'assistant/message',
    seq: index + 1,
    time: 1_700_000_000_000 + index,
    data: {
      turn: 1,
      step: index + 1,
      message: { role: 'assistant', content: [{ type: 'text', text: `answer ${index}` }] },
      usage: { inputTokens: 10 + index, outputTokens: 20, totalTokens: 30 + index, cacheReadTokens: 0 },
      stream: Array.from({ length: 6 }, (_, chunkIndex) => ({
        type: 'chunk',
        time: 1_700_000_000_000 + chunkIndex,
        chunk: { type: 'text-delta', index: chunkIndex, text: noiseSlice() }
      }))
    }
  }
}))
const otherRecords = [
  {
    type: 'event',
    event: { type: 'user/message', seq: 0, data: { message: 'hello', stream: [{ type: 'chunk', chunk: { type: 'text-delta', text: noiseSlice() } }] } }
  },
  { type: 'event', event: { type: 'assistant/attempt', seq: 121, data: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, stream: [{ type: 'chunk' }] } } },
  { type: 'event', event: { type: 'tool/result', seq: 122, data: { result: 'ok' } } },
  // Incompressible output that survives stripping: keeps the deflated frame
  // above one chunk, so chunk ordering is exercised on the payload the client
  // actually receives.
  { type: 'event', event: { type: 'tool/result', seq: 123, data: { result: noise.slice(0, 200_000) } } }
]
const BIG_TEXT = JSON.stringify({
  type: 'item',
  streamId: 'stream-1',
  value: {
    type: 'snapshot',
    header: { version: 4, id: 'session-1', createdAt: 1_700_000_000_000, cwd: '/tmp', isSeeded: true },
    projections: { asOfSeq: 123, values: {} },
    cursor: 123,
    records: [...otherRecords, ...assistantRecords],
    hasMore: true,
    assistantStream: { revision: 5 }
  }
})
const SMALL_TEXT = JSON.stringify({ type: 'ack' })
if (Buffer.byteLength(BIG_TEXT) < 1_024) throw new Error('test frame must exceed the compression threshold')
const expectedStripped = JSON.parse(BIG_TEXT)
for (const record of expectedStripped.value.records) {
  if (record.event?.type === 'assistant/message') record.event.data.stream = []
}
const EXPECTED_STRIPPED_TEXT = JSON.stringify(expectedStripped)

/** Reassemble `DSHD1` chunks exactly as client.js will. */
function reassemble(chunks) {
  const parsed = chunks.map((chunk) => {
    const header = parseChunkHeader(chunk)
    if (header === null) throw new Error('binary frame without a DSHD1 header')
    return { ...header, data: chunk.subarray(header.headerLength) }
  })
  const total = parsed[0]?.total ?? 0
  const ordered = new Array(total)
  for (const chunk of parsed) {
    if (chunk.index >= total) throw new Error(`chunk index ${chunk.index} outside total ${total}`)
    ordered[chunk.index] = chunk.data
  }
  if (ordered.some((data) => data === undefined)) throw new Error('missing chunk')
  return Buffer.concat(ordered)
}

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
const CHUNK_BYTES = 16 * 1024
const proxy = createMuxProxy({
  getOrigin: () => `http://127.0.0.1:${upstreamPort}`,
  config: {
    muxCompression: true,
    muxCompressionLevel: 4,
    muxCompressionThresholdBytes: 1_024,
    stripStreamingReplay: true,
    muxChunkBytes: CHUNK_BYTES
  }
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

/** Send `hello` and collect downlink messages until `isDone(received)`. */
async function exchange({ path, isDone, timeoutMs = 15_000 }) {
  const client = await clientHandshake({
    host: '127.0.0.1',
    port: proxyPort,
    path,
    headers: { cookie: 'sid=abc123', host: 'junction-burke-solving-was.trycloudflare.com' },
    timeoutMs
  })
  const received = []
  let finish
  let done = false
  const collected = new Promise((resolve) => {
    finish = () => {
      if (done) return
      done = true
      resolve()
    }
    setTimeout(finish, timeoutMs)
  })
  const parser = new FrameParser({
    onMessage: (opcode, payload) => {
      received.push({ opcode, payload })
      if (isDone(received)) finish()
    },
    onControl: (opcode) => {
      if (opcode === OP.CLOSE) finish()
    }
  })
  if (client.leftover.length > 0) parser.push(client.leftover)
  client.socket.on('data', (chunk) => parser.push(chunk))
  client.socket.write(encodeFrame(OP.TEXT, Buffer.from('hello'), { mask: true }))
  await collected
  client.socket.destroy()
  return received
}

// ── compressed connection ──────────────────────────────────────────────────
const compressed = await exchange({
  path: '/remote-access/mux?deflate=1',
  isDone: (received) => received.some((frame) => frame.opcode === OP.TEXT)
})
check('upstream mux path is the gateway mux', upstreamPath === '/api/remote.mux', String(upstreamPath))
check('browser cookie reaches the upstream mux', upstreamCookie === 'sid=abc123', String(upstreamCookie))
check(
  'browser Host header reaches the upstream mux',
  upstreamHost === 'junction-burke-solving-was.trycloudflare.com',
  String(upstreamHost)
)
check('uplink text frame reaches the upstream mux', upstreamFrames.includes('hello'), upstreamFrames.join(','))
check('large frame arrives as binary chunks', compressed[0]?.opcode === OP.BINARY, String(compressed[0]?.opcode))

const binaryFrames = compressed.filter((frame) => frame.opcode === OP.BINARY)
const textFrames = compressed.filter((frame) => frame.opcode === OP.TEXT)
const parsedHeaders = binaryFrames.map((frame) => parseChunkHeader(frame.payload))
const totalChunks = parsedHeaders[0]?.total ?? 0
check('binary frames are DSHD1 chunks', parsedHeaders.every((header) => header !== null))
check('a large history frame spans several chunks', totalChunks > 1, String(totalChunks))
check('chunks carry the same total', parsedHeaders.every((header) => header?.total === totalChunks))
check(
  'chunks arrive in index order',
  parsedHeaders.every((header, index) => header?.index === index),
  parsedHeaders.map((header) => header?.index).join(',')
)
const inflated = binaryFrames.length === totalChunks ? zlib.inflateRawSync(reassemble(binaryFrames.map((frame) => frame.payload))).toString('utf8') : ''
check('reassembled + inflated frame equals the stripped JSON', inflated === EXPECTED_STRIPPED_TEXT, `${inflated.length}/${EXPECTED_STRIPPED_TEXT.length}`)
const inflatedFrame = inflated ? JSON.parse(inflated) : null
const inflatedMessages = (inflatedFrame?.value?.records ?? []).filter((record) => record?.event?.type === 'assistant/message')
check('stripped window: every replay stream is empty', inflatedMessages.length === ASSISTANT_MESSAGES && inflatedMessages.every((record) => record.event.data.stream.length === 0))
check('stripped window: every data.usage is preserved', inflatedMessages.every((record) => record.event.data.usage?.totalTokens > 0))
check(
  'stripped window: other records are untouched',
  JSON.stringify(inflatedFrame?.value?.records?.slice(0, otherRecords.length)) === JSON.stringify(otherRecords)
)
check('small frame stays plain text', textFrames.length === 1 && textFrames[0].payload.toString('utf8') === SMALL_TEXT)
const wireBytes = compressed.reduce((sum, frame) => sum + frame.payload.length, 0)
check('chunked frame is smaller than the text frame', wireBytes < Buffer.byteLength(BIG_TEXT), `${wireBytes}/${Buffer.byteLength(BIG_TEXT)}`)

// ── uncompressed connection (no ?deflate=1) ────────────────────────────────
const plain = await exchange({
  path: '/remote-access/mux',
  isDone: (received) => received.length >= 2
})
check('without ?deflate=1 a large frame stays text', plain[0]?.opcode === OP.TEXT)
check('uncompressed large frame is not stripped', plain[0]?.payload.toString('utf8') === BIG_TEXT)

// ── pipeline fallback (the producer cannot break the connection) ───────────
const original = Buffer.from(BIG_TEXT)
const stripFailure = await encodeDownlinkFrame({
  payload: original,
  stripper: () => {
    throw new Error('strip exploded')
  }
})
check(
  'strip failure falls back to the original text frame',
  stripFailure.fallback === true &&
    stripFailure.frames.length === 1 &&
    stripFailure.frames[0].opcode === OP.TEXT &&
    stripFailure.frames[0].payload.equals(original)
)
const deflateFailure = await encodeDownlinkFrame({
  payload: original,
  deflate: async () => {
    throw new Error('deflate exploded')
  }
})
check(
  'deflate failure falls back to the original text frame',
  deflateFailure.fallback === true &&
    deflateFailure.frames.length === 1 &&
    deflateFailure.frames[0].opcode === OP.TEXT &&
    deflateFailure.frames[0].payload.equals(original)
)
check(
  'fallback reports the original frame as its wire size',
  deflateFailure.wireBytes === original.length && deflateFailure.compressedBytes === 0
)
const optimised = await encodeDownlinkFrame({ payload: original, chunkBytes: CHUNK_BYTES })
check('the real pipeline strips and chunks', optimised.fallback === false && optimised.strippedStreams === ASSISTANT_MESSAGES && optimised.frames.every((frame) => frame.opcode === OP.BINARY))
check(
  'the real pipeline reports the wire size it produced',
  optimised.wireBytes === optimised.frames.reduce((sum, frame) => sum + frame.payload.length, 0)
)

// ── counters ───────────────────────────────────────────────────────────────
await new Promise((resolve) => setTimeout(resolve, 150))
const stats = proxy.stats()
check('two proxied connections are counted', stats.connections === 2, String(stats.connections))
check('one compressed frame is counted', stats.compressedFrames === 1, String(stats.compressedFrames))
check('one chunked frame is counted', stats.chunkedFrames === 1, String(stats.chunkedFrames))
check('every chunk sent is counted', stats.chunksSent === totalChunks, `${stats.chunksSent}/${totalChunks}`)
check('the stripped window is counted', stats.strippedFrames === 1 && stats.strippedStreams === ASSISTANT_MESSAGES, `${stats.strippedFrames}/${stats.strippedStreams}`)
check('stripped bytes are counted', stats.strippedBytes > 0, String(stats.strippedBytes))
check('no optimisation fell back', stats.fallbackFrames === 0, String(stats.fallbackFrames))
check('downlink raw bytes cover all upstream frames', stats.downlinkRawBytes >= Buffer.byteLength(BIG_TEXT) * 2 + SMALL_TEXT.length * 2)
check('downlink wire bytes are below the raw bytes', stats.downlinkWireBytes > 0 && stats.downlinkWireBytes < stats.downlinkRawBytes)
check('compressed bytes are less than raw bytes', stats.compressedBytes > 0 && stats.compressedBytes < stats.downlinkRawBytes)
check('active connections are back to zero', stats.activeConnections === 0, String(stats.activeConnections))
check('recent frame samples are recorded', stats.recentFrames.length > 0)
check(
  'recent frame samples record the chunk count',
  stats.recentFrames.some((sample) => sample.chunks === totalChunks && sample.stripped === ASSISTANT_MESSAGES),
  JSON.stringify(stats.recentFrames.map((sample) => sample.chunks))
)

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
