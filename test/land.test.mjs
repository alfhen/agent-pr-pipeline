// Runs land-wave.sh (known flakes), check-version.sh and the gates for routine/** on fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const FX = join(root, 'test/fixtures/land')
const SHA = 'a'.repeat(40)
const P = 'repos__o__r'
const PULL = `${P}__pulls__7`
const CONTENTS = `${P}__contents__.github__pipeline.json`
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))
const fixture = (name) => readFileSync(join(FX, name), 'utf8')

const run = (s, script, args, env = {}, scripts = join(root, 'scripts')) => {
  const e = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, PIPELINE_TEST_FAST: '1', ...env }
  delete e.CLAUDECODE
  const r = spawnSync('bash', [join(scripts, script), ...args], { env: e, encoding: 'utf8' })
  const log = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  return { code: r.status, out: r.stdout + r.stderr, log }
}
const reruns = (r) => r.log.filter((l) => /^POST .*rerun-failed-jobs/.test(l))

const base = () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  put(fx, `${P}.json`, { default_branch: 'main' })
  return { dir, bin, fx, log: join(dir, 'log') }
}

const failed = (name, runId = 55) => ({ name, status: 'completed', conclusion: 'failure', details_url: `https://github.com/o/r/actions/runs/${runId}/job/9` })
const passed = (name) => ({ name, status: 'completed', conclusion: 'success' })

// checks: one check-run list per read of the check-runs path (the last repeats).
const landSetup = ({ checks, settings = 'flake', onHead = null, attempt = 1 }) => {
  const s = base()
  const { fx } = s
  put(fx, `${PULL}.json`, { merged: false, mergeable: true, head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } } })
  put(fx, 'pull-merged.json', { merged: true, head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } } })
  put(fx, `${PULL}__merge.PUT.then`, `pull-merged.json ${PULL}.json\n`)
  put(fx, `${PULL}__merge.PUT.json`, { merged: true })
  checks.forEach((c, i) => put(fx, `${P}__commits__${SHA}__check-runs.call${i + 1}.json`, { check_runs: c }))
  put(fx, `${P}__commits__${SHA}__status.json`, { state: 'success', statuses: [] })
  put(fx, `${P}__actions__runs__55.json`, { run_attempt: attempt })
  put(fx, `${CONTENTS}@ref=refs__heads__main.json`, fixture(`pipeline-${settings}.json`))
  if (onHead) put(fx, `${CONTENTS}@ref=${SHA}.json`, fixture(`pipeline-${onHead}.json`))
  put(fx, `${PULL}__reviews.json`, [{ id: 1, user: { login: 'gitar-bot[bot]' }, state: 'APPROVED', body: '', commit_id: SHA, submitted_at: '2026-01-01T10:00:00Z' }])
  put(fx, `${PULL}__comments.json`, [])
  put(fx, `${P}__issues__7__comments.json`, [])
  put(fx, `${P}__commits__${SHA}__check-suites.json`, { total_count: 0, check_suites: [] })
  put(fx, 'user.json', { login: 'alfhen' })
  return s
}
const land = (s) => run(s, 'land-wave.sh', ['o/r', `7:${SHA}`])

test('land: one check-runs read that returns an error body does not end the wait', () => {
  const s = landSetup({ checks: [[{ name: 'ci', status: 'in_progress', conclusion: null }], [passed('ci')]] })
  put(s.fx, `${P}__commits__${SHA}__check-runs.call2.json`, { message: 'Server Error' })
  put(s.fx, `${P}__commits__${SHA}__check-runs.call3.json`, { check_runs: [passed('ci')] })
  const r = land(s)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all merged/)
  assert.equal(r.log.filter((l) => /^PUT .*pulls\/7\/merge/.test(l)).length, 1)
})

test('land: a known flake that passes after one rerun merges', () => {
  const r = land(landSetup({ checks: [[failed('e2e')], [failed('e2e')], [passed('e2e')]] }))
  assert.equal(r.code, 0, r.out)
  assert.equal(reruns(r).length, 1)
  assert.match(r.out, /all merged/)
  assert.equal(r.log.filter((l) => /^PUT .*\/pulls\/7\/merge/.test(l)).length, 1)
})

test('land: a head that moves during the rerun wait stops with HEAD MOVED', () => {
  const s = landSetup({ checks: [[failed('e2e')], [failed('e2e')], [passed('e2e')]] })
  const NEW = 'b'.repeat(40)
  const pull = (sha) => ({ merged: false, mergeable: true, head: { sha, ref: 'feat/x', repo: { full_name: 'o/r' } } })
  put(s.fx, `${PULL}.call1.json`, pull(SHA))
  put(s.fx, `${PULL}.call2.json`, pull(SHA))
  put(s.fx, `${PULL}.call3.json`, pull(SHA))
  put(s.fx, `${PULL}.call4.json`, pull(NEW))
  put(s.fx, `${P}__commits__${NEW}__check-runs.json`, { check_runs: [passed('e2e')] })
  put(s.fx, `${P}__commits__${NEW}__status.json`, { state: 'success', statuses: [] })
  const r = land(s)
  assert.equal(r.code, 6, r.out)
  assert.match(r.out, /HEAD MOVED #7: checked aaaaaaa, now bbbbbbb/)
  assert.equal(reruns(r).length, 1)
  assert.equal(r.log.filter((l) => /^PUT .*\/pulls\/7\/merge/.test(l)).length, 0)
})

test('land: a known flake that fails again stops with LAND FIX after one rerun', () => {
  const r = land(landSetup({ checks: [[failed('e2e')]] }))
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /LAND FIX #7 .*failing=\[e2e\]/)
  assert.equal(reruns(r).length, 1)
})

test('land: a failing check that is not in the list is not rerun', () => {
  const r = land(landSetup({ checks: [[failed('lint', 56)]] }))
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /failing=\[lint\]/)
  assert.equal(reruns(r).length, 0)
})

test('land: one known flake and one other failure are not rerun', () => {
  const r = land(landSetup({ checks: [[failed('e2e'), failed('lint', 56)]] }))
  assert.equal(r.code, 3, r.out)
  assert.equal(reruns(r).length, 0)
})

test('land: a list that exists only on the PR head is not used', () => {
  const s = landSetup({ checks: [[failed('e2e')]], settings: 'none', onHead: 'flake' })
  assert.deepEqual(JSON.parse(readFileSync(join(s.fx, `${CONTENTS}@ref=${SHA}.json`), 'utf8')).knownFlakes, ['e2e'])
  assert.deepEqual(JSON.parse(readFileSync(join(s.fx, `${CONTENTS}@ref=refs__heads__main.json`), 'utf8')).knownFlakes, [])
  const r = land(s)
  assert.equal(r.code, 3, r.out)
  assert.equal(reruns(r).length, 0)
  assert.equal(r.log.some((l) => l.includes(`ref=${SHA}`)), false)
})

test('land: a head that was rerun before is not rerun again', () => {
  const r = land(landSetup({ checks: [[failed('e2e')]], attempt: 2 }))
  assert.equal(r.code, 3, r.out)
  assert.equal(reruns(r).length, 0)
})

test('land: a repo with no settings file has no known flakes', () => {
  const s = landSetup({ checks: [[failed('e2e')]] })
  rmSync(join(s.fx, `${CONTENTS}@ref=refs__heads__main.json`))
  const r = land(s)
  assert.equal(r.code, 3, r.out)
  assert.equal(reruns(r).length, 0)
})

test('land: a repo with no settings file takes its known flakes from the template next to the scripts', () => {
  const s = landSetup({ checks: [[failed('e2e')], [failed('e2e')], [passed('e2e')]] })
  rmSync(join(s.fx, `${CONTENTS}@ref=refs__heads__main.json`))
  const copy = join(s.dir, 'plugin')
  cpSync(join(root, 'scripts'), join(copy, 'scripts'), { recursive: true })
  mkdirSync(join(copy, 'templates'))
  writeFileSync(join(copy, 'templates/pipeline.json'), JSON.stringify({ gates: [], knownFlakes: ['e2e'], autoRelease: false }))
  const r = run(s, 'land-wave.sh', ['o/r', `7:${SHA}`], {}, join(copy, 'scripts'))
  assert.equal(r.code, 0, r.out)
  assert.equal(reruns(r).length, 1)
})

const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}
const manifest = (dir, version) => {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'x', version }))
}
const versionRepo = (baseVersion = '0.3.0') => {
  const dir = mkdtempSync(join(tmpdir(), 'version-test-'))
  git(dir, 'init', '-q', '-b', 'main')
  manifest(dir, baseVersion)
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'tag', 'v0.3.0')
  git(dir, 'branch', 'base')
  return dir
}
const check = (dir, version, env = {}) => {
  manifest(dir, version)
  const e = { ...process.env }
  delete e.BASE_REF
  const r = spawnSync('bash', [join(root, 'scripts/check-version.sh')], { cwd: dir, env: { ...e, ...env }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

for (const v of ['bad', '0.4', '', '1.2.3.4', 'v0.4.0']) {
  test(`version: "${v}" is not a semantic version`, () => {
    const r = check(versionRepo(), v)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /not MAJOR\.MINOR\.PATCH/)
  })
}

for (const v of ['0.4.0', '0.4.0-rc.1']) {
  test(`version: ${v} is accepted`, () => {
    const r = check(versionRepo(), v)
    assert.equal(r.code, 0, r.out)
  })
}

test('version: a changed version lower than the latest tag fails on a pull request', () => {
  const r = check(versionRepo(), '0.2.9', { BASE_REF: 'base' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not higher than the latest tag v0\.3\.0/)
})

test('version: the same version as the latest tag fails when it changed', () => {
  const r = check(versionRepo('0.3.1'), '0.3.0', { BASE_REF: 'base' })
  assert.equal(r.code, 1, r.out)
})

test('version: a pre-release of the tagged version is lower than the tag', () => {
  const r = check(versionRepo(), '0.3.0-rc.1', { BASE_REF: 'base' })
  assert.equal(r.code, 1, r.out)
})

test('version: a higher version passes on a pull request', () => {
  const r = check(versionRepo(), '0.4.0', { BASE_REF: 'base' })
  assert.equal(r.code, 0, r.out)
})

test('version: an unchanged version passes even when it equals the tag', () => {
  const r = check(versionRepo(), '0.3.0', { BASE_REF: 'base' })
  assert.equal(r.code, 0, r.out)
})

test('gate: routine/run.sh and routine/bin/gh are held by the repo gates', () => {
  const s = base()
  put(s.fx, `${CONTENTS}@ref=refs__heads__main.json`, readFileSync(join(root, '.github/pipeline.json'), 'utf8'))
  put(s.fx, `${PULL}__files.json`, fixture('routine-files.json'))
  const r = run(s, 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /routine\/bin\/gh/)
  assert.match(r.out, /routine\/run\.sh/)
})

test('gate: the CodeRabbit settings files are held by the repo gates', () => {
  for (const name of ['.coderabbit.yaml', '.coderabbit.yml', '.coderabbit.config.ts']) {
    const s = base()
    put(s.fx, `${CONTENTS}@ref=refs__heads__main.json`, readFileSync(join(root, '.github/pipeline.json'), 'utf8'))
    put(s.fx, `${PULL}__files.json`, [{ filename: name, status: 'modified' }])
    const r = run(s, 'gate-files.sh', ['o/r', '7'])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(`GATED #7: ${name}`), r.out)
  }
})

const checkReads = (r) => r.log.filter((l) => /^GET .*check-runs/.test(l)).length

test('land: a head with no check runs yet is waited for, then merges', () => {
  const r = land(landSetup({ checks: [[], [passed('ci')]] }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all merged/)
  const put = r.log.findIndex((l) => /^PUT .*pulls\/7\/merge/.test(l))
  assert.ok(put > 0, r.log.join('\n'))
  assert.equal(checkReads({ log: r.log.slice(0, put) }), 4)
})

test('land: a head that never gets check runs is WAITING, not merged', () => {
  const r = land(landSetup({ checks: [[]] }))
  assert.equal(r.code, 4, r.out)
  assert.match(r.out, /WAITING #7/)
  assert.equal(r.log.filter((l) => /^PUT .*pulls\/7\/merge/.test(l)).length, 0)
})

test('land: a failed commit status with no check runs yet ends the wait at once', () => {
  const s = landSetup({ checks: [[]] })
  put(s.fx, `${P}__commits__${SHA}__status.json`, { state: 'failure', statuses: [{ context: 'ext/ci', state: 'failure' }] })
  const r = land(s)
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /LAND FIX #7 .*failing=\[ext\/ci\]/)
  assert.equal(checkReads(r), 2)
})

test('land: a head that moved before the first poll ends the wait without reading its checks', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  const NEW = 'b'.repeat(40)
  put(s.fx, `${PULL}.json`, { merged: false, mergeable: true, head: { sha: NEW, ref: 'feat/x', repo: { full_name: 'o/r' } } })
  put(s.fx, `${P}__commits__${NEW}__check-runs.json`, { check_runs: [{ name: 'ci', status: 'in_progress', conclusion: null }] })
  const r = land(s)
  assert.equal(r.code, 6, r.out)
  assert.match(r.out, /HEAD MOVED #7/)
  assert.equal(r.log.filter((l) => l.includes(`commits/${NEW}/check-runs`)).length, 0)
})

test('land: after a rerun the script waits until GitHub lists the new attempt', () => {
  const s = landSetup({ checks: [[failed('e2e')], [failed('e2e')], [passed('e2e')]] })
  const runPath = `${P}__actions__runs__55`
  rmSync(join(s.fx, `${runPath}.json`))
  put(s.fx, `${runPath}.call1.json`, { run_attempt: 1, status: 'completed' })
  put(s.fx, `${runPath}.call2.json`, { run_attempt: 1, status: 'completed' })
  put(s.fx, `${runPath}.call3.json`, { run_attempt: 2, status: 'in_progress' })
  const r = land(s)
  assert.equal(r.code, 0, r.out)
  assert.equal(r.log.filter((l) => l === 'GET /repos/o/r/actions/runs/55').length, 3)
})

test('land: a rerun that never shows a new attempt stops the wave, not LAND FIX', () => {
  const s = landSetup({ checks: [[failed('e2e')], [failed('e2e')]] })
  const runPath = `${P}__actions__runs__55`
  rmSync(join(s.fx, `${runPath}.json`))
  put(s.fx, `${runPath}.json`, { run_attempt: 1, status: 'completed' })
  const r = land(s)
  assert.equal(r.code, 5, r.out)
  assert.match(r.out, /did not show a new attempt/)
  assert.doesNotMatch(r.out, /LAND FIX/)
})

test('land: check runs with large payloads are read and merged', () => {
  const big = (i) => ({ ...passed(`ci${i}`), output: { text: 'x'.repeat(3000) } })
  const r = land(landSetup({ checks: [Array.from({ length: 100 }, (_, i) => big(i))] }))
  assert.equal(r.code, 0, r.out)
})

test('merge-pr: the squash request carries exactly the PR title and body', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  const pull = JSON.parse(readFileSync(join(s.fx, `${PULL}.json`), 'utf8'))
  const body = 'Adds the thing.\n\nCloses #504\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_'
  put(s.fx, `${PULL}.json`, { ...pull, title: 'Use the PR text', body })
  const r = run(s, 'merge-pr.sh', ['--person', 'o/r', '7', SHA, 'feat/x'])
  assert.equal(r.code, 0, r.out)
  const call = r.log.find((l) => /^PUT .*pulls\/7\/merge/.test(l))
  assert.match(call, / commit_title=Use the PR text \(#7\) commit_message=/)
  assert.match(call, /commit_message=Adds the thing\.\\n\\nCloses #504$/)
  assert.doesNotMatch(call, /Generated by/)
})

test('merge-pr: a Closes line removed from the PR body after the first read is not sent', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  const pull = JSON.parse(readFileSync(join(s.fx, `${PULL}.json`), 'utf8'))
  put(s.fx, `${PULL}.call1.json`, { ...pull, title: 'T', body: 'Adds it.\n\nCloses #504' })
  put(s.fx, `${PULL}.call2.json`, { ...pull, title: 'T', body: 'Adds it.' })
  put(s.fx, `${PULL}.call3.json`, { merged: true, head: pull.head })
  const r = run(s, 'merge-pr.sh', ['--person', 'o/r', '7', SHA, 'feat/x'])
  assert.equal(r.code, 0, r.out)
  const call = r.log.find((l) => /^PUT .*pulls\/7\/merge/.test(l))
  assert.match(call, /commit_message=Adds it\.$/)
})

test('merge-pr: the Claude footer is removed when other text follows it', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  const pull = JSON.parse(readFileSync(join(s.fx, `${PULL}.json`), 'utf8'))
  const body = 'Adds it.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n\n<!-- review summary -->\nNotes'
  put(s.fx, `${PULL}.json`, { ...pull, title: 'T', body })
  const r = run(s, 'merge-pr.sh', ['--person', 'o/r', '7', SHA, 'feat/x'])
  assert.equal(r.code, 0, r.out)
  const call = r.log.find((l) => /^PUT .*pulls\/7\/merge/.test(l))
  assert.doesNotMatch(call, /Generated by/)
  assert.match(call, /Adds it\.\\n\\n<!-- review summary -->\\nNotes$/)
})

test('merge-pr: a Closes line that is only in a branch commit is not sent', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  const pull = JSON.parse(readFileSync(join(s.fx, `${PULL}.json`), 'utf8'))
  put(s.fx, `${PULL}.json`, { ...pull, title: 'T', body: 'Adds it.' })
  put(s.fx, `${PULL}__commits.json`, [{ sha: 'c1', commit: { message: 'old work\n\nCloses #999' } }])
  const r = run(s, 'merge-pr.sh', ['--person', 'o/r', '7', SHA, 'feat/x'])
  assert.equal(r.code, 0, r.out)
  const call = r.log.find((l) => /^PUT .*pulls\/7\/merge/.test(l))
  assert.match(call, /commit_message=Adds it\.$/)
  assert.doesNotMatch(call, /999/)
})

test('land: the known flakes are read with a full branch ref', () => {
  const r = land(landSetup({ checks: [[failed('e2e')], [failed('e2e')], [passed('e2e')]] }))
  assert.ok(r.log.includes('GET /repos/o/r/contents/.github/pipeline.json?ref=refs/heads/main'), r.log.join('\n'))
  assert.equal(r.log.some((l) => /\?ref=main$/.test(l)), false)
})

test('land: a bad argument after a valid one stops the run before any gh call', () => {
  const s = landSetup({ checks: [[passed('e2e')]] })
  for (const [bad, text] of [[`8:aaaaaaa:auto`, /need the full 40-character commit id in 8:aaaaaaa:auto/], [`8:${SHA}:bogus`, /need <pr>:<sha> or <pr>:<sha>:auto/], [`x:${SHA}:auto`, /need a PR number in x:/]]) {
    const r = run(s, 'land-wave.sh', ['o/r', `7:${SHA}:auto`, bad])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, text)
    assert.equal(r.log.length, 0)
  }
})

test('land: a short commit id is refused before any wait or merge', () => {
  const s = landSetup({ checks: [[passed('e2e')]] })
  for (const arg of ['7:aaaaaaa', `7:${SHA.slice(0, 39)}:auto`, '7:' + 'A'.repeat(40)]) {
    const r = run(s, 'land-wave.sh', ['o/r', arg])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /need the full 40-character commit id/)
    assert.equal(r.log.length, 0)
  }
})

const S8 = 'c'.repeat(40)
const head = (sha, ref = 'feat/x') => ({ head: { sha, ref, repo: { full_name: 'o/r' } } })
const addPair8 = (s) => {
  const { fx } = s
  put(fx, `${P}__pulls__8.json`, { merged: false, state: 'open', mergeable: true, ...head(S8, 'feat/8') })
  put(fx, 'pull-merged-8.json', { merged: true, state: 'closed', ...head(S8, 'feat/8') })
  put(fx, `${P}__pulls__8__merge.PUT.then`, `pull-merged-8.json ${P}__pulls__8.json\n`)
  put(fx, `${P}__pulls__8__merge.PUT.json`, { merged: true })
  put(fx, `${P}__commits__${S8}__check-runs.json`, { check_runs: [passed('ci')] })
  put(fx, `${P}__commits__${S8}__status.json`, { state: 'success', statuses: [] })
  put(fx, `${P}__pulls__8__reviews.json`, [{ id: 2, user: { login: 'gitar-bot[bot]' }, state: 'APPROVED', body: '', commit_id: S8, submitted_at: '2026-01-01T10:00:00Z' }])
  put(fx, `${P}__pulls__8__comments.json`, [])
  put(fx, `${P}__issues__8__comments.json`, [])
  put(fx, `${P}__commits__${S8}__check-suites.json`, { total_count: 0, check_suites: [] })
}
const lines = (r, re) => r.log.filter((l) => re.test(l))
const outLines = (r, re) => r.out.split('\n').filter((l) => re.test(l))

test('land: a merged pull is passed over and the next pair lands', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  put(s.fx, `${PULL}.json`, { merged: true, state: 'closed', mergeable: true, ...head(SHA) })
  addPair8(s)
  const r = run(s, 'land-wave.sh', ['o/r', `7:${SHA}`, `8:${S8}`])
  assert.equal(r.code, 0, r.out)
  assert.equal(outLines(r, /^MERGED #7 already/).length, 1)
  assert.equal(lines(r, new RegExp(`/commits/${SHA}/`)).length, 0)
  assert.equal(lines(r, /^PUT \/repos\/o\/r\/pulls\/7\/merge/).length, 0)
  const put8 = r.log.findIndex((l) => l.startsWith('PUT /repos/o/r/pulls/8/merge'))
  const last7 = r.log.map((l, i) => (l.startsWith('GET /repos/o/r/pulls/7') ? i : -1)).filter((i) => i >= 0).pop()
  assert.ok(put8 > last7, r.log.join('\n'))
  assert.equal(lines(r, /^PUT \/repos\/o\/r\/pulls\/8\/merge/).length, 1)
  assert.match(r.out.trim().split('\n').pop(), /^all merged$/)
})

test('land: when every pair is already merged the run ends with all merged', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  put(s.fx, `${PULL}.json`, { merged: true, state: 'closed', mergeable: null, ...head(SHA) })
  put(s.fx, `${P}__pulls__8.json`, { merged: true, state: 'closed', mergeable: null, ...head(S8, 'feat/8') })
  const r = run(s, 'land-wave.sh', ['o/r', `7:${SHA}`, `8:${S8}`])
  assert.equal(r.code, 0, r.out)
  assert.equal(outLines(r, /^MERGED #7 already/).length, 1)
  assert.equal(outLines(r, /^MERGED #8 already/).length, 1)
  assert.equal(r.out.trim().split('\n').pop(), 'all merged')
  assert.equal(lines(r, /^PUT /).length, 0)
})

test('land: a pull merged at another head stops with exit 5', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  put(s.fx, `${PULL}.json`, { merged: true, state: 'closed', mergeable: null, ...head('b'.repeat(40)) })
  const r = land(s)
  assert.equal(r.code, 5, r.out)
  const l = outLines(r, /^STOP #7: merged at/)
  assert.equal(l.length, 1)
  assert.match(l[0], /bbbbbbb/)
  assert.match(l[0], /aaaaaaa/)
  assert.equal(outLines(r, /^HEAD MOVED/).length, 0)
  assert.equal(lines(r, /^(PUT|DELETE|POST \/repos\/o\/r\/issues\/7\/comments)/).length, 0)
})

test('land: a closed pull that was not merged stops before CI', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  put(s.fx, `${PULL}.json`, { merged: false, state: 'closed', mergeable: null, ...head(SHA) })
  const r = land(s)
  assert.equal(r.code, 5, r.out)
  assert.equal(outLines(r, /^STOP #7: closed, not merged/).length, 1)
  assert.equal(lines(r, new RegExp(`/commits/${SHA}/`)).length, 0)
  assert.equal(lines(r, /^GET \/user/).length, 0)
  assert.equal(lines(r, /^PUT /).length, 0)
})

test('land: an already merged pull gets no merge record and no branch delete', () => {
  const pos = land(landSetup({ checks: [[passed('ci')]] }))
  assert.equal(pos.code, 0, pos.out)
  assert.equal(lines(pos, /^POST \/repos\/o\/r\/issues\/7\/comments.*pipeline:merge-cleared/).length, 1)
  assert.equal(lines(pos, /^DELETE \/repos\/o\/r\/git\/refs\/heads\/feat\/x/).length, 1)
  const s = landSetup({ checks: [[passed('ci')]] })
  put(s.fx, `${PULL}.json`, { merged: true, state: 'closed', mergeable: true, ...head(SHA) })
  const r = land(s)
  assert.equal(r.code, 0, r.out)
  assert.equal(outLines(r, /^MERGED #7 already/).length, 1)
  assert.equal(lines(r, /pipeline:merge-cleared/).length, 0)
  assert.equal(lines(r, /^DELETE/).length, 0)
  assert.equal(lines(r, /^PUT /).length, 0)
})

for (const withState of [true, false]) {
  test(`land: an open pull ${withState ? 'with' : 'without'} a state field waits for CI and merges`, () => {
    const s = landSetup({ checks: [[passed('ci')]] })
    if (withState) put(s.fx, `${PULL}.json`, { merged: false, state: 'open', mergeable: true, ...head(SHA) })
    const r = land(s)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /all merged/)
    assert.equal(outLines(r, /^MERGED #/).length, 0)
    const ci = r.log.findIndex((l) => l.includes(`/commits/${SHA}/check-runs`))
    const mi = r.log.findIndex((l) => l.startsWith('PUT /repos/o/r/pulls/7/merge'))
    assert.ok(ci >= 0 && mi > ci, r.log.join('\n'))
    assert.equal(lines(r, /^PUT \/repos\/o\/r\/pulls\/7\/merge/).length, 1)
  })
}

test('SKILL.md: Step 3 says to run the same land command again and the table names the new stops', () => {
  const t = readFileSync(join(root, 'skills/pr-pipeline/SKILL.md'), 'utf8').split('\n')
  const step3 = t.findIndex((l) => l.startsWith('## Step 3'))
  const para = t.slice(step3).find((l) => l.startsWith('The script waits for CI on each PR in order.'))
  const tail = para.split('The branch is deleted only after GitHub shows MERGED.')[1]
  assert.match(tail, /again/)
  assert.match(tail, /same/)
  const things = t.findIndex((l) => l.startsWith('## When things go wrong'))
  const fix = t.findIndex((l, i) => i > things && l.startsWith('| `LAND FIX'))
  const row = t[fix + 1]
  assert.ok(row.startsWith('|') && !row.startsWith('| `approved=[]`'), row)
  assert.match(row, /merged at/)
  assert.match(row, /closed, not merged/)
})

test('land: a hint with a 404 on the settings read is still no settings file', () => {
  const s = landSetup({ checks: [[failed('e2e')]] })
  rmSync(join(s.fx, `${CONTENTS}@ref=refs__heads__main.json`))
  const r = run(s, 'land-wave.sh', ['o/r', `7:${SHA}`], { FAKE_GH_HINT: 'pipeline.json' })
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /LAND FIX #7 .*failing=\[e2e\]/)
  assert.equal(reruns(r).length, 0)
})

test('land: a hint on the read of the settings does not change a known flake that passes after one rerun', () => {
  const checks = [[failed('e2e')], [failed('e2e')], [passed('e2e')]]
  const a = land(landSetup({ checks }))
  const b = run(landSetup({ checks }), 'land-wave.sh', ['o/r', `7:${SHA}`], { FAKE_GH_HINT: 'pipeline.json' })
  assert.equal(b.code, a.code, b.out)
  assert.equal(reruns(b).length, 1)
})

const loggedMktemp = (dir) => {
  const wrap = join(dir, 'wrap'); mkdirSync(wrap)
  const log = join(dir, 'mktemp.log')
  writeFileSync(join(wrap, 'mktemp'), '#!/bin/bash\np=$(PATH="$REAL_PATH" mktemp "$@") || exit $?\necho "$p" >> "$MKTEMP_LOG"\necho "$p"\n')
  chmodSync(join(wrap, 'mktemp'), 0o755)
  return { log, env: { PATH: `${wrap}:${process.env.PATH}`, REAL_PATH: process.env.PATH, MKTEMP_LOG: log } }
}
const assertTempRemoved = (log) => {
  const made = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  assert.ok(made.length > 0, 'the script made no temp file')
  for (const p of made) assert.equal(existsSync(p), false, p)
}

test('land: the temp file for stderr is removed after a normal and a LAND FIX exit', () => {
  for (const checks of [[[passed('e2e')]], [[failed('lint', 56)]]]) {
    const s = landSetup({ checks }); const m = loggedMktemp(s.dir)
    run(s, 'land-wave.sh', ['o/r', `7:${SHA}`], m.env)
    assertTempRemoved(m.log)
  }
})

// M06: the CI state of a head comes from scripts/ci-state.jq in land-wave.sh and merge-pr.sh.
const STATUS = `${P}__commits__${SHA}__status.json`
const CHECKS = `${P}__commits__${SHA}__check-runs`
const okStatus = { state: 'success', statuses: [{ context: 'ext/ci', state: 'success' }] }
const putCalls = (r) => r.log.filter((l) => /^PUT .*\/pulls\/7\/merge/.test(l))
const mergeRun = (s, scripts) => run(s, 'merge-pr.sh', ['--person', 'o/r', '7', SHA, 'feat/x'], {}, scripts)
const cancelled = (n) => ({ ...failed(n), conclusion: 'cancelled' })
const inProgress = { name: 'ci', status: 'in_progress', conclusion: null }
const stubCopy = () => {
  const copy = join(mkdtempSync(join(tmpdir(), 'land-stub-')), 'scripts')
  cpSync(join(root, 'scripts'), copy, { recursive: true })
  writeFileSync(join(copy, 'ci-state.jq'), '{state: "failure", failed: ["stub-check"], failedRuns: [{name: "stub-check", details_url: ""}], pending: [], noRuns: false}')
  return copy
}

test('land: zero check runs and only successful statuses stops after 2 polls with no check runs', () => {
  const s = landSetup({ checks: [[]] })
  put(s.fx, STATUS, okStatus)
  assert.deepEqual(JSON.parse(readFileSync(join(s.fx, `${CHECKS}.call1.json`), 'utf8')).check_runs, [])
  const r = land(s)
  assert.match(r.out, /STOP #7: no check runs/)
  assert.notEqual(r.code, 0)
  assert.notEqual(r.code, 4)
  assert.equal(putCalls(r).length, 0)
  assert.ok(checkReads(r) <= 3, r.log.join('\n'))
})

test('land: check runs that appear on the second poll of a statuses-only head merge', () => {
  const s = landSetup({ checks: [[], [passed('ci')]] })
  put(s.fx, STATUS, okStatus)
  const r = land(s)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all merged/)
})

test('land and wait-ci: one head with no check runs and green statuses is not ready in both', () => {
  const s = landSetup({ checks: [[]] })
  put(s.fx, STATUS, okStatus)
  const w = spawnSync('bash', [join(root, 'scripts/wait-ci.sh'), 'o/r', '7', '2'], { encoding: 'utf8', env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, WAIT_CI_INTERVAL: '0' } })
  const out = JSON.parse(w.stdout)
  assert.equal(out.state, 'noRuns')
  assert.notEqual(out.state, 'success')
  const r = land(s)
  assert.match(r.out, /STOP #7: no check runs/)
  assert.equal(putCalls(r).length, 0)
})

test('land: a cancelled run that is not a known flake is a LAND FIX', () => {
  const s = landSetup({ checks: [[cancelled('ci')]] })
  assert.equal(JSON.parse(readFileSync(join(s.fx, `${CHECKS}.call1.json`), 'utf8')).check_runs[0].conclusion, 'cancelled')
  const r = land(s)
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /LAND FIX #7 state=MERGEABLE failing=\[ci\]/)
  assert.equal(reruns(r).length, 0)
  assert.equal(putCalls(r).length, 0)
})

test('land: a cancelled known flake gets one rerun and merges', () => {
  const r = land(landSetup({ checks: [[cancelled('e2e')], [cancelled('e2e')], [passed('e2e')]] }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /RERUN #7: known flake\(s\) \[e2e\]/)
  assert.equal(reruns(r).length, 1)
  assert.equal(putCalls(r).length, 1)
})

test('land: a failed run does not end the wait while another run is in progress', () => {
  const ip = inProgress
  const s = landSetup({ checks: [[failed('e2e'), ip], [failed('e2e'), ip], [failed('e2e'), passed('ci')], [failed('e2e'), passed('ci')], [passed('e2e'), passed('ci')]] })
  assert.equal(JSON.parse(readFileSync(join(s.fx, `${CHECKS}.call1.json`), 'utf8')).check_runs[1].status, 'in_progress')
  const r = land(s)
  assert.equal(r.code, 0, r.out)
  assert.equal(reruns(r).length, 1)
  const post = r.log.findIndex((l) => /^POST .*rerun-failed-jobs/.test(l))
  assert.ok(checkReads({ log: r.log.slice(0, post) }) >= 4, r.log.join('\n'))
  assert.doesNotMatch(r.out, /LAND FIX/)
})

test('land: a failed run does not end the wait while a commit status is pending', () => {
  const s = landSetup({ checks: [[failed('e2e')], [failed('e2e')], [failed('e2e')], [failed('e2e')], [passed('e2e')]] })
  rmSync(join(s.fx, `${P}__commits__${SHA}__status.json`))
  const pend = { state: 'pending', statuses: [{ context: 'ext/ci', state: 'pending' }] }
  put(s.fx, `${P}__commits__${SHA}__status.call1.json`, pend)
  put(s.fx, `${P}__commits__${SHA}__status.call2.json`, pend)
  put(s.fx, `${P}__commits__${SHA}__status.call3.json`, okStatus)
  const r = land(s)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all merged/)
  assert.equal(reruns(r).length, 1)
  const post = r.log.findIndex((l) => /^POST .*rerun-failed-jobs/.test(l))
  assert.ok(r.log.slice(0, post).filter((l) => /^GET .*commits\/.*\/status/.test(l)).length >= 3, r.log.join('\n'))
  assert.doesNotMatch(r.out, /LAND FIX/)
})

test('land: the saved real check runs of PR 805 merge', () => {
  const checks = JSON.parse(readFileSync(join(root, 'test/fixtures/clean-review/pr805-f36bb8e.json'), 'utf8')).checks
  const r = land(landSetup({ checks: [checks] }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all merged/)
})

test('land: a different rule in ci-state.jq changes what land-wave.sh does', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  const r = run(s, 'land-wave.sh', ['o/r', `7:${SHA}`], {}, stubCopy())
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /LAND FIX #7 state=MERGEABLE failing=\[stub-check\]/)
  assert.equal(reruns(r).length, 0)
  assert.equal(putCalls(r).length, 0)
})

test('merge-pr: a different rule in ci-state.jq changes what merge-pr.sh does', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  const r = mergeRun(s, stubCopy())
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /PR 7 NOT merged/)
  assert.match(r.out, /failing=\[.*stub-check/)
  assert.equal(putCalls(r).length, 0)
})

for (const [name, checks, status, want] of [
  ['no check run and a green status', [[]], okStatus, /failing=\[no-checks\]/],
  ['a cancelled run', [[cancelled('ci')]], null, /failing=\[ci:cancelled\]/],
  ['a run in progress', [[inProgress]], null, /failing=\[ci:pending\]/],
  ['a pending status', [[passed('ci')]], { state: 'pending', statuses: [{ context: 'ext/ci', state: 'pending' }] }, /failing=\[ext\/ci:pending\]/],
  ['a failed status', [[passed('ci')]], { state: 'failure', statuses: [{ context: 'ext/ci', state: 'failure' }] }, /failing=\[ext\/ci:failure\]/],
]) {
  test(`merge-pr: ${name} is refused`, () => {
    const s = landSetup({ checks })
    if (status) put(s.fx, STATUS, status)
    const r = mergeRun(s)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, want)
    assert.match(r.out, /PR 7 NOT merged/)
    assert.equal(putCalls(r).length, 0)
  })
}

test('merge-pr: a green run with a green status merges', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  put(s.fx, STATUS, okStatus)
  const r = mergeRun(s)
  assert.equal(r.code, 0, r.out)
  assert.equal(putCalls(r).length, 1)
})

test('land: a failed status named like a failed known-flake run is not rerun', () => {
  const s = landSetup({ checks: [[failed('e2e')]] })
  put(s.fx, STATUS, { state: 'failure', statuses: [{ context: 'e2e', state: 'failure' }] })
  const r = land(s)
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /LAND FIX #7/)
  assert.equal(reruns(r).length, 0)
  assert.equal(putCalls(r).length, 0)
})

test('land: a failed status named like a run that is still in progress ends the wait at once', () => {
  const s = landSetup({ checks: [[failed('e2e'), inProgress]] })
  put(s.fx, STATUS, { state: 'failure', statuses: [{ context: 'e2e', state: 'failure' }] })
  const r = land(s)
  assert.equal(r.code, 3, r.out)
  assert.equal(reruns(r).length, 0)
  assert.ok(checkReads(r) <= 2, r.log.join('\n'))
})

test('land: runs in progress that appear after statuses-only polls are waited for', () => {
  const s = landSetup({ checks: [[], [], [inProgress], [inProgress], [passed('ci')]] })
  put(s.fx, STATUS, okStatus)
  const r = land(s, { review: true })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /not merged|WAITING/)
  assert.equal(putCalls(r).length, 1)
  const put1 = r.log.findIndex((l) => /^PUT .*\/pulls\/7\/merge/.test(l))
  assert.ok(checkReads({ log: r.log.slice(0, put1) }) >= 5, r.log.join('\n'))
})

test('merge-pr: a ci-state.jq that prints nothing stops the merge', () => {
  const s = landSetup({ checks: [[passed('ci')]] })
  const copy = stubCopy()
  writeFileSync(join(copy, 'ci-state.jq'), 'empty')
  const r = mergeRun(s, copy)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /PR 7 NOT merged: cannot judge the check runs/)
  assert.equal(putCalls(r).length, 0)
})

test('land: a head that gains check runs after two empty polls is not a STOP for no check runs', () => {
  const s = landSetup({ checks: [[], [], [passed('ci')]] })
  put(s.fx, STATUS, okStatus)
  const r = land(s)
  assert.doesNotMatch(r.out, /no check runs/)
  assert.equal(r.code, 0, r.out)
  assert.equal(putCalls(r).length, 1)
})

// A stand-in mktemp whose -d folder holds a read-only empty file as <name>, so the write of that file fails and the file reads as empty.
for (const file of ['sts', 'runs']) {
  test(`merge-pr: a failed write of the ${file} file stops the merge`, () => {
    const s = landSetup({ checks: [[passed('ci')]] })
    put(s.fx, STATUS, { state: 'failure', statuses: [{ context: 'ext/ci', state: 'failure' }] })
    const ro = join(s.dir, 'ro-empty'); writeFileSync(ro, ''); chmodSync(ro, 0o444)
    const real = spawnSync('which', ['mktemp'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(s.bin, 'mktemp'), `#!/bin/bash\nd=$(${real} "$@") || exit 1\ncase " $* " in *" -d "*) ln -s ${ro} "$d/${file}" ;; esac\necho "$d"\n`)
    chmodSync(join(s.bin, 'mktemp'), 0o755)
    const r = mergeRun(s)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /PR 7 NOT merged: cannot write the /)
    assert.equal(putCalls(r).length, 0)
  })
}
