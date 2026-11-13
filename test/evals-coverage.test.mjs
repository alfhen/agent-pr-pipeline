// The coverage map of the evals writer: recover-evals.sh, resume-args.sh, agents/evals-writer.md and templates/plan.md.
// Inputs are built inline, as in recover-evals.test.mjs, in a temp folder and a temp HOME under os.tmpdir().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const recover = join(root, 'scripts', 'recover-evals.sh')
const resumeArgs = join(root, 'scripts', 'resume-args.sh')
const tmp = mkdtempSync(join(tmpdir(), 'evals-coverage-'))
const home = mkdtempSync(join(tmpdir(), 'evals-coverage-home-'))
process.on('exit', () => { rmSync(tmp, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) })
let counter = 0

const ev = (id, kind, extra = {}) => ({ id, kind, statement: `${id} must hold`, check: `run ${id}; expect ok`, ...extra })
const list1 = [ev('C1-1', 'behaviour'), ev('C1-2', 'error path')]
const list2 = [ev('C1-1', 'behaviour', { statement: 'C1-1 second attempt' }), ev('C1-2', 'error path')]
const cov1 = [{ item: 'COV-A first bullet', evals: ['C1-1'] }, { item: 'COV-B invariant', evals: ['C1-2'] }]
const cov2 = [{ item: 'COV-C second attempt', evals: ['C1-1', 'C1-2'] }]
const writer = (list, extra = {}) => ({ evals: list, noErrorPath: '', noReference: '', algorithm: false, notes: '', ...extra })
const ok = { verdict: 'ok', notes: '' }
const refuse = { verdict: 'needs-change', notes: 'gap' }
const verify = { pass: true, headSha: 'sha', checks: [], evals: [{ id: 'C1-1', result: 'pass', evidence: 'x', breakCheck: 'fails-without-change' }] }
const implOk = { label: 'implement:C1', answer: { pushed: true } }
const FORMS = ['journal', 'folder']

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
const run = path => spawnSync('bash', [recover, path, 'C1'], { encoding: 'utf8' })
const out = path => {
  const r = run(path)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const holds = (steps, label, pred) => assert.ok(steps.some(s => s.label === label && pred(s.answer)), `input lacks ${label}`)
const noKey = o => assert.equal('coverage' in o.evalsMeta.accepted, false)
const topClean = o => assert.equal('coverage' in o.evalsMeta, false)

const change = (statement = 'C1-1 after the dispute') => ev('C1-1', 'behaviour', { statement })
const disputed = (answer, check) => [
  { label: 'fix:C1#1', answer: { disputes: [{ id: 'C1-1' }] } },
  { label: 'dispute:C1#1', answer },
  ...(check ? [{ label: 'evalsarch:C1#d1', answer: check }] : []),
]

test('C01-8 the record holds the coverage of the accepted writer answer', () => {
  const a = [{ label: 'evals:C1', answer: writer(list1, { coverage: cov1 }) }, { label: 'evalsarch:C1#1', answer: ok }, { label: 'verify:C1#1', answer: verify }]
  const b = [
    { label: 'evals:C1', answer: writer(list1, { coverage: cov1 }) }, { label: 'evalsarch:C1#1', answer: refuse },
    { label: 'evals:C1#w2', answer: writer(list2, { coverage: cov2 }) }, { label: 'evalsarch:C1#2', answer: ok },
  ]
  const c = [
    { label: 'evals:C1', answer: writer(list1, { coverage: cov1 }) }, { label: 'evalsarch:C1#1', answer: ok }, implOk,
    ...disputed({ ruling: 'keep', reason: 'r' }),
    { label: 'fix:C1#2', answer: { disputes: [{ id: 'C1-2' }] } },
    { label: 'dispute:C1#2', answer: { ruling: 'change', reason: 'r', eval: ev('C1-2', 'error path', { statement: 'weaker' }) } },
    { label: 'evalsarch:C1#d2', answer: refuse },
  ]
  holds(b, 'evalsarch:C1#1', x => x.verdict === 'needs-change')
  holds(c, 'dispute:C1#1', x => x.ruling === 'keep')
  holds(c, 'evalsarch:C1#d2', x => x.verdict === 'needs-change')
  for (const form of FORMS) {
    for (const [steps, coverage] of [[a, cov1], [b, cov2], [c, cov1]]) {
      const o = out(build(form, steps))
      assert.deepEqual(o.evalsMeta.accepted.coverage, coverage)
      topClean(o)
    }
  }
})

test('C01-15 the record has no coverage key when the answer has none, after a replayed change, and for a given list', () => {
  const none = [{ label: 'evals:C1', answer: writer(list1) }, { label: 'evalsarch:C1#1', answer: ok }]
  assert.ok(!('coverage' in none[0].answer))
  for (const form of FORMS) {
    const o = out(build(form, none))
    assert.deepEqual(o.evals, list1)
    noKey(o)
  }
  const withCoverage = [{ label: 'evals:C1', answer: writer(list1, { coverage: cov1 }) }, { label: 'evalsarch:C1#1', answer: ok }, implOk]
  holds(withCoverage, 'evals:C1', x => x.coverage.length > 0)
  const changed = withCoverage.concat(disputed({ ruling: 'change', reason: 'r', eval: change() }, ok))
  const same = withCoverage.concat(disputed({ ruling: 'change', reason: 'r', eval: ev('C1-1', 'behaviour') }, ok))
  for (const form of FORMS) {
    const o = out(build(form, changed))
    assert.equal(o.evals.find(e => e.id === 'C1-1').statement, change().statement)
    noKey(o)
    const s = out(build(form, same))
    assert.deepEqual(s.evals, list1)
    noKey(s)
  }
  const prompt = 'Evals to check:\n' + JSON.stringify({ evals: list2, noErrorPath: '', noReference: '', algorithm: false }, null, 1)
  const given = [{ label: 'evalsarch:C1#1', answer: ok, prompt }, { label: 'verify:C1#1', answer: verify }]
  assert.ok(!given.some(s => /^evals:/.test(s.label)))
  const o = out(build('folder', given))
  assert.deepEqual(o.evals, list2)
  noKey(o)
})

test('C01-16 a writer answer with no coverage is not refused', () => {
  const w = writer(list1)
  assert.ok(!('coverage' in w))
  const attempt1 = [{ label: 'evals:C1', answer: w }, { label: 'evalsarch:C1#1', answer: ok }]
  const attempt2 = [{ label: 'evals:C1', answer: writer(list1) }, { label: 'evalsarch:C1#1', answer: refuse }, { label: 'evals:C1#w2', answer: writer(list2) }, { label: 'evalsarch:C1#2', answer: ok }]
  const last = [{ label: 'evals:C1', answer: writer(list1) }, implOk]
  assert.ok(!last.some(s => /^evalsarch/.test(s.label)))
  for (const form of FORMS) {
    assert.deepEqual(out(build(form, attempt1)).evals, list1)
    assert.deepEqual(out(build(form, attempt2)).evals, list2)
    assert.deepEqual(out(build(form, last)).evals, list1)
  }
})

test('C01-9 resume-args.sh prints the coverage inside resume.evals.accepted', () => {
  const accepted = { pr: 'C1', evals: list1, noErrorPath: '', noReference: '', algorithm: false, coverage: cov1 }
  const result = { id: 'C1', ready: false, reason: 'rounds exhausted', history: [], evals: list1, evalsMeta: { noErrorPath: '', noReference: '', algorithm: false, accepted } }
  const file = join(tmp, 'resume-in.json')
  writeFileSync(file, JSON.stringify({ result: { prs: [result] } }))
  const r = spawnSync('bash', [resumeArgs, file, 'C1'], { encoding: 'utf8', env: { ...process.env, HOME: home } })
  assert.equal(r.status, 0, r.stderr)
  const item = JSON.parse(r.stdout)
  assert.deepEqual(item.resume.evals.accepted.coverage, cov1)
  assert.equal('coverage' in item, false)
  assert.equal('coverage' in item.resume, false)
  assert.equal('coverage' in item.resume.evals, false)
})

const read = file => readFileSync(join(root, file), 'utf8')

test('C01-10 the writer agent file asks for the coverage map and its item rule', () => {
  const md = read('agents/evals-writer.md')
  const ret = md.split('\n').find(l => l.startsWith('Return `evals`'))
  assert.ok(ret && ret.includes('`coverage`'))
  assert.match(md, /An item is one bullet or one invariant of the entry, one issue for a batch, or one line of the brief for a quick fix/)
  assert.match(md, /A list whose coverage is missing or empty, has an item with no eval id, or names an id that is not in the list is refused/)
})

test('C01-12 the plan template makes each behaviour and invariant its own bullet and keeps the Invariants prefix', () => {
  const tpl = read('templates/plan.md')
  const entry = tpl.slice(tpl.indexOf('**A01 '), tpl.indexOf('\nEvals:\n', tpl.indexOf('**A01 ')))
  const between = entry.split('\n').slice(1)
  assert.ok(between.some(l => /each behaviour and each invariant of the entry is its own bullet/i.test(l)))
  assert.match(tpl, /^Invariants: /m)
  assert.ok(read('skills/pr-pipeline/SKILL.md').includes('Invariants line'))
})
