// The end read of wait-ci.sh (one poll): the failed set and the retry of a bad GitHub reply.
// gh is a wrapper that serves a bad reply for the first calls of one path and sends everything else to test/fake-gh.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const P = 'repos__o__r'
const HEAD = 'c'.repeat(40)
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))
const HTML = '<html>Server Error</html>'

const WRAPPER = `#!/bin/bash
# bad: path glob, times: how many calls of that path are bad (-1 = all), kind: html | pulls | 502
echo "$*" >> "$WRAP_LOG"
case "$*" in
  *$WRAP_BAD*)
    n=$(cat "$WRAP_COUNT" 2>/dev/null || echo 0)
    if [ "$WRAP_TIMES" -lt 0 ] || [ "$n" -lt "$WRAP_TIMES" ]; then
      echo $((n+1)) > "$WRAP_COUNT"
      case "$WRAP_KIND" in
        html) echo '${HTML}'; exit 0 ;;
        pulls) echo "invalid character 'S' looking for beginning of value" >&2; exit 1 ;;
        502) echo "gh: Server Error (HTTP 502)" >&2; exit 1 ;;
      esac
    fi ;;
esac
exec "$(dirname "$0")/fake-gh" "$@"
`

const done = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion })
const setup = ({ runs = [done('ci')], statuses = [], bad } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'wait-ci-end-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'fake-gh')); chmodSync(join(bin, 'fake-gh'), 0o755)
  put(bin, 'gh', WRAPPER); chmodSync(join(bin, 'gh'), 0o755)
  put(fx, `${P}__pulls__7.json`, { head: { sha: HEAD } })
  put(fx, `${P}__commits__${HEAD}__check-runs.json`, { check_runs: runs })
  put(fx, `${P}__commits__${HEAD}__status.json`, { statuses })
  return { dir, fx, bad }
}
const run = (s, { minutes = '1', interval = '0' } = {}) => {
  const env = {
    ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx,
    FAKE_GH_LOG: join(s.dir, 'fake.log'), WRAP_LOG: join(s.dir, 'wrap.log'), WRAP_COUNT: join(s.dir, 'wrap.count'),
    WRAP_BAD: s.bad ? s.bad.path : 'NO-SUCH-PATH', WRAP_TIMES: String(s.bad ? s.bad.times : 0), WRAP_KIND: s.bad ? s.bad.kind : 'html',
  }
  if (interval === null) delete env.WAIT_CI_INTERVAL; else env.WAIT_CI_INTERVAL = interval
  const t = Date.now()
  const r = spawnSync('bash', [join(root, 'scripts/wait-ci.sh'), 'o/r', '7', minutes], { encoding: 'utf8', env })
  return { ...r, secs: (Date.now() - t) / 1000 }
}
const calls = (s, path) => (existsSync(join(s.dir, 'wrap.log')) ? readFileSync(join(s.dir, 'wrap.log'), 'utf8') : '').split('\n').filter(l => l.includes(path)).length
const parse = r => JSON.parse(r.stdout.trim().split('\n').pop())
const SUCCESS = { head: HEAD, state: 'success', failed: [], timedOut: false }

for (const c of ['cancelled', 'stale']) {
  test(`a ${c} check run does not make the state failure`, () => {
    const r = run(setup({ runs: [done('ci'), done('e2e', c)] }))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(parse(r), SUCCESS)
  })
}

for (const c of ['failure', 'timed_out', 'action_required']) {
  test(`a ${c} check run gives failure and is named`, () => {
    const r = run(setup({ runs: [done('ci'), done('bad', c)] }))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(parse(r), { head: HEAD, state: 'failure', failed: ['bad'], timedOut: false })
  })
}
for (const st of ['failure', 'error']) {
  test(`a status with state ${st} gives failure and is named`, () => {
    const r = run(setup({ statuses: [{ context: 'ext/bad', state: st }] }))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(parse(r), { head: HEAD, state: 'failure', failed: ['ext/bad'], timedOut: false })
  })
}

test('the failed list holds only failure, timed_out, action_required and failing statuses', () => {
  const r = run(setup({ runs: [done('unit', 'failure'), done('e2e', 'cancelled'), done('old', 'stale'), done('ci')], statuses: [{ context: 'ext/x', state: 'error' }] }))
  assert.equal(r.status, 0, r.stderr)
  const out = parse(r)
  assert.equal(out.state, 'failure')
  assert.deepEqual([...out.failed].sort(), ['ext/x', 'unit'])
})

const retryCases = {
  'a pulls reply that fails once': { path: 'pulls/7', times: 1, kind: 'pulls' },
  'a check-runs reply that is an HTML page once': { path: 'check-runs', times: 1, kind: 'html' },
  'a status reply that is an HTML page once': { path: '/status', times: 1, kind: 'html' },
  'a check-runs request that fails once with HTTP 502': { path: 'check-runs', times: 1, kind: '502' },
}
for (const [name, bad] of Object.entries(retryCases)) {
  test(`${name} is tried again and gives the good state`, () => {
    const s = setup({ bad })
    const r = run(s)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(parse(r), SUCCESS)
    assert.ok(calls(s, bad.path) >= 2)
    assert.equal((r.stdout + r.stderr).split('\n').filter(l => l.startsWith('{')).length, 1)
  })
}

for (const [path, kind] of [['check-runs', 'html'], ['pulls/7', 'pulls']]) {
  test(`when every ${path} reply is bad the script exits 3 and names the number of tries`, () => {
    const s = setup({ bad: { path, times: -1, kind } })
    const r = run(s)
    assert.equal(r.status, 3)
    assert.equal(r.stdout.trim(), '')
    const n = calls(s, path)
    assert.match(r.stderr, new RegExp(`after ${n} tries`))
  })
}

test('the number of tries does not depend on the minutes and the run ends soon', () => {
  const counts = []
  for (const minutes of ['1', '9']) {
    const s = setup({ bad: { path: 'check-runs', times: -1, kind: 'html' } })
    const r = run(s, { minutes })
    assert.equal(r.status, 3)
    assert.ok(r.secs <= 30, `${r.secs}s`)
    counts.push(calls(s, 'check-runs'))
  }
  assert.equal(counts[0], counts[1])
  assert.ok(counts[0] >= 2 && counts[0] <= 5)
})

test('the wait between tries is not the poll interval', () => {
  const s = setup({ bad: { path: 'check-runs', times: 1, kind: 'html' } })
  const r = run(s, { interval: null })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(parse(r).state, 'success')
  assert.ok(r.secs <= 30, `${r.secs}s`)
  const s2 = setup({ bad: { path: 'check-runs', times: -1, kind: 'html' } })
  const r2 = run(s2, { interval: null })
  assert.equal(r2.status, 3)
  assert.ok(r2.secs <= 30, `${r2.secs}s`)
})

test('good replies with CI still running are not tried again', () => {
  const s = setup({ runs: [{ name: 'ci', status: 'in_progress', conclusion: null }] })
  const r = run(s)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(parse(r).state, 'pending')
  assert.equal(parse(r).timedOut, true)
  assert.equal(calls(s, 'check-runs'), 1)
})

test('for seeded random fixtures the failed set is the land-wave.sh set', () => {
  let seed = 7
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const concl = ['success', 'neutral', 'skipped', 'cancelled', 'stale', 'startup_failure', 'failure', 'timed_out', 'action_required']
  const stateOf = ['success', 'pending', 'failure', 'error']
  for (let k = 0; k < 25; k++) {
    const runs = Array.from({ length: 1 + rnd(6) }, (_, i) => rnd(5) === 0 ? { name: `r${i}`, status: 'in_progress', conclusion: null } : done(`r${i}`, concl[rnd(concl.length)]))
    const statuses = Array.from({ length: rnd(4) }, (_, i) => ({ context: `s${i}`, state: stateOf[rnd(4)] }))
    const want = [...runs.filter(x => ['failure', 'timed_out', 'action_required'].includes(x.conclusion)).map(x => x.name), ...statuses.filter(x => ['failure', 'error'].includes(x.state)).map(x => x.context)].sort()
    const pending = runs.some(x => x.status !== 'completed') || statuses.some(x => x.state === 'pending')
    const out = parse(run(setup({ runs, statuses })))
    assert.deepEqual([...out.failed].sort(), want, JSON.stringify({ runs, statuses }))
    assert.equal(out.state, want.length ? 'failure' : pending ? 'pending' : 'success', JSON.stringify({ runs, statuses }))
  }
})
