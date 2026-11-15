// Runs scripts/bot-approval.jq on fixture input, and merge-pr.sh against test/fake-gh for the older-approval case.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const JQ = join(root, 'scripts/bot-approval.jq')
const BOT = 'gitar-bot[bot]'
const DEFAULT_BOTS = 'coderabbitai[bot],gitar-bot[bot]'
const HEAD = 'h'.repeat(40)
const OLD = 'o'.repeat(40)
const review = (state, commit, login = BOT) => ({ id: 1, user: { login }, state, body: 'x', commit_id: commit, submitted_at: '2026-01-01T00:00:00Z' })
const check = (conclusion, name = 'Gitar', status = 'completed', slug = 'gitar-bot') => ({ name, status, conclusion, app: { slug } })
const gate = (reviews, checks) => {
  const r = spawnSync('jq', ['-c', '-f', JQ], { input: JSON.stringify({ reviews, comments: [], checks, head: HEAD, bots: DEFAULT_BOTS.split(","), user: 'alfhen' }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('an approval on an older commit with no check run does not clear', () => {
  const reviews = [review('APPROVED', OLD)]
  assert.notEqual(reviews[0].commit_id, HEAD)
  assert.deepEqual(gate(reviews, []), [])
})

test('an approval on an older commit with a neutral check does not clear', () => {
  assert.deepEqual(gate([review('APPROVED', OLD)], [check('neutral')]), [])
})

test('an approval on an older commit with a check still running does not clear', () => {
  assert.deepEqual(gate([review('APPROVED', OLD)], [check(null, 'Gitar', 'in_progress')]), [])
})

test('an approval on an older commit with a successful check of another bot does not clear', () => {
  assert.deepEqual(gate([review('APPROVED', OLD)], [check('success', 'CodeRabbit', 'completed', 'coderabbitai')]), [])
})

test('an approval on an older commit with a successful check on the head clears as approved earlier', () => {
  assert.deepEqual(gate([review('APPROVED', OLD)], [check('success')]), [`${BOT} (approved earlier)`])
})

test('an approval on the head clears with no check, as a bare login', () => {
  assert.deepEqual(gate([review('APPROVED', HEAD)], []), [BOT])
})

test('a changes request with no later approval still blocks', () => {
  assert.deepEqual(gate([review('CHANGES_REQUESTED', HEAD)], [check('success')]), [])
})

test('bot-status.sh strips every suffix that bot-approval.jq can print', () => {
  const jq = readFileSync(JQ, 'utf8')
  const words = [...jq.matchAll(/" \(([a-z ]+)\)"/g)].map((m) => m[1])
  assert.deepEqual([...words].sort(), ['answered', 'approved earlier'])
  const sh = readFileSync(join(root, 'scripts/bot-status.sh'), 'utf8')
  const sub = sh.match(/sub\("([^"]+)"; ""\)/)[1]
  const re = new RegExp(sub.replace(/\\\\/g, '\\'))
  for (const w of words) assert.equal(`${BOT} (${w})`.replace(re, ''), BOT, w)
})

const P = 'repos__o__r'
const PULL = `${P}__pulls__7`
const KEYS = ['head', 'approvedBy', 'seenHead', 'pending', 'openThreads', 'reviewBodies']
const rv = (state, commit, login = BOT, id = 1) => ({ ...review(state, commit, login), id })
const thread = (id, login = BOT) => ({ id, in_reply_to_id: null, user: { login }, pull_request_review_id: 1 })
const reply = (to, login = 'alfhen', id = 900 + to) => ({ id, in_reply_to_id: to, user: { login } })

// Fixture F: pull 7 mergeable at HEAD, the ci check run, no statuses, user alfhen, empty comments and suites.
const setup = ({ reviews = [], comments = [], checks = [], suites = null, extra = {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-approval-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const put = (name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))
  const pull = { merged: false, mergeable: true, head: { sha: HEAD, ref: 'feat/x', repo: { full_name: 'o/r' } } }
  put(`${P}.json`, { default_branch: 'main' })
  put(`${PULL}.json`, pull)
  put('pull-merged.json', { ...pull, merged: true })
  put(`${PULL}__merge.PUT.then`, `pull-merged.json ${PULL}.json\n`)
  put(`${PULL}__merge.PUT.json`, { merged: true })
  put(`${P}__commits__${HEAD}__check-runs.json`, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }, ...checks] })
  put(`${P}__commits__${HEAD}__status.json`, { state: 'success', statuses: [] })
  put('user.json', { login: 'alfhen' })
  put(`${PULL}__reviews.json`, reviews)
  put(`${PULL}__comments.json`, comments)
  put(`${P}__issues__7__comments.json`, [])
  if (suites) suites.forEach((x, i) => put(`${P}__commits__${HEAD}__check-suites.${i + 1}.json`, x))
  else put(`${P}__commits__${HEAD}__check-suites.json`, { total_count: 0, check_suites: [] })
  for (const [name, v] of Object.entries(extra)) put(name, v)
  return { dir, bin, fx, log: join(dir, 'log') }
}
const exec = (s, script, args, env = {}) => {
  const e = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, PIPELINE_TEST_FAST: '1', ...env }
  delete e.CLAUDECODE
  if (env.BOT_LOGINS === undefined) delete e.BOT_LOGINS
  const r = spawnSync('bash', [join(root, 'scripts', script), ...args], { env: e, encoding: 'utf8' })
  const log = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout, stderr: r.stderr, log }
}
const merge = (s, env) => exec(s, 'merge-pr.sh', ['--person', 'o/r', '7', HEAD, 'feat/x'], env)
const status = (s, env) => exec(s, 'bot-status.sh', ['o/r', '7'], env)
const puts = (r) => r.log.filter((l) => /^PUT .*\/pulls\/7\/merge/.test(l))
const merged = (r, approved) => {
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes(`approved=[${approved}]`), r.out)
  assert.equal(puts(r).length, 1)
}
const refused = (r, approved = '') => {
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`approved=[${approved}]`), r.out)
  assert.match(r.out, /PR 7 NOT merged/)
  assert.equal(puts(r).length, 0)
}
const older = [rv('APPROVED', OLD)]
const botRun = { name: 'Code Review', status: 'completed', conclusion: 'success', app: { slug: 'gitar-bot' } }

test('merge-pr.sh does not merge an older approval with no check on the head', () => {
  refused(merge(setup({ reviews: older })))
})

test('merge-pr.sh finds the check run of a bot by its App, whatever its name', () => {
  merged(merge(setup({ reviews: older, checks: [botRun] })), `${BOT} (approved earlier)`)
  refused(merge(setup({ reviews: older, checks: [{ ...botRun, name: 'gitar', app: { slug: 'github-actions' } }] })))
  refused(merge(setup({ reviews: older, checks: [{ ...botRun, name: 'Gitar', app: { slug: 'gitar' } }] })))
})

test('a check run with no App counts for nothing in merge-pr.sh and bot-status.sh', () => {
  const bare = { name: 'Gitar', status: 'completed', conclusion: 'success' }
  refused(merge(setup({ reviews: older, checks: [bare] })))
  merged(merge(setup({ reviews: older, checks: [{ ...bare, app: { slug: 'gitar-bot' } }] })), `${BOT} (approved earlier)`)
  const none = JSON.parse(status(setup({ reviews: older, checks: [bare] })).stdout)
  assert.deepEqual([none.approvedBy, none.seenHead], [[], []])
  const some = JSON.parse(status(setup({ reviews: older, checks: [{ ...bare, app: { slug: 'gitar-bot' } }] })).stdout)
  assert.deepEqual([some.approvedBy, some.seenHead], [[`${BOT} (approved earlier)`], [BOT]])
  const running = { name: 'CodeRabbit', status: 'in_progress', conclusion: null }
  assert.deepEqual(JSON.parse(status(setup({ checks: [running] })).stdout).pending, [])
  assert.deepEqual(JSON.parse(status(setup({ checks: [{ ...running, app: { slug: 'coderabbitai' } }] })).stdout).pending, ['CodeRabbit'])
  const other = { name: 'ci-gitar', status: 'in_progress', app: { slug: 'github-actions' } }
  assert.deepEqual(JSON.parse(status(setup({ checks: [other] })).stdout).pending, [])
})

test('a commit status never clears a bot', () => {
  const s = setup({ reviews: older })
  writeFileSync(join(s.fx, `${P}__commits__${HEAD}__status.json`), JSON.stringify({ state: 'success', statuses: [{ context: 'Gitar', state: 'success' }] }))
  refused(merge(s))
})

test('BOT_LOGINS is a list of exact logins with one default in each script', () => {
  for (const f of ['merge-pr.sh', 'bot-status.sh']) {
    const text = readFileSync(join(root, 'scripts', f), 'utf8')
    assert.ok(text.includes(DEFAULT_BOTS), f)
    assert.equal(text.includes('coderabbit|gitar'), false, f)
  }
  for (const login of ['dependabot[bot]', 'gitar-fan']) refused(merge(setup({ reviews: [rv('APPROVED', HEAD, login)] })))
  for (const login of ['coderabbitai[bot]', BOT]) merged(merge(setup({ reviews: [rv('APPROVED', HEAD, login)] })), login)
  merged(merge(setup({ reviews: [rv('APPROVED', HEAD, 'my-reviewer[bot]')] }), { BOT_LOGINS: 'my-reviewer[bot]' }), 'my-reviewer[bot]')
  refused(merge(setup({ reviews: [rv('APPROVED', HEAD)] }), { BOT_LOGINS: 'my-reviewer[bot]' }))
  const open = (login) => JSON.parse(status(setup({ comments: [thread(4, login)] })).stdout).openThreads
  assert.deepEqual([open('dependabot[bot]'), open('gitar-fan'), open(BOT)], [0, 0, 1])
})

test('the default bot lists of merge-pr.sh, bot-status.sh and the BOTS text of run-wave.js are equal', () => {
  const fromScript = (f) => readFileSync(join(root, 'scripts', f), 'utf8').match(/BOT_LOGINS:-([^}]+)\}/)[1]
  const wave = readFileSync(join(root, 'workflows/run-wave.js'), 'utf8').split('\n').find((l) => l.startsWith('const BOTS = A.bots || '))
  const inWave = [...wave.matchAll(/"([^"]+\[bot\])"/g)].map((m) => m[1]).join(',')
  assert.equal(fromScript('merge-pr.sh'), DEFAULT_BOTS)
  assert.equal(fromScript('bot-status.sh'), fromScript('merge-pr.sh'))
  assert.equal(inWave, fromScript('merge-pr.sh'))
})

test('a BOT_LOGINS item that is not a login stops both scripts before any merge call', () => {
  for (const bots of ['coderabbit|gitar|\\[bot\\]', 'gitar.*', 'gitar-bot[bot],bad login']) {
    const r = merge(setup({ reviews: [rv('APPROVED', HEAD)] }), { BOT_LOGINS: bots })
    assert.notEqual(r.code, 0, bots)
    assert.match(r.out, /BOT_LOGINS must be a comma-separated list of logins.*\[bot\]/)
    assert.equal(puts(r).length, 0)
    const t = status(setup(), { BOT_LOGINS: bots })
    assert.notEqual(t.code, 0, bots)
    assert.match(t.out, /BOT_LOGINS/)
    assert.equal(t.stdout, '')
  }
  merged(merge(setup({ reviews: [rv('APPROVED', HEAD)] }), { BOT_LOGINS: 'gitar-bot[bot],my-reviewer' }), BOT)
})

test('a bot thread is answered only by a reply of the bot or of the user', () => {
  const fx = (r) => setup({ reviews: [rv('COMMENTED', OLD)], checks: [check('success')], comments: [thread(4), r] })
  for (const login of ['alfhen', BOT]) {
    merged(merge(fx(reply(4, login))), `${BOT} (answered)`)
    assert.equal(JSON.parse(status(fx(reply(4, login))).stdout).openThreads, 0, login)
  }
  for (const login of ['stranger', 'coderabbitai[bot]']) {
    refused(merge(fx(reply(4, login))))
    assert.equal(JSON.parse(status(fx(reply(4, login))).stdout).openThreads, 1, login)
  }
})

test('with no user in the input only a reply of the thread bot answers', () => {
  const run = (login) => {
    const input = { reviews: [rv('COMMENTED', OLD)], comments: [thread(4), reply(4, login)], checks: [check('success')], head: HEAD, bots: DEFAULT_BOTS.split(",") }
    const r = spawnSync('jq', ['-c', '-f', JQ], { input: JSON.stringify(input), encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  assert.deepEqual(run('alfhen'), [])
  assert.deepEqual(run(BOT), [`${BOT} (answered)`])
})

test('a failed read stops merge-pr.sh with cannot read and no merge call', () => {
  const reads = ['user', `${PULL}__reviews`, `${PULL}__comments`, `${P}__issues__7__comments`, `${P}__commits__${HEAD}__check-suites`]
  for (const name of reads) {
    const s = setup({ reviews: [rv('APPROVED', HEAD)], extra: { [`${name}.GET.error`]: 'fake-gh: server error (HTTP 500)' } })
    const r = merge(s)
    assert.notEqual(r.code, 0, name)
    assert.match(r.stdout, /^PR 7 NOT merged: cannot read/m, name)
    assert.equal(puts(r).length, 0, name)
  }
  const s = setup({ reviews: [rv('COMMENTED', OLD)], checks: [check('success')], comments: [thread(4)], extra: { [`${PULL}__comments.GET.error`]: 'fake-gh: server error (HTTP 500)' } })
  const r = merge(s)
  assert.notEqual(r.code, 0)
  assert.match(r.stdout, /^PR 7 NOT merged: cannot read/m)
  assert.equal(puts(r).length, 0)
})

test('merge-pr.sh reads each source as its own call, after the gate block, and reads the check runs once', () => {
  const text = readFileSync(join(root, 'scripts/merge-pr.sh'), 'utf8')
  assert.equal(text.includes('<(gh api'), false)
  assert.equal(/gh api[^|]*\| *jq/.test(text), false)
  assert.ok(text.indexOf('gh api user') > text.indexOf('gate-files.sh'))
  const r = merge(setup({ reviews: [rv('APPROVED', HEAD)] }))
  merged(r, BOT)
  const once = (re) => assert.equal(r.log.filter((l) => re.test(l)).length, 1, String(re))
  once(/^GET \/user$/)
  once(/^GET \/repos\/o\/r\/pulls\/7\/reviews/)
  once(/^GET \/repos\/o\/r\/pulls\/7\/comments/)
  once(/^GET \/repos\/o\/r\/issues\/7\/comments/)
  once(new RegExp(`^GET /repos/o/r/commits/${HEAD}/check-suites`))
  once(new RegExp(`^GET /repos/o/r/commits/${HEAD}/check-runs`))
  assert.ok(r.log.filter((l) => l === 'GET /repos/o/r/pulls/7').length <= 3)
  const refusedRun = merge(setup())
  refused(refusedRun)
  assert.ok(refusedRun.log.filter((l) => l === 'GET /repos/o/r/pulls/7').length <= 1)
})

test('a PR held by the gate stops before the new reads', () => {
  const s = setup({ reviews: [rv('APPROVED', HEAD)] })
  writeFileSync(join(s.fx, `${PULL}__files.1.json`), JSON.stringify([{ filename: 'scripts/merge-pr.sh' }]))
  writeFileSync(join(s.fx, `${P}__contents__.github__pipeline.json.json`), JSON.stringify({ gates: ['scripts/'] }))
  const r = exec(s, 'merge-pr.sh', ['--auto', 'o/r', '7', HEAD, 'feat/x'])
  assert.equal(r.code, 7)
  assert.match(r.stdout, /the gate holds it/)
  assert.doesNotMatch(r.log.join('\n'), /GET \/user|check-suites|issues\/7\/comments/)
})

test('the three ways of today still clear and block as before', () => {
  const bot = [check('success')]
  merged(merge(setup({ reviews: [rv('APPROVED', HEAD)] })), BOT)
  merged(merge(setup({ reviews: older, checks: bot })), `${BOT} (approved earlier)`)
  merged(merge(setup({ reviews: [rv('COMMENTED', OLD)], checks: bot, comments: [thread(4), reply(4)] })), `${BOT} (answered)`)
  refused(merge(setup({ reviews: [rv('CHANGES_REQUESTED', HEAD)], checks: bot })))
  refused(merge(setup({ reviews: older, checks: [check('neutral')] })))
  refused(merge(setup({ reviews: older, checks: [check(null, 'Gitar', 'in_progress')] })))
  refused(merge(setup({ reviews: [rv('COMMENTED', HEAD)], checks: bot, comments: [thread(4), reply(4)] })))
  refused(merge(setup({ reviews: [rv('APPROVED', HEAD, 'alfhen')] })))
})

test('bot-status.sh reads the check suites on all pages as one call and keeps six keys', () => {
  const page = { total_count: 1, check_suites: [{ id: 1 }] }
  const r = status(setup({ suites: [page, page] }))
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)), KEYS)
  assert.equal(r.log.filter((l) => l.startsWith(`GET /repos/o/r/commits/${HEAD}/check-suites`)).length, 1)
  assert.equal(readFileSync(join(root, 'scripts/bot-status.sh'), 'utf8').includes('<(gh api'), false)
})

test('a failed check suites read stops bot-status.sh with exit 1', () => {
  const r = status(setup({ extra: { [`${P}__commits__${HEAD}__check-suites.GET.error`]: 'fake-gh: server error (HTTP 500)' } }))
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^bot-status: cannot read/m)
  assert.equal(r.stdout, '')
  assert.equal(status(setup()).code, 0)
})
