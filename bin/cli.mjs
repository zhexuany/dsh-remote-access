#!/usr/bin/env node
/**
 * `dsh-remote-access` CLI — drives the running plugin over its loopback control
 * socket (token file `<home>/remote-access/control.json`, mode 0600). Falls back
 * to reading the persisted state/link when the app is not running.
 *
 *   dsh-remote-access status
 *   dsh-remote-access link
 *   dsh-remote-access start|stop|restart
 *   dsh-remote-access logs
 *   dsh-remote-access browser-access          (informational: the switch is gone)
 *   dsh-remote-access open
 */
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import os from 'node:os'
import path from 'node:path'

const ACTIONS = new Set(['status', 'link', 'start', 'stop', 'restart', 'logs', 'browser-access', 'open'])

function resolveHome(explicit) {
  const candidate =
    explicit ||
    process.env.DSH_HOME ||
    process.env.DSH_NEXT_HOME ||
    path.join(os.homedir(), '.dsh')
  return path.resolve(candidate.replace(/^~(?=$|\/)/, os.homedir()))
}

function parseArgs(argv) {
  const options = { action: undefined, home: undefined, json: false, timeout: 60000, help: false, enabled: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[(index += 1)]
    if (arg === '--home') options.home = next()
    else if (arg === '--json') options.json = true
    else if (arg === '--timeout') options.timeout = Number(next())
    else if (arg === '--enable' || arg === '--on') options.enabled = true
    else if (arg === '--disable' || arg === '--off') options.enabled = false
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg.startsWith('-')) throw new Error(`unknown flag "${arg}"`)
    else if (!options.action) options.action = arg
    else throw new Error(`unexpected argument "${arg}"`)
  }
  return options
}

const USAGE = `dsh-remote-access — 管理 DSH 远程协作隧道

Usage: dsh-remote-access <status|link|start|stop|restart|logs|browser-access|open> [--home <dir>] [--json]

  status           查看隧道状态、公网地址和可分享链接
  link             只打印可分享链接
  start            启动隧道
  stop             停止隧道
  restart          重启隧道（会换一个新的公网地址）
  logs             打印插件最近的日志
  browser-access   说明：DSH Desktop 0.2.1-rc.3 已没有「允许在浏览器中打开」开关，
                   分享链接本来就带令牌、隧道域名也已加入 trustedHosts，
                   任何浏览器直接打开即可。保留这个动作只为兼容旧脚本。
    --enable       旧参数，仍然接受，但什么也不会切换
    --disable      旧参数，仍然接受，但什么也不会切换
  open             在本机浏览器里打开分享链接
`

function readJson(file) {
  return readFile(file, 'utf8').then(JSON.parse)
}

async function controlCredentials(remoteDir) {
  try {
    const parsed = await readJson(path.join(remoteDir, 'control.json'))
    if (!parsed?.port || !parsed?.token) return null
    return parsed
  } catch {
    return null
  }
}

function callControl(credentials, action, timeoutMs, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: credentials.port,
        path: `/${action}`,
        method: 'POST',
        headers: { 'x-remote-access-token': credentials.token, 'content-type': 'application/json' },
        timeout: timeoutMs
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let payload
          try {
            payload = text ? JSON.parse(text) : {}
          } catch {
            payload = { error: text }
          }
          if (response.statusCode >= 400) {
            reject(new Error(payload?.error ?? `control socket returned ${response.statusCode}`))
            return
          }
          resolve(payload)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('control socket timed out')))
    req.on('error', reject)
    req.end(JSON.stringify(body ?? {}))
  })
}

async function persistedState(remoteDir) {
  const state = await readJson(path.join(remoteDir, 'state.json')).catch(() => null)
  const link = await readFile(path.join(remoteDir, 'link.txt'), 'utf8')
    .then((text) => text.trim())
    .catch(() => null)
  return { state, link }
}

function describe(payload, strings) {
  const lines = []
  const state = payload.state ?? 'unknown'
  lines.push(`${strings.state}: ${state}`)
  if (payload.tunnelUrl) lines.push(`${strings.tunnel}: ${payload.tunnelUrl}`)
  if (payload.link) lines.push(`${strings.link}: ${payload.link}`)
  if (payload.localLink) lines.push(`${strings.local}: ${payload.localLink}`)
  if (payload.provider) lines.push(`${strings.provider}: ${payload.provider}`)
  if (payload.target) lines.push(`${strings.target}: ${payload.target}`)
  if (payload.access) {
    lines.push(`${strings.access}: ${payload.access.mode ?? 'token-link'} / ${payload.access.state ?? 'unknown'} / gate ${payload.access.gate ?? 'absent'}`)
    if (payload.access.state === 'refused') lines.push(`⚠ ${strings.accessRefused}`)
  }
  if (payload.error) lines.push(`${strings.error}: ${payload.error}`)
  if (payload.restarts) lines.push(`${strings.restarts}: ${payload.restarts}`)
  return lines.join('\n')
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (options.help || !options.action) {
    process.stdout.write(USAGE)
    return
  }
  if (!ACTIONS.has(options.action)) {
    process.stderr.write(`unknown action "${options.action}"\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  const home = resolveHome(options.home)
  const remoteDir = path.join(home, 'remote-access')
  const strings = {
    state: '状态',
    tunnel: '公网地址',
    link: '分享链接',
    local: '本机链接（可配 ssh -L 转发使用）',
    provider: '提供方',
    target: '本地目标',
    access: '网页访问',
    switchGone:
      '这个 Host 没有「允许在浏览器中打开」开关（DSH Desktop 0.2.1-rc.3 已移除）：' +
      '分享链接本身就带访问令牌，隧道域名也已经写进 trustedHosts，任何浏览器直接打开即可',
    accessRefused:
      '探测被 403 拒绝：隧道域名可能不在 trustedHosts 里，分享链接在别的浏览器里也会被挡住；' +
      '运行 dsh-remote-access restart 让插件重新发布trustedHosts',
    error: '错误',
    restarts: '重启次数'
  }

  const credentials = await controlCredentials(remoteDir)
  let payload = null
  let live = false
  if (credentials) {
    try {
      const body = options.action === 'browser-access' ? { enabled: options.enabled !== false } : undefined
      payload = await callControl(credentials, options.action, options.timeout, body)
      live = true
    } catch (error) {
      process.stderr.write(`# control socket unavailable (${error.message}); falling back to persisted state\n`)
    }
  }

  // The Host no longer has a browser-access switch, so this action never
  // needed a live process and never changes anything: say so and stop.
  if (!live && options.action === 'browser-access') {
    process.stdout.write(`${strings.switchGone}\n`)
    return
  }

  if (!live) {
    const persisted = await persistedState(remoteDir)
    if (!persisted.state && !persisted.link) {
      throw new Error(
        `no running dsh-remote-access host plugin and no persisted state under ${remoteDir}\n` +
          'start DSH Desktop (with the plugin installed) and try again'
      )
    }
    payload = { ...(persisted.state ?? {}), link: persisted.state?.link ?? persisted.link }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  if (options.action === 'logs') {
    const logs = Array.isArray(payload.logs) ? payload.logs : []
    for (const entry of logs) {
      process.stdout.write(`${typeof entry === 'string' ? entry : `${entry.at ?? ''} ${entry.text ?? ''}`}\n`)
    }
    if (logs.length === 0) process.stdout.write('(no log lines)\n')
    return
  }

  if (options.action === 'browser-access') {
    process.stdout.write(`${payload.reason ?? strings.switchGone}\n`)
    if (payload.access?.state === 'refused') {
      process.stderr.write(`# ${strings.accessRefused}\n`)
      process.exitCode = 1
    }
    return
  }

  if (options.action === 'link') {
    const link = payload.link
    if (!link) {
      process.stderr.write('no share link yet — start the tunnel first: dsh-remote-access start\n')
      process.exitCode = 1
      return
    }
    process.stdout.write(`${link}\n`)
    if (payload.localLink) process.stderr.write(`# ${strings.local}: ${payload.localLink}\n`)
    if (payload.state && payload.state !== 'ready') {
      process.stderr.write(`# tunnel state is "${payload.state}"\n`)
    }
    return
  }

  if (options.action === 'open') {
    const link = payload.link
    if (!link) {
      process.stderr.write('no share link yet — start the tunnel first\n')
      process.exitCode = 1
      return
    }
    const { spawn } = await import('node:child_process')
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    spawn(command, [link], { detached: true, stdio: 'ignore' }).unref()
    process.stdout.write(`${link}\n`)
    return
  }

  process.stdout.write(`${describe(payload, strings)}\n`)
}

main().catch((error) => {
  process.stderr.write(`dsh-remote-access: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
