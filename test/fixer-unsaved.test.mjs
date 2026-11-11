import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')

test('A03-6: the fixer agent reports a failed commit or push in unsaved, with the error and the worktree', () => {
  const rule = read('../agents/fixer.md').split('\n').find(l => l.startsWith('- ') && l.includes('`unsaved`'))
  assert.ok(rule, 'no rule names unsaved')
  for (const re of [/commit/, /push/, /`error`/, /`worktree`/]) assert.match(rule, re)
})

test('A03-11: the FIX schema has unsaved and the fixPrompt Return line asks for it with the error', () => {
  const src = read('../workflows/run-wave.js')
  const fix = src.slice(src.indexOf('const FIX = {'), src.indexOf('const SAFETY'))
  assert.match(fix, /unsaved: \{ type: 'object', properties: \{ error: \{ type: 'string' \} \} \}/)
  const line = src.split('\n').find(l => l.startsWith('Return a short summary of each fix'))
  assert.ok(line, 'no Return line')
  assert.match(line, /\\`unsaved\\`/)
  assert.match(line, /\\`error\\`/)
  assert.match(line, /commit or a push failed/)
})
