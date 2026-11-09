// Runs scripts/routine-spec.sh against test/fake-gh. The settings are served as the repo's .github/pipeline.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const tmp = mkdtempSync(join(tmpdir(), 'routine-spec-test-'))
const bin = join(tmp, 'bin'); mkdirSync(bin)
copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)

const good = JSON.parse(readFileSync(join(root, 'test/fixtures/settings/good.json'), 'utf8'))
const settings = (routine) => ({ gates: [], routine: { pipelineVersion: 'v0.8.0', maintainer: 'alfhen', waveArgs: { goals: 'docs/goals.md', checks: [] }, ...routine } })
const BOTH = { authorFilter: true, labelFilter: true }
const k2File = (v) => { const f = join(tmp, `k2-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); return f }

let n = 0
function spec(repo, pipeline, args = []) {
  const fx = join(tmp, `fx${n++}`); mkdirSync(fx)
  const [o, r] = repo.split('/')
  writeFileSync(join(fx, `repos__${o}__${r}__contents__.github__pipeline.json.json`), JSON.stringify(pipeline))
  const res = spawnSync('bash', [join(root, 'scripts/routine-spec.sh'), repo, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 26,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: fx, FAKE_GH_LOG: join(fx, 'log') },
  })
  return { ...res, json: res.status === 0 ? JSON.parse(res.stdout) : null }
}
const own = (out) => out.routines.map((r) => r.kind ?? r.name.split('-').pop())

test('this repo gets triage, build and collect', () => {
  const r = spec('alfhen/agent-pr-pipeline', settings({ collectFrom: ['alfhen/dogfood'] }), ['--k2', k2File(BOTH)])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(own(r.json), ['triage', 'build', 'collect'])
  assert.deepEqual(r.json.routines.map((x) => x.name), ['apl-alfhen-agent-pr-pipeline-triage', 'apl-alfhen-agent-pr-pipeline-build', 'apl-alfhen-agent-pr-pipeline-collect'])
  const collect = r.json.routines[2]
  assert.deepEqual(collect.sources, ['alfhen/agent-pr-pipeline', 'alfhen/dogfood'])
  assert.deepEqual(r.json.routines[0].sources, ['alfhen/agent-pr-pipeline'])
  assert.deepEqual(collect.webhooks, [])
})

test('collect sources drop a repeat of the repo, ignoring case', () => {
  const r = spec('alfhen/agent-pr-pipeline', settings({ collectFrom: ['Alfhen/Agent-PR-Pipeline', 'alfhen/a', 'ALFHEN/a'] }), ['--k2', k2File(BOTH)])
  assert.deepEqual(r.json.routines[2].sources, ['alfhen/agent-pr-pipeline', 'alfhen/a'])
})

test('dogfood gets triage and build only', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({}), ['--k2', k2File(BOTH)])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(own(r.json), ['triage', 'build'])
})

test('no routine key gives an empty list, a note and exit 0', () => {
  const r = spec('alfhen/pipeline-dogfood', { gates: [], autoRelease: true })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.json.routines, [])
  assert.match(r.json.note, /no routine key/)
  assert.equal(r.json.setupScript, undefined)
})

test('invalid settings exit 3', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({ stage: 'x' }))
  assert.equal(r.status, 3)
  assert.match(r.stderr, /stage/)
})

test('two repos get different minutes', () => {
  const a = spec('alfhen/pipeline-dogfood', settings({})).json.routines
  const b = spec('alfhen/tagreeve', settings({})).json.routines
  const minute = (x) => x.schedule.split(' ')[0]
  assert.notEqual(minute(a[0]), minute(b[0]))
  assert.notEqual(minute(a[0]), minute(a[1]))
  assert.match(a[0].schedule, /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* \*$/)
})

test('the same input twice gives the same output', () => {
  const args = ['--tags', 'v0.8.1', '--k2', k2File(BOTH)]
  assert.equal(spec('alfhen/tagreeve', settings({}), args).stdout, spec('alfhen/tagreeve', settings({}), args).stdout)
})

test('the default K2 file (no webhooks in 0.8.0) gives no webhooks', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({}))
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'routine/cloud/k2.json'), 'utf8')), { authorFilter: false, labelFilter: false })
  assert.deepEqual(r.json.routines.map((x) => x.webhooks), [[], []])
})

test('K2 with no author filter gives no triage webhook', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({}), ['--k2', k2File({ authorFilter: false, labelFilter: true })])
  const [triage, build] = r.json.routines
  assert.deepEqual(triage.webhooks, [])
  assert.equal(build.webhooks.length, 1)
})

test('K2 with no label filter gives no build webhook', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({}), ['--k2', k2File({ authorFilter: true, labelFilter: false })])
  const [triage, build] = r.json.routines
  assert.deepEqual(build.webhooks, [])
  assert.equal(triage.webhooks.length, 1)
})

test('K2 with both filters gives the triage author filter and the exact build labels', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({ trustedAuthors: ['helper'] }), ['--k2', k2File(BOTH)])
  const [triage, build] = r.json.routines
  assert.deepEqual(triage.webhooks, [{ event: 'issues.opened', filter: { author: ['alfhen', 'helper'] } }])
  assert.deepEqual(build.webhooks, [{ event: 'issues.labeled', filter: { labels: ['ready-to-build', 'maintainer-approved'] } }])
})

for (const [name, content] of [['not JSON', '{'], ['not an object', '[]'], ['a string flag', { authorFilter: 'yes', labelFilter: true }], ['a missing flag', { authorFilter: true }]]) {
  test(`a malformed K2 file (${name}) exits 1`, () => {
    const r = spec('alfhen/pipeline-dogfood', settings({}), ['--k2', k2File(content)])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /K2 file/)
  })
}

test('a missing K2 file exits 1', () => {
  assert.equal(spec('alfhen/pipeline-dogfood', settings({}), ['--k2', join(tmp, 'nope.json')]).status, 1)
})

test('the prompt is prompt.md with the repo and the kind put in', () => {
  const text = readFileSync(join(root, 'routine/cloud/prompt.md'), 'utf8')
  assert.match(text, /<repo>/); assert.match(text, /<kind>/)
  const r = spec('alfhen/pipeline-dogfood', settings({}))
  for (const rt of r.json.routines) {
    const kind = rt.name.split('-').pop()
    assert.equal(rt.prompt, text.replaceAll('<repo>', 'alfhen/pipeline-dogfood').replaceAll('<kind>', kind))
    assert.doesNotMatch(rt.prompt, /<repo>|<kind>/)
  }
})

test('the prompt skips put env-stale when PIN or ROOT is none', () => {
  const text = readFileSync(join(root, 'routine/cloud/prompt.md'), 'utf8')
  assert.match(text, /neither PIN nor ROOT is `none`/)
})

test('the setup script holds the pin, and --tags adds a second tag after it', () => {
  const one = spec('alfhen/pipeline-dogfood', settings({}))
  assert.match(one.json.setupScript, /v0\.8\.0/)
  assert.doesNotMatch(one.json.setupScript, /v0\.8\.1/)
  const two = spec('alfhen/pipeline-dogfood', settings({}), ['--tags', 'v0.8.1'])
  const s = two.json.setupScript
  assert.ok(s.indexOf('v0.8.0') >= 0 && s.indexOf('v0.8.1') > s.indexOf('v0.8.0'))
})

test('the setup script fetches the release list from main and still holds the pin', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({ pipelineVersion: 'v0.8.2' }), ['--tags', 'v0.8.1'])
  const s = r.json.setupScript
  assert.match(s, /refs\/heads\/main\/\.claude-plugin\/releases\.txt/)
  assert.match(s, /^NAMED="v0\.8\.2 v0\.8\.1"$/m)
})

test('the pin is not repeated when --tags names it', () => {
  const a = spec('alfhen/pipeline-dogfood', settings({}))
  const b = spec('alfhen/pipeline-dogfood', settings({}), ['--tags', 'v0.8.0'])
  assert.equal(a.json.setupScript, b.json.setupScript)
})

test('the pin of the settings comes through when --tags lists another release only', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({ pipelineVersion: 'v0.8.2' }), ['--tags', 'v0.8.1'])
  assert.match(r.json.setupScript, /v0\.8\.2/)
})

test('a bad tag is refused', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({}), ['--tags', 'main'])
  assert.notEqual(r.status, 0)
})

test('the output depends on the settings only: the full good file works', () => {
  const r = spec('alfhen/agent-pr-pipeline', good, ['--k2', k2File(BOTH)])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.json.routines[2].sources, ['alfhen/agent-pr-pipeline', 'alfhen/tagreeve'])
})

test('the output holds no token', () => {
  const r = spec('alfhen/pipeline-dogfood', settings({}), [])
  assert.doesNotMatch(r.stdout, /ghp_|github_pat_|sk-ant-|GH_TOKEN/)
})

test('the skill says the maintainer pastes the setup script and deletes in the web UI', () => {
  const skill = readFileSync(join(root, 'skills/cloud-routines/SKILL.md'), 'utf8')
  assert.match(skill, /pastes the `setupScript` field in the web UI/)
  assert.match(skill, /RemoteTrigger cannot delete a routine/)
  assert.match(skill, /routine-paused/)
  assert.match(skill, /`\/schedule` does not work inside a cloud session/)
  assert.match(skill, /routine-state\.sh" <owner\/repo> init/)
  assert.match(skill, /git_repository/)
  assert.match(skill, /environment_id/)
})

test('every routine carries the tools the prompts call, and the skill passes them on', () => {
  const r = spec('alfhen/agent-pr-pipeline', settings({}), ['--k2', k2File(BOTH)])
  for (const x of r.json.routines) {
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'PushNotification', 'Agent', 'Workflow', 'ToolSearch', 'Skill']) assert.ok(x.allowedTools.includes(t), `${x.name} lacks ${t}`)
  }
  const skill = readFileSync(join(root, 'skills/cloud-routines/SKILL.md'), 'utf8')
  assert.match(skill, /`allowedTools`/)
  assert.match(skill, /ToolSearch and Skill/)
})
