import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'scripts', 'recover-evals.sh')
const fixtures = join(root, 'test', 'fixtures', 'recover-evals')
const tmp = mkdtempSync(join(tmpdir(), 'recover-evals-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
let counter = 0

const ev = (id, kind, extra = {}) => ({ id, kind, statement: `${id} must hold`, check: `run ${id}; expect ok`, ...extra })
const list1 = [ev('C1-1', 'behaviour'), ev('C1-2', 'error path')]
const list2 = [ev('C1-1', 'behaviour', { statement: 'C1-1 second attempt' }), ev('C1-2', 'error path')]
const writer = (list, extra = {}) => ({ evals: list, noErrorPath: '', noReference: '', algorithm: false, notes: '', ...extra })
const ok = { verdict: 'ok', notes: '' }
const refuse = { verdict: 'needs-change', notes: 'gap' }
const row = (id, result, extra = {}) => ({ id, result, evidence: 'x', breakCheck: 'fails-without-change', ...extra })
const verifier = rows => ({ pass: true, headSha: 'sha', checks: [], evals: rows })

// A run as the two input forms hold it: [{ label, answer }] in call order.
function build(form, steps) {
  const path = join(tmp, `run-${++counter}`)
  if (form === 'journal') {
    const lines = [{ type: 'launched' }]
    steps.forEach((s, i) => {
      lines.push({ type: 'started', key: `k${i}`, agentId: `a${i}`, label: s.label, phase: 'p' })
      if (s.answer != null) lines.push({ type: 'result', key: `k${i}`, agentId: `a${i}`, result: s.answer, toolsUsed: ['StructuredOutput'] })
    })
    writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  } else {
    mkdirSync(path)
    steps.forEach((s, i) => {
      writeFileSync(join(path, `agent-a${i}.meta.json`), JSON.stringify({ agentType: 'x', description: s.label }))
      const stamp = `2026-11-11T10:00:${String(10 + i).padStart(2, '0')}.000Z`
      writeFileSync(join(path, `agent-a${i}.jsonl`), [
        { type: 'user', timestamp: stamp, message: { content: s.prompt ?? 'prompt' } },
        ...(s.answer != null ? [{ type: 'assistant', timestamp: stamp, message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: s.answer }] } }] : []),
      ].map(l => JSON.stringify(l)).join('\n') + '\n')
    })
  }
  return path
}
const run = (path, pr = 'C1') => spawnSync('bash', [script, path, pr], { encoding: 'utf8' })
const FORMS = ['journal', 'folder']
const holds = (steps, label, pred) => assert.ok(steps.some(s => s.label === label && pred(s.answer)), `fixture lacks ${label}`)

const okRun = [
  { label: 'evals:C1', answer: writer(list1) },
  { label: 'evalsarch:C1#1', answer: ok },
  { label: 'verify:C1#1', answer: verifier([row('C1-1', 'fail', { evidence: 'first'}), row('C1-2', 'pass')]) },
  { label: 'verify:C1#2', answer: verifier([row('C1-1', 'pass', { evidence: 'second' })]) },
]
const okExpected = JSON.parse(readFileSync(join(fixtures, 'expected-ok.json'), 'utf8'))

test('A01-7 the committed journal and transcript fixtures print the expected list, meta, record and last results', () => {
  for (const path of [join(fixtures, 'journal-ok.jsonl'), join(fixtures, 'transcripts-ok')]) {
    const r = run(path)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), okExpected)
  }
  assert.equal(okExpected.results['C1-1'].evidence, 'second')
  assert.equal(okExpected.results['C1-2'].result, 'pass')
  assert.deepEqual(okExpected.evalsMeta.accepted.evals, okExpected.evals)
})

test('A01-7 built runs: the later verifier answer wins for one id', () => {
  for (const form of FORMS) {
    const r = run(build(form, okRun))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), okExpected)
  }
})

test('A01-7 a second writer attempt that is accepted is the record', () => {
  const steps = [
    { label: 'evals:C1', answer: writer(list1) },
    { label: 'evalsarch:C1#1', answer: refuse },
    { label: 'evals:C1#w2', answer: writer(list2) },
    { label: 'evalsarch:C1#2', answer: ok },
  ]
  holds(steps, 'evalsarch:C1#1', a => a.verdict === 'needs-change')
  for (const form of FORMS) {
    const out = JSON.parse(run(build(form, steps)).stdout)
    assert.deepEqual(out.evals, list2)
    assert.deepEqual(out.evalsMeta.accepted.evals, list2)
  }
})

const change = ev('C1-1', 'behaviour', { statement: 'C1-1 after the dispute' })
const withDispute = (ruling, check) => [
  { label: 'evals:C1', answer: writer(list1) },
  { label: 'evalsarch:C1#1', answer: ok },
  { label: 'implement:C1', answer: { pushed: true } },
  { label: 'fix:C1#1', answer: { disputes: [{ id: 'C1-1' }] } },
  { label: 'dispute:C1#1', answer: ruling === 'change' ? { ruling, reason: 'r', eval: change } : { ruling, reason: 'r' } },
  ...(check ? [{ label: 'evalsarch:C1#d1', answer: check }] : []),
]

test('A01-7 a change that the check refused and a keep ruling leave the record as the writer list', () => {
  const refused = withDispute('change', refuse)
  holds(refused, 'evalsarch:C1#d1', a => a.verdict === 'needs-change')
  holds(refused, 'dispute:C1#1', a => a.eval.statement === change.statement)
  const kept = withDispute('keep')
  holds(kept, 'dispute:C1#1', a => a.ruling === 'keep')
  for (const form of FORMS) {
    for (const steps of [refused, kept]) {
      const out = JSON.parse(run(build(form, steps)).stdout)
      assert.deepEqual(out.evalsMeta.accepted.evals, list1)
    }
  }
})

test('A01-12 a dispute change that the check accepted is the record', () => {
  const steps = withDispute('change', ok)
  holds(steps, 'dispute:C1#1', a => a.eval.statement === change.statement)
  assert.ok(!list1.some(e => e.statement === change.statement))
  for (const form of FORMS) {
    const r = run(build(form, steps))
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.evalsMeta.accepted.evals, [change, list1[1]])
    assert.deepEqual(out.evals, [change, list1[1]])
  }
})

test('A01-8 no accepted list, or a missing path, exits non-zero and prints no list', () => {
  const otherPr = [{ label: 'evals:C2', answer: writer(list1) }, { label: 'evalsarch:C2#1', answer: ok }]
  const died = [{ label: 'evals:C1', answer: writer(list1) }]
  const productRefused = [
    { label: 'evals:C1', answer: writer(list1) },
    { label: 'evalsarch:C1#1', answer: ok },
    { label: 'evalsproduct:C1#1', answer: refuse },
  ]
  const productSilent = [
    { label: 'evals:C1', answer: writer(list1) },
    { label: 'evalsarch:C1#1', answer: ok },
    { label: 'evalsproduct:C1#1', answer: null },
  ]
  const disputeSilent = [
    { label: 'evals:C1', answer: writer(list1) },
    { label: 'evalsarch:C1#1', answer: ok },
    { label: 'dispute:C1#1', answer: { ruling: 'change', eval: ev('C1-2', 'error path', { statement: 'changed' }), reason: 'r' } },
    { label: 'evalsarch:C1#d1', answer: ok },
    { label: 'evalsproduct:C1#d1', answer: null },
  ]
  holds(otherPr, 'evals:C2', a => Array.isArray(a.evals))
  holds(died, 'evals:C1', a => Array.isArray(a.evals))
  assert.ok(!died.some(s => s.label.startsWith('evalsarch')))
  holds(productRefused, 'evalsarch:C1#1', a => a.verdict === 'ok')
  holds(productRefused, 'evalsproduct:C1#1', a => a.verdict === 'needs-change')
  for (const form of FORMS) {
    for (const steps of [otherPr, died, productRefused, productSilent]) {
      const r = run(build(form, steps))
      assert.notEqual(r.status, 0)
      assert.equal(r.stdout, '')
      assert.match(r.stderr, /C1/)
    }
    const r2 = run(build(form, disputeSilent))
    assert.equal(r2.status, 0)
    assert.deepEqual(JSON.parse(r2.stdout).evals, list1)
    const missing = join(tmp, `missing-${form}`)
    const r = run(missing)
    assert.notEqual(r.status, 0)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes(missing))
  }
})

test('A01-16 shell text in an answer is printed as text and never runs', () => {
  for (const form of FORMS) {
    const m1 = join(tmp, `marker1-${form}`)
    const m2 = join(tmp, `marker2-${form}`)
    const hostile = [
      ev('C1-1', 'behaviour', { statement: `runs $(touch ${m1}) here`, check: `\`touch ${m2}\`; expect ok` }),
      ev('C1-2', 'error path'),
    ]
    const steps = [{ label: 'evals:C1', answer: writer(hostile) }, { label: 'evalsarch:C1#1', answer: ok }]
    holds(steps, 'evals:C1', a => a.evals[0].statement.includes('$(touch') && a.evals[0].check.includes('`touch'))
    const r = run(build(form, steps))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout).evals, hostile)
    assert.ok(!existsSync(m1) && !existsSync(m2))
  }
})

test('A01-7 a run whose architecture reviewer was off is accepted on the product answer', () => {
  const steps = [
    { label: 'evals:C1', answer: writer(list1) },
    { label: 'evalsproduct:C1#1', answer: ok },
  ]
  assert.ok(!steps.some(s => s.label.startsWith('evalsarch')))
  for (const form of FORMS) {
    const r = run(build(form, steps))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout).evals, list1)
  }
})

test('A01-12 a verifier result older than an accepted change of its eval is left out', () => {
  const steps = [
    { label: 'evals:C1', answer: writer(list1) },
    { label: 'evalsarch:C1#1', answer: ok },
    { label: 'implement:C1', answer: { pushed: true } },
    { label: 'verify:C1#1', answer: verifier([row('C1-1', 'pass'), row('C1-2', 'pass')]) },
    { label: 'fix:C1#1', answer: { disputes: [{ id: 'C1-1' }] } },
    { label: 'dispute:C1#1', answer: { ruling: 'change', reason: 'r', eval: ev('C1-1', 'behaviour', { statement: 'changed' }) } },
    { label: 'evalsarch:C1#d1', answer: ok },
  ]
  for (const form of FORMS) {
    const out = JSON.parse(run(build(form, steps)).stdout)
    assert.deepEqual(Object.keys(out.results), ['C1-2'])
  }
})

const implOk = { label: 'implement:C1', answer: { pushed: true } }
const labelsOf = steps => steps.map(s => s.label)
const noReviewer = steps => assert.ok(!labelsOf(steps).some(l => /^evals(arch|product):/.test(l)), 'fixture has a reviewer label')
const refusedRun = r => {
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /C1/)
}
const listPrompt = (list, extra = {}) => 'Evals to check:\n' + JSON.stringify({ evals: list, noErrorPath: '', noReference: '', algorithm: false, ...extra }, null, 1)
const disputePrompt = cur => 'The eval in dispute:\n' + JSON.stringify(cur, null, 1)
const refusedOrList = (r, list) => {
  if (r.status === 0) assert.deepEqual(JSON.parse(r.stdout).evalsMeta.accepted.evals, list)
  else refusedRun(r)
}
const bothEvals = out => {
  assert.deepEqual(out.evals, out.evalsMeta.accepted.evals)
  return out.evals
}
const head = [{ label: 'evals:C1', answer: writer(list1) }, { label: 'evalsarch:C1#1', answer: ok }]
const dChange = (evalId, statement = 'C1-1 after the dispute') => ({ ruling: 'change', reason: 'r', eval: ev(evalId, 'behaviour', { statement }) })
// A dispute step and its check step, with the prompts that run-wave.js builds for a transcript folder.
const dSteps = (n, current, answer, next) => [
  { label: `dispute:C1#${n}`, answer, prompt: disputePrompt(current) },
  { label: `evalsarch:C1#d${n}`, answer: ok, prompt: listPrompt(next) },
]
const fixStep = (round, ...ids) => ({ label: `fix:C1#${round}`, answer: { disputes: ids.map(id => ({ id })) } })

test('A10-3 a writer attempt with no reviewer started is the record when a later step started', () => {
  const weak = [ev('C1-1', 'behaviour')]
  const a = [{ label: 'evals:C1', answer: writer(list1, { noErrorPath: 'r' }) }, implOk]
  const b = [{ label: 'evals:C1', answer: writer(weak) }, { label: 'evals:C1#w2', answer: writer(list2) }, implOk]
  const c = [
    { label: 'evals:C1', answer: writer(list1) }, implOk, fixStep(1, 'C1-1'),
    { label: 'dispute:C1#1', answer: { ruling: 'keep', reason: 'r' } },
  ]
  for (const steps of [a, b, c]) noReviewer(steps)
  holds(c, 'dispute:C1#1', x => x.ruling === 'keep')
  for (const form of FORMS) {
    const ra = run(build(form, a))
    assert.equal(ra.status, 0, ra.stderr)
    assert.deepEqual(bothEvals(JSON.parse(ra.stdout)), list1)
    assert.equal(JSON.parse(ra.stdout).evalsMeta.noErrorPath, 'r')
    const rb = run(build(form, b))
    assert.equal(rb.status, 0, rb.stderr)
    assert.deepEqual(bothEvals(JSON.parse(rb.stdout)), list2)
    const rc = run(build(form, c))
    assert.equal(rc.status, 0, rc.stderr)
    assert.deepEqual(bothEvals(JSON.parse(rc.stdout)), list1)
  }
})

test('A10-4 a writer attempt with no reviewer and no later step of the PR is never printed', () => {
  const cleanup = { label: 'io:C1#cleanupclones', answer: { ok: true } }
  const cases = [
    [{ label: 'evals:C1', answer: writer(list1) }],
    [{ label: 'evals:C1', answer: writer(list1) }, cleanup],
    [{ label: 'evals:C1', answer: writer(list1) }, { label: 'evals:C1#w2', answer: writer(list2) }, cleanup],
    [{ label: 'evals:C1', answer: writer(list1) }, { label: 'implement:C2', answer: { pushed: true } }],
  ]
  for (const steps of cases) noReviewer(steps)
  for (const steps of cases.slice(1, 3)) {
    holds(steps, 'io:C1#cleanupclones', () => true)
    assert.ok(!labelsOf(steps).some(l => /^(implement:C1|(test|verify|review|fix):C1#)/.test(l)))
  }
  assert.deepEqual(labelsOf(cases[3]).filter(l => l !== 'evals:C1'), ['implement:C2'])
  for (const form of FORMS) for (const steps of cases) refusedRun(run(build(form, steps)))
})

test('A10-16 a change ruling in a run with no reviewer started is never replayed', () => {
  const steps = [
    { label: 'evals:C1', answer: writer(list1) }, implOk, fixStep(1, 'C1-1'),
    { label: 'dispute:C1#1', answer: { ruling: 'change', reason: 'r', eval: change }, prompt: disputePrompt(list1[0]) },
  ]
  noReviewer(steps)
  holds(steps, 'dispute:C1#1', a => a.ruling === 'change')
  assert.ok(!steps.some(s => (s.prompt || '').includes('Evals to check:')))
  for (const form of FORMS) refusedRun(run(build(form, steps)))
})

test('A10-5 a given list that the check accepted is read from the folder prompt only', () => {
  const marker = join(tmp, 'a10-5-marker')
  const LR = [ev('C1-1', 'behaviour', { statement: `runs $(touch ${marker}) here` }), ev('C1-2', 'error path'), ev('C1-3', 'behaviour')]
  const real = listPrompt(LR, { noErrorPath: 'r' })
  const base = prompt => [
    { label: 'evalsarch:C1#1', answer: ok, prompt },
    { label: 'verify:C1#1', answer: verifier([row('C1-1', 'pass')]) },
  ]
  const plain = base(`Brief of the PR.\n\n${real}`)
  assert.ok(!labelsOf(plain).some(l => l.startsWith('evals:') || l.startsWith('implement:')))
  assert.ok(plain[0].prompt.endsWith(real) && plain[0].prompt.includes('$(touch'))
  assert.notDeepEqual(LR, list1)
  const r1 = run(build('folder', plain))
  assert.equal(r1.status, 0, r1.stderr)
  const o1 = JSON.parse(r1.stdout)
  assert.deepEqual(bothEvals(o1), LR)
  assert.equal(o1.evalsMeta.noErrorPath, 'r')
  assert.ok(!existsSync(marker))

  const decoy = listPrompt(list1)
  const twice = base(`Entry notes.\n${decoy}\n\n${real}`)
  assert.equal(twice[0].prompt.split('Evals to check:\n').length, 3)
  assert.ok(twice[0].prompt.indexOf(decoy) < twice[0].prompt.indexOf(real))
  refusedOrList(run(build('folder', twice)), LR)

  refusedRun(run(build('journal', plain)))

  const needsChange = base(`Brief.\n\n${real}`)
  needsChange[0].answer = refuse
  holds(needsChange, 'evalsarch:C1#1', a => a.verdict === 'needs-change')
  refusedRun(run(build('folder', needsChange)))

  const withDispute = [
    ...base(`Brief.\n\n${real}`), fixStep(2, 'C1-1'),
    { label: 'dispute:C1#1', answer: { ruling: 'change', reason: 'r', eval: change } },
    { label: 'evalsarch:C1#d1', answer: ok },
  ]
  assert.ok(!withDispute.some(s => s.label.startsWith('dispute') && s.prompt))
  assert.ok(!withDispute.some(s => s.label === 'evalsarch:C1#d1' && (s.prompt ?? '').includes('Evals to check:')))
  holds(withDispute, 'dispute:C1#1', a => a.ruling === 'change')
  refusedRun(run(build('folder', withDispute)))
})

test('A10-6 a change that cannot be replayed from the writer list is never printed', () => {
  const revFinding = { severity: 'major', title: 't', detail: 'd', eval: { kind: 'behaviour', statement: 'review eval', check: 'run; expect ok' } }
  const revEval = { id: 'C1-R1-1', ...revFinding.eval }
  const c1 = [...head, implOk, { label: 'review:C1#1', answer: { findings: [revFinding] } }, fixStep(1, 'C1-R1-1'),
    ...dSteps(1, revEval, { ruling: 'change', reason: 'r', eval: revEval }, [list1[0], list1[1], revEval])]
  const c2 = [...head, implOk, fixStep(1, 'C1-1'), ...dSteps(1, list1[0], dChange('C1-2'), [list1[0], dChange('C1-2').eval])]
  const c3 = [...head, { label: 'implement:C1', answer: { pushed: true, disputes: [{ id: 'C1-2' }] } },
    { label: 'dispute:C1#1', answer: { ruling: 'keep', reason: 'r' } }, fixStep(1, 'C1-2', 'C1-1'),
    ...dSteps(2, list1[0], dChange('C1-2'), [list1[0], dChange('C1-2').eval])]
  const c4 = [...head, implOk, fixStep(1, 'C1-1'), ...dSteps(2, list1[0], dChange('C1-1'), [dChange('C1-1').eval, list1[1]])]
  const c5 = [...head, implOk, fixStep('docs1', 'C1-1'), ...dSteps(1, list1[0], dChange('C1-1'), [dChange('C1-1').eval, list1[1]])]
  assert.ok(c1.find(s => s.label === 'review:C1#1').answer.findings[0].eval)
  assert.notEqual(c2.find(s => s.label === 'dispute:C1#1').answer.eval.id, 'C1-1')
  assert.equal(c3.find(s => s.label === 'dispute:C1#2').answer.eval.id, 'C1-2')
  assert.equal(labelsOf(c4).filter(l => l.startsWith('fix:')).length, 1)
  assert.deepEqual(labelsOf(c5).filter(l => l.startsWith('fix:')), ['fix:C1#docs1'])
  for (const steps of [c1, c2, c3, c4, c5]) assert.ok(steps.some(s => /^evalsarch:C1#d\d$/.test(s.label) && s.answer.verdict === 'ok'))
  for (const steps of [c1, c2, c3, c4, c5]) {
    refusedRun(run(build('journal', steps)))
    const dList = JSON.parse(steps[steps.length - 1].prompt.split('Evals to check:\n')[1].split('\n}')[0] + '\n}').evals
    refusedOrList(run(build('folder', steps)), dList)
  }
})

test('A10-7 the disputed id is found as run-wave.js counts the disputes', () => {
  const changed = dChange('C1-1').eval
  const expected = [changed, list1[1]]
  const a = [...head, { label: 'implement:C1', answer: { pushed: true, disputes: [{ id: 'C1-9' }, { id: 'C1-2' }] } },
    { label: 'dispute:C1#2', answer: { ruling: 'keep', reason: 'r' } },
    { label: 'verify:C1#1', answer: verifier([row('C1-1', 'pass'), row('C1-2', 'pass')]) },
    fixStep(1, 'C1-1'), ...dSteps(3, list1[0], dChange('C1-1'), expected)]
  const b = [...head, { label: 'implement:C1', answer: { pushed: true, disputes: [{ id: 'C1-2' }] } },
    { label: 'dispute:C1#1', answer: { ruling: 'keep', reason: 'r' } },
    fixStep(1, 'C1-2', 'C1-1'), ...dSteps(2, list1[0], dChange('C1-1'), expected)]
  assert.ok(!labelsOf(a).includes('dispute:C1#1'))
  assert.equal(a.find(s => s.label === 'fix:C1#1').answer.disputes.findIndex(d => d.id === 'C1-1'), 0)
  assert.equal(b.find(s => s.label === 'fix:C1#1').answer.disputes[0].id, 'C1-2')
  for (const form of FORMS) {
    for (const steps of [a, b]) {
      const r = run(build(form, steps))
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(bothEvals(JSON.parse(r.stdout)), expected)
    }
  }
})

test('A10-8 a reviewer eval in the working list makes a later accepted change not replayable', () => {
  const revFinding = { severity: 'major', title: 't', detail: 'd', eval: { kind: 'behaviour', statement: 'review eval', check: 'run; expect ok' } }
  const revEval = { id: 'C1-R1-1', ...revFinding.eval }
  const changed = dChange('C1-1').eval
  const next = [changed, list1[1], revEval]
  const second = listPrompt(list1)
  const steps = [...head, implOk, { label: 'verify:C1#1', answer: verifier([row('C1-1', 'pass')]) },
    { label: 'review:C1#1', answer: { findings: [revFinding] } }, fixStep(1, 'C1-1'),
    { label: 'dispute:C1#1', answer: dChange('C1-1'), prompt: disputePrompt(list1[0]) },
    { label: 'evalsarch:C1#d1', answer: ok, prompt: `${listPrompt(next)}\n\nThe writer's notes (an answer to an earlier needs-change; accept it when it is reasoned and true):\n${second}` }]
  assert.ok(steps.find(s => s.label === 'review:C1#1').answer.findings[0].eval)
  const d1 = steps.find(s => s.label === 'evalsarch:C1#d1').prompt
  assert.ok(d1.includes('C1-R1-1') && d1.split('Evals to check:\n').length === 3)
  refusedRun(run(build('journal', steps)))
  refusedOrList(run(build('folder', steps)), next)
})

test('A10-10 an earlier verifier result stays when a change leaves the eval as it was', () => {
  const mk = changeAnswer => [...head, implOk,
    { label: 'verify:C1#1', answer: verifier([row('C1-1', 'pass', { evidence: 'before' }), row('C1-2', 'pass')]) },
    fixStep(1, 'C1-1'), ...dSteps(1, list1[0], { ruling: 'change', reason: 'r', eval: changeAnswer }, [changeAnswer, list1[1]])]
  const same = mk({ ...list1[0] })
  const other = mk({ ...list1[0], check: 'run C1-1 again; expect ok' })
  assert.deepEqual(same.find(s => s.label === 'dispute:C1#1').answer.eval, list1[0])
  assert.notEqual(other.find(s => s.label === 'dispute:C1#1').answer.eval.check, list1[0].check)
  for (const form of FORMS) {
    const r = run(build(form, same))
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.results['C1-1'].evidence, 'before')
    assert.deepEqual(out.evalsMeta.accepted.evals, list1)
    const r2 = run(build(form, other))
    assert.equal(r2.status, 0, r2.stderr)
    assert.deepEqual(Object.keys(JSON.parse(r2.stdout).results), ['C1-2'])
  }
})
