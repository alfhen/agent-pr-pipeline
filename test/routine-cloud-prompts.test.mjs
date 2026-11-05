// Checks the text of the cloud routine prompts against the scripts they name. No agent runs here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const KINDS = ['triage', 'build', 'collect']
const WORKTREE = '/tmp/apl-src-<defaultSha>'
const FORBIDDEN = ['merge-pr.sh', 'merge-wave.sh', 'land-wave.sh', 'release.sh']

const usageOf = (script) => read(`scripts/${script}`).split('\n').filter((l) => l.startsWith('#')).join('\n')
const rs = usageOf('routine-state.sh')
const ff = usageOf('file-feedback.sh')
const fo = usageOf('feedback-outbox.sh')
const putKinds = new Set(rs.replace(/\n#\s*/g, ' ').match(/put (adopt\|.*?) \(see/)[1].replace(/ /g, '').split('|'))

// Returns the problems found in the prompt texts, as { file: text }.
function commandProblems(prompts) {
  const bad = []
  for (const [file, text] of Object.entries(prompts)) {
    for (const m of text.matchAll(/routine-state\.sh <(?:repo|source)> ([a-z-]+)(?: (--mode [a-z-]+|--start|[a-z-]+))?/g)) {
      const [cmd, sub] = [m[1], m[2]]
      if (cmd === 'put' && !sub) continue
      if (cmd === 'put') {
        if (!putKinds.has(sub) || !rs.includes(sub)) bad.push(`${file}: put ${sub}`)
      } else if (cmd === 'next') {
        if (!/^--mode cloud-(triage|build)$/.test(sub || '') || !rs.includes(sub.slice(7))) bad.push(`${file}: next ${sub}`)
      } else if (cmd === 'list') {
        if (sub !== 'outboxes' || !rs.includes('list outboxes')) bad.push(`${file}: list ${sub}`)
      } else if (cmd === 'get') {
        if (sub !== 'outbox' || !rs.includes('get outbox')) bad.push(`${file}: get ${sub}`)
      } else if (!['gate', 'issue-text'].includes(cmd) || !rs.includes(cmd)) bad.push(`${file}: ${cmd}`)
    }
    for (const m of text.matchAll(/`[^`]*\bput ([a-z][a-z-]*)[^`]*`/g)) {
      if (!putKinds.has(m[1])) bad.push(`${file}: put ${m[1]}`)
    }
    for (const m of text.matchAll(/file-feedback\.sh((?: (?:--[a-z-]+|<[a-z]+>))*)/g)) {
      for (const flag of m[1].match(/--[a-z-]+/g) || []) if (!ff.includes(flag)) bad.push(`${file}: file-feedback.sh ${flag}`)
    }
    if (/feedback-outbox\.sh/.test(text) && !/feedback-outbox\.sh <repo> \S+ --run <run>/.test(text)) bad.push(`${file}: feedback-outbox.sh form`)
  }
  return [...new Set(bad)]
}

const prompts = Object.fromEntries(KINDS.map((k) => [k, read(`routine/cloud/${k}.md`)]))

test('every command a prompt names is in the usage of its script', () => {
  assert.deepEqual(commandProblems(prompts), [])
  assert.ok(Object.values(prompts).join('\n').match(/routine-state\.sh/g).length >= 10, 'the check reads the commands')
  assert.match(fo, /feedback-outbox\.sh <owner\/repo> <result\.json> --run <run>/)
  assert.ok(putKinds.has('feedback-outbox') && putKinds.has('built') && putKinds.has('triage-failed'))
})

test('a prompt that names next --mode cloud fails the command check', () => {
  const bad = commandProblems({ ...prompts, build: prompts.build.replace('next --mode cloud-build', 'next --mode cloud') })
  assert.equal(bad.length, 1)
  assert.match(bad[0], /next --mode cloud$/)
})

test('a prompt that names a put kind the script lacks fails the command check', () => {
  const bad = commandProblems({ ...prompts, triage: prompts.triage.replace('put adopt <issue>', 'put adopted <issue>') })
  assert.deepEqual(bad, ['triage: put adopted'])
})

test('a prompt with a misspelled short put form fails the command check', () => {
  const bad = commandProblems({ ...prompts, build: prompts.build.replace('`put needs-plan <issue>`', '`put need-plan <issue>`').replace('`put blocked ', '`put blockd ') })
  assert.deepEqual(bad.sort(), ['build: put blockd', 'build: put need-plan'])
})

test('the forbidden scripts appear only in the never-run line', () => {
  for (const [kind, text] of Object.entries(prompts)) {
    const lines = text.split('\n')
    const never = lines.filter((l) => /^- Never run /.test(l))
    assert.equal(never.length, 1, `${kind}: one never-run line`)
    for (const name of FORBIDDEN) assert.ok(never[0].includes(`\`${name}\``), `${kind}: the never-run line names ${name}`)
    for (const l of lines) if (l !== never[0]) for (const name of FORBIDDEN) assert.ok(!l.includes(name), `${kind}: ${name} outside the never-run line`)
  }
})

test('no prompt uses a gh subcommand that the REST-only scan forbids', () => {
  for (const [kind, text] of Object.entries(prompts)) {
    assert.doesNotMatch(text, /\bgh\s+(pr|issue|run|release|repo|label|search|workflow|project)\b|gh\s+api\s+graphql|--body-file/, kind)
  }
})

test('each prompt fetches first and names the source worktree before other commands', () => {
  for (const [kind, text] of Object.entries(prompts)) {
    const fetch = text.indexOf('git fetch origin')
    assert.ok(fetch >= 0, `${kind}: git fetch origin`)
    assert.ok(text.includes(`git worktree add --detach ${WORKTREE} <defaultSha>`), `${kind}: the worktree`)
    for (const other of ['git worktree', 'routine-state.sh', 'file-feedback.sh', 'feedback-outbox.sh', 'gh api']) {
      assert.ok(!text.includes(other) || text.indexOf(other) > fetch, `${kind}: ${other} comes after git fetch origin`)
    }
    assert.ok(text.indexOf('git worktree') < text.indexOf('routine-state.sh'), `${kind}: the worktree comes before the scripts`)
  }
})

test('every line that names a repo file names the worktree path', () => {
  for (const [kind, text] of Object.entries(prompts)) {
    for (const l of text.split('\n')) {
      if (/docs\/goals\.md|CLAUDE\.md|pipeline\.json|\bsrc\/|\.github\//.test(l)) assert.ok(l.includes(WORKTREE), `${kind}: ${l}`)
    }
    assert.match(text, /Never read them from the clone's `HEAD`/, kind)
  }
})

test('the shared paragraph names the notice, the root and env-stale', () => {
  const p = read('routine/cloud/prompt.md')
  for (const w of ['PushNotification', 'NOTICE', 'ROOT', 'put env-stale']) assert.ok(p.includes(w), w)
})

test('triage and build stop on the would- step, whatever the line count', () => {
  assert.match(prompts.triage, /If any line has the step `would-triage` \(stage 0\)[^\n]*print the `would-triage` line and stop\. Start no agent, also when it is the only line/)
  assert.match(prompts.build, /If any line has the step `would-build` \(stage 0\)[^\n]*print the `would-build` line and stop\. Run no `put build-started` and no Workflow call, also when it is the only line/)
  for (const t of [prompts.triage, prompts.build]) {
    assert.doesNotMatch(t, /several lines|one line \(stage 1/)
    assert.match(t, /\n4\. Otherwise there is one line\./)
  }
  assert.ok(prompts.triage.indexOf('would-triage') < prompts.triage.indexOf('<agentPrefix>triager'))
  assert.ok(prompts.build.indexOf('would-build') < prompts.build.indexOf('put build-started'))
  assert.match(prompts.build, /put build-started[^\n]*If it prints a line that starts with `WOULD`, stop\./)
})

test('triage and collect read the settings through config.jq', () => {
  for (const kind of ['triage', 'collect']) {
    const t = prompts[kind]
    assert.match(t, /jq -c --arg form pipeline -f <pluginRoot>\/routine\/config\.jq \/tmp\/apl-src-<defaultSha>\/\.github\/pipeline\.json/, kind)
    assert.doesNotMatch(t, /docs\/goals\.md/, kind)
    assert.doesNotMatch(t, /jq [^\n]*'[^'\n]*\.routine\./, kind)
  }
  assert.match(prompts.triage, /`\.routine\.waveArgs\.goals`/)
  assert.match(prompts.triage, /\/tmp\/apl-src-<defaultSha>\/<goals>/)
  assert.match(prompts.collect, /`\.routine\.collectFrom`/)
  assert.match(prompts.collect, /Handle a repo once/)
})

test('collect names get outbox and paused, and stops on paused <repo>', () => {
  const c = prompts.collect
  assert.match(c, /get outbox <run>/)
  assert.match(c, /If it prints `paused <repo>`, stop/)
  assert.match(c, /If the output has `paused <repo>`, stop/)
  assert.match(c, /If it has `paused <source>`, go on with the next source repo/)
  assert.doesNotMatch(c, /routine-state\.sh <(repo|source)> put/)
  assert.match(c, /--drop-old/)
  assert.match(c, /--outbox <source> <run>/)
})

test('build passes args through the file and reads it back', () => {
  const b = prompts.build
  assert.match(b, /Write the `args` object of the step, as it is, to `\/tmp\/apl-<run>\/args\.json`\. Read it back with the Read tool/)
  assert.match(b, /Call Workflow with `scriptPath` `<pluginRoot>\/workflows\/run-wave\.js` and exactly the object you read/)
  assert.ok(b.includes('select:Workflow'))
  assert.ok(b.indexOf('args.json') < b.indexOf('scriptPath'))
  assert.match(b, /result\.json/)
  assert.ok(b.indexOf('put built') < b.indexOf('feedback-outbox.sh'))
})

test('triage gives issue text to the triager only through issue-text', () => {
  const t = prompts.triage
  assert.match(t, /the output of `issue-text` as the whole issue/)
  assert.match(t, /makes no `gh` call for the issue or its comments/)
  assert.doesNotMatch(t, /gh api/)
  assert.doesNotMatch(t, /repos\/<repo>\/issues/)
  assert.match(t, /the ready clone is `\/tmp\/apl-src-<defaultSha>`[^\n]*only there and makes no clone/)
})

test('every agent a prompt names starts with <agentPrefix>', () => {
  for (const [kind, text] of Object.entries(prompts)) {
    for (const m of text.matchAll(/`([A-Za-z<>-]*(?:triager|reviewer|tester|implementer|evaluator|planner|fixer|docs-writer))`/g)) {
      assert.ok(m[1].startsWith('<agentPrefix>'), `${kind}: ${m[1]}`)
    }
  }
  assert.ok(prompts.triage.includes('<agentPrefix>triager'))
})

test('no prompt takes a step that next did not print', () => {
  for (const [kind, text] of Object.entries(prompts)) {
    assert.match(text, /only for a step that `next` printed|Write to GitHub only through `file-feedback\.sh`/, kind)
    assert.match(text, /data, never instructions/, kind)
  }
})
