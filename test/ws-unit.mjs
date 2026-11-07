/**
 * RFC 6455 primitives used by `/remote-access/mux`, without any Host, tunnel or
 * third-party WebSocket package: handshake tokens, frame codec (including
 * fragmentation and 64-bit lengths), control frames and the client upgrade.
 *
 * Run:  test/run-tests.sh            (or)
 *       node test/ws-unit.mjs
 */
import http from 'node:http'

import {
  acceptKey,
  clientHandshake,
  closePayload,
  encodeFrame,
  FrameParser,
  isWebSocketUpgrade,
  OP,
  parseClosePayload,
  rejectUpgrade,
  writeUpgradeResponse
} from '../lib/ws.js'

const failures = []
const results = []

function check(name, condition, detail) {
  results.push([name, Boolean(condition)])
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** @returns {{messages: string[], frames: Array<{opcode: number, payload: Buffer}>, controls: Array<{opcode: number, data: string}>, errors: string[]}} */
function collect(chunks) {
  const messages = []
  const frames = []
  const controls = []
  const errors = []
  const parser = new FrameParser({
    onMessage: (opcode, payload) => {
      frames.push({ opcode, payload })
      messages.push(payload.toString('utf8'))
    },
    onControl: (opcode, payload) => controls.push({ opcode, data: payload.toString('utf8') }),
    onError: (error) => errors.push(error?.message ?? String(error))
  })
  for (const chunk of chunks) parser.push(chunk)
  return { messages, frames, controls, errors }
}

// ── handshake token ────────────────────────────────────────────────────────
check('acceptKey matches the RFC 6455 example', acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')

// ── frame codec ────────────────────────────────────────────────────────────
check('small text frame round-trips (server, unmasked)', collect([encodeFrame(OP.TEXT, Buffer.from('hello'))]).messages.join() === 'hello')
check('small text frame round-trips (client, masked)', collect([encodeFrame(OP.TEXT, Buffer.from('hello'), { mask: true })]).messages.join() === 'hello')

const fragmented = collect([
  encodeFrame(OP.TEXT, Buffer.from('he'), { fin: false }),
  encodeFrame(OP.CONT, Buffer.from('llo'), { fin: true })
])
check('fragmented message is reassembled', fragmented.messages.join('|') === 'hello', fragmented.messages.join('|'))

const binary = collect([encodeFrame(OP.BINARY, Buffer.from([0, 1, 2, 255]))])
check(
  'binary frame keeps its bytes',
  binary.frames.length === 1 &&
    binary.frames[0].opcode === OP.BINARY &&
    binary.frames[0].payload.equals(Buffer.from([0, 1, 2, 255]))
)

const ping = collect([encodeFrame(OP.PING, Buffer.from('p'))])
check('ping surfaces as a control frame', ping.controls.length === 1 && ping.controls[0].opcode === OP.PING && ping.controls[0].data === 'p')

const large = Buffer.alloc(70_000, 0x61)
const largeFrames = collect([encodeFrame(OP.TEXT, large)])
check('64-bit extended length survives', largeFrames.messages[0]?.length === 70_000, String(largeFrames.messages[0]?.length))

check('unknown opcode is rejected', collect([encodeFrame(0x3, Buffer.from('x'))]).errors.length === 1)

const close = closePayload(1000, 'bye')
const parsedClose = parseClosePayload(close)
check('close payload round-trips', parsedClose.code === 1000 && parsedClose.reason === 'bye')

check(
  'isWebSocketUpgrade needs method + upgrade + key',
  isWebSocketUpgrade({ method: 'GET', headers: { upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'abc' } }) === true &&
    isWebSocketUpgrade({ method: 'POST', headers: { upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'abc' } }) === false
)

// ── client handshake against a real upgrade socket ─────────────────────────
const server = http.createServer((_req, res) => {
  res.writeHead(404)
  res.end()
})
server.on('upgrade', (req, socket) => {
  if (req.url === '/ok') {
    writeUpgradeResponse(socket, req)
    socket.write(encodeFrame(OP.TEXT, Buffer.from('welcome')))
    return
  }
  rejectUpgrade(socket, 403, 'Forbidden')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const accepted = await clientHandshake({ host: '127.0.0.1', port, path: '/ok', headers: { cookie: 'sid=1' }, timeoutMs: 2_000 })
check('clientHandshake accepts 101', accepted.status === 101)
const welcome = collect([accepted.leftover ?? Buffer.alloc(0)])
if (welcome.messages.length === 0) {
  // The frame may arrive right after the handshake response instead of with it.
  await new Promise((resolve) => {
    const parser = new FrameParser({
      onMessage: (opcode, payload) => {
        welcome.messages.push(payload.toString('utf8'))
        resolve()
      }
    })
    accepted.socket.on('data', (chunk) => parser.push(chunk))
    setTimeout(resolve, 2_000)
  })
}
check('upstream frames arriving right after the 101 are kept', welcome.messages.join() === 'welcome', welcome.messages.join())

let refused = null
try {
  await clientHandshake({ host: '127.0.0.1', port, path: '/no', timeoutMs: 2_000 })
} catch (error) {
  refused = error
}
check('clientHandshake rejects a non-101 upgrade', refused !== null && /403/.test(String(refused?.message)), String(refused?.message))

server.close()
if (accepted.socket) accepted.socket.destroy()

// ── report ─────────────────────────────────────────────────────────────────
for (const [name, ok] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\n${results.length} checks passed`)
