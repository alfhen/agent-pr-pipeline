// Prompt text for eval misses in the evaluator step: evaluatePrompt in run-wave.js and agents/evaluator.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../workflows/run-wave.js', import.meta.url), 'utf8').replace('export const meta', 'const meta')
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)
const base = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', cleanup: false, prs: [{ id: 'X1', title: 't', branch: 'feat/x' }] }

async function evaluatePrompt(extra) {
  let prompt = null
  const agent = async (p, o) => {
    if (o.label === 'evaluate:wave') { prompt = p; return { items: [], changedPaths: [] } }
    if (o.label.startsWith('preflight')) return { ok: true, exists: true, goals: 1, nonGoals: 1, missing: [] }
    if (o.label.startsWith('implement')) return { pushed: false, branch: 'b', summary: 's', acceptanceTestPassed: false }
    return null
  }
  await run({ ...base, ...extra }, agent, async thunks => Promise.all(thunks.map(t => t().catch(() => null))), () => {})
  return prompt
}

const withRoot = await evaluatePrompt({ feedback: true, pluginRoot: '/plugin' })
const noRoot = await evaluatePrompt({ feedback: true })
const agentFile = readFileSync(new URL('../agents/evaluator.md', import.meta.url), 'utf8')

test('E06-3 the evaluator prompt names an eval miss as an item for the evals writer and gives the ledger command', () => {
  assert.ok(withRoot, 'the evaluator ran')
  const rule = text => /A PR with `?codeChangedByBots`? true is an eval miss[^.]*\./.exec(text.replaceAll('`', ''))
  assert.ok(rule(withRoot) && rule(agentFile), 'both texts state the rule')
  assert.equal(rule(withRoot)[0], rule(agentFile)[0])
  assert.doesNotMatch(withRoot, /A ready PR with `?codeChangedByBots`? true/)
  assert.doesNotMatch(agentFile, /A ready PR with `?codeChangedByBots`? true/)
  assert.match(withRoot, /item for the evals writer, with what the bot found/)
  assert.match(withRoot, /bash \/plugin\/scripts\/ledger\.sh o\/r report/)
})

test('E06-3 the evaluator agent file names eval misses and the report command', () => {
  assert.match(agentFile, /eval miss/)
  assert.match(agentFile, /evals writer/)
  assert.match(agentFile, /ledger\.sh <repo> report/)
})

test('E06-5 a failed ledger read does not stop the evaluation and no number is made up', () => {
  assert.match(withRoot, /If it fails, for example when the repo has no ledger issue, give no number of earlier runs and file no item about the failure/)
  assert.match(agentFile, /If the report fails, for example when the repo has no ledger issue, file no item about the failure/)
  assert.match(agentFile, /never a number you did not read/)
})

test('E06-5 with no plugin root the prompt gives no ledger command and no numbers', () => {
  assert.ok(noRoot, 'the evaluator ran')
  assert.ok(!/ledger\.sh/.test(noRoot))
  assert.match(noRoot, /give no numbers of earlier runs/)
})
