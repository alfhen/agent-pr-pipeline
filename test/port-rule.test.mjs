import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const body = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
const near = (t, w) => {
  const m = /[^.\n]*\bports?\b[^.\n]*\bin use\b[^.\n]*|[^.\n]*\bin use\b[^.\n]*\bports?\b[^.\n]*/i.exec(t)
  if (!m) return false
  const s = t.slice(m.index, m.index + m[0].length + 300)
  return /once more|again|a second time|one more time|rerun|re-run/i.test(s) && s.includes(w)
}
const conditional = (t, w) => near(t, w) && new RegExp('only when the port is still in use', 'i').test(t.slice(t.search(/\bports?\b[^.\n]*\bin use\b/i)))

test('the tester runs a check that fails on a port in use once more and reports it as refused', () => {
  assert.ok(near(body('agents/tester.md'), 'refused'))
  assert.ok(conditional(body('agents/tester.md'), 'refused'))
})
test('the verifier runs a check that fails on a port in use once more and reports it as refused', () => {
  assert.ok(near(body('agents/verifier.md'), 'refused'))
  assert.ok(conditional(body('agents/verifier.md'), 'refused'))
})
test('qa step 4 reruns a scenario that fails on a port in use and reports it as not-run', () => {
  const step = body('agents/qa.md').split('\n').find(l => l.startsWith('4. ')) || ''
  assert.ok(near(step, 'not-run'))
  assert.ok(conditional(step, 'not-run'))
})
test('the verifier bullet on tests only names Markdown files and keeps its pinned words', () => {
  const line = body('agents/verifier.md').split('\n').find(l => /^- .*a script found that every file the PR changes is a test/.test(l)) || ''
  assert.match(line, /a script found that every file the PR changes is a test[^.]*`not-applicable`[^.]*`tests only: no change to take out`/)
  assert.match(line, /Markdown/i)
})
test('SKILL.md steps 2 and 4 name the Markdown rule and the port rule', () => {
  const s = fs.readFileSync(new URL('../skills/pr-pipeline/SKILL.md', import.meta.url), 'utf8')
  const step = n => { const i = s.indexOf(`\n${n}. **`); return s.slice(i, s.indexOf(`\n${n + 1}. `, i + 1)) }
  assert.ok(near(step(2), 'refused'))
  assert.ok(near(step(4), 'not-run'))
  assert.ok(conditional(step(2), 'refused'))
  assert.ok(conditional(step(4), 'not-run'))
  assert.ok(step(2).split(/(?<=\.)\s+/).some(x => /Markdown/.test(x) && /\btests?\b/.test(x)))
})
test('the run-wave prompts make the port rule conditional', () => {
  const src = fs.readFileSync(new URL('../workflows/run-wave.js', import.meta.url), 'utf8')
  assert.match(src, /const refusedText = [^\n]*only when the port is still in use/)
})
test('the verify prompt, verifier.md and SKILL.md say a port still in use on the second run is a ci case', () => {
  const src = fs.readFileSync(new URL('../workflows/run-wave.js', import.meta.url), 'utf8')
  const skill = fs.readFileSync(new URL('../skills/pr-pipeline/SKILL.md', import.meta.url), 'utf8')
  assert.match(src, /const refusedText = [^\n]*For the check of an eval, a port that is still in use on the second run[^\n]*result `ci`/)
  assert.match(skill, /refused the command, or a port stayed in use on the second run of its check/)
  assert.match(body('agents/verifier.md'), /port is in use runs once more[^\n]*still in use on the second run[^\n]*result `ci`/)
})
