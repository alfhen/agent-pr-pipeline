// Runs gate-files.sh, merge-pr.sh, land-wave.sh, merge-wave.sh and bot-approval.jq against test/fake-gh on fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const FX = join(root, 'test/fixtures/gate')
const SHA = 'a'.repeat(40)
const P = 'repos__o__r'
const PULL = `${P}__pulls__7`
const MERGE = `${PULL}__merge`
const DELETE_REF = `${P}__git__refs__heads__feat__x`

const pull = (extra = {}) => ({ merged: false, mergeable: true, head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } }, ...extra })
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))

// opts.files: name of a fixture in test/fixtures/gate/files, or null for no files fixture.
// opts.settings: 'repo' (the gate fixture), 'missing' (404), 'error' (500) or 'bad'.
const setup = ({ files = 'clean', settings = 'repo', merging = true, scripts = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  let scriptDir = join(root, 'scripts')
  if (scripts) {
    scriptDir = join(dir, 'scripts'); mkdirSync(scriptDir)
    for (const f of readdirSync(join(root, 'scripts'))) copyFileSync(join(root, 'scripts', f), join(scriptDir, f))
  }
  put(fx, `${P}.json`, { default_branch: 'main' })
  const contents = `${P}__contents__.github__pipeline.json.json`
  if (settings === 'repo') copyFileSync(join(FX, 'pipeline.json'), join(fx, contents))
  if (settings === 'error') put(fx, `${contents.replace(/.json$/, '')}.GET.error`, 'fake-gh: server error (HTTP 500)')
  if (settings === 'slash') put(fx, contents, { gates: ['docs/'] })
  if (settings === 'bad') put(fx, contents, '{"gates": "scripts/**"}')
  if (files) for (const f of readdirSync(join(FX, 'files')).filter((n) => n.startsWith(`${files}.`))) {
    copyFileSync(join(FX, 'files', f), join(fx, `${PULL}__files.${f.split('.')[1]}.json`))
  }
  put(fx, `${PULL}.json`, pull())
  put(fx, 'pull-merged.json', pull({ merged: true }))
  if (merging) put(fx, `${MERGE}.PUT.then`, `pull-merged.json ${PULL}.json\n`)
  put(fx, `${MERGE}.PUT.json`, { merged: true })
  put(fx, `${P}__commits__${SHA}__check-runs.json`, { check_runs: [
    { name: 'ci', status: 'completed', conclusion: 'success' },
    { name: 'gitar', status: 'completed', conclusion: 'success' }] })
  put(fx, `${P}__commits__${SHA}__status.json`, { state: 'success', statuses: [] })
  put(fx, `${PULL}__reviews.json`, [{ id: 1, user: { login: 'gitar-bot[bot]' }, state: 'APPROVED', body: '', commit_id: SHA, submitted_at: '2026-01-01T10:00:00Z' }])
  put(fx, `${PULL}__comments.json`, [])
  return { dir, bin, fx, scriptDir, log: join(dir, 'log') }
}

const run = (s, script, args, env = {}) => {
  const e = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, PIPELINE_TEST_FAST: '1', ...env }
  if (env.CLAUDECODE === undefined) delete e.CLAUDECODE
  const r = spawnSync('bash', [join(s.scriptDir, script), ...args], { env: e, encoding: 'utf8' })
  const log = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  return { code: r.status, out: r.stdout + r.stderr, log }
}
const calls = (r, re) => r.log.filter((l) => re.test(l))
const merges = (r) => calls(r, /^PUT .*\/pulls\/7\/merge/)
const gateRan = (r) => calls(r, /\/pulls\/7\/files/).length > 0

test('gate: a gated file holds the PR', () => {
  const r = run(setup({ files: 'gated' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.match(r.out, /GATED #7: scripts\/merge-pr\.sh/)
})

test('gate: a PR with only other files passes', () => {
  const r = run(setup({ files: 'clean' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 0)
  assert.match(r.out, /not gated/)
})

test('gate: a rename out of a gated path counts through previous_filename', () => {
  const r = run(setup({ files: 'renamed' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.match(r.out, /scripts\/x\.sh/)
})

test('gate: the only gated file on page 2 is found', () => {
  const s = setup({ files: 'paged' })
  assert.equal(existsSync(join(s.fx, `${PULL}__files.2.json`)), true)
  const r = run(s, 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.match(r.out, /workflows\/run-wave\.js/)
})

test('gate: a root-level package.json matches **/package.json', () => {
  const r = run(setup({ files: 'root-package' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.match(r.out, /package\.json/)
})

test('gate: an API error on the file list fails closed', () => {
  const s = setup({ files: null })
  const r = run(s, 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 3)
  assert.match(r.out, /GATE ERROR #7: cannot list/)
})

test('gate: a settings read error other than 404 fails closed', () => {
  const r = run(setup({ files: 'clean', settings: 'error' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 3)
  assert.match(r.out, /GATE ERROR #7: cannot read \.github\/pipeline\.json/)
})

test('gate: settings without a valid gates list fail closed', () => {
  const r = run(setup({ files: 'clean', settings: 'bad' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 3)
  assert.match(r.out, /GATE ERROR #7: .*no valid gates/)
})

test('gate: with no settings file the plugin template gates apply', () => {
  const s = setup({ files: 'root-package', settings: 'missing' })
  assert.equal(run(s, 'gate-files.sh', ['o/r', '7']).code, 1)
  const t = setup({ files: 'template-only', settings: 'missing' })
  const r = run(t, 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 0)
})

test('gate: no settings file and no template fails closed', () => {
  const s = setup({ files: 'clean', settings: 'missing', scripts: true })
  const r = run(s, 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 3)
  assert.match(r.out, /GATE ERROR #7: no settings file and no template/)
})

test('gate: 3000 changed files or more is a gate error, not a hit', () => {
  const s = setup({ files: null })
  put(s.fx, `${PULL}__files.1.json`, Array.from({ length: 3000 }, (_, i) => ({ filename: `src/f${i}.js` })))
  const r = run(s, 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 3)
  assert.match(r.out, /^GATE ERROR #7: 3000 changed files/)
  assert.doesNotMatch(r.out, /GATED/)
})

test('gate: a hit prints GATED and never GATE ERROR', () => {
  const r = run(setup({ files: 'gated' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.out, /GATE ERROR/)
})

test('merge-pr: a gate that could not run says so, exits 7 and makes no merge call', () => {
  const r = run(setup({ files: 'clean', settings: 'error' }), 'merge-pr.sh', ['--auto', 'o/r', '7', SHA, 'feat/x'], { CLAUDECODE: '1' })
  assert.equal(r.code, 7)
  assert.match(r.out, /the gate could not run/)
  assert.doesNotMatch(r.out, /the gate holds it/)
  assert.equal(merges(r).length, 0)
})

const AGENT = { CLAUDECODE: '1' }

test('merge-pr: an agent with --auto on a gated PR is refused and no merge call is made', () => {
  const r = run(setup({ files: 'gated' }), 'merge-pr.sh', ['--auto', 'o/r', '7', SHA, 'feat/x'], AGENT)
  assert.equal(r.code, 7)
  assert.match(r.out, /the gate holds it/)
  assert.equal(merges(r).length, 0)
  assert.match(r.log[0], /^GET \/repos\/o\/r$/)
})

test('merge-pr: an agent with no flag on a gated PR is refused by the gate', () => {
  const r = run(setup({ files: 'gated' }), 'merge-pr.sh', ['o/r', '7', SHA, 'feat/x'], AGENT)
  assert.equal(r.code, 7)
  assert.equal(merges(r).length, 0)
})

test('merge-pr: an agent with no --auto on a clean PR is refused after the gate ran', () => {
  const r = run(setup({ files: 'clean' }), 'merge-pr.sh', ['o/r', '7', SHA, 'feat/x'], AGENT)
  assert.equal(r.code, 8)
  assert.match(r.out, /needs --auto/)
  assert.equal(gateRan(r), true)
  assert.equal(merges(r).length, 0)
})

test('merge-pr: without CLAUDECODE and without --auto the gate does not run', () => {
  const r = run(setup({ files: 'gated' }), 'merge-pr.sh', ['o/r', '7', SHA, 'feat/x'])
  assert.equal(gateRan(r), false)
  assert.equal(r.code, 0)
  assert.equal(merges(r).length, 1)
})

test('merge-pr: --auto on a clean PR merges with the checked sha, records it and deletes the branch after merged', () => {
  const r = run(setup({ files: 'clean' }), 'merge-pr.sh', ['--auto', 'o/r', '7', SHA, 'feat/x'], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.equal(gateRan(r), true)
  const [m] = merges(r)
  assert.match(m, /merge_method=squash/)
  assert.ok(m.includes(`sha=${SHA}`))
  assert.equal(calls(r, /^POST \/repos\/o\/r\/issues\/7\/comments/)[0].includes(`<!-- pipeline:merge-cleared auto ${SHA} -->`), true)
  const iPut = r.log.findIndex((l) => l.startsWith('PUT '))
  const iDel = r.log.findIndex((l) => l.startsWith('DELETE /repos/o/r/git/refs/heads/feat/x'))
  assert.ok(iDel > iPut && iPut >= 0)
  assert.ok(r.log.slice(iPut, iDel).some((l) => l === 'GET /repos/o/r/pulls/7'), 'merged state read before the delete')
  assert.match(r.out, /merged=true/)
  assert.match(r.out, /clean-up: deleted feat\/x/)
})

test('merge-pr: no DELETE call when the PR does not show merged', () => {
  const r = run(setup({ files: 'clean', merging: false }), 'merge-pr.sh', ['--auto', 'o/r', '7', SHA, 'feat/x'], AGENT)
  assert.equal(r.code, 1)
  assert.equal(merges(r).length, 1)
  assert.equal(calls(r, /^DELETE /).length, 0)
  assert.equal(calls(r, /issues\/7\/comments/).length, 0)
})

test('merge-pr: --person on a gated PR skips the gate and merges with a matching sha', () => {
  const r = run(setup({ files: 'gated' }), 'merge-pr.sh', ['--person', 'o/r', '7', SHA, 'feat/x'], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.equal(gateRan(r), false)
  assert.equal(merges(r).length, 1)
  assert.ok(calls(r, /issues\/7\/comments/)[0].includes(`merge-cleared person ${SHA}`))
})

test('merge-pr: --person with a wrong sha is refused', () => {
  const r = run(setup({ files: 'gated' }), 'merge-pr.sh', ['--person', 'o/r', '7', 'b'.repeat(40), 'feat/x'], AGENT)
  assert.equal(r.code, 1)
  assert.match(r.out, /NOT merged/)
  assert.equal(merges(r).length, 0)
})

test('merge-pr: a branch that is already gone after merged is success, and the merge result is printed apart', () => {
  const s = setup({ files: 'clean' })
  put(s.fx, `${DELETE_REF}.DELETE.error`, 'Reference does not exist (HTTP 422)')
  const r = run(s, 'merge-pr.sh', ['--auto', 'o/r', '7', SHA, 'feat/x'], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /PR 7 merged=true\n/)
  assert.match(r.out, /clean-up: feat\/x already gone/)
})

test('merge-pr: a failed branch delete with the branch still there leaves the merge a success', () => {
  const s = setup({ files: 'clean' })
  put(s.fx, `${DELETE_REF}.DELETE.error`, 'forbidden (HTTP 403)')
  put(s.fx, `${P}__git__ref__heads__feat__x.json`, { ref: 'refs/heads/feat/x' })
  const r = run(s, 'merge-pr.sh', ['--auto', 'o/r', '7', SHA, 'feat/x'], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /clean-up: could not delete feat\/x/)
})

test('merge-pr: a branch name with # is deleted by its encoded full name', () => {
  const s = setup({ files: 'clean' })
  const head = { sha: SHA, ref: 'keep#x', repo: { full_name: 'o/r' } }
  put(s.fx, `${PULL}.json`, pull({ head }))
  put(s.fx, 'pull-merged.json', pull({ merged: true, head }))
  const r = run(s, 'merge-pr.sh', ['--auto', 'o/r', '7', SHA, 'keep#x'], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.equal(calls(r, /^DELETE /)[0], 'DELETE /repos/o/r/git/refs/heads/keep%23x')
})

test('merge-pr: a fork branch is not deleted in the base repo', () => {
  const s = setup({ files: 'clean' })
  const head = { sha: SHA, ref: 'feat/x', repo: { full_name: 'fork/r' } }
  put(s.fx, `${PULL}.json`, pull({ head }))
  put(s.fx, 'pull-merged.json', pull({ merged: true, head }))
  const r = run(s, 'merge-pr.sh', ['--auto', 'o/r', '7', SHA, 'feat/x'], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.equal(calls(r, /^DELETE /).length, 0)
})

test('land-wave: a :auto pair reaches merge-pr.sh as --auto', () => {
  const r = run(setup({ files: 'clean' }), 'land-wave.sh', ['o/r', `7:${SHA}:auto`], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.equal(merges(r).length, 1)
  assert.match(r.out, /mode=auto/)
})

test('land-wave: a pair without :auto is refused for an agent', () => {
  const r = run(setup({ files: 'clean' }), 'land-wave.sh', ['o/r', `7:${SHA}`], AGENT)
  assert.equal(r.code, 5)
  assert.match(r.out, /needs --auto/)
  assert.equal(merges(r).length, 0)
})

test('land-wave: --person is passed through on a gated PR', () => {
  const r = run(setup({ files: 'gated' }), 'land-wave.sh', ['--person', 'o/r', `7:${SHA}`], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /mode=person/)
})

test('land-wave: a bad suffix is refused', () => {
  const r = run(setup({ files: 'clean' }), 'land-wave.sh', ['o/r', `7:${SHA}:later`], AGENT)
  assert.equal(r.code, 2)
  assert.equal(merges(r).length, 0)
})

test('merge-wave: a :auto pair reaches merge-pr.sh as --auto', () => {
  const r = run(setup({ files: 'clean' }), 'merge-wave.sh', ['o/r', `7:${SHA}:auto`], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.equal(merges(r).length, 1)
  assert.match(r.out, /mode=auto/)
})

test('merge-wave: a pair without :auto is refused for an agent', () => {
  const r = run(setup({ files: 'clean' }), 'merge-wave.sh', ['o/r', `7:${SHA}`], AGENT)
  assert.equal(r.code, 4)
  assert.equal(merges(r).length, 0)
})

test('merge-wave: --person is passed through', () => {
  const r = run(setup({ files: 'gated' }), 'merge-wave.sh', ['--person', 'o/r', `7:${SHA}`], AGENT)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /mode=person/)
})

const approvals = (name) => {
  const input = readFileSync(join(FX, 'bot', name), 'utf8')
  const r = spawnSync('jq', ['-c', '-f', join(root, 'scripts/bot-approval.jq')], { input, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('bot-approval: an approval on the head followed by a thread-reply review still clears', () => {
  const f = JSON.parse(readFileSync(join(FX, 'bot/reply-after-approval.json'), 'utf8'))
  const last = f.reviews.at(-1)
  assert.equal(last.state, 'COMMENTED'); assert.equal(last.body, ''); assert.equal(last.commit_id, f.head)
  assert.ok(f.comments.some((c) => c.pull_request_review_id === last.id && c.in_reply_to_id !== null))
  assert.deepEqual(approvals('reply-after-approval.json'), ['gitar-bot[bot]'])
})

test('bot-approval: an empty-body review with a new inline finding on the head blocks', () => {
  const f = JSON.parse(readFileSync(join(FX, 'bot/finding-after-approval.json'), 'utf8'))
  const last = f.reviews.at(-1)
  assert.equal(last.body, '')
  assert.ok(f.comments.some((c) => c.pull_request_review_id === last.id && c.in_reply_to_id === null))
  assert.deepEqual(approvals('finding-after-approval.json'), [])
})

test('gate: a path with a newline under a gated folder is gated', () => {
  const r = run(setup({ files: 'newline' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.match(r.out, /GATED #7/)
})

test('gate: a gate ending in a slash holds everything under it', () => {
  const r = run(setup({ files: 'slash', settings: 'slash' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.match(r.out, /docs\/a\.md/)
})

const withStatus = (s, state) => put(s.fx, `${P}__commits__${SHA}__status.json`, { state, statuses: [{ context: 'ext/ci', state }] })

for (const state of ['failure', 'error', 'pending']) {
  test(`merge-pr: a ${state} commit status blocks the merge while check runs pass`, () => {
    const s = setup({ files: 'clean' }); withStatus(s, state)
    const r = run(s, 'merge-pr.sh', ['--person', 'o/r', '7', SHA, 'feat/x'])
    assert.equal(r.code, 1)
    assert.match(r.out, new RegExp(`ext/ci:${state}`))
    assert.equal(merges(r).length, 0)
  })
}

test('merge-pr: a passing commit status with passing check runs merges', () => {
  const s = setup({ files: 'clean' }); withStatus(s, 'success')
  const r = run(s, 'merge-pr.sh', ['--person', 'o/r', '7', SHA, 'feat/x'])
  assert.equal(r.code, 0, r.out)
  assert.equal(merges(r).length, 1)
})

test('land-wave: a failing commit status stops the wave with LAND FIX', () => {
  const s = setup({ files: 'clean' }); withStatus(s, 'failure')
  const r = run(s, 'land-wave.sh', ['--person', 'o/r', `7:${SHA}`])
  assert.equal(r.code, 3)
  assert.match(r.out, /LAND FIX #7.*ext\/ci/)
  assert.equal(merges(r).length, 0)
})

test('land-wave: a pending commit status is waited for, then reported as still running', () => {
  const s = setup({ files: 'clean' }); withStatus(s, 'pending')
  const r = run(s, 'land-wave.sh', ['--person', 'o/r', `7:${SHA}`])
  assert.equal(r.code, 4)
  assert.match(r.out, /WAITING #7/)
  assert.equal(merges(r).length, 0)
})

const emptyGates = (s) => put(s.fx, `${P}__contents__.github__pipeline.json.json`, { gates: [] })
const writeManifest = (dir, repository) => {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify(repository === undefined ? { name: 'x' } : { name: 'x', repository }))
}
const PLUGIN = 'https://github.com/alfhen/agent-pr-pipeline'
const floorRun = (files, { repo = 'o/r', repository = PLUGIN } = {}) => {
  const s = setup({ files: null, scripts: true })
  const rp = `repos__${repo.replace('/', '__')}`
  writeManifest(s.dir, repository === null ? undefined : repository)
  put(s.fx, `${rp}.json`, { default_branch: 'main' })
  put(s.fx, `${rp}__contents__.github__pipeline.json.json`, { gates: [] })
  put(s.fx, `${rp}__pulls__7__files.1.json`, files)
  return run(s, 'gate-files.sh', [repo, '7'])
}

test('floor: empty gates still hold .github/pipeline.json', () => {
  const r = floorRun([{ filename: '.github/pipeline.json' }])
  assert.equal(r.code, 1)
  assert.match(r.out, /^GATED #7: floor: \.github\/pipeline\.json/)
})

test('floor: empty gates still hold .claude, AGENTS.md, CLAUDE.md and docs/goals.md', () => {
  for (const f of ['.claude/settings.json', 'AGENTS.md', 'CLAUDE.md', 'docs/goals.md']) {
    const r = floorRun([{ filename: f }])
    assert.equal(r.code, 1, f)
    assert.match(r.out, /floor:/)
  }
})

test('floor: a rename out of a floor path is gated', () => {
  const r = floorRun([{ filename: 'lib/a.json', previous_filename: '.github/a.json' }])
  assert.equal(r.code, 1)
  assert.match(r.out, /\.github\/a\.json/)
})

test('floor: a rename out of scripts/ is gated in the plugin repo and not in another repo', () => {
  const files = [{ filename: 'lib/a.sh', previous_filename: 'scripts/a.sh' }]
  const plugin = floorRun(files, { repo: 'alfhen/agent-pr-pipeline' })
  assert.equal(plugin.code, 1)
  assert.match(plugin.out, /floor: .*scripts\/a\.sh/)
  assert.equal(floorRun(files).code, 0)
})

test('floor: the plugin repo is matched ignoring case', () => {
  const r = floorRun([{ filename: 'agents/x.md' }], { repo: 'Alfhen/Agent-PR-Pipeline' })
  assert.equal(r.code, 1)
  assert.match(r.out, /floor: agents\/x\.md/)
})

test('floor: other repos get only the base floor, and src files pass', () => {
  assert.equal(floorRun([{ filename: 'agents/x.md' }]).code, 0)
  const r = floorRun([{ filename: 'src/x.ts' }])
  assert.equal(r.code, 0)
  assert.match(r.out, /not gated/)
})

test('floor: a manifest with no repository adds no plugin paths', () => {
  assert.equal(floorRun([{ filename: 'scripts/x.sh' }], { repo: 'alfhen/agent-pr-pipeline', repository: null }).code, 0)
})

test('floor: a settings hit is reported without the floor prefix', () => {
  const r = run(setup({ files: 'gated' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.out, /floor/)
})

const pluginRepo = (repository) => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-repo-'))
  mkdirSync(join(dir, 'scripts')); writeManifest(dir, repository)
  copyFileSync(join(root, 'scripts/plugin-repo.sh'), join(dir, 'scripts/plugin-repo.sh'))
  const r = spawnSync('bash', [join(dir, 'scripts/plugin-repo.sh')], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim() }
}

test('plugin-repo: https, git@ and .git forms give one lowercase output', () => {
  for (const f of ['https://github.com/Alfhen/Agent-PR-Pipeline', 'git@github.com:alfhen/agent-pr-pipeline', 'https://github.com/alfhen/agent-pr-pipeline.git']) {
    const o = pluginRepo(f)
    assert.equal(o.code, 0, f)
    assert.equal(o.out, 'alfhen/agent-pr-pipeline')
  }
})

test('plugin-repo: no usable repository exits 1', () => {
  assert.equal(pluginRepo(undefined).code, 1)
  assert.equal(pluginRepo('not-a-repo').code, 1)
})
