// Runs wait-ci.sh against test/fake-gh when a gh call keeps failing: the give-up line names gh's error and no line starts with "{".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const P = 'repos__o__r'
const HEAD = 'b'.repeat(40)
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))

const failing = ({ pull = true, error }) => {
  const dir = mkdtempSync(join(tmpdir(), 'wait-ci-error-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  if (pull) put(fx, `${P}__pulls__7.json`, { head: { sha: HEAD } })
  if (error) put(fx, `${P}__commits__${HEAD}__check-runs.GET.error`, error)
  const r = spawnSync('bash', [join(root, 'scripts/wait-ci.sh'), 'o/r', '7', '1'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: fx, WAIT_CI_INTERVAL: '0' },
  })
  return { ...r, lines: (r.stdout + r.stderr).split('\n').filter(Boolean) }
}
const giveUp = (r) => r.stderr.split('\n').filter((l) => l.includes('gave up'))

test('wait-ci: a failing check-runs call gives up with the error text of gh on the same line', () => {
  const r = failing({ error: 'gh: Server Error (HTTP 502)' })
  assert.equal(r.status, 3)
  assert.equal(r.stdout, '')
  const g = giveUp(r)
  assert.equal(g.length, 1)
  assert.match(g[0], /^wait-ci: cannot read check runs, gave up after 3 tries .*gh: Server Error \(HTTP 502\)/)
})

test('wait-ci: a JSON error text never starts a line', () => {
  const r = failing({ error: '{"message":"Bad credentials","status":"401"}' })
  assert.equal(r.status, 3)
  assert.match(giveUp(r)[0], /Bad credentials/)
  for (const l of r.lines) assert.ok(!l.trim().startsWith('{'), l)
})

test('wait-ci: an unreadable PR gives up with the error text of gh', () => {
  const r = failing({ pull: false })
  assert.equal(r.status, 3)
  assert.match(giveUp(r)[0], /^wait-ci: cannot read #7, gave up after 3 tries .*HTTP 404/)
})
