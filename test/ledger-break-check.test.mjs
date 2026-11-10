// Runs scripts/ledger.sh put against test/fake-gh in a temp folder outside ~/.claude*. Each test name starts with its eval id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const LEDGER = join(root, 'scripts/ledger.sh')
const fname = p => p.replace(/^\//, '').replaceAll('/', '__')

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-bc-'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const fx = join(dir, 'fx')
  cpSync(join(root, 'test/fixtures/ledger/base'), fx, { recursive: true })
  const put = (path, v) => writeFileSync(join(fx, `${fname(path)}.json`), JSON.stringify(v))
  put('repos/o/r/issues', [{ number: 7, state: 'open', user: { login: 'alfhen' }, labels: [{ name: 'pipeline-ledger' }] }])
  put('repos/o/r/issues/7/comments', [])
  return { dir, bin, fx }
}

const putDry = (s, out) => {
  const f = join(s.dir, 'out.json'); writeFileSync(f, JSON.stringify(out))
  const r = spawnSync('bash', [LEDGER, 'o/r', 'put', f, '--run', 'wf_1', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, HOME: s.dir, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: join(s.dir, 'log') },
  })
  return { ...r, records: r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) }
}
const GROUPS = ['fails', 'passes', 'notRun', 'notApplicable']
const idsIn = bc => GROUPS.flatMap(g => (bc && bc[g]) || [])
const BC = { fails: ['X-1'], passes: [], notRun: ['X-2'], notApplicable: ['X-3'] }
const EV = { passed: ['X-1', 'X-2', 'X-3'], failed: [], ci: [] }

test('K02-3 put copies the break-check results into evals and leaves the counts alone', () => {
  const s = setup()
  const withBc = putDry(s, { result: { prs: [{ id: 'C1', ready: true, prNumber: 3, breakCheck: BC, history: [{ round: 1, evals: EV, breakCheck: BC }] }] } })
  const plain = putDry(s, { result: { prs: [{ id: 'C1', ready: true, prNumber: 3, history: [{ round: 1, evals: EV }] }] } })
  assert.equal(withBc.status, 0, withBc.stderr)
  assert.equal(withBc.records.length, 1)
  const e = withBc.records[0].evals
  assert.deepEqual(e.breakCheck, BC)
  assert.deepEqual(idsIn(e.breakCheck).sort(), ['X-1', 'X-2', 'X-3'])
  const { breakCheck, ...counts } = e
  const { breakCheck: none, ...before } = plain.records[0].evals
  assert.deepEqual(counts, before)
  assert.equal(counts.count, 3)
})

test('K02-4 an output file with no break-check data gives a record with no break-check ids', () => {
  const s = setup()
  const tester = putDry(s, { result: { prs: [{ id: 'C1', ready: true, prNumber: 3, history: [{ round: 1, testPass: true }] }] } })
  const old = putDry(s, { result: { prs: [{ id: 'C1', ready: true, prNumber: 3, history: [{ round: 1, evals: { passed: ['X-1'], failed: ['X-2'], ci: [] } }] }] } })
  for (const r of [tester, old]) {
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.records.length, 1)
    assert.deepEqual(idsIn(r.records[0].evals.breakCheck), [])
  }
  assert.equal(old.records[0].evals.count, 2)
  assert.deepEqual(old.records[0].evals.passed, { 1: ['X-1'] })
  assert.deepEqual(old.records[0].evals.failed, { 1: ['X-2'] })
})

test('K02-3 a malformed breakCheck gives no bad ids and put still exits 0', () => {
  const s = setup()
  const r = putDry(s, { result: { prs: [{ id: 'C1', ready: true, breakCheck: { fails: 'X-1', passes: [{}, 5] }, history: [] }, { id: 'C2', ready: true, breakCheck: 'x', history: [] }] } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.records.length, 2)
  assert.deepEqual(r.records[0].evals.breakCheck, { fails: [], passes: ['5'], notRun: [], notApplicable: [] })
  assert.deepEqual(idsIn(r.records[1].evals.breakCheck), [])
})
