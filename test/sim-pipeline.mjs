// Runs workflow/pr-pipeline.js against a fake agent() that returns schema-shaped answers.
// Usage: node test/sim-pipeline.mjs (exits non-zero on the first failed check).
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../workflows/run-wave.js', import.meta.url), 'utf8').replace('export const meta', 'const meta')
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)

let calls = []
let preflight
let failWait = false
let redactor = 'ok'
const ITEMS = [
  { title: 'Bot wait reports pending', detail: 'd', evidence: 'C1 botwait', suggestedChange: 'c', severity: 'major' },
  { title: 'Docs step has no timeout', detail: 'd', evidence: 'e', suggestedChange: 'c', severity: 'minor' },
]
const REDACTED = ITEMS.map(i => ({ ...i, title: `generic: ${i.title}`, detail: 'generic detail' }))
const briefs = {}
const storedInstead = {}
const triage = (decision, size, risk, extra = {}) => ({
  decision, size, risk, why: `why ${decision} ${size} ${risk}`, newConcepts: [],
  ...(decision === 'build' ? { entry: { touches: 'src/x.js', acceptance: 'node --test passes' } } : {}), ...extra,
})
const TRIAGES = {
  QS: triage('build', 'S', 'low'), QN: triage('build', 'S', 'low', { newConcepts: ['job queue'] }),
  QM: triage('build', 'M', 'medium'), QF: triage('build', 'M', 'medium'), QY: triage('build', 'M', 'medium'),
  QL: triage('build', 'L', 'low'), QH: triage('build', 'S', 'high'),
  QP: triage('plan', 'M', 'medium'), QD: triage('decline', 'S', 'low'),
  QA: triage('build', 'S', 'low', { entry: { touches: 'src/x.js', acceptance: 'node --test passes', qa: 'try --words with empty input' } }),
  QE: triage('build', 'S', 'low'), QT: triage('build', 'S', 'low'),
}
let evaluation = { items: ITEMS, changedPaths: ['src/billing/invoice.ts', 'README.md'] }
let corruptPut = false
// Merge safety: ids the gate holds, ids the agent calls person, and ids where an agent fails or answers badly.
const land = { gated: new Set(), person: new Set(), gateDown: new Set(), safetyDown: new Set(), statusDown: new Set(), gateOdd: new Set(), headMoved: new Set() }
const lastHead = {}
const agentRaw = async (prompt, o) => {
  calls.push({ label: o.label, model: o.model, effort: o.effort, agentType: o.agentType, isolation: o.isolation, prompt })
  const id = o.label.split(':')[1].split('#')[0]
  if (o.label.startsWith('preflight')) return preflight
  if (o.label.startsWith('triage')) return TRIAGES[id]
  if (o.label.startsWith('safety')) return land.safetyDown.has(id) ? null : land.person.has(id) ? { verdict: 'person', why: 'renames the --all flag' } : { verdict: 'safe', why: 'internal change' }
  if (o.label.startsWith('io:') && o.label.endsWith('#gate')) {
    if (land.gateDown.has(id)) return null
    if (land.gateOdd.has(id)) return { exitCode: 0, output: 'GATED #1: scripts/x.sh' }
    return land.gated.has(id) ? { exitCode: 1, output: 'GATED #1: scripts/merge-pr.sh' } : { exitCode: 0, output: 'not gated #1' }
  }
  if (o.label.startsWith('io:') && o.label.endsWith('#botstatus')) {
    return land.statusDown.has(id) ? { exitCode: 1, output: 'bot-status: cannot read the reviews' } : { exitCode: 0, output: JSON.stringify({ head: land.headMoved.has(id) ? 'moved' : lastHead[id], approvedBy: ['gitar-bot'], openThreads: 0 }) }
  }
  if (o.label.startsWith('io:')) {
    if (o.label.endsWith('#put')) {
      const posted = Buffer.from(/--b64 (\S+)/.exec(prompt)[1], 'base64').toString('utf8')
      if (corruptPut) return { exitCode: 65, output: 'quick-brief: the entry does not match its checksum; nothing posted' }
      briefs[id] = storedInstead[id] || posted
      return { exitCode: 0, output: briefs[id] }
    }
    return briefs[id] ? { exitCode: 0, output: briefs[id] } : { exitCode: 1, output: 'quick-brief: no trusted brief on issue 1' }
  }
  if (o.label.startsWith('evaluate')) return evaluation
  if (o.label.startsWith('redact')) {
    if (redactor === 'null') return null
    return { items: JSON.parse(prompt.slice(prompt.indexOf('[{'))).map(i => ({ ...i, title: `generic: ${i.title}`, detail: 'generic detail' })) }
  }
  if (o.label.startsWith('product')) {
    if (id === 'P2') return { verdict: 'escalate', summary: 's', entries: [{ entry: 'V04 MCP server', fit: 'widens-scope', suggestion: 'cut' }], escalation: { question: 'Keep the product CLI only?', recommendation: 'cut V04' } }
    if (id === 'QE') return { verdict: 'escalate', summary: 's', entries: [{ entry: 'QE', fit: 'non-goal' }], escalation: { question: 'Add a hosted mode?', recommendation: 'decline' } }
    if (id === 'QT') return { verdict: 'notes', summary: 's', entries: [{ entry: 'QT', fit: 'widens-scope', note: 'extra flag', suggestion: 'trim' }] }
    if (id === 'P3') return { verdict: 'notes', summary: 's', entries: [{ entry: 'H08', fit: 'widens-scope', note: 'polish', suggestion: 'defer' }] }
    return { verdict: 'aligned', summary: 's', entries: [] }
  }
  if (o.label.startsWith('arch')) {
    const round = Number(o.label.split('#')[1])
    if (id === 'E1') return { verdict: 'escalate', summary: 's', newConcepts: [{ name: 'queue', fits: false }], escalation: { question: 'Add a job queue?', options: ['a', 'b'], recommendation: 'a' } }
    if (id === 'N1' && round === 1) return { verdict: 'needs-change', summary: 's', newConcepts: [{ name: 'x', fits: false }], findings: [{ title: 'wrong layer', detail: 'd' }] }
    return { verdict: 'fits', summary: 's', newConcepts: [] }
  }
  if (o.label.startsWith('implement')) return { pushed: true, branch: 'b', summary: 's', acceptanceTestPassed: true }
  const round = o.label.split('#')[1] || ''
  if (o.label.startsWith('test')) return { pass: true, headSha: 'sha-' + id + (/^(docs|bots)/.test(round) ? '-' + round : ''), checks: [{ name: 'lint', pass: true }] }
  if (o.label.startsWith('botreview')) return { summary: 's', findings: id === 'B1' && round === '1' ? [{ severity: 'major', title: 'the new regex anchor rejects valid input', detail: 'd' }] : [{ severity: 'minor', title: 'late nit', detail: 'd' }] }
  if (o.label.startsWith('docsreview')) {
    const major = id === 'G3' || (id === 'G2' && round === '1')
    return { summary: 's', findings: major ? [{ severity: 'major', title: 'docs say the flag is --all, code has --every', detail: 'd' }] : [] }
  }
  if (o.label.startsWith('qa')) return (id === 'Q1' && round === '1')
    ? { summary: 's', scenarios: [{ name: '--words with empty input', command: "printf '' | tally --words", expected: '0', actual: '1', pass: false }], findings: [{ severity: 'major', title: 'empty input prints 1', detail: 'd' }, { severity: 'minor', title: 'help wording', detail: 'd' }] }
    : { summary: 's', scenarios: [{ name: 'acceptance', pass: true }], findings: [] }
  if (o.label.startsWith('docsfix')) return { changed: true, headSha: 'docsfix-' + id, files: ['README.md'], summary: 's' }
  if (o.label.startsWith('docs')) return ['G1', 'G2', 'G3'].includes(id) ? { changed: true, headSha: 'docs-' + id, files: ['README.md'], summary: 's' } : { changed: false, summary: 'already right' }
  if (o.label.startsWith('review')) return { summary: 's', findings: id === 'P1' || ['QS', 'QY'].includes(id) || (id === 'QF' && round === '1') ? [{ severity: 'major', title: 'x', detail: 'd' }] : [{ severity: 'minor', title: 'm', detail: 'd' }] }
  if (o.label.startsWith('open')) return { prNumber: 100 + calls.length, prUrl: 'u', issuesCreated: id === 'C2' ? ['https://github.com/o/r/issues/21'] : [] }
  if (o.label.startsWith('botwait')) return id === 'C1' && failWait ? null : { approvedBy: ['the-waiter-says-so'], openComments: ['C2', 'L1', 'B1', 'W1'].includes(id) ? 2 : 0 }
  if (o.label.startsWith('botanswer')) return { codeChanged: id !== 'W1', headSha: 'sha-answer-' + id, closesIssues: id === 'C2' ? [21] : [], notes: 'anchored the regex' }
  if (o.label.startsWith('landfix')) return { readyToMerge: true, headSha: 'abc', notes: 'ok' }
  return null
}
const agent = async (prompt, o) => {
  const out = await agentRaw(prompt, o)
  if (out && out.headSha) lastHead[o.label.split(':')[1].split('#')[0]] = out.headSha
  return out
}
const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
const log = () => {}

const PRS = [
  { id: 'E1', title: 't', branch: 'b5' },
  { id: 'N1', title: 't', branch: 'b6' },
  { id: 'D1', title: 't', branch: 'b7', kind: 'docs' },
  { id: 'C1', title: 't', branch: 'b1' },
  { id: 'C2', title: 't', branch: 'b2' },
  { id: 'P1', title: 'plan', branch: 'b3', kind: 'plan', skipImpl: true },
  { id: 'L1', title: 't', branch: 'b4', landFix: true, prNumber: 7 },
  { id: 'P2', title: 'plan2', branch: 'b8', kind: 'plan', skipImpl: true },
  { id: 'P3', title: 'plan3', branch: 'b9', kind: 'plan', skipImpl: true },
  { id: 'G1', title: 't', branch: 'b10' },
  { id: 'G2', title: 't', branch: 'b11' },
  { id: 'G3', title: 't', branch: 'b12' },
  { id: 'G4', title: 't', branch: 'b13', docsUpdate: false },
  { id: 'Q1', title: 't', branch: 'b14', qa: 'try --words with empty input' },
  { id: 'Q2', title: 't', branch: 'b15', qa: true },
  { id: 'B1', title: 't', branch: 'b16' },
  { id: 'W1', title: 't', branch: 'b17' },
]
const base = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', pluginRoot: '/plug', prs: PRS }
const GOOD = { ok: true, exists: true, goals: 3, nonGoals: 2, missing: [] }
let lastResult
const simulate = async (args, pre = GOOD) => {
  calls = []
  preflight = pre
  const out = await run(args, agent, parallel, log)
  lastResult = out
  return Object.fromEntries(out.prs.map(r => [r.id, r]))
}
const check = async (name, fn) => { await fn(); console.log('ok  ' + name) }

// Main run: every path except the failures.
const r = await simulate(base)
const mainCalls = calls
const mainResult = lastResult
await check('clean code PR lands at the tested sha', () => {
  assert.equal(r.C1.ready, true)
  assert.equal(r.C1.land.split(':')[1], 'sha-C1')
  assert.equal(r.C1.land.split(':')[2], 'auto')
  assert.equal(r.C1.rounds, 1)
})
await check('a bot answer that changed code is tested and reviewed on its diff before it can land', () => {
  assert.equal(r.C2.ready, true)
  assert.equal(r.C2.codeChangedByBots, true)
  assert.equal(r.C2.land.split(':')[1], 'sha-C2-bots1')
  const review = mainCalls.find(c => c.label === 'botreview:C2#1')
  assert.equal(review.agentType, 'agent-pr-pipeline:reviewer')
  assert.equal(review.model, 'opus')
  assert.match(review.prompt, /git diff sha-C2\.\.HEAD/)
  assert.match(review.prompt, /anchored the regex/)
  assert.ok(mainCalls.some(c => c.label === 'test:C2#bots1'))
  assert.deepEqual(r.C2.lateMinors.map(f => f.title), ['late nit'])
})
await check('a bot answer gets the filed minor issues and reports the ones it closes', () => {
  assert.match(mainCalls.find(c => c.label === 'botanswer:C2').prompt, /issues\/21/)
  assert.deepEqual(r.C2.closesIssues, [21])
})
await check('a finding in the bot answer check gets a fix round and a second check', () => {
  assert.ok(mainCalls.some(c => c.label === 'fix:B1#bots1'))
  assert.equal(r.B1.ready, true)
  assert.equal(r.B1.land.split(':')[1], 'sha-B1-bots2')
})
await check('a bot answer in words only needs no check', () => {
  assert.equal(r.W1.ready, true)
  assert.ok(!mainCalls.some(c => /^(botreview|test):W1#bots/.test(c.label)))
  assert.equal(r.W1.land.split(':')[1], 'sha-W1')
})
await check('docs PR skips architecture and uses the docs reviewer', () => {
  assert.equal(r.D1.ready, true)
  assert.deepEqual(r.D1.architecture, [])
  assert.equal(mainCalls.find(c => c.label === 'review:D1#1').model, 'sonnet')
})
await check('plan PR stops after planRounds', () => {
  assert.equal(r.P1.ready, false)
  assert.equal(r.P1.reason, 'rounds exhausted')
  assert.equal(r.P1.history.length, 2)
  assert.equal(r.P1.product.verdict, 'aligned')
})
await check('land fix runs the land fixer, then waits for and answers the bots on the new head', () => {
  assert.equal(r.L1.ready, true)
  assert.deepEqual(mainCalls.filter(c => c.label.includes(':L1')).map(c => c.label), ['landfix:L1', 'botwait:L1', 'io:L1#botstatus', 'botanswer:L1', 'test:L1#bots1', 'botreview:L1#1', 'io:L1#gate', 'safety:L1#land'])
  assert.equal(r.L1.land, '7:sha-L1-bots1:auto')
})
await check('architecture escalate stops the PR with the question', () => {
  assert.equal(r.E1.ready, false)
  assert.equal(r.E1.reason, 'needs human: architecture')
  assert.equal(r.E1.escalation.question, 'Add a job queue?')
})
await check('architecture needs-change gets a fix round, then fits', () => {
  assert.equal(r.N1.ready, true)
  assert.deepEqual(r.N1.architecture.map(a => a.verdict), ['needs-change', 'fits'])
  assert.ok(mainCalls.some(c => c.label === 'fix:N1#1'))
})
await check('product escalate stops the plan with the question', () => {
  assert.equal(r.P2.ready, false)
  assert.equal(r.P2.reason, 'needs human: product')
  assert.equal(r.P2.escalation.question, 'Keep the product CLI only?')
})
await check('product notes become minors and the plan goes on', () => {
  assert.equal(r.P3.ready, true)
  assert.equal(r.P3.product.verdict, 'notes')
  assert.match(mainCalls.find(c => c.label === 'open:P3').prompt, /Product fit: H08/)
})
await check('preflight runs once on haiku/low', () => {
  assert.deepEqual(mainCalls.filter(c => c.label.startsWith('preflight')).map(c => `${c.model}/${c.effort}`), ['haiku/low'])
})
await check('docs agent runs on code PRs only, and not when a PR turns it off', () => {
  const ran = new Set(mainCalls.filter(c => c.label.startsWith('docs:')).map(c => c.label.split(':')[1]))
  assert.deepEqual([...ran].sort(), ['B1', 'C1', 'C2', 'G1', 'G2', 'G3', 'N1', 'Q1', 'Q2', 'W1'])
})
await check('QA runs only on PRs with qa set, in parallel with the reviewer', () => {
  const ran = new Set(mainCalls.filter(c => c.label.startsWith('qa:')).map(c => c.label.split(':')[1].split('#')[0]))
  assert.deepEqual([...ran].sort(), ['Q1', 'Q2'])
  assert.equal(mainCalls.find(c => c.label === 'qa:Q1#1').model, 'sonnet')
  assert.equal(mainCalls.find(c => c.label === 'qa:Q1#1').effort, 'medium')
  assert.match(mainCalls.find(c => c.label === 'qa:Q1#1').prompt, /What to try: try --words with empty input/)
  assert.match(mainCalls.find(c => c.label === 'qa:Q2#1').prompt, /QA line, if it has one/)
  for (const label of ['qa:Q1#1', 'qa:Q2#1']) assert.doesNotMatch(mainCalls.find(c => c.label === label).prompt, /findings from the last round/, label)
})
await check('a QA major gets a fix round and QA checks it again; a clean QA does not rerun', () => {
  assert.ok(mainCalls.some(c => c.label === 'fix:Q1#1'))
  assert.match(mainCalls.find(c => c.label === 'fix:Q1#1').prompt, /empty input prints 1/)
  assert.match(mainCalls.find(c => c.label === 'qa:Q1#2').prompt, /Your findings from the last round[\s\S]*empty input prints 1/)
  assert.equal(r.Q1.ready, true)
  assert.deepEqual(r.Q1.qa.map(q => q.failed.length), [1, 0])
  assert.match(mainCalls.find(c => c.label === 'open:Q1').prompt, /help wording/)
  assert.ok(!mainCalls.some(c => c.label === 'qa:Q2#2'))
})
await check('qa "all" runs QA on every code PR, never on docs or plan PRs', async () => {
  await simulate({ ...base, qa: 'all' })
  const ran = new Set(calls.filter(c => c.label.startsWith('qa:')).map(c => c.label.split(':')[1].split('#')[0]))
  assert.ok(ran.has('C1') && ran.has('G4'))
  assert.ok(!ran.has('D1') && !ran.has('P1') && !ran.has('L1'))
})
await check('unchanged docs keep the reviewed sha and skip the re-check', () => {
  assert.equal(r.C1.docs.changed, false)
  assert.ok(!mainCalls.some(c => c.label.startsWith('docsreview:C1') || c.label === 'test:C1#docs1'))
})
await check('changed docs are re-checked and land at the re-checked sha', () => {
  assert.equal(r.G1.ready, true)
  assert.equal(r.G1.land.split(':')[1], 'sha-G1-docs1')
  assert.deepEqual(r.G1.docs.files, ['README.md'])
  const order = mainCalls.filter(c => c.label.includes(':G1')).map(c => c.label.split(':')[0])
  assert.ok(order.indexOf('docs') > order.lastIndexOf('review') && order.indexOf('docs') < order.indexOf('open'))
  assert.equal(mainCalls.find(c => c.label === 'docsreview:G1#1').model, 'sonnet')
})
await check('a docs finding gets a docs-only fix by the docs writer, then a second check', () => {
  assert.equal(r.G2.ready, true)
  const fix = mainCalls.find(c => c.label === 'docsfix:G2#1')
  assert.ok(fix)
  assert.match(fix.prompt, /Change docs only/)
  assert.match(fix.prompt, /git diff --stat sha-G2\.\.HEAD/)
  assert.ok(!mainCalls.some(c => /^fix:G\d#docs/.test(c.label)), 'the code fixer never runs in a docs round')
  assert.equal(r.G2.land.split(':')[1], 'sha-G2-docs2')
})
await check('docs findings left after docsRounds stop the PR', () => {
  assert.equal(r.G3.ready, false)
  assert.equal(r.G3.reason, 'docs check: rounds exhausted')
  assert.ok(!mainCalls.some(c => c.label === 'open:G3'))
})
await check('docsUpdate false turns it off for the wave', async () => {
  await simulate({ ...base, docsUpdate: false })
  assert.ok(!calls.some(c => c.label.startsWith('docs')))
})
await check('no skill instruction without a skills argument', () => {
  assert.ok(mainCalls.every(c => !c.prompt.includes('Skill tool')))
})

failWait = true
const w = await simulate(base)
failWait = false
await check('without pluginRoot the PR stops at the bot step and no waiter runs', async () => {
  const { pluginRoot, ...noRoot } = base
  const nr = await simulate({ ...noRoot, prs: PRS.filter(p => p.id === 'C1') })
  assert.equal(nr.C1.ready, false)
  assert.match(nr.C1.reason, /^pluginRoot missing/)
  assert.ok(!calls.some(c => /^(botwait|io|safety):/.test(c.label)))
})
await check('failed bot wait is not ready', () => {
  assert.equal(w.C1.ready, false)
  assert.equal(w.C1.reason, 'bot wait failed')
})

const refused = await simulate(base, { ok: false, exists: true, goals: 2, nonGoals: 0, missing: ['Non-goals items'] })
const refusedResult = lastResult
const refusedCalls = calls
await check('incomplete goals refuse the wave after one agent', () => {
  assert.ok(Object.values(refused).every(x => x.refused && !x.ready))
  assert.match(refused.C1.reason, /Non-goals items/)
  assert.deepEqual(calls.map(c => c.label), ['preflight:goals', 'evaluate:wave', 'redact:wave'])
})

await check('missing goals argument throws before any agent', () => {
  calls = []
  return assert.rejects(run({ ...base, goals: undefined }, agent, parallel, log), /args needs goals/)
})

// End-of-run evaluation and feedback.
const lastIndex = (cs, re) => cs.map(c => re.test(c.label)).lastIndexOf(true)
await check('the evaluator runs once per wave, after the last PR, on sonnet/medium', () => {
  const ev = mainCalls.filter(c => c.label.startsWith('evaluate'))
  assert.equal(ev.length, 1)
  assert.equal(mainCalls.indexOf(ev[0]), mainCalls.length - 2)
  assert.ok(mainCalls.indexOf(ev[0]) > lastIndex(mainCalls, /^(?!evaluate|redact)/))
  assert.equal(`${ev[0].model}/${ev[0].effort}`, 'sonnet/medium')
  assert.match(ev[0].prompt, /"id":"C1"/)
  assert.match(ev[0].prompt, /repos\/o\/r\/pulls\/<n>\/files/)
})
await check('the result has the shape { prs, feedback, denylist, source, feedbackRepo }', () => {
  assert.deepEqual(Object.keys(mainResult).sort(), ['denylist', 'feedback', 'feedbackRepo', 'prs', 'source'])
  assert.equal(mainResult.source, 'o/r')
  assert.equal(mainResult.feedbackRepo, 'alfhen/agent-pr-pipeline')
  assert.ok(Array.isArray(mainResult.prs) && mainResult.prs.length === PRS.length)
})
await check('for another repo the redactor runs once on haiku/low, its prompt names the repo to remove, and its output is the feedback', () => {
  const red = mainCalls.filter(c => c.label.startsWith('redact'))
  assert.equal(red.length, 1)
  assert.equal(`${red[0].model}/${red[0].effort}`, 'haiku/low')
  assert.match(red[0].prompt, /the owner "o"/)
  assert.match(red[0].prompt, /the name "r"/)
  assert.match(red[0].prompt, /source repo o\/r:/)
  assert.ok(red[0].prompt.includes(JSON.stringify(ITEMS)))
  assert.deepEqual(mainResult.feedback, REDACTED)
  assert.notDeepEqual(mainResult.feedback, ITEMS)
})
await check('a redactor that returns nothing leaves no feedback, keeps the denylist and the prs', async () => {
  redactor = 'null'
  try { await simulate(base) } finally { redactor = 'ok' }
  assert.deepEqual(lastResult.feedback, [])
  assert.deepEqual(lastResult.denylist, ['o', 'r', 'o/r', 'https://github.com/o/r', 'src/billing/invoice.ts', 'README.md'])
  assert.equal(lastResult.prs.length, PRS.length)
  assert.equal(calls.filter(c => c.label.startsWith('redact')).length, 1)
})
await check('a landFix-only run starts no evaluate or redact agent', async () => {
  await simulate({ ...base, prs: PRS.filter(p => p.landFix) })
  assert.ok(calls.length > 0 && calls.every(c => !/^(evaluate|redact)/.test(c.label)))
  assert.deepEqual(lastResult.feedback, [])
  assert.deepEqual(lastResult.denylist, [])
})
await check('the denylist holds the repo owner, name, URL and the changed paths', () => {
  assert.deepEqual(mainResult.denylist, ['o', 'r', 'o/r', 'https://github.com/o/r', 'src/billing/invoice.ts', 'README.md'])
})
await check('for the feedback repo itself there is no redactor and the denylist is empty', async () => {
  await simulate({ ...base, repo: 'alfhen/agent-pr-pipeline' })
  assert.ok(!calls.some(c => c.label.startsWith('redact')))
  assert.equal(calls.filter(c => c.label.startsWith('evaluate')).length, 1)
  assert.deepEqual(lastResult.denylist, [])
  assert.equal(lastResult.feedback.length, 2)
})
await check('feedbackRepo makes another repo the target', async () => {
  await simulate({ ...base, repo: 'x/y', feedbackRepo: 'x/y' })
  assert.ok(!calls.some(c => c.label.startsWith('redact')))
})
await check('feedback false turns the step off and keeps the result shape', async () => {
  await simulate({ ...base, feedback: false })
  assert.ok(!calls.some(c => /^(evaluate|redact)/.test(c.label)))
  assert.deepEqual(lastResult.feedback, [])
  assert.deepEqual(lastResult.denylist, [])
  assert.equal(lastResult.prs.length, PRS.length)
})
await check('a failed evaluation gives no feedback and does not fail the wave', async () => {
  evaluation = null
  await simulate(base)
  evaluation = { items: ITEMS, changedPaths: ['src/billing/invoice.ts', 'README.md'] }
  assert.deepEqual(lastResult.feedback, [])
  assert.ok(!calls.some(c => c.label.startsWith('redact')))
  assert.equal(lastResult.prs.length, PRS.length)
})
await check('a refused wave still gets an evaluation, with the refusals in prs', () => {
  assert.deepEqual(refusedResult.feedback, REDACTED)
  assert.deepEqual(Object.keys(refusedResult).sort(), ['denylist', 'feedback', 'feedbackRepo', 'prs', 'source'])
  assert.ok(refusedResult.prs.every(x => x.refused))
  assert.match(refusedCalls.find(c => c.label === 'evaluate:wave').prompt, /"refused":true/)
})

// Skill pairing.
const SKILLS = {
  impl: ['laravel-idioms:laravel-idioms', 'context7-mcp'],
  fix: ['laravel-idioms:laravel-idioms'],
  open: ['humanizer:humanizer'],
  botAnswer: ['humanizer:humanizer'],
  docs: ['humanizer:humanizer'],
  preflight: ['goals-helper'],
}
const prsWithSkills = PRS.map(pr =>
  pr.id === 'C1' ? { ...pr, sensitive: true }
    : pr.id === 'D1' ? { ...pr, skills: { impl: ['humanizer:humanizer'], review: ['humanizer:humanizer'] } }
      : pr)
await simulate({ ...base, skills: SKILLS, prs: prsWithSkills })
const STEP_OF = { botreview: 'review', qa: 'qa', docs: 'docs', docsfix: 'docs', docsreview: 'docs', implement: 'impl', test: 'test', review: 'review', arch: 'arch', product: 'product', fix: 'fix', open: 'open', botwait: 'botWait', botanswer: 'botAnswer', landfix: 'landFix', preflight: 'preflight', evaluate: 'evaluate', redact: 'redact' }
const expected = c => {
  const step = STEP_OF[c.label.split(':')[0]]
  const id = c.label.split(':')[1].split('#')[0]
  const names = [...(SKILLS[step] || [])]
  if (id === 'D1' && (step === 'impl' || step === 'review')) names.push('humanizer:humanizer')
  if (id === 'C1' && step === 'review') names.push('security-review')
  return names
}
const loaded = c => {
  const m = c.prompt.match(/^Before you do anything else, load these skills with the Skill tool: ([^.]+)\./)
  return m ? m[1].split(', ').map(n => n.replace(/`/g, '')) : []
}
await check('skill instruction appears only in the configured steps', () => {
  const seen = new Set(calls.map(c => STEP_OF[c.label.split(':')[0]]))
  for (const step of ['impl', 'test', 'review', 'qa', 'arch', 'product', 'fix', 'docs', 'open', 'botWait', 'botAnswer', 'landFix', 'preflight']) assert.ok(seen.has(step), `simulation never ran ${step}`)
  for (const c of calls) {
    assert.deepEqual(loaded(c), expected(c), c.label)
    if (!loaded(c).length) assert.ok(!c.prompt.includes('Skill tool'), c.label)
  }
})
await check('sensitive adds the security skill to the reviewer only', () => {
  const c1 = calls.filter(c => c.label.includes(':C1'))
  assert.deepEqual(c1.filter(c => loaded(c).includes('security-review')).map(c => c.label), ['review:C1#1'])
  assert.ok(calls.filter(c => !c.label.includes(':C1')).every(c => !loaded(c).includes('security-review')))
})
await check('agents that work in a clone are told to ignore git context a skill collects from their starting folder', () => {
  assert.match(calls.find(c => c.label === 'review:C1#1').prompt, /that context is from the wrong branch/)
  assert.doesNotMatch(calls.find(c => c.label === 'implement:C1').prompt, /wrong branch/)
  assert.doesNotMatch(calls.find(c => c.label === 'open:C1').prompt, /wrong branch/)
})
await check('a PR skill listed globally too is loaded once', async () => {
  await simulate({ ...base, skills: { review: ['security-review'] }, prs: [{ ...PRS[3], sensitive: true }] })
  assert.deepEqual(loaded(calls.find(c => c.label === 'review:C1#1')), ['security-review'])
})
await check('securitySkill renames the sensitive reviewer skill', async () => {
  await simulate({ ...base, securitySkill: 'my-sec:audit', prs: [{ ...PRS[3], sensitive: true }] })
  assert.deepEqual(loaded(calls.find(c => c.label === 'review:C1#1')), ['my-sec:audit'])
})
await check('an unknown step name throws', () =>
  assert.rejects(run({ ...base, skills: { implement: ['x'] } }, agent, parallel, log), /unknown step "implement"/))
await check('a skill list that is not a list of names throws', () =>
  assert.rejects(run({ ...base, prs: [{ ...PRS[3], skills: { open: 'humanizer' } }] }, agent, parallel, log), /must be a list of skill names/))

// Plugin wiring: every call names a role agent that exists, with the same defaults.
const root = new URL('../', import.meta.url)
const frontmatter = name => {
  const text = readFileSync(new URL(`agents/${name}.md`, root), 'utf8')
  return Object.fromEntries(text.split('---')[1].trim().split('\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]))
}
const AGENT_OF = { botreview: 'reviewer', qa: 'qa', docsfix: 'docs-writer', implement: 'implementer', test: 'tester', review: 'reviewer', arch: 'arch-reviewer', product: 'product-reviewer', fix: 'fixer', docs: 'docs-writer', docsreview: 'docs-reviewer', open: 'pr-opener', botwait: 'bot-waiter', botanswer: 'bot-answerer', landfix: 'land-fixer', preflight: 'goals-preflight', triage: 'triager', io: 'pipeline-io', safety: 'merge-safety', evaluate: 'evaluator', redact: 'feedback-redactor' }
const WRITERS = ['implementer', 'fixer', 'docs-writer', 'bot-answerer', 'land-fixer']
await simulate(base)
await check('every call names its role agent from the plugin', () => {
  for (const c of calls) assert.equal(c.agentType, 'agent-pr-pipeline:' + AGENT_OF[c.label.split(':')[0]], c.label)
})
await check('only writing agents run in a worktree', () => {
  for (const c of calls) assert.equal(c.isolation === 'worktree', WRITERS.includes(c.agentType.split(':')[1]), c.label)
})
await check('each agent file exists and its defaults match the workflow defaults', () => {
  const files = readdirSync(new URL('agents/', root)).map(f => f.replace(/\.md$/, '')).sort()
  assert.deepEqual(files, [...new Set(Object.values(AGENT_OF))].sort())
  const docsOrPlan = c => c.label.startsWith('review:') && /^(D|P)\d/.test(c.label.split(':')[1])
  for (const c of calls.filter(c => !docsOrPlan(c))) {
    const fm = frontmatter(c.agentType.split(':')[1])
    assert.equal(fm.name, c.agentType.split(':')[1])
    assert.equal(`${fm.model}/${fm.effort}`, `${c.model}/${c.effort}`, c.label)
  }
  assert.equal(`${calls.find(c => c.label === 'review:D1#1').model}`, 'sonnet')
})
await check('only the land fixer keeps a 1-hour cache', () => {
  for (const name of new Set(Object.values(AGENT_OF))) {
    const text = readFileSync(new URL(`agents/${name}.md`, root), 'utf8').split('---')[1]
    assert.equal(/\nexperimental:\n  cacheTtl: 1h\n/.test(text), name === 'land-fixer', name)
  }
})
await check('only the tester, bot waiter and preflight leave out CLAUDE.md', () => {
  for (const name of new Set(Object.values(AGENT_OF))) {
    assert.equal(frontmatter(name).omitClaudeMd === 'true', ['tester', 'bot-waiter', 'goals-preflight', 'pipeline-io'].includes(name), name)
  }
})
await check('read-only agents have no edit tools', () => {
  for (const name of [...new Set(Object.values(AGENT_OF))].filter(n => !WRITERS.includes(n) && n !== 'qa')) {
    const tools = frontmatter(name).tools
    assert.ok(tools && !/\b(Edit|Write|NotebookEdit|Agent)\b/.test(tools), name)
  }
  assert.equal(frontmatter('qa').tools, undefined, 'qa keeps browser and other MCP tools')
  assert.deepEqual(frontmatter('qa').disallowedTools.split(', ').sort(), ['Agent', 'Edit', 'NotebookEdit', 'Write'])
  for (const name of WRITERS) assert.match(frontmatter(name).disallowedTools || '', /\bAgent\b/, name)
})
await check('agentPrefix "" uses bare agent names', async () => {
  await simulate({ ...base, agentPrefix: '' })
  assert.equal(calls.find(c => c.label.startsWith('preflight')).agentType, 'goals-preflight')
})
await check('plugin and marketplace manifests agree, and the workflow is named run-wave', () => {
  const plugin = JSON.parse(readFileSync(new URL('.claude-plugin/plugin.json', root), 'utf8'))
  const market = JSON.parse(readFileSync(new URL('.claude-plugin/marketplace.json', root), 'utf8'))
  assert.equal(plugin.name, 'agent-pr-pipeline')
  assert.deepEqual(market.plugins.map(p => p.name), [plugin.name])
  assert.match(src, /name: 'run-wave'/)
  for (const skill of ['pr-pipeline', 'write-goals']) assert.ok(existsSync(new URL(`skills/${skill}/SKILL.md`, root)), skill)
})

// Quick fixes: the triage gate.
const QUICK = ['QS', 'QN', 'QM', 'QF', 'QY', 'QL', 'QH', 'QP', 'QD', 'QE', 'QT', 'QA']
const quickBase = { repo: 'o/r', tmp: '/x', goals: 'docs/goals.md', architecture: 'docs/design.md', pluginRoot: '/plug', prs: QUICK.map((id, i) => ({ id, quick: { issue: 40 + i }, branch: `fix/${id}` })) }
const qr = await simulate(quickBase)
const quickCalls = calls
const forPr = (id, re) => quickCalls.filter(c => c.label.split(':')[1].split('#')[0] === id && re.test(c.label))
const entryOf = id => `Touches: src/x.js\nAcceptance: node --test passes\nTriage: size ${TRIAGES[id].size}, risk ${TRIAGES[id].risk}`
await check('quick: an L or high-risk build becomes a plan and builds nothing', () => {
  for (const id of ['QL', 'QH']) {
    assert.equal(qr[id].ready, false)
    assert.match(qr[id].reason, /^quick fix: plan\. why build /)
    assert.equal(forPr(id, /^(implement|product|io:[^#]*#put|test|review)/).length, 0, id)
  }
})
await check('quick: plan and decline stop with the triager\'s reason and start no implementer', () => {
  assert.match(qr.QP.reason, /^quick fix: plan\. why plan M medium/)
  assert.match(qr.QD.reason, /^quick fix: decline\. why decline S low/)
  for (const id of ['QP', 'QD']) assert.equal(forPr(id, /^(implement|product|io:[^#]*#put|test|review)/).length, 0, id)
})
await check('quick: a build runs the product-fit reviewer on the entry, and its escalate stops the PR', () => {
  const p = forPr('QM', /^product/)[0]
  assert.equal(p.agentType, 'agent-pr-pipeline:product-reviewer')
  assert.ok(p.prompt.includes(entryOf('QM')))
  assert.equal(qr.QE.reason, 'needs human: product')
  assert.equal(qr.QE.escalation.question, 'Add a hosted mode?')
  assert.equal(forPr('QE', /^(implement|io:[^#]*#put|test|review)/).filter(c => c.label !== 'io:QE#put').length, 0)
  assert.equal(forPr('QE', /^io:QE#put/).length, 0, 'the brief is posted only after the product check passes')
})
await check('quick: product notes become minor issues for the PR opener', () => {
  assert.equal(qr.QT.ready, true)
  assert.match(forPr('QT', /^open/)[0].prompt, /Product fit: QT \(widens-scope\)/)
})
await check('quick: the implementer, tester, reviewer, architecture reviewer, fixer and opener all carry the same entry', () => {
  for (const id of ['QM', 'QF']) {
    const entry = entryOf(id)
    const labels = forPr(id, /^(implement|test|review|arch|fix|docs|open)/)
    for (const want of ['implement', 'test', 'review', 'arch', 'open']) assert.ok(labels.some(c => c.label.startsWith(want)), `${id} ${want}`)
    for (const c of labels) assert.ok(c.prompt.includes(entry), `${c.label} carries the entry`)
  }
  assert.ok(forPr('QF', /^fix/).length > 0)
  assert.equal(forPr('QM', /^io:QM#put/).length, 1)
})
await check('quick: the prompts name the issue and not a plan, and the PR closes the issue', () => {
  const impl = forPr('QM', /^implement/)[0].prompt
  assert.match(impl, /issues\/42/)
  assert.doesNotMatch(impl, /Plan:/)
  assert.match(forPr('QM', /^open/)[0].prompt, /"Closes #42" on its own line/)
})
await check('quick: S and low risk get 2 rounds and no architecture review unless a new concept is named', () => {
  assert.equal(qr.QS.reason, 'rounds exhausted')
  assert.equal(qr.QS.history.length, 2)
  assert.equal(forPr('QS', /^arch/).length, 0)
  assert.ok(forPr('QN', /^arch/).length > 0)
  assert.equal(qr.QY.history.length, 4)
  assert.ok(forPr('QY', /^arch/).length > 0)
})
await check('quick: a QA line from the triager turns on the QA step, and a stored one does too', async () => {
  assert.ok(forPr('QA', /^qa:/).length > 0)
  assert.match(forPr('QA', /^qa:/)[0].prompt, /What to try: try --words with empty input/)
  assert.equal(forPr('QS', /^qa:/).length, 0)
  briefs.QB = 'Touches: src/old.js\nAcceptance: old test\nQA: try old input\nTriage: size M, risk medium, new concepts: none'
  await simulate({ ...quickBase, prs: [{ id: 'QB', quick: { issue: 82 }, branch: 'fix/QB' }] })
  assert.ok(calls.some(c => c.label.startsWith('qa:QB')))
})
await check('quick: the goals path reaches the triager and the entry check', () => {
  assert.match(forPr('QM', /^triage/)[0].prompt, /docs\/goals\.md/)
  assert.match(forPr('QM', /^product/)[0].prompt, /docs\/goals\.md/)
})
await check('quick: pluginRoot reaches every pipeline-io prompt, which names the script and the plugin folder rule', () => {
  const io = quickCalls.filter(c => /^io:[^#]*#(get|put)$/.test(c.label))
  assert.ok(io.length > 0)
  for (const c of quickCalls.filter(c => c.label.startsWith('io:'))) assert.ok(c.prompt.includes('Plugin folder: /plug'), c.label)
  for (const c of io) {
    assert.ok(c.prompt.includes('bash /plug/scripts/quick-brief.sh'), c.label)
    assert.match(c.prompt, /never from a clone of o\/r/)
    assert.equal(c.agentType, 'agent-pr-pipeline:pipeline-io')
    assert.equal(`${c.model}/${c.effort}`, 'haiku/low')
  }
})
await check('quick: without pluginRoot the PR stops and no agent runs for it', async () => {
  const { pluginRoot, ...noRoot } = quickBase
  const r2 = await simulate({ ...noRoot, prs: [quickBase.prs[2]] })
  assert.match(r2.QM.reason, /^pluginRoot missing/)
  assert.equal(calls.filter(c => !/^(preflight|evaluate|redact)/.test(c.label)).length, 0)
})
await check('quick: a rerun with skipImpl reads the brief through pipeline-io, not the triager, and keeps the scaling', async () => {
  briefs.QR = 'Touches: src/r.js\nAcceptance: rerun test\nTriage: size S, risk low, new concepts: none'
  const r3 = await simulate({ ...quickBase, prs: [{ id: 'QR', quick: { issue: 77 }, branch: 'fix/QR', skipImpl: true }] })
  assert.ok(calls.some(c => c.label === 'io:QR#get' && c.prompt.includes('quick-brief.sh get o/r 77')))
  assert.ok(!calls.some(c => /^(triage|implement|product)/.test(c.label)))
  assert.ok(!calls.some(c => c.label === 'io:QR#put'))
  assert.ok(!calls.some(c => c.label.startsWith('arch')))
  for (const c of calls.filter(c => /^(test|review)/.test(c.label))) assert.ok(c.prompt.includes('Acceptance: rerun test'), c.label)
  assert.equal(r3.QR.ready, true)
})
await check('quick: a rerun with no trusted brief stops', async () => {
  const r4 = await simulate({ ...quickBase, prs: [{ id: 'QZ', quick: { issue: 78 }, branch: 'fix/QZ', skipImpl: true }] })
  assert.match(r4.QZ.reason, /^quick brief not found/)
  assert.ok(!calls.some(c => /^(triage|implement|test|review)/.test(c.label)))
})
await check('quick: a plain rerun with a stored brief skips the triager and uses the stored text', async () => {
  briefs.QX = 'Touches: src/old.js\nAcceptance: old test\nTriage: size M, risk medium, new concepts: none'
  const r5 = await simulate({ ...quickBase, prs: [{ id: 'QX', quick: { issue: 79 }, branch: 'fix/QX' }] })
  assert.ok(!calls.some(c => /^(triage|io:QX#put)/.test(c.label)))
  for (const c of calls.filter(c => /^(implement|test|review)/.test(c.label))) assert.ok(c.prompt.includes('Acceptance: old test'), c.label)
  assert.equal(r5.QX.ready, true)
})
await check('quick: a put that returns a different stored brief stops the PR before any code', async () => {
  storedInstead.QW = 'Touches: src/other.js\nAcceptance: other\nTriage: size M, risk medium, new concepts: none'
  TRIAGES.QW = triage('build', 'M', 'medium')
  const r6 = await simulate({ ...quickBase, prs: [{ id: 'QW', quick: { issue: 80 }, branch: 'fix/QW' }] })
  assert.match(r6.QW.reason, /^quick brief differs/)
  assert.ok(!calls.some(c => /^(implement|test|review)/.test(c.label)))
})
await check('quick: the entry goes into the put command as base64, never as inline text', () => {
  const put = forPr('QM', /^io:QM#put/)[0].prompt
  assert.doesNotMatch(put, /Acceptance: node --test/)
  assert.match(put, /quick-brief\.sh put o\/r 42 --b64 [A-Za-z0-9+\/=]+/)
})
await check('quick: the sum in the put command matches cksum of the decoded entry', async () => {
  const { execFileSync } = await import('node:child_process')
  const put = forPr('QM', /^io:QM#put/)[0].prompt
  const [, b64, sum] = /--b64 (\S+) --sum (\d+:\d+)/.exec(put)
  const out = execFileSync('cksum', { input: Buffer.from(b64, 'base64') }).toString().trim().split(/\s+/)
  assert.equal(sum, `${out[0]}:${out[1]}`)
})
await check('quick: a corrupted --b64 from the io agent posts nothing and stops the PR', async () => {
  TRIAGES.QK = triage('build', 'M', 'medium')
  corruptPut = true
  const r7 = await simulate({ ...quickBase, prs: [{ id: 'QK', quick: { issue: 81 }, branch: 'fix/QK' }] })
  corruptPut = false
  assert.match(r7.QK.reason, /^quick brief not posted/)
  assert.equal(briefs.QK, undefined)
  assert.ok(!calls.some(c => /^(implement|test|review)/.test(c.label)))
})
await check('quick: quick state stays off the caller options', () => {
  assert.equal(quickBase.prs[0].quickState, undefined)
  assert.equal(quickBase.prs[0].brief, undefined)
})
await check('quick: a plan is optional for a quick-only wave and required otherwise', async () => {
  await assert.rejects(() => run({ ...quickBase, prs: [...quickBase.prs.slice(0, 1), { id: 'X', title: 't', branch: 'x' }] }, agent, parallel, log), /needs plan/)
})

// Merge safety: the :auto suffix and the bot status.
const only = (...ids) => PRS.filter(p => ids.includes(p.id))
const landRun = async (cfg, prs, extra = {}) => {
  for (const [k, ids] of Object.entries(cfg)) land[k] = new Set(ids)
  try { return await simulate({ ...base, ...extra, prs }) } finally { for (const k of Object.keys(land)) land[k] = new Set() }
}
const ran = (re) => calls.filter(c => re.test(c.label)).map(c => c.label)
const suffix = x => x.land.split(':').slice(2).join(':')
await check('merge safety: :auto only when the gate passed and the agent said safe', async () => {
  const x = await landRun({ gated: ['D1'], person: ['C2'] }, only('C1', 'D1', 'C2', 'W1'))
  assert.equal(suffix(x.C1), 'auto')
  assert.equal(suffix(x.W1), 'auto')
  assert.equal(suffix(x.D1), '')
  assert.equal(suffix(x.C2), '')
  assert.deepEqual([x.C1.landMode, x.D1.landMode, x.C2.landMode], ['auto', 'person', 'person'])
  assert.match(x.D1.landWhy, /^gate: GATED #1: scripts\/merge-pr\.sh/)
  assert.match(x.C2.landWhy, /renames the --all flag/)
  assert.deepEqual(x.C2.safety, { verdict: 'person', why: 'renames the --all flag' })
  for (const v of Object.values(x)) assert.match(v.land, /^\d+:[^:]+(:auto)?$/)
})
await check('merge safety: a gated PR never reaches the merge-safety agent', async () => {
  await landRun({ gated: ['D1'] }, only('C1', 'D1'))
  assert.deepEqual(ran(/:D1#(gate|land)$/), ['io:D1#gate'])
  assert.deepEqual(ran(/:C1#(gate|land)$/), ['io:C1#gate', 'safety:C1#land'])
})
await check('merge safety: a gate that fails to run, a gate with no "not gated" answer and a failed agent give no :auto', async () => {
  const x = await landRun({ gateDown: ['C1'], gateOdd: ['C2'], safetyDown: ['W1'] }, only('C1', 'C2', 'W1'))
  assert.equal(land.gateOdd.size, 0)
  for (const id of ['C1', 'C2', 'W1']) { assert.equal(x[id].ready, true); assert.equal(suffix(x[id]), '', id) }
  assert.match(x.C1.landWhy, /pipeline-io failed/)
  assert.match(x.W1.landWhy, /merge-safety agent failed/)
  assert.deepEqual(ran(/:(C1|C2)#land$/), [])
})
await check('merge safety: a PR that stops for a person or for rounds gets no land value, gate or agent', async () => {
  const x = await landRun({}, only('E1', 'P1', 'G3'))
  for (const id of ['E1', 'P1', 'G3']) { assert.equal(x[id].ready, false); assert.equal(x[id].land, undefined) }
  assert.deepEqual(ran(/^(safety:|io:.*#gate)/), [])
})
await check('merge safety: a resumed PR and a PR with a maintainer decision land without :auto and never reach the agent', async () => {
  const x = await landRun({}, [
    { id: 'C1', title: 't', branch: 'b1', resume: { history: [], minors: [], findings: [] } },
    { id: 'C2', title: 't', branch: 'b2', architectureDecision: 'use A' },
    { id: 'W1', title: 't', branch: 'b17', productDecision: 'in scope' },
  ])
  for (const id of ['C1', 'C2', 'W1']) { assert.equal(x[id].ready, true, id); assert.equal(suffix(x[id]), '', id); assert.equal(x[id].landMode, 'person', id) }
  assert.deepEqual(ran(/^(safety:|io:.*#gate)/), [])
})
await check('merge safety: a bot status for another head stops the PR', async () => {
  const x = await landRun({ headMoved: ['C1'] }, only('C1', 'D1'))
  assert.equal(x.C1.ready, false)
  assert.match(x.C1.reason, /head moved/)
  assert.equal(x.C1.land, undefined)
  assert.equal(x.D1.ready, true)
})
await check('merge safety: the gate and the agent run last, on the sha after the docs step and the bot answers', async () => {
  const x = await landRun({}, only('G1', 'C2', 'B1'))
  assert.equal(x.G1.land.split(':')[1], 'sha-G1-docs1')
  assert.match(calls.find(c => c.label === 'safety:G1#land').prompt, /Judge the head sha-G1-docs1\./)
  assert.match(calls.find(c => c.label === 'safety:C2#land').prompt, /Judge the head sha-C2-bots1\./)
  assert.match(calls.find(c => c.label === 'safety:B1#land').prompt, /Judge the head sha-B1-bots2\./)
  for (const id of ['G1', 'C2', 'B1']) {
    const order = calls.filter(c => c.label.includes(`:${id}`)).map(c => c.label)
    assert.deepEqual(order.slice(-2), [`io:${id}#gate`, `safety:${id}#land`], id)
    assert.ok(order.indexOf(`io:${id}#gate`) > order.findLastIndex(l => /^(open|docs|botanswer|botreview|test|fix|review)/.test(l)), id)
  }
})
await check('merge safety: a land-fixed PR and a skipImpl rerun get the gate and the agent again on the new head, and :auto is never carried over', async () => {
  const x = await landRun({}, only('L1', 'P3'))
  assert.equal(x.L1.land, '7:sha-L1-bots1:auto')
  assert.equal(suffix(x.P3), 'auto')
  assert.match(calls.find(c => c.label === 'safety:L1#land').prompt, /Judge the head sha-L1-bots1\./)
  assert.ok(calls.some(c => c.label === 'io:P3#gate') && calls.some(c => c.label === 'safety:P3#land'))
  const y = await landRun({ gated: ['L1', 'P3'] }, only('L1', 'P3'))
  assert.equal(suffix(y.L1), '')
  assert.equal(suffix(y.P3), '')
  assert.deepEqual(ran(/safety:/), [])
})
await check('merge safety: the gate command runs from pluginRoot on the PR, and the agent is the read-only merge-safety role on opus/high', async () => {
  await landRun({}, only('C1'))
  const gate = calls.find(c => c.label === 'io:C1#gate')
  assert.match(gate.prompt, /bash \/plug\/scripts\/gate-files\.sh o\/r \d+/)
  assert.match(gate.prompt, /never from a clone of o\/r/)
  const s = calls.find(c => c.label === 'safety:C1#land')
  assert.equal(`${s.agentType} ${s.model}/${s.effort}`, 'agent-pr-pipeline:merge-safety opus/high')
  assert.match(s.prompt, /pull request #\d+/)
})
await check('merge safety: a stored quick brief with high risk lands as person without asking the agent', async () => {
  briefs.QHR = 'Touches: src/h.js\nAcceptance: h test\nTriage: size M, risk high, new concepts: none'
  const x = await landRun({}, [{ id: 'QHR', quick: { issue: 90 }, branch: 'fix/QHR', skipImpl: true }], { pluginRoot: '/plug' })
  assert.equal(x.QHR.ready, true)
  assert.equal(suffix(x.QHR), '')
  assert.match(x.QHR.landWhy, /high risk/)
  assert.deepEqual(ran(/^safety:/), [])
})
await check('merge safety: without pluginRoot no PR is :auto', async () => {
  const { pluginRoot, ...noRoot } = base
  calls = []; preflight = GOOD
  const out = await run({ ...noRoot, prs: only('C1', 'C2') }, agent, parallel, log)
  assert.ok(out.prs.every(p => !p.ready && !(p.land || '').endsWith(':auto')))
})

await check('bot status: approvedBy comes from the script through pipeline-io, not from the waiter', async () => {
  const x = await landRun({}, only('C1'))
  assert.deepEqual(x.C1.approvedBy, ['gitar-bot'])
  const st = calls.find(c => c.label === 'io:C1#botstatus')
  assert.match(st.prompt, /bash \/plug\/scripts\/bot-status\.sh o\/r \d+/)
  assert.match(st.prompt, /never from a clone of o\/r/)
  assert.equal(st.agentType, 'agent-pr-pipeline:pipeline-io')
  const wait = calls.find(c => c.label === 'botwait:C1')
  assert.ok(wait.prompt.includes('bash /plug/scripts/bot-status.sh o/r '))
  assert.doesNotMatch(wait.prompt, /latest review is APPROVED/)
  assert.ok(calls.findIndex(c => c.label === 'io:C1#botstatus') > calls.findIndex(c => c.label === 'botwait:C1'))
})
await check('bot status: a failed status script stops the PR before the land gate', async () => {
  const x = await landRun({ statusDown: ['C1'] }, only('C1'))
  assert.equal(x.C1.ready, false)
  assert.match(x.C1.reason, /^bot status failed: bot-status: cannot read the reviews/)
  assert.deepEqual(ran(/^(safety:|io:.*#gate)/), [])
})

// Land gate: scripts/bot-approval.jq on fixture reviews and comments.
const { execFileSync } = await import('node:child_process')
const GITAR_RAN = [{ name: 'Gitar', status: 'completed', conclusion: 'success' }]
const gate = (reviews, comments = [], checks = GITAR_RAN) => JSON.parse(execFileSync('jq', ['-f', new URL('scripts/bot-approval.jq', root).pathname], {
  input: JSON.stringify({ reviews, comments, checks, head: 'HEAD', bots: 'coderabbit|gitar|\\[bot\\]' }),
}))
const BOT = 'gitar-bot[bot]'
const review = (state, commit, at, login = BOT) => ({ user: { login }, state, commit_id: commit, submitted_at: at })
const thread = (id, login = BOT) => ({ id, in_reply_to_id: null, user: { login } })
const reply = (to, id = to + 1000) => ({ id, in_reply_to_id: to, user: { login: 'alfhen' } })
await check('gate: a bot whose latest review is APPROVED clears it', () => {
  assert.deepEqual(gate([review('APPROVED', 'OLD', '1')]), [BOT])
})
await check('gate: an answered comment on an older commit, not repeated on the head, clears it', () => {
  assert.deepEqual(gate([review('APPROVED', 'A', '1'), review('COMMENTED', 'OLD', '2')], [thread(7), reply(7)]), [`${BOT} (answered)`])
})
await check('gate: an unanswered bot thread blocks', () => {
  assert.deepEqual(gate([review('COMMENTED', 'OLD', '2')], [thread(7), thread(8), reply(7)]), [])
})
await check('gate: a bot comment on the current head blocks, even when answered', () => {
  assert.deepEqual(gate([review('COMMENTED', 'HEAD', '2')], [thread(7), reply(7)]), [])
})
await check('gate: changes requested blocks', () => {
  assert.deepEqual(gate([review('CHANGES_REQUESTED', 'OLD', '2')], [thread(7), reply(7)]), [])
})
await check('gate: an earlier changes request still blocks after a later comment, until the bot approves', () => {
  assert.deepEqual(gate([review('CHANGES_REQUESTED', 'A', '1'), review('COMMENTED', 'OLD', '2')], [thread(7), reply(7)]), [])
  assert.deepEqual(gate([review('CHANGES_REQUESTED', 'A', '1'), review('APPROVED', 'OLD', '2')]), [BOT])
})
await check('gate: answered comments clear only if the bot check ran on the head and passed', () => {
  const answered = [[review('COMMENTED', 'OLD', '2')], [thread(7), reply(7)]]
  assert.deepEqual(gate(...answered, []), [])
  assert.deepEqual(gate(...answered, [{ name: 'Gitar', status: 'in_progress', conclusion: null }]), [])
  assert.deepEqual(gate(...answered, [{ name: 'CodeRabbit', status: 'completed', conclusion: 'success' }]), [])
  assert.deepEqual(gate(...answered, [{ name: 'Gitar', status: 'completed', conclusion: 'neutral' }]), [])
})
await check('gate: a person approving does not count as a bot', () => {
  assert.deepEqual(gate([review('APPROVED', 'HEAD', '1', 'alfhen')]), [])
})
await check('gate: only the latest review of each bot counts', () => {
  assert.deepEqual(gate([review('COMMENTED', 'HEAD', '3'), review('APPROVED', 'OLD', '1')], [thread(7)]), [])
})
