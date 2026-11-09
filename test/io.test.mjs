// Runs scripts/io.sh from a temp scripts/ folder with stub scripts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'io-test-'))
mkdirSync(join(dir, 'scripts'))
copyFileSync(join(root, 'scripts/io.sh'), join(dir, 'scripts/io.sh'))
const stub = (name, body) => writeFileSync(join(dir, 'scripts', name), `#!/bin/bash\n${body}\n`)
stub('ok-stub.sh', 'echo "hello $1"')
stub('fail-stub.sh', 'echo "partial"; exit 65')
stub('err-stub.sh', 'echo "out"; echo "oops" >&2; exit 3')
stub('quiet-stub.sh', 'exit 0')
writeFileSync(join(dir, 'secret.sh'), 'echo escaped\n')

const io = (...args) => spawnSync('bash', [join(dir, 'scripts/io.sh'), ...args], { encoding: 'utf8', cwd: tmpdir() })

test('exit 0 prints the begin line, the output and the exit line', () => {
  const r = io('ok-stub.sh', 'world')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, 'pipeline-io: begin\nhello world\npipeline-io: exit 0\n')
})

test('exit 65 is the last line and the exit code of io.sh', () => {
  const r = io('fail-stub.sh')
  assert.equal(r.status, 65)
  assert.equal(r.stdout.trim().split('\n').at(-1), 'pipeline-io: exit 65')
  assert.match(r.stdout, /partial/)
})

test('stderr of the script is part of the output', () => {
  const r = io('err-stub.sh')
  assert.equal(r.status, 3)
  assert.match(r.stdout, /out\noops\npipeline-io: exit 3/)
})

test('a script with no output gives only the two lines', () => {
  assert.equal(io('quiet-stub.sh').stdout, 'pipeline-io: begin\npipeline-io: exit 0\n')
})

test('a name with a slash, .., a bad shape or no file gives exit 64 and runs nothing', () => {
  for (const name of ['../secret.sh', 'a/b.sh', '..', 'secret.sh', 'missing.sh', 'Upper.sh', 'ok-stub.sh.bak', '']) {
    const r = io(name)
    assert.equal(r.status, 64, name)
    assert.doesNotMatch(r.stdout, /escaped|hello/, name)
    assert.match(r.stdout, /pipeline-io: exit 64\n$/, name)
  }
})
