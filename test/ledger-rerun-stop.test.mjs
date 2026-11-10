// K06-5: ledger.sh report counts the head-moved and head-unknown stops as one maintainer touch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fname = p => p.replace(/^\//, '').replaceAll('/', '__')

const reasons = [
  'head moved: the checks ran on sha-C1 and then on sha-new, so the rerun cannot show that the failure was flaky',
  'head unknown: a check call reported no head (first run none, rerun sha-C1), so the rerun cannot show that the failure was flaky',
]

for (const reason of reasons) {
  test(`K06-5 a merged PR with "${reason.split(':')[0]}" counts as one maintainer touch`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-noprog-'))
    const bin = join(dir, 'bin'); mkdirSync(bin)
    copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
    const fx = join(dir, 'fx')
    cpSync(join(root, 'test/fixtures/ledger/base'), fx, { recursive: true })
    const put = (path, v) => writeFileSync(join(fx, `${fname(path)}.json`), JSON.stringify(v))
    put('repos/o/r/issues', [{ number: 7, state: 'open', user: { login: 'alfhen' }, labels: [{ name: 'pipeline-ledger' }] }])
    const record = { v: 1, repo: 'o/r', run: 'wf_1', kind: 'wave', pr: { id: 'P1', number: 61 }, ready: true, reason, rounds: 1, codeChangedByBots: false, evalMisses: [], tokens: null }
    put('repos/o/r/issues/7/comments', [{ id: 10, user: { login: 'alfhen' }, body: `<!-- pipeline:ledger v1 wf_1 P1 -->\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`` }])
    put('repos/o/r/pulls', [{ number: 61, merged_at: '2026-11-02T00:00:00Z', body: '' }])
    put('repos/o/r/issues/61/comments', [{ id: 5061, user: { login: 'alfhen' }, body: '<!-- pipeline:merge-cleared auto abc123 -->' }])
    put('repos/o/r/pulls/61/comments', [])
    const r = spawnSync('bash', [join(root, 'scripts/ledger.sh'), 'o/r', 'report'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: fx, FAKE_GH_LOG: join(dir, 'log') },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^Maintainer touches per PR: 1, 1 in all\.$/m)
  })
}
