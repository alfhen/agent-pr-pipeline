// Checks the text of the cloud routine prompts against the scripts they name. No agent runs here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
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

test('a failed next stops build and triage, and prompt.md stops on any other apl-start exit', () => {
  for (const k of ['build', 'triage']) assert.match(prompts[k], /If `next` exits non-zero, log its output and stop/)
  const p = read('routine/cloud/prompt.md')
  assert.match(p, /On any other exit code \(2, 127\), stop and do nothing else/)
  assert.match(p, /put env-ok <version>` \(if it exits non-zero, stop/)
  assert.match(prompts.build, /Run scripts only from `<pluginRoot>`, or the copy of the workflow script that step 5\.4 makes from it/)
  assert.match(prompts.collect, /per_page=100" --jq '\.\[\] \| \{number, title, body\}'/)
})

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
  assert.match(prompts.triage, /If there are several lines, or any line has the step `would-triage` \(stage 0\), run the `put` of every line that is not `would-triage`[^\n]*print the `would-triage` line if there is one, and stop\. Start no agent/)
  assert.match(prompts.build, /If there are several lines, or any line has the step `would-build` \(stage 0\), run the `put` of every line that is not `would-build`[^\n]*print the `would-build` line if there is one, and stop\. Run no `put build-started` and no Workflow call/)
  for (const t of [prompts.triage, prompts.build]) {
    assert.doesNotMatch(t, /one line \(stage 1/)
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
  assert.match(b, /Call Workflow with `scriptPath` the absolute path `<clone>\/\.git\/apl\/run-wave\.js` and exactly the object you read/)
  assert.doesNotMatch(b, /scriptPath` `?<pluginRoot>/)
  assert.match(b, /`mkdir -p \.git\/apl && cp <pluginRoot>\/workflows\/run-wave\.js \.git\/apl\/run-wave\.js`/)
  assert.ok(b.indexOf('cp <pluginRoot>/workflows/run-wave.js') < b.indexOf('Call Workflow'))
  assert.ok(b.includes('select:Workflow'))
  assert.ok(b.indexOf('args.json') < b.indexOf('scriptPath'))
  assert.match(b, /result\.json/)
  assert.ok(b.indexOf('put built') < b.indexOf('feedback-outbox.sh'))
})

test('build reads the build result with wave-result.sh and goes back to next after a build', () => {
  const b = prompts.build
  assert.match(b, /scripts\/wave-result\.sh <output-file> \/tmp\/apl-<run>\/result\.json/)
  assert.ok(b.indexOf('Call Workflow') < b.indexOf('wave-result.sh') && b.indexOf('wave-result.sh') < b.indexOf('put built'))
  assert.match(b, /put built <issue> '<run>' <pr> <ready> <reasonCode> \/tmp\/apl-<run>\/result\.json/)
  assert.match(b, /script exits non-zero, stop and run no more command/)
  assert.match(b, /Never type or edit a result by hand/)
  assert.doesNotMatch(b, /Take `<pr>` from|Take `<reasonCode>` from/)
  assert.match(b, /- `build`: if this run already did a build or printed `would-build`, stop\. Otherwise do step 5, then go back to step 1/)
  assert.doesNotMatch(b, /do step 5, then stop/)
  assert.match(usageOf('wave-result.sh'), /wave-result\.sh <workflow output file> <result file>/)
  assert.match(rs, /put built <issue> <run> <pr> <ready> <reasonCode> \[<result file>\]/)
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

test('collect and build check a record-derived run id and quote it', () => {
  const re = /\^\[0-9\]\{8\}T\[0-9\]\{6\}Z-\[0-9a-f\]\{8\}\$/
  assert.match(prompts.collect, re)
  assert.match(prompts.build, /`block`: [^\n]*matches `\^\[0-9\]\{8\}T/)
  for (const k of ['collect', 'build']) assert.match(prompts[k], /single quotes/)
})

test('triage uses decision, size, risk and type only when exactly a listed word', () => {
  assert.match(prompts.triage, /only when the decision is exactly `build`, `plan` or `decline`, the size is exactly `S`, `M` or `L`, the risk is exactly `low`, `medium` or `high`, and the type is exactly `bug`, `feat`, `docs`, `chore` or `test`/)
  assert.match(prompts.triage, /treat the triager as failed, skip sub-step 4 and do sub-step 5 for this issue/)
  assert.doesNotMatch(prompts.triage, /go to step 5/)
})

const LOOP_KINDS = ['triage', 'build']

test('triage and build loop on next, up to 20 passes', () => {
  for (const k of LOOP_KINDS) {
    const t = prompts[k]
    assert.match(t, /go back to step 1 for a new `next`/, k)
    assert.match(t, /Make at most 20 passes/, k)
    assert.match(t, /Stop instead when the `put` exits non-zero \(65 included\), or when its output starts with `WOULD`/, k)
  }
})

test('mutated prompts fail the loop and script checks', () => {
  const loopOk = (t) => /go back to step 1 for a new `next`/.test(t) && /at most 20 passes/.test(t) &&
    /exits non-zero \(65 included\)/.test(t) && /its output starts with `WOULD`/.test(t)
  for (const k of LOOP_KINDS) {
    const t = prompts[k]
    assert.ok(loopOk(t), k)
    assert.ok(!loopOk(t.replace('at most 20 passes', 'any number of passes')), `${k}: limit`)
    assert.ok(!loopOk(t.replace('exits non-zero (65 included)', 'exits 65')), `${k}: non-zero`)
    assert.ok(!loopOk(t.replace("its output starts with `WOULD`", "its output is empty")), `${k}: WOULD`)
    assert.ok(!loopOk(t.replace('go back to step 1 for a new `next`', 'stop')), `${k}: loop`)
  }
  const copyOk = (t) => /scriptPath` the absolute path `<clone>\/\.git\/apl\/run-wave\.js`/.test(t) && !/scriptPath` `?<pluginRoot>/.test(t) &&
    t.indexOf('cp <pluginRoot>/workflows/run-wave.js .git/apl/run-wave.js') >= 0 &&
    t.indexOf('cp <pluginRoot>') < t.indexOf('Call Workflow')
  const b = prompts.build
  assert.ok(copyOk(b))
  assert.ok(!copyOk(b.replace('`<clone>/.git/apl/run-wave.js`', '`<pluginRoot>/workflows/run-wave.js`')))
  assert.ok(!copyOk(b.replace('cp <pluginRoot>/workflows/run-wave.js .git/apl/run-wave.js', 'true')))
})

test('short-step bullets do not stop, so the loop is reachable', () => {
  const shortStop = (t) => t.split('\n').some((l) => /^ {3}- `(adopt|untrusted|revoke|pr-seen|exhausted|needs-plan|block)`/.test(l) &&
    /\bstop\b/i.test(/^ {3}- `block`/.test(l) ? l.replace('else log it and stop', '') : l))
  for (const k of LOOP_KINDS) {
    assert.ok(!shortStop(prompts[k]), k)
  }
  const mutations = [
    ['build', /^( {3}- `block`.*)$/m, '$1 Then stop.'],
    ['build', /^( {3}- `exhausted`.*)\.$/m, '$1, and stop.'],
    ['build', /^( {3}- `pr-seen`.*)\.$/m, '$1, then stop.'],
    ['triage', /^( {3}- `untrusted`.*)$/m, '$1 Stop.'],
    ['triage', /^( {3}- `adopt`.*)\.$/m, '$1, then stop.'],
  ]
  for (const [k, re, to] of mutations) {
    assert.match(prompts[k], re, `${k}: the bullet to mutate exists`)
    assert.ok(shortStop(prompts[k].replace(re, to)), `${k}: ${re}`)
  }
  assert.match(prompts.build, /^ {3}- `block`:.*else log it and stop\./m)
})

test('each step that must stop says so, so the one-wave-per-run and triagePerRun limits hold', () => {
  const missing = (build, triage) => [
    [triage, /^ {3}- `triage`: do step 5, then stop\.$/m, 'triage bullet'],
    [triage, /A run does the work of at most one `triage` step\./, 'triage closing line'],
    [build, /^ {3}- `build`: if this run already did a build or printed `would-build`, stop\. Otherwise do step 5, then go back to step 1\.$/m, 'build bullet'],
    [build, /A run does the work of at most one `build` step\./, 'build closing line'],
    [build, /^ {3}- `block`:.*else log it and stop\./m, 'block bullet'],
    [build, /After the 20th pass, stop\./, 'build 20th pass'],
    [triage, /After the 20th pass, stop\./, 'triage 20th pass'],
    [build, /^2\. If the only step is [^\n]*say so and stop\.$/m, 'build step 2'],
    [triage, /^2\. If the only step is [^\n]*say so and stop\.$/m, 'triage step 2'],
    [build, /^ {3}4\. From the clone, run `mkdir -p[^\n]*If the command fails, stop\./m, 'build copy failure'],
    [triage, /^5\. Read the settings once:[^\n]*If the command fails, log its output and stop\./m, 'triage settings failure'],
  ].filter(([t, re]) => !re.test(t)).map(([, , name]) => name)
  assert.deepEqual(missing(prompts.build, prompts.triage), [])
  const mutations = [
    ['build', 'if this run already did a build or printed `would-build`, stop. Otherwise', 'Otherwise', 'build bullet'],
    ['build', 'A run does the work of at most one `build` step. A `build` step after a build is not run.', '', 'build closing line'],
    ['triage', '`triage`: do step 5, then stop.', '`triage`: do step 5, then go back to step 1.', 'triage bullet'],
    ['triage', 'A run does the work of at most one `triage` step.', '', 'triage closing line'],
    ['build', 'else log it and stop', 'else use it anyway', 'block bullet'],
    ['build', 'After the 20th pass, stop.', '', 'build 20th pass'],
    ['triage', 'After the 20th pass, stop.', '', 'triage 20th pass'],
    ['build', 'say so and stop', 'go back to step 1', 'build step 2'],
    ['triage', 'say so and stop', 'go back to step 1', 'triage step 2'],
    ['build', 'If the command fails, stop.', '', 'build copy failure'],
    ['triage', 'If the command fails, log its output and stop', 'If the command fails, go on', 'triage settings failure'],
  ]
  for (const [kind, from, to, name] of mutations) {
    assert.ok(prompts[kind].includes(from), `the text to mutate exists: ${from}`)
    const mutated = { ...prompts, [kind]: prompts[kind].replace(from, to) }
    assert.deepEqual(missing(mutated.build, mutated.triage), [name], name)
  }
})

test('the triager treats the block comment as a report, with the same first sentence as blocked_comment', () => {
  const sentence = 'The build routine stopped and opened no PR.'
  const firsts = read('scripts/routine-state.sh').split('\n').filter(l => /^\s+(triage-plan|triage-decline|rounds-exhausted|needs-human|\*)\) first=/.test(l))
  assert.equal(firsts.length, 5)
  assert.ok(firsts.every(l => l.includes(`first="${sentence}`)))
  assert.ok(read('agents/triager.md').includes(`start with \`${sentence}\``))
})

test('L01 build step 9 writes the cloud ledger record after the token report, with the run id from next, and goes on after a failure', () => {
  const b = prompts.build
  const step = b.slice(b.indexOf('   9. '), b.indexOf('A run does the work'))
  assert.match(step, /scripts\/ledger\.sh <repo> put <output-file> --run <run> --cloud/)
  assert.ok(step.indexOf('token-report.sh') < step.indexOf('ledger.sh'))
  assert.match(step, /If it exits non-zero, log that and go on\.\s*$/)
  assert.match(usageOf('ledger.sh'), /ledger\.sh <owner\/repo> put <workflow output file> --run <id> \[--tokens <file>\] \[--cloud\]/)
})

test('E06-4 collect reads closed feedback issues but never lists a closed one as a duplicate', () => {
  assert.match(prompts.collect, /Do not use this list for closed issues/)
  assert.match(prompts.collect, /A closed issue is never a duplicate/)
  assert.match(prompts.collect, /`Seen before in #<n> \(closed\)`/)
})

test('the docs say one run handles every step up to the limit', () => {
  assert.match(read('docs/cloud-routines.md'), /One run handles every step up to a limit of 20 passes/)
  assert.match(read('docs/cloud-routines.md'), /copies `run-wave\.js` from `pluginRoot` to `\.git\/apl\/run-wave\.js`/)
})
