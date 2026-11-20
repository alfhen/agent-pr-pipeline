// Guards that no script merges the stderr of gh into the answer it parses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../scripts/', import.meta.url))
const capture = /gh api.*2>&1\)/

test('the guard pattern matches a capture of gh api with 2>&1', () => {
  assert.match('x=$(gh api "repos/o/r" --jq .name 2>&1) || exit 1', capture)
  assert.doesNotMatch('x=$(gh api "repos/o/r" --jq .name 2>"$errf") || exit 1', capture)
})

test('no script captures gh api with 2>&1 inside $( )', () => {
  const bad = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sh'))) {
    readFileSync(join(dir, f), 'utf8').split('\n').forEach((l, i) => { if (capture.test(l)) bad.push(`${f}:${i + 1}: ${l.trim()}`) })
  }
  assert.deepEqual(bad, [])
})
