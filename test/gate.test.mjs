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

const pull = (extra = {}) => ({ merged: false, mergeable: true, head: { sha: SHA, ref: 'feat/x' }, ...extra })
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
  assert.equal(r.code, 1)
  assert.match(r.out, /GATED #7: cannot list/)
})

test('gate: a settings read error other than 404 fails closed', () => {
  const r = run(setup({ files: 'clean', settings: 'error' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.match(r.out, /GATED #7: cannot read \.github\/pipeline\.json/)
})

test('gate: settings without a valid gates list fail closed', () => {
  const r = run(setup({ files: 'clean', settings: 'bad' }), 'gate-files.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.match(r.out, /no valid gates/)
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
  assert.equal(r.code, 1)
  assert.match(r.out, /no settings file and no template/)
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
