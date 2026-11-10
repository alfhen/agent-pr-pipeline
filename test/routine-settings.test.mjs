// Runs routine/config.jq on a whole .github/pipeline.json. The 0.7.0 form is covered by test/routine-state.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const good = JSON.parse(readFileSync(new URL('./fixtures/settings/good.json', import.meta.url), 'utf8'))
const minimal = { pipelineVersion: 'v0.8.0', maintainer: 'alfhen', waveArgs: { goals: 'g', checks: [] } }
const run = (input, ...args) => spawnSync('jq', ['-c', '--arg', 'form', 'pipeline', ...args, '-f', `${root}routine/config.jq`], { input: JSON.stringify(input), encoding: 'utf8' })
const withRoutine = routine => ({ gates: [], routine })
const check = (name, routine, re) => {
  test(`refuses ${name} with one line`, () => {
    const r = run(withRoutine(routine))
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, re)
    assert.equal(r.stderr.trim().split('\n').length, 1)
  })
}

test('a full good file prints the routine with defaults filled', () => {
  const r = run(good)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout).routine
  assert.equal(out.stage, 1)
  assert.deepEqual(out.trustedAuthors, ['alfhen', 'helper'])
  assert.deepEqual(out.skipLabels, ['wontfix', 'pipeline-routine', 'pipeline-ledger'])
  assert.deepEqual(out.typeLabels, { bug: 'type:bug', feat: 'feat', docs: 'docs', chore: 'chore', test: 'test' })
  assert.deepEqual(out.limits, { openPRs: 5, wavesPerDay: 2, buildAttempts: 2, buildHours: 12, triagePerRun: 5, triagePerDay: 20, feedbackItems: 3, feedbackPerDay: 6 })
  assert.deepEqual(out.collectFrom, ['alfhen/tagreeve'])
})

test('a minimal routine gets every default', () => {
  const out = JSON.parse(run(withRoutine(minimal)).stdout).routine
  assert.equal(out.stage, 0)
  assert.equal(out.triageFrom, 1)
  assert.deepEqual(out.trustedAuthors, ['alfhen'])
  assert.deepEqual(out.skipLabels, ['review-minor', 'pipeline-routine', 'pipeline-ledger'])
  assert.equal(out.feedbackRepo, 'alfhen/agent-pr-pipeline')
  assert.equal(out.limits.triagePerDay, 20)
})

test('trustedAuthors always holds the maintainer', () => {
  const out = JSON.parse(run(withRoutine({ ...minimal, trustedAuthors: ['helper'] })).stdout).routine
  assert.deepEqual(out.trustedAuthors, ['alfhen', 'helper'])
  const again = JSON.parse(run(withRoutine({ ...minimal, trustedAuthors: ['alfhen', 'alfhen'] })).stdout).routine
  assert.deepEqual(again.trustedAuthors, ['alfhen'])
})

test('no routine key prints null routine and exits 0', () => {
  const r = run({ gates: [], autoRelease: true })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { routine: null })
})

for (const key of ['repo', 'tmp', 'pluginRoot', 'agentPrefix', 'prs', 'plan', 'feedback', 'feedbackRepo', 'resumeFromRunId', 'cleanup']) {
  test(`refuses waveArgs.${key}`, () => {
    const routine = { ...minimal, waveArgs: { ...minimal.waveArgs, [key]: 'x' } }
    assert.ok(key in routine.waveArgs)
    const r = run(withRoutine(routine))
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, new RegExp(`waveArgs.${key} is not allowed`))
  })
}

for (const key of ['e2ePattern', 'e2eCommand', 'relatedTests', 'docs', 'docsBuild', 'bots', 'botWaitMinutes', 'architecture', 'spec', 'context', 'skills', 'steps', 'qa', 'maxRounds']) {
  test(`allows waveArgs.${key}`, () => {
    const r = run(withRoutine({ ...minimal, waveArgs: { ...minimal.waveArgs, [key]: 'x' } }))
    assert.equal(r.status, 0, r.stderr)
  })
}

check('stage 2', { ...minimal, stage: 2 }, /stage 2 needs a later release/)
check('stage 4', { ...minimal, stage: 4 }, /stage 4 needs a later release/)
check('stage 5', { ...minimal, stage: 5 }, /stage/)
check('pipelineVersion 0.8.0', { ...minimal, pipelineVersion: '0.8.0' }, /pipelineVersion/)
check('pipelineVersion v0.8', { ...minimal, pipelineVersion: 'v0.8' }, /pipelineVersion/)
check('pipelineVersion main', { ...minimal, pipelineVersion: 'main' }, /pipelineVersion/)
check('pipelineVersion with a trailing newline', { ...minimal, pipelineVersion: 'v0.8.0\n' }, /pipelineVersion/)
check('maintainer with a trailing newline', { ...minimal, maintainer: 'alfhen\n' }, /maintainer/)
check('feedbackRepo with a trailing newline', { ...minimal, feedbackRepo: 'a/b\n' }, /feedbackRepo/)
check('no pipelineVersion',{ maintainer: 'alfhen', waveArgs: minimal.waveArgs }, /pipelineVersion/)
check('a bot in trustedAuthors', { ...minimal, trustedAuthors: ['claude[bot]'] }, /trustedAuthors must not hold a bot/)
check('a limit of 21', { ...minimal, limits: { openPRs: 21 } }, /openPRs/)
check('buildHours 0', { ...minimal, limits: { buildHours: 0 } }, /buildHours/)
check('buildHours 49', { ...minimal, limits: { buildHours: 49 } }, /buildHours/)
check('feedbackItems 4', { ...minimal, limits: { feedbackItems: 4 } }, /feedbackItems/)
check('a limit that is null', { ...minimal, limits: { triagePerDay: null } }, /triagePerDay/)
check('an unknown limit', { ...minimal, limits: { nope: 1 } }, /unknown limit nope/)
check('no maintainer', { pipelineVersion: 'v0.8.0', waveArgs: minimal.waveArgs }, /maintainer/)
check('a bot as maintainer', { ...minimal, maintainer: 'x[bot]' }, /maintainer/)
check('an unknown key', { ...minimal, extra: 1 }, /unknown key extra/)
check('an unknown typeLabels key', { ...minimal, typeLabels: { fix: 'x' } }, /typeLabels key fix/)
check('a feedbackRepo that is not owner/repo', { ...minimal, feedbackRepo: 'x' }, /feedbackRepo/)
check('an unknown waveArgs key', { ...minimal, waveArgs: { ...minimal.waveArgs, nope: 1 } }, /unknown waveArgs key nope/)
check('no goals', { ...minimal, waveArgs: { checks: [] } }, /goals/)

test('-n prints the defaults of both forms and the fixed labels', () => {
  const r = spawnSync('jq', ['-nc', '-f', `${root}routine/config.jq`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(out.limits, { openPRs: 3, wavesPerDay: 2, buildIssues: 3, maxRunMinutes: 240 })
  assert.equal(out.routine.limits.buildHours, 6)
  assert.deepEqual(out.labels, ['ready-to-build', 'needs-approval', 'maintainer-approved', 'declined', 'building', 'build-failed', 'needs-plan', 'needs-maintainer', 'untrusted-author', 'routine-paused', 'size:S', 'size:M', 'size:L'])
})

test('the 0.7.0 form still works beside the new one', () => {
  const r = spawnSync('jq', ['-c', '-f', `${root}routine/config.jq`], { input: JSON.stringify({ waveArgs: { goals: 'g', checks: [] } }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).limits, { openPRs: 3, wavesPerDay: 2, buildIssues: 3, maxRunMinutes: 240 })
})

test('without --arg form pipeline, a routine.json holding gates is refused as before', () => {
  const r = spawnSync('jq', ['-c', '-f', `${root}routine/config.jq`], { input: JSON.stringify({ gates: [], waveArgs: { goals: 'g', checks: [] } }), encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /routine\.json: unknown key gates/)
})

for (const f of ['stage', 'trustedAuthors', 'triageFrom', 'skipLabels', 'typeLabels', 'feedbackRepo', 'collectFrom', 'limits']) {
  check(`${f} set to false`, { ...minimal, [f]: false }, new RegExp(f))
}
check('a typeLabels value that is a state label', { ...minimal, typeLabels: { bug: 'ready-to-build' } }, /typeLabels values must not be a fixed label/)
check('a typeLabels value that is the routine label', { ...minimal, typeLabels: { feat: 'pipeline-routine' } }, /typeLabels values must not be a fixed label/)
check('L01-12 a typeLabels value that is the ledger label', { ...minimal, typeLabels: { feat: 'pipeline-ledger' } }, /typeLabels values must not be a fixed label/)

test('a null optional key counts as not set', () => {
  const r = run(withRoutine({ ...minimal, stage: null, trustedAuthors: null, triageFrom: null, skipLabels: null, typeLabels: null, feedbackRepo: null, collectFrom: null, limits: null }))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(run(withRoutine(minimal)).stdout))
})

// Every run-wave.js argument is refused, allowed, or named here as left out on purpose.
const runtimeOnly = ['resumeFromRunId']
const leftOut =['docsUpdate', 'milestone', 'minorLabel', 'securitySkill', 'planRounds', 'docsRounds', 'botCheckRounds', 'productReview', 'architectureReview', 'evals', 'evalsRounds', 'breakCheck']
test('the waveArgs lists of config.jq match the arguments of run-wave.js', () => {
  const jq = readFileSync(`${root}routine/config.jq`, 'utf8')
  const list = name => JSON.parse(jq.match(new RegExp(`def ${name}: (\\[.*?\\]);`))[1])
  const real = new Set([...readFileSync(`${root}workflows/run-wave.js`, 'utf8').matchAll(/\bA\.([A-Za-z0-9_]+)/g)].map(m => m[1]))
  const listed = [...list('refusedWave'), ...list('allowedWave')]
  assert.deepEqual(listed.filter(n => !real.has(n) && !runtimeOnly.includes(n)), [], 'listed but not an argument of run-wave.js')
  assert.deepEqual([...real].filter(n => !listed.includes(n) && !leftOut.includes(n)).sort(), [], 'new run-wave.js argument: refuse it, allow it or add it to leftOut')
  assert.deepEqual(leftOut.filter(n => !real.has(n) || listed.includes(n)), [], 'leftOut holds a name that is listed or gone')
})
