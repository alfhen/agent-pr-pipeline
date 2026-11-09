// No file the plugin ships may call a GraphQL-backed gh subcommand: the cloud proxy refuses GraphQL with a 403.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, mkdtempSync, cpSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const FOLDERS = ['workflows', 'agents', 'scripts', 'routine', 'templates']
const FORBIDDEN = /\bgh\s+(pr|issue|run|release|repo|label|search|workflow|project)\b|gh\s+api\s+graphql|--body-file/
const BODY_FORM = /(?:pulls|issues|replies)\b[^\n]*?\s(-f|-F|--field|--raw-field)\s+body=(\S)/g
const PROMPT_FOLDERS = ['workflows', 'agents']

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

// base is the tree to scan; returns the hits as "file:line: text".
const scan = (base) => {
  const files = FOLDERS.flatMap((f) => { try { return walk(join(base, f)) } catch { return [] } })
  const hits = []
  for (const file of files) {
    const rel = relative(base, file)
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (FORBIDDEN.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
      if (PROMPT_FOLDERS.includes(rel.split('/')[0])) {
        for (const m of line.matchAll(BODY_FORM)) {
          if (m[1] !== '-F' || m[2] !== '@') hits.push(`${rel}:${i + 1}: body not from a file: ${line.trim()}`)
        }
      }
    })
  }
  return { files: files.map((f) => relative(base, f)), hits }
}

test('the tree has no GraphQL gh subcommand and prompts pass bodies from files', () => {
  const { files, hits } = scan(root)
  assert.ok(files.includes('workflows/run-wave.js'), 'scan reads run-wave.js')
  assert.ok(files.includes('agents/evaluator.md'), 'scan reads evaluator.md')
  assert.deepEqual(hits, [])
})

const withLine = (rel, oldLine) => {
  const base = mkdtempSync(join(tmpdir(), 'rest-only-'))
  for (const f of FOLDERS) { try { cpSync(join(root, f), join(base, f), { recursive: true }) } catch {} }
  const file = join(base, rel)
  writeFileSync(file, readFileSync(file, 'utf8') + `\n${oldLine}\n`)
  return base
}

test('gh pr create put back in run-wave.js fails the scan', () => {
  const { hits } = scan(withLine('workflows/run-wave.js', '2. PR: `gh pr create -R o/r --head b --body-file <file>`'))
  assert.equal(hits.length, 1)
  assert.match(hits[0], /^workflows\/run-wave\.js:\d+:/)
})

test('the old evaluator wording fails the scan', () => {
  const { hits } = scan(withLine('agents/evaluator.md', '(REST calls only, never `gh pr`, `gh issue` or `gh run`)'))
  assert.ok(hits.length >= 1)
  assert.match(hits[0], /^agents\/evaluator\.md:\d+:/)
})

test('an inline body on a pulls call in prompt text fails the scan', () => {
  const { hits } = scan(withLine('workflows/run-wave.js', '`gh api -X POST repos/o/r/pulls -f body=text`'))
  assert.equal(hits.length, 1)
  assert.match(hits[0], /body not from a file/)
})

test('an inline body is not cleared by a file body later on the same line', () => {
  const { hits } = scan(withLine('workflows/run-wave.js', '`gh api repos/o/r/pulls/1 -F body=text` then `gh api repos/o/r/issues -F body=@f`'))
  assert.equal(hits.length, 1)
  assert.match(hits[0], /body not from a file/)
})

test('graphql through gh api fails the scan', () => {
  const { hits } = scan(withLine('scripts/wait-ci.sh', 'gh api graphql -f query=x'))
  assert.equal(hits.length, 1)
})

test("--body-file put back in an agent file fails the scan", () => {
  const { hits } = scan(withLine("agents/pr-opener.md", "pass it with `--body-file`"))
  assert.equal(hits.length, 1)
})
