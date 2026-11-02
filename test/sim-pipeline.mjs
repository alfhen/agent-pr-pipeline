import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../workflow/pr-pipeline.js', import.meta.url), 'utf8').replace('export const meta', 'const meta')
const calls = []
const agent = async (prompt, o) => {
  calls.push(`${o.label} [${o.model}/${o.effort}]`)
  const id = o.label.split(':')[1].split('#')[0]
  if (o.label.startsWith('preflight')) return globalThis.PRE
  if (o.label.startsWith('product')) {
    if (id === 'P2') return { verdict: 'escalate', summary: 's', entries: [{ entry: 'V04 MCP server', fit: 'widens-scope', suggestion: 'cut' }], escalation: { question: 'Keep the product CLI only?', recommendation: 'cut V04' } }
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
  if (o.label.startsWith('test')) return { pass: true, headSha: 'sha-' + id, checks: [{ name: 'lint', pass: true }] }
  if (o.label.startsWith('review')) return { summary: 's', findings: (id === 'P1') ? [{ severity: 'major', title: 'x', detail: 'd' }] : [{ severity: 'minor', title: 'm', detail: 'd' }] }
  if (o.label.startsWith('open')) return { prNumber: 10 + calls.length, prUrl: 'u', issuesCreated: [] }
  if (o.label.startsWith('botwait')) return id === 'C1' && globalThis.FAILWAIT ? null : { approvedBy: ['gitar-bot'], openComments: id === 'C2' ? 2 : 0 }
  if (o.label.startsWith('botanswer')) return { codeChanged: true, substantiveChange: false, headSha: 'sha-answer-' + id }
  if (o.label.startsWith('landfix')) return { readyToMerge: true, headSha: 'abc', notes: 'ok' }
  return null
}
const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
const log = () => {}
const args = { repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/design.md', prs: [
  { id: 'E1', title: 't', branch: 'b5' },
  { id: 'N1', title: 't', branch: 'b6' },
  { id: 'D1', title: 't', branch: 'b7', kind: 'docs' },
  { id: 'C1', title: 't', branch: 'b1' },
  { id: 'C2', title: 't', branch: 'b2' },
  { id: 'P1', title: 'plan', branch: 'b3', kind: 'plan', skipImpl: true },
  { id: 'L1', title: 't', branch: 'b4', landFix: true, prNumber: 7 },
  { id: 'P2', title: 'plan2', branch: 'b8', kind: 'plan', skipImpl: true },
  { id: 'P3', title: 'plan3', branch: 'b9', kind: 'plan', skipImpl: true },
] }
globalThis.PRE = { ok: true, exists: true, goals: 3, nonGoals: 2, missing: [] }
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`)
const out = await run(args, agent, parallel, log)
for (const r of out) console.log(r.id, 'land=' + (r.land || '-'), 'ready=' + r.ready, r.reason || '', 'rounds=' + (r.rounds ?? r.history?.length ?? '-'), 'arch=' + JSON.stringify((r.architecture||[]).map(a=>a.verdict)), r.product ? 'product=' + r.product.verdict : '', r.escalation ? 'Q: ' + r.escalation.question : '')
console.log(calls.filter(c=>c.startsWith('preflight')).join('\n'))
globalThis.FAILWAIT = true
calls.length = 0
const outW = await run(args, agent, parallel, log)
console.log('FAILED WAIT C1:', outW.find(r => r.id === 'C1').ready, outW.find(r => r.id === 'C1').reason)
globalThis.FAILWAIT = false
globalThis.PRE = { ok: false, exists: true, goals: 2, nonGoals: 0, missing: ['Non-goals items'] }
calls.length = 0
const out2 = await run(args, agent, parallel, log)
console.log('REFUSED CASE:', out2[0].refused, out2[0].reason, '| agents started:', calls.length)
try { await run(Object.assign({}, args, { goals: undefined }), agent, parallel, log) } catch (e) { console.log('NO GOALS ARG:', e.message.slice(0, 60)) }
