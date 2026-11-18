// Runs filemap.sh against a real temporary git repo (FILEMAP_REMOTE replaces the GitHub URL).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
  return { status: r.status, out: r.stdout.trim() }
}
const must = (cwd, ...args) => { const r = git(cwd, ...args); assert.equal(r.status, 0, args.join(' ')); return r.out }
const put = (dir, file, text) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), text) }

const PLAN = [
  '**FM First entry.**',
  'Touches: `a.js` (`runPRSteps`, `lib/`), `lib/b/c.js`, `lib`, `missing.js`, `dev.js`, nob.js by name only.',
  'What must be true: `plain.txt` is named here.',
  '',
  '**SC Second entry.**',
  'Touches: `plain.txt`.',
  ''
].join('\n')

const build = ({ extraMain = {} } = {}) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'filemap-test-')))
  const remote = join(dir, 'R'); const work = join(dir, 'work')
  must(dir, 'init', '-q', '--bare', '-b', 'main', remote)
  must(dir, 'clone', '-q', remote, work)
  must(work, 'checkout', '-q', '-b', 'main')
  const files = { 'a.js': 'a', 'lib/b/c.js': 'c', 'lib/d.txt': 'd', 'plain.txt': 'p', 'nob.js': 'n', 'plan.md': PLAN, ...extraMain }
  for (const [f, t] of Object.entries(files)) put(work, f, t)
  must(work, 'add', '.'); must(work, 'commit', '-qm', 'main'); must(work, 'push', '-q', 'origin', 'main')
  must(work, 'checkout', '-q', '-b', 'dev')
  put(work, 'dev.js', 'dev'); must(work, 'add', '.'); must(work, 'commit', '-qm', 'dev'); must(work, 'push', '-q', 'origin', 'dev')
  return { dir, remote, cache: join(dir, 'cache'), clone: join(dir, 'tmp', 'filemap-FM') }
}
const run = (t, { id = 'FM', cache = t.cache, clone = t.clone, env = {}, cwd = t.dir, path } = {}) => {
  const r = spawnSync('bash', [join(root, 'scripts/filemap.sh'), 'o/r', 'plan.md', id, cache, clone], {
    encoding: 'utf8', cwd, env: { ...GIT_ENV, FILEMAP_REMOTE: t.remote, ...(path ? { PATH: path } : {}), ...env }
  })
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines, files: lines.filter((l) => 'file' in l), out: r.stdout + r.stderr }
}
const noJsonOnStderr = (r) => assert.ok(!r.stderr.split('\n').some((l) => l.trimStart().startsWith('{')), r.stderr)
const blobOf = (t, file) => must(t.clone, 'rev-parse', `HEAD:${file}`)
const emptyDir = (t, name) => { const d = join(t.dir, name); mkdirSync(d); return d }

test('FM-1 shallow clone of the default branch, reused when it exists', () => {
  const t = build()
  const r = run(t)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(must(t.clone, 'rev-parse', '--is-shallow-repository'), 'true')
  assert.equal(must(t.clone, 'rev-parse', 'HEAD'), must(t.remote, 'rev-parse', 'main'))
  writeFileSync(join(t.clone, 'marker'), 'x')
  const again = run(t)
  assert.equal(again.status, 0)
  assert.ok(existsSync(join(t.clone, 'marker')))
  assert.deepEqual(again.files, r.files)
  noJsonOnStderr(r); noJsonOnStderr(again)
})

test('FM-1 the GitHub URL of the repo is used without the override', () => {
  const t = build()
  const bin = emptyDir(t, 'bin'); const log = join(t.dir, 'git.log')
  writeFileSync(join(bin, 'git'), `#!/bin/bash\necho "$@" >> "${log}"\nexit 1\n`, { mode: 0o755 })
  const r = spawnSync('bash', [join(root, 'scripts/filemap.sh'), 'o/r', 'plan.md', 'FM', t.cache, t.clone], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FILEMAP_REMOTE: '' }
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^filemap: cannot clone/m)
  assert.ok(readFileLog(log).includes('https://github.com/o/r'))
})
const readFileLog = (p) => spawnSync('cat', [p], { encoding: 'utf8' }).stdout

test('FM-2 only backticked paths of the named Touches line that are files at the head', () => {
  const t = build()
  const r = run(t)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(new Set(r.files.map((f) => f.file)), new Set(['a.js', 'lib/b/c.js']))
  const sc = run(t, { id: 'SC' })
  assert.equal(sc.status, 0)
  assert.deepEqual(sc.files.map((f) => f.file), ['plain.txt'])
})

test('FM-3 cache line, blob, map name and present flag', () => {
  const t = build()
  run(t)
  const bA = blobOf(t, 'a.js'); const bC = blobOf(t, 'lib/b/c.js')
  const oldBlob = spawnSync('git', ['hash-object', '--stdin'], { input: 'old', encoding: 'utf8' }).stdout.trim()
  mkdirSync(t.cache, { recursive: true })
  writeFileSync(join(t.cache, `a.js@${bA}.md`), 'x')
  writeFileSync(join(t.cache, `lib%2Fb%2Fc.js@${bC}.md`), '')
  const r = run(t)
  assert.deepEqual(Object.keys(r.lines[0]), ['cache'])
  assert.equal(r.lines[0].cache, t.cache)
  for (const f of r.files) assert.deepEqual(Object.keys(f), ['file', 'blob', 'map', 'present'])
  const a = r.files.find((f) => f.file === 'a.js'); const c = r.files.find((f) => f.file === 'lib/b/c.js')
  assert.equal(a.blob, bA)
  assert.equal(c.blob, bC)
  assert.equal(c.map, join(t.cache, `lib%2Fb%2Fc.js@${bC}.md`))
  assert.equal(a.present, true)
  assert.equal(c.present, false)
  writeFileSync(join(t.cache, `lib%2Fb%2Fc.js@${bC}.md`), 'now not empty')
  assert.equal(run(t).files.find((f) => f.file === 'lib/b/c.js').present, true)
  const other = join(t.dir, 'cache2'); mkdirSync(other)
  writeFileSync(join(other, `lib%2Fb%2Fc.js@${oldBlob}.md`), 'x')
  assert.equal(run(t, { cache: other }).files.find((f) => f.file === 'lib/b/c.js').present, false)
})

test('FM-4 no stderr line is a JSON line, in success and in each error', () => {
  const t = build()
  const plain = join(t.dir, 'plain'); writeFileSync(plain, 'x')
  const cases = [
    run(t), run(t, { id: 'ZZ' }), run(t, { cache: 'maps' }),
    run(t, { cache: '~/maps', env: { HOME: '' } }), run(t, { cache: join(plain, 'maps') })
  ]
  assert.deepEqual(cases.map((r) => r.status), [0, 1, 1, 1, 1])
  for (const r of cases) noJsonOnStderr(r)
})

test('FM-5 a function name, a folder or a missing file prints no line; a file does', () => {
  const t = build()
  const r = run(t)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.lines.length, 3)
  for (const n of ['runPRSteps', 'lib/', 'lib', 'missing.js']) assert.ok(!r.files.some((f) => f.file === n), n)
  const t2 = build({ extraMain: { 'missing.js': 'm' } })
  assert.ok(run(t2).files.some((f) => f.file === 'missing.js'))
})

test('FM-6 an unknown entry id prints no entry and exits 1', () => {
  const t = build()
  for (const id of ['ZZ', 'F']) {
    const r = run(t, { id })
    assert.equal(r.status, 1)
    assert.match(r.out, new RegExp(`^filemap: no entry ${id}$`, 'm'))
    assert.equal(r.files.length, 0)
  }
  const ok = run(t)
  assert.equal(ok.status, 0)
  assert.ok(ok.files.length > 0)
})

test('FM-7 only map files older than 30 days are deleted', () => {
  const t = build()
  const hex = 'a'.repeat(40)
  mkdirSync(t.cache, { recursive: true })
  const age = (p, days) => { writeFileSync(p, 'x'); const d = new Date(Date.now() - days * 86400000); utimesSync(p, d, d) }
  const oldMap = join(t.cache, `old%2Fx.js@${hex}.md`); const newMap = join(t.cache, `new%2Fy.js@${hex}.md`)
  const notes = join(t.cache, 'notes.txt'); const parentMap = join(t.dir, `z.js@${hex}.md`)
  age(oldMap, 31); age(newMap, 29); age(notes, 31); age(parentMap, 31)
  const r = run(t)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(oldMap))
  for (const p of [newMap, notes, parentMap, join(t.clone, 'a.js')]) assert.ok(existsSync(p), p)
})

test('FM-8 creates the cache folder and writes only there and into the clone folder', () => {
  const t = build()
  const [home, tmp, cwd] = ['h', 't', 'w'].map((n) => emptyDir(t, n))
  const snapshot = () => spawnSync('find', [t.dir, '-not', '-path', `${t.remote}*`, '-not', '-path', `${join(t.dir, 'tmp')}*`, '-not', '-path', `${join(t.dir, 'a')}*`, '-not', '-path', `${join(t.dir, 'work')}*`], { encoding: 'utf8' }).stdout
  const before = snapshot()
  const cache = join(t.dir, 'a', 'b', 'cache')
  const r = run(t, { cache, cwd, env: { HOME: home, TMPDIR: tmp } })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(cache))
  for (const d of [home, tmp, cwd]) assert.deepEqual(readdirSync(d), [])
  assert.equal(snapshot(), before)
})

test('FM-9 a relative cache folder prints cache folder must be absolute and exits 1', () => {
  const t = build()
  const cwd = emptyDir(t, 'w')
  for (const cache of ['maps', './maps']) {
    const r = run(t, { cache, cwd })
    assert.equal(r.status, 1)
    assert.match(r.out, /^filemap: cache folder must be absolute$/m)
    assert.ok(!existsSync(join(cwd, 'maps')))
  }
  assert.equal(run(t, { cwd }).status, 0)
})

test('FM-10 a cache folder with ~/ is expanded with HOME', () => {
  const t = build()
  const home = emptyDir(t, 'h'); const cwd = emptyDir(t, 'w')
  const r = run(t, { cache: '~/maps', cwd, env: { HOME: home } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.lines[0].cache, join(home, 'maps'))
  assert.ok(existsSync(join(home, 'maps')))
  for (const f of r.files) assert.ok(f.map.startsWith(`${join(home, 'maps')}/`))
  assert.ok(!existsSync(join(cwd, '~')))
})

test('FM-11 an empty HOME with ~/ prints no home folder and exits 1', () => {
  const t = build()
  const r = run(t, { cache: '~/maps', env: { HOME: '' } })
  assert.equal(r.status, 1)
  assert.match(r.out, /^filemap: no home folder$/m)
  assert.equal(r.files.length, 0)
})

test('FM-12 a cache folder that cannot be created prints cannot create and exits 1', () => {
  const t = build()
  writeFileSync(join(t.dir, 'plain'), 'x')
  const bad = join(t.dir, 'plain', 'maps')
  const r = run(t, { cache: bad })
  assert.equal(r.status, 1)
  assert.match(r.out, new RegExp(`^filemap: cannot create ${bad}$`, 'm'))
  assert.equal(r.files.length, 0)
  assert.equal(run(t, { cache: join(t.dir, 'ok', 'maps') }).status, 0)
})

test('FM-14 the script holds no command form of only one of macOS and Linux', () => {
  const re = /stat -[cf]|date -[dv]|touch -d|sed -i|readlink -f|realpath|find [^|]*-printf|xargs -r|md5sum|sha1sum|sha256sum|shasum|base64 -[dD]|\btimeout |gdate|mapfile|readarray|declare -A|local -A|\$\{[^}]*(,,|\^\^)/
  const text = spawnSync('cat', [join(root, 'scripts/filemap.sh')], { encoding: 'utf8' }).stdout
  assert.ok(text.length > 0)
  assert.deepEqual(text.split('\n').filter((l) => re.test(l)), [])
})

test('FM-15 the clone folder is never deleted, also on an error', () => {
  const t = build()
  assert.equal(run(t).status, 0)
  writeFileSync(join(t.clone, 'marker'), 'x')
  writeFileSync(join(t.dir, 'plain'), 'x')
  const cases = [{}, { id: 'ZZ' }, { cache: 'maps' }, { cache: join(t.dir, 'plain', 'maps') }]
  const statuses = cases.map((c) => run(t, c).status)
  assert.deepEqual(statuses, [0, 1, 1, 1])
  assert.ok(existsSync(join(t.clone, 'marker')))
  assert.equal(git(t.clone, 'rev-parse', 'HEAD').status, 0)
})

test('FM-16 cleanup.sh clones removes filemap-<id> for its id and keeps it for another', () => {
  const t = build()
  const T = join(t.dir, 'wavetmp')
  assert.match(spawnSync('bash', [join(root, 'scripts/cleanup.sh'), 'init', T], { encoding: 'utf8' }).stdout, /^MARKED /)
  const clone = join(T, 'filemap-FM')
  assert.equal(run(t, { clone }).status, 0)
  const clones = (id) => spawnSync('bash', [join(root, 'scripts/cleanup.sh'), 'clones', T, id], { encoding: 'utf8' }).stdout
  assert.ok(!/REMOVED/.test(clones('SC')))
  assert.ok(existsSync(clone))
  assert.equal(clones('FM').trim(), `REMOVED ${realpathSync(T)}/filemap-FM`)
  assert.ok(!existsSync(clone))
})
