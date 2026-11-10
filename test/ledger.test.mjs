// Runs scripts/ledger.sh against test/fake-gh in a temp folder outside ~/.claude*. Each test name starts with its eval id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, cpSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const LEDGER = join(root, 'scripts/ledger.sh')
const TOKEN_REPORT = join(root, 'scripts/token-report.sh')
const ISSUE = 7
const fname = p => p.replace(/^\//, '').replaceAll('/', '__')

// world: { issue: false | undefined, comments: [...] | [[page1], [page2]] (pages), pulls: [...], facts: { n: { mode, threads } }, commits: { tag: date } }
function setup(world = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const fx = join(dir, 'fx')
  cpSync(join(root, 'test/fixtures/ledger/base'), fx, { recursive: true })
  const put = (path, v) => writeFileSync(join(fx, `${fname(path)}.json`), JSON.stringify(v))
  put('repos/o/r/issues', world.issue === false ? [] : [{ number: ISSUE, state: 'open', user: { login: 'alfhen' }, labels: [{ name: 'pipeline-ledger' }] }])
  if (world.comments && Array.isArray(world.comments[0]) ) {
    world.comments.forEach((page, i) => writeFileSync(join(fx, `${fname(`repos/o/r/issues/${ISSUE}/comments`)}.${i + 1}.json`), JSON.stringify(page)))
  } else {
    put(`repos/o/r/issues/${ISSUE}/comments`, world.comments ?? [])
  }
  writeFileSync(join(fx, `${fname(`repos/o/r/issues/${ISSUE}/comments`)}.POST.json`), JSON.stringify({ id: 900 }))
  put('repos/o/r/pulls', world.pulls ?? [])
  for (const [n, f] of Object.entries(world.facts ?? {})) {
    put(`repos/o/r/issues/${n}/comments`, f.mode ? [comment(5000 + Number(n), `<!-- pipeline:merge-cleared ${f.mode} abc123 -->`)] : [])
    put(`repos/o/r/pulls/${n}/comments`, Array.from({ length: f.threads ?? 0 }, (_, i) => ({ id: i, in_reply_to_id: null, user: { login: 'gitar[bot]', type: 'Bot' } })))
  }
  for (const [tag, date] of Object.entries(world.commits ?? {})) put(`repos/o/r/commits/${tag}`, { commit: { committer: { date } } })
  return { dir, bin, fx, log: join(dir, 'log'), put }
}

function run(s, ...args) {
  rmSync(s.log, { force: true })
  const r = spawnSync('bash', [LEDGER, 'o/r', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log },
  })
  const calls = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  return { ...r, calls, writes: calls.filter(c => /^(POST|DELETE|PUT|PATCH) /.test(c)) }
}

const comment = (id, body, login = 'alfhen') => ({ id, user: { login }, body })
const header = (run, id) => `<!-- pipeline:ledger v1 ${run} ${id} -->`
const rec = (id, run, prId, o = {}) => comment(id, `${header(run, prId)}\n\`\`\`json\n${JSON.stringify({
  v: 1, repo: 'o/r', run, kind: 'wave', pr: { id: prId, number: null }, ready: true, reason: null, rounds: 1, codeChangedByBots: false, evalMisses: [], tokens: null, ...o,
})}\n\`\`\``, o.login ?? 'alfhen')
const tok = (weighted, noCacheRead = weighted) => ({ source: 'transcripts', comparable: true, byRole: {}, raw: weighted, noCacheRead, weighted, agents: 1, wallMinutes: 1 })
const mergedPr = (number, at, body = '') => ({ number, merged_at: at, body })

const tmp = (s, name, v) => { const f = join(s.dir, name); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); return f }
const wave = {
  summary: 's', agentCount: 4, totalTokens: 9000, logs: [],
  result: {
    prs: [
      { id: 'L1', ready: true, prNumber: 42, codeChangedByBots: true,
        history: [{ round: 1, evals: { passed: ['L1-1'], failed: ['L1-2'], ci: [] } }, { round: 2, evals: { passed: ['L1-1', 'L1-2'], failed: [], ci: [] } }, { round: 'docs1' }, { round: 'minor1' }],
        minorPass: { ran: true, kept: false, why: 'tests failed: lint' } },
      { id: 'L2', ready: false, reason: 'needs human: scope', history: [{ round: 1 }] },
    ],
  },
}
const records = r => r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))

test('L01-2 a PR that stalls with no PR number gets a record with its reason', () => {
  const s = setup()
  const r = run(s, 'put', tmp(s, 'out.json', wave), '--run', 'wf_1')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.writes.length, 2)
  const stalled = r.writes.find(w => w.includes('wf_1 L2 -->'))
  assert.ok(stalled, r.writes.join('\n'))
  assert.match(stalled, /"number":null/)
  assert.match(stalled, /"reason":"needs human: scope"/)
  assert.match(stalled, /^POST \/repos\/o\/r\/issues\/7\/comments body=<!-- pipeline:ledger v1 wf_1 L2 -->\\n```json\\n/)
})

test('L01-4 a local record has tokens by role and the weighted figure, and a cloud record has totals with comparable false', () => {
  const s = setup()
  const folder = join(s.dir, 'tr'); mkdirSync(folder)
  const line = (id, u) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] } } })
  writeFileSync(join(folder, 'agent-1.jsonl'), line('m1', [10, 20, 400, 5]) + '\n')
  writeFileSync(join(folder, 'agent-1.meta.json'), JSON.stringify({ agentType: 'agent-pr-pipeline:implementer', description: 'implement:L1#1' }))
  const out = tmp(s, 'out.json', wave)
  const tokens = join(s.dir, 'tokens.json')
  assert.equal(spawnSync('bash', [TOKEN_REPORT, out, folder, '--json', tokens], { encoding: 'utf8' }).status, 0)
  const local = records(run(s, 'put', out, '--run', 'wf_1', '--tokens', tokens, '--dry-run'))
  const l1 = local.find(x => x.pr.id === 'L1'), l2 = local.find(x => x.pr.id === 'L2')
  assert.equal(l1.tokens.comparable, true)
  assert.deepEqual(l1.tokens.byRole.implementer, { input: 10, cacheWrite: 20, cacheRead: 400, output: 5 })
  assert.equal(l1.tokens.weighted, Math.round(10 + 40 + 25 + 25))
  assert.equal(l2.tokens, null)
  const cloud = records(run(s, 'put', out, '--run', 'run-9', '--cloud', '--dry-run'))
  assert.ok(cloud.length === 2 && cloud.every(c => c.tokens.comparable === false && c.tokens.source === 'cloud' && c.tokens.raw === null && c.tokens.agents === null && c.tokens.waveTotal === 9000 && c.tokens.waveAgents === 4 && c.tokens.byRole === null))
  assert.equal(run(s, 'put', out, '--run', 'x', '--cloud', '--tokens', tokens).status, 64)
})

test('L01-13 raw includes cache reads and noCacheRead does not, from token-report --json through put', () => {
  const s = setup()
  const folder = join(s.dir, 'tr'); mkdirSync(folder)
  const lines = [{ id: 'm1', u: [10, 20, 400, 5] }, { id: 'm2', u: [1, 2, 30, 4] }].map(x => JSON.stringify({ type: 'assistant', message: { id: x.id, usage: { input_tokens: x.u[0], cache_creation_input_tokens: x.u[1], cache_read_input_tokens: x.u[2], output_tokens: x.u[3] } } }))
  writeFileSync(join(folder, 'agent-1.jsonl'), lines.join('\n') + '\n')
  writeFileSync(join(folder, 'agent-1.meta.json'), JSON.stringify({ agentType: 'agent-pr-pipeline:implementer', description: 'implement:L1#1' }))
  const out = tmp(s, 'out.json', wave)
  const tokens = join(s.dir, 'tokens.json')
  assert.equal(spawnSync('bash', [TOKEN_REPORT, out, folder, '--json', tokens], { encoding: 'utf8' }).status, 0)
  const l1 = records(run(s, 'put', out, '--run', 'wf_1', '--tokens', tokens, '--dry-run')).find(x => x.pr.id === 'L1')
  assert.equal(l1.tokens.raw, 10 + 20 + 400 + 5 + 1 + 2 + 30 + 4)
  assert.equal(l1.tokens.noCacheRead, 10 + 20 + 5 + 1 + 2 + 4)
})

test('L01-6 the record says whether the minor pass was kept and what it cost', () => {
  const s = setup()
  const out = tmp(s, 'out.json', wave)
  const tokens = tmp(s, 'tokens.json', { comparable: true, totals: { totalTokens: 1, agentCount: 1 }, prs: [{ id: 'L1', ...tok(500), minorPass: { agents: 3, weighted: 120 } }] })
  const l1 = records(run(s, 'put', out, '--run', 'wf_1', '--tokens', tokens, '--dry-run')).find(x => x.pr.id === 'L1')
  assert.deepEqual(l1.minorPass, { ran: true, kept: false, why: 'tests failed: lint', weighted: 120 })
  assert.equal(l1.rounds, 2)
  assert.deepEqual(l1.evals, { count: 2, passed: { 1: ['L1-1'], 2: ['L1-1', 'L1-2'] }, failed: { 1: ['L1-2'] }, ci: {} })
  assert.equal(l1.codeChangedByBots, true)
  assert.equal(l1.pr.number, 42)
  const l2 = records(run(s, 'put', out, '--run', 'wf_1', '--dry-run')).find(x => x.pr.id === 'L2')
  assert.equal(l2.minorPass.ran, false)
})

test('L01-7 with no ledger issue put exits 65 and posts nothing, and a failed call exits 3', () => {
  const s = setup({ issue: false })
  const r = run(s, 'put', tmp(s, 'out.json', wave), '--run', 'wf_1')
  assert.equal(r.status, 65)
  assert.deepEqual(r.writes, [])
  assert.ok(r.calls.length > 0)
  const t = setup()
  writeFileSync(join(t.fx, `${fname(`repos/o/r/issues/${ISSUE}/comments`)}.POST.error`), 'HTTP 500')
  assert.equal(run(t, 'put', tmp(t, 'out.json', wave), '--run', 'wf_1').status, 3)
  const u = setup()
  writeFileSync(join(u.fx, 'user.GET.error'), 'HTTP 502')
  assert.equal(run(u, 'put', tmp(u, 'out.json', wave), '--run', 'wf_1').status, 3)
})

test('L01-7 a failed read of the ledger comments or the pull list exits 3 and writes nothing', () => {
  const cpath = fname(`repos/o/r/issues/${ISSUE}/comments`)
  const failed = (file, args) => {
    const s = setup({ pulls: [mergedPr(41, '2026-10-01T00:00:00Z')], facts: { 41: {} } })
    writeFileSync(join(s.fx, file), 'HTTP 502')
    const a = args(s)
    const r = run(s, ...a)
    assert.equal(r.status, 3, `${a[0]}: ${r.stderr}`)
    assert.deepEqual(r.writes, [])
  }
  failed(`${cpath}.GET.error`, s => ['put', tmp(s, 'out.json', wave), '--run', 'wf_1'])
  failed(`${cpath}.GET.error`, () => ['backfill'])
  failed(`${fname('repos/o/r/pulls')}.GET.error`, () => ['backfill'])
})

test('L01-7 init makes the issue only when there is none', () => {
  const s = setup({ issue: false })
  writeFileSync(join(s.fx, 'repos__o__r__issues.POST.json'), JSON.stringify({ number: 11 }))
  const r = run(s, 'init')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '11')
  assert.match(r.writes[0], /^POST \/repos\/o\/r\/issues title=Pipeline ledger labels\[\]=pipeline-ledger/)
  const t = setup()
  const q = run(t, 'init')
  assert.equal(q.stdout.trim(), String(ISSUE))
  assert.deepEqual(q.writes, [])
})

test('a second put for the same run and PR writes nothing', () => {
  const s = setup({ comments: [rec(10, 'wf_1', 'L1'), rec(11, 'wf_1', 'L2')] })
  const r = run(s, 'put', tmp(s, 'out.json', wave), '--run', 'wf_1')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.writes, [])
  const t = setup({ comments: [rec(10, 'wf_1', 'L1')] })
  assert.equal(run(t, 'put', tmp(t, 'out.json', wave), '--run', 'wf_2').writes.length, 2)
})

test('L01-3 list reads two pages, prints each record once and leaves out a record by another login', () => {
  const s = setup({
    comments: [
      [rec(10, 'wf_1', 'L1', { rounds: 1 }), rec(11, 'wf_1', 'L2'), comment(12, 'a plain comment')],
      [rec(20, 'wf_2', 'L1'), rec(21, 'wf_3', 'L9', { login: 'mallory' }), rec(22, 'wf_1', 'L1', { rounds: 9 })],
    ],
  })
  const out = records(run(s, 'list'))
  assert.deepEqual(out.map(x => [x.run, x.pr.id, x.commentId]), [['wf_1', 'L1', 10], ['wf_1', 'L2', 11], ['wf_2', 'L1', 20]])
  assert.equal(out[0].rounds, 1)
  assert.ok(!out.some(x => x.run === 'wf_3'))
})

const FOOTER = '\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_'
const withFooter = c => ({ ...c, body: c.body + FOOTER })

test('L01-3 a record with the cloud session footer is listed, counted by report, and seen by put', () => {
  const s = setup({ comments: [[withFooter(rec(10, 'wf_1', 'L1', { rounds: 2 }))]] })
  const out = records(run(s, 'list'))
  assert.deepEqual(out.map(x => [x.run, x.pr.id, x.rounds]), [['wf_1', 'L1', 2]])
  const p = run(s, 'put', tmp(s, 'out.json', { result: { prs: [wave.result.prs[0]] } }), '--run', 'wf_1')
  assert.equal(p.status, 0, p.stderr)
  assert.deepEqual(p.writes, [])
})

test('L01-11 two puts that both post leave one record: the later comment is deleted', () => {
  const s = setup()
  const path = `repos/o/r/issues/${ISSUE}/comments`
  writeFileSync(join(s.fx, `${fname(path)}.after.json`), JSON.stringify([rec(150, 'wf_1', 'L1'), rec(900, 'wf_1', 'L1'), rec(151, 'wf_1', 'L2')]))
  writeFileSync(join(s.fx, `${fname(path)}.POST.then`), `${fname(path)}.after.json ${fname(path)}.json\n`)
  const r = run(s, 'put', tmp(s, 'out.json', { result: { prs: [wave.result.prs[0]] } }), '--run', 'wf_1')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.writes.includes(`DELETE /repos/o/r/issues/comments/900`), r.writes.join('\n'))
  assert.ok(!r.writes.some(w => w.startsWith('DELETE') && !w.endsWith('/900')))
})

test('L01-11 a refused delete is logged, put exits 0, and the readers count the PR once', () => {
  const s = setup()
  const path = `repos/o/r/issues/${ISSUE}/comments`
  const after = [rec(150, 'wf_1', 'L1', { tokens: tok(100) }), rec(900, 'wf_1', 'L1', { tokens: tok(100) })]
  writeFileSync(join(s.fx, `${fname(path)}.after.json`), JSON.stringify(after))
  writeFileSync(join(s.fx, `${fname(path)}.POST.then`), `${fname(path)}.after.json ${fname(path)}.json\n`)
  writeFileSync(join(s.fx, 'repos__o__r__issues__comments__900.DELETE.error'), 'HTTP 403')
  const r = run(s, 'put', tmp(s, 'out.json', { result: { prs: [wave.result.prs[0]] } }), '--run', 'wf_1')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /could not delete the later record 900/)
  assert.deepEqual(records(run(s, 'list')).map(x => x.commentId), [150])
  s.put('repos/o/r/pulls', [mergedPr(42, '2026-11-02T00:00:00Z')])
  s.put('repos/o/r/issues/42/comments', [])
  s.put('repos/o/r/pulls/42/comments', [])
  const rows = after.map(c => JSON.parse(c.body.split('\n')[2])).map(x => ({ ...x, pr: { id: 'L1', number: 42 }, reason: 'needs human: scope' }))
  s.put(`repos/o/r/issues/${ISSUE}/comments`, [rec(150, 'wf_1', 'L1', rows[0]), rec(900, 'wf_1', 'L1', rows[1])])
  const rep = run(s, 'report').stdout
  assert.match(rep, /^Weighted tokens per merged PR: median 100, mean 100, over 1 PRs with tokens\.$/m)
  assert.match(rep, /^Maintainer touches per PR: 1, 1 in all\.$/m)
})

test('L01-1 report --since prints the medians, means and the share with 4 or more rounds for the PRs merged after the tag', () => {
  const rs = [[41, '2026-10-01T00:00:00Z', 9, 9], [42, '2026-11-02T00:00:00Z', 100, 1], [43, '2026-11-03T00:00:00Z', 200, 2], [44, '2026-11-04T00:00:00Z', 300, 3], [45, '2026-11-05T00:00:00Z', 1000, 5]]
  const comments = rs.map(([n, , w, r], i) => rec(10 + i, 'wf_1', `P${n}`, { pr: { id: `P${n}`, number: n }, rounds: r, tokens: tok(w, w / 2) }))
  const facts = Object.fromEntries(rs.map(([n]) => [n, { mode: 'auto', threads: 1 }]))
  const s = setup({ comments, pulls: rs.map(([n, at]) => mergedPr(n, at)), facts, commits: { 'v0.8.5': '2026-10-15T00:00:00Z' } })
  const r = run(s, 'report', '--since', 'v0.8.5')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Report over 4 merged PRs since v0\.8\.5\.$/m)
  assert.match(r.stdout, /^Weighted tokens per merged PR: median 250, mean 400, over 4 PRs with tokens\.$/m)
  assert.match(r.stdout, /^Tokens without cache reads per merged PR: median 125, mean 200\.$/m)
  assert.match(r.stdout, /^Rounds per merged PR: median 2\.5, over 4 PRs, and 0 PRs have no round count\.$/m)
  assert.match(r.stdout, /^PRs with 4 or more rounds: 1 of 4\.$/m)
  assert.match(r.stdout, /^Bot threads: 4 in all\.$/m)
  assert.deepEqual(r.writes, [])
})

test('L01-9 report counts a PR once over its records, a defect once, land fixes apart, and leaves a null-rounds PR out of the median', () => {
  const comments = [
    rec(10, 'wf_1', 'L1', { pr: { id: 'L1', number: null }, reason: 'needs human: scope', rounds: 3, tokens: tok(100, 50), codeChangedByBots: true }),
    rec(11, 'wf_2', 'L1', { pr: { id: 'L1', number: 42 }, rounds: 4, tokens: tok(100, 50), evalMisses: ['x'] }),
    rec(12, 'wf_3', 'L1', { kind: 'land-fix', pr: { id: 'L1', number: 42 }, rounds: 1, tokens: tok(50, 25) }),
    rec(13, 'backfill', 'pr-43', { kind: 'backfill', pr: { id: 'pr-43', number: 43 }, rounds: null }),
  ]
  const s = setup({ comments, pulls: [mergedPr(42, '2026-11-02T00:00:00Z'), mergedPr(43, '2026-11-03T00:00:00Z')], facts: { 42: { mode: 'auto' }, 43: { mode: 'auto' } } })
  const r = run(s, 'report')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Report over 2 merged PRs\.$/m)
  assert.match(r.stdout, /^Weighted tokens per merged PR: median 250, mean 250, over 1 PRs with tokens\.$/m)
  assert.match(r.stdout, /^Rounds per merged PR: median 4, over 1 PRs, and 1 PRs have no round count\.$/m)
  assert.match(r.stdout, /^Defects found after sign-off: 1 PRs\.$/m)
  assert.match(r.stdout, /^Land fixes: 1 records on 1 PRs, counted apart from defects\.$/m)
  assert.match(r.stdout, /^Maintainer touches per PR: 0\.5, 1 in all\.$/m)
  assert.match(r.stdout, /^Records with no tokens: 1 of 2 PRs\.$/m)
})

test('L01-9 a stalled record joins only the next numbered record of its plan id, even when the id repeats', () => {
  const comments = [
    rec(10, 'wf_1', 'V01', { pr: { id: 'V01', number: 30 }, rounds: 2 }),
    rec(11, 'wf_2', 'V01', { pr: { id: 'V01', number: null }, reason: 'needs human: scope', rounds: 1, tokens: tok(70) }),
    rec(12, 'wf_3', 'V01', { pr: { id: 'V01', number: 50 }, rounds: 3, tokens: tok(30) }),
    rec(13, 'wf_4', 'V01', { pr: { id: 'V01', number: null }, reason: 'needs human: scope', rounds: 1, tokens: tok(5) }),
  ]
  const s = setup({ comments, pulls: [mergedPr(30, '2026-10-01T00:00:00Z'), mergedPr(50, '2026-11-01T00:00:00Z')], facts: { 30: {}, 50: {} } })
  const r = run(s, 'report')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Weighted tokens per merged PR: median 100, mean 100, over 1 PRs with tokens\.$/m)
  assert.match(r.stdout, /^Maintainer touches per PR: 0\.5, 1 in all\.$/m)
  assert.match(r.stdout, /^Records left out because no later record of the PR has a number: 1\.$/m)
})

test('L01-9 report, list and put work with a ledger and a pull list over 200 KB', () => {
  const big = 'x'.repeat(3000)
  const comments = Array.from({ length: 120 }, (_, i) => rec(100 + i, `wf_${i}`, `P${i}`, { pr: { id: `P${i}`, number: 1000 + i }, rounds: 1, tokens: tok(10), note: big }))
  const pulls = Array.from({ length: 120 }, (_, i) => mergedPr(1000 + i, '2026-11-01T00:00:00Z', big))
  const facts = Object.fromEntries(pulls.map(p => [p.number, {}]))
  const s = setup({ comments, pulls, facts })
  const r = run(s, 'report')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Report over 120 merged PRs\.$/m)
  assert.equal(run(s, 'list').status, 0)
  assert.equal(run(s, 'put', tmp(s, 'out.json', wave), '--run', 'wf_new').status, 0)
})

test('L01-9 only the four stop reasons and a person merge count as touches', () => {
  const reasons = ['needs human: scope', 'no progress: the fix changed nothing in round 1', 'rounds exhausted: the fix changed nothing in round 1', 'checks failed twice: lint', 'rounds exhausted: 4 of 4']
  const nums = [51, 52, 53, 54, 55]
  const comments = nums.map((n, i) => rec(10 + i, 'wf_1', `P${n}`, { pr: { id: `P${n}`, number: n }, reason: reasons[i] }))
  const s = setup({ comments, pulls: nums.map(n => mergedPr(n, '2026-11-02T00:00:00Z')), facts: Object.fromEntries(nums.map(n => [n, { mode: n === 55 ? 'person' : 'auto' }])) })
  assert.match(run(s, 'report').stdout, /^Maintainer touches per PR: 1, 5 in all\.$/m)
  const t = setup({ comments, pulls: nums.map(n => mergedPr(n, '2026-11-02T00:00:00Z')), facts: Object.fromEntries(nums.map(n => [n, { mode: 'auto' }])) })
  assert.match(run(t, 'report').stdout, /^Maintainer touches per PR: 0\.8, 4 in all\.$/m)
})

test('L01-10 hand records a hand fix and report prints the counts by kind', () => {
  const s = setup()
  const r = run(s, 'hand', '42', 'process')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.writes[0], /^POST \/repos\/o\/r\/issues\/7\/comments body=<!-- pipeline:ledger v1 hand-\d+ #42 -->\\n```json\\n.*"handFix":"process"/)
  assert.equal(run(s, 'hand', '42', 'other').status, 64)
  assert.equal(run(setup({ issue: false }), 'hand', '42', 'code').status, 65)
  const hand = (id, n, k) => rec(id, `hand-${id}`, `#${n}`, { kind: 'hand', handFix: k, pr: { id: `#${n}`, number: n }, rounds: null })
  const comments = [rec(10, 'wf_1', 'P42', { pr: { id: 'P42', number: 42 }, rounds: 4 }), rec(11, 'wf_1', 'P43', { pr: { id: 'P43', number: 43 }, rounds: 1 }), hand(20, 42, 'code'), hand(21, 42, 'code'), hand(22, 43, 'process')]
  const t = setup({ comments, pulls: [mergedPr(42, '2026-11-02T00:00:00Z'), mergedPr(43, '2026-11-03T00:00:00Z')], facts: { 42: {}, 43: {} } })
  const rep = run(t, 'report').stdout
  assert.match(rep, /^Hand fixes: 2 by code, 1 by process\.$/m)
  assert.match(rep, /^PRs with 4 or more rounds: 1 of 2\.$/m)
})

test('L01-8 backfill writes one record per merged PR with none and nothing on a second run', () => {
  const pulls = [mergedPr(41, '2026-10-01T00:00:00Z', 'Tested.\nReview: no blockers or majors after round 3.'), mergedPr(42, '2026-10-02T00:00:00Z', 'Closes #1'), mergedPr(43, '2026-10-03T00:00:00Z', 'Review rounds: 2')]
  const facts = { 41: { mode: 'auto', threads: 2 }, 42: { mode: 'person' }, 43: {} }
  const s = setup({ comments: [rec(10, 'wf_1', 'P42', { pr: { id: 'P42', number: 42 } })], pulls, facts })
  const dry = run(s, 'backfill', '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.deepEqual(dry.writes, [])
  const printed = records(dry)
  assert.deepEqual(printed.map(x => [x.pr.number, x.rounds, x.github.mergeMode, x.github.botThreads, x.kind, x.tokens]), [[41, 3, 'auto', 2, 'backfill', null], [43, 2, null, 0, 'backfill', null]])
  const r = run(s, 'backfill')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.writes.length, 2)
  assert.match(r.writes[0], /^POST \/repos\/o\/r\/issues\/7\/comments body=<!-- pipeline:ledger v1 backfill pr-41 -->/)
  const path = `repos/o/r/issues/${ISSUE}/comments`
  s.put(path, [rec(10, 'wf_1', 'P42', { pr: { id: 'P42', number: 42 } }), rec(11, 'backfill', 'pr-41', { pr: { id: 'pr-41', number: 41 } }), rec(12, 'backfill', 'pr-43', { pr: { id: 'pr-43', number: 43 } })])
  assert.deepEqual(run(s, 'backfill').writes, [])
  const onlyMiss = setup({ comments: [rec(10, 'miss', 'P41', { kind: 'miss', pr: { id: 'P41', number: 41 } })], pulls: [pulls[0]], facts })
  assert.deepEqual(records(run(onlyMiss, 'backfill', '--dry-run')).map(x => x.pr.number), [41])
  const noIssue = run(setup({ issue: false, pulls, facts }), 'backfill', '--dry-run')
  assert.equal(noIssue.status, 0, noIssue.stderr)
  assert.equal(records(noIssue).length, 3)
})

test('report --from reads the lines that backfill --dry-run printed', () => {
  const pulls = [mergedPr(41, '2026-10-01T00:00:00Z', '3 rounds'), mergedPr(43, '2026-10-03T00:00:00Z', '5 rounds')]
  const s = setup({ issue: false, pulls, facts: { 41: { mode: 'person' }, 43: { mode: 'auto' } } })
  const f = join(s.dir, 'printed.jsonl')
  writeFileSync(f, run(s, 'backfill', '--dry-run').stdout)
  const r = run(s, 'report', '--from', f)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Rounds per merged PR: median 4, over 2 PRs, and 0 PRs have no round count\.$/m)
  assert.match(r.stdout, /^Maintainer touches per PR: 0\.5, 1 in all\.$/m)
  assert.match(r.stdout, /^Records with no tokens: 2 of 2 PRs\.$/m)
})

test('list, report and hand with no ledger issue exit 65', () => {
  for (const args of [['list'], ['report'], ['hand', '1', 'code']]) assert.equal(run(setup({ issue: false }), ...args).status, 65)
  assert.equal(run(setup(), 'bogus').status, 64)
  assert.equal(run(setup(), 'put').status, 64)
})

test('E06-1 put writes an eval miss for a ready PR with codeChangedByBots, in the same run, and none otherwise', () => {
  const s = setup()
  const out = (id, o) => tmp(s, `out-${id}.json`, { result: { prs: [{ id, ready: true, prNumber: 42, history: [{ round: 1 }], ...o }] } })
  const miss = records(run(s, 'put', out('A', { codeChangedByBots: true }), '--run', 'wf_1', '--dry-run'))[0]
  assert.deepEqual(miss.evalMisses, [{ source: 'bot' }])
  assert.equal(records(run(s, 'put', out('B', { codeChangedByBots: false }), '--run', 'wf_1', '--dry-run'))[0].evalMisses.length, 0)
  assert.equal(records(run(s, 'put', out('C', { codeChangedByBots: true, ready: false }), '--run', 'wf_1', '--dry-run'))[0].evalMisses.length, 0)
  const given = records(run(s, 'put', out('D', { codeChangedByBots: true, evalMisses: [{ source: 'bot' }] }), '--run', 'wf_1', '--dry-run'))[0]
  assert.equal(given.evalMisses.length, 1)
})

test('E06-2 miss records a later defect and report counts the PR once with a bot miss as well', () => {
  const s = setup()
  const r = run(s, 'miss', '42', '77')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.writes[0], /^POST \/repos\/o\/r\/issues\/7\/comments body=<!-- pipeline:ledger v1 miss-\d+-77 #42 -->\\n```json\\n.*"kind":"miss".*"evalMisses":\[\{"source":"later","issue":77\}\]/)
  assert.equal(run(s, 'miss', '42').status, 64)
  assert.equal(run(s, 'miss', '42', 'x').status, 64)
  assert.equal(run(s, 'miss', '42', '1234567890123456789').status, 64)
  assert.equal(run(s, 'miss', '0042', '77').status, 64)
  assert.equal(run(setup({ issue: false }), 'miss', '42', '77').status, 65)
  const missRec = (id, n, i) => rec(id, `miss-${id}-${i}`, `#${n}`, { kind: 'miss', pr: { id: `#${n}`, number: n }, rounds: null, evalMisses: [{ source: 'later', issue: i }] })
  const comments = [
    rec(10, 'wf_1', 'P42', { pr: { id: 'P42', number: 42 }, rounds: 2, codeChangedByBots: true, evalMisses: [{ source: 'bot' }] }),
    rec(11, 'wf_1', 'P43', { pr: { id: 'P43', number: 43 }, rounds: 1 }),
    rec(12, 'wf_1', 'P44', { pr: { id: 'P44', number: 44 }, rounds: 1 }),
    missRec(20, 42, 77), missRec(21, 43, 78),
  ]
  const t = setup({ comments, pulls: [42, 43, 44].map(n => mergedPr(n, '2026-11-02T00:00:00Z')), facts: { 42: {}, 43: {}, 44: {} } })
  const rep = run(t, 'report').stdout
  assert.match(rep, /^Defects found after sign-off: 2 PRs\.$/m)
  assert.match(rep, /^Eval misses: 2 PRs\.$/m)
  assert.match(rep, /^Rounds per merged PR: median 1, over 3 PRs/m)
})

test('a local record from a tokens file that is not comparable keeps the wave totals out of raw and agents', () => {
  const s = setup()
  const out = tmp(s, 'out.json', wave)
  const tokens = tmp(s, 'tokens.json', { comparable: false, totals: { totalTokens: 7000, agentCount: 5 }, prs: [] })
  const recs = records(run(s, 'put', out, '--run', 'wf_1', '--tokens', tokens, '--dry-run'))
  assert.ok(recs.length === 2 && recs.every(r => r.tokens.comparable === false && r.tokens.source === 'totals' && r.tokens.raw === null && r.tokens.agents === null && r.tokens.waveTotal === 7000 && r.tokens.waveAgents === 5))
})
