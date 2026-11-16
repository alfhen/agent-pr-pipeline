// The text of the places that say what an opener or a body agent does to the description of an open PR.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const sentences = t => t.split(/(?<=\.) /)

test('openPrompt step 2 adds the minors fixed to the Minor fixes section of an open PR', () => {
  const src = read('workflows/run-wave.js')
  const i = src.indexOf('and the Untested section (set it')
  assert.ok(i > 0)
  const rest = src.slice(i, src.indexOf('Never rebuild the body from the data below'))
  assert.match(rest, /Also add to its Minor fixes section one line for each finding under "Minors fixed in the minor pass"/)
})

test('the opener role adds one line to the Minor fixes section for each minor fixed', () => {
  const line = read('agents/pr-opener.md').split('\n').find(l => l.startsWith('- Open a ready PR'))
  const after = sentences(line.slice(line.indexOf('Change only its Review line and its Untested section')))
  assert.ok(after.some(s => /Minor fixes/.test(s) && /\badd\b/i.test(s)))
})

test('step 9 names the Minor fixes lines and the Tests only removal after a bot change or a land fix', () => {
  const step = sentences(read('skills/pr-pipeline/SKILL.md').split('\n').find(l => l.startsWith('9. **Open the PR.**')))
  assert.ok(step.some(s => /Minor fixes/.test(s) && /\badds?\b/i.test(s)))
  assert.ok(step.some(s => /Tests only:/.test(s) && /bot/i.test(s) && /land fix/i.test(s)))
})

const planOpenPrompt = async notes => {
  const src = read('workflows/run-wave.js').replace('export const meta', 'const meta')
  const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)
  const prompts = {}
  const agent = async (prompt, o) => {
    prompts[o.label] = prompt
    if (o.label.startsWith('preflight')) return { ok: true, exists: true, goals: 1, nonGoals: 1, missing: [] }
    if (o.label.startsWith('implement')) return { pushed: true, branch: 'b', summary: 's', acceptanceTestPassed: true }
    if (o.label.startsWith('review:')) return { summary: 's', findings: [] }
    if (o.label.startsWith('test:')) return { pass: true, headSha: 'sha', checks: [{ name: 'lint', pass: true }] }
    if (o.label.startsWith('arch:')) return { verdict: 'fits', summary: 's', newConcepts: [] }
    if (o.label.startsWith('product')) return { verdict: 'aligned', summary: 's', entries: [] }
    if (o.label.startsWith('open:')) return { prNumber: 7, prUrl: 'u', issuesCreated: [] }
    return null
  }
  const args = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', feedback: false, cleanup: false, prs: [{ id: 'P1', title: 't', branch: 'plan/a', kind: 'plan', notes }] }
  await run(args, agent, async thunks => Promise.all(thunks.map(t => t().catch(() => null))), () => {})
  return prompts['open:P1']
}

test('a plan PR gets no closing line unless the notes tell the opener to put it in, in the open prompt and the opener role', async () => {
  for (const notes of ['entry TK closes #816 when it merges', 'PR body: Closes #45 on its own line.']) {
    const p = await planOpenPrompt(notes)
    assert.ok(p, 'the open prompt was built')
    assert.ok(p.includes(notes) && p.includes('Kind: plan'))
    const step = p.split('\n').find(l => l.startsWith('2. PR'))
    assert.match(step, /keep all of it, including every `Closes #N` line/)
    const marker = 'The rest of this step describes the body of a new PR.'
    const part = sentences(step.slice(step.indexOf(marker) + marker.length + 1))
    assert.ok(part.some(s => /closing keyword/i.test(s) && /issue number/i.test(s) && /\bunless\b/i.test(s) && /\bnotes\b/i.test(s)))
    assert.ok(part.some(s => /\bnames? (?:an|the) issues?\b/i.test(s) && /\b(?:not|no)\b/i.test(s) && /instruction|exception/i.test(s)))
    assert.ok(part.some(s => /\bplan\b/i.test(s) && /\bentry\b/i.test(s) && /\bcop(?:y|ied)\b/i.test(s) && /\b(?:not|never)\b/i.test(s)))
    assert.ok(part.some(s => /\bnumber\b/i.test(s) && /\bclose\b/i.test(s) && /\bfix\b/i.test(s) && /\bresolve\b/i.test(s) && /any form/i.test(s)))
  }
  const line = sentences(read('agents/pr-opener.md').split('\n').find(l => l.startsWith('- Open a ready PR')))
  assert.ok(line.some(s => /\bplan\b/i.test(s) && /closing keyword/i.test(s) && /\bunless\b/i.test(s) && /\bnotes\b/i.test(s)))
  assert.ok(line.some(s => /\bnames? (?:an|the) issues?\b/i.test(s) && /\b(?:not|no)\b/i.test(s)))
  assert.ok(line.some(s => /\bentry\b/i.test(s) && /\bcop(?:y|ied)\b/i.test(s) && /\b(?:not|never)\b/i.test(s)))
  assert.ok(line.some(s => /\bclose\b/i.test(s) && /\bfix\b/i.test(s) && /\bresolve\b/i.test(s)))
})
