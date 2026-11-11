import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, chmodSync, realpathSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/cleanup.sh', import.meta.url))
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-io-')))
const home = join(base, 'home'); mkdirSync(home)
let n = 0
const run = (args, env = {}) => {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, ...env } })
  return { status: r.status, out: r.stdout + r.stderr }
}
const folder = (marked = true) => {
  const d = join(base, `t${n++}`); mkdirSync(d)
  if (marked) run(['init', d])
  return d
}
const lines = (out, word) => out.split('\n').filter((l) => l.startsWith(word + ' '))
const touch = (...p) => writeFileSync(join(...p), 'x')

test('--all removes each io-large file and folder at the top', () => {
  const s = folder()
  touch(s, 'io-large.Ab12Cd'); touch(s, 'io-large.9ZxQw0'); mkdirSync(join(s, 'test-T01-r1'))
  const r = run(['clones', s, '--all'])
  assert.equal(r.status, 0)
  assert.deepEqual(readdirSync(s).sort(), ['.pipeline-tmp'])
  const rm = lines(r.out, 'REMOVED')
  assert.equal(rm.length, 3)
  for (const name of ['io-large.Ab12Cd', 'io-large.9ZxQw0', 'test-T01-r1']) assert.ok(rm.some((l) => l.endsWith('/' + name)), name)
})

test('without a marker nothing is removed, and after marking it is', () => {
  const s = folder(false)
  touch(s, 'io-large.Ab12Cd')
  let r = run(['clones', s, '--all'])
  assert.equal(r.status, 0)
  assert.match(r.out, /^KEPT .* no \.pipeline-tmp marker/m)
  assert.equal(lines(r.out, 'REMOVED').length, 0)
  assert.ok(existsSync(join(s, 'io-large.Ab12Cd')))
  run(['init', s])
  r = run(['clones', s, '--all'])
  assert.ok(!existsSync(join(s, 'io-large.Ab12Cd')))
  assert.ok(lines(r.out, 'REMOVED').some((l) => l.endsWith('/io-large.Ab12Cd')))
})

test('a symbolic link named io-large.x is not followed or removed', () => {
  const s = folder()
  const target = join(base, 'outside'); writeFileSync(target, 'keep me')
  symlinkSync(target, join(s, 'io-large.x'))
  touch(s, 'io-large.Ab12Cd')
  assert.ok(lstatSync(join(s, 'io-large.x')).isSymbolicLink())
  const r = run(['clones', s, '--all'])
  assert.equal(readFileSync(target, 'utf8'), 'keep me')
  assert.ok(lstatSync(join(s, 'io-large.x')).isSymbolicLink())
  assert.ok(!lines(r.out, 'REMOVED').some((l) => l.includes('io-large.x')))
  assert.ok(!existsSync(join(s, 'io-large.Ab12Cd')))
  assert.ok(lines(r.out, 'REMOVED').some((l) => l.endsWith('/io-large.Ab12Cd')))
})

test('other top-level files stay, and the per-PR form keeps io-large files', () => {
  const s = folder()
  touch(s, 'notes.txt'); touch(s, 'io-large-x')
  let r = run(['clones', s, '--all'])
  for (const f of ['.pipeline-tmp', 'notes.txt', 'io-large-x']) assert.ok(existsSync(join(s, f)), f)
  assert.equal(lines(r.out, 'REMOVED').length, 0)
  const p = folder()
  touch(p, 'io-large.Ab12Cd'); mkdirSync(join(p, 'test-T01-r1'))
  r = run(['clones', p, 'T01'])
  assert.ok(!existsSync(join(p, 'test-T01-r1')))
  assert.ok(existsSync(join(p, 'io-large.Ab12Cd')))
  assert.ok(!r.out.includes('io-large'))
})

test('only io-large. plus letters or digits at the top is removed', () => {
  const s = folder()
  const keep = ['io-large.', 'io-large.ab-c', 'io-large.a.b', 'io-large.Ab12Cd.bak']
  for (const f of keep) touch(s, f)
  touch(s, 'io-large.Zz9')
  mkdirSync(join(s, 'sub')); touch(s, 'sub', 'io-large.Qq1')
  const r = run(['clones', s, '--all'])
  assert.ok(!existsSync(join(s, 'io-large.Zz9')))
  for (const f of keep) assert.ok(existsSync(join(s, f)), f)
  assert.ok(!existsSync(join(s, 'sub')))
  const rm = lines(r.out, 'REMOVED')
  assert.equal(rm.length, 2)
  assert.equal(rm.filter((l) => l.endsWith('/sub')).length, 1)
  assert.equal(rm.filter((l) => l.endsWith('/io-large.Zz9')).length, 1)
  assert.ok(!r.out.includes('sub/io-large.Qq1'))
})

test('a refused folder keeps its io-large file', () => {
  const s = folder()
  touch(s, 'io-large.Ab12Cd')
  let r = run(['clones', s, '--all'], { TMPDIR: s })
  assert.equal(r.status, 0)
  assert.match(r.out, /^KEPT .* refused: shared temp folder/m)
  assert.ok(existsSync(join(s, 'io-large.Ab12Cd')))
  spawnSync('git', ['-C', s, 'init', '-q'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  r = run(['clones', s, '--all'])
  assert.match(r.out, /refused: top of a git repo/)
  assert.ok(existsSync(join(s, 'io-large.Ab12Cd')))
  const ok = folder(); touch(ok, 'io-large.Ab12Cd')
  run(['clones', ok, '--all'])
  assert.ok(!existsSync(join(ok, 'io-large.Ab12Cd')))
})

test('a file that cannot be deleted is kept and the exit code is 0', { skip: process.getuid?.() === 0 }, () => {
  const s = folder()
  touch(s, 'io-large.Ab12Cd')
  chmodSync(s, 0o555)
  try {
    const r = run(['clones', s, '--all'])
    assert.equal(r.status, 0)
    assert.match(r.out, /^KEPT .*io-large\.Ab12Cd cannot delete$/m)
    assert.equal(lines(r.out, 'REMOVED').length, 0)
    assert.ok(existsSync(join(s, 'io-large.Ab12Cd')))
  } finally { chmodSync(s, 0o755) }
})
