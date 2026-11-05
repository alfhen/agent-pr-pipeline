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

const sentenceWhy = 'Short start. ' + 'a'.repeat(300) + '. ' + 'b'.repeat(300)

test('put cuts a why over 500 characters at the last sentence end', () => {
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', sentenceWhy)
  assert.equal(r.status, 0, r.stderr)
  const rec = JSON.parse(r.stdout)
  assert.equal(rec.why, 'Short start. ' + 'a'.repeat(300) + '.')
  assert.ok(rec.why.length <= 500)
  assert.equal(rec.whyCut, true)
  assert.ok(r.writes.some(l => l.includes(`/issues/${TRACKING}/comments`) && l.includes('whyCut')))
})

test('put cuts a why with no sentence end at 500 characters', () => {
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', 'x'.repeat(600))
  assert.equal(r.status, 0, r.stderr)
  const rec = JSON.parse(r.stdout)
  assert.equal(rec.why, 'x'.repeat(500))
  assert.equal(rec.whyCut, true)
})

test('put stores a short why unchanged', () => {
  for (const why of ['x'.repeat(500), 'short one. ok']) {
    const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', why)
    assert.equal(r.status, 0, r.stderr)
    const rec = JSON.parse(r.stdout)
    assert.equal(rec.why, why)
    assert.ok(!('whyCut' in rec))
  }
})

test('put cuts a why with multibyte characters at 500 code points and keeps valid UTF-8', () => {
  const why = 'a'.repeat(498) + '\u00e9\u{1F600}' + 'z'.repeat(50)
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', why)
  assert.equal(r.status, 0, r.stderr)
  const rec = JSON.parse(r.stdout)
  assert.equal([...rec.why].length, 500)
  assert.equal(rec.why, [...why].slice(0, 500).join(''))
  assert.ok(!rec.why.includes('\ufffd'))
  assert.equal(rec.whyCut, true)
})

test('put cuts a long why to its last sentence end and treats a period without a space as no end', () => {
  const why = 'a'.repeat(100) + '.b' + 'c'.repeat(500)
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', why)
  assert.equal(JSON.parse(r.stdout).why, why.slice(0, 500))
})

test('put keeps a sentence-end cut within 500 characters when a later sentence end lies past 500', () => {
  const why = 'a'.repeat(200) + '. ' + 'b'.repeat(400) + '. tail'
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', why)
  assert.equal(r.status, 0, r.stderr)
  const rec = JSON.parse(r.stdout)
  assert.equal(rec.why, 'a'.repeat(200) + '.')
  assert.equal(rec.whyCut, true)
})

test('put cuts at a sentence end at index 499 and never stores 501 characters for one at index 500', () => {
  const at499 = 'a'.repeat(499) + '. ' + 'b'.repeat(50)
  const rec1 = JSON.parse(putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', at499).stdout)
  assert.equal(rec1.why, 'a'.repeat(499) + '.')
  assert.equal(rec1.whyCut, true)
  const at500 = 'a'.repeat(500) + '. ' + 'b'.repeat(50)
  const rec2 = JSON.parse(putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'S', 'low', at500).stdout)
  assert.equal(rec2.why, 'a'.repeat(500))
  assert.equal(rec2.whyCut, true)
})

test('put posts the cut why as the decline comment', () => {
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'decline', 'S', 'low', sentenceWhy)
  assert.equal(r.status, 0, r.stderr)
  const post = r.writes.find(l => l.includes('/issues/3/comments'))
  assert.ok(post, r.writes.join('\n'))
  assert.ok(post.includes('a'.repeat(300) + '.'))
  assert.ok(!post.includes('b'.repeat(10)))
})

test('put posts a decline why cut before a later sentence end past 500', () => {
  const why = 'a'.repeat(200) + '. ' + 'b'.repeat(400) + '. tail'
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'decline', 'S', 'low', why)
  const post = r.writes.find(l => l.includes('/issues/3/comments'))
  assert.ok(post.includes('a'.repeat(200) + '.'))
  assert.ok(!post.includes('bbbb') && !post.includes('tail'))
})

test('put cuts a long why of a build of size L and keeps the plan rule', () => {
  const r = putTriaged(setup({ issues: [issue(3)] }), '3', 'build', 'L', 'low', 'x'.repeat(600))
  const rec = JSON.parse(r.stdout)
  assert.equal(rec.decision, 'plan')
  assert.equal(rec.whyCut, true)
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

test('a guard mode file that says neither triage nor full refuses put with no call logged', () => {
  for (const mode of ['observe', 'other', undefined]) {
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

// ---- full mode stage 1 ----

const iso = hoursAgo => new Date(Date.now() - hoursAgo * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z')
const RUN = n => `20261105T0${n}0000Z-${n}${n}`
const bmark = (type, n) => `<!-- pipeline:routine ${type} ${n} -->`
const started = (n, o = {}, user = 'bot') => ({
  user: { login: user }, created_at: iso(o.age ?? 1),
  body: `${bmark('build-started', n)}\n${o.raw ?? JSON.stringify({ run: o.run ?? RUN(1), branch: o.branch ?? `routine/issue-${n}` })}`,
})
const blockedRec = (n, o = {}, user = 'bot') => ({
  user: { login: user }, created_at: iso(1),
  body: `${bmark('blocked', n)}\n${o.raw ?? JSON.stringify({ reason: 'build ended with no PR', run: RUN(1) })}`,
})
const buildIssue = (n, o = {}) => issue(n, { labels: ['routine-build'], created: `2026-01-${String(n % 28 + 1).padStart(2, '0')}T00:00:00Z`, ...o })
const pr = (ref, o = {}) => ({ number: o.number ?? 900, state: o.state ?? 'open', user: { login: o.user ?? 'bot' }, head: { ref }, merged_at: o.merged ?? null })

// extra: { config, pulls (open PR list), branchPrs: { n: [pr] }, prefix: false }
function fullSetup(world = {}, mode = 'full', extra = {}) {
  const s = setup(world, { guard: { mode } })
  const plugin = join(s.dir, 'g', 'plugin')
  mkdirSync(join(plugin, 'routine'), { recursive: true })
  copyFileSync(join(root, 'routine/config.jq'), join(plugin, 'routine/config.jq'))
  if (extra.prefix !== false) copyFileSync(join(root, 'routine/branch-prefix'), join(plugin, 'routine/branch-prefix'))
  if (extra.config !== undefined) writeFileSync(join(s.dir, 'g', 'routine.json'), typeof extra.config === 'string' ? extra.config : JSON.stringify(extra.config))
  s.put('repos/o/r/pulls', extra.pulls ?? [])
  for (const i of world.issues ?? []) {
    // The slash in the branch makes the fake-gh query fixture a file in a folder.
    mkdirSync(join(s.fx, `${fname('repos/o/r/pulls')}@state=all&head=o:routine`), { recursive: true })
    writeFileSync(join(s.fx, `${fname('repos/o/r/pulls')}@state=all&head=o:routine/issue-${i.number}.json`), JSON.stringify(extra.branchPrs?.[i.number] ?? []))
  }
  return s
}
const nextFull = s => run(s, 'o/r', 'next', '--mode', 'full')
const goodConfig = { waveArgs: { goals: 'docs/goals.md', checks: ['node test/sim-pipeline.mjs'] } }

for (const mode of [[], ['--mode', 'observe'], ['--mode', 'triage']]) {
  test(`next ${mode.join(' ') || 'with no mode'} prints the same line, with no full-mode fields, for a routine-build issue`, () => {
    const s = fullSetup({ issues: [issue(3), buildIssue(4)], records: [record(4), started(4)] })
    const r = run(s, 'o/r', 'next', ...mode)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '{"step":"triage","issues":[3]}\n')
    assert.ok(!r.calls.some(c => c.includes('pulls')))
  })
}

test('next --mode full without a tracking issue says init needed with no session', () => {
  const r = nextFull(fullSetup({ tracking: [] }))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(step(r), { step: 'init needed', session: false, held: [] })
})

test('next --mode full refuses an unknown mode word', () => {
  const r = run(fullSetup(), 'o/r', 'next', '--mode', 'merge')
  assert.equal(r.status, 64)
  assert.deepEqual(r.calls, [])
})

test('block: a build-started record with no PR gives a block step with no session', () => {
  const s = fullSetup({ issues: [buildIssue(4)], records: [record(4), started(4, { run: RUN(2) })] })
  const r = nextFull(s)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(step(r), { step: 'block', session: false, issue: 4, run: RUN(2), reason: 'build ended with no PR', held: [], config: 'defaults' })
  assert.ok(r.calls.some(c => c.includes('head=o:routine/issue-4')))
})

for (const [name, prs] of [
  ['open', [pr('routine/issue-4')]],
  ['merged', [pr('routine/issue-4', { state: 'closed', merged: '2026-11-05T00:00:00Z' })]],
  ['closed unmerged', [pr('routine/issue-4', { state: 'closed' })]],
]) {
  test(`no block when the PR from the branch is ${name}`, () => {
    const s = fullSetup({ issues: [buildIssue(4)], records: [record(4), started(4)] }, 'full', { branchPrs: { 4: prs } })
    assert.ok(!['block', 'build'].includes(step(nextFull(s)).step))
  })
}

test('a PR by another account from the branch does not end the block', () => {
  const s = fullSetup({ issues: [buildIssue(4)], records: [record(4), started(4)] }, 'full', { branchPrs: { 4: [pr('routine/issue-4', { user: 'mallory' })] } })
  assert.equal(step(nextFull(s)).step, 'block')
})

test('no block when the label was removed or the issue is closed', () => {
  for (const i of [issue(4, { labels: ['bug'] }), buildIssue(4, { state: 'closed' })]) {
    const s = fullSetup({ issues: [i], records: [record(4), started(4)] })
    assert.equal(step(nextFull(s)).step, 'idle', JSON.stringify(i))
  }
})

test('a blocked record holds the issue: no second block, and it is listed in held', () => {
  const s = fullSetup({ issues: [buildIssue(4)], records: [record(4), started(4), blockedRec(4)] })
  const out = step(nextFull(s))
  assert.equal(out.step, 'idle')
  assert.deepEqual(out.held, [{ issue: 4, why: 'blocked' }])
})

test('a forged blocked record by another account does not hold the issue', () => {
  const forged = blockedRec(4, {}, 'mallory')
  assert.ok(forged.body.startsWith(bmark('blocked', 4)))
  const s = fullSetup({ issues: [buildIssue(4)], records: [record(4), started(4), forged] })
  assert.equal(step(nextFull(s)).step, 'block')
})

test('the oldest of two unfinished builds is blocked first', () => {
  const s = fullSetup({ issues: [buildIssue(5, { created: '2026-02-01T00:00:00Z' }), buildIssue(6, { created: '2026-01-01T00:00:00Z' })],
    records: [record(5), record(6), started(5), started(6)] })
  assert.equal(step(nextFull(s)).issue, 6)
})

test('build: four pending issues with buildIssues 3 gives three, oldest first, each with its branch', () => {
  const issues = [14, 12, 13, 11].map((n, k) => buildIssue(n, { created: `2026-01-0${k + 1}T00:00:00Z` }))
  const s = fullSetup({ issues, records: issues.map(i => record(i.number)) })
  const r = nextFull(s)
  assert.equal(r.status, 0, r.stderr)
  const out = step(r)
  assert.equal(out.step, 'build'); assert.equal(out.session, true)
  assert.equal(out.config, 'defaults')
  assert.deepEqual(out.issues, [14, 12, 13].map(n => ({ issue: n, branch: `routine/issue-${n}` })))
})

test('build uses the limits of routine.json', () => {
  const issues = [buildIssue(1), buildIssue(2), buildIssue(3)]
  const s = fullSetup({ issues, records: issues.map(i => record(i.number)) }, 'full', { config: { ...goodConfig, limits: { buildIssues: 1 } } })
  const out = step(nextFull(s))
  assert.equal(out.issues.length, 1)
  assert.equal(out.config, undefined)
})

test('a bad routine.json gives the defaults', () => {
  const issues = [buildIssue(1), buildIssue(2), buildIssue(3), buildIssue(4)]
  const s = fullSetup({ issues, records: issues.map(i => record(i.number)) }, 'full', { config: '{"waveArgs":{"goals":"g","checks":[],"plan":"x"}}' })
  const out = step(nextFull(s))
  assert.equal(out.issues.length, 3); assert.equal(out.config, 'defaults')
})

test('a pending issue needs a trusted triaged record with decision build', () => {
  const s = fullSetup({ issues: [buildIssue(1), buildIssue(2), buildIssue(3)],
    records: [record(1, { decision: 'plan' }), record(2, {}, 'mallory')] })
  assert.equal(step(nextFull(s)).step, 'idle')
})

test('no build at three open routine PRs, and a PR from fix/x does not count', () => {
  const routinePrs = [1, 2, 3].map(n => pr(`routine/issue-${n + 50}`, { number: 800 + n }))
  const w = { issues: [buildIssue(1)], records: [record(1)] }
  const held = step(nextFull(fullSetup(w, 'full', { pulls: routinePrs })))
  assert.equal(held.step, 'wait'); assert.equal(held.heldBy, 'limits')
  const free = step(nextFull(fullSetup(w, 'full', { pulls: [pr('fix/x'), pr('fix/y'), pr('fix/z'), ...routinePrs.slice(0, 2)] })))
  assert.equal(free.step, 'build')
})

test('an open routine PR by another account does not count for the limit', () => {
  const pulls = [1, 2, 3].map(n => pr(`routine/issue-${n + 50}`, { user: 'mallory' }))
  assert.equal(step(nextFull(fullSetup({ issues: [buildIssue(1)], records: [record(1)] }, 'full', { pulls }))).step, 'build')
})

test('no build when two runs posted build-started in the last 24 hours; the same run twice counts once; 25 hours old does not count', () => {
  const w = runs => ({ issues: [buildIssue(1)], records: [record(1), ...runs] })
  const limited = step(nextFull(fullSetup(w([started(8, { run: RUN(1) }), started(9, { run: RUN(2), age: 23 })]))))
  assert.equal(limited.step, 'wait'); assert.equal(limited.heldBy, 'limits')
  assert.equal(step(nextFull(fullSetup(w([started(8, { run: RUN(1) }), started(9, { run: RUN(1) })])))).step, 'build')
  assert.equal(step(nextFull(fullSetup(w([started(8, { run: RUN(1) }), started(9, { run: RUN(2), age: 25 })])))).step, 'build')
})

test('a limit that holds a build still gives triage when there is triage work', () => {
  const s = fullSetup({ issues: [buildIssue(1), issue(2)], records: [record(1), started(8, { run: RUN(1) }), started(9, { run: RUN(2) })] })
  const out = step(nextFull(s))
  assert.equal(out.step, 'triage'); assert.equal(out.session, true)
  assert.deepEqual(out.issues, [2]); assert.equal(out.heldBy, 'limits')
})

test('a limit of 0 never builds', () => {
  for (const limits of [{ buildIssues: 0 }, { openPRs: 0 }, { wavesPerDay: 0 }]) {
    const s = fullSetup({ issues: [buildIssue(1)], records: [record(1)] }, 'full', { config: { ...goodConfig, limits } })
    const out = step(nextFull(s))
    assert.equal(out.step, 'wait', JSON.stringify(limits)); assert.equal(out.heldBy, 'limits')
  }
})

test('an issue with a build-started record is never built again', () => {
  const s = fullSetup({ issues: [buildIssue(1)], records: [record(1), started(1, { age: 30 })] }, 'full', { branchPrs: { 1: [pr('routine/issue-1')] } })
  assert.notEqual(step(nextFull(s)).step, 'build')
})

test('a forged build-started or triaged record by another account changes no step', () => {
  const forgedStart = started(1, {}, 'mallory'); const forgedTriage = record(2, {}, 'mallory')
  assert.ok(forgedStart.body.startsWith(bmark('build-started', 1)) && forgedTriage.body.startsWith(marker(2)))
  const s = fullSetup({ issues: [buildIssue(1), buildIssue(2)], records: [record(1), forgedStart, forgedTriage] })
  const out = step(nextFull(s))
  assert.equal(out.step, 'build'); assert.deepEqual(out.issues.map(i => i.issue), [1])
})

test('a build-started record that does not parse is skipped, listed in held, and next exits 0', () => {
  for (const raw of ['not json', '{"run":"x"}', '[]']) {
    const s = fullSetup({ issues: [buildIssue(4)], records: [record(4), started(4, { raw })] })
    const r = nextFull(s)
    assert.equal(r.status, 0, r.stderr)
    const out = step(r)
    assert.equal(out.step, 'idle', raw)
    assert.deepEqual(out.held, [{ issue: 4, why: 'bad build-started record' }])
  }
})

test('two trusted records for one key and a bad triaged record are held, not a failed next', () => {
  const s = fullSetup({ issues: [buildIssue(4), issue(6)], records: [record(4), started(4), started(4), { ...record(6), body: `${marker(6)}\nnope` }] })
  const r = nextFull(s)
  assert.equal(r.status, 0, r.stderr)
  const out = step(r)
  assert.deepEqual(out.held.map(h => h.issue).sort(), [4, 6])
  assert.equal(out.step, 'idle')
})

test('wait when a routine PR is open and nothing else applies, idle otherwise', () => {
  assert.equal(step(nextFull(fullSetup({}, 'full', { pulls: [pr('routine/issue-9')] }))).step, 'wait')
  assert.equal(step(nextFull(fullSetup())).step, 'idle')
})

test('session is true only for the steps in the one SESSION_STEPS line', () => {
  const src = readFileSync(join(root, 'scripts/routine-state.sh'), 'utf8')
  assert.equal(src.match(/^SESSION_STEPS=/gm).length, 1)
  assert.match(src, /^SESSION_STEPS="build triage"$/m)
  for (const [w, extra, want] of [
    [{ tracking: [] }, {}, false],
    [{ issues: [buildIssue(4)], records: [record(4), started(4)] }, {}, false],
    [{ issues: [buildIssue(4)], records: [record(4)] }, {}, true],
    [{ issues: [issue(4)] }, {}, true],
    [{}, { pulls: [pr('routine/issue-9')] }, false],
    [{}, {}, false],
  ]) assert.equal(step(nextFull(fullSetup(w, 'full', extra))).session, want)
})

test('next --mode full fails on two tracking issues and on a failed GitHub call', () => {
  assert.equal(nextFull(fullSetup({ tracking: [100, 101] })).status, 2)
  const s = fullSetup({ issues: [issue(3)] })
  rmSync(join(s.fx, 'repos__o__r__pulls.json'))
  assert.equal(nextFull(s).status, 3)
})

test('next --mode full exits 3 with no output when only the head= PR call fails', () => {
  const s = fullSetup({ issues: [buildIssue(4)], records: [record(4), started(4)] })
  writeFileSync(join(s.fx, `${fname('repos/o/r/pulls')}@state=all&head=o:routine/issue-4.json`), '{}')
  const r = nextFull(s)
  assert.equal(r.status, 3); assert.equal(r.stdout, '')
})

test('next --mode full exits 3 with no output when the events call fails for a decline record', () => {
  const s = fullSetup({ issues: [issue(3)], records: [record(3, { decision: 'decline' })] })
  rmSync(join(s.fx, 'repos__o__r__issues__3__events.json'))
  const r = nextFull(s)
  assert.equal(r.status, 3); assert.equal(r.stdout, '')
})

test('next --mode full exits 3 when routine/branch-prefix is missing', () => {
  const r = nextFull(fullSetup({}, 'full', { prefix: false }))
  assert.equal(r.status, 3)
  assert.match(r.stderr, /branch-prefix/)
})

const run_ = (s, ...a) => run(s, 'o/r', ...a)
const putStarted = (s, n = '4', runId = RUN(1), branch = `routine/issue-${n}`) => run_(s, 'put', 'build-started', n, runId, branch)
const putBlocked = (s, n = '4', runId = RUN(1)) => run_(s, 'put', 'blocked', n, runId)
const stored = r => r.writes.filter(l => l.includes(`/issues/${TRACKING}/comments`))
const ready = (o = {}) => fullSetup({ issues: [buildIssue(4)], records: [record(4), ...(o.records ?? [])] }, 'mode' in o ? o.mode : 'full')

test('put build-started writes one record in full mode, and also with CLAUDECODE set', () => {
  const r = putStarted(ready())
  assert.equal(r.status, 0, r.stderr)
  assert.equal(stored(r).length, 1)
  assert.ok(stored(r)[0].includes(`${bmark('build-started', 4)}\\n{"run":"${RUN(1)}","branch":"routine/issue-4"}`))
  const s = ready()
  const withEnv = spawnSync('bash', [s.script, 'o/r', 'put', 'build-started', '4', RUN(1), 'routine/issue-4'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDECODE: '1', PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log },
  })
  assert.equal(withEnv.status, 0, withEnv.stderr)
  assert.equal(readFileSync(s.log, 'utf8').split('\n').filter(l => l.includes(`/issues/${TRACKING}/comments`) && l.startsWith('POST')).length, 1)
})

test('put build-started twice: the second is refused with no write', () => {
  const r = putStarted(ready({ records: [started(4)] }))
  assert.equal(r.status, 65); assert.deepEqual(r.writes, [])
})

test('a build-started record by another account does not block the write', () => {
  assert.equal(stored(putStarted(ready({ records: [started(4, {}, 'mallory')] }))).length, 1)
})

test('put build-started is refused for no label, a closed issue, or no trusted build record', () => {
  for (const [i, recs] of [[issue(4, { labels: ['pipeline-feedback'] }), [record(4)]], [buildIssue(4, { state: 'closed' }), [record(4)]], [buildIssue(4), []], [buildIssue(4), [record(4, { decision: 'plan' })]], [buildIssue(4), [record(4, {}, 'mallory')]]]) {
    const r = putStarted(fullSetup({ issues: [i], records: recs }))
    assert.equal(r.status, 65, JSON.stringify(i)); assert.deepEqual(r.writes, [])
  }
})

test('put build-started refuses a branch that breaks the rule and a bad run with exit 64 and no call', () => {
  for (const args of [['4', RUN(1), 'routine/issue-5'], ['4', RUN(1), 'fix/issue-4'], ['4', RUN(1), 'routine/issue-4x'], ['4', 'run-1', 'routine/issue-4'], ['4x', RUN(1), 'routine/issue-4']]) {
    const r = putStarted(ready(), ...args)
    assert.equal(r.status, 64, args.join(' ')); assert.deepEqual(r.calls, [])
  }
})

test('put build-started and blocked need the mode full in a guard folder', () => {
  for (const mode of ['triage', 'observe', null]) {
    for (const f of [putStarted, putBlocked]) {
      const r = f(ready({ mode }))
      assert.equal(r.status, 65, `${mode}`); assert.deepEqual(r.calls, [])
    }
  }
})

test('put blocked writes one record, refuses a second, and ignores a forged one', () => {
  const r = putBlocked(ready())
  assert.equal(r.status, 0, r.stderr)
  assert.ok(stored(r)[0].includes(`${bmark('blocked', 4)}\\n{"reason":"build ended with no PR","run":"${RUN(1)}"}`))
  const again = putBlocked(ready({ records: [blockedRec(4)] }))
  assert.equal(again.status, 65); assert.deepEqual(again.writes, [])
  assert.equal(stored(putBlocked(ready({ records: [blockedRec(4, {}, 'mallory')] }))).length, 1)
})

test('put triaged works in full mode and is refused in observe mode', () => {
  const r = run_(fullSetup({ issues: [issue(3)] }, 'full'), 'put', 'triaged', '3', 'build', 'S', 'low', 'small')
  assert.equal(r.status, 0, r.stderr); assert.equal(stored(r).length, 1)
  const obs = run_(fullSetup({ issues: [issue(3)] }, 'observe'), 'put', 'triaged', '3', 'build', 'S', 'low', 'small')
  assert.equal(obs.status, 65); assert.deepEqual(obs.calls, [])
})

test('put build-started and blocked refuse a wrong argument count', () => {
  const s = ready()
  assert.equal(run_(s, 'put', 'blocked', '4').status, 64)
  assert.equal(run_(s, 'put', 'build-started', '4', RUN(1)).status, 64)
  assert.equal(run_(s, 'put', 'blocked', '4', RUN(1), 'x').status, 64)
})

test('put build-started exits 3 when routine/branch-prefix is missing', () => {
  const r = putStarted(fullSetup({ issues: [buildIssue(4)], records: [record(4)] }, 'full', { prefix: false }))
  assert.equal(r.status, 3); assert.deepEqual(r.calls, [])
})

test('with bin and bin-full on PATH, the script reaches bin-full and never bin', () => {
  const s = ready()
  const x = join(s.dir, 'x'); const logf = join(s.dir, 'which')
  for (const d of ['bin', 'bin-full']) {
    mkdirSync(join(x, 'routine', d), { recursive: true })
    writeFileSync(join(x, 'routine', d, 'gh'), `#!/bin/bash\necho ${d} >> "${logf}"\nexec "${s.bin}/gh" "$@"\n`)
    chmodSync(join(x, 'routine', d, 'gh'), 0o755)
  }
  const r = spawnSync('bash', [s.script, 'o/r', 'next', '--mode', 'full'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${x}/routine/bin:${x}/routine/bin-full:${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual([...new Set(readFileSync(logf, 'utf8').split('\n').filter(Boolean))], ['bin-full'])
})

// config.jq and trusted-comment.jq
const jq = (file, input, ...args) => spawnSync('jq', ['-c', ...args, '-f', join(root, file)], { input, encoding: 'utf8' })
const cfg = o => jq('routine/config.jq', JSON.stringify(o))
const DEFAULTS = { openPRs: 3, wavesPerDay: 2, buildIssues: 3, maxRunMinutes: 240 }

test('config.jq fills the defaults in a good file', () => {
  const r = cfg({ ...goodConfig, limits: { openPRs: 5 } })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { ...goodConfig, limits: { ...DEFAULTS, openPRs: 5 } })
  assert.deepEqual(JSON.parse(cfg(goodConfig).stdout).limits, DEFAULTS)
})

test('config.jq with -n and no input prints the defaults only', () => {
  const r = spawnSync('jq', ['-nc', '-f', join(root, 'routine/config.jq')], { encoding: 'utf8' })
  assert.deepEqual(JSON.parse(r.stdout), { limits: DEFAULTS })
})

for (const key of ['repo', 'tmp', 'pluginRoot', 'prs', 'plan', 'feedback', 'feedbackRepo', 'resumeFromRunId']) {
  test(`config.jq refuses waveArgs.${key}`, () => {
    const input = { waveArgs: { ...goodConfig.waveArgs, [key]: 'x' } }
    assert.ok(key in input.waveArgs)
    const r = cfg(input)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, new RegExp(`waveArgs.${key} is not allowed`))
  })
}

for (const [name, input, re] of [
  ['no goals', { waveArgs: { checks: [] } }, /goals/],
  ['checks that is not a list', { waveArgs: { goals: 'g', checks: 'x' } }, /checks/],
  ['checks with a non-string', { waveArgs: { goals: 'g', checks: [1] } }, /checks/],
  ['no waveArgs', { limits: {} }, /waveArgs/],
  ['a limit of 21', { ...goodConfig, limits: { openPRs: 21 } }, /openPRs/],
  ['a limit of -1', { ...goodConfig, limits: { wavesPerDay: -1 } }, /wavesPerDay/],
  ['a limit that is not an integer', { ...goodConfig, limits: { buildIssues: 1.5 } }, /buildIssues/],
  ['maxRunMinutes 5', { ...goodConfig, limits: { maxRunMinutes: 5 } }, /maxRunMinutes/],
  ['maxRunMinutes 1441', { ...goodConfig, limits: { maxRunMinutes: 1441 } }, /maxRunMinutes/],
  ['an unknown top-level key', { ...goodConfig, extra: 1 }, /unknown key extra/],
  ['an unknown limit', { ...goodConfig, limits: { nope: 1 } }, /unknown limit nope/],
  ['openPRs null', { ...goodConfig, limits: { openPRs: null } }, /openPRs/],
  ['maxRunMinutes null', { ...goodConfig, limits: { maxRunMinutes: null } }, /maxRunMinutes/],
  ['wavesPerDay null', { ...goodConfig, limits: { wavesPerDay: null } }, /wavesPerDay/],
  ['buildIssues null', { ...goodConfig, limits: { buildIssues: null } }, /buildIssues/],
  ['a list', [], /JSON object/],
]) {
  test(`config.jq refuses ${name} with one line`, () => {
    const r = cfg(input)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, re)
    assert.equal(r.stderr.trim().split('\n').length, 1)
  })
}

test('config.jq accepts the edges of the ranges', () => {
  const r = cfg({ ...goodConfig, limits: { openPRs: 0, wavesPerDay: 20, buildIssues: 20, maxRunMinutes: 1440 } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(cfg({ ...goodConfig, limits: { maxRunMinutes: 10 } }).stdout).limits.maxRunMinutes, 10)
})

test('trusted-comment.jq: two matches without all is an error, with all it is a list of two', () => {
  const input = JSON.stringify([comment('bot', '<!-- m -->\na'), comment('bot', '<!-- m -->\nb'), comment('mallory', '<!-- m -->\nc')])
  const a = ['--arg', 'prefix', '<!-- m -->', '--arg', 'user', 'bot']
  assert.notEqual(jq('scripts/trusted-comment.jq', input, ...a).status, 0)
  const all = jq('scripts/trusted-comment.jq', input, ...a, '--arg', 'all', '1')
  assert.equal(all.status, 0, all.stderr)
  assert.deepEqual(JSON.parse(all.stdout), ['<!-- m -->\na', '<!-- m -->\nb'])
  assert.deepEqual(JSON.parse(jq('scripts/trusted-comment.jq', JSON.stringify([comment('bot', '<!-- m -->\na')]), ...a).stdout), '<!-- m -->\na')
  assert.equal(jq('scripts/trusted-comment.jq', '[]', ...a).stdout.trim(), 'null')
})
