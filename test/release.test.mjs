// Runs release.sh and bot-status.sh against test/fake-gh on fixtures built in each test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const P = 'repos__o__r'
const HEAD = 'a'.repeat(40)
const TAG = 'b'.repeat(40)
const C1 = 'c'.repeat(40)
const C2 = 'd'.repeat(40)
const H1 = 'e'.repeat(40)
const H2 = 'f'.repeat(40)
const WORKFLOW = 'on:\n  release:\n    types: [published]\njobs:\n  release:\n    runs-on: ubuntu-latest\n'
const cleared = (mode, sha) => `<!-- pipeline:merge-cleared ${mode} ${sha} -->`

const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))
const pr = (number, merge, head) => [{ number, merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: merge, head: { sha: head } }]

const setup = (over = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const o = {
    settings: { gates: [], autoRelease: true }, workflow: WORKFLOW, conclusion: 'success', tags: [{ name: 'v0.2.0', commit: { sha: TAG } }],
    commits: [C1], manifest: { version: '0.3.0' }, prs: { [C1]: pr(5, C1, H1) }, comments: { 5: [{ user: { login: 'bot' }, body: cleared('auto', H1) }] }, ...over,
  }
  put(fx, `${P}.json`, { default_branch: 'main' })
  put(fx, 'user.json', { login: 'bot' })
  put(fx, `${P}__commits__main.json`, { sha: HEAD })
  put(fx, `${P}__contents__.github__pipeline.json.json`, o.settings)
  put(fx, `${P}__contents__.github__workflows.json`, [{ name: 'release.yml', path: '.github/workflows/release.yml' }])
  put(fx, `${P}__contents__.github__workflows__release.yml.json`, o.workflow)
  put(fx, `${P}__commits__${HEAD}__check-runs.json`, { check_runs: [{ name: 'ci', status: 'completed', conclusion: o.conclusion }] })
  put(fx, `${P}__commits__${HEAD}__status.json`, { state: 'success', statuses: [] })
  put(fx, `${P}__tags.json`, o.tags)
  put(fx, `${P}__compare__${TAG}...${HEAD}.json`, { total_commits: o.commits.length, commits: o.commits.map((sha) => ({ sha })) })
  for (const [sha, list] of Object.entries(o.prs)) put(fx, `${P}__commits__${sha}__pulls.json`, list)
  for (const sha of o.commits) if (!o.prs[sha]) put(fx, `${P}__commits__${sha}__pulls.json`, [])
  for (const [n, list] of Object.entries(o.comments)) put(fx, `${P}__issues__${n}__comments.json`, list)
  if (o.manifest) put(fx, `${P}__contents__.claude-plugin__plugin.json.json`, o.manifest)
  return { dir, bin, fx, log: join(dir, 'log'), settings: o.settings }
}

const run = (s, script, args) => {
  const env = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, PIPELINE_TEST_FAST: '1' }
  const r = spawnSync('bash', [join(root, 'scripts', script), ...args], { env, encoding: 'utf8' })
  const log = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  return { code: r.status, out: r.stdout + r.stderr, log }
}
const release = (s, ...flags) => run(s, 'release.sh', [...flags, 'o/r', '0.3.0'])
const writes = (r) => r.log.filter((l) => /^(POST|PUT|PATCH|DELETE) /.test(l))

const refused = (r, text) => {
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, text)
  assert.match(r.out, /NOT released/)
  assert.deepEqual(writes(r), [])
}

test('release: every check passes, the release pins the checked sha', () => {
  const r = release(setup())
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(writes(r).map((l) => l.replace(/\\n/g, ' ')), [`POST /repos/o/r/releases tag_name=v0.3.0 target_commitish=${HEAD} name=v0.3.0 generate_release_notes=true`])
  assert.match(r.out, /ok: all 1 commits since v0\.2\.0/)
})

test('release: --dry-run prints each check and the release, and calls no write endpoint', () => {
  const r = release(setup(), '--dry-run')
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(writes(r), [])
  assert.match(r.out, /ok: autoRelease is true/)
  assert.match(r.out, /ok: \.github\/workflows\/release\.yml runs on a release/)
  assert.match(r.out, new RegExp(`release: v0\\.3\\.0 on o/r, target ${HEAD}`))
  assert.match(r.out, /dry run: no release made/)
})

test('release: autoRelease false refuses', () => {
  const s = setup({ settings: { gates: [], autoRelease: false } })
  assert.equal(s.settings.autoRelease, false)
  refused(release(s), /MISSING: autoRelease is not true/)
})

test('release: a repo without a settings file refuses', () => {
  const s = setup()
  put(s.fx, `${P}__contents__.github__pipeline.json.GET.error`, 'fake-gh: no fixture (HTTP 404)')
  refused(release(s), /MISSING: autoRelease is not true/)
})

test('release: a workflow without a release or tag trigger refuses, even with a job named release', () => {
  const workflow = 'on:\n  pull_request:\njobs:\n  release:\n    runs-on: ubuntu-latest\n'
  assert.match(workflow, /^  release:/m)
  refused(release(setup({ workflow })), /MISSING: no workflow has a release or tag trigger/)
})

test('release: a tag trigger counts', () => {
  const r = release(setup({ workflow: 'on:\n  push:\n    tags:\n      - "v*"\n' }), '--dry-run')
  assert.equal(r.code, 0, r.out)
})

test('release: an inline list and a bare name count as release triggers', () => {
  for (const on of ['on: [release]', 'on: [push, release]', 'on: release', 'on: { release: { types: [published] } }']) {
    const r = release(setup({ workflow: `${on}\njobs:\n  x:\n    runs-on: ubuntu-latest\n` }), '--dry-run')
    assert.equal(r.code, 0, `${on}\n${r.out}`)
  }
})

test('release: a workflow_dispatch input named release or tags, or a similar word, is not a trigger', () => {
  const dispatch = name => `on:\n  workflow_dispatch:\n    inputs:\n      ${name}:\n        description: x\njobs:\n  x:\n    runs-on: ubuntu-latest\n`
  for (const workflow of [dispatch('release'), dispatch('tags'), 'on: [push, prerelease]\n', 'on:\n  push:\n    branches: [main]\n  pull_request:\n    tags: [x]\n']) {
    refused(release(setup({ workflow })), /MISSING: no workflow has a release or tag trigger/)
  }
})

test('release: a red default branch refuses', () => {
  const s = setup({ conclusion: 'failure' })
  assert.match(readFileSync(join(s.fx, `${P}__commits__${HEAD}__check-runs.json`), 'utf8'), /"failure"/)
  refused(release(s), /MISSING: main is not green at aaaaaaa: ci/)
})

test('release: a manifest version that differs from the release version refuses', () => {
  const s = setup({ manifest: { version: '0.2.9' } })
  refused(release(s), /MISSING: \.claude-plugin\/plugin\.json has version '0\.2\.9', not 0\.3\.0/)
})

test('release: a repo with no manifest refuses', () => {
  const s = setup({ manifest: null })
  refused(release(s), /MISSING: no manifest with a version at aaaaaaa/)
})

test('release: the manifest check covers package.json too', () => {
  const s = setup()
  put(s.fx, `${P}__contents__package.json.json`, { version: '0.1.0' })
  refused(release(s), /MISSING: package\.json has version '0\.1\.0'/)
})

test('release: a commit with no merge-cleared comment refuses', () => {
  const s = setup({ commits: [C1, C2], prs: { [C1]: pr(5, C1, H1), [C2]: pr(6, C2, H2) }, comments: { 5: [{ user: { login: 'bot' }, body: cleared('auto', H1) }], 6: [] } })
  refused(release(s), /MISSING: since v0\.2\.0: #6 has no merge-cleared comment by bot/)
})

test('release: a merge-cleared comment by another account does not count', () => {
  const s = setup({ comments: { 5: [{ user: { login: 'mallory' }, body: cleared('auto', H1) }] } })
  assert.match(readFileSync(join(s.fx, `${P}__issues__5__comments.json`), 'utf8'), /mallory/)
  refused(release(s), /#5 has no merge-cleared comment by bot/)
})

test('release: a merge-cleared comment for an older head refuses', () => {
  const s = setup({ comments: { 5: [{ user: { login: 'bot' }, body: cleared('person', H2) }] } })
  refused(release(s), /#5: the merge-cleared comment is for fffffff, the merged head is eeeeeee/)
})

test('release: a person record clears like an auto record', () => {
  const r = release(setup({ comments: { 5: [{ user: { login: 'bot' }, body: cleared('person', H1) }] } }), '--dry-run')
  assert.equal(r.code, 0, r.out)
})

test('release: two trusted merge-cleared comments refuse', () => {
  const both = { user: { login: 'bot' }, body: cleared('auto', H1) }
  refused(release(setup({ comments: { 5: [both, both] } })), /#5 has two merge-cleared comments/)
})

test('release: a commit with no merged PR (a hand merge) refuses', () => {
  const s = setup({ commits: [C1, C2], prs: { [C1]: pr(5, C1, H1) } })
  assert.equal(readFileSync(join(s.fx, `${P}__commits__${C2}__pulls.json`), 'utf8'), '[]')
  refused(release(s), /MISSING: since v0\.2\.0: ddddddd has no merged PR/)
})

test('release: with no tag it always refuses, even when every commit has a merge-cleared record', () => {
  const s = setup({ tags: [] })
  assert.equal(readFileSync(join(s.fx, `${P}__tags.json`), 'utf8'), '[]')
  assert.match(readFileSync(join(s.fx, `${P}__issues__5__comments.json`), 'utf8'), /merge-cleared auto/)
  refused(release(s), /MISSING: no tag yet: the first release needs the maintainer/)
  refused(release(setup({ tags: [] }), '--dry-run'), /no tag yet: the first release needs the maintainer/)
})

test('release: a tag for the version that exists already refuses', () => {
  refused(release(setup({ tags: [{ name: 'v0.3.0', commit: { sha: TAG } }, { name: 'v0.2.0', commit: { sha: TAG } }] })), /the tag for 0\.3\.0 exists already/)
})

test('release: a bad version is a usage error and calls nothing', () => {
  const s = setup()
  const r = run(s, 'release.sh', ['o/r', 'latest'])
  assert.equal(r.code, 2)
  assert.deepEqual(r.log, [])
})

const BOT = 'gitar-bot[bot]'
const statusSetup = (reviews, comments, checks = [{ name: 'Gitar', status: 'completed', conclusion: 'success' }]) => {
  const s = setup()
  put(s.fx, `${P}__pulls__7.json`, { head: { sha: HEAD } })
  put(s.fx, `${P}__pulls__7__reviews.json`, reviews)
  put(s.fx, `${P}__pulls__7__comments.json`, comments)
  put(s.fx, `${P}__commits__${HEAD}__check-runs.json`, { check_runs: checks })
  return s
}
const rv = (state, commit, at, body = 'x') => ({ id: Number(at), user: { login: BOT }, state, body, commit_id: commit, submitted_at: `2026-01-0${at}T00:00:00Z` })
const status = (s) => JSON.parse(run(s, 'bot-status.sh', ['o/r', '7']).out)

test('bot-status: approvedBy is the land gate rule, so an approval of an older commit counts', () => {
  const r = status(statusSetup([rv('APPROVED', 'old'.padEnd(40, '0'), '1')], []))
  assert.deepEqual(r, { head: HEAD, approvedBy: [`${BOT} (approved earlier)`], seenHead: [BOT], openThreads: 0, reviewBodies: 0 })
})

test('bot-status: an approval of an older commit with the bot check still running has not seen the head', () => {
  const r = status(statusSetup([rv('APPROVED', 'old'.padEnd(40, '0'), '1')], [], [{ name: 'Gitar', status: 'in_progress', conclusion: null }]))
  assert.deepEqual(r, { head: HEAD, approvedBy: [], seenHead: [], openThreads: 0, reviewBodies: 0 })
})

test('bot-status: an approval on the head has seen it', () => {
  const r = status(statusSetup([rv('APPROVED', HEAD, '1')], [], []))
  assert.deepEqual(r.seenHead, [BOT])
})

test('bot-status: a reply-only review after an approval does not take the approval away', () => {
  const s = statusSetup([rv('APPROVED', HEAD, '1'), rv('COMMENTED', HEAD, '2', '')], [{ id: 9, pull_request_review_id: 2, in_reply_to_id: 4, user: { login: 'alfhen' } }])
  assert.deepEqual(status(s).approvedBy, [BOT])
})

test('bot-status: an unanswered bot thread is counted and nothing clears', () => {
  const thread = (id) => ({ id, pull_request_review_id: 1, in_reply_to_id: null, user: { login: BOT } })
  const s = statusSetup([rv('COMMENTED', 'old'.padEnd(40, '0'), '1')], [thread(4), thread(5), { id: 9, in_reply_to_id: 4, user: { login: 'alfhen' } }])
  assert.deepEqual(status(s), { head: HEAD, approvedBy: [], seenHead: [], openThreads: 1, reviewBodies: 0 })
})

test('bot-status: a failed GitHub read exits 1', () => {
  const s = statusSetup([], [])
  put(s.fx, `${P}__pulls__7__reviews.GET.error`, 'fake-gh: server error (HTTP 500)')
  const r = run(s, 'bot-status.sh', ['o/r', '7'])
  assert.equal(r.code, 1)
  assert.match(r.out, /bot-status: cannot read the reviews/)
})

const big = (n, conclusion) => Array.from({ length: n }, (_, i) => ({ name: `job${i}`, status: 'completed', conclusion: i === 0 ? conclusion : 'success', output: { text: 'x'.repeat(20000) } }))

test('release: a red branch with check runs over 128 KiB still refuses', () => {
  const s = setup()
  put(s.fx, `${P}__commits__${HEAD}__check-runs.json`, { check_runs: big(60, 'failure') })
  refused(release(s, '--dry-run'), /MISSING: main is not green at aaaaaaa: job0/)
})

test('bot-status: reviews and comments over 128 KiB still work', () => {
  const thread = (id) => ({ id, pull_request_review_id: 1, in_reply_to_id: null, user: { login: BOT }, body: 'x'.repeat(40000) })
  const s = statusSetup([rv('COMMENTED', 'old'.padEnd(40, '0'), '1')], Array.from({ length: 30 }, (_, i) => thread(i + 1)))
  assert.deepEqual(status(s), { head: HEAD, approvedBy: [], seenHead: [], openThreads: 30, reviewBodies: 0 })
})

// The plugin's own repo: the fixtures of setup() moved to its name, plus a files.txt and a tree.
const PP = 'repos__alfhen__agent-pr-pipeline'
const S1 = '1'.repeat(40); const S2 = '2'.repeat(40); const S3 = '3'.repeat(40); const S4 = '4'.repeat(40)
const shippedTree = [['.claude-plugin/plugin.json', S1], ['agents/tester.md', S2], ['scripts/x.sh', S3]]
const pluginSetup = ({ files = shippedTree, tree = shippedTree, releases = 'v0.3.0\nv0.2.0\n' } = {}) => {
  const s = setup()
  for (const f of readdirSync(s.fx)) if (f.startsWith(`${P}`)) renameSync(join(s.fx, f), join(s.fx, f.replace(P, PP)))
  if (files) put(s.fx, `${PP}__contents__.claude-plugin__files.txt.json`, files.map(([p, sha]) => `${sha} ${p}`).join('\n') + '\n')
  if (releases !== null) put(s.fx, `${PP}__contents__.claude-plugin__releases.txt.json`, releases)
  put(s.fx, `${PP}__git__trees__${HEAD}.json`, {
    truncated: false,
    tree: [...tree, ['README.md', S4], ['.claude-plugin/files.txt', S4], ['docs/plan.md', S4]].map(([path, sha]) => ({ type: 'blob', path, sha })),
  })
  return s
}
const releasePlugin = (s, ...flags) => run(s, 'release.sh', [...flags, 'alfhen/agent-pr-pipeline', '0.3.0'])

test('release: the plugin repo with a manifest that matches its tree releases', () => {
  const r = releasePlugin(pluginSetup())
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ok: files\.txt matches the tree/)
  assert.equal(writes(r).length, 1)
  assert.match(writes(r)[0], /^POST \/repos\/alfhen\/agent-pr-pipeline\/releases /)
})

test('release: the plugin repo with a changed, added or missing shipped file stops and makes no release', () => {
  const cases = [
    [[['.claude-plugin/plugin.json', S1], ['agents/tester.md', S4], ['scripts/x.sh', S3]], /MANIFEST changed agents\/tester\.md/],
    [[...shippedTree, ['scripts/new.sh', S4]], /MANIFEST added scripts\/new\.sh/],
    [shippedTree.slice(0, 2), /MANIFEST missing scripts\/x\.sh/],
  ]
  for (const [tree, text] of cases) {
    const s = pluginSetup({ tree })
    const r = releasePlugin(s)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /files\.txt does not match the tree/)
    assert.match(r.out, text)
    assert.deepEqual(writes(r), [])
  }
  const s = pluginSetup({ files: [...shippedTree, ['scripts/gone.sh', S4]] })
  const r = releasePlugin(s)
  assert.match(r.out, /MANIFEST missing scripts\/gone\.sh/)
  assert.deepEqual(writes(r), [])
})

test('release: the plugin repo without a files.txt stops and makes no release', () => {
  const s = pluginSetup({ files: null })
  const r = releasePlugin(s)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /cannot go on: \.claude-plugin\/files\.txt is missing/)
  assert.deepEqual(writes(r), [])
})

test('release: another repo with no files.txt releases as before and never reads one', () => {
  const s = setup()
  assert.equal(existsSync(join(s.fx, `${P}__contents__.claude-plugin__files.txt.json`)), false)
  const r = release(s)
  assert.equal(r.code, 0, r.out)
  assert.equal(r.log.filter((l) => /files\.txt|git\/trees/.test(l)).length, 0)
  assert.equal(writes(r).length, 1)
})

test('release: a cut tree in the plugin repo stops', () => {
  const s = pluginSetup()
  put(s.fx, `${PP}__git__trees__${HEAD}.json`, { truncated: true, tree: [] })
  const r = releasePlugin(s)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is cut/)
  assert.deepEqual(writes(r), [])
})

test('release: the plugin repo with releases.txt starting with the version releases', () => {
  const r = releasePlugin(pluginSetup())
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ok: releases\.txt lists v0\.3\.0 first/)
  assert.equal(writes(r).length, 1)
})

test('release: the plugin repo with another first line, a missing list or an empty list stops and makes no release', () => {
  for (const releases of ['v0.2.0\nv0.3.0\n', 'v0.3.1\n', null, '']) {
    const r = releasePlugin(pluginSetup({ releases }))
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /MISSING: \.claude-plugin\/releases\.txt does not start with v0\.3\.0/)
    assert.deepEqual(writes(r), [])
  }
})

test('release: another repo never reads releases.txt', () => {
  const r = release(setup())
  assert.equal(r.code, 0, r.out)
  assert.equal(r.log.filter((l) => /releases\.txt/.test(l)).length, 0)
})
