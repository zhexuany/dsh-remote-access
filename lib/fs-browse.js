/**
 * Directory browsing for clients that cannot show the Host's native chooser.
 *
 * The Host composition picks one directory-picker backend at boot. On a macOS
 * Desktop it resolves to `native`, whose `pick` opens an NSOpenPanel on the
 * machine that runs the Host. A browser on the phone or another computer never
 * sees that panel, so the pick RPC stays pending and "add workspace" looks dead.
 * These helpers let the remote-access client half render its own chooser over a
 * narrow, authenticated listing endpoint instead.
 */
import { readdir, realpath, stat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const MAX_ENTRIES = 500

/** Refuse anything that is not an existing absolute directory. */
async function resolveDirectory(input) {
  if (typeof input !== 'string' || !input.startsWith('/')) {
    throw Object.assign(new Error('an absolute directory path is required'), { code: 'bad-path' })
  }
  const resolved = await realpath(input)
  const info = await stat(resolved)
  if (!info.isDirectory()) {
    throw Object.assign(new Error('not a directory'), { code: 'bad-path' })
  }
  return resolved
}

/**
 * List the immediate subdirectories of `dir` (default: the home directory).
 * Files and hidden entries are skipped; the caller only needs pickable folders.
 */
export async function listDirectories(dir) {
  const home = homedir()
  const target = await resolveDirectory(dir ?? home)
  const names = await readdir(target, { withFileTypes: true })
  const entries = []
  let truncated = false
  for (const entry of names) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    entries.push({ name: entry.name, path: path.join(target, entry.name) })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return {
    path: target,
    home,
    parent: target === '/' ? null : path.dirname(target),
    entries,
    truncated
  }
}

/** Create one child directory. `name` must be a single path segment. */
export async function createDirectory({ dir, name }) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw Object.assign(new Error('a single directory name is required'), { code: 'bad-name' })
  }
  const parent = await resolveDirectory(dir)
  const target = path.join(parent, name)
  try {
    await mkdir(target)
  } catch (error) {
    if (error?.code === 'EEXIST') return { path: target, created: false }
    throw error
  }
  return { path: target, created: true }
}
