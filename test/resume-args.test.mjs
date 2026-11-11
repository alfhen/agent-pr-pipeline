// Runs scripts/resume-args.sh on fixtures in a temp HOME and folder under os.tmpdir(). Each test name starts with its eval id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT = join(root, 'scripts/resume-args.sh')
const dir = mkdtempSync(join(tmpdir(), 'resume-args-test-'))
const home = mkdtempSync(join(tmpdir(), 'resume-args-home-'))
let n = 0
const file = v => { const f = join(dir, `in-${n++}.json`); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); return f }
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } })
const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stderr); return { ...r, item: JSON.parse(r.stdout) } }
const output = prs => ({ agentCount: 3, totalTokens: 100, result: { prs } })
const REQUEST_KEYS = ['history', 'minors', 'findings', 'evals', 'designRules', 'evalDisputes', 'deviations']

const mkEvals = (count, size = 5) => Array.from({ length: count }, (_, i) => ({ id: `E${i + 1}`, kind: 'behaviour', statement: `s${i}`, check: `c${i} ` + 'x'.repeat(size) }))
const meta = (id, evals) => ({ noErrorPath: false, noReference: true, algorithm: false, accepted: { pr: id, evals, noErrorPath: false, noReference: true, algorithm: false } })
const finding = i => ({ severity: 'major', title: `f${i}`, detail: `d${i}` })

function stopped(id) {
  const evals = mkEvals(3)
  return {
    id, ready: false, reason: 'rounds exhausted', history: [{ round: 1, fixChanged: true }, { round: 2, fixChanged: true }, { round: 'stop', stop: 'rounds exhausted' }],
    lastFindings: [finding(1), finding(2)], fixSummary: 'fixed', worktree: '/w', escalation: null, conflict: null, architecture: null, product: null,
    rerunFixChanged: false, breakCheck: { passes: ['E1'] }, evals, evalsMeta: meta(id, evals), evalDisputes: [{ id: 'E2', reason: 'r' }], deviations: [{ what: 'w', why: 'y' }],
  }
}

test('A09-3 prints the resume item of a stopped result with the object form of evals', () => {
  const r1 = stopped('R1'), r2 = stopped('R2'); r2.reason = 'other'
  assert.ok(!('minors' in r1) && !('lateMinors' in r1))
  const { item, stdout } = ok(file(output([r1, r2])), 'R1')
  assert.equal(item.id, 'R1')
  assert.deepEqual(item.resume.evals, { evals: r1.evals, ...r1.evalsMeta })
  assert.deepEqual(item.resume.evals.evals, r1.evals)
  assert.deepEqual(item.resume.evals.accepted, r1.evalsMeta.accepted)
  assert.equal(item.resume.evals.noErrorPath, r1.evalsMeta.noErrorPath)
  assert.deepEqual(item.resume.history, r1.history)
  assert.deepEqual(item.resume.findings, r1.lastFindings)
  assert.deepEqual(item.resume.evalDisputes, r1.evalDisputes)
  assert.deepEqual(item.resume.deviations, r1.deviations)
  assert.ok(!('minors' in item.resume))
  assert.ok(Object.keys(item.resume).every(k => REQUEST_KEYS.includes(k)))
  assert.ok(!stdout.includes('R2') && !stdout.includes('other'))
})

test('A09-12 lateMinors are copied into resume.minors', () => {
  const evals = mkEvals(2)
  const p = {
    id: 'M1', ready: false, reason: 'rounds exhausted', prNumber: 12, headSha: 'abc', history: [{ round: 1 }],
    lateMinors: [{ severity: 'minor', title: 'm1' }, { severity: 'minor', title: 'm2' }], evals, evalsMeta: meta('M1', evals), rounds: 1, untested: [], docs: null, minorPass: null,
  }
  const { item } = ok(file(output([p])), 'M1')
  assert.deepEqual(item.resume.minors, p.lateMinors)
  assert.ok(!('lateMinors' in item) && !('lateMinors' in item.resume))
  assert.equal(item.prNumber, 12)
})

const recovered = () => {
  const r = spawnSync('bash', [join(root, 'scripts/recover-evals.sh'), join(root, 'test/fixtures/recover-evals/journal-ok.jsonl'), 'C1'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return { rec: JSON.parse(r.stdout), f: file(r.stdout) }
}

test('A09-4 takes the output of recover-evals.sh', () => {
  const { rec, f } = recovered()
  assert.ok(rec.evals && rec.evalsMeta.accepted)
  const { item } = ok(f, 'C1')
  assert.equal(item.id, 'C1')
  assert.deepEqual(item.resume.evals, { evals: rec.evals, ...rec.evalsMeta })
  assert.deepEqual(item.resume.evals.evals, rec.evals)
  assert.deepEqual(item.resume.evals.accepted, rec.evalsMeta.accepted)
  for (const o of [item, item.resume]) assert.ok(!('results' in o) && !('pr' in o))
  for (const k of ['history', 'findings', 'minors']) assert.ok(!(k in item.resume))
})

test('A09-5 an unknown PR id exits non-zero with nothing on stdout', () => {
  const a = run(file(output([stopped('R1')])), 'NOPE')
  const { f } = recovered()
  const b = run(f, 'C2')
  for (const [r, id] of [[a, 'NOPE'], [b, 'C2']]) {
    assert.ok([1, 64, 65].includes(r.status), `status ${r.status}`)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes(id))
  }
})

test('A09-8 a missing, non-JSON or foreign input exits non-zero and names the path', () => {
  for (const f of [join(dir, 'missing.json'), file('not json'), file('{"x":1}')]) {
    const r = run(f, 'R1')
    assert.ok([1, 64, 65].includes(r.status), `status ${r.status}`)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes(f))
  }
})

test('A09-6 warns when the history rounds plus n are more than the cap', () => {
  const a = stopped('R1')
  assert.ok(a.history.some(h => h.round === 'stop'))
  const f = file(output([a]))
  const plain = ok(f, 'R1').item
  const w = ok(f, 'R1', '--max-rounds', '2', '--cap', '3')
  const lines = w.stderr.split('\n').filter(l => l.startsWith('WARN'))
  assert.equal(lines.length, 1)
  assert.deepEqual(lines[0].match(/\d+/g).sort(), ['2', '2', '3'])
  assert.deepEqual(w.item.resume, plain.resume)

  const b = stopped('R1'); b.history = [{ round: 1 }, { round: 'stop', stop: 'x' }]
  const w2 = ok(file(output([b])), 'R1', '--max-rounds', '2', '--cap', '3')
  assert.ok(!w2.stderr.split('\n').some(l => l.startsWith('WARN')))
  assert.equal(w2.item.id, 'R1')
})

test('A09-7 40 evals and 12 rounds come through whole and in order', () => {
  const p = stopped('B1')
  p.evals = mkEvals(40, 1200)
  p.evalsMeta = meta('B1', p.evals)
  p.history = [...Array.from({ length: 12 }, (_, i) => ({ round: i + 1, fixChanged: true })), { round: 'stop', stop: 'x' }]
  p.lastFindings = Array.from({ length: 20 }, (_, i) => finding(i))
  const { item } = ok(file(output([p])), 'B1')
  assert.equal(item.resume.evals.evals.length, 40)
  assert.deepEqual(item.resume.evals.evals, p.evals)
  assert.deepEqual(item.resume.evals.accepted, p.evalsMeta.accepted)
  assert.equal(item.resume.history.length, 13)
  assert.deepEqual(item.resume.history, p.history)
  assert.deepEqual(item.resume.findings, p.lastFindings)
})

test('A09-9 prints only copied fields over 60 seeded results', () => {
  let seed = 12345
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const cases = []
  for (let i = 0; i < 60; i++) {
    const id = `S${i}`
    const p = { id, ready: false, reason: 'r', worktree: '/w', breakCheck: {}, architecture: null, fixSummary: 'f' }
    if (rnd() < 0.5) p.prNumber = i + 1
    if (rnd() < 0.6) p.history = Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => ({ round: k + 1 }))
    if (rnd() < 0.6) p.lastFindings = Array.from({ length: Math.floor(rnd() * 3) }, (_, k) => finding(k))
    if (rnd() < 0.5) p.lateMinors = [{ severity: 'minor', title: `m${i}` }]
    if (rnd() < 0.6) { p.evals = mkEvals(1 + Math.floor(rnd() * 6)).reverse(); p.evalsMeta = meta(id, p.evals) }
    if (rnd() < 0.5) p.evalDisputes = []
    if (rnd() < 0.5) p.deviations = [{ what: 'w' }]
    cases.push(p)
  }
  const f = file(output(cases))
  const same = { history: 'history', findings: 'lastFindings', minors: 'lateMinors', evalDisputes: 'evalDisputes', deviations: 'deviations' }
  for (const p of cases) {
    const { item } = ok(f, p.id)
    assert.ok(Object.keys(item.resume).every(k => REQUEST_KEYS.includes(k)))
    for (const [k, src] of Object.entries(same)) {
      assert.equal(k in item.resume, src in p, `${p.id} ${k}`)
      if (src in p) assert.deepEqual(item.resume[k], p[src])
    }
    assert.equal('evals' in item.resume, 'evals' in p)
    if ('evals' in p) {
      assert.deepEqual(item.resume.evals, { evals: p.evals, ...p.evalsMeta })
      assert.deepEqual(item.resume.evals.evals.map(e => e.id), p.evals.map(e => e.id))
    }
    for (const k of Object.keys(item)) {
      if (k === 'resume') continue
      assert.ok(['id', 'prNumber', 'maxRounds'].includes(k), k)
      if (k !== 'maxRounds') assert.deepEqual(item[k], p[k])
    }
    assert.equal('prNumber' in item, 'prNumber' in p)
  }
})
