// Runs the full-mode wrappers routine/bin-full/gh and routine/bin-full/git, and checks routine/settings/full.json.
// The wrappers' real gh is test/fake-gh. The real git is a stub for pushes to GitHub (nothing leaves the machine),
// and the system git on fixture repos for everything else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, cpSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
const fname = path => path.replaceAll('/', '__')
const sumOf = s => { const o = spawnSync('cksum', { input: s, encoding: 'utf8' }).stdout.trim().split(/\s+/); return `${o[0]}:${o[1]}` }

const STUB_GIT = `#!/bin/bash
# Stands in for the real git behind the wrapper. Answers the wrapper's questions from files in $STUB_DIR and logs every call.
S="$STUB_DIR"
echo "$*" >> "$S/calls.log"
args=("$@")
while :; do
  case "\${args[0]:-}" in
    -C|-c|--git-dir|--work-tree) args=("\${args[@]:2}") ;;
    --no-pager|--bare|--literal-pathspecs|--no-replace-objects|--git-dir=*|--work-tree=*) args=("\${args[@]:1}") ;;
    *) break ;;
  esac
done
last=\${args[\${#args[@]}-1]:-}
case "\${args[0]:-}" in
  --list-cmds=builtins,main) printf '%s\\n' push status log fetch subtree commit worktree branch tag remote add diff checkout merge rebase reset rev-parse show-ref symbolic-ref config pull clone init switch stash; exit 0 ;;
  --list-cmds=alias) cat "$S/aliases" 2>/dev/null; exit 0 ;;
  remote) [ "\${args[1]:-}" = get-url ] || exit 0
          if [ -f "$S/url.$last" ]; then cat "$S/url.$last"; exit 0; fi
          echo "error: No such remote '$last'" >&2; exit 2 ;;
  config) case "$*" in
            *--get-regexp*) if [ -f "$S/urlkeys" ]; then cat "$S/urlkeys"; exit 0; fi; exit 1 ;;
            *mirror*) if [ -f "$S/mirror" ]; then cat "$S/mirror"; exit 0; fi; exit 1 ;;
          esac; exit 0 ;;
  symbolic-ref) if [ -f "$S/head" ]; then cat "$S/head"; exit 0; fi; exit 1 ;;
  show-ref) grep -qxF -- "$last" "$S/refs" 2>/dev/null; exit $? ;;
  push) echo "PUSH $*" >> "$S/push.log"; exit 0 ;;
esac
exit 0
`

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'routine-full-guard-test-')))
  const guard = join(dir, 'routine/o-r'); const plugin = join(guard, 'plugin')
  const fakebin = join(dir, 'fakebin'); const stubbin = join(dir, 'stubbin'); const fx = join(dir, 'fx'); const stub = join(dir, 'stub')
  for (const d of [join(plugin, '.claude-plugin'), fakebin, stubbin, fx, stub, join(dir, 'files')]) mkdirSync(d, { recursive: true })
  cpSync(join(root, 'routine'), join(plugin, 'routine'), { recursive: true })
  cpSync(join(root, 'scripts'), join(plugin, 'scripts'), { recursive: true })
  cpSync(join(root, 'templates'), join(plugin, 'templates'), { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'x', version: '9.9.9', repository: 'https://github.com/alfhen/agent-pr-pipeline' }))
  writeFileSync(join(plugin, 'routine/branch-prefix'), 'routine/\n')
  writeFileSync(join(guard, 'repo'), 'o/r\n')
  copyFileSync(join(root, 'test/fake-gh'), join(fakebin, 'gh')); chmodSync(join(fakebin, 'gh'), 0o755)
  writeFileSync(join(stubbin, 'git'), STUB_GIT); chmodSync(join(stubbin, 'git'), 0o755)
  const s = {
    dir, guard, plugin, fakebin, stubbin, fx, stub,
    full: join(plugin, 'routine/bin-full'),
    ghLog: join(dir, 'gh.log'), refusalLog: join(dir, 'refusal.log'), passLog: join(dir, 'pass.log'),
  }
  stubSetup(s)
  return s
}

// The default stub world: origin is this repo on GitHub, HEAD is the branch routine/issue-7.
function stubSetup(s, { url = 'https://github.com/o/r.git', refs = ['refs/heads/routine/issue-7'], head = 'refs/heads/routine/issue-7', aliases = '', urlkeys = null, mirror = null } = {}) {
  for (const f of ['calls.log', 'push.log', 'aliases', 'urlkeys', 'mirror', 'refs', 'head', 'url.origin']) writeFileSync(join(s.stub, f), '')
  for (const f of ['urlkeys', 'mirror', 'head', 'url.origin']) rmFile(join(s.stub, f))
  writeFileSync(join(s.stub, 'url.origin'), `${url}\n`)
  writeFileSync(join(s.stub, 'refs'), refs.join('\n') + '\n')
  writeFileSync(join(s.stub, 'aliases'), aliases)
  if (head) writeFileSync(join(s.stub, 'head'), `${head}\n`)
  if (urlkeys) writeFileSync(join(s.stub, 'urlkeys'), `${urlkeys}\n`)
  if (mirror) writeFileSync(join(s.stub, 'mirror'), `${mirror}\n`)
}
const rmFile = f => { try { spawnSync('rm', ['-f', f]) } catch {} }

const cleanEnv = () => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('GIT_') || k === 'CLAUDECODE') delete e[k]
  return e
}
// kind: 'fake' (system git behind bin-full), 'stub' (stub git behind bin-full), 'none' (no wrappers).
const envFor = (s, kind = 'fake', extra = {}) => {
  const front = kind === 'stub' ? [s.full, s.stubbin, s.fakebin] : kind === 'none' ? [s.fakebin] : [s.full, s.fakebin]
  return {
    ...cleanEnv(), PATH: `${front.join(':')}:${process.env.PATH}`,
    FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.ghLog, STUB_DIR: s.stub,
    WRAPPER_REFUSAL_LOG: s.refusalLog, WRAPPER_PASS_LOG: s.passLog, ...extra,
  }
}
function call(s, prog, args, { kind = 'stub', extra = {}, cwd } = {}) {
  const before = { gh: lines(s.ghLog).length, ref: lines(s.refusalLog).length, pass: lines(s.passLog).length, push: lines(join(s.stub, 'push.log')).length }
  const r = spawnSync(join(s.full, prog), args, { env: envFor(s, kind, extra), encoding: 'utf8', cwd })
  return {
    code: r.status, out: r.stdout, err: r.stderr,
    ghCalls: lines(s.ghLog).slice(before.gh), refusals: lines(s.refusalLog).slice(before.ref),
    passes: lines(s.passLog).slice(before.pass), pushes: lines(join(s.stub, 'push.log')).slice(before.push),
  }
}
const ghc = (s, args, o) => call(s, 'gh', args, { kind: 'fake', ...o })
const gitc = (s, args, o) => call(s, 'git', args, { kind: 'stub', ...o })

const expectRefused = (prog, args, r) => {
  assert.equal(r.code, 77, `${prog} ${args.join(' ')}: ${r.err}`)
  assert.equal(r.err, `${prog} wrapper: refused: ${prog} ${args.join(' ')}\n`)
  assert.equal(r.refusals.length, 1)
  assert.equal(r.passes.length, 0)
}
const refusedGh = (s, args, o) => { const r = ghc(s, args, o); expectRefused('gh', args, r); assert.deepEqual(r.ghCalls, [], `reached gh: ${args.join(' ')}`); return r }
const refusedGit = (s, args, o) => { const r = gitc(s, args, o); expectRefused('git', args, r); assert.deepEqual(r.pushes, [], `reached the push: ${args.join(' ')}`); return r }
const passedGit = (s, args, o) => { const r = gitc(s, args, o); assert.equal(r.code, 0, r.err); assert.deepEqual(r.refusals, []); assert.equal(r.passes.length, 1); return r }

const S = setup()
const file = (name, text) => { const p = join(S.dir, 'files', name); writeFileSync(p, text); return p }
const fixture = (name, v) => writeFileSync(join(S.fx, `${fname(name)}.json`), typeof v === 'string' ? v : JSON.stringify(v))

const MARK = '<!-- pipeline:routine build-started 7 -->'
const BRIEF = '<!-- pipeline:quick-brief 1:1 -->\nTouches: a\nAcceptance: b'
const mark = (p) => { assert.match(readFileSync(p, 'utf8'), /<!-- pipeline:/); return p }
const okBody = file('ok.txt', 'A plain body.\n')
const markBody = mark(file('marker.txt', `${MARK}\n{"a":1}\n`))
const mergeBody = mark(file('merge-cleared.txt', '<!-- pipeline:merge-cleared 5 -->\n'))
const briefBody = mark(file('brief.txt', BRIEF))
const twoBody = file('two.txt', `${BRIEF}\n${MARK}`)

// ---- the gh wrapper ----

test('the wrappers are executable, because the settings allow them by path', () => {
  for (const f of ['routine/bin-full/gh', 'routine/bin-full/git']) assert.equal(statSync(join(root, f)).mode & 0o111, 0o111, f)
})

test('gh refuses what a quick wave never makes, with exit 77, one line and no call to gh', () => {
  const cases = [
    ['pr', 'merge', '3'], ['release', 'create', 'v1'], ['auth', 'token'], ['api', 'graphql', '-f', 'query=x'],
    ['api', '-X', 'PUT', 'repos/o/r/pulls/3/merge'], ['api', '-X', 'POST', 'repos/o/r/merges'], ['api', '-X', 'POST', 'repos/o/r/git/refs'],
    ['api', '-X', 'PATCH', 'repos/o/r'], ['api', '-X', 'DELETE', 'repos/o/r/issues/comments/9'],
    ['api', '-X', 'POST', 'repos/o/r/issues/7/labels', '-f', 'labels[]=x'], ['api', 'repos/x/y/issues'],
    ['api', 'repos/alfhen/agent-pr-pipeline/issues'], ['api', '-X', 'PATCH', 'repos/o/r/pulls/3', '-f', 'body=x'],
    ['api', '-X', 'PUT', 'repos/o/r/contents/a.txt', '-f', 'body=x'], ['api', 'repos/o/r/../x/issues'],
    ['api', 'repos/o/r/issues', '-f', 'title=x'], ['api', 'repos/o/r/issues', '--input', 'x.json'],
    ['pr', 'create', '-R', 'o/r', '--head', 'fix/x', '--body-file', okBody],
    ['pr', 'create', '-R', 'o/r', '--head', 'routine/issue-7', '--base', 'main', '--body-file', okBody],
    ['pr', 'create', '-R', 'o/other', '--head', 'routine/issue-7', '--body-file', okBody],
    ['pr', 'create', '-R', 'o/r', '--head', 'routine/../x', '--body-file', okBody],
    ['pr', 'edit', '3', '-R', 'o/r', '--title', 'x', '--body-file', okBody], ['pr', 'edit', '3', '-R', 'o/r', '--add-label', 'x'],
    ['issue', 'create', '-R', 'o/r', '--label', 'routine-build', '--body-file', okBody],
    ['issue', 'create', '-R', 'o/r', '--label', 'review-minor', '--assignee', 'x', '--body-file', okBody],
    ['issue', 'edit', '3', '--add-label', 'x'], ['issue', 'close', '3'], ['run', 'rerun', '5'], ['workflow', 'run', 'x'],
    ['repo', 'delete', 'o/r'], ['secret', 'set', 'X'], ['pr', 'view', '3', '--web'], ['pr', 'view', '3', '-R', 'o/other'],
    ['pr', 'view', 'https://github.com/o/other/pull/3'], ['pr', 'list', '--jq', '.[] | env'],
    [],
  ]
  for (const args of cases) refusedGh(S, args)
})

test('gh refuses a record marker in every body route, and the same call with a plain body passes', () => {
  const comments = 'repos/o/r/issues/7/comments'
  const replies = 'repos/o/r/pulls/3/comments/9/replies'
  const refuseds = [
    ['api', '-X', 'POST', comments, '-f', `body=${MARK}`],
    ['api', comments, '-f', `body=${MARK}`],
    ['api', '-X', 'POST', comments, '-F', `body=@${markBody}`],
    ['api', '-X', 'POST', comments, '--input', markBody],
    ['api', '-X', 'POST', comments, '-f', `body=${BRIEF}\n${MARK}`],
    ['api', '-X', 'POST', comments, '-F', `body=@${twoBody}`],
    ['api', replies, '-F', `body=@${briefBody}`],
    ['api', replies, '-f', `body=${MARK}`],
    ['issue', 'create', '-R', 'o/r', '--label', 'review-minor', '--body-file', mergeBody],
    ['pr', 'edit', '3', '-R', 'o/r', '--body-file', mergeBody],
    ['pr', 'create', '-R', 'o/r', '--head', 'routine/issue-7', '--body-file', briefBody],
  ]
  for (const args of refuseds) refusedGh(S, args)
  assert.match(readFileSync(twoBody, 'utf8'), /pipeline:quick-brief[\s\S]*pipeline:routine/)
  const controls = [
    ['api', '-X', 'POST', comments, '-f', 'body=hello'],
    ['api', '-X', 'POST', comments, '-F', `body=@${okBody}`],
    ['api', replies, '-F', `body=@${okBody}`],
    ['issue', 'create', '-R', 'o/r', '--label', 'review-minor', '--body-file', okBody],
    ['pr', 'edit', '3', '-R', 'o/r', '--body-file', okBody],
    ['pr', 'create', '-R', 'o/r', '--head', 'routine/issue-7', '--body-file', okBody],
  ]
  for (const args of controls) {
    const r = ghc(S, args)
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`)
    assert.equal(r.passes.length, 1)
  }
})

test('gh passes a quick brief POST, and a PATCH only when the stored comment is a quick brief', () => {
  const post = ['api', '--method', 'POST', 'repos/o/r/issues/7/comments', '-f', `body=${BRIEF}`]
  const r = ghc(S, post)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.ghCalls.length, 1)
  assert.match(r.ghCalls[0], /^POST \/repos\/o\/r\/issues\/7\/comments/)

  const patch = ['api', '--method', 'PATCH', 'repos/o/r/issues/comments/9', '-f', `body=${BRIEF}`]
  fixture('repos/o/r/issues/comments/9', { body: `${MARK}\n{"a":1}` })
  const stored = ghc(S, patch)
  expectRefused('gh', patch, stored)
  assert.ok(stored.ghCalls.some(l => l.startsWith('GET /repos/o/r/issues/comments/9')), 'the wrapper reads the stored comment first')
  assert.ok(!stored.ghCalls.some(l => l.startsWith('PATCH')))

  fixture('repos/o/r/issues/comments/9', { body: '<!-- pipeline:quick-brief 452653:48 -->\nold' })
  const ok = ghc(S, patch)
  assert.equal(ok.code, 0, ok.err)
  assert.ok(ok.ghCalls.some(l => l.startsWith('PATCH /repos/o/r/issues/comments/9')))

  const notBrief = ['api', '--method', 'PATCH', 'repos/o/r/issues/comments/9', '-f', 'body=plain']
  const r3 = ghc(S, notBrief)
  expectRefused('gh', notBrief, r3)
  assert.ok(!r3.ghCalls.some(l => l.startsWith('PATCH')))
})

test('gh passes the reads of the routine repo, the user and the latest plugin release, and nothing else of another repo', () => {
  const passing = [
    ['api', 'user'], ['api', 'user', '--jq', '.login'], ['api', '--paginate', '--slurp', 'repos/o/r/issues/7/comments'],
    ['api', 'repos/o/r', '--jq', '.default_branch'], ['api', '-H', 'Accept: application/vnd.github.raw+json', 'repos/o/r/contents/a.md?ref=main'],
    ['api', 'repos/alfhen/agent-pr-pipeline/releases/latest', '--jq', '.tag_name'],
    ['pr', 'view', '7', '-R', 'o/r', '--json', 'body'], ['pr', 'view', '7', '--json', 'body'], ['pr', 'diff', '7', '-R', 'o/r'],
    ['pr', 'checks', '7', '-R', 'o/r', '--watch', '--interval', '30'], ['pr', 'list', '-R', 'o/r', '--state', 'open'],
    ['issue', 'view', '7', '-R', 'o/r'], ['issue', 'list', '-R', 'o/r'], ['run', 'view', '5', '-R', 'o/r', '--log-failed'], ['run', 'list', '-R', 'o/r'],
  ]
  for (const args of passing) {
    const r = ghc(S, args)
    assert.deepEqual(r.refusals, [], args.join(' '))
    assert.equal(r.passes.length, 1, args.join(' '))
    assert.equal(r.ghCalls.length, 1, args.join(' '))
  }
  refusedGh(S, ['api', 'repos/alfhen/agent-pr-pipeline/releases'])
  refusedGh(S, ['api', 'repos/alfhen/agent-pr-pipeline/releases/latest', '-X', 'DELETE'])
})

test('gh refuses every call when the repo file is missing or bad, and pr create when the prefix file is missing', () => {
  const t = setup()
  const okArgs = ['api', 'repos/o/r/issues']
  writeFileSync(join(t.fx, 'repos__o__r__issues.json'), '[]')
  assert.equal(call(t, 'gh', okArgs, { kind: 'fake' }).code, 0)
  const create = ['pr', 'create', '-R', 'o/r', '--head', 'routine/issue-7', '--body-file', okBody]
  assert.equal(call(t, 'gh', create, { kind: 'fake' }).code, 0)
  rmFile(join(t.plugin, 'routine/branch-prefix'))
  expectRefused('gh', create, call(t, 'gh', create, { kind: 'fake' }))
  assert.equal(call(t, 'gh', okArgs, { kind: 'fake' }).code, 0, 'a missing prefix does not refuse a read')
  writeFileSync(join(t.guard, 'repo'), 'not a repo\n')
  expectRefused('gh', okArgs, call(t, 'gh', okArgs, { kind: 'fake' }))
  rmFile(join(t.guard, 'repo'))
  expectRefused('gh', okArgs, call(t, 'gh', okArgs, { kind: 'fake' }))
})

// ---- the git wrapper ----

const HEAD7 = ['push', 'origin', 'HEAD:routine/issue-7']

test('git refuses each push that is not to routine/<name> on this repo, and the plain push reaches the stub', () => {
  const ok = passedGit(S, HEAD7)
  assert.equal(ok.pushes.length, 1)
  assert.match(ok.pushes[0], /--no-follow-tags/)
  const refused = [
    ['push', 'origin', 'main'], ['push', 'origin', 'HEAD:main'], ['push', 'origin', 'HEAD'],
    ['push', '--force', 'origin', 'routine/issue-7'], ['push', 'origin', '+HEAD:routine/issue-7'], ['push', 'origin', ':routine/issue-7'],
    ['push', 'origin', '--delete', 'routine/issue-7'], ['push', '--tags', 'origin'], ['push', 'origin', 'refs/heads/*:refs/heads/*'],
    ['push', 'origin', 'HEAD:refs/tags/v1'], ['push'], ['push', 'origin'], ['push', '-f', 'origin', 'HEAD:routine/issue-7'],
    ['push', '--mirror', 'origin', 'HEAD:routine/issue-7'], ['push', '--force-with-lease', 'origin', 'HEAD:routine/issue-7'],
    ['push', '-o', 'x', 'origin', 'HEAD:routine/issue-7'], ['push', '--repo', 'origin', 'HEAD:routine/issue-7'],
    ['push', 'https://github.com/o/other.git', 'HEAD:routine/issue-7'],
    ['push', 'https://github.com/o/r.git.evil/x', 'HEAD:routine/issue-7'],
    ['push', 'origin', 'HEAD:routine/a..b'], ['push', 'origin', 'HEAD:routine/'], ['push', 'origin', 'HEAD:routine/a b'],
    ['push', 'origin', 'HEAD:refs/heads/main'], ['push', 'origin', 'HEAD:refs/heads/routine/../main'],
    ['-c', 'remote.origin.pushurl=https://github.com/o/other.git', ...HEAD7],
    ['-c', 'push.default=matching', ...HEAD7],
    ['--git-dir=x', ...HEAD7], ['--work-tree=x', ...HEAD7], ['--bare', ...HEAD7],
  ]
  for (const args of refused) refusedGit(S, args)
  assert.equal(passedGit(S, ['-C', 'x', ...HEAD7]).pushes.length, 1, '-C alone is allowed on a push')
  refusedGit(S, ['-C', 'x', '-c', 'alias.p=push', 'p', 'origin', 'HEAD:main'])
})

test('git passes the pushes of a quick wave, and a destination is compared as a branch name, not a substring', () => {
  for (const args of [['push', '-u', 'origin', 'routine/issue-7'], HEAD7, ['push', 'origin', 'HEAD:refs/heads/routine/domain-main-fix'], ['push', 'origin', 'HEAD:routine/domain-main-fix']]) {
    const r = passedGit(S, args)
    assert.equal(r.pushes.length, 1, args.join(' '))
    assert.match(r.pushes[0], /--no-follow-tags/)
    assert.match(r.pushes[0], /--no-recurse-submodules/)
  }
  stubSetup(S, { url: 'git@github.com:o/r' })
  passedGit(S, HEAD7)
  stubSetup(S)
})

test('git refuses a push of a tag by an unqualified destination, and passes it for a branch', () => {
  stubSetup(S, { refs: ['refs/tags/v1', 'refs/tags/routine/issue-7'], head: null })
  refusedGit(S, ['push', 'origin', 'v1:routine/v1'])
  refusedGit(S, ['push', '-u', 'origin', 'routine/issue-7'])
  refusedGit(S, ['push', 'origin', 'HEAD:routine/issue-7'])
  stubSetup(S, { refs: ['refs/tags/v1', 'refs/heads/v1', 'refs/heads/routine/issue-7'] })
  passedGit(S, ['push', 'origin', 'v1:routine/v1'])
  passedGit(S, ['push', '-u', 'origin', 'routine/issue-7'])
  passedGit(S, ['push', 'origin', 'refs/heads/v1:routine/v1'])
  passedGit(S, ['push', 'origin', 'v1:refs/heads/routine/v1'])
  stubSetup(S)
})

test('git refuses an alias from config, from -c or from the real git, and passes a plain subcommand', () => {
  stubSetup(S, { aliases: 'p\nq\n' })
  refusedGit(S, ['p', 'origin', 'HEAD:main'])
  refusedGit(S, ['q'])
  passedGit(S, ['status'])
  stubSetup(S)
  refusedGit(S, ['p', 'origin', 'x'])
  refusedGit(S, ['puhs', 'origin', 'HEAD:main'])
  refusedGit(S, ['-c', 'help.autocorrect=immediate', 'psuh', 'origin', 'HEAD:main'])
  refusedGit(S, ['Status'])
  stubSetup(S, { aliases: 'p\n' })
  refusedGit(S, ['P', 'origin', 'HEAD:main'])
  stubSetup(S)
  refusedGit(S, ['-c', 'alias.p=push', 'p', 'origin', 'HEAD:main'])
  refusedGit(S, ['-c', 'Alias.P=push', 'p'])

  const repo = makeRepo(S)
  const real = (args) => call(S, 'git', args, { kind: 'fake', cwd: repo.work })
  assert.equal(real(['config', 'alias.p', 'push --force']).code, 0)
  assert.equal(spawnSync('git', ['config', '--get', 'alias.p'], { cwd: repo.work, encoding: 'utf8', env: cleanEnv() }).stdout.trim(), 'push --force')
  expectRefused('git', ['p'], real(['p']))
  expectRefused('git', ['P'], real(['P']))
  assert.equal(real(['status']).code, 0)
})

test('git refuses a push to a local path while a url rewrite exists, a mirror remote, and a changed config route', () => {
  const local = ['push', '/x/bare.git', 'HEAD:routine/issue-7']
  const control = passedGit(S, ['push', '/x/bare.git', 'main'])
  assert.doesNotMatch(control.pushes[0], /--no-follow-tags/, 'a local push is passed as it is')
  stubSetup(S, { urlkeys: 'url.https://github.com/o/r.git.insteadof /x/bare.git' })
  assert.match(readFileSync(join(S.stub, 'urlkeys'), 'utf8'), /insteadof/)
  refusedGit(S, local)
  refusedGit(S, ['push', 'https://github.com/o/r.git', 'HEAD:routine/issue-7'])
  stubSetup(S, { mirror: 'true' })
  refusedGit(S, HEAD7)
  stubSetup(S, { mirror: 'false' })
  passedGit(S, HEAD7)
  stubSetup(S)
  for (const v of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_DIR']) {
    refusedGit(S, HEAD7, { extra: { [v]: '1' } })
    refusedGit(S, ['push', '/x/bare.git', 'main'], { extra: { [v]: '1' } })
  }
  stubSetup(S, { url: 'https://github.com/o/r.git\nhttps://github.com/o/other.git' })
  refusedGit(S, HEAD7)
  stubSetup(S, { url: '/x/bare.git\nhttps://github.com/o/r.git' })
  refusedGit(S, HEAD7)
  stubSetup(S)
})

test('git refuses every push to GitHub when the prefix file is missing, a local push still passes, and a bad repo file refuses all', () => {
  const t = setup()
  passedGit(t, HEAD7)
  rmFile(join(t.plugin, 'routine/branch-prefix'))
  refusedGit(t, HEAD7)
  passedGit(t, ['push', '/x/bare.git', 'main'])
  passedGit(t, ['status'])
  writeFileSync(join(t.guard, 'repo'), 'bad\n')
  refusedGit(t, ['status'])
  refusedGit(t, ['push', '/x/bare.git', 'main'])
})

test('git refuses an unlisted global option, a command that sends by another route, and passes the listed globals', () => {
  for (const args of [['--exec-path=/x', 'status'], ['-p', 'status'], ['--namespace=x', 'status'], ['-c'], ['-C'], [], ['send-email'], ['remote-https'], ['svn', 'dcommit'], ['http-push'], ['send-pack'], ['subtree', 'push', '--prefix=x', 'origin', 'main'], ['imap-send'], ['p4', 'submit'], ['cvsexportcommit'], ['-Cx', 'status']]) refusedGit(S, args)
  for (const args of [['-C', 'x', '--no-pager', 'log'], ['--literal-pathspecs', '--no-replace-objects', 'status'], ['-c', 'user.name=t', 'commit', '-m', 'x'], ['--git-dir=/x/.git', 'worktree', 'list'], ['--git-dir', '/x/.git', 'branch', '-D', 'b'], ['tag', 'v1'], ['remote', 'add', 'o', 'x'], ['--version']]) passedGit(S, args)
})

test('git passes the commands of the repo checks on real repositories', () => {
  const repo = makeRepo(S)
  const real = (args, cwd = repo.work) => call(S, 'git', args, { kind: 'fake', cwd })
  const pass = (args, cwd) => { const r = real(args, cwd); assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`); assert.deepEqual(r.refusals, []); assert.ok(r.passes.length >= 1); return r }
  pass(['checkout', '-b', 'domain-main-fix'])
  writeFileSync(join(repo.work, 'b.txt'), 'b')
  pass(['add', '.'])
  pass(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'x'])
  const common = join(repo.work, '.git')
  assert.match(pass([`--git-dir=${common}`, 'worktree', 'list', '--porcelain']).out, /worktree /)
  pass(['push', repo.bare, 'domain-main-fix'])
  pass(['push', '-q', '-f', 'origin', 'domain-main-fix'])
  pass(['tag', 'v1'])
  pass(['clone', repo.bare, join(S.dir, 'cloned')], S.dir)
  const tagPush = ['push', 'origin', 'v1']
  assert.equal(real(tagPush).code, 0, 'a push to a local origin is local, so a tag push passes there')
  assert.equal(spawnSync('git', ['--git-dir', repo.bare, 'tag', '-l'], { encoding: 'utf8', env: cleanEnv() }).stdout.trim(), 'v1')
})

// A work clone of a local bare origin.
function makeRepo(s) {
  const base = mkdtempSync(join(s.dir, 'repo-'))
  const bare = join(base, 'origin.git'); const work = join(base, 'work')
  const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: cleanEnv() }); assert.equal(r.status, 0, r.stderr); return r.stdout }
  g(base, 'init', '--bare', '-b', 'main', bare)
  g(base, 'init', '-b', 'main', work)
  writeFileSync(join(work, 'a.txt'), 'a')
  g(work, 'add', '.')
  g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'one')
  g(work, 'remote', 'add', 'origin', bare)
  g(work, 'push', 'origin', 'main')
  return { base, bare, work, g }
}

// ---- the plugin's scripts through the wrappers ----

const io = (s, script, args, kind, extra = {}) => {
  const before = { ref: lines(s.refusalLog).length, pass: lines(s.passLog).length }
  const r = spawnSync('bash', [join(s.plugin, 'scripts/io.sh'), script, ...args], { env: envFor(s, kind, extra), encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr, refusals: lines(s.refusalLog).slice(before.ref), passes: lines(s.passLog).slice(before.pass) }
}
// Runs a script with and without the wrappers: same exit code and output, no refusal, and the wrapped run leaves pass lines.
const through = (s, script, args, { extra, want } = {}) => {
  const bare = io(s, script, args, 'none', extra)
  assert.deepEqual(bare.passes, [], 'a run without the wrappers leaves no pass line')
  const wrapped = io(s, script, args, 'fake', extra)
  assert.deepEqual(wrapped.refusals, [], `${script} was refused: ${wrapped.out}`)
  assert.equal(wrapped.code, bare.code, wrapped.out)
  assert.equal(wrapped.out, bare.out)
  assert.ok(wrapped.passes.length > 0, `${script} left no pass line`)
  if (want) assert.match(wrapped.out, want)
  return wrapped
}
const reset = () => { for (const f of readdirSync(S.fx)) rmFile(join(S.fx, f)) }

test('check-goals.sh and plugin-version.sh run through the wrappers, the release read of the plugin repo included', () => {
  reset()
  fixture('repos/o/r/contents/docs/goals.md', { content: Buffer.from('# Goals\n- a\n# Non-goals\n- b\n').toString('base64') })
  through(S, 'check-goals.sh', ['o/r', 'docs/goals.md'], { want: /goals=1 non-goals=1/ })
  fixture('repos/alfhen/agent-pr-pipeline/releases/latest', { tag_name: 'v9.9.9' })
  const r = through(S, 'plugin-version.sh', ['9.9.9'], { want: /^pipeline-io: begin\nOK\n/ })
  assert.ok(r.passes.some(l => l.startsWith('gh api repos/alfhen/agent-pr-pipeline/releases/latest')))
})

test('quick-brief.sh get, put and a changed put (the PATCH) run through the wrappers', () => {
  reset()
  fixture('user', { login: 'alfhen' })
  const user = { login: 'alfhen' }
  const old = 'Touches: src/a.js\nAcceptance: node --test passes'
  fixture('repos/o/r/issues/5/comments.1', [{ id: 1, user, body: 'Thanks' }])
  const entry = file('entry.md', 'Touches: src/b.js\nAcceptance: x')
  const sum = sumOf('Touches: src/b.js\nAcceptance: x')
  const first = through(S, 'quick-brief.sh', ['put', 'o/r', '5', entry, '--sum', sum])
  assert.ok(first.passes.some(l => l.startsWith('gh api --method POST repos/o/r/issues/5/comments')))

  fixture('repos/o/r/issues/5/comments.1', [{ id: 2, user, body: `<!-- pipeline:quick-brief ${sumOf(old)} -->\n${old}` }])
  fixture('repos/o/r/issues/comments/2', { body: `<!-- pipeline:quick-brief ${sumOf(old)} -->\n${old}` })
  const got = through(S, 'quick-brief.sh', ['get', 'o/r', '5'], { want: /Touches: src\/a\.js/ })
  assert.ok(got.passes.length > 0)
  const changed = through(S, 'quick-brief.sh', ['put', 'o/r', '5', entry, '--sum', sum])
  assert.ok(changed.passes.some(l => l.startsWith('gh api --method PATCH repos/o/r/issues/comments/2')), changed.passes.join('\n'))
})

test('gate-files.sh, bot-status.sh and wait-bots.sh run through the wrappers', () => {
  reset()
  const sha = 'a'.repeat(40)
  fixture('repos/o/r', { default_branch: 'main' })
  copyFileSync(join(root, 'test/fixtures/gate/pipeline.json'), join(S.fx, 'repos__o__r__contents__.github__pipeline.json.json'))
  copyFileSync(join(root, 'test/fixtures/gate/files/clean.1.json'), join(S.fx, 'repos__o__r__pulls__7__files.1.json'))
  through(S, 'gate-files.sh', ['o/r', '7'], { want: /not gated #7/ })
  fixture('repos/o/r/pulls/7', { head: { sha } })
  fixture(`repos/o/r/commits/${sha}/check-runs`, { check_runs: [] })
  fixture('repos/o/r/pulls/7/reviews', [])
  fixture('repos/o/r/pulls/7/comments', [])
  through(S, 'bot-status.sh', ['o/r', '7'], { want: /"head":"a{40}"/ })
  through(S, 'wait-bots.sh', ['o/r', '7', '1'], { extra: { WAIT_BOTS_INTERVAL: '0' }, want: /"timedOut":true/ })
})

test('cleanup.sh init, clones and worktrees run through the wrappers, the --git-dir calls included', () => {
  reset()
  const tmp = join(S.dir, 'pipeline-tmp')
  const init = through(S, 'cleanup.sh', ['init', tmp], { want: /MARKED/ })
  assert.ok(init.passes.some(l => l.startsWith('git ')))
  through(S, 'cleanup.sh', ['clones', tmp, '123'])

  const repo = makeRepo(S)
  const wt = join(repo.work, '.claude/worktrees/w1')
  repo.g(repo.work, 'branch', 'worktree-w1')
  repo.g(repo.work, 'worktree', 'add', wt, '-b', 'feat')
  const sha = repo.g(wt, 'rev-parse', 'HEAD').trim()
  const tip = repo.g(repo.work, 'rev-parse', 'refs/heads/worktree-w1').trim()
  fixture(`repos/o/r/commits/${sha}`, { sha })
  fixture(`repos/o/r/commits/${tip}`, { sha: tip })
  const r = io(S, 'cleanup.sh', ['worktrees', 'o/r', wt], 'fake')
  assert.deepEqual(r.refusals, [])
  assert.match(r.out, /REMOVED \S+ branch feat branch worktree-w1/)
  assert.doesNotMatch(r.out, /KEPT/)
  assert.ok(r.passes.some(l => l.startsWith('gh api repos/o/r/commits/')))
  assert.ok(r.passes.some(l => l.startsWith('git --git-dir=') && l.includes('worktree remove')))
  assert.ok(r.passes.some(l => l.startsWith('git --git-dir=') && l.includes('branch -D')))
  assert.ok(r.passes.some(l => l.startsWith('git --git-dir=') && l.includes('merge-base')))
  assert.ok(r.passes.some(l => l.startsWith('git --git-dir=') && l.includes('show-ref')))
  assert.ok(!existsSync(wt))
})

test('the checks of this repo that use git run through the git wrapper', () => {
  const t = setup()
  const copy = join(t.dir, 'copy')
  cpSync(root, copy, { recursive: true, filter: src => !['.git', 'node_modules'].includes(basename(src)) })
  const env = envFor(t, 'fake', { TMPDIR: mkdtempSync(join(t.dir, 'tmp-')) })
  delete env.NODE_TEST_CONTEXT
  // The copy's wrappers are the ones under test, not the guard's: the guard supplies repo and the prefix.
  env.PATH = `${join(t.plugin, 'routine/bin-full')}:${t.fakebin}:${process.env.PATH}`
  const syntax = spawnSync('bash', ['scripts/check-syntax.sh'], { cwd: copy, env, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stdout + syntax.stderr)
  const tests = spawnSync('node', ['--test', 'test/routine-guard.test.mjs', 'test/cleanup.test.mjs', 'test/land-commits.test.mjs'], { cwd: copy, env, encoding: 'utf8' })
  assert.equal(tests.status, 0, tests.stdout.slice(-3000) + tests.stderr)
  assert.deepEqual(lines(t.refusalLog), [])

  const passes = lines(t.passLog)

  assert.ok(passes.some(l => l.startsWith('git -c user.name=')), `a commit with -c passed: ${passes.length} lines, e.g. ${passes.slice(0, 5).join(' / ')}`)
  assert.ok(passes.some(l => /^git (-C \S+ )?push /.test(l) && !l.includes('github.com')), 'a push to a local path passed')
})

// ---- settings, prompt lines and deny rules ----

const G = '/g'
const full = JSON.parse(readFileSync(join(root, 'routine/settings/full.json'), 'utf8'))
const fill = r => r.replaceAll('OWNER/REPO', 'o/r').replaceAll('GUARD', G.slice(1)).replaceAll('WORK', 'w').replaceAll('STAGE', 'st')
const denyBash = rulesObj => rulesObj.permissions.deny.filter(r => r.startsWith('Bash(')).map(r => r.slice(5, -1))
const matches = (rule, cmd) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(cmd)
const denied = (rulesObj, cmd) => denyBash(rulesObj).some(r => matches(r, cmd))

test('the matcher tells a match from a miss', () => {
  assert.ok(matches('gh pr merge*', 'gh pr merge 3'))
  assert.ok(!matches('gh pr merge*', 'gh pr view 3'))
  assert.ok(matches('*merge*', 'a merge b'))
})

test('full.json holds the sandbox keys, no allow rule under the guard folder, and a deny rule for Edit and Write there', () => {
  const sb = full.sandbox
  assert.equal(sb.enabled, true)
  assert.equal(sb.failIfUnavailable, true)
  assert.equal(sb.allowUnsandboxedCommands, false)
  assert.deepEqual(sb.filesystem.allowWrite, ['/WORK'])
  assert.deepEqual(sb.filesystem.denyWrite, ['/GUARD'])
  assert.deepEqual(sb.network.allowedDomains, ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'uploads.github.com'])
  const allow = full.permissions.allow; const deny = full.permissions.deny
  for (const r of allow) assert.ok(!r.includes('//GUARD/**'), r)
  assert.ok(allow.includes('Read(//GUARD/plugin/**)'))
  for (const r of ['Edit(//GUARD/**)', 'NotebookEdit']) assert.ok(deny.includes(r), r)
  for (const role of ['implementer', 'pr-opener', 'bot-answerer', 'triager', 'evaluator']) {
    assert.ok(allow.includes(`Agent(${role})`) && allow.includes(`Agent(agent-pr-pipeline:${role})`), role)
  }
  for (const role of ['land-fixer', 'feedback-redactor', 'Explore', 'general-purpose']) assert.ok(deny.includes(`Agent(${role})`), role)
  const triage = JSON.parse(readFileSync(join(root, 'routine/settings/triage.json'), 'utf8'))
  for (const r of triage.permissions.deny.filter(x => /^Agent\((Explore|Plan|general-purpose|statusline-setup|claude-code-guide|output-style-setup|claude|web-fetch)\)$/.test(x))) assert.ok(deny.includes(r), r)
  assert.ok(!JSON.stringify(full).includes('"Edit"'))
})

// The commands that the prompts in workflows/run-wave.js tell an agent to run, read from the file.
function scrapePromptLines() {
  const text = readFileSync(join(root, 'workflows/run-wave.js'), 'utf8')
  const spans = [...text.matchAll(/\\`([^`]*?)\\`/g)].map(m => m[1])
  const out = new Set()
  for (const span of spans) {
    if (!/(^|&& )(gh|git) /.test(span)) continue
    for (const milestone of [' --milestone "0.7.0"', '']) {
      const filled = span
        .replace(/\$\{[^}]*\|\|\s*'([^']*)'\}/g, '$1')
        .replaceAll('${REPO}', 'o/r').replaceAll('${pr.branch}', 'routine/issue-7').replaceAll('${LABEL}', 'review-minor')
        .replaceAll('${MILESTONE}', milestone).replaceAll('${GOALS}', 'docs/goals.md').replaceAll('${TMP}', '/w/tmp')
        .replace(/\$\{(n|pr\.prNumber|pr\.quick\.issue)\}/g, '7')
        .replace(/\$\{[^}]*\}/g, 'x')
        .replaceAll('<file>', '@FILE@').replaceAll('<id>', '9').replaceAll('<run>', '5').replaceAll('<n>', '7')
      for (const part of filled.split(' && ')) {
        const cmd = part.split(' | ')[0].trim()
        if (/^(gh|git) \S+ \S+/.test(cmd)) out.add(cmd)
      }
    }
  }
  // The land fixer is denied in full.json, so its rerun is not a call a build session makes.
  return [...out].filter(l => !l.startsWith('gh run rerun'))
}

const need = [
  /^gh pr create -R o\/r --head routine\/issue-7 --body-file /, /^gh pr edit 7 -R o\/r --body-file /,
  /^gh issue create -R o\/r --label review-minor --body-file /, /^gh issue create -R o\/r --label review-minor --milestone "0\.7\.0" --body-file /,
  /^gh pr view 7 -R o\/r --json body$/, /^gh api repos\/o\/r\/pulls\/7\/comments\/9\/replies -F body=@/,
  /^git push -u origin routine\/issue-7$/, /^git push origin HEAD:routine\/issue-7$/, /^git fetch origin$/, /^git checkout -B /, /^git clone --branch /,
]

test('the scrape of the prompts finds the calls a quick wave makes', () => {
  const found = scrapePromptLines()
  for (const re of need) assert.ok(found.some(l => re.test(l)), `the scrape misses ${re}`)
})

test('no scraped prompt line is matched by a deny rule, and the mutation widened rule does match', () => {
  const rules = JSON.parse(fill(JSON.stringify(full)))
  const synthetic = ['gh api repos/o/r/pulls/3/comments/9/replies -F body=@/w/reply.txt # please merge this', 'git push origin HEAD:routine/domain-main-fix', 'git checkout -b domain-main-fix']
  const lines_ = [...scrapePromptLines(), ...synthetic]
  for (const l of lines_) assert.ok(!denied(rules, l.replace('@FILE@', '/w/body.txt')), `denied: ${l}`)
  assert.match(synthetic[0], /merge/, 'the synthetic reply line holds the word merge')
  const widened = JSON.parse(JSON.stringify(rules))
  widened.permissions.deny.push('Bash(gh api *merge*)')
  assert.ok(denied(widened, synthetic[0]), 'the matcher sees merge in the line')
})

test('every scraped prompt line runs through the wrappers, is passed, and reaches the real program', () => {
  const body = file('prompt-body.txt', 'A plain quick brief.\n')
  const found = scrapePromptLines()
  const reply = join(S.dir, 'files', 'reply.txt'); writeFileSync(reply, 'Thanks.\n')
  reset()
  for (const l of found) {
    const m = l.match(/^gh api (?:--paginate )?(\S+)/)
    if (m) fixture(m[1], {})
  }
  for (const l of found) {
    const cmd = l.replaceAll('@FILE@', body).replace(/(-F body=)@\S+/, `$1@${reply}`)
    const before = { ref: lines(S.refusalLog).length, pass: lines(S.passLog).length, gh: lines(S.ghLog).length, push: lines(join(S.stub, 'push.log')).length }
    const r = spawnSync('bash', ['-c', cmd], { env: envFor(S, 'stub'), encoding: 'utf8', cwd: S.dir })
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`)
    assert.deepEqual(lines(S.refusalLog).slice(before.ref), [], cmd)
    const passes = lines(S.passLog).slice(before.pass)
    assert.ok(passes.length >= 1, `no pass line for ${cmd}`)
    const prog = cmd.split(' ')[0]
    assert.ok(passes.every(p => p.startsWith(`${prog} `)))
    if (prog === 'gh') assert.ok(lines(S.ghLog).length > before.gh, `${cmd} did not reach gh`)
    if (/^git push /.test(cmd)) assert.equal(lines(join(S.stub, 'push.log')).length, before.push + 1, `${cmd} did not reach the push`)
  }
  assert.ok(found.length >= need.length)
})

test('each deny rule that names gh, a push or a script has its shape refused by the wrapper or names a script', () => {
  const shapes = {
    'gh pr merge*': ['gh', ['pr', 'merge', '3']],
    'gh release*': ['gh', ['release', 'create', 'v1']],
    'git push --force*': ['git', ['push', '--force', 'origin', 'HEAD:routine/issue-7']],
    'git push -f*': ['git', ['push', '-f', 'origin', 'HEAD:routine/issue-7']],
    'git push --tags*': ['git', ['push', '--tags', 'origin', 'HEAD:routine/issue-7']],
  }
  const rules = denyBash(full)
  const scriptRules = rules.filter(r => /^\*[a-z-]+\.sh\*$/.test(r))
  for (const r of rules) {
    if (r in shapes) {
      const [prog, args] = shapes[r]
      assert.ok(matches(r, `${prog} ${args.join(' ')}`), `the shape matches its rule: ${r}`)
      const res = call(S, prog, args, { kind: 'stub' })
      expectRefused(prog, args, res)
    } else if (scriptRules.includes(r)) {
      const name = r.slice(1, -1)
      assert.ok(existsSync(join(root, 'scripts', name)), `${name} is a script of the plugin`)
    } else assert.equal(r, 'git tag*', `unexpected deny rule ${r}`)
  }
  assert.deepEqual(scriptRules.map(r => r.slice(1, -1)).sort(), ['file-feedback.sh', 'land-wave.sh', 'merge-pr.sh', 'merge-wave.sh', 'release.sh', 'routine-state.sh'])
  // The same push without the forbidden flag passes, so the refusal above is for the flag.
  passedGit(S, ['push', 'origin', 'HEAD:routine/issue-7'])
  assert.equal(passedGit(S, ['tag', 'v1']).code, 0)
  refusedGit(S, ['push', 'origin', 'v1'])
  refusedGit(S, ['push', 'origin', 'refs/tags/v1'])
})
