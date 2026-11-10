// Prompt and agent-file text for E04: the eval rule for the reviewer, resume.designRules, and the scope question. The sim covers what code decides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const src = read('workflows/run-wave.js').replace('export const meta', 'const meta')
const LIST = [{ id: 'X1-1', kind: 'behaviour', statement: 's1', check: 'c1' }, { id: 'X1-2', kind: 'error path', statement: 's2', check: 'c2' }]
const args = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', feedback: false, cleanup: false }
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)
const finding = (title, theme) => ({ severity: 'major', title, detail: 'd', theme, eval: { kind: 'behaviour', statement: `${title} holds`, check: 'run it' } })

async function capture(pr, review, extra = {}) {
  const prompts = {}
  const agent = async (prompt, o) => {
    prompts[o.label] = prompt
    if (o.label.startsWith('preflight')) return { ok: true, exists: true, goals: 1, nonGoals: 1, missing: [] }
    if (o.label.startsWith('evalsarch')) return { verdict: 'ok', notes: '' }
    if (o.label.startsWith('implement')) return { pushed: true, branch: 'b', summary: 's', acceptanceTestPassed: true }
    if (o.label.startsWith('review:')) return { summary: 's', findings: review(o.label) }
    if (o.label.startsWith('verify')) return { pass: true, headSha: 'sha', checks: [{ name: 'lint', pass: true }], evals: [...prompt.matchAll(/^Eval (\S+) \[/gm)].map(m => ({ id: m[1], result: 'pass', breakCheck: 'fails-without-change' })) }
    if (o.label.startsWith('test:')) return { pass: true, headSha: 'sha', checks: [{ name: 'lint', pass: true }] }
    if (o.label.startsWith('arch:')) return { verdict: 'fits', summary: 's', newConcepts: [] }
    if (o.label.startsWith('fix:')) return { summary: 's', changed: true }
    return null
  }
  const out = await run({ ...args, ...extra, prs: [pr] }, agent, async thunks => Promise.all(thunks.map(t => t().catch(() => null))), () => {})
  return { prompts, result: out.prs[0] }
}
const base = { id: 'X1', title: 't', branch: 'feat/x1-branch' }

test('E04-8 resume.designRules reach the verifier, reviewer and fixer prompts, and nothing without them', async () => {
  const rules = ['Refuse a path with dots', '  ', 'Keep the exit code 2']
  const withRules = await capture({ ...base, resume: { history: [], minors: [], findings: [], evals: LIST, designRules: rules } }, label => label === 'review:X1#1' ? [finding('x')] : [])
  for (const label of ['verify:X1#1', 'review:X1#1', 'fix:X1#1']) {
    assert.ok(withRules.prompts[label], `${label} ran`)
    assert.match(withRules.prompts[label], /Rules a person set after the last stop[^]*- Refuse a path with dots\n- Keep the exit code 2/, label)
  }
  assert.doesNotMatch(withRules.prompts['verify:X1#1'], /- \s*\n/)
  const without = await capture({ ...base, resume: { history: [], minors: [], findings: [], evals: LIST } }, label => label === 'review:X1#1' ? [finding('x')] : [])
  for (const label of ['verify:X1#1', 'review:X1#1', 'fix:X1#1']) assert.doesNotMatch(without.prompts[label], /Rules a person set/, label)
})

test('E04-2 the reviewer prompt asks for an eval on each blocker and major, only for a PR with a list', async () => {
  const listed = await capture({ ...base, evals: LIST }, () => [])
  assert.match(listed.prompts['review:X1#1'], /Every blocker and major of yours needs an `eval`: \{ kind, statement, check \}/)
  assert.match(listed.prompts['review:X1#1'], /behaviour, error path, regression, quality bar, size limit, time bound, reference/)
  assert.match(listed.prompts['review:X1#1'], /sent back to you once/)
  const plain = await capture({ ...base }, () => [], { evals: false })
  assert.doesNotMatch(plain.prompts['review:X1#1'], /needs an `eval`/)
})

test('E04-2 the request for a missing eval names the finding and the rule', async () => {
  const bare = [{ severity: 'major', title: 'cache race', detail: 'd' }]
  const got = await capture({ ...base, evals: LIST }, label => label === 'review:X1#1' ? bare : [])
  assert.match(got.prompts['review:X1#1e'], /write the missing evals/)
  assert.match(got.prompts['review:X1#1e'], /"title": "cache race"/)
  assert.match(got.prompts['review:X1#1e'], /Every blocker and major of yours needs an `eval`/)
  assert.equal(got.result.reason, 'needs human: review after evals')
})

test('E04 the reviewer agent file holds the eval rule', () => {
  const body = read('agents/reviewer.md')
  assert.match(body, /## Evals/)
  assert.match(body, /Give each blocker and major of your own an `eval`: `\{ kind, statement, check \}`/)
  assert.match(body, /sent back to you once, and then it stops the PR/)
  assert.match(body, /A failed invariant needs no eval/)
})

test('#635 a scope stop asks for a threat model only for a security theme', async () => {
  const stuck = theme => label => label === 'review:X1#1' || label === 'review:X1#2' ? [{ severity: 'major', title: label, detail: 'd', theme }] : []
  const security = await capture({ ...base }, stuck('bypass of the path check'), { evals: false })
  assert.equal(security.result.reason, 'needs human: scope')
  assert.match(security.result.escalation.question, /threat model/)
  const plain = await capture({ ...base }, stuck('naming of the helper'), { evals: false })
  assert.equal(plain.result.reason, 'needs human: scope')
  assert.doesNotMatch(JSON.stringify(plain.result.escalation), /threat model/)
  assert.match(plain.result.escalation.options[0], /resume\.designRules/)
})

test('#635 a theme that only contains a security stem is not a security theme', async () => {
  const stuck = theme => label => label === 'review:X1#1' || label === 'review:X1#2' ? [{ severity: 'major', title: label, detail: 'd', theme }] : []
  for (const theme of ['forgotten cleanup of the temp dir', 'authoring of the help text', 'memory leak in the poller']) {
    const out = await capture({ ...base }, stuck(theme), { evals: false })
    assert.equal(out.result.reason, 'needs human: scope', theme)
    assert.doesNotMatch(JSON.stringify(out.result.escalation), /threat model/, theme)
  }
})

test('a stop row in the resume history does not count as a round', async () => {
  const history = [{ round: 1, blockersAndMajors: 1 }, { round: 'stop', stop: 'rounds exhausted' }]
  const out = await capture({ ...base, resume: { history, minors: [], findings: [], evals: LIST } }, label => label === 'review:X1#2' ? [] : [finding('x')])
  assert.ok(out.prompts['review:X1#2'], 'the next round is 2')
  assert.equal(out.prompts['review:X1#3'], undefined)
})
