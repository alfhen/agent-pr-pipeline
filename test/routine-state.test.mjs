// Runs scripts/routine-state.sh against test/fake-gh. The shared fixtures are in test/fixtures/routine/base;
// each test writes the issues, comments and events it needs on top of them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const TRACKING = 100
const fname = path => path.replaceAll('/', '__')
const marker = n => `<!-- pipeline:routine triaged ${n} -->`

const issue = (number, o = {}) => ({
  number, state: 'open', title: `issue ${number}`, user: { login: o.user ?? 'bot' },
  labels: (o.labels ?? ['pipeline-feedback']).map(name => ({ name })),
  created_at: o.created ?? `2026-01-${String(number % 28 + 1).padStart(2, '0')}T00:00:00Z`,
  ...(o.pr ? { pull_request: {} } : {}), ...(o.state ? { state: o.state } : {}),
})
const comment = (user, body) => ({ user: { login: user }, body })
const record = (n, o = {}, user = 'bot') => {
  const c = comment(user, `${marker(n)}\n${JSON.stringify({ decision: 'build', size: 'S', risk: 'low', why: 'small', ...o })}`)
  assert.ok(c.body.startsWith(marker(n)))
  return c
}
const closedBy = login => ({ event: 'closed', actor: { login } })

// world: { issues: [...], records: [...], events: { n: [...] }, issueComments: { n: [...] }, tracking: false | number[] }
function setup(world = {}, { guard } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'routine-state-test-'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const fx = join(dir, 'fx')
  cpSync(join(root, 'test/fixtures/routine/base'), fx, { recursive: true })
  const put = (path, v) => writeFileSync(join(fx, `${fname(path)}.json`), JSON.stringify(v))
  const feedback = world.issues ?? []
  const trackingIssues = (world.tracking ?? [TRACKING]).map(n => issue(n, { labels: ['pipeline-routine'] }))
  put('repos/o/r/issues', [...trackingIssues, ...feedback.filter(i => i.state === 'open' && !i.pr)])
  for (const i of feedback) put(`repos/o/r/issues/${i.number}`, i)
  for (const i of feedback) put(`repos/o/r/issues/${i.number}/comments`, world.issueComments?.[i.number] ?? [])
  for (const i of feedback) put(`repos/o/r/issues/${i.number}/events`, world.events?.[i.number] ?? [])
  put(`repos/o/r/issues/${TRACKING}/comments`, world.records ?? [])
  const scriptDir = join(dir, 'g', 'plugin', 'scripts'); mkdirSync(scriptDir, { recursive: true })
  copyFileSync(join(root, 'scripts/routine-state.sh'), join(scriptDir, 'routine-state.sh'))
  copyFileSync(join(root, 'scripts/trusted-comment.jq'), join(scriptDir, 'trusted-comment.jq'))
  if (guard) {
    writeFileSync(join(dir, 'g', 'repo'), guard.repo ?? 'o/r')
    if (guard.mode) writeFileSync(join(dir, 'g', 'mode'), guard.mode)
  }
  return { dir, fx, bin, log: join(dir, 'log'), script: join(scriptDir, 'routine-state.sh'), put }
}

function run(s, ...args) {
  rmSync(s.log, { force: true })
  const r = spawnSync('bash', [s.script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log },
  })
  const calls = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  return { ...r, calls, writes: calls.filter(l => /^(POST|PATCH|PUT|DELETE) /.test(l)) }
}
const next = s => run(s, 'o/r', 'next')
const putTriaged = (s, ...a) => run(s, 'o/r', 'put', 'triaged', ...a)
const step = r => JSON.parse(r.stdout)

test('next without a tracking issue says init needed', () => {
  const s = setup({ tracking: [] })
  const r = next(s)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(step(r), { step: 'init needed' })
})

test('next lists the two untriaged issues, oldest first, and skips the triaged one', () => {
  const s = setup({
    issues: [issue(5, { created: '2026-02-01T00:00:00Z' }), issue(3, { created: '2026-03-01T00:00:00Z' }), issue(4, { created: '2026-01-01T00:00:00Z' })],
    records: [record(3, { decision: 'plan' })],
  })
  const r = next(s)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(step(r), { step: 'triage', issues: [4, 5] })
})

test('next lists at most five of seven untriaged issues', () => {
  const s = setup({ issues: [1, 2, 3, 4, 5, 6, 7].map(n => issue(n, { created: `2026-01-0${n}T00:00:00Z` })) })
  assert.deepEqual(step(next(s)), { step: 'triage', issues: [1, 2, 3, 4, 5] })
})

test('next ignores a record by another account', () => {
  const forged = record(3, {}, 'mallory')
  assert.ok(forged.body.startsWith(marker(3)) && forged.user.login !== 'bot')
  const s = setup({ issues: [issue(3)], records: [forged] })
  assert.deepEqual(step(next(s)), { step: 'triage', issues: [3] })
})

test('the record for issue 1 does not match issue 12', () => {
  const s = setup({ issues: [issue(1), issue(12)], records: [record(1)] })
  assert.deepEqual(step(next(s)), { step: 'triage', issues: [12] })
})

test('the record for issue 12 does not match issue 1', () => {
  const s = setup({ issues: [issue(1), issue(12)], records: [record(12)] })
  assert.deepEqual(step(next(s)), { step: 'triage', issues: [1] })
})

test('next skips an issue by another account and one without the label', () => {
  const s = setup({ issues: [issue(3, { user: 'mallory' }), issue(4, { labels: ['bug'] }), issue(5)] })
  assert.deepEqual(step(next(s)), { step: 'triage', issues: [5] })
})

test('next is idle when every issue has a build or plan record', () => {
  const s = setup({ issues: [issue(3), issue(4)], records: [record(3), record(4, { decision: 'plan' })] })
  assert.deepEqual(step(next(s)), { step: 'idle' })
})

test('next lists a decline record whose issue is still open and was not closed by the account', () => {
  const s = setup({ issues: [issue(3)], records: [record(3, { decision: 'decline' })] })
  assert.deepEqual(step(next(s)), { step: 'triage', issues: [3] })
})

test('next does not list a declined issue that the account closed and a person reopened', () => {
  const s = setup({ issues: [issue(3)], records: [record(3, { decision: 'decline' })], events: { 3: [closedBy('bot')] } })
  assert.deepEqual(step(next(s)), { step: 'idle' })
})

test('next lists a declined issue that only another account closed', () => {
  const s = setup({ issues: [issue(3)], records: [record(3, { decision: 'decline' })], events: { 3: [closedBy('mallory')] } })
  assert.deepEqual(step(next(s)), { step: 'triage', issues: [3] })
})

test('next fails on two trusted records for one issue', () => {
  const s = setup({ issues: [issue(3)], records: [record(3), record(3, { decision: 'plan' })] })
  const r = next(s)
  assert.equal(r.status, 2)
  assert.equal(r.stdout, '')
})

test('next fails on two tracking issues', () => {
  const r = next(setup({ tracking: [100, 101] }))
  assert.equal(r.status, 2)
  assert.match(r.stderr, /more than one open pipeline-routine/)
})

test('init fails on two open tracking issues and posts nothing', () => {
  const r = run(setup({ tracking: [100, 101] }), 'o/r', 'init')
  assert.equal(r.status, 2)
  assert.deepEqual(r.writes, [])
})

test('init prints the existing tracking issue and posts nothing', () => {
  const r = run(setup(), 'o/r', 'init')
  assert.equal(r.stdout.trim(), String(TRACKING))
  assert.deepEqual(r.writes, [])
})

test('init opens the tracking issue when there is none', () => {
  const r = run(setup({ tracking: [] }), 'o/r', 'init')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '100')
  assert.equal(r.writes.length, 1)
  assert.match(r.writes[0], /^POST \/repos\/o\/r\/issues .*labels\[\]=pipeline-routine/)
})

test('put stores a build of size L as plan and keeps the triager decision', () => {
  const s = setup({ issues: [issue(3)] })
  const r = putTriaged(s, '3', 'build', 'L', 'low', 'big')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { decision: 'plan', size: 'L', risk: 'low', why: 'big', triagerDecision: 'build' })
  assert.ok(r.writes.some(l => l.includes('labels[]=routine-plan')))
  assert.ok(r.writes.some(l => l.includes('triagerDecision')))
})

test('put stores a build with high risk as plan', () => {
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'high', 'risky')
  assert.equal(JSON.parse(r.stdout).decision, 'plan')
  assert.equal(JSON.parse(r.stdout).triagerDecision, 'build')
})

test('put keeps a small low-risk build as build, adds the label and does not close', () => {
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', 'small')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).triagerDecision, undefined)
  assert.ok(r.writes.some(l => l.includes('/issues/3/labels') && l.includes('routine-build')))
  assert.ok(!r.writes.some(l => l.startsWith('PATCH')))
})

for (const [name, args] of [
  ['an unknown decision', ['3', 'merge', 'S', 'low', 'x']],
  ['a size XL', ['3', 'build', 'XL', 'low', 'x']],
  ['a risk of none', ['3', 'build', 'S', 'none', 'x']],
  ['a why of 501 characters', ['3', 'build', 'S', 'low', 'x'.repeat(501)]],
  ['a why with a newline', ['3', 'build', 'S', 'low', 'a\nb']],
  ['a why with a C1 control character', ['3', 'build', 'S', 'low', 'a\u0085b']],
  ['a why with DEL', ['3', 'build', 'S', 'low', 'a\u007fb']],
  ['an empty why',['3', 'build', 'S', 'low', '']],
  ['an issue that is not a number', ['3x', 'build', 'S', 'low', 'x']],
]) {
  test(`put refuses ${name} and logs no call`, () => {
    const r = putTriaged(setup({ issues: [issue(3)] }), ...args)
    assert.equal(r.status, 64, r.stderr)
    assert.deepEqual(r.calls, [])
  })
}

test('put accepts a why of exactly 500 characters', () => {
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', 'x'.repeat(500))
  assert.equal(r.status, 0, r.stderr)
})

test('put and init refuse a trailing extra argument before any call', () => {
  const s = setup({ issues: [issue(3)] })
  const a = putTriaged(s, '3', 'build', 'S', 'low', 'x', 'next')
  assert.equal(a.status, 64); assert.deepEqual(a.calls, [])
  const b = run(s, 'o/r', 'init', 'next')
  assert.equal(b.status, 64); assert.deepEqual(b.calls, [])
  const c = run(s, 'o/r', 'next', 'extra')
  assert.equal(c.status, 64); assert.deepEqual(c.calls, [])
})

test('put refuses a record type other than triaged', () => {
  const r = run(setup({ issues: [issue(3)] }), 'o/r', 'put', 'wave-started', '3', 'build', 'S', 'low', 'x')
  assert.equal(r.status, 64)
  assert.deepEqual(r.calls, [])
})

test('a guard repo file refuses another repo with no call logged', () => {
  const s = setup({ issues: [issue(3)] }, { guard: { repo: 'o/r', mode: 'triage' } })
  const r = run(s, 'x/y', 'put', 'triaged', '3', 'build', 'S', 'low', 'x')
  assert.equal(r.status, 65)
  assert.deepEqual(r.calls, [])
  assert.equal(run(s, 'x/y', 'next').calls.length, 0)
})

test('a guard mode file that does not say triage refuses put with no call logged', () => {
  for (const mode of ['observe', 'full', undefined]) {
    const s = setup({ issues: [issue(3)] }, { guard: { mode } })
    const r = putTriaged(s, '3', 'build', 'S', 'low', 'x')
    assert.equal(r.status, 65, `mode ${mode}`)
    assert.deepEqual(r.calls, [])
  }
})

test('a guard mode file that says triage lets put write', () => {
  const s = setup({ issues: [issue(3)] }, { guard: { mode: 'triage\n' } })
  assert.equal(putTriaged(s, '3', 'build', 'S', 'low', 'x').status, 0)
})

test('init from a guard folder is refused with no call logged', () => {
  for (const mode of ['observe', 'triage']) {
    const r = run(setup({ tracking: [] }, { guard: { mode } }), 'o/r', 'init')
    assert.equal(r.status, 65, `mode ${mode}`)
    assert.deepEqual(r.calls, [])
  }
})

test('next works in observe mode', () => {
  const s = setup({ issues: [issue(3)] }, { guard: { mode: 'observe' } })
  assert.deepEqual(step(next(s)), { step: 'triage', issues: [3] })
})

test('put refuses a closed issue, an issue by another account, one without the label and a pull request', () => {
  for (const i of [issue(3, { state: 'closed' }), issue(3, { user: 'mallory' }), issue(3, { labels: ['bug'] }), issue(3, { pr: true })]) {
    const r = putTriaged(setup({ issues: [i] }), '3', 'build', 'S', 'low', 'x')
    assert.equal(r.status, 65, JSON.stringify(i))
    assert.deepEqual(r.writes, [])
  }
})

test('put for a decline posts the reason, stores the record, then closes, in that order', () => {
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'decline', 'S', 'low', 'out of scope')
  assert.equal(r.status, 0, r.stderr)
  const w = r.writes
  assert.equal(w.length, 3, w.join('\n'))
  assert.match(w[0], /^POST \/repos\/o\/r\/issues\/3\/comments body=<!-- pipeline:routine declined 3 -->\\nout of scope/)
  assert.match(w[1], new RegExp(`^POST /repos/o/r/issues/${TRACKING}/comments body=<!-- pipeline:routine triaged 3 -->`))
  assert.match(w[2], /^PATCH \/repos\/o\/r\/issues\/3 state=closed/)
})

test('put reruns the close when the record exists and the close failed, without a second record', () => {
  const s = setup({ issues: [issue(3)] })
  writeFileSync(join(s.fx, 'repos__o__r__issues__3.PATCH.error'), 'HTTP 502')
  const first = putTriaged(s, '3', 'decline', 'S', 'low', 'out of scope')
  assert.equal(first.status, 3)
  rmSync(join(s.fx, 'repos__o__r__issues__3.PATCH.error'))
  s.put(`repos/o/r/issues/${TRACKING}/comments`, [record(3, { decision: 'decline', why: 'out of scope' })])
  s.put('repos/o/r/issues/3/comments', [comment('bot', '<!-- pipeline:routine declined 3 -->\nout of scope')])
  const second = putTriaged(s, '3', 'decline', 'S', 'low', 'out of scope')
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(second.writes.map(l => l.split(' ')[0] + ' ' + l.split(' ')[1]), ['PATCH /repos/o/r/issues/3'])
})

test('put with different input uses the stored record and posts no second record', () => {
  const s = setup({ issues: [issue(3, { labels: ['pipeline-feedback', 'routine-plan'] })], records: [record(3, { decision: 'plan', size: 'M', why: 'stored' })] })
  const r = putTriaged(s, '3', 'decline', 'S', 'low', 'new input')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).why, 'stored')
  assert.deepEqual(r.writes, [])
})

test('put does not close an issue the account closed before and a person reopened', () => {
  const s = setup({
    issues: [issue(3)], records: [record(3, { decision: 'decline' })], events: { 3: [closedBy('bot')] },
    issueComments: { 3: [comment('bot', '<!-- pipeline:routine declined 3 -->\nwhy')] },
  })
  const r = putTriaged(s, '3', 'decline', 'S', 'low', 'x')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.writes, [])
})

test('put posts the decline reason once when a forged declined comment exists', () => {
  const forged = comment('mallory', '<!-- pipeline:routine declined 3 -->\nfake')
  const r = putTriaged(setup({ issues: [issue(3)], issueComments: { 3: [forged] } }), '3', 'decline', 'S', 'low', 'real')
  assert.ok(r.writes[0].includes('declined 3 -->\\nreal'))
})

test('put fails when the tracking issue is missing', () => {
  const r = putTriaged(setup({ issues: [issue(3)], tracking: [] }), '3', 'build', 'S', 'low', 'x')
  assert.equal(r.status, 65)
  assert.deepEqual(r.writes, [])
})
