// Runs scripts/ci-state.jq on check runs and commit statuses, and checks that the four CI scripts use it and keep no conclusion set.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const URL9 = 'https://github.com/o/r/actions/runs/55/job/9'
const done = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion, details_url: URL9 })
const jq = (runs, statuses = []) => {
  const r = spawnSync('jq', ['-c', '-f', join(root, 'scripts/ci-state.jq')], { input: JSON.stringify({ runs, statuses }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(out).sort(), ['failed', 'failedRuns', 'failedStatuses', 'noRuns', 'pending', 'state'])
  return out
}

test('success, skipped and neutral are green', () => {
  const o = jq([done('a'), done('b', 'skipped'), done('c', 'neutral')])
  assert.deepEqual(o, { state: 'success', failed: [], failedRuns: [], failedStatuses: [], pending: [], noRuns: false })
})

test('every other conclusion fails, with the details url', () => {
  const names = ['failure', 'timed_out', 'action_required', 'cancelled', 'stale', 'startup_failure']
  const o = jq(names.map((n) => done(n, n)))
  assert.equal(o.state, 'failure')
  assert.deepEqual(o.failed, names)
  assert.deepEqual(o.failedRuns, names.map((name) => ({ name, details_url: URL9 })))
})

test('runs that are not complete are pending', () => {
  const o = jq([{ name: 'a', status: 'in_progress', conclusion: null }, { name: 'b', status: 'queued', conclusion: null }])
  assert.equal(o.state, 'pending')
  assert.deepEqual(o.pending, ['a', 'b'])
})

test('a failed or error status fails, a pending status is pending', () => {
  for (const state of ['failure', 'error']) {
    const o = jq([done('ci')], [{ context: 'ext/ci', state }])
    assert.equal(o.state, 'failure')
    assert.deepEqual(o.failed, ['ext/ci'])
    assert.deepEqual(o.failedRuns, [])
  }
  const p = jq([done('ci')], [{ context: 'ext/ci', state: 'pending' }])
  assert.equal(p.state, 'pending')
  assert.deepEqual(p.pending, ['ext/ci'])
})

test('no check run and a green status is noRuns, not success', () => {
  const o = jq([], [{ context: 'ext/ci', state: 'success' }])
  assert.equal(o.noRuns, true)
  assert.notEqual(o.state, 'success')
})

test('a failed run wins over a pending run', () => {
  const o = jq([done('e2e', 'failure'), { name: 'ci', status: 'in_progress', conclusion: null }])
  assert.equal(o.state, 'failure')
  assert.deepEqual(o.failed, ['e2e'])
  assert.deepEqual(o.pending, ['ci'])
})

test('the saved real check runs of PR 805 are green', () => {
  const runs = JSON.parse(readFileSync(join(root, 'test/fixtures/clean-review/pr805-f36bb8e.json'), 'utf8')).checks
  const o = jq(runs)
  assert.equal(o.state, 'success')
  assert.equal(o.noRuns, false)
})

test('the four scripts name ci-state.jq, hold no conclusion set and use no gh pr or gh issue command', () => {
  for (const f of ['wait-ci.sh', 'land-wave.sh', 'merge-pr.sh', 'release.sh']) {
    const src = readFileSync(join(root, 'scripts', f), 'utf8')
    assert.match(src, /ci-state\.jq/, f)
    assert.doesNotMatch(src, /timed_out|"neutral"|"action_required"/, f)
    assert.doesNotMatch(src, /gh (pr|issue)/, f)
  }
})

test('a failed status is listed in failedStatuses even when a failed run has its name', () => {
  const o = jq([done('e2e', 'failure')], [{ context: 'e2e', state: 'failure' }, { context: 'ext/ok', state: 'success' }])
  assert.deepEqual(o.failedStatuses, ['e2e'])
  assert.deepEqual(o.failedRuns.map((r) => r.name), ['e2e'])
})
