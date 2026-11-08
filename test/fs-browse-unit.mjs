/**
 * Unit test for lib/fs-browse.js — the directory listing that backs the remote
 * page's own folder chooser.
 *
 * A macOS Desktop resolves the Host directory picker to `native`, whose RPC
 * opens an NSOpenPanel on the Host's screen. A remote browser never sees that
 * panel (Cloudflare answers 524 after 100 s), so the client half browses through
 * this module over `/remote-access/fs` instead. The contract here is deliberately
 * narrow: directories only, absolute paths only, one entry level at a time.
 *
 * Run:  test/run-tests.sh            (or)
 *       node test/fs-browse-unit.mjs
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { MAX_ENTRIES, createDirectory, listDirectories } from '../lib/fs-browse.js'

const failures = []
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`)
}

async function rejectsWith(promise, code) {
  try {
    await promise
    return false
  } catch (error) {
    return error?.code === code
  }
}

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ra-fs-')))
try {
  await mkdir(path.join(root, 'beta'))
  await mkdir(path.join(root, 'Alpha'))
  await mkdir(path.join(root, '.hidden'))
  await writeFile(path.join(root, 'note.txt'), 'x')

  const listing = await listDirectories(root)
  check('listing reports the resolved path', listing.path === root, listing.path)
  check('files are not offered', !listing.entries.some((entry) => entry.name === 'note.txt'))
  check('hidden folders are not offered', !listing.entries.some((entry) => entry.name === '.hidden'))
  check(
    'folders come back sorted by name',
    listing.entries.map((entry) => entry.name).join(',') === 'Alpha,beta',
    listing.entries.map((entry) => entry.name).join(',')
  )
  check('every entry carries an absolute child path', listing.entries.every((entry) => entry.path === path.join(root, entry.name)))
  check('the parent is reported for navigation', listing.parent === path.dirname(root), listing.parent)
  check('a small folder is not truncated', listing.truncated === false)

  const home = await listDirectories()
  check('no path means the home directory', home.path === await realpath(process.env.HOME ?? ''), home.path)

  check('a relative path is refused', await rejectsWith(listDirectories('relative/dir'), 'bad-path'))
  check('a missing path is refused', await rejectsWith(listDirectories(path.join(root, 'nope')), 'ENOENT'))
  check('a file is refused', await rejectsWith(listDirectories(path.join(root, 'note.txt')), 'bad-path'))

  const made = await createDirectory({ dir: root, name: 'gamma' })
  check('a new folder is created', made.created === true && made.path === path.join(root, 'gamma'), made.path)
  const again = await createDirectory({ dir: root, name: 'gamma' })
  check('creating an existing folder is idempotent', again.created === false, String(again.created))
  check('a separator in the name is refused', await rejectsWith(createDirectory({ dir: root, name: 'a/b' }), 'bad-name'))
  check('a dot-dot name is refused', await rejectsWith(createDirectory({ dir: root, name: '..' }), 'bad-name'))
  check('an empty name is refused', await rejectsWith(createDirectory({ dir: root, name: '' }), 'bad-name'))
  check('a missing parent is refused', await rejectsWith(createDirectory({ dir: path.join(root, 'nope'), name: 'x' }), 'ENOENT'))

  // Truncation keeps the response bounded for a home directory with thousands of
  // entries; the client shows only what it is given.
  for (let index = 0; index < MAX_ENTRIES + 5; index += 1) {
    await mkdir(path.join(root, `bulk-${String(index).padStart(4, '0')}`))
  }
  const bulk = await listDirectories(root)
  check('a huge folder is truncated', bulk.truncated === true)
  check('a huge folder stops at the entry cap', bulk.entries.length === MAX_ENTRIES, String(bulk.entries.length))
} finally {
  await rm(root, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('\nfs browse passed')
