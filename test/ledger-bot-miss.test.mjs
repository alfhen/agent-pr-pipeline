// Runs scripts/ledger.sh against test/fake-gh in a temp folder outside ~/.claude*. Each test name starts with its eval id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, cpSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const LEDGER = join(root, 'scripts/ledger.sh')
const ISSUE = 7
const fname = p => p.replace(/^\//, '').replaceAll('/', '__')

function setup(merged = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-bot-miss-'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const fx = join(dir, 'fx')
  cpSync(join(root, 'test/fixtures/ledger/base'), fx, { recursive: true })
  const put = (path, v) => writeFileSync(join(fx, `${fname(path)}.json`), JSON.stringify(v))
  put('repos/o/r/issues', [{ number: ISSUE, state: 'open', user: { login: 'alfhen' }, labels: [{ name: 'pipeline-ledger' }] }])
  put(`repos/o/r/issues/${ISSUE}/comments`, [])
  put('repos/o/r/pulls', merged.map(n => ({ number: n, merged_at: '2026-11-02T00:00:00Z', body: '' })))
  for (const n of merged) {
    put(`repos/o/r/issues/${n}/comments`, [])
    put(`repos/o/r/pulls/${n}/comments`, [])
  }
  return { dir, bin, fx, log: join(dir, 'log') }
}

function run(s, ...args) {
  rmSync(s.log, { force: true })
  return spawnSync('bash', [LEDGER, 'o/r', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: s.dir, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log },
  })
}

const pr = (id, prNumber, ready) => ({ id, ready, reason: ready ? null : 'bot answer check: rounds exhausted: 2 of 2 (botCheckRounds)', prNumber, codeChangedByBots: true, history: [{ round: 1 }] })
const outFile = (s, name, p) => {
  const f = join(s.dir, name)
  writeFileSync(f, JSON.stringify({ result: { prs: [p] } }))
  return f
}
const records = r => r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))

test('K07-1 put writes one bot eval miss for a not-ready PR with codeChangedByBots', () => {
  const s = setup()
  const p = pr('P1', 42, false)
  assert.equal(p.ready, false)
  assert.equal(p.codeChangedByBots, true)
  const r = run(s, 'put', outFile(s, 'out.json', p), '--run', 'wf_1', '--dry-run')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(records(r)[0].evalMisses, [{ source: 'bot' }])
})

test('K07-4 report counts the same PRs as eval misses and as defects for ready and not-ready bot code changes', () => {
  const s = setup([42, 43])
  const lines = [pr('P42', 42, true), pr('P43', 43, false)].map((p, i) => {
    const r = run(s, 'put', outFile(s, `out${i}.json`, p), '--run', 'wf_1', '--dry-run')
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  })
  const f = join(s.dir, 'printed.jsonl')
  writeFileSync(f, lines.join('\n') + '\n')
  const rep = run(s, 'report', '--from', f)
  assert.equal(rep.status, 0, rep.stderr)
  assert.match(rep.stdout, /^Defects found after sign-off: 2 PRs\.$/m)
  assert.match(rep.stdout, /^Eval misses: 2 PRs\.$/m)
})
