// A08: ledger.sh report counts evals-check, evals-refused and fix-not-saved stops as maintainer touches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fname = p => p.replace(/^\//, '').replaceAll('/', '__')

// prs: { [number]: [reason, ...] }, every PR merged with mode auto
function report(prs) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-evals-'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const fx = join(dir, 'fx')
  cpSync(join(root, 'test/fixtures/ledger/base'), fx, { recursive: true })
  const put = (path, v) => writeFileSync(join(fx, `${fname(path)}.json`), JSON.stringify(v))
  put('repos/o/r/issues', [{ number: 7, state: 'open', user: { login: 'alfhen' }, labels: [{ name: 'pipeline-ledger' }] }])
  let id = 10
  const comments = []
  for (const [num, list] of Object.entries(prs)) {
    list.forEach((reason, i) => {
      const record = { v: 1, repo: 'o/r', run: 'wf_1', kind: 'wave', pr: { id: `P${num}`, number: Number(num) }, ready: false, reason, rounds: 1, tokens: null }
      comments.push({ id: id++, user: { login: 'alfhen' }, body: `<!-- pipeline:ledger v1 wf_1 P${num}-${i} -->\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`` })
    })
    put(`repos/o/r/issues/${num}/comments`, [{ id: 5000 + Number(num), user: { login: 'alfhen' }, body: '<!-- pipeline:merge-cleared auto abc123 -->' }])
    put(`repos/o/r/pulls/${num}/comments`, [])
  }
  put('repos/o/r/issues/7/comments', comments)
  put('repos/o/r/pulls', Object.keys(prs).map(n => ({ number: Number(n), merged_at: '2026-11-02T00:00:00Z', body: '' })))
  return spawnSync('bash', [join(root, 'scripts/ledger.sh'), 'o/r', 'report'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: fx, FAKE_GH_LOG: join(dir, 'log') },
  })
}

test('A08-1 an evals check stop counts as one maintainer touch', () => {
  const r = report({ 61: ['evals check: no error path'] })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Maintainer touches per PR: 1, 1 in all\.$/m)
})

test('A08-2 evals refused and fix not saved count one touch each', () => {
  const r = report({ 61: ['evals refused: the list is wrong'], 62: ['fix not saved: push failed'] })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Maintainer touches per PR: 1, 2 in all\.$/m)
})

test('A08-3 no reason, evals writer failed and tester or reviewer failed add no touch', () => {
  const a = 'evals writer failed'
  const b = 'tester or reviewer failed'
  assert.equal(a, 'evals writer failed')
  assert.equal(b, 'tester or reviewer failed')
  const r = report({ 61: [null, a, b, 'evals check: x'], 62: [null, a] })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Maintainer touches per PR: 0\.5, 1 in all\.$/m)
})
