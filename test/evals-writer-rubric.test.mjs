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

test('one rule ties the plan rules, the Touches limit and the fails-on-default claim to the list', () => {
  assert.ok(rules.some(r => /Rules for every PR/.test(r) && /Touches line is a limit/.test(r) && /default branch/.test(r)))
})
