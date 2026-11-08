// Runs wait-bots.sh (with bot-status.sh) and the fake-gh extensions against fixtures built in each test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const P = 'repos__o__r'
const HEAD = 'a'.repeat(40)
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))

// reviews: the bot's review fixtures, one per call (call 1, call 2, ...) or a single one.
const setup = (reviews) => {
  const dir = mkdtempSync(join(tmpdir(), 'wait-bots-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  put(fx, `${P}__pulls__7.json`, { head: { sha: HEAD } })
  put(fx, `${P}__commits__${HEAD}__check-runs.json`, { check_runs: [] })
  put(fx, `${P}__pulls__7__comments.json`, [])
  put(fx, `${P}__issues__7__comments.json`, [])
  reviews.forEach((r, i) => put(fx, `${P}__pulls__7__reviews.call${i + 1}.json`, r))
  return { dir, fx, log: join(dir, 'log') }
}
const approved = [{ user: { login: 'gitar-bot[bot]' }, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-01-01T00:00:00Z' }]
const run = (s, args, extra = {}) => spawnSync('bash', [join(root, 'scripts/wait-bots.sh'), ...args], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, WAIT_BOTS_INTERVAL: '0', ...extra },
})
const reads = (s) => readFileSync(s.log, 'utf8').split('\n').filter((l) => l === `GET /repos/o/r/pulls/7/reviews?per_page=100`).length

test('stops at the poll where seenHead is no longer empty', () => {
  const s = setup([[], approved])
  const r = run(s, ['o/r', '7', '5'])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.timedOut, false)
  assert.deepEqual(out.seenHead, ['gitar-bot[bot]'])
  assert.equal(reads(s), 2)
})

test('stops at the limit with timedOut when no bot saw the head', () => {
  const s = setup([[]])
  const r = run(s, ['o/r', '7', '3'])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.timedOut, true)
  assert.deepEqual(out.seenHead, [])
  assert.equal(reads(s), 3)
})

test('a limit above 9 minutes waits 9 polls', () => {
  const s = setup([[]])
  const r = run(s, ['o/r', '7', '30'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).timedOut, true)
  assert.equal(reads(s), 9)
})

test('a failed status read exits 1', () => {
  const s = setup([[]])
  put(s.fx, `${P}__pulls__7__reviews.GET.error`, 'fake-gh: server error (HTTP 500)')
  const r = run(s, ['o/r', '7', '3'])
  assert.equal(r.status, 1)
  assert.equal(reads(s), 1)
})

test('refuses a missing or non-numeric argument', () => {
  const s = setup([[]])
  assert.equal(run(s, ['o/r', '7']).status, 2)
  assert.equal(run(s, ['o/r', '7', 'soon']).status, 2)
})

test('fake-gh: call sequences repeat the last file and count in a .count file', () => {
  const s = setup([])
  for (const [n, v] of [[1, { v: 'one' }], [2, { v: 'two' }]]) put(s.fx, `x.call${n}.json`, v)
  put(s.fx, 'x.json', { v: 'plain' })
  const gh = (p) => spawnSync(join(s.dir, 'bin/gh'), ['api', p, '--jq', '.v'], { encoding: 'utf8', env: { ...process.env, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log } }).stdout.trim()
  assert.deepEqual([gh('x'), gh('x'), gh('x')], ['one', 'two', 'two'])
  assert.equal(readFileSync(join(s.fx, 'x.count'), 'utf8').trim(), '3')
  assert.equal(gh('repos/o/r'), '')
  assert.ok(existsSync(join(s.fx, 'x.json')))
})

test('fake-gh: a query is logged and its fixture wins over the plain one', () => {
  const s = setup([])
  put(s.fx, 'y.json', { v: 'plain' })
  put(s.fx, 'y@ref=main.json', { v: 'main' })
  const gh = (p) => spawnSync(join(s.dir, 'bin/gh'), ['api', p, '--jq', '.v'], { encoding: 'utf8', env: { ...process.env, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log } }).stdout.trim()
  assert.deepEqual([gh('y?ref=main'), gh('y?ref=other'), gh('y')], ['main', 'plain', 'plain'])
  const log = readFileSync(s.log, 'utf8')
  assert.match(log, /^GET \/y\?ref=main$/m)
  assert.match(log, /^GET \/y$/m)
})

const OLD = 'b'.repeat(40)
const status = (reviews, issueComments = []) => {
  const s = setup([reviews])
  put(s.fx, `${P}__issues__7__comments.json`, issueComments)
  const r = spawnSync('bash', [join(root, 'scripts/bot-status.sh'), 'o/r', '7'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log },
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout).reviewBodies
}
const rev = (body, commit = HEAD, login = 'coderabbitai[bot]') => ({ user: { login }, state: 'COMMENTED', commit_id: commit, submitted_at: '2026-01-01T00:00:00Z', body })

test('reviewBodies counts a CodeRabbit body with an Outside diff range section', () => {
  assert.equal(status([rev('Actionable comments posted: 0\n\n<details><summary>Outside diff range comments (1)</summary>x</details>')]), 1)
})

test('reviewBodies counts a CodeRabbit body with a Nitpick section', () => {
  assert.equal(status([rev('Actionable comments posted: 0\n<summary>Nitpick comments (2)</summary>')]), 1)
})

test('reviewBodies skips "Actionable comments posted: 0" and Gitar approval text', () => {
  assert.equal(status([rev('**Actionable comments posted: 0**'), rev('Gitar has auto-approved this PR', HEAD, 'gitar-bot[bot]')]), 0)
})

test('reviewBodies skips empty bodies and bodies of only HTML comments', () => {
  assert.equal(status([rev(''), rev(null), rev('  <!-- review_stack_entry -->\n ')]), 0)
})

test('reviewBodies skips a body on an older commit and a body from a person', () => {
  assert.equal(status([rev('finding', OLD), rev('finding', HEAD, 'alice')]), 0)
})

test('reviewBodies counts an unknown text', () => {
  assert.equal(status([rev('Something new we have never seen')]), 1)
})

const marker = (head = HEAD) => `<!-- pipeline-bot-answer head=${head} -->\nAnswered.`
const answer = (association, body = marker()) => ({ author_association: association, body })

test('reviewBodies is 0 when a maintainer answer comment for the head is on the PR', () => {
  assert.equal(status([rev('Something new')], [answer('OWNER')]), 0)
  assert.equal(status([rev('Something new')], [answer('COLLABORATOR')]), 0)
})

test('reviewBodies ignores an answer comment from an outsider, for another head, or without the marker at the start', () => {
  assert.equal(status([rev('Something new')], [answer('NONE'), answer('CONTRIBUTOR')]), 1)
  assert.equal(status([rev('Something new')], [answer('OWNER', marker(OLD))]), 1)
  assert.equal(status([rev('Something new')], [answer('OWNER', `quoted ${marker()}`)]), 1)
})

test('wait-bots keeps polling while a bot check run is still running, and the body then counts', () => {
  const s = setup([[], [...approved], [...approved, rev('Outside diff range comments (1)')]])
  const checks = (status_) => ({ check_runs: [{ name: 'CodeRabbit', status: status_, conclusion: null }] })
  put(s.fx, `${P}__commits__${HEAD}__check-runs.call1.json`, checks('in_progress'))
  put(s.fx, `${P}__commits__${HEAD}__check-runs.call2.json`, checks('in_progress'))
  put(s.fx, `${P}__commits__${HEAD}__check-runs.call3.json`, checks('completed'))
  const r = run(s, ['o/r', '7', '5'])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.timedOut, false)
  assert.deepEqual(out.pending, [])
  assert.equal(out.reviewBodies, 1)
  assert.equal(reads(s), 3)
})
