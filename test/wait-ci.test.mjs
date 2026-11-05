// Runs wait-ci.sh against test/fake-gh with fixtures built in each test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const P = 'repos__o__r'
const HEAD = 'b'.repeat(40)
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))

// runs and statuses: one fixture, or an array of fixtures read one per call (the last repeats).
const setup = ({ runs = [], statuses = [] }) => {
  const dir = mkdtempSync(join(tmpdir(), 'wait-ci-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  put(fx, `${P}__pulls__7.json`, { head: { sha: HEAD } })
  const seq = (name, key, v) => {
    if (Array.isArray(v[0])) v.forEach((x, i) => put(fx, `${P}__commits__${HEAD}__${name}.call${i + 1}.json`, { [key]: x }))
    else put(fx, `${P}__commits__${HEAD}__${name}.json`, { [key]: v })
  }
  seq('check-runs', 'check_runs', runs)
  seq('status', 'statuses', statuses)
  return { dir, fx }
}
const done = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion })
const run = (s, minutes = '3') => spawnSync('bash', [join(root, 'scripts/wait-ci.sh'), 'o/r', '7', minutes], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, WAIT_CI_INTERVAL: '0' },
})

test('all check runs complete and green: success', () => {
  const r = run(setup({ runs: [done('ci'), done('lint', 'skipped')] }))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { head: HEAD, state: 'success', failed: [], timedOut: false })
})

test('a failed check run: failure with its name', () => {
  const r = run(setup({ runs: [done('ci', 'failure'), done('lint')] }))
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'failure')
  assert.deepEqual(out.failed, ['ci'])
  assert.equal(out.timedOut, false)
})

test('a check run that stays in progress: pending with timedOut at the limit', () => {
  const r = run(setup({ runs: [done('lint'), { name: 'ci', status: 'in_progress', conclusion: null }] }), '2')
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'pending')
  assert.equal(out.timedOut, true)
})

test('a pending commit status with green check runs is pending, never success', () => {
  const r = run(setup({ runs: [done('ci')], statuses: [{ context: 'bot/review', state: 'pending' }] }), '2')
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'pending')
  assert.equal(out.timedOut, true)
})

test('a failed commit status is a failure with its context', () => {
  const r = run(setup({ runs: [done('ci')], statuses: [{ context: 'bot/review', state: 'error' }] }))
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'failure')
  assert.deepEqual(out.failed, ['bot/review'])
})

test('checks that finish on a later poll end the wait without timedOut', () => {
  const pending = [{ name: 'ci', status: 'queued', conclusion: null }]
  const r = run(setup({ runs: [pending, [done('ci')]] }), '5')
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'success')
  assert.equal(out.timedOut, false)
})

test('a head with no check runs yet is pending, never success', () => {
  const r = run(setup({ runs: [], statuses: [] }), '2')
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'pending')
  assert.equal(out.timedOut, true)
})

test('check runs that appear on a later poll give success', () => {
  const r = run(setup({ runs: [[], [done('ci')]] }), '5')
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'success')
  assert.equal(out.timedOut, false)
})

test('a failed GitHub call exits 3', () => {
  const s = setup({ runs: [done('ci')] })
  put(s.fx, `${P}__commits__${HEAD}__check-runs.GET.error`, 'HTTP 500')
  const r = run(s)
  assert.equal(r.status, 3)
})

test('a bad minutes value exits 2', () => {
  const r = run(setup({}), 'x')
  assert.equal(r.status, 2)
})

test("commit statuses alone, all green: success", () => {
  const out = JSON.parse(run(setup({ runs: [], statuses: [{ context: "legacy/ci", state: "success" }] })).stdout)
  assert.equal(out.state, "success")
  assert.equal(out.timedOut, false)
})

test("no check runs and no statuses: pending", () => {
  const out = JSON.parse(run(setup({}), "2").stdout)
  assert.equal(out.state, "pending")
  assert.equal(out.timedOut, true)
})
