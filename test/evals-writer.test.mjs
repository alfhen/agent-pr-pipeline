// Prompt text for the evals writer and its check, and the plan template and skill lines for evals. The sim covers what code decides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../workflows/run-wave.js', import.meta.url), 'utf8').replace('export const meta', 'const meta')
const BRANCH = 'feat/unique-branch-7f3a9c'
const OK_LIST = { evals: [{ id: 'X1-1', kind: 'behaviour', statement: 's1', check: 'c1' }, { id: 'X1-2', kind: 'error path', statement: 's2', check: 'c2' }] }
const args = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', feedback: false, cleanup: false, prs: [{ id: 'X1', title: 't', branch: BRANCH }] }
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)

async function capture() {
  const prompts = {}
  const agent = async (prompt, o) => {
    prompts[o.label] = prompt
    if (o.label.startsWith('preflight')) return { ok: true, exists: true, goals: 1, nonGoals: 1, missing: [] }
    if (o.label.startsWith('evalsarch')) return { verdict: 'ok', notes: '' }
    if (o.label.startsWith('evals:')) return OK_LIST
    if (o.label.startsWith('implement')) return { pushed: false, branch: 'b', summary: 's', acceptanceTestPassed: false }
    return null
  }
  await run(args, agent, async thunks => Promise.all(thunks.map(t => t().catch(() => null))), () => {})
  return prompts
}
const prompts = await capture()
const agentFile = readFileSync(new URL('../agents/evals-writer.md', import.meta.url), 'utf8')

test('E01-8 the writer prompt names no PR branch, though the implementer prompt does', () => {
  assert.ok(prompts['implement:X1'].includes(BRANCH), 'the fixture branch must be in the implementer prompt')
  assert.ok(prompts['evals:X1'], 'the writer ran')
  assert.ok(!prompts['evals:X1'].includes(BRANCH))
  assert.ok(!prompts['evalsarch:X1#1'].includes(BRANCH))
})

test('E01-8 the writer prompt reads the default branch and the agent file says it never reads a PR branch', () => {
  assert.match(prompts['evals:X1'], /Clone the default branch/)
  assert.match(prompts['evals:X1'], /never read or check out a PR branch/)
  assert.match(agentFile, /You never read a PR branch/)
})

test('E01-11 the evals check asks which behaviour, error path, Acceptance line or QA line has no eval', () => {
  assert.match(prompts['evalsarch:X1#1'], /which behaviour, error path, Acceptance line or QA line of the entry has no eval\?/)
})

test('the writer agent file has the eval kinds, the algorithm rule and the Rules block', () => {
  for (const kind of ['behaviour', 'error path', 'regression', 'quality bar', 'size limit', 'time bound', 'reference']) assert.ok(agentFile.includes(`\`${kind}\``), kind)
  assert.match(agentFile, /a `time bound` eval, a `size limit` eval and a `reference` eval/)
  assert.match(agentFile, /^## Rules$/m)
})

test('the plan template and the skill name the Round cap, the Algorithm line and the Evals table', () => {
  const template = readFileSync(new URL('../templates/plan.md', import.meta.url), 'utf8')
  assert.match(template, /\*\*A01 <Title> \(#<n>\)\.\*\* Round cap <n>\./)
  assert.match(template, /^Algorithm: /m)
  assert.match(template, /\| Id \| Kind \| What must be true \| How to check \|/)
  const skill = readFileSync(new URL('../skills/pr-pipeline/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /\*\*Evals\.\*\* An entry of a code PR has an \*\*Evals\*\* table/)
  assert.match(skill, /`Algorithm: yes` line/)
  assert.match(skill, /Give each code entry a Round cap and an Evals table/)
})

test('F652-1 the writer prompt and agent file name what is not an eval', () => {
  for (const text of [prompts['evals:X1'], agentFile]) {
    assert.match(text, /checkable from a clean clone of the branch/)
    for (const thing of [/PR body or title/, /Closes/, /labels/, /bot comments/, /CI results/, /a merge/, /a release/]) assert.match(text, thing)
    for (const thing of ['PR body or title', 'bot comments', 'CI results', 'a merge', 'a release']) assert.match(text, new RegExp(`(do not write an eval for|leave out)[^.]*${thing}`, 'i'))
  }
  assert.match(agentFile, /the notes still reach the opener/)
})

test('F659: the writer marks behaviour that already holds as regression, in the agent and the task prompt', () => {
  assert.match(agentFile, /already holds on the default branch, give its evals kind `regression` \(they pass with and without the change, by design\) and say so in `notes`/);
  const sim = readFileSync(new URL('../workflows/run-wave.js', import.meta.url), 'utf8');
  assert.match(sim, /already holds on the default branch, give those evals kind regression and say so in notes/);
});
