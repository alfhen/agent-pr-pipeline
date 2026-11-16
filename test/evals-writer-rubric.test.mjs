// The list rules in the evals writer agent file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const rules = readFileSync(new URL('../agents/evals-writer.md', import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('- '))

test('one rule holds the list size for an issue and for a batch PR', () => {
  assert.ok(rules.some(r => r.includes('3 to 6') && r.includes('20')))
})

test('one rule says a quality bar eval needs a check that can fail, with a general rule as the example', () => {
  assert.ok(rules.some(r => r.includes('`quality bar`') && /check that can fail/.test(r) && r.includes('house style')))
})

test('the kind bullets say a text-only check gives the kind quality bar', () => {
  const T = rules.filter(l => l.startsWith('- `kind` is one of') || l.startsWith('- A `quality bar` eval needs its own check')).join(' ')
  const S = T.split(/(?<=\.)\s/)
  const has = (...w) => S.some(t => w.every(x => t.includes(x)))
  assert.ok(has('only reads', 'quality bar'))
  for (const w of ['search', 'doc', 'changelog', 'export', 'test file']) assert.ok(T.includes(w), w)
  assert.ok(has('behaviour', 'error path', 'runs'))
  assert.ok(has('quality bar', 'default branch'))
  assert.ok(has('quality bar', 'refused'))
  assert.ok(has('item', 'regression', 'runs'))
  assert.ok(has('runs', 'test', 'only reads', 'quality bar'))
  assert.ok(S.some(t => /refused/.test(t) && t.includes('item') && t.includes('text-only')))
  assert.ok(has('test file', 'quality bar', 'item'))
})
