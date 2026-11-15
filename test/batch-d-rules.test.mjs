// Prompt and doc text for batch D of 0.9.7: the regression kind, the post-build exception of the evals check, and the plan-review closing check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const src = read('workflows/run-wave.js').replace('export const meta', 'const meta')
const LIST = { evals: [{ id: 'X1-1', kind: 'behaviour', statement: 's1', check: 'c1' }, { id: 'X1-2', kind: 'error path', statement: 's2', check: 'c2' }], coverage: [{ item: 'x', evals: ['X1-1', 'X1-2'] }] }
const args = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', feedback: false, cleanup: false }
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)

async function capture(pr, extra = {}) {
  const prompts = {}
  const agent = async (prompt, o) => {
    prompts[o.label] = prompt
    if (o.label.startsWith('preflight')) return { ok: true, exists: true, goals: 1, nonGoals: 1, missing: [] }
    if (o.label.startsWith('evalsarch')) return { verdict: 'ok', notes: '' }
    if (o.label.startsWith('evals:')) return LIST
    if (o.label.startsWith('implement')) return { pushed: true, branch: 'b', summary: 's', acceptanceTestPassed: true }
    if (o.label.startsWith('review:')) return { summary: 's', findings: [] }
    if (o.label.startsWith('verify')) return { pass: true, headSha: 'sha', checks: [{ name: 'lint', pass: true }], evals: [...prompt.matchAll(/^Eval (\S+) \[/gm)].map(m => ({ id: m[1], result: 'pass', breakCheck: 'fails-without-change' })) }
    if (o.label.startsWith('test:')) return { pass: true, headSha: 'sha', checks: [{ name: 'lint', pass: true }] }
    if (o.label.startsWith('arch:')) return { verdict: 'fits', summary: 's', newConcepts: [] }
    return null
  }
  await run({ ...args, ...extra, prs: [pr] }, agent, async thunks => Promise.all(thunks.map(t => t().catch(() => null))), () => {})
  return prompts
}
const base = { id: 'X1', title: 't', branch: 'feat/x1-branch' }
const sentences = text => text.split(/(?<=\.) /)
const ruleOf = p => p.slice(p.indexOf('Every blocker and major of yours needs an `eval`'), p.indexOf('A failed invariant needs no eval.') + 'A failed invariant needs no eval.'.length)

test('D-1 the reviewer eval rule names kind regression for behaviour the PR broke', async () => {
  const p = await capture({ ...base, evals: LIST.evals })
  const hit = sentences(ruleOf(p['review:X1#1'])).filter(t => /regression/.test(t) && /default branch/.test(t) && !/is one of/.test(t))
  assert.equal(hit.length, 1)
})

test('D-2 agents/reviewer.md names kind regression for behaviour the PR broke', () => {
  const line = read('agents/reviewer.md').split('\n').find(l => l.startsWith('When your task lists evals'))
  const hit = sentences(line).filter(t => /regression/.test(t) && /default branch/.test(t))
  assert.equal(hit.length, 1)
  assert.doesNotMatch(hit[0], /`fileIssue: true`|untrusted text|minor-pass check/)
})

test('D-4 step 2 of the evals check names the steps after the build as no gap', async () => {
  const p = await capture({ ...base })
  const step2 = p['evalsarch:X1#1'].split('\n').find(l => l.startsWith('2. '))
  const after = step2.slice(step2.indexOf('has no eval?'))
  for (const w of [/CI/, /label/, /merge/, /release/, /needs no eval|not a gap/]) assert.match(after, w)
  assert.match(after, /The part of an Acceptance or QA line that names a step/)
  assert.match(after, /the rest of the line still does/)
  assert.doesNotMatch(after, /An Acceptance or QA line that names a step[^.]*needs no eval/)
})

test('D-6 step 1 of SKILL.md says the evals check asks no eval for a step after the build', () => {
  const line = read('skills/pr-pipeline/SKILL.md').split('\n').find(l => l.startsWith('1. **Implement.**'))
  assert.ok(sentences(line).some(t => /evals check|reviewer/.test(t) && /CI/.test(t) && /release/.test(t) && /needs no eval|not a gap/.test(t)))
})

test('D-10 the plan review paragraph of SKILL.md checks that each closed issue is fully settled', () => {
  const line = read('skills/pr-pipeline/SKILL.md').split('\n').find(l => l.startsWith('For the rest of the plan review'))
  assert.match(line, /issue[^.]*clos[^.]*(settled|fully)/)
})

const EXC = /names only a step after the build[^.]*(gets no (coverage )?item)/
test('D-11 the coverage rule exempts a line that names only a step after the build', async () => {
  const p = await capture({ ...base })
  const w = p['evals:X1']
  assert.match(w.slice(w.indexOf('5. Return')), EXC)
  assert.match(read('agents/evals-writer.md').split('\n').find(l => l.startsWith('Return `coverage` with the list')), EXC)
  const c = p['evalsarch:X1#1']
  assert.match(c.slice(c.indexOf('Judge each item')), /names only a step after the build[^.]*gets no item[^.]*not a gap/)
})
