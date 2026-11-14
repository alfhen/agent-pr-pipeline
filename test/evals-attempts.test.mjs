// C10: the writer sentence, the SKILL.md text and the recorded list of attempt 3.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = p => readFileSync(join(root, p), 'utf8')
const src = read('workflows/run-wave.js').replace('export const meta', 'const meta')
const SENTENCE = /an eval for code that reads pull request text names that code in its statement and puts the fixture text in its check/i
const args = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', feedback: false, cleanup: false, prs: [{ id: 'X1', title: 't', branch: 'feat/x' }] }
const LIST = { evals: [{ id: 'X1-1', kind: 'behaviour', statement: 's1', check: 'c1' }, { id: 'X1-2', kind: 'error path', statement: 's2', check: 'c2' }], coverage: [{ item: 'x', evals: ['X1-1', 'X1-2'] }] }
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)

async function capture() {
  const prompts = {}
  const agent = async (prompt, o) => {
    prompts[o.label] = prompt
    if (o.label.startsWith('preflight')) return { ok: true, exists: true, goals: 1, nonGoals: 1, missing: [] }
    if (o.label.startsWith('evalsarch')) return { verdict: 'ok', notes: '' }
    if (o.label.startsWith('evals:')) return LIST
    if (o.label.startsWith('implement')) return { pushed: false, branch: 'b', summary: 's', acceptanceTestPassed: false }
    return null
  }
  await run(args, agent, async thunks => Promise.all(thunks.map(t => t().catch(() => null))), () => {})
  return prompts
}

test('C10-8 the task prompt holds the sentence in step 4, outside the rule text the evals check shares', async () => {
  const prompts = await capture()
  const prompt = prompts['evals:X1']
  assert.ok(prompt && prompts['evalsarch:X1#1'])
  const step4 = prompt.split('\n').find(l => l.startsWith('4. '))
  assert.match(step4, SENTENCE)
  assert.doesNotMatch(prompts['evalsarch:X1#1'], SENTENCE)
})

test('C10-8 the role file holds the sentence on its one clean-clone rule line', () => {
  const lines = read('agents/evals-writer.md').split('\n').filter(l => l.startsWith('- Every eval must be checkable from a clean clone of the branch'))
  assert.equal(lines.length, 1)
  assert.match(lines[0], SENTENCE)
})

test('C10-9 SKILL.md says default 3 and that the rule reads the statement', () => {
  const lines = read('skills/pr-pipeline/SKILL.md').split('\n')
  const bullet = lines.find(l => l.startsWith('- `evals`:'))
  assert.ok(bullet.includes('default 3'))
  assert.ok(!bullet.includes('default 2'))
  const step1 = lines.find(l => l.startsWith('1. **Implement.**'))
  const sentence = step1.split(/(?<=[.;]) /).find(s => s.includes('checks the PR, not the code'))
  assert.ok(sentence, 'step 1 has the sentence on the rule')
  assert.match(sentence, /statement/)
})

test('C10-10 recover-evals prints the list of attempt 3 when only that attempt was accepted', () => {
  const ev = (id, kind, statement) => ({ id, kind, statement, check: `run ${id}; expect ok` })
  const lists = [1, 2, 3].map(n => [ev('C1-1', 'behaviour', `attempt ${n}`), ev('C1-2', 'error path', 'bad input is refused')])
  const writer = list => ({ evals: list, noErrorPath: '', noReference: '', algorithm: false, notes: '' })
  const steps = [
    ['evals:C1', writer(lists[0])], ['evalsarch:C1#1', { verdict: 'needs-change', notes: 'gap' }],
    ['evals:C1#w2', writer(lists[1])], ['evalsarch:C1#2', { verdict: 'needs-change', notes: 'gap' }],
    ['evals:C1#w3', writer(lists[2])], ['evalsarch:C1#3', { verdict: 'ok', notes: '' }],
  ]
  const dir = mkdtempSync(join(tmpdir(), 'evals-attempts-'))
  try {
    const path = join(dir, 'journal.jsonl')
    const lines = [{ type: 'launched' }]
    steps.forEach(([label, answer], i) => {
      lines.push({ type: 'started', key: `k${i}`, agentId: `a${i}`, label, phase: 'p' })
      lines.push({ type: 'result', key: `k${i}`, agentId: `a${i}`, result: answer, toolsUsed: ['StructuredOutput'] })
    })
    writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const r = spawnSync('bash', [join(root, 'scripts', 'recover-evals.sh'), path, 'C1'], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.notDeepEqual(lists[2], lists[0])
    assert.deepEqual(JSON.parse(r.stdout).evals, lists[2])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
