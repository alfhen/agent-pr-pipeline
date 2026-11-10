// Prompt and agent-file text for E02: the builder cannot change the eval list, and disputes go to the writer. The sim covers what code decides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const src = read('workflows/run-wave.js').replace('export const meta', 'const meta')
const OK_LIST = { evals: [{ id: 'X1-1', kind: 'behaviour', statement: 's1', check: 'c1' }, { id: 'X1-2', kind: 'error path', statement: 's2', check: 'c2' }] }
const args = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', feedback: false, cleanup: false, prs: [{ id: 'X1', title: 't', branch: 'feat/x1-branch' }] }
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)

async function capture() {
  const prompts = {}
  const types = {}
  const agent = async (prompt, o) => {
    prompts[o.label] = prompt
    types[o.label] = o.agentType
    if (o.label.startsWith('preflight')) return { ok: true, exists: true, goals: 1, nonGoals: 1, missing: [] }
    if (o.label.startsWith('evalsarch')) return { verdict: 'ok', notes: '' }
    if (o.label.startsWith('evals:')) return OK_LIST
    if (o.label.startsWith('implement')) return { pushed: true, branch: 'b', summary: 's', acceptanceTestPassed: true, disputes: [{ id: 'X1-1', reason: 'too wide' }] }
    if (o.label.startsWith('dispute')) return { ruling: 'keep', reason: 'k' }
    if (o.label.startsWith('review:')) return { summary: 's', findings: o.label === 'review:X1#1' ? [{ severity: 'major', title: 'x', detail: 'd' }] : [] }
    if (o.label.startsWith('verify')) return { pass: true, headSha: 'sha', checks: [{ name: 'lint', pass: true }], evals: [{ id: 'X1-1', result: 'pass' }, { id: 'X1-2', result: 'pass' }] }
    if (o.label.startsWith('arch:')) return { verdict: 'fits', summary: 's', newConcepts: [] }
    if (o.label.startsWith('fix:')) return { summary: 's', changed: true }
    return null
  }
  await run(args, agent, async thunks => Promise.all(thunks.map(t => t().catch(() => null))), () => {})
  return { prompts, types }
}
const { prompts, types } = await capture()

test('E02-1 the implementer prompt holds the list and says the builder cannot change it', () => {
  assert.match(prompts['implement:X1'], /"id": "X1-2"/)
  assert.match(prompts['implement:X1'], /The evals in the PR block are fixed/)
  assert.match(prompts['implement:X1'], /You cannot change, add or remove an eval, and an eval in your answer is ignored/)
  assert.match(prompts['implement:X1'], /`deviations`/)
})

test('E02-1 the fixer prompt holds the list and the same rule, with no deviations', () => {
  assert.ok(prompts['fix:X1#1'], 'the fixer ran')
  assert.match(prompts['fix:X1#1'], /"id": "X1-2"/)
  assert.match(prompts['fix:X1#1'], /You cannot change, add or remove an eval/)
  assert.doesNotMatch(prompts['fix:X1#1'], /`deviations`/)
})

test('E02-1 the implementer and fixer agent files say the list is fixed and name disputes', () => {
  for (const file of ['agents/implementer.md', 'agents/fixer.md']) {
    const body = read(file)
    assert.match(body, /they are fixed|are fixed/)
    assert.match(body, /cannot change, add or remove an eval/)
    assert.match(body, /`disputes`/)
  }
  assert.match(read('agents/implementer.md'), /`deviations`/)
})

test('E02-3 a dispute goes to the evals writer agent, on the default branch, with the reason', () => {
  assert.equal(types['dispute:X1#1'], 'agent-pr-pipeline:evals-writer')
  assert.match(prompts['dispute:X1#1'], /too wide/)
  assert.match(prompts['dispute:X1#1'], /never read or check out a PR branch/)
  assert.match(prompts['dispute:X1#1'], /`keep`/)
  assert.match(read('agents/evals-writer.md'), /## Disputes/)
  assert.match(read('agents/evals-writer.md'), /Answer `keep`/)
})

test('E02-6 the reviewer agent file holds the deviation rule', () => {
  assert.match(read('agents/reviewer.md'), /## Deviations/)
  assert.match(read('agents/reviewer.md'), /A change outside the entry's Touches line is a finding unless the entry or a plan rule allows it/)
})
