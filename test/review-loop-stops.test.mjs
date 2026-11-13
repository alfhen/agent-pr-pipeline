// BR1: the security-theme question at a scope stop, and the flaky-rerun stops of reviewLoop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../workflows/run-wave.js', import.meta.url), 'utf8').replace('export const meta', 'const meta')
const LIST = [{ id: 'X1-1', kind: 'behaviour', statement: 's1', check: 'c1' }, { id: 'X1-2', kind: 'error path', statement: 's2', check: 'c2' }]
const args = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', feedback: false, cleanup: false }
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)

async function capture(pr, answers, extra = {}) {
  const calls = []
  const agent = async (prompt, o) => {
    calls.push(o.label)
    const own = answers(o.label)
    if (own !== undefined) return own
    if (o.label.startsWith('preflight')) return { ok: true, exists: true, goals: 1, nonGoals: 1, missing: [] }
    if (o.label.startsWith('evalsarch')) return { verdict: 'ok', notes: '' }
    if (o.label.startsWith('implement')) return { pushed: true, branch: 'b', summary: 's', acceptanceTestPassed: true }
    if (o.label.startsWith('review:')) return { summary: 's', findings: [] }
    if (o.label.startsWith('verify')) return { pass: true, headSha: 'sha', checks: [{ name: 'lint', pass: true }], evals: LIST.map(e => ({ id: e.id, result: 'pass', breakCheck: 'fails-without-change' })) }
    if (o.label.startsWith('test:')) return { pass: true, headSha: 'sha', checks: [{ name: 'lint', pass: true }] }
    if (o.label.startsWith('arch:')) return { verdict: 'fits', summary: 's', newConcepts: [] }
    if (o.label.startsWith('fix:')) return { summary: 's', changed: true }
    return null
  }
  const out = await run({ ...args, ...extra, prs: [pr] }, agent, async thunks => Promise.all(thunks.map(t => t().catch(() => null))), () => {})
  return { calls, result: out.prs[0] }
}
const base = { id: 'X1', title: 't', branch: 'b' }
const stuck = theme => label => label === 'review:X1#1' || label === 'review:X1#2' ? { summary: 's', findings: [{ severity: 'major', title: label, detail: 'd', theme }] } : undefined

test('a repeated theme with a negation prefix, forged record, qualified leak, escape or web attack gets the threat-model question', async () => {
  for (const theme of ['insecure temp file', 'unauthorized access to the API', 'unauthenticated endpoint', 'unsanitized input', 'forged signal', 'forged record', 'token leak in logs', 'sandbox escape', 'shell escaping of the branch name', 'XSS in the report page', 'SSRF via the URL field', 'CSRF', 'data exposure', 'denial of service', 'privilege escalation', 'bypass of the path check']) {
    const out = await capture(base, stuck(theme), { evals: false })
    assert.equal(out.result.reason, 'needs human: scope', theme)
    assert.match(out.result.escalation.question, /threat model/, theme)
  }
})

test('a repeated theme in ordinary wording gets the design-rule question', async () => {
  for (const theme of ['Escalation path for the person', 'forgotten cleanup of the temp dir', 'authoring of the help text', 'memory leak in the poller', 'naming of the helper']) {
    const out = await capture(base, stuck(theme), { evals: false })
    assert.equal(out.result.reason, 'needs human: scope', theme)
    assert.doesNotMatch(JSON.stringify(out.result.escalation), /threat model/, theme)
    assert.match(out.result.escalation.options[0], /resume\.designRules/, theme)
  }
})

test('the cap stop for the unreachable no reviewer round is gone', () => {
  assert.equal(src.includes('no reviewer round'), false)
})

test('a flaky check that passes on the rerun before the cap runs the next round, and one in the last round stops with the cap reason', async () => {
  const failing = { pass: false, headSha: 'sha', checks: [{ name: 'lint', pass: false }], evals: LIST.map(e => ({ id: e.id, result: 'pass', breakCheck: 'fails-without-change' })) }
  const answers = label => label === 'verify:X1#1' ? failing : label === 'verify:X1#1r' ? { ...failing, pass: true, checks: [{ name: 'lint', pass: true }] } : label === 'fix:X1#1' ? { summary: 's', changed: false } : undefined
  const a = await capture({ ...base, evals: LIST }, answers)
  for (const label of ['verify:X1#1r', 'verify:X1#2', 'review:X1#2']) assert.ok(a.calls.includes(label), label)
  const b = await capture({ ...base, evals: LIST, maxRounds: 1 }, answers)
  assert.equal(b.result.reason, 'rounds exhausted: 1 of 1 (prs[].maxRounds)')
  assert.ok(!b.calls.includes('fix:X1#1'))
})
