// Checks the prompt text in run-wave.js that no runtime test reaches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../workflows/run-wave.js', import.meta.url), 'utf8')

test('milestone lookup reads every page and escapes the title', () => {
  assert.match(src, /gh api --paginate 'repos\/\$\{REPO\}\/milestones\?per_page=100'/)
  assert.match(src, /A\.milestone\.replace\(/)
})

test('land fixer reruns wait-ci a bounded number of times', () => {
  assert.match(src, /run it again, at most 3 calls in all/)
})

test('a quick PR with the default title takes the title from the issue, through a file', () => {
  assert.match(src, /pr\.titleFromIssue = !pr\.title/)
  assert.match(src, /gh api repos\/\$\{REPO\}\/issues\/\$\{pr\.quick\.issue\} --jq \.title/)
  assert.match(src, /-F title=@<title file>/)
})

test('an explicit title is passed as it is', () => {
  assert.match(src, /: `title "\$\{pr\.title\}"`/)
  assert.match(src, /'-f title=<title>'/)
})
