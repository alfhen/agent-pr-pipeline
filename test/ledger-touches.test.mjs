// A10: ledger.sh report counts `evals missing:` and `run failed:` stops as maintainer touches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fname = p => p.replace(/^\//, '').replaceAll('/', '__')

// prs: { [number]: reason }, every PR merged with mode auto
function report(prs) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-touches-'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const fx = join(dir, 'fx')
  cpSync(join(root, 'test/fixtures/ledger/base'), fx, { recursive: true })
  const put = (path, v) => writeFileSync(join(fx, `${fname(path)}.json`), JSON.stringify(v))
  put('repos/o/r/issues', [{ number: 7, state: 'open', user: { login: 'alfhen' }, labels: [{ name: 'pipeline-ledger' }] }])
  const comments = []
  let id = 10
  for (const [num, reason] of Object.entries(prs)) {
    const record = { v: 1, repo: 'o/r', run: 'wf_1', kind: 'wave', pr: { id: `P${num}`, number: Number(num) }, ready: false, reason, rounds: 1, tokens: null }
    comments.push({ id: id++, user: { login: 'alfhen' }, body: `<!-- pipeline:ledger v1 wf_1 P${num}-0 -->\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`` })
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

test('A10-9 an evals missing stop and a run failed stop count one touch each', () => {
  const r = report({ 61: 'evals missing: the input holds the accepted record and no list', 62: 'run failed: verifier crashed' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Maintainer touches per PR: 1, 2 in all\.$/m)
})
