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
