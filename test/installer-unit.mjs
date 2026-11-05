/**
 * Installer unit test — no Host process, no tunnel, no network.
 *
 * It builds a throwaway DSH home with a fake profile and checks the three
 * things the installer is responsible for:
 *   1. the bundle ends up in `<profile>/node_modules` and in `dsh.profile.bundles`
 *      (with the manifest backed up first),
 *   2. the managed `typert-gateway` heartbeat block is written into the profile
 *      patch file *without* disturbing hand-written entries, and is idempotent,
 *   3. `--no-heartbeat`, `--uninstall` and `--dry-run` each do exactly what they say.
 *
 * Run:  test/run-tests.sh            (or)
 *       ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/DSH NEXT" test/installer-unit.mjs
 */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs')
const BUNDLE = 'dsh-remote-access'

const failures = []
const results = []

function check(name, condition, detail) {
  results.push([name, Boolean(condition)])
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function exists(target) {
  return stat(target).then(() => true, () => false)
}

/** The template a never-edited profile carries: comments and an empty array. */
const FRESH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** The Host parses the patch with js-yaml from inside the app bundle. */
function loadYaml() {
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
  const require = createRequire(import.meta.url)
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {}
  }
  return null
}

/** Run the installer through this process's own Node runtime. */
async function installer(home, args) {
  const { stdout } = await run(process.execPath, [INSTALLER, '--home', home, '--json', ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  return JSON.parse(stdout)
}

const PROFILE_PATCH = `# hand-written entries must survive the installer
- id: locale
  name: '@deepseek-ai/dsh-client-locale'
  config:
    preference: zh
`

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'remote-access-installer-'))
  const profileDir = path.join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: { dshmarket: '1.66.8' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket'] } }
      },
      null,
      2
    )}\n`
  )
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), PROFILE_PATCH)
  return { home, profileDir }
}

async function main() {
  const { home, profileDir } = await makeHome()
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const manifestFile = path.join(profileDir, 'package.json')
  try {
    /* 1 — a real install */
    const first = await installer(home, ['--profile', 'web', '--no-cloudflared'])
    check('install reports the bundle name', first.action === 'install' && first.installDir.endsWith(path.join('node_modules', BUNDLE)), String(first.installDir))
    check('install reports the default heartbeat', first.heartbeatMs === 15_000, String(first.heartbeatMs))
    check('install says it set the heartbeat', first.report.some((line) => /set the Remote-stream mux heartbeat to 15000ms/.test(line)), JSON.stringify(first.report))
    check('the bundle directory exists', await exists(path.join(profileDir, 'node_modules', BUNDLE, 'index.js')))

    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    check('the bundle is appended to dsh.profile.bundles', JSON.stringify(manifest?.dsh?.profile?.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', 'dshmarket', BUNDLE]), JSON.stringify(manifest?.dsh?.profile?.bundles))
    check('the dependency points at the source tree', String(manifest?.dependencies?.[BUNDLE] ?? '').startsWith('file:'), String(manifest?.dependencies?.[BUNDLE]))
    check('an unrelated dependency is untouched', manifest?.dependencies?.dshmarket === '1.66.8', JSON.stringify(manifest?.dependencies))
    check('the manifest was backed up first', (await readdir(profileDir)).some((name) => name.startsWith('package.json.bak-')), JSON.stringify(await readdir(profileDir)))

    const patch = await readFile(patchFile, 'utf8')
    check('the heartbeat row is written', /- id: typert-gateway/.test(patch) && /websocketHeartbeatIntervalMs: 15000/.test(patch), patch.slice(-220))
    check('the row keeps its package name', /name: '@deepseek-ai\/dsh-api-gateway'/.test(patch))
    check('hand-written entries survive', /preference: zh/.test(patch), patch.slice(0, 200))
    check('the block is marker-delimited', patch.includes('# >>> dsh-remote-access: mux heartbeat (managed block)') && patch.includes('# <<< dsh-remote-access: mux heartbeat (managed block)'))

    /* 2 — a second install must be a no-op for the patch file */
    const second = await installer(home, ['--profile', 'web', '--no-cloudflared'])
    const patchAgain = await readFile(patchFile, 'utf8')
    check('a re-install is idempotent', patchAgain === patch, 'the patch file changed on the second run')
    check('a re-install says the heartbeat is already set', second.report.some((line) => /mux heartbeat already 15000ms/.test(line)), JSON.stringify(second.report))
    check('a re-install keeps one bundles entry', second.bundles.filter((name) => name === BUNDLE).length === 1, JSON.stringify(second.bundles))

    /* 3 — a custom interval */
    const custom = await installer(home, ['--profile', 'web', '--no-cloudflared', '--heartbeat-ms', '5000'])
    check('a custom interval is reported', custom.heartbeatMs === 5000, String(custom.heartbeatMs))
    check('a custom interval replaces the previous value', /websocketHeartbeatIntervalMs: 5000/.test(await readFile(patchFile, 'utf8')))

    /* 4 — --no-heartbeat removes the managed block only */
    await installer(home, ['--profile', 'web', '--no-cloudflared', '--no-heartbeat'])
    const stripped = await readFile(patchFile, 'utf8')
    check('--no-heartbeat removes the block', !/websocketHeartbeatIntervalMs/.test(stripped), stripped.slice(-200))
    check('--no-heartbeat keeps hand-written entries', /preference: zh/.test(stripped), stripped.slice(0, 200))
    check('--no-heartbeat is idempotent', (await installer(home, ['--profile', 'web', '--no-cloudflared', '--no-heartbeat'])).report.some((line) => /no managed mux heartbeat block/.test(line)))

    /* 5 — dry run writes nothing */
    const dry = await makeHome()
    try {
      const before = await readFile(path.join(dry.profileDir, 'cordis.patch.yml'), 'utf8')
      const planned = await installer(dry.home, ['--profile', 'web', '--no-cloudflared', '--dry-run'])
      check('a dry run reports the planned copy', planned.report.some((line) => /would copy/.test(line)), JSON.stringify(planned.report))
      check('a dry run reports the planned heartbeat', planned.report.some((line) => /would set the Remote-stream mux heartbeat/.test(line)), JSON.stringify(planned.report))
      check('a dry run writes no bundle', !(await exists(path.join(dry.profileDir, 'node_modules', BUNDLE))))
      check('a dry run leaves the patch file alone', (await readFile(path.join(dry.profileDir, 'cordis.patch.yml'), 'utf8')) === before)
      check('a dry run leaves the manifest alone', !(await readdir(dry.profileDir)).some((name) => name.startsWith('package.json.bak-')))
    } finally {
      await rm(dry.home, { recursive: true, force: true })
    }

    /* 6 — install again, then uninstall */
    await installer(home, ['--profile', 'web', '--no-cloudflared'])
    const removed = await installer(home, ['--profile', 'web', '--uninstall'])
    check('uninstall reports the action', removed.action === 'uninstall', JSON.stringify(removed.action))
    check('uninstall removes the bundle directory', !(await exists(path.join(profileDir, 'node_modules', BUNDLE))))
    const afterManifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    check('uninstall drops the bundle from dsh.profile.bundles', !afterManifest.dsh.profile.bundles.includes(BUNDLE), JSON.stringify(afterManifest.dsh.profile.bundles))
    check('uninstall drops the dependency', afterManifest.dependencies[BUNDLE] === undefined, JSON.stringify(afterManifest.dependencies))
    const afterPatch = await readFile(patchFile, 'utf8')
    check('uninstall removes the managed heartbeat block', !/websocketHeartbeatIntervalMs/.test(afterPatch), afterPatch.slice(-200))
    check('uninstall keeps hand-written entries', /preference: zh/.test(afterPatch), afterPatch.slice(0, 200))
  } finally {
    await rm(home, { recursive: true, force: true })
  }

  /* 7 — a fresh profile's patch is `[]`; appending to it must stay valid YAML */
  const fresh = await makeHome()
  try {
    const freshPatch = path.join(fresh.profileDir, 'cordis.patch.yml')
    await writeFile(freshPatch, FRESH_TEMPLATE)
    const result = await installer(fresh.home, ['--profile', 'web', '--no-cloudflared'])
    check('the fresh profile installed', result.action === 'install', JSON.stringify(result.action))
    const text = await readFile(freshPatch, 'utf8')
    check('the empty-array document token is gone', !/^[ \t]*\[\][ \t]*$/m.test(text), text)
    const yaml = loadYaml()
    const doc = yaml ? yaml.load(text) : null
    check('the composed patch parses as an array', yaml === null || Array.isArray(doc), yaml ? JSON.stringify(doc) : 'no parser')
    check(
      'the heartbeat row survived the rewrite',
      yaml === null ||
        (doc ?? []).some(
          (row) => row?.id === 'typert-gateway' && row?.config?.websocketHeartbeatIntervalMs === 15_000
        ),
      yaml ? JSON.stringify(doc) : 'no parser'
    )
  } finally {
    await rm(fresh.home, { recursive: true, force: true })
  }

  for (const [name, ok] of results) process.stdout.write(`${ok ? '✓' : '✗'} ${name}\n`)
  process.stdout.write(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}\n`)
  for (const failure of failures) process.stdout.write(`  · ${failure}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exit(1)
})
