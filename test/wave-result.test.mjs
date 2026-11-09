// Checks scripts/wave-result.sh: the result file, the printed line and the refusals. No GitHub call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('../scripts/wave-result.sh', import.meta.url).pathname

function run(output, { raw } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wave-result-test-'))
  const input = join(dir, 'output.json')
  const result = join(dir, 'result.json')
  writeFileSync(input, raw ?? JSON.stringify(output, null, 2))
  const r = spawnSync('bash', [script, input, result], { encoding: 'utf8' })
  return { ...r, result, dir, wrote: existsSync(result), files: readdirSync(dir).sort() }
}
const wave = (pr) => ({ summary: 'done', agentCount: 21, logs: ['a', 'b'], result: { prs: [pr], feedback: [] } })

const CODES = [
  [{ id: 'q', prNumber: 42, ready: true }, '42 true opened'],
  [{ id: 'q', ready: false, reason: 'quick fix: plan. It needs a plan.' }, 'none false triage-plan'],
  [{ id: 'q', ready: false, reason: 'quick fix: decline. Not a bug.' }, 'none false triage-decline'],
  [{ id: 'q', prNumber: 7, ready: false, reason: 'rounds exhausted: 4 of 4 (maxRounds)' }, '7 false rounds-exhausted'],
  [{ id: 'q', prNumber: 8, ready: false, reason: 'docs check: rounds exhausted: 2 of 2 (docsRounds)' }, '8 false rounds-exhausted'],
  [{ id: 'q', ready: false, reason: 'needs human: permission' }, 'none false needs-human'],
  [{ id: 'q', ready: false, reason: 'implementation not pushed' }, 'none false other'],
  [{ id: 'q', ready: false, reason: 'quick fix: touches overlap with b (x); run it in a later wave' }, 'none false other'],
  [{ id: 'q', ready: false }, 'none false other'],
]

for (const [pr, line] of CODES) {
  test(`prints "${line}" for ${JSON.stringify(pr.reason ?? pr)}`, () => {
    const r = run(wave(pr))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, `${line}\n`)
  })
}

test('writes .result from a pretty-printed output file', () => {
  const o = wave({ id: 'q', prNumber: 42, ready: true })
  const r = run(o)
  assert.ok(readFileSync(join(r.dir, 'output.json'), 'utf8').split('\n').length > 10)
  assert.deepEqual(JSON.parse(readFileSync(r.result, 'utf8')), o.result)
  assert.deepEqual(r.files, ['output.json', 'result.json'])
})

test('refuses a file that is not JSON, and writes nothing', () => {
  for (const raw of ['not json', '', '{"result": ']) {
    const r = run(null, { raw })
    assert.equal(r.status, 1, raw)
    assert.equal(r.wrote, false)
    assert.deepEqual(r.files, ['output.json'])
  }
})

test('refuses a missing file', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'wave-result-test-')), 'result.json')
  const r = spawnSync('bash', [script, '/nonexistent/output.json', out], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.equal(existsSync(out), false)
})

test('refuses when result.prs[0] is not an object', () => {
  for (const o of [{ result: { prs: [] } }, { result: { prs: ['x'] } }, { result: { prs: [null] } }, { result: {} }, { result: null }, {}, [], { result: { prs: { a: 1 } } }]) {
    const r = run(o)
    assert.equal(r.status, 1, JSON.stringify(o))
    assert.equal(r.wrote, false)
  }
})

test('refuses ready true without a whole-number prNumber', () => {
  for (const prNumber of [undefined, null, '42', 4.5, 0, -1, true]) {
    const r = run(wave({ id: 'q', ready: true, prNumber }))
    assert.equal(r.status, 1, String(prNumber))
    assert.equal(r.wrote, false)
  }
})

test('a prNumber that is not a whole number with ready false prints none', () => {
  assert.equal(run(wave({ id: 'q', ready: false, prNumber: '42', reason: 'x' })).stdout, 'none false other\n')
})

test('needs two arguments', () => {
  assert.equal(spawnSync('bash', [script, 'a'], { encoding: 'utf8' }).status, 64)
})
