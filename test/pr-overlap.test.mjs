// Runs pr-overlap.sh with the fake gh. A wrapper copies each -F body=@file before the script deletes it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const P = 'repos__o__r'
const MARKER = '<!-- pipeline:overlap -->'
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))
const files = names => names.map(filename => ({ filename }))

// open: { number: [file names] } for every open PR, the PR under test (7) included.
const setup = ({ open, comments = [], login = 'me' }) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-overlap-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(dir, 'fake-gh')); chmodSync(join(dir, 'fake-gh'), 0o755)
  writeFileSync(join(bin, 'gh'), `#!/bin/bash
for a in "$@"; do case "$a" in body=@*) cp "\${a#body=@}" "${dir}/posted-body" ;; esac; done
exec "${dir}/fake-gh" "$@"
`)
  chmodSync(join(bin, 'gh'), 0o755)
  put(fx, 'user.json', { login })
  put(fx, `${P}__pulls.json`, Object.keys(open).map(n => ({ number: Number(n) })))
  for (const [n, names] of Object.entries(open)) put(fx, `${P}__pulls__${n}__files.json`, files(names))
  put(fx, `${P}__issues__7__comments.json`, comments)
  return { dir, fx, log: join(dir, 'log'), body: join(dir, 'posted-body') }
}
const run = s => spawnSync('bash', [join(root, 'scripts/pr-overlap.sh'), 'o/r', '7'], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log },
})
const posts = s => (existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n') : []).filter(l => l.startsWith('POST '))

test('a shared file posts one comment that names the PR and the file', () => {
  const s = setup({ open: { 7: ['a.js', 'b.js'], 8: ['b.js', 'c.js'], 9: ['z.js'] } })
  const r = run(s)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'posted')
  assert.equal(posts(s).length, 1)
  assert.match(posts(s)[0], /^POST \/repos\/o\/r\/issues\/7\/comments body=@/)
  const body = readFileSync(s.body, 'utf8')
  assert.equal(body.split('\n')[0], MARKER)
  assert.match(body, /#8: `b\.js`/)
  assert.doesNotMatch(body, /#9|c\.js|a\.js/)
  assert.match(body, /Merge them one at a time/)
})

test('no shared file posts nothing and prints none', () => {
  const s = setup({ open: { 7: ['a.js'], 8: ['b.js'] } })
  const r = run(s)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'none')
  assert.equal(posts(s).length, 0)
})

test('a second run posts nothing when the marker comment from the same account exists', () => {
  const s = setup({ open: { 7: ['a.js'], 8: ['a.js'] } })
  assert.equal(run(s).stdout.trim(), 'posted')
  put(s.fx, `${P}__issues__7__comments.json`, [{ user: { login: 'me' }, body: readFileSync(s.body, 'utf8') }])
  const r = run(s)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'already posted')
  assert.equal(posts(s).length, 1)
})

test('a marker comment from another account does not count', () => {
  const s = setup({ open: { 7: ['a.js'], 8: ['a.js'] }, comments: [{ user: { login: 'someone' }, body: `${MARKER}\nfake` }] })
  const r = run(s)
  assert.equal(r.stdout.trim(), 'posted')
  assert.equal(posts(s).length, 1)
})

test('more than 5 shared files print the count of the others', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(x => `${x}.js`)
  const s = setup({ open: { 7: names, 8: names } })
  const r = run(s)
  assert.equal(r.status, 0, r.stderr)
  const body = readFileSync(s.body, 'utf8')
  assert.match(body, /`e\.js` and 2 others/)
  assert.doesNotMatch(body, /f\.js/)
})

const others = n => { const open = { 7: ['a.js'] }; for (let i = 8; i < 8 + n; i++) open[i] = ['b.js']; return open }

test('it says when more than 30 other PRs are open, and does not read the 31st', () => {
  const s = setup({ open: others(31) })
  const r = run(s)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /stopped at the first 30 open pull requests/)
  const log = readFileSync(s.log, 'utf8')
  assert.match(log, /pulls\/37\/files/)
  assert.doesNotMatch(log, /pulls\/38\/files/)
})

test('exactly 30 other open PRs print no stop message', () => {
  const s = setup({ open: others(30) })
  const r = run(s)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /stopped at/)
  assert.match(readFileSync(s.log, 'utf8'), /pulls\/37\/files/)
})

test('a failed GitHub read exits 1 and posts nothing', () => {
  const s = setup({ open: { 7: ['a.js'], 8: ['a.js'] } })
  put(s.fx, `${P}__pulls__8__files.GET.error`, 'HTTP 500')
  const r = run(s)
  assert.equal(r.status, 1)
  assert.equal(posts(s).length, 0)
})
