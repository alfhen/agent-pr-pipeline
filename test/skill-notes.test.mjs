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
