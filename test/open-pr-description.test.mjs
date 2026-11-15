// The text of the places that say what an opener or a body agent does to the description of an open PR.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const sentences = t => t.split(/(?<=\.) /)

test('openPrompt step 2 adds the minors fixed to the Minor fixes section of an open PR', () => {
  const src = read('workflows/run-wave.js')
  const i = src.indexOf('and the Untested section (set it')
  assert.ok(i > 0)
  const rest = src.slice(i, src.indexOf('Never rebuild the body from the data below'))
  assert.match(rest, /Also add to its Minor fixes section one line for each finding under "Minors fixed in the minor pass"/)
})

test('the opener role adds one line to the Minor fixes section for each minor fixed', () => {
  const line = read('agents/pr-opener.md').split('\n').find(l => l.startsWith('- Open a ready PR'))
  const after = sentences(line.slice(line.indexOf('Change only its Review line and its Untested section')))
  assert.ok(after.some(s => /Minor fixes/.test(s) && /\badd\b/i.test(s)))
})

test('step 9 names the Minor fixes lines and the Tests only removal after a bot change or a land fix', () => {
  const step = sentences(read('skills/pr-pipeline/SKILL.md').split('\n').find(l => l.startsWith('9. **Open the PR.**')))
  assert.ok(step.some(s => /Minor fixes/.test(s) && /\badds?\b/i.test(s)))
  assert.ok(step.some(s => /Tests only:/.test(s) && /bot/i.test(s) && /land fix/i.test(s)))
})
