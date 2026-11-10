// Runs scripts/token-report.sh on fixtures in a temp folder outside ~/.claude*.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('../scripts/token-report.sh', import.meta.url).pathname

const msg = (id, u) => ({ type: 'assistant', message: { id, usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] } } })
const first = pr => ({ type: 'user', message: { role: 'user', content: pr ? `  Task\n  PR: ${pr} - A title\nBranch: x` : 'no pr here' } })

const setup = (agents, output = { summary: 's', agentCount: agents.length, totalTokens: 12345, logs: [], result: {} }) => {
  const dir = mkdtempSync(join(tmpdir(), 'token-report-test-'))
  const folder = join(dir, 'transcripts'); mkdirSync(folder)
  agents.forEach((a, i) => {
    writeFileSync(join(folder, `agent-${i}.jsonl`), a.lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    writeFileSync(join(folder, `agent-${i}.meta.json`), JSON.stringify({ agentType: `agent-pr-pipeline:${a.role}`, ...(a.desc ? { description: a.desc } : {}) }))
  })
  const outFile = join(dir, 'output.json')
  writeFileSync(outFile, typeof output === 'string' ? output : JSON.stringify(output, null, 2))
  return { dir, folder, outFile }
}
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' })

test('totals come from a pretty-printed output file', () => {
  const { outFile } = setup([])
  const r = run(outFile)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /total tokens: 12345/)
  assert.match(r.stdout, /agents: 0/)
})

test('a per-role table sums input, cache write, cache read and output', () => {
  const { outFile, folder } = setup([
    { role: 'reviewer', lines: [first('A1'), msg('m1', [1, 10, 100, 5]), msg('m2', [2, 20, 200, 7])] },
    { role: 'reviewer', lines: [first('A1'), msg('m3', [3, 30, 300, 9])] },
    { role: 'tester', lines: [first('A1'), msg('m4', [4, 40, 400, 11])] },
  ])
  const r = run(outFile, folder)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^reviewer \| 2 \| 6 \| 60 \| 600 \| 21 \| 222$/m)
  assert.match(r.stdout, /^tester \| 1 \| 4 \| 40 \| 400 \| 11 \| 444$/m)
  assert.match(r.stdout, /^top roles \(weighted\): reviewer 246, tester 149$/m)
  assert.match(r.stdout, /^transcripts: 3 agents, 1142 tokens \(cache reads included\)$/m)
})

test('a duplicate message id counts once', () => {
  const { outFile, folder } = setup([{ role: 'fixer', lines: [first(null), msg('m1', [1, 10, 100, 5]), msg('m1', [1, 10, 100, 5])] }])
  const r = run(outFile, folder)
  assert.match(r.stdout, /^fixer \| 1 \| 1 \| 10 \| 100 \| 5 \| 111$/m)
})

test('a missing transcript folder prints totals and exits 0', () => {
  const { outFile, dir } = setup([])
  const r = run(outFile, join(dir, 'nope'))
  assert.equal(r.status, 0)
  assert.match(r.stdout, /total tokens: 12345/)
  assert.match(r.stdout, /totals only/)
})

test('a broken output file exits 1', () => {
  assert.equal(run(setup([], '{ not json').outFile).status, 1)
  assert.equal(run(setup([], { agentCount: 2 }).outFile).status, 1)
  assert.equal(run(join(tmpdir(), 'token-report-no-such-file')).status, 1)
})

test('a PR above twice the wave median is flagged, and the feedback item holds no PR id', () => {
  const pr = (id, n) => ({ role: 'implementer', lines: [first(id), msg(`${id}`, [0, 0, 0, n])] })
  const { outFile, folder, dir } = setup([pr('P1', 100), pr('P2', 110), pr('P3', 120), pr('P4', 1000)])
  const fb = join(dir, 'fb.json')
  const r = run(outFile, folder, '--feedback', fb)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^FLAG P4: 5000 weighted tokens/m)
  assert.doesNotMatch(r.stdout, /FLAG P[123]:/)
  const items = JSON.parse(readFileSync(fb, 'utf8'))
  assert.equal(items.length, 1)
  assert.doesNotMatch(JSON.stringify(items), /P4/)
  assert.match(items[0].evidence, /implementer/)
})

test('a PR is taken from the meta description, and wave and goals labels are no PR', () => {
  const pr = (id, n, role = 'implementer') => ({ role, desc: `fix:${id}#2`, lines: [first(null), msg(id, [0, 0, 0, n])] })
  const noPr = (label, n) => ({ role: 'pipeline-io', desc: label, lines: [first(null), msg(label, [0, 0, 0, n])] })
  const { outFile, folder } = setup([pr('P1', 100), pr('P2', 110), pr('P3', 120), pr('P4', 1000), noPr('io:wave#version', 5000), noPr('preflight:goals', 5000)])
  const r = run(outFile, folder)
  assert.match(r.stdout, /^FLAG P4: 5000 weighted tokens/m)
  assert.doesNotMatch(r.stdout, /FLAG (wave|goals)/)
})

test('no PR is flagged when the PRs are alike, and the feedback list is empty', () => {
  const pr = (id, n) => ({ role: 'implementer', lines: [first(id), msg(id, [0, 0, 0, n])] })
  const { outFile, folder, dir } = setup([pr('P1', 100), pr('P2', 110), pr('P3', 120)])
  const fb = join(dir, 'fb.json')
  const r = run(outFile, folder, '--feedback', fb)
  assert.match(r.stdout, /PR flags: none/)
  assert.deepEqual(JSON.parse(readFileSync(fb, 'utf8')), [])
})

test('a bad argument exits 64', () => {
  assert.equal(run().status, 64)
  assert.equal(run('--bogus').status, 64)
})

test('a truncated line keeps the valid usage, marks the report incomplete and flags no PR', () => {
  const { outFile, folder } = setup([
    { role: 'fixer', desc: 'fixer:A1#1', lines: [first('A1'), msg('m1', [1, 10, 100, 5])] },
    { role: 'fixer', desc: 'fixer:B1#1', lines: [first('B1'), msg('m2', [1, 10, 100, 5])] },
    { role: 'fixer', desc: 'fixer:C1#1', lines: [first('C1'), msg('m3', [1000, 10, 100, 5])] },
  ])
  appendFileSync(join(folder, 'agent-0.jsonl'), '{"type":"assistant","message":{"id":"m9","us\n')
  const r = run(outFile, folder)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^fixer \| 3 \| 1002 /m)
  assert.match(r.stdout, /incomplete, 1 file/)
  assert.doesNotMatch(r.stdout, /^FLAG /m)
})

test('L01-5 #556: the transcript total is labelled, and a PR flag follows the weighted figure, not cache reads', () => {
  const pr = (id, u) => ({ role: 'implementer', lines: [first(id), msg(id, u)] })
  const { outFile, folder } = setup([pr('A', [0, 0, 100000, 10]), pr('B', [0, 0, 0, 4000]), pr('C', [0, 0, 0, 1000]), pr('D', [0, 0, 0, 1000])])
  const r = run(outFile, folder)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^transcripts: 4 agents, 106010 tokens \(cache reads included\)$/m)
  assert.match(r.stdout, /^weighted per PR: C 5000, D 5000, A 10050, B 20000$/m)
  assert.match(r.stdout, /^FLAG B: 20000 weighted tokens/m)
  assert.doesNotMatch(r.stdout, /^FLAG A:/m)
})

const stamped = (line, timestamp) => ({ ...line, timestamp })

test('L01-13 --json: noCacheRead is input + cache write + output, raw adds cache reads, and wall minutes span the timestamps', () => {
  const { outFile, folder, dir } = setup([
    { role: 'implementer', desc: 'implement:P1#1', lines: [stamped(first('P1'), '2026-11-10T10:00:00.500Z'), stamped(msg('m1', [10, 20, 400, 5]), '2026-11-10T10:05:00.000Z')] },
    { role: 'tester', desc: 'test:P1#1', lines: [stamped(first('P1'), '2026-11-10T10:08:00.000Z'), stamped(msg('m2', [1, 2, 30, 4]), '2026-11-10T10:12:30.000Z')] },
  ])
  const json = join(dir, 'tokens.json')
  const r = run(outFile, folder, '--json', json)
  assert.equal(r.status, 0, r.stderr)
  const t = JSON.parse(readFileSync(json, 'utf8'))
  assert.equal(t.comparable, true)
  assert.deepEqual(t.totals, { totalTokens: 12345, agentCount: 2 })
  const p = t.prs.find(x => x.id === 'P1')
  assert.deepEqual(p.byRole.implementer, { input: 10, cacheWrite: 20, cacheRead: 400, output: 5 })
  assert.equal(p.raw, 10 + 20 + 400 + 5 + 1 + 2 + 30 + 4)
  assert.equal(p.noCacheRead, 10 + 20 + 5 + 1 + 2 + 4)
  assert.equal(p.weighted, Math.round(11 + 430 * 0.1 + 22 * 1.25 + 9 * 5))
  assert.equal(p.agents, 2)
  assert.equal(p.wallMinutes, 12.5)
})

test('L01-6 --json: the minor pass cost counts minorfix, minorreview and test #minor1 agents only', () => {
  const a = (role, desc, out) => ({ role, desc, lines: [first('P1'), msg(desc, [0, 0, 0, out])] })
  const { outFile, folder, dir } = setup([
    a('implementer', 'implement:P1#1', 1000), a('minor-fixer', 'minorfix:P1#1', 10), a('reviewer', 'minorreview:P1#1', 20),
    a('tester', 'test:P1#minor1', 30), a('tester', 'test:P1#2', 400),
  ])
  const json = join(dir, 'tokens.json')
  assert.equal(run(outFile, folder, '--json', json).status, 0)
  const p = JSON.parse(readFileSync(json, 'utf8')).prs[0]
  assert.deepEqual(p.minorPass, { agents: 3, weighted: 300 })
  assert.equal(p.weighted, (1000 + 10 + 20 + 30 + 400) * 5)
})

test('--json with no transcript folder writes the totals with comparable false', () => {
  const { outFile, dir } = setup([])
  const json = join(dir, 'tokens.json')
  assert.equal(run(outFile, join(dir, 'nope'), '--json', json).status, 0)
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), { comparable: false, totals: { totalTokens: 12345, agentCount: 0 }, prs: [] })
})

test('--json writes comparable false when a file is valid JSON but a line is not a transcript entry', () => {
  const { outFile, folder, dir } = setup([
    { role: 'reviewer', lines: [first('A1'), msg('m1', [1, 10, 100, 5])] },
    { role: 'reviewer', lines: [{ type: 'user', message: 'text' }] },
  ])
  const json = join(dir, 'tokens.json')
  assert.equal(run(outFile, folder, '--json', json).status, 0)
  assert.equal(JSON.parse(readFileSync(json, 'utf8')).comparable, false)
})

test('--json writes comparable false when a transcript has an unreadable line', () => {
  const { outFile, folder, dir } = setup([{ role: 'reviewer', lines: [first('A1'), msg('m1', [1, 10, 100, 5])] }])
  appendFileSync(join(folder, 'agent-0.jsonl'), 'not json\n')
  const json = join(dir, 'tokens.json')
  assert.equal(run(outFile, folder, '--json', json).status, 0)
  assert.equal(JSON.parse(readFileSync(json, 'utf8')).comparable, false)
})
