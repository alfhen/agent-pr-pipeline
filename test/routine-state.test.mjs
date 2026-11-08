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
  body: `${bmark('build-started', n)}\n${o.raw ?? JSON.stringify({ run: o.run ?? RUN(1), branch: o.branch ?? `claude/issue-${n}` })}`,
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
    mkdirSync(join(s.fx, `${fname('repos/o/r/pulls')}@state=all&head=o:claude`), { recursive: true })
    writeFileSync(join(s.fx, `${fname('repos/o/r/pulls')}@state=all&head=o:claude/issue-${i.number}.json`), JSON.stringify(extra.branchPrs?.[i.number] ?? []))
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
  assert.ok(r.calls.some(c => c.includes('head=o:claude/issue-4')))
})

for (const [name, prs] of [
  ['open', [pr('claude/issue-4')]],
  ['merged', [pr('claude/issue-4', { state: 'closed', merged: '2026-11-05T00:00:00Z' })]],
  ['closed unmerged', [pr('claude/issue-4', { state: 'closed' })]],
]) {
  test(`no block when the PR from the branch is ${name}`, () => {
    const s = fullSetup({ issues: [buildIssue(4)], records: [record(4), started(4)] }, 'full', { branchPrs: { 4: prs } })
    assert.ok(!['block', 'build'].includes(step(nextFull(s)).step))
  })
}

test('a PR by another account from the branch does not end the block', () => {
  const s = fullSetup({ issues: [buildIssue(4)], records: [record(4), started(4)] }, 'full', { branchPrs: { 4: [pr('claude/issue-4', { user: 'mallory' })] } })
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

test('a blocked record with no build-started record gives no build step and is held', () => {
  for (const b of [blockedRec(4), blockedRec(4, { raw: 'not json' })]) {
    const out = step(nextFull(fullSetup({ issues: [buildIssue(4)], records: [record(4), b] })))
    assert.equal(out.step, 'idle')
    assert.deepEqual(out.held, [{ issue: 4, why: 'blocked' }])
  }
})

test('put build-started is refused with exit 65 when a blocked record exists', () => {
  const r = putStarted(ready({ records: [blockedRec(4)] }))
  assert.equal(r.status, 65); assert.deepEqual(r.writes, [])
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
  assert.deepEqual(out.issues, [14, 12, 13].map(n => ({ issue: n, branch: `claude/issue-${n}` })))
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
  const routinePrs = [1, 2, 3].map(n => pr(`claude/issue-${n + 50}`, { number: 800 + n }))
  const w = { issues: [buildIssue(1)], records: [record(1)] }
  const held = step(nextFull(fullSetup(w, 'full', { pulls: routinePrs })))
  assert.equal(held.step, 'wait'); assert.equal(held.heldBy, 'limits')
  const free = step(nextFull(fullSetup(w, 'full', { pulls: [pr('fix/x'), pr('fix/y'), pr('fix/z'), ...routinePrs.slice(0, 2)] })))
  assert.equal(free.step, 'build')
})

test('an open routine PR by another account does not count for the limit', () => {
  const pulls = [1, 2, 3].map(n => pr(`claude/issue-${n + 50}`, { user: 'mallory' }))
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
  const s = fullSetup({ issues: [buildIssue(1)], records: [record(1), started(1, { age: 30 })] }, 'full', { branchPrs: { 1: [pr('claude/issue-1')] } })
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
  assert.equal(step(nextFull(fullSetup({}, 'full', { pulls: [pr('claude/issue-9')] }))).step, 'wait')
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
    [{}, { pulls: [pr('claude/issue-9')] }, false],
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
  writeFileSync(join(s.fx, `${fname('repos/o/r/pulls')}@state=all&head=o:claude/issue-4.json`), '{}')
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
const putStarted = (s, n = '4', runId = RUN(1), branch = `claude/issue-${n}`) => run_(s, 'put', 'build-started', n, runId, branch)
const putBlocked = (s, n = '4', runId = RUN(1)) => run_(s, 'put', 'blocked', n, runId)
const stored = r => r.writes.filter(l => l.includes(`/issues/${TRACKING}/comments`))
const ready = (o = {}) => fullSetup({ issues: [buildIssue(4)], records: [record(4), ...(o.records ?? [])] }, 'mode' in o ? o.mode : 'full')

test('put build-started writes one record in full mode, and also with CLAUDECODE set', () => {
  const r = putStarted(ready())
  assert.equal(r.status, 0, r.stderr)
  assert.equal(stored(r).length, 1)
  assert.ok(stored(r)[0].includes(`${bmark('build-started', 4)}\\n{"run":"${RUN(1)}","branch":"claude/issue-4"}`))
  const s = ready()
  const withEnv = spawnSync('bash', [s.script, 'o/r', 'put', 'build-started', '4', RUN(1), 'claude/issue-4'], {
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
  for (const args of [['4', RUN(1), 'claude/issue-5'], ['4', RUN(1), 'fix/issue-4'], ['4', RUN(1), 'claude/issue-4x'], ['4', 'run-1', 'claude/issue-4'], ['4x', RUN(1), 'claude/issue-4']]) {
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

test('config.jq with -n and no input prints the 0.7.0 defaults in limits', () => {
  const r = spawnSync('jq', ['-nc', '-f', join(root, 'routine/config.jq')], { encoding: 'utf8' })
  assert.deepEqual(JSON.parse(r.stdout).limits, DEFAULTS)
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


// ---- Cloud routines (0.8.0) ----
// A small world model: c_apply() copies the writes of a command (records, labels) into the world, so a test can run
// a step, its put and then next again.
import { createHash } from 'node:crypto'
const c_BASE = Date.now() - 5 * 3600e3
const c_T = m => new Date(c_BASE + m * 60e3).toISOString().replace(/\.\d+Z$/, 'Z')
const c_OLD = new Date(Date.now() - 30 * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z')
let c_nextId = 1000
const c_sha = (title, body) => createHash('sha256').update(`${title}\n${body}`).digest('hex')
const c_ROUTINE = { stage: 1, pipelineVersion: 'v0.8.0', maintainer: 'alfhen', waveArgs: { goals: 'docs/goals.md', checks: ['node test/sim-pipeline.mjs'] } }
const c_CRUN = n => `20261105T1200${String(n).padStart(2, '0')}Z-0a1b2c3${n % 10}`

const c_ci = (number, o = {}) => ({
  number, state: 'open', title: `issue ${number}`, body: o.body ?? `body ${number}`, user: { login: o.user ?? 'alfhen' },
  labels: (o.labels ?? []).map(name => ({ name })), created_at: o.created ?? c_T(0),
  ...(o.pr ? { pull_request: {} } : {}),
})
const c_cc = (user, at, body = 'hi', updated) => ({ id: ++c_nextId, user: { login: user }, created_at: at, updated_at: updated ?? at, body })
const c_cr = (kind, key, rec, o = {}) => ({
  id: o.id ?? ++c_nextId, user: { login: o.user ?? 'alfhen' }, created_at: o.at ?? c_T(10),
  body: `<!-- pipeline:routine ${kind} ${key} -->\n${o.raw ?? JSON.stringify(rec)}`,
})
const c_lab = (label, actor, at, app = null) => ({ event: 'labeled', label: { name: label }, actor: { login: actor }, created_at: at, performed_via_github_app: app })
const c_approved = at => [c_lab('maintainer-approved', 'alfhen', at)]
const c_triagedRec = (n, o = {}) => c_cr('triaged', `${n}:${o.epoch ?? 0}`, { decision: 'build', size: 'S', risk: 'low', type: 'bug', why: 'ok', ...o.rec }, { at: o.at ?? c_T(20), id: o.id })
const c_startedRec = (n, a, o = {}) => c_cr('build-started', `${n}:${a}`, { run: o.run ?? c_CRUN(a), branch: `claude/issue-${n}`, attempt: a }, { at: o.at ?? c_T(30) })
const c_blockedRec = (n, a, o = {}) => c_cr('blocked', `${n}:${a}`, { run: o.run ?? c_CRUN(a), reasonCode: 'other', attempt: a }, { at: o.at ?? c_T(40) })
const c_cpr = (ref, o = {}) => ({ number: o.number ?? 900, state: o.state ?? 'open', user: { login: o.user ?? 'alfhen' }, head: { ref }, merged_at: null })

// w: { issues, comments: {n: []}, events: {n: []}, records, pulls, trackingLabels, settings, noTracking }
function csetup(w = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'routine-cloud-test-'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const fx = join(dir, 'fx')
  cpSync(join(root, 'test/fixtures/routine/base'), fx, { recursive: true })
  const plugin = join(dir, 'g', 'plugin')
  mkdirSync(join(plugin, 'scripts'), { recursive: true }); mkdirSync(join(plugin, 'routine'), { recursive: true })
  for (const f of ['routine-state.sh', 'trusted-comment.jq', 'approval.jq']) copyFileSync(join(root, 'scripts', f), join(plugin, 'scripts', f))
  copyFileSync(join(root, 'routine/config.jq'), join(plugin, 'routine/config.jq'))
  copyFileSync(join(root, 'routine/branch-prefix'), join(plugin, 'routine/branch-prefix'))
  const s = {
    dir, fx, bin, log: join(dir, 'log'), script: join(plugin, 'scripts/routine-state.sh'),
    w: { issues: [], comments: {}, events: {}, records: [], pulls: [], trackingLabels: [], settings: { gates: [], routine: c_ROUTINE }, ...w },
  }
  s.sync = () => {
    const put = (path, v) => writeFileSync(join(fx, `${fname(path)}.json`), JSON.stringify(v))
    const x = s.w
    put('user', { login: 'alfhen' })
    put('repos/o/r/contents/.github/pipeline.json', x.settings)
    const tracking = x.noTracking ? [] : [{ ...c_ci(100, { labels: ['pipeline-routine', ...x.trackingLabels] }) }]
    put('repos/o/r/issues', [...tracking, ...x.issues])
    for (const i of x.issues) {
      put(`repos/o/r/issues/${i.number}`, i)
      put(`repos/o/r/issues/${i.number}/comments`, x.comments[i.number] ?? [])
      put(`repos/o/r/issues/${i.number}/events`, x.events[i.number] ?? [])
    }
    put('repos/o/r/issues/100/comments', x.records)
    put('repos/o/r/pulls', x.pulls)
    writeFileSync(join(fx, `${fname('repos/o/r/issues/100/comments')}.POST.json`), JSON.stringify({ id: 5000 }))
  }
  s.sync()
    return s
}

const c_issueOf = (s, n) => s.w.issues.find(i => i.number === n)
function c_apply(s, r) {
  for (const c of r.calls) {
    let m
    if ((m = c.match(/^POST \/repos\/o\/r\/issues\/(\d+)\/comments body=(.*)$/s))) {
      const body = m[2].replaceAll('\\n', '\n')
      if (m[1] === '100') s.w.records.push({ id: ++c_nextId, user: { login: 'alfhen' }, created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), body })
      else (s.w.comments[m[1]] ??= []).push(c_cc('alfhen', new Date().toISOString(), body))
    } else if ((m = c.match(/^POST \/repos\/o\/r\/issues\/(\d+)\/labels (.*)$/))) {
      const i = c_issueOf(s, Number(m[1]))
      for (const l of m[2].split(' ')) { const name = l.replace('labels[]=', ''); if (!i.labels.some(x => x.name === name)) { i.labels.push({ name }); (s.w.events[i.number] ??= []).push(c_lab(name, 'alfhen', new Date().toISOString().replace(/\.\d+Z$/, 'Z'), 'claude')) } }
    } else if ((m = c.match(/^DELETE \/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/))) {
      const i = c_issueOf(s, Number(m[1])); i.labels = i.labels.filter(x => x.name !== m[2])
    }
  }
  s.sync()
}
const c_labelsOf = (s, n) => c_issueOf(s, n).labels.map(l => l.name).sort()
const c_startFile = (s, o = {}) => {
  const f = join(s.dir, 'start.json')
  writeFileSync(f, JSON.stringify({ version: 'v0.8.0', pluginRoot: '/opt/agent-pr-pipeline/v0.8.0', agentPrefix: 'apl-v0-8-0-', defaultSha: 'abc', ...o }))
  return f
}
const c_cnext = (s, mode = 'cloud-triage', startOpts) => mode === 'cloud-build'
  ? run(s, 'o/r', 'next', '--mode', 'cloud-build', '--start', c_startFile(s, startOpts))
  : run(s, 'o/r', 'next', '--mode', 'cloud-triage')
const c_lines = r => r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const c_one = r => { assert.equal(r.status, 0, r.stderr); const l = c_lines(r); assert.equal(l.length, 1, r.stdout); return l[0] }
const c_ok = r => { assert.equal(r.status, 0, r.stderr); const l = c_lines(r); assert.ok(l.length > 0, 'next printed no line'); return l }
const c_onlyReads = r => assert.deepEqual(r.writes, [], r.writes.join('\n'))
const c_cput = (s, ...a) => run(s, 'o/r', 'put', ...a)
// Runs the put, applies its writes and returns the result.
const c_doPut = (s, ...a) => { const r = c_cput(s, ...a); assert.equal(r.status, 0, r.stderr); c_apply(s, r); return r }
// A trusted, triaged-as-build issue by the maintainer.
const c_readyIssue = (n, o = {}) => ({
  issue: c_ci(n, { labels: ['ready-to-build'], ...o.issue }),
  events: [c_lab('ready-to-build', 'alfhen', c_T(25), 'claude')],
  records: [c_triagedRec(n, o.tri)],
})
const c_withIssues = (...parts) => ({
  issues: parts.map(p => p.issue),
  events: Object.fromEntries(parts.map(p => [p.issue.number, p.events ?? []])),
  comments: Object.fromEntries(parts.map(p => [p.issue.number, p.comments ?? []])),
  records: parts.flatMap(p => p.records ?? []),
})
const c_bare = (n, o = {}) => ({ issue: c_ci(n, o), events: o.events, comments: o.comments, records: o.records })

test('gate prints each answer and next agrees', () => {
  const g = (w) => { const s = csetup(w); return [run(s, 'o/r', 'gate').stdout.trim(), c_one(c_cnext(s)).step] }
  assert.deepEqual(g({}), ['stage 1', 'idle'])
  assert.deepEqual(g({ noTracking: true }), ['init needed', 'init needed'])
  assert.deepEqual(g({ trackingLabels: ['routine-paused'] }), ['paused', 'paused'])
  assert.deepEqual(g({ settings: { gates: [] } }), ['paused', 'paused'])
  assert.deepEqual(g({ settings: { routine: { ...c_ROUTINE, stage: 0 } } }), ['stage 0', 'idle'])
})

test('a paused tracking issue does not stay paused after anyone removes the label', () => {
  const s = csetup({ trackingLabels: ['routine-paused'], ...c_withIssues(c_bare(5)) })
  assert.equal(c_one(c_cnext(s)).step, 'paused')
  s.w.trackingLabels = []; s.sync()
  assert.deepEqual(c_one(c_cnext(s)), { step: 'triage', issues: [5] })
})

test('next reads the settings from the default branch with the raw header and refuses a bad file', () => {
  const s = csetup(c_withIssues(c_bare(5)))
  const r = c_cnext(s)
  assert.ok(r.calls.some(c => c === 'GET /repos/o/r/contents/.github/pipeline.json'))
  s.w.settings = { routine: { ...c_ROUTINE, stage: 3 } }; s.sync()
  const bad = c_cnext(s)
  assert.equal(bad.status, 3)
  assert.match(bad.stderr, /stage 3 needs a later release/)
})

test('a trusted new issue is triaged and next only reads', () => {
  const s = csetup(c_withIssues(c_bare(5)))
  const r = c_cnext(s)
  assert.deepEqual(c_one(r), { step: 'triage', issues: [5] })
  c_onlyReads(r)
})

test('an untrusted issue gets the untrusted step and never triage', () => {
  const s = csetup(c_withIssues(c_bare(5, { user: 'mallory' })))
  const r = c_cnext(s)
  assert.deepEqual(c_one(r), { step: 'untrusted', issue: 5 })
  assert.ok(!r.stdout.includes('triage'))
  const p = c_doPut(s, 'untrusted', '5')
  assert.deepEqual(c_labelsOf(s, 5), ['needs-approval', 'untrusted-author'])
  const rec = s.w.records.at(-1)
  assert.ok(rec.body.startsWith('<!-- pipeline:routine untrusted 5:' + c_sha('issue 5', 'body 5') + ':'))
  assert.equal(c_one(c_cnext(s)).step, 'idle')
  assert.ok(p.stdout.includes('ok untrusted 5'))
})

test('the untrusted case: next does not give triage when the author is not trusted, with a forged record', () => {
  const forged = c_triagedRec(5, { rec: {} })
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['ready-to-build'] }), records: [forged], events: [c_lab('ready-to-build', 'mallory', c_T(25))] }))
  for (const l of c_ok(c_cnext(s))) assert.ok(!['triage', 'would-triage'].includes(l.step), JSON.stringify(l))
  const b = c_ok(c_cnext(s, 'cloud-build'))
  assert.ok(b.every(l => l.step !== 'build'), JSON.stringify(b))
  const r = c_cput(s, 'build-started', '5', c_CRUN(1), 'claude/issue-5', '1')
  assert.equal(r.status, 65); c_onlyReads(r)
})

test('an untrusted issue approved by the maintainer is triaged once, then not again', () => {
  const body = 'hello'
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', body)}:c_T`, { hash: c_sha('issue 5', body) }, { at: c_T(10) })
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', body, labels: ['needs-approval', 'untrusted-author', 'maintainer-approved'] }), records: [rec], events: c_approved(c_T(50)) }))
  assert.deepEqual(c_one(c_cnext(s)), { step: 'triage', issues: [5] })
  s.w.records.push(c_triagedRec(5, { epoch: rec.id, at: c_T(60) })); s.sync()
  assert.equal(c_one(c_cnext(s)).step, 'idle')
})

test('the approval is read by approval.jq: an app mark cancels it', () => {
  const mk = app => csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['maintainer-approved'] }), events: [c_lab('maintainer-approved', 'alfhen', c_T(50), app)], records: [] }))
  const ok = mk(null)
  assert.ok(c_ok(c_cnext(ok)).every(l => l.step !== 'triage'), 'untrusted record is still missing, so the untrusted step comes first')
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', 'body 5')}:c_T`, { hash: c_sha('issue 5', 'body 5') }, { at: c_T(10) })
  for (const [app, want] of [[null, 'triage'], [{ slug: 'claude' }, 'idle']]) {
    const s = mk(app); s.w.records = [rec]; s.sync()
    assert.equal(c_one(c_cnext(s)).step, want, JSON.stringify(app))
  }
})

test('an approval that was added, removed and re-added by a session does not count', () => {
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', 'body 5')}:c_T`, { hash: c_sha('issue 5', 'body 5') }, { at: c_T(10) })
  const events = [c_lab('maintainer-approved', 'alfhen', c_T(50)), { event: 'unlabeled', label: { name: 'maintainer-approved' }, actor: { login: 'alfhen' }, created_at: c_T(55), performed_via_github_app: null }, c_lab('maintainer-approved', 'alfhen', c_T(60), { slug: 'claude' })]
  const noTriage = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['maintainer-approved'] }), events, records: [rec] }))
  assert.equal(c_one(c_cnext(noTriage)).step, 'idle')
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['maintainer-approved', 'ready-to-build'] }), events, records: [rec, c_triagedRec(5, { epoch: rec.id })] }))
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'idle')
})

test('an approval that was removed has no force', () => {
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', 'body 5')}:c_T`, { hash: c_sha('issue 5', 'body 5') }, { at: c_T(10) })
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['needs-approval'] }), events: c_approved(c_T(50)), records: [rec] }))
  assert.equal(c_one(c_cnext(s)).step, 'idle')
})

test('a body changed after approval is revoked with the hash cause, and put revoke writes the new hash', () => {
  const old = c_sha('issue 5', 'old body')
  const rec = c_cr('untrusted', `5:${old}:c_T`, { hash: old }, { at: c_T(10) })
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', body: 'new body', labels: ['maintainer-approved', 'ready-to-build'] }), events: c_approved(c_T(50)), records: [rec, c_triagedRec(5, { epoch: rec.id })] }))
  assert.deepEqual(c_one(c_cnext(s)), { step: 'revoke', issue: 5, cause: 'hash' })
  assert.ok(c_ok(c_cnext(s, 'cloud-build')).every(l => l.step !== 'build'))
  const rb = c_cput(s, 'build-started', '5', c_CRUN(1), 'claude/issue-5', '1')
  assert.equal(rb.status, 65); c_onlyReads(rb)
  const s0 = csetup({ ...c_withIssues({ issue: c_ci(5, { user: 'mallory', body: 'new body', labels: ['maintainer-approved', 'ready-to-build'] }), events: c_approved(c_T(50)), records: [rec, c_triagedRec(5, { epoch: rec.id })] }), settings: { routine: { ...c_ROUTINE, stage: 0 } } })
  assert.ok(c_ok(c_cnext(s0, 'cloud-build')).every(l => l.step !== 'would-build'))
  c_doPut(s, 'revoke', '5', 'hash')
  const last = s.w.records.at(-1).body
  assert.ok(last.startsWith('<!-- pipeline:routine revoked 5:hash:'))
  assert.equal(JSON.parse(last.split('\n')[1]).hash, c_sha('issue 5', 'new body'))
  assert.deepEqual(c_labelsOf(s, 5), ['needs-approval'])
  assert.equal(c_one(c_cnext(s)).step, 'idle')
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'idle')
})

test('a body that goes H1, H2, H1, H2 is revoked each time and compared with the newest record only', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', body: 'H1', labels: ['needs-approval'] }), records: [] }))
  const approve = at => { s.w.events[5] = [...(s.w.events[5] ?? []), c_lab('maintainer-approved', 'alfhen', at)]; const i = c_issueOf(s, 5); i.labels.push({ name: 'maintainer-approved' }); s.sync() }
  c_doPut(s, 'untrusted', '5')
  let t = 900
  for (const body of ['H2', 'H1', 'H2', 'H1']) {
    approve(c_T(t++)); c_issueOf(s, 5).body = body; s.sync()
    assert.deepEqual(c_one(c_cnext(s)), { step: 'revoke', issue: 5, cause: 'hash' }, body)
    c_doPut(s, 'revoke', '5', 'hash')
    assert.equal(c_one(c_cnext(s)).step, 'idle')
  }
})

test('an outsider comment newer than the approval is revoked with the comment cause', () => {
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', 'body 5')}:c_T`, { hash: c_sha('issue 5', 'body 5') }, { at: c_T(10) })
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['maintainer-approved'] }), events: c_approved(c_T(50)), comments: [c_cc('eve', c_T(60))], records: [rec] }))
  assert.deepEqual(c_one(c_cnext(s)), { step: 'revoke', issue: 5, cause: 'comment' })
  c_doPut(s, 'revoke', '5', 'comment')
  assert.deepEqual(c_labelsOf(s, 5), ['needs-approval'])
  assert.equal(c_one(c_cnext(s)).step, 'idle')
})

test('a comment created before the approval and edited after it blocks; created only does not', () => {
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', 'body 5')}:c_T`, { hash: c_sha('issue 5', 'body 5') }, { at: c_T(10) })
  const mk = comment => csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['maintainer-approved'] }), events: c_approved(c_T(50)), comments: [comment], records: [rec] }))
  assert.deepEqual(c_one(c_cnext(mk(c_cc('eve', c_T(40), 'x', c_T(70))))), { step: 'revoke', issue: 5, cause: 'comment' })
  assert.deepEqual(c_one(c_cnext(mk(c_cc('eve', c_T(40))))), { step: 'triage', issues: [5] })
})

test('a trusted new issue with an outsider comment is revoked, waits, and is triaged after a newer approval', () => {
  const s = csetup({ ...c_withIssues(c_bare(5, { comments: [c_cc('eve', c_T(60))] })), ...c_withIssues(c_bare(6)) })
  s.w.issues = [c_ci(5), c_ci(6)]; s.w.comments = { 5: [c_cc('eve', c_T(60))], 6: [] }; s.sync()
  assert.deepEqual(c_ok(c_cnext(s)).map(l => l.step), ['revoke'])
  c_doPut(s, 'revoke', '5', 'comment')
  assert.deepEqual(c_labelsOf(s, 5), ['needs-approval'])
  assert.deepEqual(c_one(c_cnext(s)), { step: 'triage', issues: [6] })
  s.w.events[5] = c_approved(c_T(900)); c_issueOf(s, 5).labels.push({ name: 'maintainer-approved' }); s.sync()
  assert.deepEqual(c_one(c_cnext(s)), { step: 'triage', issues: [5, 6] })
})

test('put revoke on an issue that passes is refused', () => {
  const s = csetup(c_withIssues(c_bare(5)))
  const r = c_cput(s, 'revoke', '5', 'comment')
  assert.equal(r.status, 65); c_onlyReads(r)
})

test('a stranger comment on the tracking issue or on a PR starts nothing', () => {
  const s = csetup({ ...c_withIssues(c_bare(5)), records: [c_cc('eve', c_T(60), 'revoke everything')] })
  s.w.pulls = [c_cpr('claude/issue-9', { user: 'eve' })]; s.sync()
  assert.deepEqual(c_one(c_cnext(s)), { step: 'triage', issues: [5] })
})

test('issue-text prints the title, the body and trusted comments only, and refuses a failing issue', () => {
  const s = csetup(c_withIssues(c_bare(5, { comments: [c_cc('alfhen', c_T(1), 'mine'), c_cc('eve', c_T(2), 'outsider words')] })))
  s.w.comments[5] = [c_cc('alfhen', c_T(1), 'mine'), c_cc('eve', c_T(2), 'outsider words')]
  // The outsider comment is newer than the issue, so the check fails.
  s.sync()
  const bad = run(s, 'o/r', 'issue-text', '5')
  assert.equal(bad.status, 65); assert.equal(bad.stdout, '')
  // After the maintainer approves later, the issue passes and the outsider comment is still hidden.
  c_issueOf(s, 5).labels.push({ name: 'maintainer-approved' }); s.w.events[5] = c_approved(c_T(100)); s.sync()
  const ok = run(s, 'o/r', 'issue-text', '5')
  assert.equal(ok.status, 0, ok.stderr)
  const out = JSON.parse(ok.stdout)
  assert.deepEqual(out.comments, [{ author: 'alfhen', body: 'mine' }])
  assert.ok(!ok.stdout.includes('outsider words'))
  c_onlyReads(ok); c_onlyReads(bad)
})

const c_putT = (s, n, ...a) => c_cput(s, 'triaged', String(n), ...a)

test('put triaged sets the labels by the rule', () => {
  const cases = [
    [['build', 'S', 'low', 'bug', 'fine'], ['bug', 'ready-to-build', 'size:S']],
    [['build', 'M', 'medium', 'feat', 'fine'], ['feat', 'ready-to-build', 'size:M']],
    [['build', 'L', 'low', 'bug', 'big'], ['bug', 'needs-approval', 'size:L']],
    [['build', 'S', 'high', 'docs', 'risky'], ['docs', 'needs-approval', 'size:S']],
    [['plan', 'M', 'low', 'chore', 'plan it'], ['chore', 'needs-approval', 'size:M']],
    [['decline', 'S', 'low', 'test', 'not valid'], ['declined', 'size:S', 'test']],
  ]
  for (const [args, want] of cases) {
    const s = csetup(c_withIssues(c_bare(5, { labels: ['needs-approval'] })))
    const r = c_putT(s, 5, ...args)
    assert.equal(r.status, 0, r.stderr)
    c_apply(s, r)
    const expected = want.includes('needs-approval') ? want : want
    assert.deepEqual(c_labelsOf(s, 5), expected.sort(), args.join(' '))
    const rec = JSON.parse(s.w.records.at(-1).body.split('\n')[1])
    assert.equal(rec.type, args[3])
    if (args[0] === 'decline') assert.ok(r.writes.some(w => w.includes('/issues/5/comments') && w.includes('Declined by the triage routine: not valid')))
    assert.ok(!r.writes.some(w => /state=closed/.test(w)))
  }
})

test('put triaged keeps the plan rule for size L and refuses a second record in one epoch', () => {
  const s = csetup(c_withIssues(c_bare(5)))
  const r = c_putT(s, 5, 'build', 'L', 'low', 'bug', 'big')
  c_apply(s, r)
  assert.equal(JSON.parse(s.w.records.at(-1).body.split('\n')[1]).decision, 'plan')
  const again = c_putT(s, 5, 'build', 'S', 'low', 'bug', 'x')
  assert.equal(again.status, 65); c_onlyReads(again)
})

test('put triaged: a revoke, a new approval and a second triage write a record with a new epoch, then never triage', () => {
  const s = csetup({ ...c_withIssues(c_bare(5, { comments: [c_cc('eve', c_T(60))] })), records: [c_triagedRec(5, { epoch: 0, at: c_T(20) })] })
  c_doPut(s, 'revoke', '5', 'comment')
  const epoch = s.w.records.at(-1).id
  c_issueOf(s, 5).labels.push({ name: 'maintainer-approved' }); s.w.events[5] = c_approved(c_T(900)); s.sync()
  const t = c_putT(s, 5, 'build', 'S', 'low', 'bug', 'ok')
  assert.equal(t.status, 0, t.stderr); c_apply(s, t)
  assert.ok(s.w.records.at(-1).body.startsWith(`<!-- pipeline:routine triaged 5:${epoch} -->`))
  assert.equal(s.w.records.filter(r => r.body.includes('pipeline:routine triaged 5:')).length, 2)
  assert.ok(c_ok(c_cnext(s)).every(l => l.step !== 'triage'))
  const b = c_one(c_cnext(s, 'cloud-build'))
  assert.equal(b.step, 'build')
})

test('put triaged refuses a bad type with exit 64 and no call', () => {
  const r = c_putT(csetup(c_withIssues(c_bare(5))), 5, 'build', 'S', 'low', 'fix', 'x')
  assert.equal(r.status, 64); assert.deepEqual(r.calls, [])
})

test('two triaged records with different keys are no error', () => {
  const s = csetup({ ...c_withIssues(c_bare(5)), records: [c_triagedRec(5, { epoch: 0, at: c_T(20) }), c_triagedRec(5, { epoch: 3, at: c_T(21) })] })
  assert.equal(c_one(c_cnext(s)).step, 'idle')
})

test('an issue with an open PR and a cloud triaged record is idle, with no adopt', () => {
  const s = csetup({ ...c_withIssues({ issue: c_ci(5, { labels: ['ready-to-build'] }), records: [c_triagedRec(5)] }) })
  s.w.pulls = [c_cpr('claude/issue-5')]; s.sync()
  assert.equal(c_one(c_cnext(s)).step, 'idle')
})

test('adopt: a 0.7.0 record with no cloud label is adopted; a PR from routine/ or a label stops it', () => {
  const legacy = c_cr('triaged', '5', { decision: 'build', size: 'S', risk: 'low', why: 'ok' }, { at: c_T(5) })
  const s = csetup(c_withIssues({ issue: c_ci(5), records: [legacy] }))
  assert.deepEqual(c_one(c_cnext(s)), { step: 'adopt', issue: 5, labels: ['ready-to-build', 'size:S'] })
  s.w.pulls = [c_cpr('routine/issue-5')]; s.sync()
  assert.equal(c_one(c_cnext(s)).step, 'idle')
  assert.ok(c_ok(c_cnext(s, 'cloud-build')).every(l => l.step !== 'build'))
  s.w.pulls = []; s.sync()
  c_doPut(s, 'adopt', '5')
  assert.deepEqual(c_labelsOf(s, 5), ['ready-to-build', 'size:S'])
  assert.equal(c_one(c_cnext(s)).step, 'idle')
  const decline = c_cr('triaged', '6', { decision: 'plan', size: 'L', risk: 'high', why: 'x' }, { at: c_T(5) })
  const s2 = csetup(c_withIssues({ issue: c_ci(6), records: [decline] }))
  assert.deepEqual(c_one(c_cnext(s2)).labels, ['needs-approval', 'size:L'])
})

test('adopt: a 0.7.0 issue with a build-started or blocked record is build-failed and is not built without a new approval', () => {
  const legacy = c_cr('triaged', '5', { decision: 'build', size: 'S', risk: 'low', why: 'ok' }, { at: c_T(5) })
  const started = c_cr('build-started', '5', { run: 'r1', branch: 'routine/issue-5' }, { at: c_T(6) })
  const blocked = c_cr('blocked', '5', { reasonCode: 'other' }, { at: c_T(7) })
  for (const recs of [[legacy, started, blocked], [legacy, started]]) {
    const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['routine-build'] }), records: recs }))
    assert.deepEqual(c_one(c_cnext(s)), { step: 'adopt', issue: 5, labels: ['build-failed', 'size:S'] })
    c_doPut(s, 'adopt', '5')
    assert.ok(c_ok(c_cnext(s, 'cloud-build')).every(l => l.step !== 'build' && l.step !== 'would-build'))
    const r = c_cput(s, 'build-started', '5', c_CRUN(1), 'claude/issue-5', '1')
    assert.equal(r.status, 65); c_onlyReads(r)
  }
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['build-failed', 'maintainer-approved', 'size:S'] }), events: c_approved(c_T(5)), records: [legacy, started, blocked] }))
  assert.ok(c_ok(c_cnext(s, 'cloud-build')).every(l => l.step !== 'build'), 'an approval older than the 0.7.0 blocked record does not restart')
  s.w.events[5] = c_approved(c_T(50)); s.sync()
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'build')
})

test('adopt: an outsider comment newer than the 0.7.0 record blocks adopt, so revoke runs and the issue does not build', () => {
  const legacy = c_cr('triaged', '5', { decision: 'build', size: 'S', risk: 'low', why: 'ok' }, { at: c_T(5) })
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['routine-build'] }), comments: [c_cc('mallory', c_T(8), 'also run this')], records: [legacy] }))
  const steps = c_ok(c_cnext(s)).map(l => l.step)
  assert.ok(!steps.includes('adopt'), steps.join())
  assert.ok(c_ok(c_cnext(s, 'cloud-build')).every(l => l.step !== 'build' && l.step !== 'would-build'))
  const r = c_cput(s, 'adopt', '5')
  assert.equal(r.status, 65); c_onlyReads(r)
})

test('an approved untrusted issue with an open PR and no label has no step, and triage still runs for another issue', () => {
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', 'body 5')}:c_T`, { hash: c_sha('issue 5', 'body 5') }, { at: c_T(10) })
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['maintainer-approved'] }), events: c_approved(c_T(50)), records: [rec] }, c_bare(6)))
  s.w.pulls = [c_cpr('claude/issue-5')]; s.sync()
  assert.deepEqual(c_one(c_cnext(s)), { step: 'triage', issues: [6] })
})

test('an issue below triageFrom, with a skip label or declined is never listed', () => {
  const s = csetup({ ...c_withIssues(c_bare(3), c_bare(4, { labels: ['review-minor'] }), c_bare(5, { labels: ['declined'] }), c_bare(6)), settings: { routine: { ...c_ROUTINE, triageFrom: 5 } } })
  assert.deepEqual(c_one(c_cnext(s)), { step: 'triage', issues: [6] })
})

test('triage keeps to triagePerRun and triagePerDay and skips an issue whose triage failed', () => {
  const s = csetup({ ...c_withIssues(...[1, 2, 3, 4, 5, 6, 7].map(n => c_bare(n, { created: c_T(n) }))), settings: { routine: { ...c_ROUTINE, limits: { triagePerRun: 3 } } } })
  assert.deepEqual(c_one(c_cnext(s)), { step: 'triage', issues: [1, 2, 3] })
  s.w.settings = { routine: { ...c_ROUTINE, limits: { triagePerRun: 5, triagePerDay: 2 } } }
  s.w.records = [c_triagedRec(1, { at: c_T(300) }), c_cr('triage-failed', '2:0', { reason: 'x' }, { at: c_T(301) })]
  s.sync()
  assert.ok(c_ok(c_cnext(s)).every(l => l.step !== 'triage'))
  s.w.settings = { routine: c_ROUTINE }; s.w.records = [c_cr('triage-failed', '1:0', { reason: 'x' }, { at: c_OLD })]; s.sync()
  assert.deepEqual(c_one(c_cnext(s)), { step: 'triage', issues: [2, 3, 4, 5, 6] })
})

test('put triage-failed labels needs-maintainer with one notice, once per epoch', () => {
  const s = csetup(c_withIssues(c_bare(5)))
  const r = c_doPut(s, 'triage-failed', '5')
  assert.ok(r.stdout.includes('NOTICE triage-failed o/r 5'))
  assert.deepEqual(c_labelsOf(s, 5), ['needs-maintainer'])
  assert.equal(c_cput(s, 'triage-failed', '5').status, 65)
  assert.equal(c_one(c_cnext(s)).step, 'idle')
})

test('every triage-side step ends: the step, its put and next again', () => {
  const legacy = c_cr('triaged', '3', { decision: 'build', size: 'S', risk: 'low', why: 'ok' }, { at: c_T(5) })
  const s = csetup(c_withIssues(
    c_bare(3, { records: [legacy] }), c_bare(4, { user: 'mallory' }),
    c_bare(5, { comments: [c_cc('eve', c_T(60))] }), c_bare(6), c_bare(7, { created: c_T(1) }),
  ))
  s.w.records = [legacy]; s.sync()
  const seen = []
  for (let guard = 0; guard < 12; guard++) {
    const l = c_one(c_cnext(s))
    seen.push(l.step)
    if (l.step === 'adopt') c_doPut(s, 'adopt', String(l.issue))
    else if (l.step === 'untrusted') c_doPut(s, 'untrusted', String(l.issue))
    else if (l.step === 'revoke') c_doPut(s, 'revoke', String(l.issue), l.cause)
    else if (l.step === 'triage') { for (const n of l.issues) c_doPut(s, 'triaged', String(n), 'build', 'S', 'low', 'bug', 'ok') }
    else break
  }
  assert.deepEqual(seen, ['adopt', 'untrusted', 'revoke', 'triage', 'idle'])
})

test('stage 0 prints every step once, writes nothing and every put prints WOULD', () => {
  const legacy = c_cr('triaged', '3', { decision: 'build', size: 'S', risk: 'low', why: 'ok' }, { at: c_T(5) })
  const s = csetup({ ...c_withIssues(c_bare(3), c_bare(4, { user: 'mallory' }), c_bare(6)), records: [legacy], settings: { routine: { ...c_ROUTINE, stage: 0 } } })
  const r = c_cnext(s)
  assert.deepEqual(c_lines(r), [{ step: 'adopt', issue: 3, labels: ['ready-to-build', 'size:S'] }, { step: 'untrusted', issue: 4 }, { step: 'would-triage', issues: [6] }])
  c_onlyReads(r)
  for (const a of [['adopt', '3'], ['untrusted', '4'], ['triaged', '6', 'build', 'S', 'low', 'bug', 'ok'], ['triage-failed', '6']]) {
    const p = c_cput(s, ...a)
    assert.equal(p.status, 0, p.stderr)
    assert.match(p.stdout, /^WOULD /); assert.ok(!p.stdout.includes('NOTICE'))
    c_onlyReads(p)
  }
})

// ---- build side ----
const c_builtIssue = (n, o = {}) => c_readyIssue(n, o)
const c_buildStep = r => { const l = c_lines(r); return l[0] }

test('build: ready-to-build gives the build step with the run-wave arguments', () => {
  const s = csetup(c_withIssues(c_builtIssue(5)))
  const r = c_cnext(s, 'cloud-build')
  const b = c_one(r)
  c_onlyReads(r)
  assert.equal(b.step, 'build'); assert.equal(b.issue, 5); assert.equal(b.attempt, 1); assert.equal(b.branch, 'claude/issue-5')
  assert.match(b.run, /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/)
  assert.deepEqual(b.args, {
    goals: 'docs/goals.md', checks: ['node test/sim-pipeline.mjs'], repo: 'o/r', tmp: `/tmp/apl-${b.run}`,
    pluginRoot: '/opt/agent-pr-pipeline/v0.8.0', agentPrefix: 'apl-v0-8-0-', feedback: true, feedbackRepo: 'alfhen/agent-pr-pipeline',
    prs: [{ quick: { issue: 5 }, branch: 'claude/issue-5' }],
  })
})

test('build: an approval of an untrusted issue gives build, and a size L record never does', () => {
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', 'body 5')}:c_T`, { hash: c_sha('issue 5', 'body 5') }, { at: c_T(10) })
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['maintainer-approved'] }), events: c_approved(c_T(50)), records: [rec, c_triagedRec(5, { epoch: rec.id, at: c_T(60) })] }))
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'build')
  const big = csetup(c_withIssues(c_builtIssue(5, { tri: { rec: { size: 'L' } } })))
  assert.ok(c_ok(c_cnext(big, 'cloud-build')).every(l => l.step !== 'build'))
  const high = csetup(c_withIssues(c_builtIssue(5, { tri: { rec: { risk: 'high' } } })))
  assert.ok(c_ok(c_cnext(high, 'cloud-build')).every(l => l.step !== 'build'))
  const plan = csetup(c_withIssues(c_builtIssue(5, { tri: { rec: { decision: 'plan' } } })))
  assert.ok(c_ok(c_cnext(plan, 'cloud-build')).every(l => l.step !== 'build'))
})

test('build: a ready-to-build label on a build-failed issue does not restart it without a newer approval', () => {
  const s = csetup(c_withIssues({ ...c_builtIssue(5), records: [c_triagedRec(5), c_startedRec(5, 1), c_blockedRec(5, 1, { at: c_T(40) })] }))
  s.w.issues[0].labels.push({ name: 'build-failed' }); s.sync()
  assert.ok(c_ok(c_cnext(s, 'cloud-build')).every(l => l.step !== 'build'))
  s.w.events[5] = [...s.w.events[5], c_lab('maintainer-approved', 'alfhen', c_T(90))]; c_issueOf(s, 5).labels.push({ name: 'maintainer-approved' }); s.sync()
  const b = c_one(c_cnext(s, 'cloud-build'))
  assert.equal(b.step, 'build'); assert.equal(b.attempt, 2)
})

test('build: an approved issue with an older approval than its blocked record does not build', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['maintainer-approved', 'build-failed'] }), events: c_approved(c_T(30)), records: [c_triagedRec(5), c_startedRec(5, 1), c_blockedRec(5, 1, { at: c_T(40) })] }))
  assert.ok(c_ok(c_cnext(s, 'cloud-build')).every(l => l.step !== 'build'))
})

test('build: an attempt in flight, a building label, or a PR from the branch blocks a second build', () => {
  const inflight = csetup(c_withIssues({ ...c_builtIssue(5), records: [c_triagedRec(5), c_startedRec(5, 1)] }))
  assert.ok(c_ok(c_cnext(inflight, 'cloud-build')).every(l => l.step !== 'build'))
  const r = c_cput(inflight, 'build-started', '5', c_CRUN(2), 'claude/issue-5', '2')
  assert.equal(r.status, 65)
  const label = csetup(c_withIssues({ issue: c_ci(5, { labels: ['maintainer-approved', 'building'] }), events: c_approved(c_T(90)), records: [c_triagedRec(5), c_startedRec(5, 1), c_blockedRec(5, 1)] }))
  assert.equal(c_one(c_cnext(csetup(c_withIssues({ issue: c_ci(5, { labels: ['maintainer-approved'] }), events: c_approved(c_T(90)), records: [c_triagedRec(5), c_startedRec(5, 1), c_blockedRec(5, 1)] })), 'cloud-build')).step, 'build', 'the same issue without the label builds')
  assert.ok(c_ok(c_cnext(label, 'cloud-build')).every(l => l.step !== 'build'))
  const rl = c_cput(label, 'build-started', '5', c_CRUN(2), 'claude/issue-5', '2')
  assert.equal(rl.status, 65); c_onlyReads(rl)
  const label0 = csetup({ ...c_withIssues({ issue: c_ci(5, { labels: ['maintainer-approved', 'building'] }), events: c_approved(c_T(90)), records: [c_triagedRec(5), c_startedRec(5, 1), c_blockedRec(5, 1)] }), settings: { routine: { ...c_ROUTINE, stage: 0 } } })
  assert.ok(c_ok(c_cnext(label0, 'cloud-build')).every(l => l.step !== 'would-build'))
  const pr = csetup(c_withIssues(c_builtIssue(5)))
  pr.w.pulls = [c_cpr('claude/issue-5', { state: 'closed' })]; pr.sync()
  assert.ok(c_ok(c_cnext(pr, 'cloud-build')).every(l => l.step !== 'build'))
})

test('build: limits hold at 3 open claude PRs and at 2 runs in 24 hours, with heldBy', () => {
  const s = csetup(c_withIssues(c_builtIssue(5)))
  s.w.pulls = [1, 2, 3].map(n => c_cpr(`claude/issue-${n + 50}`, { number: 800 + n })); s.sync()
  assert.deepEqual(c_one(c_cnext(s, 'cloud-build')), { step: 'wait', heldBy: 'limits' })
  s.w.pulls = [c_cpr('fix/x'), c_cpr('claude/issue-60', { user: 'mallory' })]; s.sync()
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'build')
  s.w.pulls = []; s.w.records = [c_triagedRec(5), c_startedRec(61, 1, { run: c_CRUN(8), at: c_T(50) }), c_startedRec(62, 1, { run: c_CRUN(9), at: c_T(51) })]; s.sync()
  assert.deepEqual(c_one(c_cnext(s, 'cloud-build')), { step: 'wait', heldBy: 'limits' })
  s.w.records = [c_triagedRec(5), c_startedRec(61, 1, { run: c_CRUN(8), at: c_T(50) }), c_startedRec(62, 1, { run: c_CRUN(8), at: c_T(51) })]; s.sync()
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'build')
  s.w.records = [c_triagedRec(5), c_startedRec(61, 1, { run: c_CRUN(8), at: c_OLD }), c_startedRec(62, 1, { run: c_CRUN(9), at: c_OLD })]; s.sync()
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'build')
})

test('build: buildAttempts 0 never builds', () => {
  const s = csetup({ ...c_withIssues(c_builtIssue(5)), settings: { routine: { ...c_ROUTINE, limits: { buildAttempts: 0 } } } })
  assert.ok(c_ok(c_cnext(s, 'cloud-build')).every(l => l.step !== 'build'))
})

test('build: a --start file with another version or a root that does not end in the version is refused', () => {
  const s = csetup(c_withIssues(c_builtIssue(5)))
  for (const o of [{ version: 'v0.7.0' }, { pluginRoot: '/opt/agent-pr-pipeline/v0.7.0' }]) {
    const r = c_cnext(s, 'cloud-build', o)
    assert.equal(r.status, 65, r.stderr); assert.equal(r.stdout, '')
  }
  assert.equal(run(s, 'o/r', 'next', '--mode', 'cloud-build').status, 64)
})

test('build: a forged build-started record by another account changes nothing', () => {
  const s = csetup(c_withIssues({ ...c_builtIssue(5), records: [c_triagedRec(5), { ...c_startedRec(5, 1), user: { login: 'mallory' } }] }))
  assert.equal(c_one(c_cnext(s, 'cloud-build')).attempt, 1)
})

test('block: a built record, or an old record, ends the attempt; a fresh record does not', () => {
  const mk = recs => csetup(c_withIssues({ issue: c_ci(5, { labels: ['building'] }), records: [c_triagedRec(5), ...recs] }))
  const built = c_cr('built', '5:1', { run: c_CRUN(1), pr: 'none', ready: false, reasonCode: 'needs-human' }, { at: c_T(35) })
  assert.deepEqual(c_one(c_cnext(mk([c_startedRec(5, 1), built]), 'cloud-build')), { step: 'block', issue: 5, run: c_CRUN(1), attempt: 1, reasonCode: 'needs-human' })
  assert.deepEqual(c_one(c_cnext(mk([c_startedRec(5, 1, { at: c_OLD })]), 'cloud-build')).step, 'block')
  assert.equal(c_one(c_cnext(mk([c_startedRec(5, 1)]), 'cloud-build')).step, 'idle')
  const withPr = mk([c_startedRec(5, 1, { at: c_OLD })]); withPr.w.pulls = [c_cpr('claude/issue-5')]; withPr.sync()
  assert.equal(c_one(c_cnext(withPr, 'cloud-build')).step, 'pr-seen')
})

test('every build-side step ends: pr-seen, block, exhausted, needs-plan and build', () => {
  const approvedFailed = (n, a) => ({
    issue: c_ci(n, { labels: ['maintainer-approved', 'build-failed'] }), events: c_approved(c_T(90)),
    records: [c_triagedRec(n), ...[...Array(a).keys()].flatMap(k => [c_startedRec(n, k + 1, { at: c_T(30 + k) }), c_blockedRec(n, k + 1, { at: c_T(40 + k) })])],
  })
  const s = csetup({ settings: { routine: { ...c_ROUTINE, limits: { wavesPerDay: 9 } } }, ...c_withIssues(
    { issue: c_ci(10, { labels: ['building'] }), records: [c_triagedRec(10), c_startedRec(10, 1)] },
    { issue: c_ci(11, { labels: ['building'] }), records: [c_triagedRec(11), c_startedRec(11, 1, { at: c_OLD })] },
    approvedFailed(12, 2),
    { issue: c_ci(13, { labels: ['maintainer-approved'] }), events: c_approved(c_T(90)), records: [c_triagedRec(13, { rec: { size: 'L', decision: 'plan' } })] },
    c_builtIssue(14), c_builtIssue(15),
  ) })
  s.w.pulls = [c_cpr('claude/issue-10')]; s.sync()
  const seen = []
  for (let g = 0; g < 14; g++) {
    const l = c_one(c_cnext(s, 'cloud-build'))
    seen.push(`${l.step}${l.issue ?? ''}`)
    if (l.step === 'pr-seen') c_doPut(s, 'pr-seen', String(l.issue))
    else if (l.step === 'block') c_doPut(s, 'blocked', String(l.issue), l.run, l.reasonCode)
    else if (l.step === 'exhausted') c_doPut(s, 'exhausted', String(l.issue))
    else if (l.step === 'needs-plan') c_doPut(s, 'needs-plan', String(l.issue))
    else if (l.step === 'build') { c_doPut(s, 'build-started', String(l.issue), l.run, l.branch, String(l.attempt)); s.w.pulls.push(c_cpr(l.branch, { number: 700 + l.issue })); s.sync() }
    else break
  }
  assert.deepEqual(seen, ['pr-seen10', 'block11', 'exhausted12', 'needs-plan13', 'build14', 'pr-seen14', 'build15', 'pr-seen15', 'idle'])
})

test('exhausted needs the attempts used; below the limit put exits 65', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['maintainer-approved', 'build-failed'] }), events: c_approved(c_T(90)), records: [c_triagedRec(5), c_startedRec(5, 1), c_blockedRec(5, 1)] }))
  assert.equal(c_cput(s, 'exhausted', '5').status, 65)
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'build')
})

test('exhausted at attempt 2 prints one notice and labels needs-maintainer', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['maintainer-approved', 'build-failed'] }), events: c_approved(c_T(90)), records: [c_triagedRec(5), c_startedRec(5, 1), c_blockedRec(5, 1), c_startedRec(5, 2, { at: c_T(50) }), c_blockedRec(5, 2, { at: c_T(60) })] }))
  assert.deepEqual(c_one(c_cnext(s, 'cloud-build')), { step: 'exhausted', issue: 5 })
  const r = c_doPut(s, 'exhausted', '5')
  assert.equal(r.stdout.trim(), 'NOTICE exhausted o/r 5')
  assert.ok(c_labelsOf(s, 5).includes('needs-maintainer'))
})

test('pr-seen with no PR exits 65', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['building'] }), records: [c_triagedRec(5), c_startedRec(5, 1)] }))
  assert.equal(c_cput(s, 'pr-seen', '5').status, 65)
})

test('needs-plan once per approval: the label removed by the maintainer is not set again, a newer approval gives a second record', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['maintainer-approved', 'needs-approval'] }), events: c_approved(c_T(90)), records: [c_triagedRec(5, { rec: { decision: 'plan', size: 'L' } })] }))
  assert.deepEqual(c_one(c_cnext(s, 'cloud-build')), { step: 'needs-plan', issue: 5 })
  const r = c_doPut(s, 'needs-plan', '5')
  assert.ok(r.stdout.includes('NOTICE needs-plan o/r 5'))
  assert.deepEqual(c_labelsOf(s, 5), ['maintainer-approved', 'needs-plan'])
  c_issueOf(s, 5).labels = c_issueOf(s, 5).labels.filter(l => l.name !== 'needs-plan'); s.sync()
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'idle')
  s.w.events[5] = [c_lab('maintainer-approved', 'alfhen', c_T(95))]; s.sync()
  assert.deepEqual(c_one(c_cnext(s, 'cloud-build')), { step: 'needs-plan', issue: 5 })
  c_doPut(s, 'needs-plan', '5')
  assert.equal(s.w.records.filter(x => x.body.includes('needs-plan 5:')).length, 2)
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'idle')
})

test('put build-started removes ready-to-build, adds building and writes the record; put blocked removes the labels and adds build-failed', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['ready-to-build', 'maintainer-approved'] }), events: [c_lab('ready-to-build', 'alfhen', c_T(25)), ...c_approved(c_T(26))], records: [c_triagedRec(5)] }))
  const r = c_doPut(s, 'build-started', '5', c_CRUN(1), 'claude/issue-5', '1')
  assert.deepEqual(c_labelsOf(s, 5), ['building', 'maintainer-approved'])
  assert.ok(s.w.records.at(-1).body.startsWith('<!-- pipeline:routine build-started 5:1 -->'))
  assert.equal(JSON.parse(r.stdout).run, c_CRUN(1))
  const b = c_doPut(s, 'blocked', '5', c_CRUN(1), 'rounds-exhausted')
  assert.deepEqual(c_labelsOf(s, 5), ['build-failed'])
  assert.ok(b.stdout.includes('NOTICE blocked o/r 5'))
  assert.equal(c_cput(s, 'blocked', '5', c_CRUN(1), 'other').status, 65)
  assert.equal(c_cput(s, 'build-started', '5', c_CRUN(3), 'claude/issue-5', '2').status, 65)
})

test('put blocked with triage-plan also writes a needs-plan record and labels needs-plan', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['building', 'needs-approval'] }), records: [c_triagedRec(5), c_startedRec(5, 1)] }))
  const r = c_doPut(s, 'blocked', '5', c_CRUN(1), 'triage-plan')
  assert.ok(s.w.records.some(x => x.body.startsWith('<!-- pipeline:routine needs-plan 5:5000 -->')))
  assert.deepEqual(c_labelsOf(s, 5), ['needs-plan'])
  assert.equal(r.stdout.split('\n').filter(l => l.startsWith('NOTICE')).length, 1)
})

const c_builtRec = (n, a, o = {}) => c_cr('built', `${n}:${a}`, { run: c_CRUN(a), pr: 'none', ready: false, reasonCode: 'other', ...o.rec }, { at: o.at ?? c_T(35) })
const c_blockSetup = (labels, recs) => csetup(c_withIssues({ issue: c_ci(5, { labels }), records: [c_triagedRec(5), c_startedRec(5, 1), ...recs] }))
const c_commentsOn = (s, n) => (s.w.comments[n] ?? []).map(c => c.body)

test('put blocked with triage-plan has needs-plan, no build-failed, and one comment with the why', () => {
  const s = c_blockSetup(['building'], [c_builtRec(5, 1, { rec: { reasonCode: 'triage-plan', why: 'quick fix: plan. The change spans three modules.' } })])
  c_doPut(s, 'blocked', '5', c_CRUN(1), 'triage-plan')
  assert.deepEqual(c_labelsOf(s, 5), ['needs-plan'])
  const [body, ...more] = c_commentsOn(s, 5)
  assert.equal(more.length, 0)
  assert.match(body, /^The build routine stopped and opened no PR\. Its triage step decided that this issue needs a plan\.\nquick fix: plan\. The change spans three modules\.$/)
  assert.doesNotMatch(body, /<!-- pipeline:/)
})

test('put blocked with rounds-exhausted keeps build-failed and comments', () => {
  const s = c_blockSetup(['building'], [c_builtRec(5, 1, { rec: { reasonCode: 'rounds-exhausted', why: 'rounds exhausted: 4 of 4 (maxRounds)' } })])
  c_doPut(s, 'blocked', '5', c_CRUN(1), 'rounds-exhausted')
  assert.deepEqual(c_labelsOf(s, 5), ['build-failed'])
  const [body] = c_commentsOn(s, 5)
  assert.match(body, /^The build routine stopped and opened no PR\. The review rounds ran out[^\n]*\nrounds exhausted: 4 of 4 \(maxRounds\)$/)
})

test('put blocked with no built record comments with the fixed line only', () => {
  const s = c_blockSetup(['building'], [])
  c_doPut(s, 'blocked', '5', c_CRUN(1), 'other')
  assert.deepEqual(c_commentsOn(s, 5), ['The build routine stopped and opened no PR.'])
})

test('put blocked makes an @name in the why inert', () => {
  const s = c_blockSetup(['building'], [c_builtRec(5, 1, { rec: { why: 'ask @octocat and @alfhen/team' } })])
  c_doPut(s, 'blocked', '5', c_CRUN(1), 'other')
  const [body] = c_commentsOn(s, 5)
  assert.doesNotMatch(body, /@[A-Za-z0-9]/)
  assert.match(body, /octocat/)
})

test('put blocked exits 0 when the comment fails, and the record and labels stay', () => {
  const s = c_blockSetup(['building'], [])
  writeFileSync(join(s.fx, `${fname('repos/o/r/issues/5/comments')}.POST.error`), 'HTTP 403')
  const r = c_cput(s, 'blocked', '5', c_CRUN(1), 'other')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /WARNING could not post the block comment/)
  assert.ok(r.writes.some(w => w.startsWith('POST /repos/o/r/issues/100/comments')))
  assert.ok(r.writes.some(w => w.startsWith('POST /repos/o/r/issues/5/comments')))
})

test('the block comment does not make the next next print revoke', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['building', 'maintainer-approved'] }), events: c_approved(c_T(5)), records: [c_triagedRec(5), c_startedRec(5, 1), c_builtRec(5, 1, { rec: { why: 'a reason' } })] }))
  c_doPut(s, 'blocked', '5', c_CRUN(1), 'other')
  assert.equal(c_commentsOn(s, 5).length, 1)
  assert.ok(c_lines(c_cnext(s, 'cloud-build')).every(l => l.step !== 'revoke'))
  assert.ok(c_lines(c_cnext(s, 'cloud-triage')).every(l => l.step !== 'revoke'))
})

test('stage 0: put blocked posts no comment', () => {
  const s = csetup({ ...c_withIssues({ issue: c_ci(5, { labels: ['building'] }), records: [c_triagedRec(5), c_startedRec(5, 1)] }), settings: { routine: { ...c_ROUTINE, stage: 0 } } })
  const r = c_cput(s, 'blocked', '5', c_CRUN(1), 'triage-plan')
  assert.match(r.stdout, /^WOULD blocked/)
  assert.deepEqual(r.writes, [])
})

test('a triage-plan block that is approved again still ends', () => {
  const s = csetup(c_withIssues({
    issue: c_ci(5, { labels: ['building'] }),
    records: [c_triagedRec(5), c_startedRec(5, 1, { at: c_T(30) }), c_builtRec(5, 1, { rec: { reasonCode: 'triage-plan' } })],
  }))
  c_doPut(s, 'blocked', '5', c_CRUN(1), 'triage-plan')
  assert.deepEqual(c_labelsOf(s, 5), ['needs-plan'])
  s.w.events[5] = [...(s.w.events[5] ?? []), c_lab('maintainer-approved', 'alfhen', c_T(400))]
  c_issueOf(s, 5).labels.push({ name: 'maintainer-approved' }); s.sync()
  const seen = []
  for (let g = 0; g < 8; g++) {
    const l = c_one(c_cnext(s, 'cloud-build'))
    seen.push(l.step)
    if (l.step === 'build') { assert.equal(l.attempt, 2); c_doPut(s, 'build-started', '5', l.run, l.branch, String(l.attempt)); s.w.pulls.push(c_cpr(l.branch)); s.sync() }
    else if (l.step === 'pr-seen') c_doPut(s, 'pr-seen', '5')
    else break
  }
  assert.deepEqual(seen, ['build', 'pr-seen', 'idle'])
  assert.ok(!c_labelsOf(s, 5).includes('needs-maintainer'))
  assert.ok(!c_labelsOf(s, 5).includes('build-failed'))
})

test('exhausted does not fire while the last attempt runs or after it opened a PR', () => {
  for (const labels of [['maintainer-approved', 'build-failed'], ['needs-plan', 'maintainer-approved']]) {
    const lastBlocked = labels.includes('build-failed') ? c_blockedRec(5, 1, { at: c_T(40) }) : c_cr('blocked', '5:1', { run: c_CRUN(1), reasonCode: 'triage-plan', attempt: 1 }, { at: c_T(40) })
    const mk = () => csetup(c_withIssues({
      issue: c_ci(5, { labels: [...labels, 'building'] }), events: c_approved(c_T(90)),
      records: [c_triagedRec(5), c_startedRec(5, 1, { at: c_T(30) }), lastBlocked, c_startedRec(5, 2, { at: c_T(95) })],
    }))
    assert.notEqual(c_one(c_cnext(mk(), 'cloud-build')).step, 'exhausted', labels.join())
    const withPr = mk(); withPr.w.pulls = [c_cpr('claude/issue-5')]; withPr.sync()
    assert.equal(c_one(c_cnext(withPr, 'cloud-build')).step, 'pr-seen', labels.join())
    c_doPut(withPr, 'pr-seen', '5')
    assert.ok(!c_labelsOf(withPr, 5).includes('building'), labels.join())
    assert.equal(c_one(c_cnext(withPr, 'cloud-build')).step, 'idle', labels.join())
  }
})

test('a triage-plan block on the last attempt, approved again, ends: exhausted, needs-maintainer, idle', () => {
  const planBlock = a => c_cr('blocked', `5:${a}`, { run: c_CRUN(a), reasonCode: 'triage-plan', attempt: a }, { at: c_T(40 + a) })
  const s = csetup(c_withIssues({
    issue: c_ci(5, { labels: ['maintainer-approved'] }), events: c_approved(c_T(90)),
    records: [c_triagedRec(5), c_startedRec(5, 1, { at: c_T(30) }), planBlock(1), c_startedRec(5, 2, { at: c_T(35) }), planBlock(2)],
  }))
  assert.deepEqual(c_one(c_cnext(s, 'cloud-build')), { step: 'exhausted', issue: 5 })
  c_doPut(s, 'exhausted', '5')
  assert.ok(c_labelsOf(s, 5).includes('needs-maintainer'))
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'idle')
})

test('put built makes an @name in the why inert in the record', () => {
  const s = c_builtSetup()
  c_doPut(s, 'built', '5', c_CRUN(1), 'none', 'false', 'other', c_resultFile(s, { prs: [{ ready: false, reason: 'ask @octocat' }] }))
  const posts = s.w.records.at(-1).body
  assert.doesNotMatch(posts, /@[A-Za-z0-9]/)
  assert.match(posts, /octocat/)
})

const c_resultFile = (s, res) => { const f = join(s.dir, 'result.json'); writeFileSync(f, JSON.stringify(res)); return f }
const c_builtRecOf = s => JSON.parse(s.w.records.at(-1).body.split('\n')[1])
const c_builtSetup = () => csetup(c_withIssues({ issue: c_ci(5, { labels: ['building'] }), records: [c_triagedRec(5), c_startedRec(5, 1)] }))

test('put built with pr none stores the reason of the result file as why, on one line', () => {
  const s = c_builtSetup()
  const f = c_resultFile(s, { prs: [{ ready: false, reason: 'quick fix: plan.\n\tIt   needs\r\na plan.' }] })
  c_doPut(s, 'built', '5', c_CRUN(1), 'none', 'false', 'triage-plan', f)
  assert.deepEqual(c_builtRecOf(s), { run: c_CRUN(1), pr: 'none', ready: false, reasonCode: 'triage-plan', why: 'quick fix: plan. It needs a plan.' })
})

test('put built cuts a long why at a sentence end under 500 characters, as triaged does', () => {
  const s = c_builtSetup()
  const f = c_resultFile(s, { prs: [{ ready: false, reason: `${'a'.repeat(100)}. ${'b'.repeat(600)}` }] })
  c_doPut(s, 'built', '5', c_CRUN(1), 'none', 'false', 'other', f)
  const rec = c_builtRecOf(s)
  assert.equal(rec.why, `${'a'.repeat(100)}.`)
  assert.equal(rec.whyCut, true)
  const s2 = c_builtSetup()
  c_doPut(s2, 'built', '5', c_CRUN(1), 'none', 'false', 'other', c_resultFile(s2, { prs: [{ ready: false, reason: 'x'.repeat(700) }] }))
  assert.equal(c_builtRecOf(s2).why.length, 500)
})

test('put built stores no why for a PR number, with no file, or with no reason; a missing file is exit 64', () => {
  const s = c_builtSetup()
  c_doPut(s, 'built', '5', c_CRUN(1), '42', 'false', 'other', c_resultFile(s, { prs: [{ ready: false, prNumber: 42, reason: 'x' }] }))
  assert.equal('why' in c_builtRecOf(s), false)
  const s2 = c_builtSetup()
  c_doPut(s2, 'built', '5', c_CRUN(1), 'none', 'false', 'other')
  assert.equal('why' in c_builtRecOf(s2), false)
  const s3 = c_builtSetup()
  c_doPut(s3, 'built', '5', c_CRUN(1), 'none', 'false', 'other', c_resultFile(s3, { prs: [{ ready: false }] }))
  assert.equal('why' in c_builtRecOf(s3), false)
  assert.equal(c_cput(c_builtSetup(), 'built', '5', c_CRUN(1), 'none', 'false', 'other', join(s.dir, 'missing.json')).status, 64)
})

test('put built stores a log record with fixed fields and refuses a second one', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['building'] }), records: [c_triagedRec(5), c_startedRec(5, 1)] }))
  c_doPut(s, 'built', '5', c_CRUN(1), '42', 'true', 'opened')
  const rec = JSON.parse(s.w.records.at(-1).body.split('\n')[1])
  assert.deepEqual(rec, { run: c_CRUN(1), pr: 42, ready: true, reasonCode: 'opened' })
  assert.equal(c_cput(s, 'built', '5', c_CRUN(1), '42', 'true', 'opened').status, 65)
  assert.equal(c_cput(s, 'built', '5', c_CRUN(1), '42', 'maybe', 'opened').status, 64)
  assert.equal(c_cput(s, 'built', '5', c_CRUN(1), '42', 'true', 'because').status, 64)
})

test('the race: a second record of one attempt from another run gets exit 66', () => {
  const s = csetup(c_withIssues(c_builtIssue(5)))
  const older = c_startedRec(5, 1, { run: c_CRUN(7), at: c_T(31) })
  const mine = { ...c_startedRec(5, 1, { run: c_CRUN(1) }), id: older.id + 1 }
  // After our POST the tracking comments hold the other run's record first.
  writeFileSync(join(s.fx, `${fname('repos/o/r/issues/100/comments')}.race.json`), JSON.stringify([...s.w.records, older, mine]))
  writeFileSync(join(s.fx, `${fname('repos/o/r/issues/100/comments')}.POST.then`), `${fname('repos/o/r/issues/100/comments')}.race.json ${fname('repos/o/r/issues/100/comments')}.json\n`)
  const r = c_cput(s, 'build-started', '5', c_CRUN(1), 'claude/issue-5', '1')
  assert.equal(r.status, 66, r.stderr)
  assert.ok(!r.writes.some(w => w.includes('/labels')))
})

test('a lost-race build-started record is ignored: block names the winner', () => {
  const winner = c_startedRec(5, 1, { run: c_CRUN(7), at: c_OLD })
  const loser = { ...c_startedRec(5, 1, { run: c_CRUN(1), at: c_OLD }), id: winner.id + 1 }
  const s = csetup({ ...c_withIssues({ issue: c_ci(5, { labels: ['building'] }), records: [c_triagedRec(5), winner, loser] }), settings: { routine: { ...c_ROUTINE, stage: 1 } } })
  const blocks = c_lines(c_cnext(s, 'cloud-build')).filter(l => l.step === 'block')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].run, c_CRUN(7))
})

test('the winner of the race goes on', () => {
  const s = csetup(c_withIssues(c_builtIssue(5)))
  const mine = c_startedRec(5, 1, { run: c_CRUN(1), at: c_T(31) })
  const later = { ...c_startedRec(5, 1, { run: c_CRUN(7) }), id: mine.id + 1 }
  writeFileSync(join(s.fx, `${fname('repos/o/r/issues/100/comments')}.race.json`), JSON.stringify([...s.w.records, mine, later]))
  writeFileSync(join(s.fx, `${fname('repos/o/r/issues/100/comments')}.POST.then`), `${fname('repos/o/r/issues/100/comments')}.race.json ${fname('repos/o/r/issues/100/comments')}.json\n`)
  const r = c_cput(s, 'build-started', '5', c_CRUN(1), 'claude/issue-5', '1')
  assert.equal(r.status, 0, r.stderr)
})

test('stage 0 for the build side prints would-build and WOULD, and writes nothing', () => {
  const s = csetup({ ...c_withIssues(c_builtIssue(5), { issue: c_ci(6, { labels: ['building'] }), records: [c_triagedRec(6), c_startedRec(6, 1, { at: c_OLD })] }), settings: { routine: { ...c_ROUTINE, stage: 0 } } })
  const r = c_cnext(s, 'cloud-build')
  c_onlyReads(r)
  assert.deepEqual(c_lines(r).map(l => l.step), ['block', 'would-build'])
  assert.equal(c_lines(r)[1].issue, 5)
  for (const a of [['build-started', '5', c_CRUN(1), 'claude/issue-5', '1'], ['built', '6', c_CRUN(1), 'none', 'false', 'other']]) {
    const p = c_cput(s, ...a)
    assert.equal(p.status, 0, p.stderr); assert.match(p.stdout, /^WOULD /); c_onlyReads(p)
  }
  const blocked = c_cput(s, 'blocked', '6', c_CRUN(1), 'other')
  assert.equal(blocked.status, 0, blocked.stderr)
  assert.match(blocked.stdout, /^WOULD blocked/); c_onlyReads(blocked)
})

test('stage 0 also holds for revoke, pr-seen, exhausted, needs-plan, env and outbox puts', () => {
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', 'old')}:c_T`, { hash: c_sha('issue 5', 'old') }, { at: c_T(10) })
  const s = csetup({
    ...c_withIssues(
      { issue: c_ci(5, { user: 'mallory', body: 'new', labels: ['maintainer-approved'] }), events: c_approved(c_T(50)), records: [rec] },
      { issue: c_ci(6, { labels: ['building'] }), records: [c_triagedRec(6), c_startedRec(6, 1)] },
      { issue: c_ci(7, { labels: ['maintainer-approved', 'build-failed'] }), events: c_approved(c_T(90)), records: [c_triagedRec(7), c_startedRec(7, 1), c_blockedRec(7, 1), c_startedRec(7, 2, { at: c_T(50) }), c_blockedRec(7, 2, { at: c_T(60) })] },
      { issue: c_ci(8, { labels: ['maintainer-approved'] }), events: c_approved(c_T(90)), records: [c_triagedRec(8, { rec: { size: 'L', decision: 'plan' } })] },
    ),
    settings: { routine: { ...c_ROUTINE, stage: 0 } },
  })
  s.w.pulls = [c_cpr('claude/issue-6')]; s.sync()
  const file = join(s.dir, 'outbox.json'); writeFileSync(file, JSON.stringify({ source: 'o/r', feedbackRepo: 'o/r', items: [], denylist: [], dropped: 0 }))
  for (const a of [['revoke', '5', 'hash'], ['pr-seen', '6'], ['exhausted', '7'], ['needs-plan', '8'], ['env-stale', 'v0.8.0'], ['env-ok', 'v0.8.0'], ['feedback-outbox', c_CRUN(1), file]]) {
    const p = c_cput(s, ...a)
    assert.equal(p.status, 0, `${a.join(' ')}: ${p.stderr}`)
    assert.match(p.stdout, /^WOULD /); assert.ok(!p.stdout.includes('NOTICE')); c_onlyReads(p)
  }
})

test('put env-stale writes once with one notice, then known; env-ok writes only after a stale', () => {
  const s = csetup({})
  const a = c_doPut(s, 'env-stale', 'v0.8.0')
  assert.equal(a.stdout.trim(), 'NOTICE env-stale o/r v0.8.0')
  assert.equal(s.w.records.length, 1)
  const b = c_cput(s, 'env-stale', 'v0.8.0')
  assert.equal(b.stdout.trim(), 'known'); c_onlyReads(b)
  const c = c_doPut(s, 'env-ok', 'v0.8.0')
  assert.equal(c.stdout.trim(), '')
  assert.equal(s.w.records.length, 2)
  const d = c_cput(s, 'env-ok', 'v0.8.0')
  assert.deepEqual(d.writes, [])
  const e = c_doPut(s, 'env-stale', 'v0.8.0')
  assert.ok(e.stdout.includes('NOTICE'))
})

test('put env-stale on a paused repo prints paused and writes nothing; it reads only the stage', () => {
  const s = csetup({ trackingLabels: ['routine-paused'] })
  const p = c_cput(s, 'env-stale', 'v0.8.0')
  assert.equal(p.stdout.trim(), 'paused'); c_onlyReads(p)
  const t = csetup({ settings: { routine: { ...c_ROUTINE, someFutureKey: 1, stage: 1 } } })
  const q = c_cput(t, 'env-stale', 'v0.8.0')
  assert.equal(q.status, 0, q.stderr)
  assert.ok(q.stdout.includes('NOTICE'))
})

test('a forged env record by another account does not stop the notice', () => {
  const s = csetup({ records: [{ ...c_cr('env-stale', 'v0.8.0:T', { pin: 'v0.8.0' }), user: { login: 'mallory' } }] })
  assert.ok(c_cput(s, 'env-stale', 'v0.8.0').stdout.includes('NOTICE'))
})

test('outbox: put, list, get, filed; a forged or unknown run is refused', () => {
  const s = csetup({})
  const file = join(s.dir, 'outbox.json')
  const box = { source: 'o/r', feedbackRepo: 'o/r', items: [{ title: 'x' }], denylist: ['w'], dropped: 0 }
  writeFileSync(file, JSON.stringify(box))
  c_doPut(s, 'feedback-outbox', c_CRUN(1), file)
  assert.equal(c_cput(s, 'feedback-outbox', c_CRUN(1), file).status, 65)
  const list = run(s, 'o/r', 'list', 'outboxes')
  assert.equal(list.status, 0, list.stderr)
  const l = c_lines(list); assert.equal(l.length, 1); assert.equal(l[0].run, c_CRUN(1)); assert.ok(l[0].ageSeconds >= 0)
  assert.deepEqual(JSON.parse(run(s, 'o/r', 'get', 'outbox', c_CRUN(1)).stdout), box)
  assert.equal(run(s, 'o/r', 'get', 'outbox', c_CRUN(2)).status, 65)
  c_doPut(s, 'feedback-filed', c_CRUN(1), '{"filed":1,"seenAgain":0,"refused":0}')
  assert.equal(run(s, 'o/r', 'list', 'outboxes').stdout, '')
  assert.equal(run(s, 'o/r', 'get', 'outbox', c_CRUN(1)).status, 65)
  const forged = csetup({ records: [{ ...c_cr('feedback-outbox', c_CRUN(3), box), user: { login: 'mallory' } }] })
  assert.equal(run(forged, 'o/r', 'get', 'outbox', c_CRUN(3)).status, 65)
  assert.equal(run(forged, 'o/r', 'list', 'outboxes').stdout, '')
})

test('outbox put refuses fields outside the fixed set and a bad run with exit 64', () => {
  const s = csetup({})
  const file = join(s.dir, 'outbox.json')
  writeFileSync(file, JSON.stringify({ source: 'o/r', feedbackRepo: 'o/r', items: [], denylist: [], dropped: 0, extra: 1 }))
  const a = c_cput(s, 'feedback-outbox', c_CRUN(1), file)
  assert.equal(a.status, 64); assert.deepEqual(a.calls, [])
  assert.equal(c_cput(s, 'feedback-dropped', 'run-1').status, 64)
  assert.equal(c_cput(s, 'feedback-dropped', c_CRUN(1)).status, 65)
  assert.equal(c_cput(s, 'feedback-filed', c_CRUN(1), '{"filed":-1}').status, 64)
})

test('feedback-dropped closes an outbox', () => {
  const s = csetup({ records: [c_cr('feedback-outbox', c_CRUN(1), { source: 'o/r', feedbackRepo: 'o/r', items: [], denylist: [], dropped: 0 })] })
  assert.equal(c_lines(run(s, 'o/r', 'list', 'outboxes')).length, 1)
  c_doPut(s, 'feedback-dropped', c_CRUN(1))
  assert.equal(run(s, 'o/r', 'list', 'outboxes').stdout, '')
})

test('next --mode full still prints the 0.7.0 line with the claude/ prefix', () => {
  const s = fullSetup({ issues: [buildIssue(4)], records: [record(4)] }, 'full', {})
  const out = step(nextFull(s))
  assert.deepEqual(out.issues, [{ issue: 4, branch: 'claude/issue-4' }])
})

test('the cloud commands refuse a bad argument with exit 64 and no call', () => {
  const s = csetup({})
  for (const a of [['issue-text', 'x'], ['list', 'x'], ['get', 'outbox', 'x'], ['put', 'revoke', '5', 'because'], ['put', 'env-stale', '0.8'], ['put', 'build-started', '5', c_CRUN(1), 'routine/issue-5', '1'], ['put', 'nothing', '1'], ['next', '--mode', 'cloud-build']]) {
    const r = run(s, 'o/r', ...a)
    assert.equal(r.status, 64, a.join(' ')); assert.deepEqual(r.calls, [])
  }
})

test('build: an outsider comment older than the ready-to-build label does not block the build', () => {
  const part = c_readyIssue(5)
  part.comments = [c_cc('eve', c_T(20))]
  const s = csetup(c_withIssues(part))
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'build')
  s.w.comments[5] = [c_cc('eve', c_T(30))]; s.sync()
  assert.deepEqual(c_one(c_cnext(s, 'cloud-build')), { step: 'revoke', issue: 5, cause: 'comment' })
  const r = c_cput(s, 'build-started', '5', c_CRUN(1), 'claude/issue-5', '1')
  assert.equal(r.status, 65); c_onlyReads(r)
  const part0 = c_readyIssue(5); part0.comments = [c_cc('eve', c_T(30))]
  const s0 = csetup({ ...c_withIssues(part0), settings: { routine: { ...c_ROUTINE, stage: 0 } } })
  assert.ok(c_ok(c_cnext(s0, 'cloud-build')).every(l => l.step !== 'would-build'))
})

test('an untrusted issue with an early approval and no untrusted record passes nothing', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['maintainer-approved'] }), events: c_approved(c_T(50)) }))
  assert.deepEqual(c_one(c_cnext(s)), { step: 'untrusted', issue: 5 })
  const t = run(s, 'o/r', 'issue-text', '5')
  assert.equal(t.status, 65); assert.equal(t.stdout, '')
  const p = c_putT(s, 5, 'build', 'S', 'low', 'bug', 'ok')
  assert.equal(p.status, 65); c_onlyReads(p)
  assert.equal(c_cput(s, 'triage-failed', '5').status, 65)
  const s0 = csetup({ ...c_withIssues({ issue: c_ci(5, { user: 'mallory', labels: ['maintainer-approved'] }), events: c_approved(c_T(50)) }), settings: { routine: { ...c_ROUTINE, stage: 0 } } })
  assert.ok(c_ok(c_cnext(s0)).every(l => l.step !== 'would-triage'))
})

test('a 0.7.0 build-started record does not break cloud-build or count as an attempt', () => {
  const legacy = (at) => c_cr('build-started', '5', { run: '20260101T000000Z-1', branch: 'routine/issue-5' }, { at })
  for (const [at, labels, want] of [[c_OLD, ['building'], [{ step: 'pr-seen', issue: 5 }]], [c_T(30), ['building'], []]]) {
    const s = csetup({ ...c_withIssues({ issue: c_ci(5, { labels }), records: [legacy(at)] }, c_builtIssue(6)), settings: { routine: { ...c_ROUTINE, stage: 0 } } })
    const lines = c_ok(c_cnext(s, 'cloud-build'))
    assert.deepEqual(lines.filter(l => l.issue === 5), want)
    assert.ok(lines.some(l => l.step === 'would-build' && l.issue === 6), JSON.stringify(lines))
  }
  const s = csetup(c_withIssues({ ...c_builtIssue(5), records: [c_triagedRec(5), legacy(c_OLD)] }))
  assert.equal(c_one(c_cnext(s, 'cloud-build')).attempt, 1)
})

test('a stale building label with no open attempt is removed by pr-seen, with build-failed after a blocked attempt', () => {
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['building', 'maintainer-approved'] }), events: c_approved(c_T(90)), records: [c_triagedRec(5), c_startedRec(5, 1), c_blockedRec(5, 1)] }))
  assert.deepEqual(c_ok(c_cnext(s, 'cloud-build')), [{ step: 'pr-seen', issue: 5 }])
  c_doPut(s, 'pr-seen', '5')
  assert.deepEqual(c_labelsOf(s, 5), ['build-failed', 'maintainer-approved'])
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'build')
  const bare = csetup(c_withIssues({ issue: c_ci(7, { labels: ['building'] }) }))
  assert.deepEqual(c_ok(c_cnext(bare, 'cloud-build')), [{ step: 'pr-seen', issue: 7 }])
  c_doPut(bare, 'pr-seen', '7')
  assert.deepEqual(c_labelsOf(bare, 7), [])
  const live = csetup(c_withIssues({ issue: c_ci(5, { labels: ['building'] }), records: [c_triagedRec(5), c_startedRec(5, 1)] }))
  assert.equal(c_one(c_cnext(live, 'cloud-build')).step, 'idle')
})

test('put triaged adds the labels before it writes the record, and an issue with labels but no record is triaged again', () => {
  const s = csetup(c_withIssues(c_bare(5)))
  const r = c_putT(s, 5, 'build', 'S', 'low', 'bug', 'ok')
  assert.equal(r.status, 0, r.stderr)
  const at = re => r.calls.findIndex(c => re.test(c))
  assert.ok(at(/issues\/5\/labels/) >= 0 && at(/issues\/5\/labels/) < at(/^POST .*issues\/100\/comments/), r.calls.join('\n'))
  const half = csetup(c_withIssues(c_bare(5, { labels: ['ready-to-build'] })))
  assert.deepEqual(c_one(c_cnext(half)), { step: 'triage', issues: [5] })
})

test('build: a ready-to-build label alone does not build when the maintainer removed maintainer-approved', () => {
  const rec = c_cr('untrusted', `5:${c_sha('issue 5', 'body 5')}:c_T`, { hash: c_sha('issue 5', 'body 5') }, { at: c_T(10) })
  const mk = labels => csetup(c_withIssues({ issue: c_ci(5, { user: 'mallory', labels }), events: [...c_approved(c_T(50)), c_lab('ready-to-build', 'alfhen', c_T(70), 'claude')], records: [rec, c_triagedRec(5, { epoch: rec.id, at: c_T(60) })] }))
  const removed = mk(['ready-to-build'])
  assert.equal(c_one(c_cnext(removed, 'cloud-build')).step, 'idle')
  const r = c_cput(removed, 'build-started', '5', c_CRUN(1), 'claude/issue-5', '1')
  assert.equal(r.status, 65); c_onlyReads(r)
  assert.equal(c_one(c_cnext(mk(['ready-to-build', 'maintainer-approved']), 'cloud-build')).step, 'build')
})

// A jq that refuses any argument over 100000 bytes, like Linux (128 KB per argument) with some margin.
function c_capJq(s) {
  const real = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim()
  const f = join(s.bin, 'jq')
  writeFileSync(f, `#!/bin/bash\nfor a in "$@"; do if [ "\${#a}" -gt 100000 ]; then echo "jq: Argument list too long" >&2; exit 126; fi; done\nexec ${real} "$@"\n`)
  chmodSync(f, 0o755)
}

test('cloud next works when the collected JSON is far above one argument cap', () => {
  const pad = n => 'x'.repeat(n)
  const issues = Array.from({ length: 60 }, (_, k) => c_ci(200 + k, { body: pad(4000), created: c_T(k) }))
  const records = Array.from({ length: 4 }, (_, k) => c_cr('feedback-outbox', `${900 + k}:${c_CRUN(k)}`, { pad: pad(60000) }, { at: c_T(10 + k) }))
  const pulls = Array.from({ length: 10 }, (_, k) => ({ ...c_cpr(`claude/issue-${300 + k}`, { number: 400 + k }), body: pad(20000) }))
  const comments = Object.fromEntries(issues.map(i => [i.number, [c_cc('alfhen', c_T(1), pad(3000))]]))
  const s = csetup({ issues, records, pulls, comments })
  c_capJq(s)
  const t = c_cnext(s)
  assert.equal(t.status, 0, t.stderr); c_ok(t)
  const sb = csetup({ issues: issues.map(i => ({ ...i, labels: [{ name: 'ready-to-build' }] })), records, pulls, comments })
  c_capJq(sb)
  const b = c_cnext(sb, 'cloud-build')
  assert.equal(b.status, 0, b.stderr)
})

const FOOTER = '\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_'
const withFooter = r => ({ ...r, body: r.body + FOOTER })

test('records that carry the cloud session footer are read: put built, get outbox and a triaged decision', () => {
  const box = { source: 'o/r', feedbackRepo: 'o/r', items: [{ title: 'x' }], denylist: ['w'], dropped: 0 }
  const plain = c_withIssues(c_readyIssue(5))
  const s = csetup({ ...plain, records: [...plain.records, c_cr('feedback-outbox', c_CRUN(1), box)].map(withFooter) })
  assert.deepEqual(JSON.parse(run(s, 'o/r', 'get', 'outbox', c_CRUN(1)).stdout), box)
  assert.equal(c_one(c_cnext(s, 'cloud-build')).step, 'build')
  const b = csetup(c_withIssues({ issue: c_ci(5, { labels: ['building'] }), records: [c_triagedRec(5), c_startedRec(5, 1)].map(withFooter) }))
  const put = c_cput(b, 'built', '5', c_CRUN(1), '42', 'true', 'opened')
  assert.equal(put.status, 0, put.stderr)
})

test('a footer record whose second line is not JSON still counts as no data', () => {
  const bad = c_cr('build-started', '5:1', null, { raw: 'not json' })
  const s = csetup(c_withIssues({ issue: c_ci(5, { labels: ['building'] }), records: [c_triagedRec(5), withFooter(bad)] }))
  assert.equal(c_cput(s, 'built', '5', c_CRUN(1), '42', 'true', 'opened').status, 65)
})
