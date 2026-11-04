// Runs scripts/check-syntax.sh on temp roots and checks that AGENTS.md and ci.yml call it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = new URL('../', import.meta.url).pathname
const GOOD = '#!/usr/bin/env bash\necho ok\n'
const BAD = '#!/usr/bin/env bash\nif then fi (\n'

const bashN = (file) => spawnSync('bash', ['-n', file]).status

const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-syntax-'))
  for (const d of ['scripts', 'routine/bin']) mkdirSync(join(dir, d), { recursive: true })
  copyFileSync(join(repo, 'scripts/check-syntax.sh'), join(dir, 'scripts/check-syntax.sh'))
  writeFileSync(join(dir, 'scripts/a.sh'), GOOD)
  writeFileSync(join(dir, 'routine/r.sh'), GOOD)
  writeFileSync(join(dir, 'routine/bin/gh'), GOOD)
  return dir
}
const run = (dir, args = []) => spawnSync('bash', [join(dir, 'scripts/check-syntax.sh'), ...args], { encoding: 'utf8' })

test('good files give OK and exit 0', () => {
  const dir = makeRoot()
  const r = run(dir)
  assert.equal(r.status, 0, r.stdout)
  assert.equal(r.stdout.trim(), 'OK 4 files')
  rmSync(dir, { recursive: true })
})

test('a syntax error in routine/bin/gh gives SYNTAX and exit 1', () => {
  const dir = makeRoot()
  writeFileSync(join(dir, 'routine/bin/gh'), BAD)
  assert.notEqual(bashN(join(dir, 'routine/bin/gh')), 0)
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^SYNTAX routine\/bin\/gh$/m)
  assert.doesNotMatch(r.stdout, /^OK/m)
  rmSync(dir, { recursive: true })
})

test('a syntax error in scripts/x.sh gives SYNTAX and exit 1', () => {
  const dir = makeRoot()
  writeFileSync(join(dir, 'scripts/x.sh'), BAD)
  assert.notEqual(bashN(join(dir, 'scripts/x.sh')), 0)
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^SYNTAX scripts\/x\.sh$/m)
  rmSync(dir, { recursive: true })
})

test('a syntax error in routine/*.sh gives SYNTAX and exit 1', () => {
  const dir = makeRoot()
  writeFileSync(join(dir, 'routine/r.sh'), BAD)
  assert.notEqual(bashN(join(dir, 'routine/r.sh')), 0)
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^SYNTAX routine\/r\.sh$/m)
  rmSync(dir, { recursive: true })
})

test('a pattern that matches no file gives MISSING and exit 1', () => {
  const dir = makeRoot()
  rmSync(join(dir, 'routine/r.sh'))
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^MISSING routine\/\*\.sh$/m)
  rmSync(dir, { recursive: true })
})

test('a root argument is used in place of the default', () => {
  const dir = makeRoot()
  const other = mkdtempSync(join(tmpdir(), 'check-syntax-empty-'))
  const r = run(dir, [other])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^MISSING scripts\/\*\.sh$/m)
  rmSync(dir, { recursive: true })
  rmSync(other, { recursive: true })
})

test('the repo itself passes', () => {
  const r = spawnSync('bash', [join(repo, 'scripts/check-syntax.sh')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /^OK \d+ files$/m)
})

test('AGENTS.md and ci.yml call the script and hold no for loop', () => {
  for (const f of ['AGENTS.md', '.github/workflows/ci.yml']) {
    const text = readFileSync(join(repo, f), 'utf8')
    assert.match(text, /bash scripts\/check-syntax\.sh/, f)
    assert.doesNotMatch(text, /for f in/, f)
  }
})
