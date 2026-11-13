// Checks token-report.sh (file count, role names, the PR line of prBlock) and wave-result.sh (the no progress code). Each test name starts with its eval id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const TOKEN_REPORT = join(root, 'scripts/token-report.sh')
const WAVE_RESULT = join(root, 'scripts/wave-result.sh')

const line = (o) => JSON.stringify(o)
const first = (prId) => line({ type: 'user', message: { content: `PR: ${prId} - t` } })
const usage = (id, output) => line({ type: 'assistant', message: { id, usage: { output_tokens: output } } })

function world(agents) {
  const dir = mkdtempSync(join(tmpdir(), 'br4-'))
  const tr = join(dir, 'tr'); mkdirSync(tr)
  writeFileSync(join(dir, 'out.json'), line({ summary: 's', agentCount: agents.length, totalTokens: 10, logs: [], result: {} }))
  agents.forEach((a, i) => {
    writeFileSync(join(tr, `agent-${i}.jsonl`), a.lines.join('\n') + '\n')
    writeFileSync(join(tr, `agent-${i}.meta.json`), line({ agentType: a.type }))
  })
  const run = (...args) => {
    const r = spawnSync('bash', [TOKEN_REPORT, join(dir, 'out.json'), tr, '--json', join(dir, 'tok.json'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: dir } })
    return { ...r, tok: JSON.parse(readFileSync(join(dir, 'tok.json'), 'utf8')) }
  }
  return { dir, run }
}

const byOutput = (type, prId, output) => ({ type, lines: [first(prId), usage(`m-${prId}`, output)] })

test('BR4-5 a file with a bad line and a skipped line counts once and the message says skipped', () => {
  const w = world([
    { type: 'agent-pr-pipeline:reviewer', lines: [first('A1'), usage('m1', 1)] },
    { type: 'agent-pr-pipeline:reviewer', lines: [line({ type: 'user', message: 'text' }), 'not json'] },
  ])
  const r = w.run()
  const msg = r.stdout.split('\n').find(l => l.startsWith('transcripts: incomplete'))
  assert.ok(msg, r.stdout)
  assert.match(msg, /\b1 file/)
  assert.match(msg, /skipped/)
  assert.doesNotMatch(msg, /had unreadable lines/)
  assert.equal(r.tok.comparable, false)
})

test('BR4-7 a versioned cloud name maps to the role that ends it and the longest match wins', () => {
  const w = world([
    byOutput('apl-v0-8-0-implementer', 'A1', 100),
    byOutput('apl-v0-8-0-arch-reviewer', 'B1', 100),
    byOutput('agent-pr-pipeline:tester', 'C1', 100),
  ])
  const r = w.run()
  for (const role of ['implementer', 'arch-reviewer', 'tester']) assert.match(r.stdout, new RegExp(`^${role} \\| 1 \\|`, 'm'))
  assert.doesNotMatch(r.stdout, /apl-v0/)
  assert.deepEqual([...new Set(r.tok.prs.flatMap(p => Object.keys(p.byRole)))].sort(), ['arch-reviewer', 'implementer', 'tester'])
})

test('BR4-8 an agentType that matches no agent file is other and its text goes nowhere', () => {
  const w = world([
    byOutput('apl-v0-8-0-implementer', 'A1', 100),
    byOutput('apl-v0-8-0-tester', 'B1', 100),
    byOutput('agent-pr-pipeline:fixer', 'C1', 100),
    byOutput('Secret Name 42', 'D1', 5000),
  ])
  const fb = join(w.dir, 'fb.json')
  const r = w.run('--feedback', fb)
  assert.equal(r.status, 0, r.stderr)
  const all = r.stdout + readFileSync(fb, 'utf8') + JSON.stringify(r.tok)
  assert.doesNotMatch(all, /Secret/)
  assert.match(r.stdout, /^other \| 1 \|/m)
  const evidence = JSON.parse(readFileSync(fb, 'utf8'))[0].evidence
  assert.match(evidence, /Top roles by weighted tokens: other 25000/)
  assert.doesNotMatch(evidence, /apl-v0/)
})

test('BR4-6 the PR line that token-report.sh reads is the one prBlock writes', () => {
  const src = readFileSync(join(root, 'workflows/run-wave.js'), 'utf8')
  const pr = src.split('\n').find(l => l.startsWith('const prBlock = '))
  assert.ok(pr, 'prBlock not found')
  assert.ok(pr.includes('`PR: ${pr.id} - '), 'prBlock must start with "PR: ${pr.id} - "')
  const head = readFileSync(TOKEN_REPORT, 'utf8').split('\nset -u')[0]
  assert.match(head, /prBlock/)
  const w = world([{ type: 'agent-pr-pipeline:tester', lines: [line({ type: 'user', message: { content: 'PR: A1 - t\nBranch: b' } }), usage('m', 1)] }])
  assert.deepEqual(w.run().tok.prs.map(p => p.id), ['A1'])
})

test('BR4-9 a reason that starts with "no progress:" is coded rounds-exhausted and the other codes stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br4-wr-'))
  const cases = [
    ['no progress: the fix changed nothing in round 2, 2 of 4 used (maxRounds)', '7 false rounds-exhausted'],
    ['no progress: rounds 2 and 3 fixed no eval, left no fewer failing checks and cleared no theme (since round 1)', '7 false rounds-exhausted'],
    ['needs human: scope', '7 false needs-human'],
    ['rounds exhausted: 4 of 4 (maxRounds)', '7 false rounds-exhausted'],
    ['implementation not pushed', '7 false other'],
  ]
  for (const [reason, want] of cases) {
    const input = join(dir, 'o.json')
    writeFileSync(input, line({ summary: 's', agentCount: 1, logs: [], result: { prs: [{ id: 'q', prNumber: 7, ready: false, reason }] } }))
    const r = spawnSync('bash', [WAVE_RESULT, input, join(dir, 'res.json')], { encoding: 'utf8' })
    assert.equal(r.stdout.trim(), want, reason)
  }
})
