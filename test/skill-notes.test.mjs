// Checks that the Lessons section of SKILL.md keeps the shallow-clone and milestone notes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const skill = readFileSync(new URL('../skills/pr-pipeline/SKILL.md', import.meta.url), 'utf8')
const lessons = skill.slice(skill.indexOf('## Lessons'), skill.indexOf('\n## Files'))

test('lessons tell a shallow clone to fetch a branch with an explicit refspec', () => {
  assert.match(lessons, /shallow|single-branch/i)
  assert.match(lessons, /git fetch origin <branch>:refs\/remotes\/origin\/<branch>/)
})

test('lessons set a milestone through the REST API, not gh issue edit', () => {
  assert.match(lessons, /gh api -X PATCH repos\/<repo>\/issues\/<n> -F milestone=<number>/)
  assert.match(lessons, /gh issue edit --milestone/)
})

const step1 = skill.slice(skill.indexOf('## Step 1'), skill.indexOf('## Step 2'))

test('step 1 has the plan-author checklist with its six items', () => {
  assert.ok(skill.includes('## Step 1') && skill.includes('## Step 2'), 'step headings missing')
  assert.match(step1, /Plan-author checklist/)
  const items = [
    /Rules for every PR/,
    /shared path or value in one place/,
    /~\/Library\/LaunchAgents.*~\/\.agent-pr-pipeline.*real `HOME`/,
    /acceptance test a way to fail/,
    /Invariants line.*States table/,
    /gated paths each entry touches/,
  ]
  for (const re of items) assert.match(step1, re)
})

test('skill names the version warnings, the gate error and the older approval label', () => {
  assert.match(skill, /`warnings`/)
  assert.match(skill, /GATE ERROR/)
  assert.match(skill, /approved earlier/)
  assert.match(skill, /`gateOutput`/)
})

test('skill names the manifest, the cloud prompts and the pin; the cloud doc names its core terms', () => {
  assert.match(skill, /manifest\.sh/)
  assert.match(skill, /routine\/cloud\//)
  assert.match(skill, /pipelineVersion/)
  const cloud = readFileSync(new URL('../docs/cloud-routines.md', import.meta.url), 'utf8')
  for (const term of ['maintainer-approved', 'routine-paused', 'performed_via_github_app', 'apl-start', 'stage'])
    assert.ok(cloud.includes(term), `docs/cloud-routines.md misses ${term}`)
  assert.match(cloud, /no webhooks/i)
})

test('routine doc names the cut, the new records and full-mode next; skill names config.jq', () => {
  const routine = readFileSync(new URL('../docs/routine.md', import.meta.url), 'utf8')
  assert.match(routine, /`whyCut`/)
  assert.match(routine, /`build-started`/)
  assert.match(routine, /next --mode full/)
  assert.match(skill, /routine\/config\.jq/)
})

test('docs say entries of one wave can share a file when they edit different parts', () => {
  const rule = /can touch the same file when they edit different parts of it/
  for (const f of ['../skills/pr-pipeline/SKILL.md', '../AGENTS.md', '../templates/AGENTS-section.md', '../templates/plan.md']) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.match(text, rule, f)
    assert.doesNotMatch(text, /touch different files/, f)
  }
  assert.match(step1, /names the function or section for a shared file/)
})
