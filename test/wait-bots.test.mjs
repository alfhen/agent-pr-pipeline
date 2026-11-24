// Runs wait-bots.sh (with bot-status.sh) and the fake-gh extensions against fixtures built in each test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
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
  put(fx, `${P}__commits__${HEAD}__check-suites.json`, { total_count: 0, check_suites: [] })
  put(fx, 'user.json', { login: 'pipeline-bot-account' })
  reviews.forEach((r, i) => put(fx, `${P}__pulls__7__reviews.call${i + 1}.json`, r))
  return { dir, fx, log: join(dir, 'log') }
}
const approved = [{ user: { login: 'gitar-bot[bot]' }, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-01-01T00:00:00Z' }]
const run = (s, args, extra = {}) => spawnSync('bash', [join(root, 'scripts/wait-bots.sh'), ...args], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, WAIT_BOTS_INTERVAL: '0', BOT_LOGINS: 'gitar-bot[bot]', ...extra },
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
  put(s.fx, 'user.json', { login: 'pipeline-bot-account' })
  const r = spawnSync('bash', [join(root, 'scripts/bot-status.sh'), 'o/r', '7'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log },
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout).reviewBodies
}
let nextId = 100
const rev = (body, commit = HEAD, login = 'coderabbitai[bot]', id = nextId++, at = '2026-01-01T00:00:00Z') => ({ id, user: { login }, state: 'COMMENTED', commit_id: commit, submitted_at: at, body })

test('reviewBodies counts a CodeRabbit body with an Outside diff range section', () => {
  assert.equal(status([rev('Actionable comments posted: 0\n\n<details><summary>Outside diff range comments (1)</summary>x</details>')]), 1)
})

test('reviewBodies counts a CodeRabbit body with a Nitpick section', () => {
  assert.equal(status([rev('Actionable comments posted: 0\n<summary>Nitpick comments (2)</summary>')]), 1)
})

test('reviewBodies counts a CodeRabbit body with a Duplicate comments section', () => {
  assert.equal(status([rev('Actionable comments posted: 0\n<summary>Duplicate comments (1)</summary>')]), 1)
})

test('reviewBodies skips "Actionable comments posted: 0" and Gitar approval text', () => {
  assert.equal(status([rev('**Actionable comments posted: 0**'), rev('Gitar has auto-approved this PR', HEAD, 'gitar-bot[bot]')]), 0)
})

test('reviewBodies counts a body with a Nitpick section that quotes the Gitar approval phrase', () => {
  assert.equal(status([rev('Actionable comments posted: 0\n<summary>Nitpick comments (1)</summary>Gitar has auto-approved this PR')]), 1)
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
const listing = (ids, head = HEAD, rest = 'Note, not filed: x, y') => `<!-- pipeline-bot-answer head=${head} -->\n<!-- pipeline-reviews ${ids.join(',')} -->\n${rest}`
const answer = (login, body = marker(), association = 'NONE', at = '2026-01-01T00:30:00Z') => ({ user: { login }, author_association: association, created_at: at, body })
const ME = 'pipeline-bot-account'
const NEW = 'Something new'

test('reviewBodies does not count a review whose id is on the second line of a trusted answer comment', () => {
  const two = () => [rev(NEW, HEAD, undefined, 101), rev(NEW, HEAD, undefined, 102)]
  assert.equal(status(two(), [answer(ME, listing([101, 102]))]), 0)
  assert.equal(status(two(), [answer(ME, listing([101]))]), 1)
  assert.equal(status(two(), [answer(ME, `<!-- pipeline-bot-answer head=${HEAD} -->\nNote, not filed: x, y\n<!-- pipeline-reviews 101,102 -->`)]), 2)
})

test('reviewBodies is 0 when the trusted answer comments of the head list every review between them', () => {
  const two = () => [rev(NEW, HEAD, undefined, 101), rev(NEW, HEAD, undefined, 102)]
  assert.equal(status(two(), [answer(ME, listing([101])), answer(ME, listing([102]))]), 0)
  assert.equal(status(two(), [answer(ME, listing([101]))]), 1)
})

test('reviewBodies counts a later review of the head that the answer comment does not list', () => {
  const rs = () => [rev(NEW, HEAD, undefined, 101, '2026-01-01T00:00:00Z'), rev(NEW, HEAD, undefined, 102, '2026-01-01T01:00:00Z')]
  assert.equal(status(rs(), [answer(ME, listing([101]))]), 1)
  assert.equal(status(rs(), [answer(ME, listing([101, 102]))]), 0)
})

test('reviewBodies compares no times: an older review that is not listed counts, a newer one that is listed does not', () => {
  const at = '2026-01-01T02:00:00Z'
  const old = [rev(NEW, HEAD, undefined, 101), rev(NEW, HEAD, undefined, 102)]
  assert.equal(status(old, [answer(ME, listing([101]), 'NONE', at)]), 1)
  const later = [rev(NEW, HEAD, undefined, 101), rev(NEW, HEAD, undefined, 102, '2026-01-01T03:00:00Z')]
  assert.equal(status(later, [answer(ME, listing([101, 102]), 'NONE', at)]), 0)
})

test('reviewBodies counts every review when the answer comment has no pipeline-reviews line', () => {
  const two = [rev(NEW, HEAD, undefined, 101), rev(NEW, HEAD, undefined, 102)]
  assert.equal(status(two, [answer(ME)]), 2)
  assert.equal(status([two[0]], [answer(ME)]), 1)
  assert.equal(status(two, [answer(ME, listing([101, 102]))]), 0)
})

test('reviewBodies counts every review with no answer comment, and a later no-finding review adds nothing', () => {
  assert.equal(status([rev(NEW, HEAD, undefined, 101), rev(NEW, HEAD, undefined, 102)], []), 2)
  const c = [answer(ME, listing([101]))]
  assert.equal(status([rev(NEW, HEAD, undefined, 101), rev('**Actionable comments posted: 0**', HEAD, undefined, 102)], c), 0)
  assert.equal(status([rev(NEW, HEAD, undefined, 101), rev(NEW, HEAD, undefined, 102)], c), 1)
})

test('reviewBodies ignores an answer comment from another account or for another head, and a review by a person', () => {
  const r = () => [rev(NEW, HEAD, undefined, 101)]
  assert.equal(status(r(), [answer(ME, listing([101]))]), 0)
  assert.equal(status(r(), [answer('someone', listing([101]), 'OWNER')]), 1)
  assert.equal(status(r(), [answer(ME, listing([101], OLD))]), 1)
  assert.equal(status(r(), [answer(ME, `quoted ${listing([101])}`)]), 1)
  assert.equal(status([...r(), rev(NEW, HEAD, 'alice', 102)], [answer(ME, listing([101]))]), 0)
})

test('wait-bots keeps polling while a bot check run is still running, and the body then counts', () => {
  const s = setup([[], [...approved], [...approved, rev('Outside diff range comments (1)')]])
  const checks = (status_) => ({ check_runs: [{ name: 'CodeRabbit', status: status_, conclusion: null, app: { slug: 'coderabbitai' } }] })
  put(s.fx, `${P}__commits__${HEAD}__check-runs.call1.json`, checks('in_progress'))
  put(s.fx, `${P}__commits__${HEAD}__check-runs.call2.json`, checks('in_progress'))
  put(s.fx, `${P}__commits__${HEAD}__check-runs.call3.json`, checks('completed'))
  const r = run(s, ['o/r', '7', '5'], { BOT_LOGINS: 'gitar-bot[bot],coderabbitai[bot]' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.timedOut, false)
  assert.deepEqual(out.pending, [])
  assert.equal(out.reviewBodies, 1)
  assert.equal(reads(s), 3)
})

const CR = 'coderabbitai[bot]'
const crRev = (commit, login = CR) => [{ user: { login }, state: 'COMMENTED', commit_id: commit, submitted_at: '2026-01-01T00:00:00Z', body: '' }]
const crRun = (status, conclusion, slug = 'coderabbitai') => ({ check_runs: [{ name: 'CodeRabbit', status, conclusion, app: { slug } }] })
const withRuns = (s, runs) => put(s.fx, `${P}__commits__${HEAD}__check-runs.json`, runs)
const waitCR = (s, n = '2', extra = {}) => { const r = run(s, ['o/r', '7', n], { BOT_LOGINS: CR, ...extra }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout) }

test('finishedOnHead: a skipped run is not finished, a completed one is', () => {
  const s = setup([[]])
  withRuns(s, crRun('completed', 'skipped'))
  const out = waitCR(s)
  assert.deepEqual(out.finishedOnHead, [])
  assert.equal(out.timedOut, true)
  withRuns(s, crRun('completed', 'success'))
  const ok = waitCR(s)
  assert.deepEqual(ok.finishedOnHead, [CR])
  assert.equal(ok.timedOut, false)
})

test('finishedOnHead: a review of an older commit is not finished, one on the head is', () => {
  const old = setup([crRev('b'.repeat(40))])
  const a = waitCR(old)
  assert.deepEqual(a.finishedOnHead, [])
  assert.equal(a.timedOut, true)
  const cur = setup([crRev(HEAD)])
  const b = waitCR(cur)
  assert.deepEqual(b.finishedOnHead, [CR])
  assert.equal(b.timedOut, false)
})

test('the bot is matched by its exact login and its App slug plus [bot]', () => {
  const login = setup([crRev(HEAD, 'coderabbitai')])
  const a = waitCR(login)
  assert.deepEqual(a.finishedOnHead, [])
  assert.equal(a.timedOut, true)
  const slug = setup([[]])
  withRuns(slug, crRun('completed', 'success', 'coderabbitai-other'))
  const b = waitCR(slug)
  assert.deepEqual(b.finishedOnHead, [])
  assert.equal(b.timedOut, true)
})

test('every configured bot must finish: one finished bot is not enough', () => {
  // CodeRabbit approved the head, so the old rule (any bot seen on the head) would stop at once.
  const s = setup([[{ user: { login: CR }, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-01-01T00:00:00Z' }]])
  const both = waitCR(s, '3', { BOT_LOGINS: `${CR},gitar-bot[bot]` })
  assert.equal(both.timedOut, true)
  assert.deepEqual(both.finishedOnHead, [CR])
  assert.equal(reads(s), 3)
  const t = setup([[...crRev(HEAD), ...approved]])
  assert.equal(waitCR(t, '3', { BOT_LOGINS: `${CR},gitar-bot[bot]` }).timedOut, false)
})

test('a bot that commented without approving stops the wait at the first poll', () => {
  const s = setup([crRev(HEAD)])
  withRuns(s, crRun('completed', 'success'))
  const out = waitCR(s, '3')
  assert.equal(out.timedOut, false)
  assert.deepEqual(out.approvedBy, [])
  assert.equal(reads(s), 1)
})

test('a running bot check run holds the wait to its limit', () => {
  const s = setup([[{ user: { login: CR }, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-01-01T00:00:00Z' }]])
  withRuns(s, crRun('in_progress', null))
  const out = waitCR(s, '3')
  assert.equal(out.timedOut, true)
  assert.deepEqual(out.pending, ['CodeRabbit'])
  assert.equal(reads(s), 3)
})

test('a finished bot with an open thread stops the wait and the thread is counted', () => {
  const s = setup([crRev(HEAD)])
  withRuns(s, crRun('completed', 'success'))
  put(s.fx, `${P}__pulls__7__comments.json`, [{ id: 5, in_reply_to_id: null, user: { login: CR }, body: 'fix' }])
  const out = waitCR(s, '3')
  assert.equal(out.timedOut, false)
  assert.equal(out.openThreads, 1)
  assert.equal(reads(s), 1)
})
