// Runs workflow/pr-pipeline.js against a fake agent() that returns schema-shaped answers.
// Usage: node test/sim-pipeline.mjs (exits non-zero on the first failed check).
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../workflows/run-wave.js', import.meta.url), 'utf8').replace('export const meta', 'const meta')
const RealDate = globalThis.Date
Date.now = () => { throw new Error('Date.now is forbidden in a workflow') }
Math.random = () => { throw new Error('Math.random is forbidden in a workflow') }
globalThis.Date = class extends RealDate { constructor(...a) { if (!a.length) throw new Error('argless new Date is forbidden in a workflow'); super(...a) } }
globalThis.Date.now = Date.now
assert.doesNotMatch(src, /Date\.now\(|Math\.random\(|new Date\(\)/, 'run-wave.js uses a call the runtime forbids')
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
let triageCount = 0
// Each build entry touches its own file, so quick PRs in one run never overlap unless a test makes them.
const triage = (decision, size, risk, extra = {}) => ({
  decision, size, risk, why: `why ${decision} ${size} ${risk}`, newConcepts: [],
  ...(decision === 'build' ? { entry: { touches: `src/t${++triageCount}.js`, acceptance: 'node --test passes' } } : {}), ...extra,
})
const TRIAGES = {
  QS: triage('build', 'S', 'low'), QN: triage('build', 'S', 'low', { newConcepts: ['job queue'] }),
  QM: triage('build', 'M', 'medium'), QF: triage('build', 'M', 'medium'), QY: triage('build', 'M', 'medium'),
  QL: triage('build', 'L', 'low'), QH: triage('build', 'S', 'high'),
  QP: triage('plan', 'M', 'medium'), QD: triage('decline', 'S', 'low'),
  QA: triage('build', 'S', 'low', { entry: { touches: 'src/qa.js', acceptance: 'node --test passes', qa: 'try --words with empty input' } }),
  QE: triage('build', 'S', 'low'), QT: triage('build', 'S', 'low'),
}
let evaluation = { items: ITEMS, changedPaths: ['src/billing/invoice.ts', 'README.md'] }
// Exit codes the put script gives, per PR id: the first call, then the #put2 retry. Default 0.
const putPlan = {}
// Merge safety: ids the gate holds, ids the agent calls person, and ids where an agent fails or answers badly.
const land = { gated: new Set(), person: new Set(), gateDown: new Set(), safetyDown: new Set(), statusDown: new Set(), gateOdd: new Set(), headMoved: new Set(), blocked: new Set(), landOutput: new Set(), landFail: new Set(), landBad: new Set(), landBadOnce: new Set(), landOther: new Set(), testMoved: new Set(), threads: new Set() }
const landHead = {}
const wt = o => '/wt/' + o.label.replace(/[:#]/g, '-')
let cleanupMode = 'ok'
const cleanupAnswer = label => label.endsWith('init') ? { exitCode: 0, output: cleanupMode === 'refused' ? 'KEPT /x refused: shared temp folder' : 'MARKED /x' }
  : cleanupMode === 'down' ? null : cleanupMode === 'fail' ? { exitCode: 1, output: 'cleanup: boom' }
  : { exitCode: 0, output: /(clones|all)$/.test(label) ? 'REMOVED /x/test-1' : '' }
const lastHead = {}
// Cleanup calls are kept apart so the step-by-step checks below see only the pipeline's own steps.
let cleanupCalls = []
let timeline = []
const agentRaw = async (prompt, o) => {
  const entry = { label: o.label, model: o.model, effort: o.effort, agentType: o.agentType, isolation: o.isolation, prompt }
  timeline.push(o.label)
  if (/#cleanup/.test(o.label)) cleanupCalls.push(entry)
  else calls.push(entry)
  const id = o.label.split(':')[1].split('#')[0]
  if (o.label.startsWith('preflight')) return preflight
  if (/#cleanup/.test(o.label)) return cleanupAnswer(o.label, prompt)
  if (o.label.startsWith('triage')) return TRIAGES[id]
  if (o.label.startsWith('safety')) return land.safetyDown.has(id) ? null : land.person.has(id) ? { verdict: 'person', why: 'renames the --all flag' } : { verdict: 'safe', why: 'internal change' }
  if (o.label.startsWith('io:') && o.label.endsWith('#gate')) {
    if (land.gateDown.has(id)) return null
    if (land.gateOdd.has(id)) return { exitCode: 0, output: 'GATED #1: scripts/x.sh' }
    return land.gated.has(id) ? { exitCode: 1, output: 'GATED #1: scripts/merge-pr.sh' } : { exitCode: 0, output: 'not gated #1' }
  }
  if (o.label.startsWith('io:') && /#landhead\d*$/.test(o.label)) {
    // Right after the fix the PR head extends the fixer's short sha, as a real full sha does.
    const head = o.label.endsWith('#landhead') ? 'b'.repeat(40) : o.label.endsWith('#landhead1') ? (land.landOther.has(id) ? 'd'.repeat(40) : (lastHead[id] || '').padEnd(40, 'c')) : 'c'.repeat(40)
    if (!o.label.endsWith('#landhead')) lastHead[id] = head
    return { exitCode: 0, output: JSON.stringify({ head, approvedBy: [] }) }
  }
  if (o.label.startsWith('io:') && /#landcommits\d*$/.test(o.label)) {
    if (land.landFail.has(id)) return { exitCode: 1, output: 'land-commits: cannot read ' + 'b'.repeat(40) }
    landHead[id] = prompt.match(/land-commits\.sh \S+ \S+ (\S+)/)[1]
    return { exitCode: 0, output: land.landOutput.has(id) ? 'merge abc\n+resolved line\n' : '' }
  }
  if (o.label.startsWith('io:') && o.label.endsWith('#botstatus')) {
    return land.statusDown.has(id) ? { exitCode: 1, output: 'bot-status: cannot read the reviews' } : { exitCode: 0, output: JSON.stringify({ head: land.headMoved.has(id) ? 'moved' : lastHead[id], approvedBy: ['gitar-bot'], seenHead: ['gitar-bot'], openThreads: land.threads.has(id) ? 1 : 0 }) }
  }
  if (o.label.startsWith('io:')) {
    if (o.label.endsWith('#put') || o.label.endsWith('#put2')) {
      const code = (putPlan[id] || [])[o.label.endsWith('#put2') ? 1 : 0] ?? 0
      if (code === 65) return { exitCode: 65, output: 'quick-brief: the entry does not match its checksum; nothing posted' }
      if (code === 4) return { exitCode: 4, output: 'quick-brief: the brief on issue 1 was edited by a person or has no sum; nothing changed' }
      const posted = putText(prompt)
      briefs[id] = storedInstead[id] || posted
      return { exitCode: 0, output: briefs[id] }
    }
    if (putPlan[id] && putPlan[id].get === 4) return { exitCode: 4, output: 'quick-brief: the brief on issue 1 was edited by a person' }
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
  if (o.label.startsWith('implement')) return { pushed: true, branch: 'b', summary: 's', acceptanceTestPassed: true, worktree: wt(o) }
  if (o.label.startsWith('fix:')) return { summary: 's', worktree: wt(o) }
  const round = o.label.split('#')[1] || ''
  if (o.label.startsWith('test')) return { pass: true, headSha: /^land/.test(round) && !land.testMoved.has(id) ? landHead[id].padEnd(40, 'c') : 'sha-' + id + (/^(docs|bots|land)/.test(round) ? '-' + round : ''), checks: [{ name: 'lint', pass: true }] }
  if (o.label.startsWith('landreview')) return { summary: 's', findings: land.landBad.has(id) || (land.landBadOnce.has(id) && round === '1') ? [{ severity: 'major', title: 'the resolution drops the new flag', detail: 'd' }] : [{ severity: 'minor', title: 'land nit', detail: 'd' }] }
  if (o.label.startsWith('botreview')) return { summary: 's', findings: id === 'B1' && round === '1' ? [{ severity: 'major', title: 'the new regex anchor rejects valid input', detail: 'd' }] : [{ severity: 'minor', title: 'late nit', detail: 'd' }] }
  if (o.label.startsWith('docsreview')) {
    const major = id === 'G3' || (id === 'G2' && round === '1')
    return { summary: 's', findings: major ? [{ severity: 'major', title: 'docs say the flag is --all, code has --every', detail: 'd' }] : [] }
  }
  if (o.label.startsWith('qa')) return (id === 'Q1' && round === '1')
    ? { summary: 's', scenarios: [{ name: '--words with empty input', command: "printf '' | tally --words", expected: '0', actual: '1', result: 'fail' }], findings: [{ severity: 'major', title: 'empty input prints 1', detail: 'd' }, { severity: 'minor', title: 'help wording', detail: 'd' }] }
    : { summary: 's', scenarios: [{ name: 'acceptance', result: 'pass' }, { name: '--words with empty input', result: 'pass' }], findings: [] }
  if (o.label.startsWith('docsfix')) return { changed: true, headSha: 'docsfix-' + id, files: ['README.md'], summary: 's', worktree: wt(o) }
  if (o.label.startsWith('docs')) return ['G1', 'G2', 'G3'].includes(id) ? { changed: true, headSha: 'docs-' + id, files: ['README.md'], summary: 's', worktree: wt(o) } : { changed: false, summary: 'already right', worktree: wt(o) }
  if (o.label.startsWith('review')) return { summary: 's', findings: id === 'P1' || ['QS', 'QY'].includes(id) || (id === 'QF' && round === '1') ? [{ severity: 'major', title: 'x', detail: 'd', file: 'src/secret/area.ts' }] : [{ severity: 'minor', title: 'm', detail: 'd' }] }
  if (o.label.endsWith('#body')) return { updated: true }
  if (o.label.startsWith('open') && land.blocked.has(id)) return { blocked: true, blockedReason: 'permission denied: gh pr create', commands: ['gh pr create -R o/r --head b1 --title "t"'] }
  if (o.label.startsWith('open')) return { prNumber: 100 + calls.length, prUrl: 'u', issuesCreated: id === 'C2' ? ['https://github.com/o/r/issues/21'] : [] }
  if (o.label.startsWith('botwait')) return id === 'C1' && failWait ? null : { approvedBy: ['the-waiter-says-so'], openComments: ['C2', 'L1', 'B1', 'W1'].includes(id) ? 2 : 0 }
  if (o.label.startsWith('botanswer')) return { codeChanged: id !== 'W1', headSha: 'sha-answer-' + id, closesIssues: id === 'C2' ? [21] : [], notes: 'anchored the regex', worktree: wt(o) }
  if (o.label.startsWith('landfix')) return { readyToMerge: true, headSha: 'abc', notes: 'ok', worktree: wt(o) }
  return null
}
// The entry that a put prompt asks the agent to write: the text between the two fences.
const putText = prompt => /\n(`{3,})\n([\s\S]*?)\n\1\n/.exec(prompt)[2]
// A pipeline-io answer as the real agent returns it: the script's text between the two io.sh lines. The fake's own exitCode stays in the answer and must be ignored.
const ioWrap = (label, out) => out && label.startsWith('io:') && typeof out.exitCode === 'number' && !out.raw
  ? { exitCode: out.exitCode, output: `pipeline-io: begin\n${out.output}${out.output ? '\n' : ''}pipeline-io: exit ${out.exitCode}` } : out
const agent = async (prompt, o) => {
  const out = ioWrap(o.label, await agentRaw(prompt, o))
  if (out && out.headSha) lastHead[o.label.split(':')[1].split('#')[0]] = out.headSha
  return out
}
const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
let logs = []
const log = m => { logs.push(m) }

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
const MAIN_DENYLIST = ['o', 'r', 'o/r', 'https://github.com/o/r', 'src/billing/invoice.ts', 'README.md', 'src/secret/area.ts', 'billing/invoice.ts', 'secret/area.ts', ...PRS.map(p => p.branch)]
const simulate = async (args, pre = GOOD) => {
  calls = []
  cleanupCalls = []
  timeline = []
  logs = []
  preflight = pre
  const out = await run(args, agent, parallel, log)
  lastResult = out
  return Object.fromEntries(out.prs.map(r => [r.id, r]))
}
const check = async (name, fn) => { await fn(); console.log('ok  ' + name) }

// Main run: every path except the failures.
const r = await simulate(base)
const mainCalls = calls
const mainCleanup = cleanupCalls
const mainTimeline = timeline
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
  assert.equal(r.P1.reason, 'rounds exhausted: 3 of 3 (planRounds)')
  assert.equal(r.P1.history.length, 3)
  assert.equal(r.P1.product.verdict, 'aligned')
})
await check('planRounds in the args overrides the default', async () => {
  const x = await simulate({ ...base, planRounds: 2, prs: [{ id: 'P1', title: 'plan', branch: 'b3', kind: 'plan', skipImpl: true }] })
  assert.equal(x.P1.reason, 'rounds exhausted: 2 of 2 (planRounds)')
  assert.equal(x.P1.history.length, 2)
})
await check('land fix runs the land fixer, then waits for and answers the bots on the new head', () => {
  assert.equal(r.L1.ready, true)
  assert.deepEqual(mainCalls.filter(c => c.label.includes(':L1')).map(c => c.label), ['io:L1#landhead', 'landfix:L1', 'io:L1#landhead1', 'io:L1#landcommits1', 'botwait:L1', 'io:L1#botstatus', 'botanswer:L1', 'test:L1#bots1', 'botreview:L1#1'])
  assert.equal(r.L1.land, '7:sha-L1-bots1')
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
  assert.equal(r.G3.reason, 'docs check: rounds exhausted: 2 of 2 (docsRounds)')
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
await check('the result has the shape { prs, feedback, denylist, source, feedbackRepo, cleanup }', () => {
  assert.deepEqual(Object.keys(mainResult).sort(), ['cleanup', 'denylist', 'feedback', 'feedbackRepo', 'prs', 'source'])
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
  assert.deepEqual(lastResult.denylist, MAIN_DENYLIST)
  assert.equal(lastResult.prs.length, PRS.length)
  assert.equal(calls.filter(c => c.label.startsWith('redact')).length, 1)
})
await check('a landFix-only run starts no evaluate or redact agent', async () => {
  await simulate({ ...base, prs: PRS.filter(p => p.landFix) })
  assert.ok(calls.length > 0 && calls.every(c => !/^(evaluate|redact)/.test(c.label)))
  assert.deepEqual(lastResult.feedback, [])
  assert.deepEqual(lastResult.denylist, [])
})
await check('the denylist holds the repo owner, name, URL, the changed paths, their two-segment suffixes and the branches', () => {
  assert.deepEqual(mainResult.denylist, MAIN_DENYLIST)
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
  assert.deepEqual(Object.keys(refusedResult).sort(), ['cleanup', 'denylist', 'feedback', 'feedbackRepo', 'prs', 'source'])
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
const STEP_OF = { botreview: 'review', landreview: 'review', qa: 'qa', docs: 'docs', docsfix: 'docs', docsreview: 'docs', implement: 'impl', test: 'test', review: 'review', arch: 'arch', product: 'product', fix: 'fix', open: 'open', botwait: 'botWait', botanswer: 'botAnswer', landfix: 'landFix', preflight: 'preflight', evaluate: 'evaluate', redact: 'redact' }
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
const AGENT_OF = { botreview: 'reviewer', landreview: 'reviewer', qa: 'qa', docsfix: 'docs-writer', implement: 'implementer', test: 'tester', review: 'reviewer', arch: 'arch-reviewer', product: 'product-reviewer', fix: 'fixer', docs: 'docs-writer', docsreview: 'docs-reviewer', open: 'pr-opener', botwait: 'bot-waiter', botanswer: 'bot-answerer', landfix: 'land-fixer', preflight: 'goals-preflight', triage: 'triager', io: 'pipeline-io', safety: 'merge-safety', evaluate: 'evaluator', redact: 'feedback-redactor' }
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
await check('read-only agents have no edit tools, except pipeline-io with Write', () => {
  for (const name of [...new Set(Object.values(AGENT_OF))].filter(n => !WRITERS.includes(n) && n !== 'qa')) {
    const tools = frontmatter(name).tools
    const allowed = name === 'pr-opener' || name === 'pipeline-io' ? 'Write' : ''
    assert.ok(tools && !/\b(Edit|Write|NotebookEdit|Agent)\b/.test(tools.replace(allowed, '')), name)
  }
  assert.match(frontmatter('pr-opener').tools, /\bWrite\b/)
  assert.equal(frontmatter('pipeline-io').tools, 'Bash, Write', 'pipeline-io may write the one brief file and nothing else')
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
const entryOf = id => `Touches: ${TRIAGES[id].entry.touches}\nAcceptance: node --test passes\nTriage: size ${TRIAGES[id].size}, risk ${TRIAGES[id].risk}`
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
  assert.equal(qr.QS.reason, 'rounds exhausted: 2 of 2 (quick S/low)')
  assert.equal(qr.QS.history.length, 2)
  assert.equal(forPr('QS', /^arch/).length, 0)
  assert.ok(forPr('QN', /^arch/).length > 0)
  assert.equal(qr.QY.history.length, 4)
  assert.ok(forPr('QY', /^arch/).length > 0)
})
await check('quick: a QA line from the triager turns on the QA step, and a stored one does too', async () => {
  assert.ok(forPr('QA', /^qa:/).length > 0)
  const qaPrompt = forPr('QA', /^qa:/)[0].prompt
  const [instructions, briefBlock] = qaPrompt.split('Quick-fix entry (the brief for this PR')
  assert.match(instructions, /What to try: the plan entry's QA line/)
  assert.doesNotMatch(instructions, /try --words with empty input/)
  assert.match(briefBlock, /QA: try --words with empty input/)
  assert.equal(forPr('QS', /^qa:/).length, 0)
  briefs.QB = 'Touches: src/old.js\nAcceptance: old test\nQA: try old input\nTriage: size M, risk medium, new concepts: none'
  await simulate({ ...quickBase, prs: [{ id: 'QB', quick: { issue: 82 }, branch: 'fix/QB' }] })
  assert.ok(calls.some(c => c.label.startsWith('qa:QB')))
})
await check('quick: the goals path reaches the triager and the entry check', () => {
  assert.match(forPr('QM', /^triage/)[0].prompt, /docs\/goals\.md/)
  assert.match(forPr('QM', /^product/)[0].prompt, /docs\/goals\.md/)
})
await check('quick: the triage prompt names the issue comments path', () => {
  assert.match(forPr('QM', /^triage/)[0].prompt, /repos\/o\/r\/issues\/42\/comments/)
})
await check('quick: pluginRoot reaches every pipeline-io prompt, which names io.sh, the script and the plugin folder rule', () => {
  const io = quickCalls.filter(c => /^io:[^#]*#(get|put)$/.test(c.label))
  assert.ok(io.length > 0)
  for (const c of quickCalls.filter(c => c.label.startsWith('io:'))) {
    assert.ok(c.prompt.includes('Plugin folder: /plug'), c.label)
    assert.ok(c.prompt.includes('bash /plug/scripts/io.sh '), c.label)
    assert.doesNotMatch(c.prompt, /bash \/plug\/scripts\/(?!io\.sh)/, c.label)
  }
  for (const c of io) {
    assert.ok(c.prompt.includes('io.sh quick-brief.sh '), c.label)
    assert.match(c.prompt, /never from a clone of o\/r/)
    assert.equal(c.agentType, 'agent-pr-pipeline:pipeline-io')
  }
})
await check('quick: only the put calls run on the brief step (sonnet), every other pipeline-io call stays on haiku', async () => {
  const puts = quickCalls.filter(c => /^io:[^#]*#put2?$/.test(c.label))
  assert.ok(puts.length > 0)
  for (const c of puts) assert.equal(`${c.model}/${c.effort}`, 'sonnet/low', c.label)
  const others = quickCalls.filter(c => c.label.startsWith('io:') && !/#put2?$/.test(c.label))
  assert.ok(others.length > 0)
  for (const c of others) assert.equal(`${c.model}/${c.effort}`, 'haiku/low', c.label)
  const src = readFileSync(new URL('workflows/run-wave.js', root), 'utf8')
  assert.match(src, /brief: \{ model: 'sonnet', effort: 'low' \}/)
  assert.match(src, /ioBrief: \{ agent: 'pipeline-io', phase: 'Triage', skills: null, model: 'brief' \}/)
  assert.equal(src.match(/role: 'ioBrief'/g).length, 1, 'one call site serves the put and the #put2 retry')
  TRIAGES.QSO = triage('build', 'M', 'medium')
  await simulate({ ...quickBase, steps: { brief: { model: 'opus', effort: 'high' } }, prs: [{ id: 'QSO', quick: { issue: 96 }, branch: 'fix/QSO' }] })
  assert.equal(calls.find(c => c.label === 'io:QSO#put').model, 'opus')
  assert.equal(calls.find(c => c.label === 'io:QSO#get').model, 'haiku')
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
const BASE64_RUN = /[A-Za-z0-9+\/=]{60,}/
await check('quick: the put prompt holds the path, --sum and the entry in a fenced block, and no --b64 or base64 run', () => {
  const put = forPr('QM', /^io:QM#put$/)[0].prompt
  assert.match(put, /File: \/x\/brief-QM\/entry-1\.md\n/)
  assert.match(put, /quick-brief\.sh put o\/r 42 \/x\/brief-QM\/entry-1\.md --sum \d+:\d+`/)
  assert.ok(putText(put).startsWith(entryOf('QM')))
  assert.match(put, /Write tool/)
  for (const c of quickCalls.filter(c => c.label.startsWith('io:'))) {
    assert.doesNotMatch(c.prompt, /--b64/, c.label)
    assert.doesNotMatch(c.prompt, BASE64_RUN, c.label)
  }
})
await check('quick: the get call clears the brief folder and runs before the put', async () => {
  delete briefs.QM
  await simulate({ ...quickBase, prs: [quickBase.prs[2]] })
  const labels = calls.map(c => c.label)
  const get = calls.find(c => c.label === 'io:QM#get')
  assert.ok(get.prompt.includes('quick-brief.sh get o/r 42 --clear /x/brief-QM`'), get.prompt)
  assert.ok(labels.indexOf('io:QM#get') >= 0 && labels.indexOf('io:QM#get') < labels.indexOf('io:QM#put'))
})
await check('quick: the fence is longer than any backtick run in the entry', async () => {
  TRIAGES.QG = triage('build', 'M', 'medium', { entry: { touches: 'src/qg.js', acceptance: 'run ```x``` and pass' } })
  await simulate({ ...quickBase, prs: [{ id: 'QG', quick: { issue: 95 }, branch: 'fix/QG' }] })
  const put = calls.find(c => c.label === 'io:QG#put').prompt
  assert.match(put, /\n````\nTouches: src\/qg\.js\n/)
  assert.ok(putText(put).includes('```x```'))
})
await check('quick: the sum in the put command equals cksum of the entry', async () => {
  const { execFileSync } = await import('node:child_process')
  const put = forPr('QM', /^io:QM#put$/)[0].prompt
  const sum = /--sum (\d+:\d+)/.exec(put)[1]
  const out = execFileSync('cksum', { input: putText(put) }).toString().trim().split(/\s+/)
  assert.equal(sum, `${out[0]}:${out[1]}`)
})
const quickOne = async (id, issue, extra = {}) => {
  TRIAGES[id] = TRIAGES[id] || triage('build', 'M', 'medium')
  return (await simulate({ ...quickBase, prs: [{ id, quick: { issue }, branch: `fix/${id}`, ...extra }] }))[id]
}
const built = () => calls.some(c => /^(implement|test|review)/.test(c.label))
await check('quick: a put that gives 65 and then 0 runs #put2 and the PR goes on', async () => {
  putPlan.QU = [65, 0]
  const r = await quickOne('QU', 83)
  delete putPlan.QU
  assert.ok(calls.some(c => c.label === 'io:QU#put2'))
  assert.equal(calls.filter(c => /^io:QU#put/.test(c.label)).length, 2)
  const fileOf = c => c.prompt.match(/\S*brief-QU\/entry-\d+\.md/g)
  const [p1, p2] = ['io:QU#put', 'io:QU#put2'].map(l => fileOf(calls.find(c => c.label === l)))
  assert.ok(p1 && p2 && p1[0] !== p2[0], 'each put attempt writes a file that does not exist yet')
  assert.ok(briefs.QU)
  assert.ok(calls.some(c => c.label.startsWith('implement:QU')))
  assert.equal(r.ready, true)
})
await check('quick: 65 twice stops the PR with the checksum reason and builds nothing', async () => {
  putPlan.QK = [65, 65]
  const r = await quickOne('QK', 81)
  delete putPlan.QK
  assert.equal(r.reason, 'quick brief not posted: checksum, twice')
  assert.equal(calls.filter(c => /^io:QK#put/.test(c.label)).length, 2)
  assert.equal(briefs.QK, undefined)
  assert.ok(!built())
})
await check('quick: exit 4 from get or put stops the PR with the edited-by-a-person reason', async () => {
  putPlan.QV = { get: 4 }
  const g = await quickOne('QV', 84)
  delete putPlan.QV
  assert.equal(g.reason, 'quick brief edited by a person')
  assert.ok(!calls.some(c => /^(triage|implement|test|review)/.test(c.label)))
  putPlan.QV2 = [4]
  const p = await quickOne('QV2', 85)
  delete putPlan.QV2
  assert.equal(p.reason, 'quick brief edited by a person')
  assert.ok(!built())
})
// A real agent answer that the fake builds by hand: the script's text may have anything around it.
const withIo = (match, answer) => (p, o) => match(o.label) ? answer : agent(p, o)
const runWith = (args, fn) => { calls = []; cleanupCalls = []; timeline = []; logs = []; preflight = GOOD; return run(args, fn, parallel, log) }
await check('quick: text outside the begin and exit lines never reaches the result', async () => {
  briefs.QJ = 'Touches: src/qj.js\nAcceptance: wrapped test\nTriage: size M, risk medium, new concepts: none'
  const answer = { output: `MCP Server Instructions\nnoise before\npipeline-io: begin\n${briefs.QJ}\npipeline-io: exit 0\nthanks, done` }
  const r = (await runWith({ ...quickBase, prs: [{ id: 'QJ', quick: { issue: 86 }, branch: 'fix/QJ', skipImpl: true }] }, withIo(l => l === 'io:QJ#get', answer))).prs[0]
  assert.equal(r.ready, true)
  const reviews = calls.filter(c => c.label.startsWith('review:QJ'))
  assert.ok(reviews.length > 0)
  for (const c of reviews) {
    assert.ok(c.prompt.includes('Acceptance: wrapped test'))
    assert.doesNotMatch(c.prompt, /noise before|thanks, done|pipeline-io: /)
  }
})
await check('quick: the exit code comes from the exit line, not from the agent\'s exitCode', async () => {
  const lie = { exitCode: 0, output: 'pipeline-io: begin\nboom\npipeline-io: exit 3\n' }
  const r = (await runWith({ ...quickBase, prs: [{ id: 'QJ2', quick: { issue: 87 }, branch: 'fix/QJ2' }] }, withIo(l => l === 'io:QJ2#get', lie))).prs[0]
  assert.match(r.reason, /^quick brief not found: boom/)
  assert.ok(!calls.some(c => /^(triage|implement|test|review)/.test(c.label)), 'exit 3 is not read as 0')
  const one = { exitCode: 0, output: 'pipeline-io: begin\nquick-brief: no trusted brief on issue 87\npipeline-io: exit 1' }
  TRIAGES.QJ3 = triage('build', 'M', 'medium')
  await runWith({ ...quickBase, prs: [{ id: 'QJ3', quick: { issue: 88 }, branch: 'fix/QJ3' }] }, withIo(l => l === 'io:QJ3#get', one))
  assert.ok(calls.some(c => c.label === 'triage:QJ3'), 'exit 1 on the line goes to the triager')
})
await check('quick: an answer with no exit line is a failed call', async () => {
  for (const output of ['boom', 'pipeline-io: begin\nhalf an answer', 'pipeline-io: exit 0']) {
    const r = (await runWith({ ...quickBase, prs: [{ id: 'QJ4', quick: { issue: 89 }, branch: 'fix/QJ4' }] }, withIo(l => l === 'io:QJ4#get', { exitCode: 0, output }))).prs[0]
    assert.match(r.reason, /^quick brief not found: pipeline-io: no exit line/, output)
    assert.ok(!built(), output)
  }
})
await check('pipeline-io calls outside the brief read the exit line too', async () => {
  const odd = (p, o) => o.label === 'io:C1#gate' ? { exitCode: 0, output: 'pipeline-io: begin\nnot gated #1\npipeline-io: exit 1' } : agent(p, o)
  const x = Object.fromEntries((await runWith({ ...base, prs: PRS.filter(p => p.id === 'C1') }, odd)).prs.map(r => [r.id, r]))
  assert.equal(x.C1.landMode, 'person')
  assert.match(x.C1.landWhy, /^gate: not gated/)
})
await check('quick: the overlap check stops the later of two quick PRs that share a path, after both briefs are posted and before any build', async () => {
  TRIAGES.QO1 = triage('build', 'M', 'medium', { entry: { touches: 'src/x.js', acceptance: 'a' } })
  TRIAGES.QO2 = triage('build', 'M', 'medium', { entry: { touches: 'test/y.mjs, `./src/x.js` (the loader), docs/z.md', acceptance: 'b' } })
  TRIAGES.QO3 = triage('build', 'M', 'medium', { entry: { touches: 'src/other.js [new]', acceptance: 'c' } })
  const res = await simulate({ ...quickBase, prs: ['QO1', 'QO2', 'QO3'].map((id, i) => ({ id, quick: { issue: 100 + i }, branch: `fix/${id}` })) })
  assert.equal(res.QO2.reason, 'quick fix: touches overlap with QO1 (src/x.js); run it in a later wave')
  assert.ok(!calls.some(c => /^(implement|test|review|open)[:]QO2/.test(c.label)), 'QO2 builds nothing')
  assert.ok(calls.some(c => c.label.startsWith('implement:QO1')) && res.QO1.ready, 'QO1 builds')
  assert.ok(calls.some(c => c.label.startsWith('implement:QO3')) && res.QO3.ready, 'no shared path builds')
  assert.ok(briefs.QO2, 'the brief of the stopped PR stays on the issue')
  const firstBuild = timeline.findIndex(l => /^implement:/.test(l))
  const lastPut = timeline.map(l => /^io:QO\d#put$/.test(l)).lastIndexOf(true)
  assert.ok(lastPut > -1 && lastPut < firstBuild, 'every brief is set up before the first build')
})
await check('quick: touchesOf drops backticks, bracket notes and ./ and splits on commas', () => {
  const src = readFileSync(new URL('workflows/run-wave.js', root), 'utf8')
  const fn = new Function(`${/const touchesOf = [\s\S]*?\n}\n/.exec(src)[0]}; return touchesOf`)()
  assert.deepEqual(fn('Touches: `./a.js`, b/c.md (new, big), [x] d.js\nAcceptance: z'), ['a.js', 'b/c.md', 'd.js'])
  assert.deepEqual(fn('Acceptance: z'), [])
})
await check('quick: two quick PRs with no shared path both build', async () => {
  const res = await simulate({ ...quickBase, prs: ['QM', 'QF'].map((id, i) => ({ id, quick: { issue: 110 + i }, branch: `fix/${id}` })) })
  assert.ok(res.QM.reason === undefined || !/overlap/.test(res.QM.reason))
  assert.ok(!/overlap/.test(res.QF.reason || ''))
  for (const id of ['QM', 'QF']) assert.ok(calls.some(c => c.label.startsWith(`implement:${id}`)), id)
})
await check('quick: a stored brief with the same path as an earlier PR also stops', async () => {
  briefs.QOS = 'Touches: src/x.js\nAcceptance: stored\nTriage: size M, risk medium, new concepts: none'
  const res = await simulate({ ...quickBase, prs: [{ id: 'QO1', quick: { issue: 100 }, branch: 'fix/QO1' }, { id: 'QOS', quick: { issue: 120 }, branch: 'fix/QOS', skipImpl: true }] })
  assert.match(res.QOS.reason, /^quick fix: touches overlap with QO1 \(src\/x\.js\)/)
  assert.ok(!calls.some(c => /^(review|test):QOS/.test(c.label)))
})
await check('pipeline-io front matter has Write and its body limits the write to the named file', () => {
  const text = readFileSync(new URL('agents/pipeline-io.md', root), 'utf8')
  assert.match(frontmatter('pipeline-io').tools, /\bWrite\b/)
  const body = text.split('---').slice(2).join('---')
  assert.match(body, /Write tool/)
  assert.match(body, /no other file/)
  assert.match(body, /pipeline-io: exit/)
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
await check('decision rerun: a skipImpl rerun with productDecision runs the fixer first, then reviews', async () => {
  const order = id => calls.filter(c => c.label.includes(`:${id}`)).map(c => c.label)
  const findingsOf = label => calls.find(c => c.label === label).prompt.split('together:\n')[1].split(/^File .*:\n/m).filter(Boolean).flatMap(g => JSON.parse(g)).sort((x, y) => x.n - y.n)
  const rerun = async (pr, text) => {
    await simulate({ ...base, prs: [pr] })
    const labels = order(pr.id)
    const fixAt = labels.indexOf(`fix:${pr.id}#0`)
    assert.ok(fixAt >= 0, pr.id)
    assert.ok(fixAt < labels.indexOf(`review:${pr.id}#1`) && fixAt < labels.indexOf(`test:${pr.id}#1`), pr.id)
    const items = findingsOf(`fix:${pr.id}#0`)
    assert.equal(items.length, 1)
    assert.equal(items[0].title, 'Apply the maintainer decision')
    assert.match(items[0].detail, new RegExp(text))
    assert.deepEqual(ran(new RegExp(`^implement:${pr.id}$`)), [])
  }
  await rerun({ id: 'P1', title: 'plan', branch: 'b3', kind: 'plan', skipImpl: true, productDecision: 'ship the narrow scope' }, 'ship the narrow scope')
  await rerun({ id: 'C1', title: 't', branch: 'b1', skipImpl: true, architectureDecision: 'use option A' }, 'use option A')

  await simulate({ ...base, prs: [{ id: 'C1', title: 't', branch: 'b1', resume: { history: [], minors: [], findings: [{ severity: 'major', title: 'old resume finding', detail: 'd' }] }, architectureDecision: 'use option A' }] })
  const pre = ran(/^fix:C1#0$/)
  assert.equal(pre.length, 1)
  const items = findingsOf('fix:C1#0')
  assert.equal(items.length, 2)
  assert.equal(items[0].title, 'old resume finding')
  assert.equal(items[1].title, 'Apply the maintainer decision')
  assert.match(items[1].detail, /use option A/)

  await simulate({ ...base, prs: [{ id: 'P1', title: 'plan', branch: 'b3', kind: 'plan', skipImpl: true }] })
  assert.deepEqual(ran(/^fix:P1#0$/), [])
  await simulate({ ...base, prs: [{ id: 'C2', title: 't', branch: 'b2', architectureDecision: 'use A' }] })
  assert.deepEqual(ran(/^implement:C2$/), ['implement:C2'])
  assert.deepEqual(ran(/^fix:C2#0$/), [])
  await simulate({ ...base, prs: only('L1') })
  assert.deepEqual(ran(/^(implement|fix):L1/), [])
})
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
await check('merge safety: a land-fixed PR and a skipImpl rerun land without :auto and never reach the gate or the agent', async () => {
  const x = await landRun({}, only('L1', 'P3'))
  for (const id of ['L1', 'P3']) { assert.equal(x[id].ready, true, id); assert.equal(suffix(x[id]), '', id); assert.equal(x[id].landMode, 'person', id) }
  assert.equal(x.L1.land, '7:sha-L1-bots1')
  assert.match(x.L1.landWhy, /land fix/)
  assert.match(x.P3.landWhy, /skipImpl/)
  assert.deepEqual(ran(/^(safety:|io:.*#gate)/), [])
})
await check('merge safety: a normal clean first run still gets :auto', async () => {
  const x = await landRun({}, only('C1'))
  assert.equal(suffix(x.C1), 'auto')
})
await check('merge safety: the gate command runs from pluginRoot on the PR, and the agent is the read-only merge-safety role on opus/high', async () => {
  await landRun({}, only('C1'))
  const gate = calls.find(c => c.label === 'io:C1#gate')
  assert.match(gate.prompt, /bash \/plug\/scripts\/io\.sh gate-files\.sh o\/r \d+/)
  assert.match(gate.prompt, /never from a clone of o\/r/)
  const s = calls.find(c => c.label === 'safety:C1#land')
  assert.equal(`${s.agentType} ${s.model}/${s.effort}`, 'agent-pr-pipeline:merge-safety opus/high')
  assert.match(s.prompt, /pull request #\d+/)
})
await check('merge safety: a quick-fix skipImpl rerun with a high-risk stored brief lands as person without asking the agent', async () => {
  briefs.QHR = 'Touches: src/h.js\nAcceptance: h test\nTriage: size M, risk high, new concepts: none'
  const x = await landRun({}, [{ id: 'QHR', quick: { issue: 90 }, branch: 'fix/QHR', skipImpl: true }], { pluginRoot: '/plug' })
  assert.equal(x.QHR.ready, true)
  assert.equal(suffix(x.QHR), '')
  assert.match(x.QHR.landWhy, /skipImpl/)
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
  assert.match(st.prompt, /bash \/plug\/scripts\/io\.sh bot-status\.sh o\/r \d+/)
  assert.match(st.prompt, /never from a clone of o\/r/)
  assert.equal(st.agentType, 'agent-pr-pipeline:pipeline-io')
  const wait = calls.find(c => c.label === 'botwait:C1')
  assert.ok(wait.prompt.includes('bash /plug/scripts/bot-status.sh o/r '))
  assert.doesNotMatch(wait.prompt, /latest review is APPROVED/)
  assert.match(wait.prompt, /Stop when seenHead is not empty/)
  assert.doesNotMatch(wait.prompt, /check-runs/)
  assert.ok(calls.findIndex(c => c.label === 'io:C1#botstatus') > calls.findIndex(c => c.label === 'botwait:C1'))
})
await check('bot status: a failed status script stops the PR before the land gate', async () => {
  const x = await landRun({ statusDown: ['C1'] }, only('C1'))
  assert.equal(x.C1.ready, false)
  assert.match(x.C1.reason, /^bot status failed: bot-status: cannot read the reviews/)
  assert.deepEqual(ran(/^(safety:|io:.*#gate)/), [])
})

await check('the wait prompt names wait-bots.sh from pluginRoot and a 600000 ms timeout', async () => {
  await landRun({}, only('C1'))
  const wait = calls.find(c => c.label === 'botwait:C1')
  assert.ok(wait.prompt.includes('bash /plug/scripts/wait-bots.sh o/r '))
  assert.match(wait.prompt, /timeout set to 600000 ms/)
  assert.match(wait.prompt, /wait-bots\.sh o\/r \d+ 9`/)
  assert.match(wait.prompt, /do not sleep between calls/)
})
await check('a blocked opener stops the PR with needs human: permission and the commands', async () => {
  const x = await landRun({ blocked: ['C1'] }, only('C1', 'C2'))
  assert.equal(x.C1.ready, false)
  assert.equal(x.C1.reason, 'needs human: permission')
  assert.equal(x.C1.blockedReason, 'permission denied: gh pr create')
  assert.deepEqual(x.C1.commands, ['gh pr create -R o/r --head b1 --title "t"'])
  assert.ok(!calls.some(c => /^(botwait|safety):C1/.test(c.label)))
  assert.equal(x.C2.ready, true)
})
await check('the opener prompt says to stop on a denied command and return the commands', async () => {
  await landRun({}, only('C1'))
  const open = calls.find(c => c.label === 'open:C1')
  assert.match(open.prompt, /blocked true, blockedReason, and commands/)
  assert.match(open.prompt, /Never work around a denial/)
})

// Land-fix check: the fixer's own code is tested and reviewed before the bot wait.
const ABC = 'abc'.padEnd(40, 'c')
const LANDS = [{ id: 'LA', title: 't', branch: 'la', landFix: true, prNumber: 8 }]
const landFixRun = (cfg, id = 'LA') => landRun(cfg, [{ ...LANDS[0], id, branch: 'b-' + id }])
await check('land fix: output from land-commits.sh starts a tester and a diff reviewer before the bot wait', async () => {
  const x = await landFixRun({ landOutput: ['LA'] })
  assert.equal(x.LA.ready, true)
  const labels = calls.map(c => c.label)
  assert.deepEqual(labels.filter(l => l.includes(':LA')).slice(0, 7), ['io:LA#landhead', 'landfix:LA', 'io:LA#landhead1', 'io:LA#landcommits1', 'test:LA#land1', 'landreview:LA#1', 'botwait:LA'])
  const io = calls.find(c => c.label === 'io:LA#landcommits1')
  assert.match(io.prompt, new RegExp('bash /plug/scripts/io\\.sh land-commits\\.sh o/r ' + 'b'.repeat(40) + ' ' + ABC + ' /x'))
  const rev = calls.find(c => c.label === 'landreview:LA#1')
  assert.match(rev.prompt, /\+resolved line/)
  assert.match(rev.prompt, /Read only this output/)
  assert.equal(rev.agentType, 'agent-pr-pipeline:reviewer')
  assert.equal(x.LA.land.split(':')[1], ABC)
})
await check('land fix: a tested head that is not the reviewed head makes the PR not ready', async () => {
  const x = await landFixRun({ landOutput: ['LA'], testMoved: ['LA'] })
  assert.equal(x.LA.ready, false)
  assert.equal(x.LA.reason, 'land-fix check: head moved (sha-LA-land1 is not the reviewed ' + ABC + ')')
  assert.ok(!calls.some(c => c.label === 'botwait:LA'))
})
await check('land fix: empty output from land-commits.sh starts no tester or reviewer', async () => {
  const x = await landFixRun({})
  assert.equal(x.LA.ready, true)
  assert.ok(calls.some(c => c.label === 'io:LA#landcommits1'))
  assert.ok(!calls.some(c => /^(test|landreview|fix):LA/.test(c.label)))
  assert.equal(x.LA.land.split(':')[1], ABC)
})
await check('land fix: a non-zero exit of land-commits.sh makes the PR not ready', async () => {
  const x = await landFixRun({ landFail: ['LA'] })
  assert.equal(x.LA.ready, false)
  assert.match(x.LA.reason, /^land-fix check failed: land-commits: cannot read/)
  assert.ok(!calls.some(c => /^(botwait|test|landreview):LA/.test(c.label)))
})
await check('land fix: blockers in the check run the fixer, then stop after the rounds', async () => {
  const x = await landFixRun({ landOutput: ['LA'], landBad: ['LA'] })
  assert.equal(x.LA.ready, false)
  assert.equal(x.LA.reason, 'land-fix check: rounds exhausted: 2 of 2 (botCheckRounds)')
  assert.deepEqual(calls.filter(c => c.label.startsWith('fix:LA')).map(c => c.label), ['fix:LA#land1'])
  assert.equal(calls.filter(c => c.label.startsWith('landreview:LA')).length, 2)
  assert.ok(!calls.some(c => c.label === 'botwait:LA'))
  assert.deepEqual(x.LA.lastFindings.map(f => f.title), ['the resolution drops the new flag'])
})
await check('land fix: an unreadable head before the fix stops before the fixer runs', async () => {
  const x = await run({ ...base, prs: [{ ...LANDS[0], id: 'LH' }] }, async (p, o) => o.label.endsWith('#landhead') ? { output: 'pipeline-io: begin\ngh: HTTP 404\npipeline-io: exit 1' } : agent(p, o), parallel, log)
  assert.equal(x.prs[0].ready, false)
  assert.match(x.prs[0].reason, /cannot read the head/)
})
await check('land fix: round 2 reads from the head before the land fix to the new head and gets the last blockers', async () => {
  await landFixRun({ landOutput: ['LA'], landBad: ['LA'] })
  const io2 = calls.find(c => c.label === 'io:LA#landcommits2')
  assert.ok(io2)
  assert.match(io2.prompt, new RegExp('land-commits\\.sh o/r ' + 'b'.repeat(40) + ' ' + 'c'.repeat(40)))
  assert.ok(calls.some(c => c.label === 'io:LA#landhead2'))
  assert.ok(calls.findIndex(c => c.label === 'fix:LA#land1') < calls.findIndex(c => c.label === 'io:LA#landcommits2'))
  assert.match(calls.find(c => c.label === 'landreview:LA#2').prompt, /\+resolved line/)
  assert.match(calls.find(c => c.label === 'landreview:LA#2').prompt, /the resolution drops the new flag/)
  assert.doesNotMatch(calls.find(c => c.label === 'landreview:LA#1').prompt, /last round found/)
})
await check('land fix: a major in round 1 and a clean round 2 is ready, and lands at the round-2 head', async () => {
  const x = await landFixRun({ landOutput: ['LA'], landBadOnce: ['LA'] })
  assert.equal(x.LA.ready, true, x.LA.reason)
  assert.equal(x.LA.land.split(':')[1], 'c'.repeat(40))
  assert.deepEqual(calls.filter(c => c.label.startsWith('landreview:LA')).map(c => c.label), ['landreview:LA#1', 'landreview:LA#2'])
  assert.ok(calls.some(c => c.label === 'botwait:LA'))
})
await check('land fix: a short sha from the fixer is completed from the PR head, and a head that does not extend it stops the PR', async () => {
  const ok = await landFixRun({ landOutput: ['LA'] })
  assert.equal(ok.LA.ready, true, ok.LA.reason)
  assert.match(calls.find(c => c.label === 'io:LA#landcommits1').prompt, new RegExp(' ' + ABC + ' /x'))
  const bad = await landFixRun({ landOutput: ['LA'], landOther: ['LA'] })
  assert.equal(bad.LA.ready, false)
  assert.equal(bad.LA.reason, `land-fix check: head moved (${'d'.repeat(40)} is not the fixer's abc)`)
  assert.ok(!calls.some(c => /^(test|landreview|botwait):LA|^io:LA#landcommits/.test(c.label)))
})
await check('land fix: without pluginRoot the fixer does not run', async () => {
  const { pluginRoot, ...noRoot } = base
  const x = await simulate({ ...noRoot, prs: [LANDS[0]] })
  assert.match(x.LA.reason, /^pluginRoot missing/)
  assert.ok(!calls.some(c => /^(landfix|io):LA/.test(c.label)))
})
await check('the land-fixer role file tells it never to answer bot threads', () => {
  const text = readFileSync(new URL('agents/land-fixer.md', new URL('../', import.meta.url)), 'utf8')
  assert.match(text, /never reply on review threads/i)
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

// Script and workflow minors.
await check('bot status: an open thread in the status script runs the answer agent though the waiter says 0', async () => {
  const x = await landRun({ threads: ['C1'] }, only('C1'))
  assert.equal(x.C1.ready, true)
  assert.ok(calls.some(c => c.label === 'botanswer:C1'))
  const none = await landRun({}, only('C1'))
  assert.equal(none.C1.ready, true)
  assert.ok(!calls.some(c => c.label === 'botanswer:C1'))
})
await check('the wait schema has seenHead, which the waiter prompt asks for', async () => {
  const seen = []
  const probe = async (p, o) => { if (o.label.startsWith('botwait')) seen.push({ ...o, prompt: p }); return agent(p, o) }
  await run({ ...base, prs: only('C1') }, probe, parallel, log)
  assert.ok(seen[0].schema.properties.seenHead)
  assert.match(seen[0].prompt, /Return approvedBy, seenHead, openComments/)
})
await check('quick: a stored high-risk brief on a first run lands as person without asking the safety agent', async () => {
  briefs.QHI = 'Touches: src/h.js\nAcceptance: h test\nTriage: size M, risk high, new concepts: none'
  const x = await landRun({}, [{ id: 'QHI', quick: { issue: 91 }, branch: 'fix/QHI' }], { pluginRoot: '/plug' })
  assert.equal(x.QHI.ready, true, x.QHI.reason)
  assert.equal(suffix(x.QHI), '')
  assert.match(x.QHI.landWhy, /high risk/)
  assert.ok(calls.some(c => c.label === 'io:QHI#gate'))
  assert.deepEqual(ran(/^safety:/), [])
})
await check('quick: qa false on the PR beats a QA line in the stored brief', async () => {
  briefs.QQF = 'Touches: src/q.js\nAcceptance: q test\nQA: try q input\nTriage: size M, risk medium, new concepts: none'
  await simulate({ ...quickBase, prs: [{ id: 'QQF', quick: { issue: 92 }, branch: 'fix/QQF', qa: false }] })
  assert.ok(calls.some(c => c.label.startsWith('review:QQF')))
  assert.ok(!calls.some(c => c.label.startsWith('qa:')))
  await simulate({ ...quickBase, qa: false, prs: [{ id: 'QQF', quick: { issue: 92 }, branch: 'fix/QQF' }] })
  assert.ok(!calls.some(c => c.label.startsWith('qa:')))
})
await check('evaluate: a wave of only reruns runs no evaluator, a plan PR with skipImpl still does', async () => {
  await simulate({ ...base, prs: only('P1', 'P3') })
  assert.equal(calls.filter(c => c.label === 'evaluate:wave').length, 1)
  const rerun = { id: 'R1', title: 't', branch: 'b7', skipImpl: true }
  await simulate({ ...base, prs: [rerun] })
  assert.ok(calls.length > 0 && !calls.some(c => /^(evaluate|redact)/.test(c.label)))
  assert.deepEqual(lastResult.denylist, [])
  await simulate({ ...base, prs: [{ id: 'C1', title: 't', branch: 'b1', resume: { history: [], minors: [], findings: [] } }, rerun] })
  assert.ok(!calls.some(c => /^evaluate/.test(c.label)))
  await simulate({ ...base, prs: only('P1', 'C1') })
  assert.equal(calls.filter(c => c.label === 'evaluate:wave').length, 1)
})
await check('the denylist holds finding files, docs files, branches and path suffixes, and an empty changedPaths is logged', async () => {
  for (const want of ['src/secret/area.ts', 'secret/area.ts', 'billing/invoice.ts', 'b1', 'b3']) assert.ok(mainResult.denylist.includes(want), want)
  evaluation = { items: ITEMS, changedPaths: [] }
  try { await simulate({ ...base, prs: only('C1', 'P1') }) } finally { evaluation = { items: ITEMS, changedPaths: ['src/billing/invoice.ts', 'README.md'] } }
  assert.ok(logs.some(m => /no changed paths/.test(m)))
  assert.ok(lastResult.denylist.includes('src/secret/area.ts'))
  await simulate({ ...base, prs: only('C1', 'P1') })
  assert.ok(!logs.some(m => /no changed paths/.test(m)))
})
await check('a PR whose run throws is null in the result, and the other PRs and the evaluator still run', async () => {
  calls = []
  preflight = GOOD
  const out = await run({ ...base, prs: only('C1', 'C2') }, async (p, o) => { if (o.label === 'implement:C1') throw new Error('boom'); return agent(p, o) }, parallel, log)
  assert.equal(out.prs[0], null)
  assert.equal(out.prs[1].id, 'C2')
  assert.ok(out.denylist.includes('b1'))
  assert.ok(calls.some(c => c.label === 'evaluate:wave'))
})
const cleanupOf = (cs, id, kind) => cs.filter(c => c.label === `io:${id}#cleanup${kind}`)
await check('cleanup: init runs before the first agent', () => {
  assert.equal(mainTimeline[0], 'io:wave#cleanupinit')
  assert.match(mainCleanup[0].prompt, /cleanup\.sh init '\/x'/)
  assert.equal(mainCleanup.filter(c => c.label.endsWith('cleanupinit')).length, 1)
})
await check('cleanup: a ready PR and a stopped PR each get one clones call and one worktrees call with their writers\' paths', () => {
  for (const id of ['C1', 'E1']) {
    assert.equal(cleanupOf(mainCleanup, id, 'clones').length, 1, id)
    assert.match(cleanupOf(mainCleanup, id, 'clones')[0].prompt, new RegExp(`cleanup\\.sh clones '/x' '${id}'`))
    assert.equal(cleanupOf(mainCleanup, id, 'worktrees').length, 1, id)
    assert.match(cleanupOf(mainCleanup, id, 'worktrees')[0].prompt, new RegExp(`cleanup\\.sh worktrees 'o/r' '/wt/implement-${id}'`))
  }
  assert.equal(mainResult.prs.find(p => p.id === 'C1').ready, true)
  assert.equal(mainResult.prs.find(p => p.id === 'E1').ready, false)
  const b1 = cleanupOf(mainCleanup, 'B1', 'worktrees')[0].prompt
  for (const w of ['implement-B1', 'fix-B1-bots1', 'botanswer-B1']) assert.ok(b1.includes(`'/wt/${w}'`), w)
  const g2 = cleanupOf(mainCleanup, 'G2', 'worktrees')[0].prompt
  assert.ok(g2.includes("'/wt/docs-G2'"))
})
await check('cleanup: clones run once the PR ended, so after its last other call', () => {
  const at = (re) => mainTimeline.map(l => re.test(l)).lastIndexOf(true)
  assert.ok(mainTimeline.indexOf('io:C1#cleanupclones') > at(/:C1#(?!cleanup)/))
})
await check('cleanup: clones --all runs once, after the evaluator and the redactor', () => {
  const all = mainTimeline.indexOf('io:wave#cleanupall')
  assert.ok(all > 0 && all === mainTimeline.length - 1)
  assert.ok(all > mainTimeline.indexOf('evaluate:wave') && all > mainTimeline.indexOf('redact:wave'))
  assert.match(mainCleanup.at(-1).prompt, /cleanup\.sh clones '\/x' --all/)
  assert.deepEqual(mainResult.cleanup, ['REMOVED /x/test-1'])
})
await check('cleanup: the result lists what the script printed per PR', () => {
  assert.deepEqual(mainResult.prs.find(p => p.id === 'C1').cleanup, ['REMOVED /x/test-1'])
})
await check('cleanup: false makes no cleanup call and adds no cleanup lines', async () => {
  await simulate({ ...base, cleanup: false, prs: only('C1', 'E1') })
  assert.equal(cleanupCalls.length, 0)
  assert.ok(!timeline.some(l => /cleanup/.test(l)))
  assert.ok(lastResult.prs.every(p => !('cleanup' in p)) && !('cleanup' in lastResult))
})
await check('cleanup: no pluginRoot skips cleanup and says so', async () => {
  await simulate({ ...base, pluginRoot: undefined, prs: only('E1') })
  assert.equal(cleanupCalls.length, 0)
  assert.ok(logs.some(m => /cleanup skipped: pluginRoot missing/.test(m)))
})
await check('cleanup: a failing or missing cleanup answer never stops a PR', async () => {
  for (const mode of ['fail', 'down']) {
    cleanupMode = mode
    try {
      await simulate({ ...base, prs: only('C1', 'E1') })
    } finally { cleanupMode = 'ok' }
    const c1 = lastResult.prs.find(p => p.id === 'C1')
    assert.equal(c1.ready, true, mode)
    assert.ok(c1.cleanup.length > 0 && c1.cleanup.every(l => /failed|pipeline-io failed/.test(l)), mode)
    assert.ok(Array.isArray(lastResult.cleanup) && lastResult.cleanup.length > 0, mode)
  }
})
await check('cleanup: a refused init means no clones call and no --all call, but worktrees are still cleaned', async () => {
  cleanupMode = 'refused'
  try {
    await simulate({ ...base, prs: only('C1', 'E1') })
  } finally { cleanupMode = 'ok' }
  assert.equal(cleanupCalls.filter(c => /cleanup(clones|all)$/.test(c.label)).length, 0)
  assert.equal(cleanupOf(cleanupCalls, 'C1', 'worktrees').length, 1)
  assert.ok(logs.some(m => /clones cleanup is off for this run: KEPT/.test(m)))
  assert.ok(!('cleanup' in lastResult))
})
await check('cleanup: a PR whose run throws is still cleaned up', async () => {
  calls = []; cleanupCalls = []; timeline = []
  preflight = GOOD
  const out = await run({ ...base, prs: only('C1', 'C2') }, async (p, o) => { if (o.label === 'open:C1') throw new Error('boom'); return agent(p, o) }, parallel, log)
  assert.equal(out.prs[0], null)
  assert.equal(cleanupOf(cleanupCalls, 'C1', 'clones').length, 1)
  assert.match(cleanupOf(cleanupCalls, 'C1', 'worktrees')[0].prompt, /\/wt\/implement-C1/)
})
await check('cleanup: a path with a quote is passed as one shell word', async () => {
  const quoting = async (p, o) => { const out = await agent(p, o); return o.label === 'implement:C1' ? { ...out, worktree: "/wt/it's" } : out }
  calls = []; cleanupCalls = []; timeline = []
  preflight = GOOD
  await run({ ...base, prs: only('C1') }, quoting, parallel, log)
  assert.ok(cleanupOf(cleanupCalls, 'C1', 'worktrees')[0].prompt.includes("'/wt/it'\\''s'"))
})

// Findings: one severity source, duplicates, sweep, invariants and round caps.
const hooked = async (prs, hook, extra = {}) => {
  calls = []; cleanupCalls = []; timeline = []; logs = []
  preflight = GOOD
  const out = await run({ ...base, ...extra, prs }, async (p, o) => { const h = hook(p, o); if (h === undefined) return agent(p, o); calls.push({ label: o.label, model: o.model, prompt: p }); return h }, parallel, log)
  return Object.fromEntries(out.prs.map(x => [x.id, x]))
}
const only1 = id => PRS.filter(p => p.id === id)
const f = (severity, title, extra = {}) => ({ severity, title, detail: 'd', ...extra })
const reviewOf = (findings, extra = {}) => ({ summary: 's', findings, ...extra })
const fixCalls = id => calls.filter(c => c.label.startsWith(`fix:${id}#`))
await check('severity: a review major titled [minor] x is one major line, a conflict and a clean title for the fixer', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('major', '[minor] x')]) : undefined)
  assert.deepEqual(x.C1.history[0].blockersAndMajors, ['major [review]: x'])
  assert.equal(x.C1.history[0].severityConflicts, 1)
  assert.equal(x.C1.history[1].severityConflicts, undefined)
  assert.match(fixCalls('C1')[0].prompt, /"title": "x"/)
  assert.doesNotMatch(fixCalls('C1')[0].prompt, /\[minor\] x/)
})
await check('severity: every word form is stripped, and a word inside the title stays', async () => {
  const titles = ['(Major) a1', 'blocker: a2', 'minor - a3', 'MINOR: a4', '[ Blocker ] a5', 'Major rewrite of the parser']
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf(titles.map(t => f('major', t))) : undefined)
  assert.deepEqual(x.C1.history[0].blockersAndMajors.map(l => l.replace('major [review]: ', '')).sort(), ['Major rewrite of the parser', 'a1', 'a2', 'a3', 'a4', 'a5'])
  assert.equal(x.C1.history[0].severityConflicts, 4)
})
await check('severity: a docs-check finding titled [minor] x is one major line and a conflict', async () => {
  const x = await hooked(only1('G2'), (p, o) => o.label === 'docsreview:G2#1' ? reviewOf([f('major', '[minor] x')]) : undefined)
  const row = x.G2.history.find(h => h.round === 'docs1')
  assert.deepEqual(row.blockersAndMajors, ['major [docs-check]: x'])
  assert.equal(row.severityConflicts, 1)
})
await check('severity: a bot-answer-check finding titled [minor] x is one major line and a conflict', async () => {
  const x = await hooked(only1('B1'), (p, o) => o.label === 'botreview:B1#1' ? reviewOf([f('major', '[minor] x')]) : undefined)
  const row = x.B1.history.find(h => h.round === 'bots1')
  assert.deepEqual(row.blockersAndMajors, ['major [bot answer check]: x'])
  assert.equal(row.severityConflicts, 1)
})
await check('severity: a land-fix-check finding titled [minor] x is one major line and a conflict', async () => {
  land.landOutput.add('LA')
  let x
  try { x = await hooked(LANDS, (p, o) => o.label === 'landreview:LA#1' ? reviewOf([f('major', '[minor] x')]) : undefined) } finally { for (const k of Object.keys(land)) land[k] = new Set() }
  const row = x.LA.history.find(h => h.round === 'land1')
  assert.deepEqual(row.blockersAndMajors, ['major [land-fix check]: x'])
  assert.equal(row.severityConflicts, 1)
})
await check('severity: a QA finding titled (Minor) x is one major line and a conflict', async () => {
  const x = await hooked(only1('Q1'), (p, o) => o.label === 'qa:Q1#1' ? { summary: 's', scenarios: [{ name: 's', result: 'pass' }], findings: [f('major', '(Minor) x')] } : undefined)
  assert.deepEqual(x.Q1.history[0].blockersAndMajors, ['major [qa]: x'])
  assert.equal(x.Q1.history[0].severityConflicts, 1)
})
await check('severity: an architecture minor goes to the minors and starts no fix and no second architecture run', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('major', 'y')])
    : o.label === 'arch:C1#1' ? { verdict: 'needs-change', summary: 's', newConcepts: [], findings: [f('minor', '[major] naming')] } : undefined)
  assert.ok(calls.some(c => c.label === 'review:C1#2'))
  assert.ok(!calls.some(c => c.label === 'arch:C1#2'))
  assert.match(calls.find(c => c.label === 'open:C1').prompt, /"title": "naming"/)
  assert.equal(x.C1.history[0].severityConflicts, 1)
})
await check('severity: a fits architecture report keeps its minors and starts no fix and no second architecture run', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('major', 'y')])
    : o.label === 'arch:C1#1' ? { verdict: 'fits', summary: 's', newConcepts: [], findings: [f('minor', 'naming')] } : undefined)
  assert.ok(calls.some(c => c.label === 'review:C1#2'))
  assert.ok(!calls.some(c => c.label === 'arch:C1#2'))
  assert.match(calls.find(c => c.label === 'open:C1').prompt, /"title": "naming"/)
})
await check('severity: a review finding goes through splitFindings, so a severity word in the title is stripped', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('major', '[minor] x')]) : undefined)
  assert.equal(x.C1.history[0].blockersAndMajors[0], 'major [review]: x')
  assert.equal(x.C1.history[0].severityConflicts, 1)
})
await check('duplicates: a minor from one source and a major from another merge into one major and no minor', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('minor', 'Wrong layer', { file: 'a.js' })])
    : o.label === 'arch:C1#1' ? { verdict: 'needs-change', summary: 's', newConcepts: [], findings: [f('major', 'wrong layer', { file: 'a.js' })] } : undefined)
  assert.deepEqual(x.C1.history[0].blockersAndMajors, ['major [review, architecture]: Wrong layer'])
  assert.doesNotMatch(calls.find(c => c.label === 'open:C1').prompt, /"title": "Wrong layer"/)
})
await check('severity: a needs-change with no findings is a fallback major and the architecture review runs again', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'arch:C1#1' ? { verdict: 'needs-change', summary: 'too big', newConcepts: [], findings: [] } : undefined)
  assert.deepEqual(x.C1.history[0].blockersAndMajors, ['major [architecture]: Architecture review asked for changes'])
  assert.ok(calls.some(c => c.label === 'arch:C1#2'))
})
await check('severity: an architecture major keeps the architecture review running until it fits', () => {
  assert.ok(mainCalls.some(c => c.label === 'arch:N1#2'))
  assert.ok(!mainCalls.some(c => c.label === 'arch:N1#3'))
  assert.ok(!mainCalls.some(c => c.label === 'arch:C1#2'))
})
await check('duplicates: one finding from the reviewer and the architecture reviewer is one line, one item and the highest severity', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('major', 'Wrong layer!', { file: 'a.js' })])
    : o.label === 'arch:C1#1' ? { verdict: 'needs-change', summary: 's', newConcepts: [], findings: [f('blocker', 'wrong layer', { file: 'a.js' })] } : undefined)
  assert.deepEqual(x.C1.history[0].blockersAndMajors, ['blocker [review, architecture]: Wrong layer!'])
  assert.equal((fixCalls('C1')[0].prompt.match(/"n":/g) || []).length, 1)
})
await check('duplicates: the same title in two files stays two items', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('major', 'same', { file: 'a.js' }), f('major', 'same', { file: 'b.js' })]) : undefined)
  assert.equal(x.C1.history[0].blockersAndMajors.length, 2)
})
await check('duplicates: a higher severity keeps its own detail and fix, with the lower detail appended', async () => {
  await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('minor', 'Wrong layer', { file: 'a.js', detail: 'minor text' })])
    : o.label === 'arch:C1#1' ? { verdict: 'needs-change', summary: 's', newConcepts: [], findings: [f('major', 'wrong layer', { file: 'a.js', detail: 'arch reasoning', suggestedFix: 'move it' })] } : undefined)
  const prompt = fixCalls('C1')[0].prompt
  assert.match(prompt, /arch reasoning/)
  assert.match(prompt, /move it/)
  assert.match(prompt, /Also: minor text/)
})
await check('duplicates: the fix prompt numbers the findings and groups them by file', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('major', 'one', { file: 'b.js' }), f('major', 'two', { file: 'a.js' }), f('major', 'three', { file: 'b.js' })]) : undefined)
  const prompt = fixCalls('C1')[0].prompt
  assert.ok(prompt.indexOf('File a.js') < prompt.indexOf('File b.js'))
  assert.equal((prompt.match(/File b\.js/g) || []).length, 1)
  assert.deepEqual(x.C1.history[0].blockersAndMajors.map(l => l.replace('major [review]: ', '')), ['two', 'one', 'three'])
  assert.match(prompt, /"n": 1,\s+"severity": "major",\s+"title": "two"/)
})
await check('duplicates: sameAs folds two lines into one with every source, and bad groups change nothing', async () => {
  const two = (p, o) => o.label === 'review:C1#1' ? reviewOf([f('major', 'one', { file: 'a.js' }), f('minor', 'x'), f('blocker', 'two', { file: 'b.js' })]) : undefined
  const x = await hooked(only1('C1'), (p, o) => two(p, o) || (o.label === 'fix:C1#1' ? { summary: 's', worktree: '/w', sameAs: [[1, 2]] } : undefined))
  assert.deepEqual(x.C1.history[0].blockersAndMajors, ['blocker [review]: one'])
  const y = await hooked(only1('C1'), (p, o) => two(p, o) || (o.label === 'fix:C1#1' ? { summary: 's', worktree: '/w', sameAs: [[1, 1], [5, 6], [2]] } : undefined))
  assert.equal(y.C1.history[0].blockersAndMajors.length, 2)
})
await check('caps: a code PR stops with both numbers and maxRounds', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label.startsWith('review:C1') ? reviewOf([f('major', 'x')]) : undefined)
  assert.equal(x.C1.reason, 'rounds exhausted: 4 of 4 (maxRounds)')
  assert.equal(x.C1.history.length, 4)
  const y = await hooked(only1('C1'), (p, o) => o.label.startsWith('review:C1') ? reviewOf([f('major', 'x')]) : undefined, { maxRounds: 2 })
  assert.equal(y.C1.reason, 'rounds exhausted: 2 of 2 (maxRounds)')
})
await check('caps: a PR with its own maxRounds names prs[].maxRounds', async () => {
  const x = await hooked([{ ...only1('C1')[0], maxRounds: 1 }], (p, o) => o.label.startsWith('review:C1') ? reviewOf([f('major', 'x')]) : undefined)
  assert.equal(x.C1.reason, 'rounds exhausted: 1 of 1 (prs[].maxRounds)')
})
await check('caps: the bot answer check names botCheckRounds, and the args change the numbers', async () => {
  const bad = (p, o) => o.label.startsWith('botreview:B1') ? reviewOf([f('major', 'x')]) : undefined
  const x = await hooked(only1('B1'), bad)
  assert.equal(x.B1.reason, 'bot answer check: rounds exhausted: 2 of 2 (botCheckRounds)')
  const y = await hooked(only1('B1'), bad, { botCheckRounds: 3 })
  assert.equal(y.B1.reason, 'bot answer check: rounds exhausted: 3 of 3 (botCheckRounds)')
  const z = await hooked(only1('G3'), () => undefined, { docsRounds: 1 })
  assert.equal(z.G3.reason, 'docs check: rounds exhausted: 1 of 1 (docsRounds)')
})
await check('sweep: the reviewer sweep is in the fix prompt and the fixer siblings are in the next review prompt', async () => {
  const sweep = [{ finding: 'x', checked: ['callers of parse in b.js'], sameWeakness: ['c.js'] }]
  const siblings = [{ finding: 1, checked: ['d.js'], fixed: ['d.js'] }]
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([f('major', 'x')], { sweep })
    : o.label === 'fix:C1#1' ? { summary: 's', worktree: '/w', siblings } : undefined)
  assert.equal(x.C1.ready, true)
  assert.match(fixCalls('C1')[0].prompt, /callers of parse in b\.js/)
  assert.doesNotMatch(calls.find(c => c.label === 'review:C1#1').prompt, /sweep of sibling places in the last fix round/)
  const next = calls.find(c => c.label === 'review:C1#2').prompt
  assert.match(next, /sweep of sibling places in the last fix round/)
  assert.match(next, /"fixed": \[\s+"d\.js"/)
})
await check('invariants: a row that does not hold becomes a major and one that holds does not', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'review:C1#1' ? reviewOf([], { invariants: [{ text: 'every path calls splitFindings', holds: false, evidence: 'docs path does not' }, { text: 'caps name both numbers', holds: true, evidence: 'e' }] }) : undefined)
  assert.deepEqual(x.C1.history[0].blockersAndMajors, ['major [review]: [invariant] every path calls splitFindings'])
  assert.match(fixCalls('C1')[0].prompt, /docs path does not/)
})
await check('invariants: a stored brief with an Invariants line reaches the reviewer', async () => {
  TRIAGES.QI = triage('build', 'M', 'medium', { entry: { touches: 'src/qi.js', acceptance: 'node --test passes', invariants: 'a refused input never writes' } })
  await simulate({ ...quickBase, prs: [{ id: 'QI', quick: { issue: 93 }, branch: 'fix/QI' }] })
  assert.match(briefs.QI, /^Invariants: a refused input never writes$/m)
  assert.match(calls.find(c => c.label === 'review:QI#1').prompt, /Invariants: a refused input never writes/)
  assert.doesNotMatch(entryOf('QS'), /Invariants/)
})
await check('plan review: a plan PR runs the architecture review in every round with its earlier reports', () => {
  for (const n of [1, 2, 3]) assert.ok(mainCalls.some(c => c.label === `arch:P1#${n}`), `round ${n}`)
  assert.doesNotMatch(mainCalls.find(c => c.label === 'arch:P1#1').prompt, /earlier reports/)
  const third = mainCalls.find(c => c.label === 'arch:P1#3').prompt
  assert.match(third, /earlier reports/)
  assert.match(third, /"round": 1/)
  assert.match(third, /"round": 2/)
})

// U01: untested is not passed.
const chk = (name, extra = {}) => ({ name, pass: true, ...extra })
const tested = (id, answer, round = '1') => (p, o) => o.label === `test:${id}#${round}` ? { headSha: 'sha-' + id, ...answer } : undefined
const cleanReview = (id, hook) => (p, o) => o.label.startsWith('review:') && o.label.includes(`:${id}#`) ? reviewOf([f('minor', 'm')]) : hook(p, o)
const openOf = id => calls.find(c => c.label === `open:${id}`)
await check('untested: a refused check starts no fix, signs off, and is listed, with no :auto and a body file', async () => {
  const x = await hooked(only1('C1'), tested('C1', { pass: false, checks: [chk('unit'), { name: 'lint', pass: false, refused: true }] }))
  assert.equal(x.C1.ready, true)
  assert.equal(fixCalls('C1').length, 0)
  assert.equal(x.C1.history.length, 1)
  assert.equal(x.C1.history[0].testPass, true)
  assert.deepEqual(x.C1.history[0].notRun, ['lint (refused)'])
  assert.deepEqual(x.C1.history[0].failingChecks, [])
  assert.deepEqual(x.C1.untested, ['lint (refused)'])
  assert.equal(x.C1.landMode, 'person')
  assert.match(x.C1.landWhy, /^untested: lint \(refused\)$/)
  assert.ok(!x.C1.land.endsWith(':auto'))
  assert.match(openOf('C1').prompt, /Untested items: \["lint \(refused\)"\]/)
  assert.match(openOf('C1').prompt, /--body-file/)
  assert.match(openOf('C1').prompt, /Untested" section/)
})
await check('untested: a clean run has an empty untested list and keeps :auto', async () => {
  const x = await hooked(only1('C1'), () => undefined)
  assert.deepEqual(x.C1.untested, [])
  assert.equal(x.C1.landMode, 'auto')
})
await check('untested: a real failure next to a refused check gives a fix prompt with only the real failure', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'test:C1#1' ? { pass: true, headSha: 'sha-C1', checks: [chk('unit', { pass: false, log: 'boom in unit' }), { name: 'lint', pass: false, refused: true }, chk('types')] } : undefined)
  assert.equal(fixCalls('C1').length, 1)
  const prompt = fixCalls('C1')[0].prompt
  assert.match(prompt, /boom in unit/)
  assert.doesNotMatch(prompt.split('Failing checks:')[1], /lint/)
  assert.deepEqual(x.C1.history[0].failingChecks, ['unit'])
})
await check('untested: the agent pass is ignored in both directions', async () => {
  const bad = await hooked(only1('C1'), tested('C1', { pass: true, checks: [chk('unit'), chk('lint', { pass: false })] }))
  assert.equal(bad.C1.history[0].testPass, false)
  assert.equal(fixCalls('C1').length, 1)
  const good = await hooked(only1('C1'), tested('C1', { pass: false, checks: [chk('unit'), chk('lint')] }))
  assert.equal(good.C1.history.length, 1)
  assert.equal(fixCalls('C1').length, 0)
})
for (const [what, answer] of [['pass true with no checks', { pass: true, checks: [] }], ['pass false with no checks', { pass: false, checks: [] }],
  ['every check refused', { pass: false, checks: [{ name: 'a', pass: false, refused: true }, { name: 'b', pass: false, refused: true }] }]]) {
  await check(`untested: ${what} stops the PR with tests did not run, no fixer and no sign-off`, async () => {
    const x = await hooked(only1('C1'), tested('C1', answer))
    assert.equal(x.C1.ready, false)
    assert.equal(x.C1.reason, 'tests did not run')
    assert.equal(fixCalls('C1').length, 0)
    assert.ok(!calls.some(c => /^(open|docs):C1/.test(c.label)))
  })
}
const acc = (check, declared = true) => ({ declared, check })
await check('untested: a declared acceptance test that is missing or failed gives a fix round and no sign-off', async () => {
  const missing = await hooked(only1('C1'), (p, o) => o.label === 'test:C1#1' ? { pass: true, headSha: 'sha-C1', checks: [chk('lint')], acceptance: acc('x') } : undefined)
  assert.match(fixCalls('C1')[0].prompt, /acceptance test did not run/)
  assert.deepEqual(missing.C1.history[0].blockersAndMajors, ['major [test]: acceptance test did not run'])
  assert.equal(missing.C1.history[0].testPass, false)
  const failed = await hooked(only1('C1'), (p, o) => o.label === 'test:C1#1' ? { pass: true, headSha: 'sha-C1', checks: [chk('lint'), chk('x', { pass: false, log: 'x exploded' })], acceptance: acc('x') } : undefined)
  const prompt = fixCalls('C1')[0].prompt
  assert.match(prompt, /x exploded/)
  assert.doesNotMatch(prompt, /acceptance test did not run/)
  assert.equal(failed.C1.history[0].testPass, false)
})
await check('untested: the same list with declared false signs off, and a passed acceptance check signs off', async () => {
  const off = await hooked(only1('C1'), tested('C1', { pass: true, checks: [chk('lint')], acceptance: acc('x', false) }))
  assert.equal(off.C1.history.length, 1)
  assert.equal(fixCalls('C1').length, 0)
  const on = await hooked(only1('C1'), tested('C1', { pass: true, checks: [chk('lint'), chk('x')], acceptance: acc('x') }))
  assert.equal(on.C1.history.length, 1)
  assert.equal(on.C1.landMode, 'auto')
})
await check('untested: a refused acceptance check starts no fix, signs off, is untested and gets no :auto', async () => {
  const x = await hooked(only1('C1'), tested('C1', { pass: true, checks: [chk('lint'), { name: 'x', pass: false, refused: true }], acceptance: acc('x') }))
  assert.equal(x.C1.ready, true)
  assert.equal(fixCalls('C1').length, 0)
  assert.deepEqual(x.C1.untested, ['x (refused)'])
  assert.deepEqual(x.C1.history[0].notRun, ['x (refused)'])
  assert.ok(!x.C1.land.endsWith(':auto'))
})
await check('untested: a plan PR signs off with a declared acceptance test that is not in the list', async () => {
  const x = await hooked(only1('P1'), cleanReview('P1', tested('P1', { pass: true, checks: [chk('lint')], acceptance: acc('x') })))
  assert.equal(x.P1.ready, true)
  assert.equal(x.P1.history.length, 1)
})
await check('untested: a docs re-check with no check that ran stops the PR', async () => {
  const x = await hooked(only1('G1'), tested('G1', { pass: true, checks: [] }, 'docs1'))
  assert.equal(x.G1.ready, false)
  assert.equal(x.G1.reason, 'docs check: tests did not run')
})
await check('untested: a bot-answer check with no check that ran stops the PR', async () => {
  const x = await hooked(only1('B1'), tested('B1', { pass: true, checks: [] }, 'bots1'))
  assert.equal(x.B1.ready, false)
  assert.equal(x.B1.reason, 'bot answer check: tests did not run')
})
await check('untested: the refused checks of the last test round replace those of an earlier one', async () => {
  const x = await hooked(only1('C1'), (p, o) => o.label === 'test:C1#1' ? { pass: true, headSha: 'sha-C1', checks: [chk('lint', { refused: true, pass: false }), chk('unit', { pass: false })] }
    : o.label === 'test:C1#2' ? { pass: true, headSha: 'sha-C1', checks: [chk('lint'), chk('unit')] } : undefined)
  assert.equal(x.C1.history.length, 2)
  assert.deepEqual(x.C1.untested, [])
  assert.equal(x.C1.landMode, 'auto')
})

await check('untested: a refused check in a bot-answer test round updates the PR body, and a failed update stops the PR', async () => {
  const refusedBots = (p, o) => o.label === 'test:C2#bots1' ? { headSha: 'sha-answer-C2', pass: true, checks: [chk('unit'), { name: 'lint', pass: false, refused: true }] } : undefined
  const x = await hooked(only1('C2'), refusedBots)
  assert.equal(x.C2.ready, true)
  assert.deepEqual(x.C2.untested, ['lint (refused)'])
  assert.equal(x.C2.landMode, 'person')
  const body = calls.find(c => c.label === 'open:C2#body')
  assert.ok(body)
  assert.match(body.prompt, /Untested items: \["lint \(refused\)"\]/)
  assert.match(body.prompt, /--body-file/)
  const y = await hooked(only1('C2'), (p, o) => o.label === 'open:C2#body' ? { updated: false } : refusedBots(p, o))
  assert.equal(y.C2.ready, false)
  assert.match(y.C2.reason, /PR body not updated/)
})
await check('untested: a bot-answer test round that clears a refused check updates the PR body', async () => {
  const x = await hooked(only1('C2'), (p, o) => o.label === 'test:C2#1' ? { pass: true, headSha: (lastHead.C2 = 'sha-C2'), checks: [chk('unit'), { name: 'lint', pass: false, refused: true }] }
    : o.label === 'test:C2#bots1' ? { headSha: 'sha-answer-C2', pass: true, checks: [chk('unit'), chk('lint')] } : undefined)
  assert.equal(x.C2.ready, true, x.C2.reason)
  assert.deepEqual(x.C2.untested, [])
  const body = calls.find(c => c.label === 'open:C2#body')
  assert.ok(body)
  assert.match(body.prompt, /Untested items: \[\]/)
})
await check('untested: a land fix with a refused check sends a body prompt that only adds items', async () => {
  land.landOutput.add('LA')
  try {
    const x = await hooked([{ ...LANDS[0], branch: 'b-LA' }], (p, o) => o.label === 'test:LA#land1' ? { headSha: ABC, pass: true, checks: [chk('unit'), { name: 'lint', pass: false, refused: true }] } : undefined)
    assert.equal(x.LA.ready, true, x.LA.reason)
    assert.deepEqual(x.LA.untested, ['lint (refused)'])
    const body = calls.find(c => c.label === 'open:LA#body')
    assert.ok(body)
    assert.match(body.prompt, /Untested items: \["lint \(refused\)"\]/)
    assert.match(body.prompt, /Keep the items already listed/)
    assert.doesNotMatch(body.prompt, /drop|remove the section|exactly/)
  } finally { land.landOutput.delete('LA') }
})
await check('untested: no body update when the open prompt already listed every item', async () => {
  await hooked(only1('C1'), tested('C1', { pass: true, checks: [chk('unit'), { name: 'lint', pass: false, refused: true }] }))
  assert.ok(!calls.some(c => c.label === 'open:C1#body'))
})

const scen = (name, result, extra = {}) => ({ name, result, ...extra })
const qaRun = (...rounds) => (p, o) => {
  const m = /^qa:Q1#(\d+)$/.exec(o.label)
  return m ? { summary: 's', findings: [], ...rounds[Math.min(m[1], rounds.length) - 1] } : undefined
}
const quietReview = hook => (p, o) => o.label.startsWith('review:Q1#') ? reviewOf([f('minor', 'm')]) : hook(p, o)
await check('QA: a failed scenario with only a minor finding makes QA run again with the name, and a pass there signs off', async () => {
  const x = await hooked(only1('Q1'), quietReview(qaRun({ scenarios: [scen('empty input', 'fail', { actual: '1' })], findings: [f('minor', 'wording')] }, { scenarios: [scen('empty input', 'pass')] })))
  assert.match(fixCalls('Q1')[0].prompt, /QA scenario failed: empty input/)
  assert.match(calls.find(c => c.label === 'qa:Q1#2').prompt, /"name":"empty input","state":"open"/)
  assert.equal(x.Q1.ready, true)
  assert.equal(x.Q1.history.length, 2)
})
await check('QA: a scenario that fails in every round stops with rounds exhausted and the name', async () => {
  const x = await hooked(only1('Q1'), quietReview(qaRun({ scenarios: [scen('empty input', 'fail')] })), { maxRounds: 2 })
  assert.equal(x.Q1.ready, false)
  assert.equal(x.Q1.reason, 'rounds exhausted: 2 of 2 (maxRounds)')
  assert.ok(x.Q1.lastFindings.some(g => g.title === 'QA scenario failed: empty input'))
})
await check('QA: a run that leaves out the open name keeps it open', async () => {
  const x = await hooked(only1('Q1'), quietReview(qaRun({ scenarios: [scen('empty input', 'fail')] }, { scenarios: [scen('other', 'pass')] })), { maxRounds: 2 })
  assert.equal(x.Q1.ready, false)
  assert.ok(x.Q1.lastFindings.some(g => g.title === 'QA scenario failed: empty input'))
  assert.ok(calls.some(c => c.label === 'qa:Q1#2'))
})
await check('QA: not-run on an open scenario keeps it open', async () => {
  const x = await hooked(only1('Q1'), quietReview(qaRun({ scenarios: [scen('empty input', 'fail')] }, { scenarios: [scen('empty input', 'not-run', { whyNotRun: 'denied' })] })), { maxRounds: 2 })
  assert.equal(x.Q1.ready, false)
  assert.ok(x.Q1.lastFindings.some(g => g.title === 'QA scenario failed: empty input'))
})
await check('QA: a not-run scenario gives a ready PR with no :auto and the scenario in the body and the result', async () => {
  const x = await hooked(only1('Q1'), quietReview(qaRun({ scenarios: [scen('triage mode', 'not-run', { whyNotRun: 'no scratch repo' }), scen('acceptance', 'pass')] })))
  assert.equal(x.Q1.ready, true)
  assert.equal(fixCalls('Q1').length, 0)
  assert.deepEqual(x.Q1.untested, ['QA scenario triage mode (not run: no scratch repo)'])
  assert.ok(!x.Q1.land.endsWith(':auto'))
  assert.match(x.Q1.landWhy, /^untested: QA scenario triage mode/)
  assert.match(openOf('Q1').prompt, /QA scenario triage mode \(not run: no scratch repo\)/)
  assert.deepEqual(x.Q1.qa[0].notRun, ['triage mode'])
})
await check('QA: a later pass ends an untested scenario', async () => {
  const x = await hooked(only1('Q1'), quietReview(qaRun({ scenarios: [scen('triage mode', 'not-run'), scen('empty input', 'fail')] }, { scenarios: [scen('triage mode', 'pass'), scen('empty input', 'pass')] })))
  assert.equal(x.Q1.ready, true)
  assert.equal(x.Q1.history.length, 2)
  assert.deepEqual(x.Q1.untested, [])
})
await check('bot answer: the prompt sends the reply from a file and never inline', async () => {
  await hooked(only1('B1'), () => undefined)
  const prompt = calls.find(c => c.label === 'botanswer:B1').prompt
  assert.match(prompt, /-F body=@<file>/)
  assert.doesNotMatch(prompt, /-f body=/)
})
