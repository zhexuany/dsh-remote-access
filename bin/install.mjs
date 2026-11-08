#!/usr/bin/env node
/**
 * Install `dsh-remote-access` into a DSH profile as a bundle.
 *
 * A DSH bundle is two things: a package present in `<profile>/node_modules`, and
 * its name listed in that profile's `package.json` → `dsh.profile.bundles`. This
 * installer does exactly those two things (plus an optional cloudflared binary),
 * with a backup of the manifest first. It never runs pnpm and never touches the
 * compiled Desktop app.
 *
 *   node bin/install.mjs                      # install into ~/.dsh/profiles/desktop
 *   node bin/install.mjs --link               # symlink instead of copy (dev loop)
 *   node bin/install.mjs --enable-browser-access
 *   node bin/install.mjs --heartbeat-ms 30000     # tolerate a lossy tunnel path
 *   node bin/install.mjs --no-heartbeat           # drop the managed block again
 *   node bin/install.mjs --uninstall
 */
import { cp, lstat, mkdir, readFile, rename, rm, symlink, writeFile, access, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_NAME = 'dsh-remote-access'
const DEFAULT_PROFILE = 'desktop'

/** Mirrors the Desktop app's DEFAULT_PREFERENCES; unknown keys are rejected by the app. */
const DEFAULT_PREFERENCES = {
  closeToTray: true,
  macosMaterial: 'transparent',
  windowsMaterial: 'off',
  linuxMaterial: 'off',
  browserAccess: false,
  networkExposure: 'loopback',
  port: 0,
  lanPort: 0,
  logLevel: 'info',
  notifications: true,
  turnCompleted: true,
  turnFailed: true,
  jobCompleted: false,
  jobFailed: false,
  scheduleCompleted: true,
  scheduleFailed: true
}

const COPY_SKIP = new Set(['node_modules', 'vendor', '.git', '.DS_Store'])

function parseArgs(argv) {
  const options = {
    home: undefined,
    profile: DEFAULT_PROFILE,
    link: false,
    uninstall: false,
    enableBrowserAccess: false,
    cloudflared: true,
    heartbeatMs: undefined,
    dryRun: false,
    json: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[(index += 1)]
    switch (arg) {
      case '--home':
        options.home = next()
        break
      case '--profile':
        options.profile = next()
        break
      case '--link':
        options.link = true
        break
      case '--copy':
        options.link = false
        break
      case '--uninstall':
        options.uninstall = true
        break
      case '--enable-browser-access':
        options.enableBrowserAccess = true
        break
      case '--heartbeat-ms':
        options.heartbeatMs = Number(next())
        break
      case '--no-heartbeat':
        options.heartbeatMs = 0
        break
      case '--no-cloudflared':
        options.cloudflared = false
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--json':
        options.json = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`unknown argument "${arg}"`)
    }
  }
  return options
}

const USAGE = `dsh-remote-access installer

Usage: node bin/install.mjs [options]

  --home <dir>               DSH home (default: $DSH_HOME, $DSH_NEXT_HOME, else ~/.dsh)
  --profile <name>           profile to install into (default: ${DEFAULT_PROFILE})
  --link                     symlink the package instead of copying it (dev loop)
  --copy                     copy the package (default)
  --enable-browser-access    set browserAccess: true in desktop-preferences.json
                             (only DSH Desktop <= 0.2.1-rc.2 reads it; 0.2.1-rc.3 removed the switch)
  --heartbeat-ms <ms>        Remote-stream mux heartbeat interval (default 30000, 0 = keep DSH's 2000)
  --no-heartbeat             remove the managed mux heartbeat block
  --no-cloudflared           skip placing the bundled cloudflared binary
  --uninstall                remove the bundle from the profile
  --dry-run                  report what would change, write nothing
  --json                     machine-readable result
  -h, --help                 this text
`

function resolveHome(explicit) {
  const candidate =
    explicit ||
    process.env.DSH_HOME ||
    process.env.DSH_NEXT_HOME ||
    path.join(os.homedir(), '.dsh')
  return path.resolve(candidate.replace(/^~(?=$|\/)/, os.homedir()))
}

async function exists(target) {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeJsonAtomic(file, value, mode = 0o600) {
  const temp = `${file}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await rename(temp, file)
}

function timestamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`
}

/** Sanity-check the source package before we wire it into a live profile. */
async function inspectSource() {
  const manifest = await readJson(path.join(PACKAGE_ROOT, 'package.json'))
  const problems = []
  if (manifest.name !== BUNDLE_NAME) problems.push(`package.json name is "${manifest.name}", expected "${BUNDLE_NAME}"`)
  for (const relative of ['index.js', 'client.js', 'cordis.patch.yml']) {
    if (!(await exists(path.join(PACKAGE_ROOT, relative)))) problems.push(`missing ${relative}`)
  }
  const patch = manifest?.dsh?.bundle?.patch
  if (!patch) problems.push('package.json dsh.bundle.patch is not declared')
  else if (!(await exists(path.join(PACKAGE_ROOT, patch)))) problems.push(`missing patch file ${patch}`)
  if (!manifest?.exports?.['./client']) problems.push('package.json exports["./client"] is not declared')
  return { manifest, problems }
}

function cloudflaredAssetName() {
  const platform =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return `cloudflared-${platform}-${arch}`
}

async function placeCloudflared(home, options, report) {
  const target = path.join(home, 'remote-access', 'bin', 'cloudflared')
  if (await exists(target)) {
    report.push(`cloudflared already present at ${target}`)
    return
  }
  const vendored = path.join(PACKAGE_ROOT, 'vendor', cloudflaredAssetName())
  if (!(await exists(vendored))) {
    report.push(`no vendored cloudflared for this platform (${cloudflaredAssetName()}) — the plugin will look on PATH`)
    return
  }
  if (options.dryRun) {
    report.push(`would install cloudflared → ${target}`)
    return
  }
  await mkdir(path.dirname(target), { recursive: true })
  await cp(vendored, target)
  await chmod(target, 0o755)
  report.push(`installed cloudflared → ${target}`)
}

async function enableBrowserAccess(home, options, report) {
  const file = path.join(home, 'desktop-preferences.json')
  let current = { ...DEFAULT_PREFERENCES }
  if (await exists(file)) {
    try {
      const raw = await readJson(file)
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) current = { ...DEFAULT_PREFERENCES, ...raw }
      await cp(file, `${file}.bak-${timestamp()}`)
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.message}`)
    }
  }
  if (current.browserAccess === true) {
    report.push('browserAccess already true (only DSH Desktop <= 0.2.1-rc.2 reads it)')
    return
  }
  const next = { ...current, browserAccess: true }
  if (options.dryRun) {
    report.push(`would set browserAccess: true in ${file}`)
    return
  }
  await writeJsonAtomic(file, next)
  report.push(`set browserAccess: true in ${file} (only DSH Desktop <= 0.2.1-rc.2 reads it)`)
}

const HEARTBEAT_BEGIN = '# >>> dsh-remote-access: mux heartbeat (managed block)'
const HEARTBEAT_END = '# <<< dsh-remote-access: mux heartbeat (managed block)'

function stripHeartbeatBlock(text) {
  const start = text.indexOf(HEARTBEAT_BEGIN)
  if (start === -1) return text
  const end = text.indexOf(HEARTBEAT_END, start)
  if (end === -1) return text.slice(0, start)
  const after = text.indexOf('\n', end)
  return `${text.slice(0, start)}${after === -1 ? '' : text.slice(after + 1)}`
}

/**
 * A profile that has never been edited ships its patch as an explicit empty
 * array (`[]`, plus the template comments). Appending a sequence entry after
 * `[]` is a YAML syntax error and the Host then refuses to boot:
 * `failed to parse overlay …/cordis.patch.yml: YAMLException: end of the
 * stream or a document separator is expected`. So drop the empty document
 * token before adding the managed block. Takes already-block-stripped text.
 */
function dropEmptyDocument(text) {
  const bare = text.replace(/^[ \t]*#.*$/gm, '').trim()
  if (bare !== '[]' && bare !== 'null' && bare !== '~') return text
  return text.replace(/^[ \t]*(\[\]|null|~)[ \t]*\n?/m, '')
}

function loadYamlParser() {
  const candidates = []
  const exe = process.execPath ?? ''
  const marker = '.app/Contents/MacOS/'
  const at = exe.indexOf(marker)
  if (at > 0) {
    candidates.push(
      path.join(`${exe.slice(0, at)}.app/Contents/Resources/app/node_modules/js-yaml`, 'index.js')
    )
  }
  candidates.push('js-yaml')
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {}
  }
  return null
}

/** Never leave an unparseable overlay behind: parse before writing. */
function assertPatchArray(text, file, report) {
  const yaml = loadYamlParser()
  if (!yaml) {
    report.push(`note: no YAML parser available; ${file} was only checked structurally`)
    return
  }
  const doc = yaml.load(text)
  if (doc === undefined || doc === null) return
  if (!Array.isArray(doc)) {
    throw new Error(
      `refusing to write ${file}: a profile patch must be a top-level YAML array (got ${typeof doc})`
    )
  }
}

/**
 * The Remote-stream mux pings every 2s and the Host terminates a socket after
 * two unanswered pings — a lossy tunnel path reaches that easily, and the
 * browser then shows 重新连接中. The interval belongs to the `typert-gateway`
 * row, which is a different bundle, so the only lever is the profile patch
 * file. The block below is marker-delimited and managed: install rewrites it,
 * uninstall removes it, and everything else in the file is left untouched.
 */
async function applyGatewayHeartbeat(profileDir, options, report) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  const wanted = options.heartbeatMs === undefined ? 30_000 : options.heartbeatMs
  const existing = (await exists(file)) ? await readFile(file, 'utf8') : ''
  const stripped = stripHeartbeatBlock(existing)
  const base = wanted ? dropEmptyDocument(stripped) : stripped
  const block = wanted
    ? [
        HEARTBEAT_BEGIN,
        `# DSH pings the mux every 2s and kills a peer after 2 missed pongs, which is`,
        `# too tight for a WAN path. ${wanted}ms means two lost pings span`,
        `# ${Math.round((wanted * 2) / 1000)}s before the socket is reaped. A row config replaces the`,
        '# whole config, so this is the only key we add — never merge assumptions.',
        '- id: typert-gateway',
        "  name: '@deepseek-ai/dsh-api-gateway'",
        '  config:',
        `    websocketHeartbeatIntervalMs: ${wanted}`,
        HEARTBEAT_END
      ].join('\n')
    : ''
  let next = base
  if (block) {
    if (next && !next.endsWith('\n')) next += '\n'
    next += `${block}\n`
  }
  assertPatchArray(next, file, report)
  if (next === existing) {
    report.push(
      wanted ? `mux heartbeat already ${wanted}ms in ${file}` : `no managed mux heartbeat block in ${file}`
    )
    return
  }
  const what = wanted
    ? `set the Remote-stream mux heartbeat to ${wanted}ms`
    : 'remove the managed mux heartbeat block'
  if (options.dryRun) {
    report.push(`would ${what} in ${file}`)
    return
  }
  await mkdir(profileDir, { recursive: true })
  if (existing) await cp(file, `${file}.bak-${timestamp()}`)
  await writeFile(file, next, { mode: 0o600 })
  report.push(`${what} in ${file} (takes effect on the next app start)`)
}

async function install(home, options) {
  const report = []
  const profileDir = path.join(home, 'profiles', options.profile)
  const manifestPath = path.join(profileDir, 'package.json')
  if (!(await exists(manifestPath))) {
    const available = await readFile(path.join(home, 'profiles'), 'utf8').catch(() => '')
    throw new Error(
      `no profile at ${profileDir} (looked for package.json)${available ? '' : ''} — pass --profile <name>`
    )
  }
  const { manifest, problems } = await inspectSource()
  if (problems.length > 0) throw new Error(`package self-check failed:\n  - ${problems.join('\n  - ')}`)

  const manifestDoc = await readJson(manifestPath)
  const nodeModules = path.join(profileDir, 'node_modules')
  const installDir = path.join(nodeModules, BUNDLE_NAME)
  const spec = options.link ? `link:${PACKAGE_ROOT}` : `file:${PACKAGE_ROOT}`

  const bundles = manifestDoc?.dsh?.profile?.bundles
  const bundlesIsArray = Array.isArray(bundles)
  const alreadyListed = bundlesIsArray && bundles.includes(BUNDLE_NAME)
  const previous = bundlesIsArray ? [...bundles] : []

  if (options.dryRun) {
    report.push(`would ${options.link ? 'symlink' : 'copy'} ${PACKAGE_ROOT} → ${installDir}`)
    report.push(
      alreadyListed
        ? 'bundle already listed in dsh.profile.bundles'
        : `would add "${BUNDLE_NAME}" to dsh.profile.bundles (${previous.length} → ${previous.length + 1})`
    )
    report.push(`would set dependencies["${BUNDLE_NAME}"] = "${spec}"`)
  } else {
    await mkdir(nodeModules, { recursive: true })
    const existing = await lstat(installDir).catch(() => null)
    if (existing) {
      // Guard: only ever remove the exact bundle directory under this profile.
      if (path.dirname(installDir) !== nodeModules || path.basename(installDir) !== BUNDLE_NAME) {
        throw new Error(`refusing to replace unexpected path ${installDir}`)
      }
      await rm(installDir, { recursive: true, force: true })
    }
    if (options.link) {
      await symlink(PACKAGE_ROOT, installDir, 'dir')
      report.push(`symlinked ${installDir} → ${PACKAGE_ROOT}`)
    } else {
      await cp(PACKAGE_ROOT, installDir, {
        recursive: true,
        dereference: true,
        filter: (source) => !COPY_SKIP.has(path.basename(source))
      })
      report.push(`copied ${PACKAGE_ROOT} → ${installDir}`)
    }

    const nextManifest = {
      ...manifestDoc,
      dependencies: { ...(manifestDoc.dependencies ?? {}), [BUNDLE_NAME]: spec },
      dsh: {
        ...(manifestDoc.dsh ?? {}),
        profile: { ...(manifestDoc.dsh?.profile ?? {}), bundles: [...previous.filter((n) => n !== BUNDLE_NAME), BUNDLE_NAME] }
      }
    }
    await cp(manifestPath, `${manifestPath}.bak-${timestamp()}`)
    await writeJsonAtomic(manifestPath, nextManifest, 0o600)
    report.push(
      alreadyListed
        ? `bundle already listed; refreshed dependencies entry`
        : `added "${BUNDLE_NAME}" to dsh.profile.bundles`
    )
    report.push(`backed up manifest to ${manifestPath}.bak-${timestamp()}`)
  }

  if (options.cloudflared) await placeCloudflared(home, options, report)
  if (options.enableBrowserAccess) await enableBrowserAccess(home, options, report)
  await applyGatewayHeartbeat(profileDir, options, report)

  return {
    action: 'install',
    home,
    profile: options.profile,
    profileDir,
    installDir,
    mode: options.link ? 'link' : 'copy',
    heartbeatMs: options.heartbeatMs === undefined ? 30_000 : options.heartbeatMs,
    version: manifest.version,
    bundles: [...previous.filter((n) => n !== BUNDLE_NAME), BUNDLE_NAME],
    report
  }
}

async function uninstall(home, options) {
  const report = []
  const profileDir = path.join(home, 'profiles', options.profile)
  const manifestPath = path.join(profileDir, 'package.json')
  const installDir = path.join(profileDir, 'node_modules', BUNDLE_NAME)

  const manifestDoc = await readJson(manifestPath)
  const previous = Array.isArray(manifestDoc?.dsh?.profile?.bundles) ? manifestDoc.dsh.profile.bundles : []
  const dependencies = { ...(manifestDoc.dependencies ?? {}) }
  delete dependencies[BUNDLE_NAME]

  if (options.dryRun) {
    report.push(`would remove ${installDir}`)
    report.push(`would drop "${BUNDLE_NAME}" from bundles and dependencies`)
  } else {
    if (path.dirname(installDir) !== path.join(profileDir, 'node_modules') || path.basename(installDir) !== BUNDLE_NAME) {
      throw new Error(`refusing to remove unexpected path ${installDir}`)
    }
    await rm(installDir, { recursive: true, force: true })
    report.push(`removed ${installDir}`)
    await cp(manifestPath, `${manifestPath}.bak-${timestamp()}`)
    await writeJsonAtomic(
      manifestPath,
      {
        ...manifestDoc,
        dependencies,
        dsh: {
          ...(manifestDoc.dsh ?? {}),
          profile: { ...(manifestDoc.dsh?.profile ?? {}), bundles: previous.filter((n) => n !== BUNDLE_NAME) }
        }
      },
      0o600
    )
    report.push(`removed "${BUNDLE_NAME}" from ${manifestPath}`)
  }
  // the managed heartbeat block lives in the profile patch file, not the manifest
  await applyGatewayHeartbeat(profileDir, { ...options, heartbeatMs: 0 }, report)
  return { action: 'uninstall', home, profile: options.profile, profileDir, installDir, report }
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
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  const home = resolveHome(options.home)
  const result = options.uninstall ? await uninstall(home, options) : await install(home, options)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`\n${options.uninstall ? '卸载' : '安装'} ${BUNDLE_NAME} (profile: ${result.profile})\n`)
    for (const line of result.report) process.stdout.write(`  · ${line}\n`)
    process.stdout.write('\n')
    if (!options.uninstall) {
      process.stdout.write('下一步：面板/客户端部分会热加载，刷新一下界面即可；Host 侧的新代码（新的 action、访问探测）需要重启一次 DSH Desktop。\n')
      process.stdout.write('不需要再打开任何 Desktop 侧开关：DSH Desktop 0.2.1-rc.3 已移除「允许在浏览器中打开」，\n')
      process.stdout.write('跨机访问由 trustedHosts（插件自动发布）+ 链接里的令牌负责。装完直接 设置 → 远程协作 → 启动 即可。\n')
    }
  }
}

main().catch((error) => {
  process.stderr.write(`install failed: ${error?.stack ?? error}\n`)
  process.exitCode = 1
})
