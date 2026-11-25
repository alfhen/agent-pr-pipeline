// scripts/pr-files.sh is the one place that reads pulls/<n>/files. No other script may read it itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const FILES = 'repos__o__r__pulls__7__files'

const run = (setup) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-files-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  setup(fx)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: fx }
  return spawnSync('bash', [join(root, 'scripts/pr-files.sh'), 'o/r', '7'], { env, encoding: 'utf8' })
}

test('pr-files: pages are joined and only the names stay', () => {
  const r = run((fx) => {
    writeFileSync(join(fx, `${FILES}.1.json`), JSON.stringify([{ filename: 'a', patch: 'x', status: 'added' }]))
    writeFileSync(join(fx, `${FILES}.2.json`), JSON.stringify([{ filename: 'b', previous_filename: 'c', status: 'renamed' }]))
  })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), [{ filename: 'a' }, { filename: 'b', previous_filename: 'c' }])
})

test('pr-files: a failed read exits 1 and says why', () => {
  const r = run((fx) => writeFileSync(join(fx, `${FILES}.GET.error`), 'HTTP 500'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^cannot list the changed files \(.*HTTP 500\)/)
})

test('pr-files: 3000 files exit 4, 2999 pass', () => {
  const list = (n) => Array.from({ length: n }, (_, i) => ({ filename: `f${i}` }))
  assert.equal(run((fx) => writeFileSync(join(fx, `${FILES}.json`), JSON.stringify(list(2999)))).status, 0)
  const r = run((fx) => writeFileSync(join(fx, `${FILES}.json`), JSON.stringify(list(3000))))
  assert.equal(r.status, 4)
  assert.match(r.stderr, /3000 changed files or more/)
})

test('no other script reads pulls/<n>/files itself', () => {
  for (const f of ['gate-files.sh', 'merge-pr.sh', 'bot-status.sh', 'pr-overlap.sh']) {
    const text = readFileSync(join(root, 'scripts', f), 'utf8')
    assert.doesNotMatch(text, /pulls\/\$\{?[A-Za-z_]+\}?\/files/, f)
  }
  assert.match(readFileSync(join(root, 'scripts/pr-files.sh'), 'utf8'), /--paginate/)
})
