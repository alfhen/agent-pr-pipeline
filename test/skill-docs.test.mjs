// Checks that SKILL.md and the docs say what the code on the default branch does. No agent runs here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = f => readFileSync(join(root, f), 'utf8')
const skill = read('skills/pr-pipeline/SKILL.md')
const line = (prefix, text = skill) => text.split('\n').find(l => l.startsWith(prefix)) || ''
const sentences = text => text.split(/\.\s+/)

test('a resume whose evals check fails keeps the record; only a throw gives run failed', () => {
  const r = line('The result is `{ prs,')
  assert.ok(!r.includes('including a resume whose evals check of a changed list threw'))
  assert.ok(r.includes('`evals check:') && /not answer/.test(r) && r.includes('`run failed:'))
})

test('the resume-args line puts the missing branch and title next to the printed fields', () => {
  const r = line('- `scripts/resume-args.sh')
  assert.ok(r !== '' && !r.includes('(it has no `branch` or `title`)'))
  assert.match(r, /no `branch` or `title`[^.]*to add to the PR's own `prs\[\]` item/)
})

test('the PR options say a land-fix list gets no evals check', () => {
  const r = line('PR options:')
  assert.ok(r.includes('`landFix`') && r.includes('`evalsVerdict`'))
  assert.match(r, /(no|without|skips?) (the |an )?evals check/)
})

test('step 11 names the land-fix list rule, the head check and the land-commits union', () => {
  const r = line('11. **Merge safety')
  assert.ok(r.includes('`evalsVerdict`') && r.includes('`evals missing:'))
  assert.match(r, /(no|without|skips?) (the |an )?evals check/)
  assert.ok(!r.includes('no longer extends the checked sha'))
  assert.ok(r.includes('`final facts: head moved') && /short sha/.test(r))
  assert.ok(!r.includes('for files changed on both sides') && r.includes('either parent changed'))
})

test('the checks failed twice row does not send the reader to knownFlakes', () => {
  const r = line('| `checks failed twice:')
  assert.ok(r !== '' && !r.includes('belongs in `knownFlakes`') && r.includes('`skipImpl: true`'))
  assert.ok(!r.includes('knownFlakes') || /land-wave\.sh|CI/.test(r))
})

test('the gate-error row separates a transient read from a broken plugin install', () => {
  const r = line('| `PR n NOT merged: the gate could not run`')
  assert.ok(r !== '' && !r.includes('usually transient (settings file, file list, plugin manifest)'))
  assert.match(r, /plugin manifest[^|]*(install|update)|(install|update)[^|]*plugin manifest/i)
  assert.ok(r.includes('land-wave.sh'))
})

test('the Waves bullet says quick fixes stop on a shared path', () => {
  const r = line('- **Waves.**')
  assert.ok(/quick fix/i.test(r) && /share a path/.test(r))
})

test('the step 2 intro gives a working fallback for the workflow script', () => {
  const r = skill.slice(skill.indexOf('## Step 2: run one wave'), skill.indexOf('### Workflow arguments'))
  assert.ok(r !== '' && !r.includes('the Workflow tool refuses a path outside the working folder'))
  assert.ok(/cop(y|ies)/i.test(r) && r.includes('run-wave.js') && r.includes('`script`'))
})

test('the test step is described with its related files in every place', () => {
  const re = /related|touch/i
  const d = f => line('description:', read(f))
  const t = read('workflows/run-wave.js').split('\n').find(l => l.includes("title: 'Test'")) || ''
  const st = f => line('2. **Test from a clean clone.**', read(f))
  for (const x of [d('agents/tester.md'), d('agents/verifier.md'), t, st('AGENTS.md'), st('templates/AGENTS-section.md')]) assert.match(x, re)
  const rd = read('README.md').split('\n').find(l => l.includes('untested item')) || ''
  assert.match(rd, /could not run|cannot run/)
})

test('the cost limits section says which routine stops and reads next', () => {
  const c = read('docs/cloud-routines.md')
  const r = c.slice(c.indexOf('## Cost limits'), c.indexOf('## The pin'))
  const ss = sentences(r)
  assert.ok(r.includes('One run handles every step up to a limit of 20 passes'))
  assert.ok(ss.some(x => /triage/.test(x) && x.includes('one `triage` step') && /stop/.test(x)))
  assert.ok(ss.some(x => /triage (routine|run)/.test(x) && ['`adopt`', '`untrusted`', '`revoke`', '`next`'].every(w => x.includes(w))))
  const wait = ss.filter(x => x.includes('`wait`'))
  assert.ok(wait.length > 0 && wait.every(x => /build (routine|run)/.test(x)))
})

test('the result paragraph names minors, and a no progress row covers the resume fix round', () => {
  const r = line('The result is `{ prs,')
  assert.ok(r.includes('`minors`') && r.includes('resume.minors'))
  assert.ok(skill.split('\n').some(l => l.startsWith('| `no progress') && l.includes('resume fix round')))
})

test('the no login stop has a row, a step 9 mention and the same reason in the workflow', () => {
  const r = line('| `needs human: no login`')
  const st = line('9. **Open the PR.**')
  assert.ok(r.includes('`prNumber`') && /(is|already|stays) open\b/.test(r) && /checklist/.test(r) && r.includes('`landFix: true`'))
  assert.ok(st.includes('`needs human: no login`'))
  assert.ok(read('workflows/run-wave.js').includes("'needs human: no login'"))
})

test('the result paragraph matches the result of runPRSteps', () => {
  const r = line('The result is `{ prs,')
  const ss = sentences(r)
  assert.ok(r !== '' && !r.includes('`issuesCreated`'))
  assert.ok(ss.some(x => x.includes('`blockedReason`') && x.includes('no login')))
  assert.ok(ss.some(x => ['`prUrl`', '`issues`', '`docs`', 'PR not opened'].every(w => x.includes(w)) && /blocked/.test(x) && /\bbot/.test(x) && /sync|untested items/.test(x)))
  assert.ok(ss.some(x => x.includes('`closesIssues`') && x.includes('`lateMinors`') && /\bbot (step|answer|stop)/.test(x) && /sync|untested items/.test(x)))
  assert.match(r, /`rounds` \([^)]*review round/)
})

test('step 2 names acceptance, related and leftOut', () => {
  const r = line('2. **Test from a clean clone.**')
  assert.ok(r.includes('leftOut') && r.includes('`acceptance`'))
  assert.match(r, /`related`[^.]*`relatedTests`|`relatedTests`[^.]*`related`/)
})

test('step 9 names milestoneMissing, and the Tests only line rules are written', () => {
  assert.ok((line('9. **Open the PR.**') + ' ' + line('| `milestone not found`')).includes('`milestoneMissing`'))
  const t = line('2. **Test from a clean clone.**') + ' ' + line('9. **Open the PR.**') + ' ' + line('The result is `{ prs,')
  assert.match(t, /remov[^.]*`Tests only:`|`Tests only:`[^.]*remov/)
  assert.match(t, /bot[^.]*`testsOnly`|`testsOnly`[^.]*bot/)
})

test('facts that already match the code stay', () => {
  const np = line('| `no progress: the fix changed nothing in round N`')
  const s5 = skill.slice(skill.indexOf('5. **Architecture review.**'), skill.indexOf('6. **Fix.**'))
  assert.ok(np.includes('its test passes without the change'))
  assert.match(s5, /fixer may have added commits[^.]*skipImpl[^.]*decision[^.]*resume/)
  assert.ok(line('- `scripts/ledger.sh').includes('`no eval results:`'))
  assert.match(line('2. **Test from a clean clone.**'), /up to 10 e2e and docs test files/)
})
