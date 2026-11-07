/**
 * Unit test for lib/stream-strip.js — the history-window downlink optimiser.
 *
 * Proves the contract the mux proxy relies on:
 *
 *   - `data.stream` on replayed `assistant/message` history records is
 *     neutralised to `[]`, while `data.usage`, `data.message` and every other
 *     field survive byte-for-byte after JSON round-tripping,
 *   - events the client renders from the replay (user/message, assistant/attempt,
 *     tool/result, …) are untouched,
 *   - records without `data.usage` keep their replay stream (usage fallback),
 *   - frames with nothing to strip are returned as the identical string, so the
 *     proxy can treat "same string" as "no optimisation",
 *   - both gateway payload shapes are handled: a bare `{type:'snapshot',…}`
 *     value and the mux stream item wrapper `{type:'item', value:{…}}`.
 *
 * When the real 2.6 MB sample is present the test also measures the actual
 * window: it is not required for the offline suite (the file lives outside the
 * repo) but it is the number the change is justified by.
 *
 * Run:  test/run-tests.sh            (or)
 *       node test/stream-strip-unit.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { stripStreamingReplay, stripStreamingReplayDetailed } from '../lib/stream-strip.js'

const failures = []
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`)
}

/** A realistic assistant/message replayed event. */
function assistantMessage(seq, { usage = true, stream = true } = {}) {
  const data = {
    turn: 1,
    step: seq,
    message: { role: 'assistant', content: [{ type: 'text', text: 'answer '.repeat(4) }] }
  }
  if (usage) data.usage = { inputTokens: 11, outputTokens: 22, totalTokens: 33, cacheReadTokens: 0 }
  if (stream) {
    data.stream = [
      { type: 'chunk', time: 1_700_000_000_000, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'reasoning-chunks', time0: 1_700_000_000_001, index: 0, dt: [4, 5], texts: ['thinking…', 'more'] }
    ]
  }
  return { type: 'event', event: { type: 'assistant/message', seq, time: 1_700_000_000_000, data, surfaceOp: null } }
}

/**
 * @param {{ wrapper?: boolean }} [options]
 * @returns {string} a snapshot frame with a mix of records
 */
function snapshotText({ wrapper = true } = {}) {
  const records = [
    assistantMessage(0),
    { type: 'event', event: { type: 'user/message', seq: 1, data: { message: 'hi', stream: [{ type: 'chunk' }] } } },
    assistantMessage(2, { usage: false }),
    { type: 'event', event: { type: 'assistant/attempt', seq: 3, data: { usage: { inputTokens: 1 }, stream: [{ type: 'chunk', text: 'x' }] } } },
    { type: 'event', event: { type: 'tool/result', seq: 4, data: { result: 'ok'.repeat(20) } } },
    assistantMessage(5)
  ]
  const value = {
    type: 'snapshot',
    header: { version: 4, id: 'session-1', createdAt: 1_700_000_000_000, cwd: '/tmp', isSeeded: true },
    projections: { asOfSeq: 6, values: {} },
    cursor: 1869,
    records,
    hasMore: true,
    assistantStream: { revision: 72_186 }
  }
  return JSON.stringify(wrapper ? { type: 'item', streamId: 'stream-1', value } : value)
}

// ── the happy path ─────────────────────────────────────────────────────────
const originalText = snapshotText()
const original = JSON.parse(originalText)
const strippedText = stripStreamingReplay(originalText)
const stripped = JSON.parse(strippedText)
const records = stripped.value.records

check('stripping produces different JSON', strippedText !== originalText)
check('replayed stream is neutralised to an empty array', Array.isArray(records[0].event.data.stream) && records[0].event.data.stream.length === 0)
check('data.usage survives stripping', records[0].event.data.usage?.totalTokens === 33)
check('data.message survives stripping', records[0].event.data.message.content[0].text === 'answer answer answer answer ')
check(
  'an assistant/message without data.usage keeps its replay stream',
  records[2].event.data.stream.length === 2
)
check(
  'assistant/attempt events keep their replay stream',
  records[3].event.data.stream.length === 1
)
check(
  'user/message events keep their stream field',
  records[1].event.data.stream.length === 1
)
check('other record types are untouched', records[4].event.data.result === 'ok'.repeat(20))
check('record order and count are preserved', stripped.value.records.length === original.value.records.length)
check('non-record snapshot fields are unchanged', stripped.value.cursor === 1_869 && stripped.value.hasMore === true)

// Everything except the neutralised streams must deep-equal the input.
const expected = JSON.parse(originalText)
expected.value.records[0].event.data.stream = []
expected.value.records[5].event.data.stream = []
check('only stream arrays changed', JSON.stringify(stripped) === JSON.stringify(expected))

const detailed = stripStreamingReplayDetailed(originalText)
check('detailed result counts two neutralised streams', detailed.removedStreams === 2, String(detailed.removedStreams))
check('detailed result reports a positive byte win', detailed.removedBytes > 0, String(detailed.removedBytes))
check('detailed result agrees with the plain helper', detailed.text === strippedText)

// ── idempotence and no-op frames ───────────────────────────────────────────
check('stripping twice is idempotent', stripStreamingReplay(strippedText) === strippedText)
check('a bare snapshot value is stripped too', JSON.parse(stripStreamingReplay(snapshotText({ wrapper: false }))).records[0].event.data.stream.length === 0)
check('a nested result/output container is stripped', (() => {
  const text = JSON.stringify({
    type: 'result',
    output: { records: [assistantMessage(0)] }
  })
  const parsed = JSON.parse(stripStreamingReplay(text))
  return parsed.output.records[0].event.data.stream.length === 0
})())

const emptyStreamRecord = assistantMessage(0)
emptyStreamRecord.event.data.stream = []
const noopCases = {
  'plain JSON without assistant/message': JSON.stringify({ type: 'ack', value: 1 }),
  'malformed JSON': '{not json',
  'empty string': '',
  'already stripped history': strippedText,
  'assistant/message without usage': JSON.stringify({
    type: 'item',
    streamId: 'stream-1',
    value: { type: 'snapshot', records: [assistantMessage(0, { usage: false })] }
  }),
  'assistant/message with an empty stream': JSON.stringify({
    type: 'item',
    streamId: 'stream-1',
    value: { type: 'snapshot', records: [emptyStreamRecord] }
  })
}
for (const [name, text] of Object.entries(noopCases)) {
  check(`no-op keeps the identical string: ${name}`, stripStreamingReplay(text) === text)
}
const nonString = { not: 'a string' }
check('non-string input is returned unchanged', stripStreamingReplay(nonString) === nonString)

// ── real 817-record window (optional) ──────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url))
const samplePath = path.resolve(here, '../../.tmp/e2e/bigframe-local-2.json')
if (existsSync(samplePath)) {
  const raw = readFileSync(samplePath, 'utf8')
  const result = stripStreamingReplayDetailed(raw)
  const frame = JSON.parse(result.text)
  const historyRecords = frame.value?.records ?? []
  const assistantMessages = historyRecords.filter((record) => record?.event?.type === 'assistant/message')
  check('real window: every assistant/message stream is empty', assistantMessages.every((record) => Array.isArray(record.event.data.stream) && record.event.data.stream.length === 0))
  check('real window: every data.usage is preserved', assistantMessages.every((record) => record.event.data.usage !== undefined && typeof record.event.data.usage === 'object'))
  check(
    'real window: raw JSON shrinks by at least 40%',
    Buffer.byteLength(result.text) <= Buffer.byteLength(raw) * 0.6,
    `${Buffer.byteLength(raw)} -> ${Buffer.byteLength(result.text)}`
  )
  const originalFrame = JSON.parse(raw)
  const stripStreams = (value) => {
    for (const record of value.value?.records ?? []) {
      if (record?.event?.type === 'assistant/message') record.event.data.stream = []
    }
  }
  stripStreams(originalFrame)
  check('real window: nothing but stream arrays changed', JSON.stringify(frame) === JSON.stringify(originalFrame))
  const removedBytes = result.removedBytes
  console.log(
    `     real window: ${Buffer.byteLength(raw)} B -> ${Buffer.byteLength(result.text)} B raw ` +
      `(${(100 * (1 - Buffer.byteLength(result.text) / Buffer.byteLength(raw))).toFixed(1)}% smaller, ` +
      `${result.removedStreams} streams, ${removedBytes} B removed)`
  )
} else {
  console.log(`skip real window sample (${samplePath} missing)`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('\nstream strip passed')
