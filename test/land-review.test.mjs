// Runs land-wave.sh --review (and without it) on fixtures for test/fake-gh. Times are relative to the start of the test.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const S = 'a'.repeat(40)
const S8 = 'c'.repeat(40)
const B = 'b'.repeat(40)
const P = 'repos__o__r'
const REQ = '@coderabbitai full review'
const asked = (n) => `POST /repos/o/r/issues/${n}/comments body=${REQ}`
let T0 = 0
beforeEach(() => { T0 = Date.now() })
const iso = (min) => new Date(T0 - min * 60000).toISOString().replace(/\.\d+Z$/, 'Z')
const isoSec = (sec) => new Date(T0 - sec * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))

const ci = { id: 1, name: 'ci', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', started_at: iso(100), output: { title: 'ok', summary: '' } }
const bot = ({ id = 5151, min = 0, conclusion = 'success', title = 'Finished', summary = 'Result: Success - Review completed', slug = 'coderabbitai' } = {}) =>
  ({ id, name: 'CodeRabbit', app: { slug }, status: 'completed', conclusion, started_at: min === 0 ? isoSec(0) : iso(min), output: { title, summary } })
const approval = (sha) => ({ id: 1, user: { login: 'gitar-bot[bot]' }, state: 'APPROVED', body: '', commit_id: sha, submitted_at: iso(30) })
const request = (min, id) => ({ id, user: { login: 'alfhen' }, body: REQ, created_at: iso(min) })

// One PR of the base fixture: green CI, no approval, no thread, no review body. The request is answered with a comment 30 seconds old.
const addPr = (fx, n, sha, { mergeable = true, runs = [ci], reviews = [], inline = [], requests = [], head = sha, swapRuns = null } = {}) => {
  const pull = (merged) => ({ merged, mergeable, head: { sha: head, ref: `feat/${n}`, repo: { full_name: 'o/r' } } })
  put(fx, `${P}__pulls__${n}.json`, pull(false))
  put(fx, `merged-${n}.json`, pull(true))
  put(fx, `${P}__pulls__${n}__merge.PUT.then`, `merged-${n}.json ${P}__pulls__${n}.json\n`)
  put(fx, `${P}__pulls__${n}__merge.PUT.json`, { merged: true })
  put(fx, `${P}__commits__${sha}__check-runs.json`, { check_runs: runs })
  put(fx, `${P}__commits__${sha}__status.json`, { state: 'success', statuses: [] })
  put(fx, `${P}__commits__${sha}__check-suites.json`, { check_suites: [{ created_at: iso(120) }] })
  put(fx, `${P}__pulls__${n}__reviews.json`, reviews)
  put(fx, `${P}__pulls__${n}__comments.json`, inline)
  put(fx, `${P}__issues__${n}__comments.json`, requests)
  const posted = { id: 9000 + n, user: { login: 'alfhen' }, body: REQ, created_at: isoSec(30) }
  put(fx, `${P}__issues__${n}__comments.POST.json`, posted)
  if (swapRuns) {
    put(fx, `runs-after-${n}.json`, { check_runs: swapRuns })
    put(fx, `comments-after-${n}.json`, [...requests, posted])
    put(fx, `${P}__issues__${n}__comments.POST.then`, `runs-after-${n}.json ${P}__commits__${sha}__check-runs.json\ncomments-after-${n}.json ${P}__issues__${n}__comments.json\n`)
  }
}
const setup = (prs = [[7, S, {}]], repoComments = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'landrev-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  put(fx, `${P}.json`, { default_branch: 'main' })
  put(fx, `${P}__contents__.github__pipeline.json@ref=refs__heads__main.json`, { gates: [], knownFlakes: [] })
  put(fx, 'user.json', { login: 'alfhen' })
  put(fx, `${P}__issues__comments.json`, repoComments)
  for (const [n, sha, o] of prs) addPr(fx, n, sha, o)
  return { dir, bin, fx, log: join(dir, 'log') }
}
const run = (s, args, env = {}, scripts = join(root, 'scripts')) => {
  const e = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, PIPELINE_TEST_FAST: '1', ...env }
  if (!('CLAUDECODE' in env)) delete e.CLAUDECODE
  const r = spawnSync('bash', [join(scripts, 'land-wave.sh'), ...args], { env: e, encoding: 'utf8' })
  const log = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  return { code: r.status, out: r.stdout + r.stderr, log }
}
const land = (s, extra = [], env = {}) => run(s, ['--review', ...extra, 'o/r', `7:${S}`], env)
const requested = (r, n = 7) => r.log.includes(asked(n))
const merged = (r, n = 7) => r.log.some((l) => l.startsWith(`PUT /repos/o/r/pulls/${n}/merge`))
const reviewsReads = (r) => r.log.filter((l) => l.startsWith('GET /repos/o/r/pulls/7/reviews')).length

test('the base fixture asks for the review after CI is green', () => {
  const r = land(setup())
  assert.ok(requested(r), r.log.join('\n'))
})

test('a PR that is not MERGEABLE gets no request and goes on to merge-pr.sh, which refuses', () => {
  const r = land(setup([[7, S, { mergeable: null }]]))
  assert.equal(r.code, 5, r.out)
  assert.match(r.out, /PR 7 mergeable=UNKNOWN/)
  assert.match(r.out, /STOP #7 not merged/)
  assert.ok(!r.log.some((l) => l.includes(REQ)))
  assert.equal(reviewsReads(r), 1)
})

test('an unanswered bot inline comment stops with REVIEW and exit 9, with no request', () => {
  const inline = [{ id: 11, user: { login: 'coderabbitai[bot]' }, in_reply_to_id: null, body: 'x', pull_request_review_id: 5 }]
  const r = land(setup([[7, S, { inline }]]))
  assert.equal(r.code, 9, r.out)
  assert.match(r.out, /^REVIEW #7: /m)
  assert.ok(!r.log.some((l) => l.includes(REQ)))
  assert.ok(!merged(r))
  assert.equal(reviewsReads(r), 1)
})

test('a bot review body with a finding stops with REVIEW and exit 9, with no request', () => {
  const reviews = [{ id: 5, user: { login: 'coderabbitai[bot]' }, state: 'COMMENTED', body: '**Actionable comments posted: 1**', commit_id: S, submitted_at: iso(30) }]
  const r = land(setup([[7, S, { reviews }]]))
  assert.equal(r.code, 9, r.out)
  assert.match(r.out, /^REVIEW #7: /m)
  assert.ok(!r.log.some((l) => l.includes(REQ)))
  assert.ok(!merged(r))
  assert.equal(reviewsReads(r), 1)
})

test('a moved head stops with HEAD MOVED and no request', () => {
  const r = land(setup([[7, S, { head: B }]]))
  assert.equal(r.code, 6, r.out)
  assert.match(r.out, /^HEAD MOVED #7/m)
  assert.ok(!r.log.some((l) => l.includes(REQ)))
})

test('a failing check stops with LAND FIX and no request', () => {
  const failing = { id: 2, name: 'test', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure', started_at: iso(100), output: { title: 'x', summary: '' } }
  const r = land(setup([[7, S, { runs: [ci, failing] }]]))
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /^LAND FIX #7.*failing=\[test\]/m)
  assert.ok(!r.log.some((l) => l.includes(REQ)))
})

test('an approval clears the PR: one bot-status read, one merge-pr read, no request', () => {
  const r = land(setup([[7, S, { reviews: [approval(S)] }]]))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all merged/)
  assert.ok(merged(r))
  assert.ok(!r.log.some((l) => l.includes(REQ)))
  assert.equal(reviewsReads(r), 2)
})

test('an approval and a bot run with the title Review failed still run request-review.sh', () => {
  const r = land(setup([[7, S, { reviews: [approval(S)], runs: [ci, bot({ id: 6001, min: 5, title: 'Review failed' })] }]]))
  assert.ok(requested(r), r.log.join('\n'))
})

test('after two failed reviews the land stops with REVIEW and merges nothing', () => {
  const requests = [request(90, 1), request(30, 2)]
  const runs = [ci, bot({ id: 6002, min: 20, title: 'Review failed' })]
  const r = run(setup([[7, S, { reviews: [approval(S)], runs, requests }]], requests), ['--review', 'o/r', `7:${S}`])
  assert.equal(r.code, 9, r.out)
  assert.match(r.out, /^REVIEW #7: /m)
  assert.ok(!merged(r))
  assert.ok(!r.log.some((l) => l.includes(REQ)))
})

test('a run with the title Review failed from another App is not read, so the approval merges', () => {
  const r = land(setup([[7, S, { reviews: [approval(S)], runs: [ci, bot({ id: 6003, min: 5, title: 'Review failed', slug: 'github-actions' })] }]]))
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.log.some((l) => l.includes(REQ)))
  assert.ok(merged(r))
  assert.match(r.out, /all merged/)
})

test('a review that comes after the request is followed by the merge', () => {
  const swapRuns = [ci, bot({ id: 5151 })]
  const r = land(setup([[7, S, { swapRuns }]]))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /REVIEWED #7 run/)
  assert.ok(merged(r))
  assert.match(r.out, /all merged/)
})

test('no review after the request stops with NO REVIEW and a REVIEW line with the same cause', () => {
  const r = land(setup())
  assert.equal(r.code, 9, r.out)
  const no = r.out.split('\n').find((l) => l.startsWith('NO REVIEW #7: '))
  assert.ok(no, r.out)
  const cause = no.slice('NO REVIEW #7: '.length)
  assert.ok(r.out.split('\n').includes(`REVIEW #7: ${cause}`), r.out)
  assert.ok(!merged(r))
})

test('a failed read of bot-status.sh posts no request, merges nothing and stops with exit 5', () => {
  const s = setup()
  put(s.fx, `${P}__pulls__7__reviews.GET.error`, 'HTTP 500')
  const r = land(s)
  assert.equal(r.code, 5, r.out)
  assert.match(r.out, /^STOP #7: cannot read the bot status/m)
  assert.ok(!r.log.some((l) => l.includes(REQ)))
  assert.ok(!merged(r))
})

const two = (o7) => run(setup([[7, S, o7], [8, S8, {}]]), ['--review', 'o/r', `7:${S}`, `8:${S8}`])

test('the wave stops at an unanswered bot comment and posts no request for the next PR', () => {
  const r = two({ inline: [{ id: 11, user: { login: 'coderabbitai[bot]' }, in_reply_to_id: null, body: 'x', pull_request_review_id: 5 }] })
  assert.equal(r.code, 9, r.out)
  assert.match(r.out, /^REVIEW #7: /m)
  assert.ok(!r.log.some((l) => l.includes('/pulls/8') || l.includes('/issues/8/')))
})

test('the wave stops at a PR that merge-pr.sh refuses and posts no request for the next PR', () => {
  const r = two({ mergeable: null })
  assert.equal(r.code, 5, r.out)
  assert.match(r.out, /STOP #7 not merged/)
  assert.ok(!r.log.some((l) => l.includes('/issues/8/')))
})

test('after PR 7 merges the next PR gets its request', () => {
  const r = two({ reviews: [approval(S)] })
  assert.ok(merged(r))
  assert.ok(r.log.includes(asked(8)), r.log.join('\n'))
  const put = r.log.findIndex((l) => l.startsWith('PUT /repos/o/r/pulls/7/merge'))
  assert.ok(put >= 0 && put < r.log.indexOf(asked(8)), r.log.join('\n'))
})

for (const order of [['--review', '--person'], ['--person', '--review']]) {
  test(`${order.join(' ')} works with an approval and asks for a review without one`, () => {
    const withApproval = run(setup([[7, S, { reviews: [approval(S)] }]]), [...order, 'o/r', `7:${S}`], { CLAUDECODE: '1' })
    assert.equal(withApproval.code, 0, withApproval.out)
    assert.ok(merged(withApproval))
    assert.doesNotMatch(withApproval.out, /--auto|the gate holds/)
    const bare = run(setup(), [...order, 'o/r', `7:${S}`], { CLAUDECODE: '1' })
    assert.ok(requested(bare), bare.log.join('\n'))
  })
}

test('--review alone in an agent shell is refused by merge-pr.sh', () => {
  const r = run(setup([[7, S, { reviews: [approval(S)] }]]), ['--review', 'o/r', `7:${S}`], { CLAUDECODE: '1' })
  assert.equal(r.code, 5, r.out)
  assert.match(r.out, /NOT merged/)
  assert.ok(!merged(r))
})

test('without --review the calls are the same as on the default branch', (t) => {
  let old
  try { old = execFileSync('git', ['show', 'origin/main:scripts/land-wave.sh'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return t.skip('origin/main is not available') }
  if (old.includes('--review')) return t.skip('origin/main already has --review')
  const dir = mkdtempSync(join(tmpdir(), 'landrev-old-'))
  cpSync(join(root, 'scripts'), dir, { recursive: true })
  writeFileSync(join(dir, 'land-wave.sh'), old)
  const mk = () => setup([[7, S, { reviews: [approval(S)] }]])
  const a = mk(); const b = mk()
  const ra = run(a, ['o/r', `7:${S}`], {}, dir)
  const rb = run(b, ['o/r', `7:${S}`])
  assert.equal(ra.code, 0, ra.out)
  assert.equal(rb.code, 0, rb.out)
  assert.match(rb.out, /all merged/)
  assert.deepEqual(rb.log, ra.log)
  assert.ok(!rb.log.some((l) => l.includes(REQ)))
})

test('SKILL.md describes the review request of the land step', () => {
  const md = readFileSync(join(root, 'skills/pr-pipeline/SKILL.md'), 'utf8')
  const lines = md.split('\n')
  const s3Start = lines.findIndex((l) => l.startsWith('## Step 3'))
  const s3 = lines.slice(s3Start + 1, s3Start + 1 + lines.slice(s3Start + 1).findIndex((l) => l.startsWith('## '))).join('\n')
  for (const w of ['--review', '64 minutes', 'REVIEW #', 'background', '10 minutes', 'at a time']) assert.ok(s3.includes(w), w)
  assert.match(s3, /\block\b/)
  assert.match(s3, /two requests|request 2|second request/i)
  const step10 = lines.find((l) => l.startsWith('10. **Bots'))
  for (const w of ['land step', 'botWaitMinutes', 'request']) assert.ok(step10.includes(w), w)
  assert.match(step10, /botWaitMinutes[^.]*\b0\b/)
  const row = lines.find((l) => l.startsWith('| Bot rate-limited'))
  assert.ok(row.includes('64 minutes'))
  assert.match(row, /two requests|request 2|second request/)
  const args = md.slice(md.indexOf('### Workflow arguments'), md.indexOf('### Role agents'))
  assert.match(args, /botWaitMinutes[^.\n]*\b0\b/)
})

test('SKILL.md says the review request needs the CodeRabbit check run', () => {
  const md = readFileSync(join(root, 'skills/pr-pipeline/SKILL.md'), 'utf8')
  const line = md.split('\n').find((l) => l.startsWith('With `--review`, the land step asks for the review'))
  assert.ok(line.includes('reviews.review_progress'))
  assert.ok(line.includes('check run'))
  assert.match(line, /\bfalse\b/)
})

test('with an approval only the newest bot run decides whether a request is posted', () => {
  const older = bot({ id: 6101, min: 20, title: 'Review failed' })
  const newer = bot({ id: 6102, min: 10 })
  const r1 = land(setup([[7, S, { reviews: [approval(S)], runs: [ci, older, newer] }]]))
  assert.equal(r1.code, 0, r1.out)
  assert.match(r1.out, /all merged/)
  assert.ok(merged(r1))
  assert.ok(!r1.log.some((l) => l.includes(REQ)))
  const failedNewest = bot({ id: 6101, min: 10, title: 'Review failed' })
  const olderDone = bot({ id: 6102, min: 20 })
  const r2 = land(setup([[7, S, { reviews: [approval(S)], runs: [ci, failedNewest, olderDone] }]]))
  assert.ok(requested(r2), r2.log.join('\n'))
})

test('an approval with a failed newest review does not take approvedBy: open comments stop the land', () => {
  const runs = [ci, bot({ id: 6001, min: 5, title: 'Review failed' })]
  const inline = [{ id: 11, user: { login: 'coderabbitai[bot]' }, in_reply_to_id: null, body: 'x', pull_request_review_id: 5 }]
  const r1 = land(setup([[7, S, { reviews: [approval(S)], runs, inline }]]))
  assert.equal(r1.code, 9, r1.out)
  assert.match(r1.out, /^REVIEW #7: /m)
  assert.ok(!r1.log.some((l) => l.includes(REQ)))
  assert.ok(!merged(r1))
  const r2 = land(setup([[7, S, { reviews: [approval(S)], runs }]]))
  assert.ok(requested(r2), r2.log.join('\n'))
})

test('the README sentence on the review bot says what the clean review is', () => {
  const md = readFileSync(join(root, 'README.md'), 'utf8')
  const line = md.split('\n').find((l) => l.startsWith('- A review bot on the repo'))
  assert.ok(line.includes('@coderabbitai full review'))
  assert.ok(line.includes('Minor or Trivial'))
  assert.ok(line.includes('answered'))
  assert.match(line, /counts? 0[^.]*does not clear the gate/)
})

test('a pair that is already merged gets no review request', () => {
  const s = setup()
  put(s.fx, `${P}__pulls__7.json`, { merged: true, state: 'closed', mergeable: true, head: { sha: S, ref: 'feat/7', repo: { full_name: 'o/r' } } })
  const r = land(s)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.split('\n').some((l) => l.startsWith('MERGED #7 already')), r.out)
  assert.equal(requested(r), false)
  assert.ok(!r.log.some((l) => l.includes(REQ)))
  assert.equal(merged(r), false)
  assert.equal(r.out.trim().split('\n').pop(), 'all merged')
})
