/**
 * Strip replayed assistant streams from a mux downlink frame.
 *
 * Why this exists
 * ---------------
 * A conversation switch downloads the initial history window as one JSON
 * WebSocket frame. Every replayed `assistant/message` event in that window
 * carries `data.stream`: the recorded sequence of streaming events (block
 * starts, reasoning chunks, text deltas) that the UI already collapsed into
 * `data.message`. On a real 817-record window it is ~50% of the frame —
 * 1.25 MB of 2.53 MB of JSON — while `data.message` and `data.usage` are the
 * only fields the client renders from history. Live streaming is not affected:
 * this only runs on downlink JSON, and only on the history window records.
 *
 * Why the field is emptied instead of deleted
 * -------------------------------------------
 * `@deepseek-ai/dsh-api-session-controller`'s trajectory fold calls
 * `assistantStreamFirstTokenTime(event.data.stream)`, which iterates the array
 * unguarded (`for (const record of stream)`). A deleted field throws a
 * `TypeError` there and takes the trajectory panel down. `[]` costs 13 bytes
 * per event (~1.5 KB in a 2.6 MB window, 0.06%) and iterates safely, so the
 * stream stays neutralised rather than absent.
 *
 * Contract: pure, never throws, and returns the original string unchanged
 * whenever there is nothing to neutralise (non-JSON, non-history frames, or
 * already-stripped JSON), so callers can measure the win by length alone.
 */

const ASSISTANT_MESSAGE = 'assistant/message'

/**
 * Frames arrive either as the bare gateway payload (`{type:'snapshot',...}`)
 * or wrapped as a mux stream item (`{type:'item', streamId, value:{...}}`).
 * Record arrays live under one of these containers; walking only known
 * container keys keeps unrelated payload objects untouched.
 */
const CONTAINER_KEYS = ['value', 'output', 'result', 'page', 'data']
const MAX_CONTAINER_DEPTH = 3

/**
 * @param {string} text downlink text frame
 * @returns {string} the frame to send, or `text` itself when nothing was stripped
 */
export function stripStreamingReplay(text) {
  return stripStreamingReplayDetailed(text).text
}

/**
 * Same as {@link stripStreamingReplay} but also reports what changed, for the
 * proxy's status counters.
 *
 * @param {string} text downlink text frame
 * @returns {{ text: string, removedStreams: number, removedBytes: number }}
 */
export function stripStreamingReplayDetailed(text) {
  const unchanged = { text, removedStreams: 0, removedBytes: 0 }
  if (typeof text !== 'string') return unchanged
  // Cheap pre-filter: without an assistant/message event there is no replay to
  // neutralise, and most downlink frames (RPC replies, acks, small events) hit
  // neither marker. Keeps the JSON.parse cost off the hot path.
  if (!text.includes(ASSISTANT_MESSAGE) || !text.includes('"stream"')) return unchanged

  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    return unchanged
  }

  const removed = stripFrame(frame)
  if (removed.removedStreams === 0) return unchanged
  return {
    text: JSON.stringify(frame),
    removedStreams: removed.removedStreams,
    removedBytes: removed.removedBytes
  }
}

/**
 * @param {unknown} frame parsed downlink frame
 * @returns {{ removedStreams: number, removedBytes: number }}
 */
function stripFrame(frame) {
  const totals = { removedStreams: 0, removedBytes: 0 }
  const seen = new Set()

  /** @param {unknown} node @param {number} depth */
  const visit = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > MAX_CONTAINER_DEPTH) return
    // JSON.parse cannot produce cycles, but a caller may hand us a live object.
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node.records)) stripRecords(node.records, totals)
    for (const key of CONTAINER_KEYS) visit(node[key], depth + 1)
  }

  visit(frame, 0)
  return totals
}

/**
 * Neutralise the replay stream on history records only.
 *
 * @param {unknown[]} records
 * @param {{ removedStreams: number, removedBytes: number }} totals
 */
function stripRecords(records, totals) {
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const event = record.event
    if (event === null || typeof event !== 'object') continue
    if (event.type !== ASSISTANT_MESSAGE) continue
    const data = event.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    // `data.usage` is the client's primary usage source and a stream replay is
    // its fallback. Keep the replay when usage is missing so no information is
    // lost on frames from older/other producers.
    if (!Object.hasOwn(data, 'stream') || !Object.hasOwn(data, 'usage') || data.usage === undefined) continue
    const stream = data.stream
    if (!Array.isArray(stream) || stream.length === 0) continue
    const serialized = JSON.stringify(stream)
    totals.removedBytes += Buffer.byteLength(serialized, 'utf8') - 2 // "[]" replaces the array text
    totals.removedStreams += 1
    data.stream = []
  }
}
