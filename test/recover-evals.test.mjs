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
        { type: 'user', timestamp: stamp, message: { content: 'prompt' } },
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
