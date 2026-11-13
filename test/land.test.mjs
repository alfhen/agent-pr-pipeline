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
  return s
}
const land = (s) => run(s, 'land-wave.sh', ['o/r', `7:${SHA}`])

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
  put(s.fx, `${PULL}.call3.json`, pull(NEW))
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
  for (const [bad, text] of [[`8:aaaaaaa:auto`, /need the full 40-character commit id in 8:aaaaaaa:auto/], [`8:${SHA}:bogus`, /need <pr>:<sha> or <pr>:<sha>:auto/]]) {
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
