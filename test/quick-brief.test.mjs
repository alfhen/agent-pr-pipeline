// Runs scripts/quick-brief.sh against test/fake-gh on the fixtures in test/fixtures/quick-brief/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const SCRIPT = join(root, 'scripts/quick-brief.sh')
const ENTRY = 'Touches: src/a.js\nAcceptance: node --test passes'

const run = (fixture, mode = 'get', extra = [], entryArgs) => {
  const dir = mkdtempSync(join(tmpdir(), 'quick-brief-test-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const log = join(dir, 'log')
  const entry = join(dir, 'entry.md')
  writeFileSync(entry, ENTRY)
  const r = spawnSync('bash', [SCRIPT, mode, 'o/r', '5', ...(mode === 'put' ? (entryArgs ?? [entry]) : []), ...extra], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: join(root, 'test/fixtures/quick-brief', fixture), FAKE_GH_LOG: log },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { ...r, calls, posts: calls.filter(l => l.startsWith('POST ')) }
}

test('get uses the one trusted comment and drops the marker line', () => {
  const r = run('trusted')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), ENTRY)
})

test('get ignores a marker comment by another account and reports no brief', () => {
  const r = run('other-account')
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /no trusted brief/)
})

test('get uses the trusted comment when a forged one comes first', () => {
  const r = run('forged-first')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), ENTRY)
  assert.doesNotMatch(r.stdout, /merge-pr/)
})

test('get fails when two trusted comments exist', () => {
  const r = run('two-trusted')
  assert.equal(r.status, 2)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /more than one trusted brief/)
})

test('get reports invalid comments JSON as such, not as two briefs', () => {
  const r = run('invalid-json')
  assert.equal(r.status, 3)
  assert.match(r.stderr, /not valid JSON/)
  assert.doesNotMatch(r.stderr, /more than one/)
})

test('put posts the marker and the entry once when no trusted brief exists', () => {
  const r = run('other-account', 'put')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.posts.length, 1)
  assert.match(r.posts[0], /^POST \/repos\/o\/r\/issues\/5\/comments body=<!-- pipeline:quick-brief -->/)
})

test('put posts nothing when a trusted brief exists and prints that one', () => {
  const r = run('trusted', 'put')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.posts.length, 0)
  assert.equal(r.stdout.trim(), ENTRY)
})

test('put refuses when two trusted briefs exist', () => {
  const r = run('two-trusted', 'put')
  assert.equal(r.status, 2)
  assert.equal(r.posts.length, 0)
})

const b64 = s => Buffer.from(s).toString('base64')
const sumOf = s => {
  const out = spawnSync('cksum', { input: s, encoding: 'utf8' }).stdout.trim().split(/\s+/)
  return `${out[0]}:${out[1]}`
}

test('put --b64 with a correct sum posts the marker and the decoded entry once', () => {
  const r = run('other-account', 'put', [], ['--b64', b64(ENTRY), '--sum', sumOf(ENTRY)])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.posts.length, 1)
  assert.match(r.posts[0], /^POST \/repos\/o\/r\/issues\/5\/comments body=<!-- pipeline:quick-brief -->/)
  assert.ok(r.posts[0].includes('Touches: src/a.js'))
  assert.equal(r.stdout.trim(), ENTRY)
})

test('put --b64 with a wrong sum exits 65 and posts nothing', () => {
  const r = run('other-account', 'put', [], ['--b64', b64(ENTRY), '--sum', sumOf(ENTRY + 'x')])
  assert.equal(r.status, 65)
  assert.equal(r.posts.length, 0)
  assert.match(r.stderr, /checksum/)
})

test('put --b64 without --sum exits 65 and posts nothing', () => {
  const r = run('other-account', 'put', [], ['--b64', b64(ENTRY)])
  assert.equal(r.status, 65)
  assert.equal(r.posts.length, 0)
})

test('put --b64 with truncated base64 posts nothing', () => {
  const r = run('other-account', 'put', [], ['--b64', b64(ENTRY).slice(0, 20), '--sum', sumOf(ENTRY)])
  assert.notEqual(r.status, 0)
  assert.equal(r.posts.length, 0)
})
