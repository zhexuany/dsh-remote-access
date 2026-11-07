/**
 * Unit test for lib/mux-chunk.js — the `DSHD1` downlink chunk protocol.
 *
 * Proves the wire contract shared with client.js:
 *
 *   - header encoding/parsing is exact, zero-based, and rejects malformed or
 *     out-of-range headers (which is how the client detects legacy frames),
 *   - chunks cover the payload exactly once and in index order, for boundary
 *     sizes (one byte under/at/over a chunk, many chunks, empty payload),
 *   - a chunked payload reassembles byte-identically before inflating, so the
 *     deflate-raw round trip through the wire format is lossless,
 *   - the configured chunk size is clamped to the supported range.
 *
 * Run:  test/run-tests.sh            (or)
 *       node test/mux-chunk-unit.mjs
 */
import { randomBytes } from 'node:crypto'
import zlib from 'node:zlib'

import {
  CHUNK_MAGIC,
  DEFAULT_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNKS,
  MIN_CHUNK_BYTES,
  chunkCompressedFrame,
  clampChunkBytes,
  encodeChunkHeader,
  parseChunkHeader
} from '../lib/mux-chunk.js'

const failures = []
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`)
}

/** Reassemble chunks the way client.js does: parse, order by index, concat. */
function reassemble(chunks) {
  const parsed = chunks.map((chunk) => {
    const header = parseChunkHeader(chunk)
    if (header === null) throw new Error('chunk without a DSHD1 header')
    return { ...header, data: chunk.subarray(header.headerLength) }
  })
  const total = parsed[0]?.total ?? 0
  const ordered = new Array(total)
  for (const chunk of parsed) {
    if (chunk.total !== total) throw new Error(`inconsistent total: ${chunk.total} vs ${total}`)
    if (ordered[chunk.index] !== undefined) throw new Error(`duplicate chunk ${chunk.index}`)
    ordered[chunk.index] = chunk.data
  }
  if (ordered.some((data) => data === undefined)) throw new Error('missing chunk')
  return Buffer.concat(ordered)
}

/** @param {number} bytes deterministic, weakly-compressible payload */
function payloadOf(bytes) {
  const buffer = Buffer.allocUnsafe(bytes)
  let state = 0x9e3779b9
  for (let index = 0; index < bytes; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    buffer[index] = state & 0xff
  }
  return buffer
}

// ── header encoding ────────────────────────────────────────────────────────
check('magic is the documented ASCII marker', CHUNK_MAGIC === 'DSHD1')
check('default chunk size is 256 KB', DEFAULT_CHUNK_BYTES === 262_144)
check('chunk range is 16 KB .. 1 MB', MIN_CHUNK_BYTES === 16_384 && MAX_CHUNK_BYTES === 1_048_576)
check('single-chunk header is `DSHD1 0 1\\n`', encodeChunkHeader(0, 1).toString('ascii') === 'DSHD1 0 1\n')
check('multi-digit header is decimal', encodeChunkHeader(42, 1_000).toString('ascii') === 'DSHD1 42 1000\n')
check('header is pure ASCII', encodeChunkHeader(7, 9).every((byte) => byte < 0x80))

for (const [index, total] of [[-1, 1], [1, 1], [0, 0], [0, MAX_CHUNKS + 1], [0.5, 2]]) {
  let threw = false
  try {
    encodeChunkHeader(index, total)
  } catch {
    threw = true
  }
  check(`encode rejects index=${index} total=${total}`, threw)
}

// ── header parsing ─────────────────────────────────────────────────────────
const header = encodeChunkHeader(3, 5)
check('parse round-trips the header', (() => {
  const parsed = parseChunkHeader(Buffer.concat([header, Buffer.from('data')]))
  return parsed?.index === 3 && parsed?.total === 5 && parsed?.headerLength === header.length
})())

const invalidHeaders = [
  ['empty buffer', Buffer.alloc(0)],
  ['non-DSHD1 bytes', Buffer.from('GET / HTTP/1.1\r\n')],
  ['no newline', Buffer.from('DSHD1 0 1')],
  ['non-decimal index', Buffer.from('DSHD1 x 1\n')],
  ['index beyond total', Buffer.from('DSHD1 1 1\n')],
  ['zero total', Buffer.from('DSHD1 0 0\n')],
  ['total beyond limit', Buffer.from(`DSHD1 0 ${MAX_CHUNKS + 1}\n`)],
  ['lowercase magic', Buffer.from('dshd1 0 1\n')],
  ['legacy binary frame', Buffer.from([0x78, 0x9c, 0x00, 0x00])]
]
for (const [name, buffer] of invalidHeaders) {
  check(`parse rejects ${name}`, parseChunkHeader(buffer) === null)
}
check('parse accepts a header-only chunk', (() => {
  const parsed = parseChunkHeader(encodeChunkHeader(0, 1))
  return parsed?.index === 0 && parsed?.total === 1 && parsed?.headerLength === 10
})())
check('parse accepts string input', parseChunkHeader('DSHD1 1 2\nrest')?.index === 1)

// ── chunking boundaries ────────────────────────────────────────────────────
const size = MIN_CHUNK_BYTES
const boundaryCases = [
  ['one byte under a chunk', size - 1, 1],
  ['exactly one chunk', size, 1],
  ['one byte over a chunk', size + 1, 2],
  ['three chunks plus a tail', size * 3 + 5, 4],
  ['empty payload', 0, 1]
]
for (const [name, bytes, expectedChunks] of boundaryCases) {
  const payload = payloadOf(bytes)
  const chunks = chunkCompressedFrame(payload, size)
  check(`${name}: chunk count`, chunks.length === expectedChunks, `${chunks.length} vs ${expectedChunks}`)
  check(`${name}: every chunk carries total=${expectedChunks}`, chunks.every((chunk) => parseChunkHeader(chunk)?.total === expectedChunks))
  check(`${name}: indices are zero-based and ordered`, chunks.every((chunk, index) => parseChunkHeader(chunk)?.index === index))
  check(`${name}: chunk data never exceeds the chunk size`, chunks.every((chunk) => {
    const parsed = parseChunkHeader(chunk)
    return chunk.length - (parsed?.headerLength ?? 0) <= size
  }))
  check(`${name}: reassembly is byte-identical`, reassemble(chunks).equals(payload))
}

// ── deflate-raw round trip through the wire format ─────────────────────────
const jsonFrame = Buffer.from(JSON.stringify({
  type: 'item',
  streamId: 'stream-1',
  value: { type: 'snapshot', records: Array.from({ length: 200 }, (_, index) => ({ seq: index, text: 'history '.repeat(8) })) }
}), 'utf8')
const jsonChunks = chunkCompressedFrame(zlib.deflateRawSync(jsonFrame, { level: 4 }), size)
check(
  'inflate(reassemble(chunks)) equals the JSON frame',
  zlib.inflateRawSync(reassemble(jsonChunks)).toString('utf8') === jsonFrame.toString('utf8')
)

const incompressible = randomBytes(200_000)
const compressed = zlib.deflateRawSync(incompressible, { level: 4 })
const chunks = chunkCompressedFrame(compressed, size)
check('a ~200 KB compressed frame spans multiple chunks', chunks.length > 1, String(chunks.length))
check(
  'multi-chunk inflate(reassemble(chunks)) is byte-identical',
  zlib.inflateRawSync(reassemble(chunks)).equals(incompressible)
)
check(
  'chunks are produced in send order',
  chunks.every((chunk, index) => parseChunkHeader(chunk).index === index)
)
check(
  'wire overhead is exactly the header',
  chunks.every((chunk) => chunk.length === parseChunkHeader(chunk).headerLength + Math.min(size, compressed.length - parseChunkHeader(chunk).index * size))
)

// ── clamping ───────────────────────────────────────────────────────────────
check('clamp: below the minimum becomes the minimum', clampChunkBytes(1) === MIN_CHUNK_BYTES)
check('clamp: above the maximum becomes the maximum', clampChunkBytes(2 ** 30) === MAX_CHUNK_BYTES)
check('clamp: missing value uses the default', clampChunkBytes(undefined) === DEFAULT_CHUNK_BYTES)
check('clamp: non-numeric value uses the default', clampChunkBytes('not a number') === DEFAULT_CHUNK_BYTES)
check('clamp: rounds to an integer', clampChunkBytes(size + 0.6) === size + 1)
check('chunking clamps an out-of-range size instead of trusting it', (() => {
  const clamped = chunkCompressedFrame(payloadOf(10), 1)
  return clamped.length === 1 && parseChunkHeader(clamped[0])?.total === 1
})())

let threw = false
try {
  chunkCompressedFrame(123)
} catch (error) {
  threw = error instanceof TypeError
}
check('chunking rejects a non-byte payload', threw)

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('\nmux chunk passed')
