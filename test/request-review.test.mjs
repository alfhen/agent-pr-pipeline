// Runs scripts/request-review.sh on fixtures for test/fake-gh. Times are relative to the start of the test.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const S = 'a'.repeat(40)
const B = 'b'.repeat(40)
const P = 'repos__o__r'
const CHECKS = `${P}__commits__${S}__check-runs`
const PRC = `${P}__issues__7__comments`
const REPOC = `${P}__issues__comments`
const REQ = '@coderabbitai full review'
const POSTED = `POST /repos/o/r/issues/7/comments body=${REQ}`
let T0 = 0
beforeEach(() => { T0 = Date.now() })
const iso = (min) => new Date(T0 - min * 60000).toISOString().replace(/\.\d+Z$/, 'Z')
const isoSec = (sec) => new Date(T0 - sec * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))

const ci = { id: 1, name: 'ci', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', started_at: iso(100), output: { title: 'ok', summary: '' } }
const bot = ({ id = 5151, min = 0, status = 'completed', conclusion = 'success', title = 'Finished', summary = 'Result: Success - Review completed', slug = 'coderabbitai' } = {}) =>
  ({ id, name: 'CodeRabbit', app: { slug }, status, conclusion, started_at: min === 0 ? isoSec(0) : iso(min), output: { title, summary } })
const comment = (min, { user = 'alfhen', body = REQ } = {}) => ({ id: Math.floor(min * 1000) + 1, user: { login: user }, body, created_at: iso(min) })

// requests: comments of PR 7. repoComments: more comments of the repo. runs: check runs of S. seq: one run list per read.
// post: false leaves out the answer of the POST. swap: false keeps the runs as they are after the POST.
const setup = ({ requests = [], repoComments = [], runs = [ci], seq = null, post = true, swap = true, head = S } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  put(fx, `${P}__pulls__7.json`, { merged: false, mergeable: true, head: { sha: head, ref: 'feat/x' } })
  put(fx, 'user.json', { login: 'alfhen' })
  put(fx, `${P}__commits__${S}__check-suites.json`, { check_suites: [{ created_at: iso(120) }, { created_at: iso(119) }] })
  if (seq) seq.forEach((r, i) => put(fx, `${CHECKS}.call${i + 1}.json`, { check_runs: r }))
  else put(fx, `${CHECKS}.json`, { check_runs: runs })
  put(fx, `${PRC}.json`, requests)
  put(fx, `${REPOC}.json`, [...requests, ...repoComments])
  if (post) {
    put(fx, `${PRC}.POST.json`, { id: 9000, user: { login: 'alfhen' }, body: REQ, created_at: isoSec(30) })
    if (swap) {
      put(fx, 'runs-after.json', { check_runs: [...runs, bot()] })
      put(fx, 'comments-after.json', [...requests, { id: 9000, user: { login: 'alfhen' }, body: REQ, created_at: isoSec(30) }])
      put(fx, `${PRC}.POST.then`, `runs-after.json ${CHECKS}.json\ncomments-after.json ${PRC}.json\ncomments-after.json ${REPOC}.json\n`)
    }
  }
  return { dir, bin, fx, log: join(dir, 'log') }
}
const run = (s, { scripts = join(root, 'scripts'), env = {} } = {}) => {
  const e = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, PIPELINE_TEST_FAST: '1', ...env }
  const t = Date.now()
  const r = spawnSync('bash', [join(scripts, 'request-review.sh'), 'o/r', '7', S], { env: e, encoding: 'utf8' })
  const log = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  const lines = r.stdout.split('\n').filter(Boolean)
  return { code: r.status, out: r.stdout + r.stderr, lines, log, last: lines[lines.length - 1] ?? '', secs: (Date.now() - t) / 1000 }
}
const posts = (r) => r.log.filter((l) => l.startsWith('POST /repos/o/r/issues/7/comments'))
const waits = (r) => r.lines.filter((l) => /^WAIT \d+ #7$/.test(l)).map((l) => Number(l.split(' ')[1]))
const reviewed = (r, id) => assert.ok(r.lines.some((l) => l.startsWith(`REVIEWED #7 run ${id}`)), r.out)
const noReview = (r, re = /^NO REVIEW #7: /) => { assert.equal(r.code, 1, r.out); assert.match(r.last, re) }
const readsComments = (r) => assert.ok(r.log.some((l) => l.startsWith('GET /repos/o/r/issues/7/comments')), r.log.join('\n'))

test('a head that is not the given sha posts nothing and ends NO REVIEW', () => {
  const r = run(setup({ head: B }))
  noReview(r, /^NO REVIEW #7: .*bbbbbbb/)
  assert.ok(r.log.includes('GET /repos/o/r/pulls/7'))
  assert.equal(posts(r).length, 0)
})

test('the same fixture with the head back posts the request and ends REVIEWED', () => {
  const r = run(setup())
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(posts(r), [POSTED])
  assert.equal(r.last, 'REVIEWED #7 run 5151')
})

for (const [name, requests] of [
  ['no comment', []],
  ['the text by another login', [comment(60, { user: 'someone' })]],
  ['a longer text by the user', [comment(60, { body: `${REQ} please` })]],
  ['the text by the user before the push', [comment(180)]],
]) {
  test(`a request is counted only when it is the exact text of the user after the push (${name})`, () => {
    const r = run(setup({ requests }))
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(posts(r), [POSTED])
    reviewed(r, 5151)
    assert.deepEqual(waits(r), [])
    readsComments(r)
  })
}

test('one request after the push is followed and no request is posted', () => {
  const r = run(setup({ requests: [comment(70)], runs: [ci, bot({ id: 7001, min: 60 })], post: false }))
  assert.equal(r.code, 0, r.out)
  reviewed(r, 7001)
  assert.equal(posts(r).length, 0)
  readsComments(r)
})

test('two requests after the push: the run of the newest is followed and no request is posted', () => {
  const r = run(setup({ requests: [comment(90), comment(30)], runs: [ci, bot({ id: 7002, min: 20 })], post: false }))
  assert.equal(r.code, 0, r.out)
  reviewed(r, 7002)
  assert.equal(posts(r).length, 0)
  readsComments(r)
})

test('two requests and a run with the title Review failed give no third request', () => {
  const r = run(setup({ requests: [comment(90), comment(30)], runs: [ci, bot({ id: 7003, min: 20, title: 'Review failed' })], post: false }))
  noReview(r, /^NO REVIEW #7: .*two requests/)
  assert.equal(posts(r).length, 0)
  readsComments(r)
})

test('the request is posted with gh api and -f body, never gh pr, gh issue or -F body', () => {
  const src = readFileSync(join(root, 'scripts/request-review.sh'), 'utf8')
  assert.doesNotMatch(src, /gh +(pr|issue)\b/)
  assert.doesNotMatch(src, /-F body=/)
  assert.match(src, /-f body=/)
})

test('a request of the user on another PR 10 minutes ago delays the post by the real 54 minutes', () => {
  const r = run(setup({ repoComments: [{ ...comment(10), id: 4001 }] }))
  assert.equal(r.code, 0, r.out)
  const w = waits(r)
  assert.equal(w.length, 1, r.out)
  assert.ok(w[0] >= 3230 && w[0] <= 3240, String(w[0]))
  assert.ok(r.lines.indexOf(`WAIT ${w[0]} #7`) < r.lines.indexOf('REVIEWED #7 run 5151'))
  assert.deepEqual(posts(r), [POSTED])
  assert.ok(r.secs < 60)
})

test('a request of the user on another PR 70 minutes ago needs no wait', () => {
  const r = run(setup({ repoComments: [{ ...comment(70), id: 4001 }] }))
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(waits(r), [])
  assert.deepEqual(posts(r), [POSTED])
  assert.equal(r.last, 'REVIEWED #7 run 5151')
})

const seq3 = (startMin, extra = {}) => [[ci], [ci, bot({ id: 4242, min: startMin, status: 'in_progress', conclusion: null, ...extra })], [ci, bot({ id: 4242, min: startMin, ...extra })]]

test('after a request the run that started after it and completes is the answer', () => {
  const r = run(setup({ requests: [comment(10)], seq: seq3(5), post: false }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.lines.some((l) => l.startsWith('REVIEWED #7 run 4242')), r.out)
  assert.ok(r.log.filter((l) => l.startsWith(`GET /repos/o/r/commits/${S}/check-runs`)).length >= 3)
  assert.equal(posts(r).length, 0)
})

test('a run that started before the request is not the answer', () => {
  const r = run(setup({ requests: [comment(10)], seq: seq3(20) }))
  assert.ok(!r.lines.some((l) => l.startsWith('REVIEWED #7 run 4242')), r.out)
  assert.match(r.last, /^(NO REVIEW #7: |REVIEWED)/)
})

test('a run with the same name and text from another App is not the answer', () => {
  const other = { slug: 'github-actions' }
  const r = run(setup({ requests: [comment(10)], seq: seq3(5, other) }))
  assert.ok(!r.lines.some((l) => l.startsWith('REVIEWED #7 run 4242')), r.out)
  noReview(r)
})

for (const [name, over] of [
  ['rate limited', { conclusion: 'neutral', title: 'Review rate limited' }],
  ['cancelled', { conclusion: 'cancelled' }],
  ['failed', { title: 'Review failed' }],
]) {
  test(`a run that is ${name} after request 1 gives request 2 under the 64-minute rule`, () => {
    const r = run(setup({ requests: [comment(70)], runs: [ci, bot({ id: 7100, min: 60, ...over })] }))
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(posts(r), [POSTED])
    assert.deepEqual(waits(r), [])
    assert.equal(r.last, 'REVIEWED #7 run 5151')
  })
}

test('a completed review after request 1 gives no request 2', () => {
  const r = run(setup({ requests: [comment(70)], runs: [ci, bot({ id: 7101, min: 60 })], post: false }))
  assert.equal(r.code, 0, r.out)
  assert.equal(posts(r).length, 0)
  reviewed(r, 7101)
})

test('request 2 after a failed review waits for 64 minutes after request 1', () => {
  const r = run(setup({ requests: [comment(20)], runs: [ci, bot({ id: 7102, min: 10, title: 'Review failed' })] }))
  assert.equal(r.code, 0, r.out)
  const w = waits(r)
  assert.ok(w.length === 1 && w[0] >= 2630 && w[0] <= 2640, r.out)
  assert.deepEqual(posts(r), [POSTED])
  assert.equal(r.last, 'REVIEWED #7 run 5151')
})

test('no run in the 45 minutes after request 1, read in a later call, gives request 2 after a wait', () => {
  const r = run(setup({ requests: [comment(50)] }))
  assert.equal(r.code, 0, r.out)
  const w = waits(r)
  assert.ok(w.length === 1 && w[0] >= 830 && w[0] <= 840, r.out)
  assert.deepEqual(posts(r), [POSTED])
  assert.equal(r.last, 'REVIEWED #7 run 5151')
})

test('no request and no run in the same call gives two requests and ends NO REVIEW', () => {
  const r = run(setup({ swap: false }))
  noReview(r)
  assert.deepEqual(posts(r), [POSTED, POSTED])
  const first = r.log.indexOf(POSTED)
  const second = r.log.lastIndexOf(POSTED)
  assert.ok(second > first)
  assert.equal(waits(r).length, 1)
  assert.ok(r.lines.some((l) => l.startsWith('WAIT')))
})

test('a skipped run older than the request is never the answer', () => {
  const skipped = bot({ id: 6060, min: 30, conclusion: 'skipped', title: 'Review skipped' })
  const r = run(setup({ requests: [comment(20)], seq: [[ci, skipped], [ci, skipped, bot({ id: 6161, min: 5 })]], post: false }))
  assert.equal(r.code, 0, r.out)
  reviewed(r, 6161)
  assert.equal(posts(r).length, 0)
  assert.ok(!r.lines.some((l) => l.includes('6060')))
})

test('a run that did not complete inside 45 minutes of the request ends NO REVIEW with no request 2', () => {
  const r = run(setup({ requests: [comment(50)], runs: [ci, bot({ id: 8001, min: 40, status: 'in_progress', conclusion: null })], post: false }))
  noReview(r, /^NO REVIEW #7: .*8001/)
  assert.equal(posts(r).length, 0)
})

test('two requests and no run after the newer one end NO REVIEW', () => {
  const r = run(setup({ requests: [comment(90), comment(50)], post: false }))
  noReview(r)
  assert.equal(posts(r).length, 0)
})

test('a failed read of the comments ends NO REVIEW naming the read', () => {
  const s = setup()
  put(s.fx, `${PRC}.GET.error`, 'HTTP 500')
  const r = run(s)
  noReview(r, /^NO REVIEW #7: .*comments/)
  assert.equal(posts(r).length, 0)
})

test('a failed read of the check runs ends NO REVIEW', () => {
  const s = setup()
  put(s.fx, `${CHECKS}.GET.error`, 'HTTP 500')
  const r = run(s)
  noReview(r, /^NO REVIEW #7: .*check runs/)
})

test('the script uses no date, stat, sed or readlink form that differs between Linux and macOS', () => {
  const src = readFileSync(join(root, 'scripts/request-review.sh'), 'utf8')
  assert.doesNotMatch(src, /date +-(d|j|v)|date +--date|gdate|stat +-[cf]|sed +-i|readlink +-f/)
})

test('the rules come from review-request.jq and are not copied', () => {
  const src = readFileSync(join(root, 'scripts/request-review.sh'), 'utf8')
  assert.match(src, /review-request/)
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.doesNotMatch(code, /full review|Review completed|Finished|check_suites[^|]*min/)
})

const withEditedJq = (edit) => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-scripts-'))
  cpSync(join(root, 'scripts'), dir, { recursive: true })
  const f = join(dir, 'review-request.jq')
  const before = readFileSync(f, 'utf8')
  const after = edit(before)
  assert.notEqual(before, after)
  writeFileSync(f, after)
  return dir
}

test('a changed request text in review-request.jq changes the posted request', () => {
  const scripts = withEditedJq((t) => t.replace('def requestText: "@coderabbitai full review";', 'def requestText: "@coderabbitai full review now";'))
  const r = run(setup(), { scripts })
  assert.ok(r.log.includes(`${POSTED} now`), r.log.join('\n'))
})

test('a changed completed-review rule in review-request.jq changes which run is the answer', () => {
  const scripts = withEditedJq((t) => t.replace('Result: Success - Review completed', 'Result: Success - Done'))
  const r = run(setup({ requests: [comment(10)], seq: seq3(5), post: false }), { scripts })
  assert.ok(!r.lines.some((l) => l.startsWith('REVIEWED #7 run 4242')), r.out)
})

const failedRun = () => bot({ conclusion: 'success', title: 'Review failed', summary: '' })
const asSequence = (fx, file, first, second) => {
  rmSync(join(fx, `${file}.json`), { force: true })
  put(fx, `${file}.call1.json`, first)
  put(fx, `${file}.call2.json`, second)
}

test('a request made by hand while the script waited is counted: no third request', () => {
  const s = setup({ runs: [ci, failedRun()], swap: false })
  asSequence(s.fx, PRC, [], [comment(0.5), { ...comment(0.33), id: 77 }])
  const r = run(s)
  assert.ok(posts(r).length <= 1, r.log.join('\n'))
  noReview(r)
})

test('a request on another PR made while the script waited moves the WAIT', () => {
  const s = setup({ runs: [ci, failedRun()], swap: false })
  put(s.fx, `${PRC}.POST.json`, { id: 9000, user: { login: 'alfhen' }, body: REQ, created_at: iso(30) })
  asSequence(s.fx, REPOC, [], [{ id: 88, user: { login: 'alfhen' }, body: REQ, issue_url: 'https://api.github.com/repos/o/r/issues/8', created_at: isoSec(10) }])
  const r = run(s)
  const w = waits(r)
  assert.ok(w.length >= 1, r.out)
  for (const n of w) assert.ok(n >= 3820 && n <= 3840, String(n))
})

const pullSeq = (s, heads) => {
  rmSync(join(s.fx, `${P}__pulls__7.json`), { force: true })
  heads.forEach((h, i) => put(s.fx, `${P}__pulls__7.call${i + 1}.json`, { merged: false, mergeable: true, head: { sha: h, ref: 'feat/x' } }))
}

test('a push during the wait before request 1 gives no request for the old head', () => {
  const s = setup({ repoComments: [{ ...comment(10), id: 4001 }] })
  pullSeq(s, [S, B])
  const r = run(s)
  noReview(r, /^NO REVIEW #7: .*bbbbbbb/)
  assert.equal(waits(r).length, 1, r.out)
  assert.ok(r.log.filter((l) => l === 'GET /repos/o/r/pulls/7').length >= 2, r.log.join('\n'))
  assert.equal(posts(r).length, 0)
})

test('the same fixture with the head unchanged posts the request once', () => {
  const s = setup({ repoComments: [{ ...comment(10), id: 4001 }] })
  pullSeq(s, [S, S])
  const r = run(s)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(posts(r), [POSTED])
})

test('a run of the bot with no started_at is not read as the answer and the script reads again', () => {
  const queued = bot({ id: 4242, status: 'queued', conclusion: null })
  queued.started_at = null
  const seq = seq3(5)
  seq[0] = [ci, queued]
  const r = run(setup({ requests: [comment(10)], seq, post: false }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.lines.some((l) => l.startsWith('REVIEWED #7 run 4242')), r.out)
  assert.ok(!r.lines.some((l) => l.startsWith('NO REVIEW')), r.out)
  assert.equal(posts(r).length, 0)
})
