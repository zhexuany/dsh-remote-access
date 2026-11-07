/**
 * `DSHD1` chunk framing for compressed mux downlink frames.
 *
 * A 2.6 MB history window deflates to a few hundred KB, but it still leaves as
 * a single WebSocket frame. Cloudflare quick tunnels (and some middleboxes) cap
 * how much of one frame they buffer, and a single large frame also gives the
 * client no progress signal. The proxy therefore splits the compressed payload
 * into bounded chunks, each prefixed with a small ASCII header:
 *
 *   `DSHD1 <idx> <total>\n` + raw deflate-raw bytes
 *
 * `idx` is zero-based and `total` is the number of chunks for that frame; the
 * client buffers chunks until `total` are present, concatenates them in `idx`
 * order and inflates the result. The header is always present, even for a
 * single chunk (`total=1`), so the client can tell compressed chunks apart from
 * the legacy whole-frame binary frames that carry no header.
 *
 * The header stays ASCII so it can be scanned with a byte comparison before
 * any decompression, and its fields are parsed with a strict regex: a frame is
 * either a well-formed chunk or it is not a chunk at all (legacy frame).
 */

export const CHUNK_MAGIC = 'DSHD1'
export const DEFAULT_CHUNK_BYTES = 256 * 1024
export const MIN_CHUNK_BYTES = 16 * 1024
export const MAX_CHUNK_BYTES = 1024 * 1024
// A frame only ever needs ~4k chunks at the minimum chunk size for the 64 MB
// downlink cap; the bound keeps a hostile/garbled header from allocating huge
// arrays on the client half.
export const MAX_CHUNKS = 65_536

const HEADER_PREFIX = `${CHUNK_MAGIC} `
const HEADER_PATTERN = /^DSHD1 (\d{1,7}) (\d{1,7})\n/

/**
 * @param {number} index zero-based chunk index
 * @param {number} total total chunk count for the frame
 * @returns {Buffer} ASCII header including the trailing newline
 */
export function encodeChunkHeader(index, total) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`invalid chunk index: ${index}`)
  if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) throw new RangeError(`invalid chunk total: ${total}`)
  if (index >= total) throw new RangeError(`chunk index ${index} is outside total ${total}`)
  return Buffer.from(`${HEADER_PREFIX}${index} ${total}\n`, 'ascii')
}

/**
 * Parse a chunk header. Returns `null` for anything that is not a well-formed
 * `DSHD1` header, which is how the client detects "legacy" binary frames.
 *
 * @param {Buffer|Uint8Array|string} input
 * @returns {{ index: number, total: number, headerLength: number } | null}
 */
export function parseChunkHeader(input) {
  const buffer = toBuffer(input)
  if (buffer === null) return null
  if (buffer.length < HEADER_PREFIX.length + 3) return null
  const match = HEADER_PATTERN.exec(buffer.toString('latin1', 0, Math.min(buffer.length, HEADER_PREFIX.length + 16)))
  if (match === null) return null
  const index = Number(match[1])
  const total = Number(match[2])
  if (!Number.isInteger(index) || !Number.isInteger(total)) return null
  if (total < 1 || total > MAX_CHUNKS || index >= total) return null
  return { index, total, headerLength: match[0].length }
}

/**
 * Split a compressed downlink payload into `DSHD1` chunks. Always returns at
 * least one chunk (a header-only chunk for an empty payload) and never mutates
 * the input.
 *
 * @param {Buffer|Uint8Array} payload compressed (deflate-raw) bytes
 * @param {number} [chunkBytes] maximum chunk data size, clamped to the range
 * @returns {Buffer[]} chunk frames in send order
 */
export function chunkCompressedFrame(payload, chunkBytes = DEFAULT_CHUNK_BYTES) {
  const buffer = toBuffer(payload)
  if (buffer === null) throw new TypeError('chunkCompressedFrame expects a Buffer or Uint8Array')
  const size = clampChunkBytes(chunkBytes)
  const total = Math.max(1, Math.ceil(buffer.length / size))
  if (total > MAX_CHUNKS) throw new RangeError(`payload needs ${total} chunks, limit is ${MAX_CHUNKS}`)
  const chunks = new Array(total)
  for (let index = 0; index < total; index += 1) {
    const start = index * size
    const end = Math.min(start + size, buffer.length)
    const header = encodeChunkHeader(index, total)
    chunks[index] = Buffer.concat([header, buffer.subarray(start, end)])
  }
  return chunks
}

/**
 * Clamp a configured chunk size to the supported range.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampChunkBytes(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_CHUNK_BYTES
  return Math.max(MIN_CHUNK_BYTES, Math.min(MAX_CHUNK_BYTES, Math.round(number)))
}

/**
 * @param {unknown} value
 * @returns {Buffer | null}
 */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return null
}
