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
const botInline = (login = 'coderabbitai[bot]') => ({ id: 11, user: { login }, in_reply_to_id: null, body: 'x', pull_request_review_id: 5 })
const findingReview = (sha) => ({ id: 5, user: { login: 'coderabbitai[bot]' }, state: 'COMMENTED', body: '**Actionable comments posted: 1**', commit_id: sha, submitted_at: iso(30) })
const answerLine = (sha, t, b) => `ANSWER #7 ${sha}: ${t} threads, ${b} review bodies; run the bots step with answer: true, then land again`
const noAnswer = (r) => assert.ok(!r.out.split('\n').some((l) => l.startsWith('ANSWER #')), r.out)
const noMergePr = (r) => assert.ok(!r.out.split('\n').some((l) => l.startsWith('PR 7 mergeable=')), r.out)
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
  put(fx, `${P}__pulls__${n}__files.json`, [{ filename: 'src/a.js', status: 'modified' }])
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
  assert.match(r.out, /^STOP #7 not merged/m)
  noAnswer(r)
  assert.ok(!r.log.some((l) => l.includes(REQ)))
  assert.equal(reviewsReads(r), 1)
})

test('an unanswered bot inline comment stops with ANSWER and exit 10, with no request', () => {
  const r = land(setup([[7, S, { inline: [botInline()] }]]))
  assert.equal(r.code, 10, r.out)
  assert.ok(r.out.split('\n').includes(answerLine(S, 1, 0)), r.out)
  assert.ok(!r.out.split('\n').some((l) => l.startsWith('PR 7 mergeable=')))
  assert.ok(!r.log.some((l) => l.includes(REQ)))
  assert.ok(!merged(r))
  assert.equal(reviewsReads(r), 1)
})

test('a bot review body with a finding stops with ANSWER and exit 10, with no request', () => {
  const r = land(setup([[7, S, { reviews: [findingReview(S)] }]]))
  assert.equal(r.code, 10, r.out)
  assert.ok(r.out.split('\n').includes(answerLine(S, 0, 1)), r.out)
  assert.ok(!r.out.split('\n').some((l) => l.startsWith('PR 7 mergeable=')))
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
  noAnswer(r)
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
  assert.equal(r.code, 9)
  noAnswer(r)
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

// A swapRuns PR whose request also copies more fixture files, so the review that comes leaves comments.
const afterRequest = (copies) => {
  const s = setup([[7, S, { swapRuns: [ci, bot({ id: 5151 })] }]])
  const then = `${P}__issues__7__comments.POST.then`
  let extra = ''
  for (const [name, dest, v] of copies) { put(s.fx, name, v); extra += `${name} ${P}__pulls__7__${dest}.json\n` }
  put(s.fx, then, readFileSync(join(s.fx, then), 'utf8') + extra)
  return s
}
const withApprovalFrom = (login) => ({ ...approval(S), user: { login } })

test('a head that moved during the request stops with HEAD MOVED, not ANSWER', () => {
  const s = afterRequest([['inline-after.json', 'comments', [botInline()]]])
  put(s.fx, 'pull-moved.json', { merged: false, mergeable: true, head: { sha: B, ref: 'feat/7', repo: { full_name: 'o/r' } } })
  put(s.fx, `${P}__commits__${B}__check-runs.json`, { check_runs: [ci] })
  put(s.fx, `${P}__commits__${B}__check-suites.json`, { check_suites: [] })
  const then = `${P}__issues__7__comments.POST.then`
  put(s.fx, then, readFileSync(join(s.fx, then), 'utf8') + `pull-moved.json ${P}__pulls__7.json\n`)
  const r = land(s)
  assert.match(r.out, /REVIEWED #7 run 5151/)
  assert.equal(r.code, 6, r.out)
  assert.match(r.out, /^HEAD MOVED #7/m)
  noAnswer(r)
  noMergePr(r)
})

test('a review that leaves an inline comment after the request stops with ANSWER and exit 10', () => {
  const r = land(afterRequest([['inline-after.json', 'comments', [botInline()]]]))
  assert.match(r.out, /REVIEWED #7 run 5151/)
  assert.equal(r.code, 10, r.out)
  assert.ok(r.out.split('\n').includes(answerLine(S, 1, 0)), r.out)
  noMergePr(r)
  assert.ok(!merged(r))
})

test('a review body with a finding after the request stops with ANSWER and exit 10', () => {
  const r = land(afterRequest([['reviews-after.json', 'reviews', [findingReview(S)]]]))
  assert.equal(r.code, 10, r.out)
  assert.ok(r.out.split('\n').includes(answerLine(S, 0, 1)), r.out)
  noMergePr(r)
  assert.ok(!merged(r))
})

test('a review from a login that is not a bot gives no approval after the request', () => {
  const r = land(afterRequest([['reviews-after.json', 'reviews', [withApprovalFrom('alice')]], ['inline-after.json', 'comments', [botInline()]]]))
  assert.equal(r.code, 10, r.out)
  assert.match(r.out, new RegExp(`^ANSWER #7 ${S}: 1 threads`, 'm'))
  noMergePr(r)
  assert.ok(!merged(r))
})

test('after the request an approval of a bot merges even with an open thread', () => {
  const r = land(afterRequest([['reviews-after.json', 'reviews', [approval(S)]], ['inline-after.json', 'comments', [botInline()]]]))
  assert.match(r.out, /REVIEWED #7 run 5151/)
  assert.ok(r.out.split('\n').some((l) => l.startsWith('PR 7 mergeable=')), r.out)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all merged/)
  assert.ok(merged(r))
  noAnswer(r)
})

test('after the request an approval of a bot merges even with a review body with a finding', () => {
  const r = land(afterRequest([['reviews-after.json', 'reviews', [approval(S), findingReview(S)]]]))
  assert.ok(r.out.split('\n').some((l) => l.startsWith('PR 7 mergeable=')), r.out)
  assert.equal(r.code, 0, r.out)
  assert.ok(merged(r))
  noAnswer(r)
})

test('a failed second read of the bot status stops with exit 5 and no merge-pr.sh call', () => {
  const s = afterRequest([])
  put(s.fx, 'err-after.txt', 'HTTP 500')
  const then = `${P}__issues__7__comments.POST.then`
  put(s.fx, then, readFileSync(join(s.fx, then), 'utf8') + `err-after.txt ${P}__pulls__7__reviews.GET.error\n`)
  const r = land(s)
  assert.match(r.out, /REVIEWED #7 run 5151/)
  assert.equal(r.code, 5, r.out)
  assert.match(r.out, /^STOP #7: cannot read the bot status/m)
  noMergePr(r)
  assert.ok(!merged(r))
})

test('the answer stop uses the head of a pair that is the PR head', () => {
  const r = run(setup([[7, B, { inline: [botInline()] }]]), ['--review', 'o/r', `7:${B}`])
  assert.equal(r.code, 10, r.out)
  assert.match(r.out, new RegExp(`^ANSWER #7 ${B}: 1 threads`, 'm'))
  const replied = [botInline(), { id: 12, user: { login: 'alfhen' }, in_reply_to_id: 11, body: 'done', pull_request_review_id: 6 }]
  const r2 = run(setup([[7, B, { inline: replied }]]), ['--review', 'o/r', `7:${B}`])
  noAnswer(r2)
  assert.ok(requested(r2), r2.log.join('\n'))
})

test('an open inline comment of a login that is not a bot gets the request and no ANSWER', () => {
  const r = land(setup([[7, S, { inline: [botInline('alice')] }]]))
  assert.ok(requested(r), r.log.join('\n'))
  noAnswer(r)
  assert.notEqual(r.code, 10)
})

test('before the request an approval of a bot merges even with an open thread', () => {
  const r = land(setup([[7, S, { reviews: [approval(S)], inline: [botInline()] }]]))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all merged/)
  assert.ok(merged(r))
  assert.ok(!requested(r))
  noAnswer(r)
})

test('before the request an approval of a login that is not a bot still gives the ANSWER stop', () => {
  const r = land(setup([[7, S, { reviews: [withApprovalFrom('alice')], inline: [botInline()] }]]))
  assert.equal(r.code, 10, r.out)
  assert.match(r.out, new RegExp(`^ANSWER #7 ${S}: 1 threads`, 'm'))
  assert.ok(!merged(r))
  assert.ok(!requested(r))
})

const two = (o7) => run(setup([[7, S, o7], [8, S8, {}]]), ['--review', 'o/r', `7:${S}`, `8:${S8}`])

test('the wave stops at an unanswered bot comment and posts no request for the next PR', () => {
  const r = two({ inline: [botInline()] })
  assert.equal(r.code, 10, r.out)
  assert.match(r.out, /^ANSWER #7 /m)
  assert.ok(!r.log.some((l) => l.includes('/pulls/8') || l.includes('/issues/8/')))
})

test('the wave stops at a PR that merge-pr.sh refuses and posts no request for the next PR', () => {
  const r = two({ mergeable: null })
  assert.equal(r.code, 5, r.out)
  assert.match(r.out, /^STOP #7 not merged/m)
  noAnswer(r)
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
  assert.match(r.out, /^STOP #7 not merged/m)
  noAnswer(r)
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
  const inline = [botInline()]
  const r1 = land(setup([[7, S, { reviews: [approval(S)], runs, inline }]]))
  assert.equal(r1.code, 10, r1.out)
  assert.match(r1.out, /^ANSWER #7 /m)
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

const skillLines = () => readFileSync(join(root, 'skills/pr-pipeline/SKILL.md'), 'utf8').split('\n')
const stepThree = () => {
  const lines = skillLines()
  const start = lines.findIndex((l) => l.startsWith('## Step 3'))
  return lines.slice(start + 1, start + 1 + lines.slice(start + 1).findIndex((l) => l.startsWith('## ')))
}

test('SKILL.md Step 3 says what to do on an ANSWER line', () => {
  const line = stepThree().find((l) => l.startsWith('With `--review`, the land step asks for the review'))
  for (const w of ['ANSWER #', 'answer: true', 'prNumber', 'headSha', 'evals', 'evalsMeta', '--person --review', '--auto', 'reviews.review_progress', 'check run']) assert.ok(line.includes(w), w)
  assert.match(line, /botWaitMinutes[^.\n]*\b0\b/)
  assert.match(line, /never[^.]*first run/)
  assert.match(line, /not ready[^.]*(do not land|person decides)/)
  const old = stepThree().join('\n').split(/(?<=\.)\s+/).filter((x) => /openThreads|reviewBodies/.test(x) && x.includes('REVIEW #<pr>: ') && x.includes('exit 9'))
  assert.deepEqual(old, [])
})

test('SKILL.md has a row for ANSWER with exit 10 and the REVIEW row keeps only a review that did not come', () => {
  const lines = skillLines()
  const answer = lines.find((l) => l.startsWith('| `ANSWER #'))
  assert.match(answer, /exit 10/)
  const review = lines.find((l) => l.startsWith('| `REVIEW #n: <cause>`'))
  assert.match(review, /none came|did not come/)
  assert.doesNotMatch(review, /open comments|review body/)
})

// reviewOnRequest: the real settings file of the repo, with the key set per case.
const realSettings = () => JSON.parse(readFileSync(join(root, '.github/pipeline.json'), 'utf8'))
const withKey = (value) => { const o = realSettings(); delete o.reviewOnRequest; if (value !== undefined) o.reviewOnRequest = value; return o }
const MAIN = `${P}__contents__.github__pipeline.json@ref=refs__heads__main.json`
const roqSetup = (value, prOpts = {}) => {
  const s = setup([[7, S, prOpts]])
  put(s.fx, MAIN, withKey(value))
  return s
}
const warns = (r) => r.out.split('\n').filter((l) => l.startsWith('WARN'))
const stopLine = (r) => r.out.split('\n').some((l) => l.startsWith('STOP #7 not merged'))
const noRequestPlain = (r) => { assert.equal(requested(r), false, r.out); assert.equal(r.code, 5, r.out); assert.ok(stopLine(r), r.out) }

test('reviewOnRequest true on the default branch asks for the review without --review', () => {
  const s = roqSetup(true)
  assert.equal(JSON.parse(readFileSync(join(s.fx, MAIN), 'utf8')).reviewOnRequest, true)
  const r = run(s, ['o/r', `7:${S}`])
  const withFlag = land(setup())
  assert.equal(requested(r), true, r.out)
  assert.equal(r.code, 9, r.out)
  assert.equal(r.code, withFlag.code)
  assert.ok(r.out.split('\n').some((l) => l.startsWith('REVIEW #7: ')), r.out)
})

test('reviewOnRequest true merges the PR once the review came', () => {
  const s = roqSetup(true, { swapRuns: [ci, bot({ id: 5151 })] })
  const r = run(s, ['o/r', `7:${S}`])
  assert.ok(r.out.split('\n').includes('REVIEWED #7 run 5151'), r.out)
  assert.equal(merged(r), true, r.out)
  assert.equal(r.code, 0, r.out)
  assert.equal(r.out.trim().split('\n').pop(), 'all merged')
})

test('reviewOnRequest is read from the default branch, not from the PR head', () => {
  const s = roqSetup(undefined)
  const headFile = `${P}__contents__.github__pipeline.json@ref=${S}.json`
  put(s.fx, headFile, withKey(true))
  assert.equal(JSON.parse(readFileSync(join(s.fx, headFile), 'utf8')).reviewOnRequest, true)
  assert.equal('reviewOnRequest' in JSON.parse(readFileSync(join(s.fx, MAIN), 'utf8')), false)
  const r = run(s, ['o/r', `7:${S}`])
  noRequestPlain(r)
  // Without the read the test would pass for any reason: the log must show the settings read from the default branch only.
  const reads = r.log.filter((l) => l.includes('.github/pipeline.json'))
  assert.ok(reads.some((l) => l.includes('ref=refs/heads/main')), r.log.join('\n'))
  assert.equal(reads.some((l) => l.includes(`ref=${S}`)), false, r.log.join('\n'))
})

for (const [label, value] of [['missing', undefined], ['null', null], ['false', false]]) {
  test(`reviewOnRequest ${label}: no request and no WARN`, () => {
    const s = roqSetup(value)
    assert.equal(JSON.parse(readFileSync(join(s.fx, MAIN), 'utf8')).reviewOnRequest, value)
    const r = run(s, ['o/r', `7:${S}`])
    noRequestPlain(r)
    assert.deepEqual(warns(r), [])
  })
}

test('reviewOnRequest missing: an approved PR merges with no request', () => {
  const s = roqSetup(undefined, { reviews: [approval(S)] })
  const r = run(s, ['o/r', `7:${S}`])
  assert.equal(r.code, 0, r.out)
  assert.equal(merged(r), true)
  assert.equal(r.out.trim().split('\n').pop(), 'all merged')
  assert.equal(requested(r), false)
})

test('an unreadable settings file acts as false with one WARN', () => {
  const s = roqSetup(true)
  const errFile = join(s.fx, `${P}__contents__.github__pipeline.json.GET.error`)
  writeFileSync(errFile, 'HTTP 500')
  assert.equal(readFileSync(errFile, 'utf8'), 'HTTP 500')
  const r = run(s, ['o/r', `7:${S}`])
  noRequestPlain(r)
  assert.equal(warns(r).length, 1, r.out)
})

for (const value of ['true', 1]) {
  test(`reviewOnRequest ${JSON.stringify(value)} is not a boolean: false with one WARN`, () => {
    const s = roqSetup(value)
    assert.equal(typeof JSON.parse(readFileSync(join(s.fx, MAIN), 'utf8')).reviewOnRequest, typeof value)
    const r = run(s, ['o/r', `7:${S}`])
    noRequestPlain(r)
    assert.equal(warns(r).length, 1, r.out)
  })
}

test('merge-pr.sh prints one hint when no bot cleared, and none when one did', () => {
  const hint = /land-wave\.sh --review|reviewOnRequest/
  const direct = (s) => {
    const e = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, PIPELINE_TEST_FAST: '1' }
    delete e.CLAUDECODE
    const r = spawnSync('bash', [join(root, 'scripts/merge-pr.sh'), 'o/r', '7', S, 'feat/7'], { env: e, encoding: 'utf8' })
    return { code: r.status, lines: (r.stdout + r.stderr).split('\n') }
  }
  const a = direct(setup())
  assert.equal(a.code, 1, a.lines.join('\n'))
  assert.ok(a.lines.includes('PR 7 NOT merged'))
  assert.ok(a.lines.some((l) => l.includes('approved=[]')))
  assert.equal(a.lines.filter((l) => hint.test(l)).length, 1, a.lines.join('\n'))
  const s = setup([[7, S, { reviews: [approval(S)] }]])
  const rv = JSON.parse(readFileSync(join(s.fx, `${P}__pulls__7__reviews.json`), 'utf8'))
  assert.ok(rv.some((x) => x.user.login === 'gitar-bot[bot]' && x.state === 'APPROVED' && x.commit_id === S))
  const b = direct(s)
  assert.equal(b.code, 0, b.lines.join('\n'))
  assert.ok(b.lines.includes('PR 7 merged=true'))
  assert.equal(b.lines.filter((l) => hint.test(l)).length, 0)
})
