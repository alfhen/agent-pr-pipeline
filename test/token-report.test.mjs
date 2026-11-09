// Runs scripts/token-report.sh on fixtures in a temp folder outside ~/.claude*.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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
  assert.match(r.stdout, /top roles: reviewer 687, tester 455/)
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
  assert.match(r.stdout, /^FLAG P4: 1000 tokens/m)
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
  assert.match(r.stdout, /^FLAG P4: 1000 tokens/m)
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
