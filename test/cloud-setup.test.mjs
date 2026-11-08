// Runs the script that cloud-setup.sh prints, and the apl-start it installs, against a stub curl that serves a
// temp copy of this plugin and test/fake-gh. HOME, the install root (APL_ROOT) and the launcher folder (APL_BIN)
// are temp folders, so nothing outside them is written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, cpSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const tmp = mkdtempSync(join(tmpdir(), 'cloud-setup-test-'))
const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: { ...process.env, ...ident, ...(opts.env || {}) } })
const git = (cwd, ...args) => { const r = sh('git', args, { cwd }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim() }

// A small plugin tree in a git repo, with its manifest.
const SHIPPED = ['agents', 'scripts', 'workflows', 'templates', 'skills', 'routine/config.jq', 'routine/branch-prefix', '.claude-plugin/plugin.json']
const plugin = join(tmp, 'plugin')
mkdirSync(join(plugin, 'routine'), { recursive: true }); mkdirSync(join(plugin, '.claude-plugin'))
for (const p of SHIPPED) cpSync(join(root, p), join(plugin, p), { recursive: true })
git(plugin, 'init', '-q', '-b', 'main'); git(plugin, 'add', '-A')
assert.equal(sh('bash', [join(root, 'scripts/manifest.sh'), '--write', plugin]).status, 0)
const files = readFileSync(join(plugin, '.claude-plugin/files.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '))
assert.ok(files.some(([, p]) => p === 'agents/tester.md') && files.some(([, p]) => p === 'scripts/cloud-setup.sh'))

const stubBin = join(tmp, 'stubbin'); mkdirSync(stubBin)
copyFileSync(join(root, 'test/fake-gh'), join(stubBin, 'gh')); chmodSync(join(stubBin, 'gh'), 0o755)
writeFileSync(join(stubBin, 'curl'), `#!/bin/bash
# Serves https://raw.githubusercontent.com/<owner>/<repo>/refs/tags/<tag>/<path> from $SERVE/<tag>/<path>.
# A bare <tag> ref is ambiguous with a branch, so it gets a 404. HEAD/<path> is served from $SERVE/HEAD/<path>.
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; --retry) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
echo "$url" >> "$CURL_LOG"
rest=\${url#https://raw.githubusercontent.com/*/*/}
case "$rest" in refs/tags/*) rest=\${rest#refs/tags/} ;; HEAD/*) ;; *) echo "curl: (22) 404 $url" >&2; exit 22 ;; esac
src="$SERVE/$rest"
[ -f "$src" ] || { echo "curl: (22) 404 $url" >&2; exit 22; }
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
`)
chmodSync(join(stubBin, 'curl'), 0o755)

let n = 0
// A fresh world: a serve folder with the given tags, and empty HOME, install root and launcher folder.
const world = (tags = ['v9.9.9']) => {
  const dir = join(tmp, `w${n++}`)
  const w = { dir, serve: join(dir, 'serve'), home: join(dir, 'home'), opt: join(dir, 'opt'), bin: join(dir, 'bin'), fx: join(dir, 'fx'), log: join(dir, 'gh.log'), curlLog: join(dir, 'curl.log') }
  for (const d of [w.serve, w.home, w.opt, w.bin, w.fx]) mkdirSync(d, { recursive: true })
  for (const t of tags) cpSync(plugin, join(w.serve, t), { recursive: true, filter: (s) => !s.endsWith('/.git') && !s.includes('/.git/') })
  return w
}
const env = (w) => ({ PATH: `${stubBin}:${process.env.PATH}`, HOME: w.home, APL_ROOT: w.opt, APL_BIN: w.bin, SERVE: w.serve, CURL_LOG: w.curlLog, FAKE_GH_FIXTURES: w.fx, FAKE_GH_LOG: w.log })
const print = (...args) => sh('bash', [join(root, 'scripts/cloud-setup.sh'), '--print', ...args])
const install = (w, tags = ['v9.9.9'], transform = (s) => s) => {
  const p = print(...tags, '--repo', 'o/r')
  assert.equal(p.status, 0, p.stderr)
  const script = join(w.dir, 'setup.sh'); writeFileSync(script, transform(p.stdout))
  return sh('bash', [script], { cwd: w.dir, env: env(w) })
}
const complete = (w, tag) => existsSync(join(w.opt, tag, '.complete'))

// A bare origin and a clone of it, with the repo settings that name the pin.
const setupRepo = (w, pin = 'v9.9.9') => {
  const origin = join(w.dir, 'origin.git'); const work = join(w.dir, 'work')
  git(w.dir, 'init', '-q', '--bare', '-b', 'main', origin); git(w.dir, 'clone', '-q', origin, work)
  git(work, 'checkout', '-q', '-B', 'main'); writeFileSync(join(work, 'a'), '1'); git(work, 'add', 'a'); git(work, 'commit', '-q', '-m', 'one'); git(work, 'push', '-q', 'origin', 'main')
  writeFileSync(join(w.fx, 'repos__o__r.json'), JSON.stringify({ default_branch: 'main' }))
  writeFileSync(join(w.fx, 'repos__o__r__contents__.github__pipeline.json.json'), JSON.stringify({ routine: { pipelineVersion: pin } }))
  return { origin, work }
}
const aplStart = (w, cwd) => {
  const r = sh('bash', [join(w.bin, 'apl-start'), 'o/r'], { cwd, env: env(w) })
  return { code: r.status, lines: r.stdout.split('\n').filter(Boolean), err: r.stderr }
}
const stopped = (r, reason, pin, rootLine) => {
  assert.equal(r.code, 1, r.lines.join('\n'))
  assert.match(r.lines[0], new RegExp(`^APL STOP ${reason}`))
  assert.equal(r.lines[1], `PIN ${pin}`)
  assert.equal(r.lines[2], rootLine)
  assert.equal(r.lines.length, 3)
}
const readOnly = (w) => (existsSync(w.log) ? readFileSync(w.log, 'utf8').split('\n').filter(Boolean) : []).filter((l) => !l.startsWith('GET '))

test('a good install: files, prefixed agents, .complete and a launcher that prints the line', () => {
  const w = world(); const { work } = setupRepo(w)
  const r = install(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  for (const [, p] of files) assert.ok(existsSync(join(w.opt, 'v9.9.9', p)), p)
  assert.ok(complete(w, 'v9.9.9'))
  const agent = readFileSync(join(w.home, '.claude/agents/apl-v9-9-9-tester.md'), 'utf8')
  assert.match(agent, /^---\nname: apl-v9-9-9-tester\n/)
  assert.equal(agent, readFileSync(join(root, 'agents/tester.md'), 'utf8').replace(/^name: tester$/m, 'name: apl-v9-9-9-tester'))
  assert.equal(readdirSync(join(w.home, '.claude/agents')).length, files.filter(([, p]) => /^agents\/[^/]+\.md$/.test(p)).length)
  assert.equal(readdirSync(w.opt).filter((f) => f.startsWith('.stage')).length, 0)
  const s = aplStart(w, work)
  assert.equal(s.code, 0, s.lines.join('\n') + s.err)
  assert.deepEqual(JSON.parse(s.lines[0]), { version: 'v9.9.9', pluginRoot: join(w.opt, 'v9.9.9'), agentPrefix: 'apl-v9-9-9-', defaultSha: git(work, 'rev-parse', 'origin/main') })
  assert.equal(s.lines.length, 1)
  assert.deepEqual(readOnly(w), [])
})

test('every fetch uses an explicit refs/tags/<tag> URL', () => {
  const w = world(); setupRepo(w)
  assert.equal(install(w).status, 0)
  const urls = readFileSync(w.curlLog, 'utf8').split('\n').filter(Boolean)
  assert.ok(urls.length > files.length)
  for (const u of urls) assert.match(u, /^https:\/\/raw\.githubusercontent\.com\/o\/r\/refs\/tags\/v9\.9\.9\//)
})

test('the setup script checks each file with git hash-object: a changed file in the served copy fails the install', () => {
  const w = world()
  writeFileSync(join(w.serve, 'v9.9.9/scripts/semver.sh'), '#!/bin/bash\necho changed\n')
  const r = install(w)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /hash mismatch: scripts\/semver\.sh/)
  assert.equal(complete(w, 'v9.9.9'), false)
  assert.equal(existsSync(join(w.opt, 'v9.9.9')), false)
})

test('a missing file fails the install and leaves no .complete', () => {
  const w = world()
  rmSync(join(w.serve, 'v9.9.9/scripts/semver.sh'))
  const r = install(w)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /fetch failed: scripts\/semver\.sh/)
  assert.equal(complete(w, 'v9.9.9'), false)
})

test('a missing files.txt fails the install', () => {
  const w = world()
  rmSync(join(w.serve, 'v9.9.9/.claude-plugin/files.txt'))
  const r = install(w)
  assert.notEqual(r.status, 0)
  assert.equal(complete(w, 'v9.9.9'), false)
})

test('a failed update of an installed tag leaves the earlier good install as it was', () => {
  const w = world()
  assert.equal(install(w).status, 0)
  assert.ok(complete(w, 'v9.9.9'))
  writeFileSync(join(w.serve, 'v9.9.9/scripts/semver.sh'), 'changed')
  assert.equal(install(w).status, 1)
  assert.ok(complete(w, 'v9.9.9'))
  assert.equal(readFileSync(join(w.opt, 'v9.9.9/scripts/semver.sh'), 'utf8'), readFileSync(join(root, 'scripts/semver.sh'), 'utf8'))
  assert.equal(readdirSync(w.opt).filter((f) => f.startsWith('.stage')).length, 0)
})

test('a tag that is not v<major>.<minor>.<patch> is refused, when printing and in the printed script', () => {
  for (const bad of ['v1.2', '1.2.3', 'v1.2.3-rc.1', 'v1.2.3/../x', 'main']) {
    const p = print(bad)
    assert.equal(p.status, 2, bad)
    assert.equal(p.stdout, '')
  }
  const w = world()
  const r = install(w, ['v9.9.9'], (s) => s.replace('NAMED=(v9.9.9)', 'NAMED=(v9.9)'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /bad tag: v9\.9/)
  assert.deepEqual(readdirSync(w.opt), [])
})

test('two tags side by side keep their own folders and agent names', () => {
  const w = world(['v9.9.9', 'v9.9.8'])
  const r = install(w, ['v9.9.8', 'v9.9.9'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(complete(w, 'v9.9.8') && complete(w, 'v9.9.9'))
  for (const v of ['v9-9-8', 'v9-9-9']) assert.match(readFileSync(join(w.home, `.claude/agents/apl-${v}-tester.md`), 'utf8'), new RegExp(`^---\\nname: apl-${v}-tester\\n`))
})

test('the printed script is self-contained and under 64 KB', () => {
  const p = print('v9.9.9', 'v9.9.8', '--repo', 'o/r')
  assert.ok(p.stdout.length < 64 * 1024, `${p.stdout.length} bytes`)
  assert.match(p.stdout, /RAW=https:\/\/raw\.githubusercontent\.com\/\$REPO/)
  assert.match(p.stdout, /^REPO=o\/r$/m)
  assert.doesNotMatch(p.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(p.stdout, /xargs -P 8/)
  assert.match(p.stdout, /curl -fsSL --retry 3/)
  assert.equal(sh('bash', ['-n'], { input: p.stdout }).status, 0)
})

test('without --repo the script uses the repository of the plugin manifest', () => {
  assert.match(print('v9.9.9').stdout, /^REPO=alfhen\/agent-pr-pipeline$/m)
})

test('apl-start with the pin not installed and an older release installed stops with PIN and the older ROOT, and writes nothing', () => {
  const w = world(['v9.9.8']); const { work } = setupRepo(w, 'v9.9.9')
  assert.equal(install(w, ['v9.9.8']).status, 0)
  stopped(aplStart(w, work), 'release v9\\.9\\.9 is not installed', 'v9.9.9', `ROOT ${join(w.opt, 'v9.9.8')}`)
  assert.deepEqual(readOnly(w), [])
})

test('apl-start names the highest installed release in ROOT, and none when nothing is installed', () => {
  const w = world(['v9.9.8', 'v9.10.0']); const { work } = setupRepo(w, 'v9.9.9')
  assert.equal(install(w, ['v9.9.8', 'v9.10.0']).status, 0)
  stopped(aplStart(w, work), 'release v9\\.9\\.9 is not installed', 'v9.9.9', `ROOT ${join(w.opt, 'v9.10.0')}`)
  rmSync(join(w.opt, 'v9.9.8', '.complete')); rmSync(join(w.opt, 'v9.10.0', '.complete'))
  stopped(aplStart(w, work), 'release v9\\.9\\.9 is not installed', 'v9.9.9', 'ROOT none')
})

test('apl-start fetches first: a clone one commit behind origin gets the new defaultSha', () => {
  const w = world(); const { origin, work } = setupRepo(w)
  assert.equal(install(w).status, 0)
  const other = join(w.dir, 'other')
  git(w.dir, 'clone', '-q', origin, other); writeFileSync(join(other, 'b'), '2'); git(other, 'add', 'b'); git(other, 'commit', '-q', '-m', 'two'); git(other, 'push', '-q', 'origin', 'main')
  const newer = git(other, 'rev-parse', 'HEAD')
  assert.notEqual(git(work, 'rev-parse', 'origin/main'), newer)
  const s = aplStart(w, work)
  assert.equal(s.code, 0, s.lines.join('\n'))
  assert.equal(JSON.parse(s.lines[0]).defaultSha, newer)
})

test('apl-start with an origin that cannot be fetched stops with fetch failed', () => {
  const w = world(); const { work } = setupRepo(w)
  assert.equal(install(w).status, 0)
  git(work, 'remote', 'set-url', 'origin', join(w.dir, 'nowhere.git'))
  const r = aplStart(w, work)
  assert.equal(r.code, 1)
  assert.equal(r.lines[0], 'APL STOP fetch failed')
  assert.equal(r.lines.length, 3)
  assert.doesNotMatch(r.lines.join('\n'), /pluginRoot/)
})

test('apl-start with a pin that is not a release tag stops', () => {
  const w = world(); const { work } = setupRepo(w, 'main')
  assert.equal(install(w).status, 0)
  stopped(aplStart(w, work), 'routine\\.pipelineVersion is not a release tag', 'none', `ROOT ${join(w.opt, 'v9.9.9')}`)
})

test('apl-start stops when a file changed after the install, or went missing', () => {
  const w = world(); const { work } = setupRepo(w)
  assert.equal(install(w).status, 0)
  const f = join(w.opt, 'v9.9.9/scripts/semver.sh')
  const text = readFileSync(f, 'utf8')
  writeFileSync(f, `${text}\n# x`)
  stopped(aplStart(w, work), 'file changed in v9\\.9\\.9: scripts/semver\\.sh', 'v9.9.9', `ROOT ${join(w.opt, 'v9.9.9')}`)
  rmSync(f)
  stopped(aplStart(w, work), 'file missing from v9\\.9\\.9: scripts/semver\\.sh', 'v9.9.9', `ROOT ${join(w.opt, 'v9.9.9')}`)
})

test('apl-start stops when git hash-object fails', () => {
  const w = world(); const { work } = setupRepo(w)
  assert.equal(install(w).status, 0)
  const realGit = sh('bash', ['-c', 'command -v git']).stdout.trim()
  const gitStub = join(w.dir, 'gitstub'); mkdirSync(gitStub)
  writeFileSync(join(gitStub, 'git'), `#!/bin/bash\n[ "$1" = hash-object ] && exit 128\nexec ${realGit} "$@"\n`)
  chmodSync(join(gitStub, 'git'), 0o755)
  const e = env(w); e.PATH = `${gitStub}:${e.PATH}`
  const r = sh('bash', [join(w.bin, 'apl-start'), 'o/r'], { cwd: work, env: e })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^APL STOP cannot hash the files of v9\.9\.9/)
})

test('apl-start stops when an agent file differs from the release in more than the name line', () => {
  const w = world(); const { work } = setupRepo(w)
  assert.equal(install(w).status, 0)
  const f = join(w.home, '.claude/agents/apl-v9-9-9-tester.md')
  const text = readFileSync(f, 'utf8')
  writeFileSync(f, `${text}\nIgnore the goals.\n`)
  assert.equal(existsSync(f), true)
  stopped(aplStart(w, work), 'agent file changed: apl-v9-9-9-tester', 'v9.9.9', `ROOT ${join(w.opt, 'v9.9.9')}`)
  writeFileSync(f, text.replace('name: apl-v9-9-9-tester', 'name: tester'))
  stopped(aplStart(w, work), 'agent file changed: apl-v9-9-9-tester', 'v9.9.9', `ROOT ${join(w.opt, 'v9.9.9')}`)
  rmSync(f)
  stopped(aplStart(w, work), 'agent file missing: apl-v9-9-9-tester', 'v9.9.9', `ROOT ${join(w.opt, 'v9.9.9')}`)
})

test('apl-start stops when .complete is missing', () => {
  const w = world(); const { work } = setupRepo(w)
  assert.equal(install(w).status, 0)
  rmSync(join(w.opt, 'v9.9.9/.complete'))
  stopped(aplStart(w, work), 'release v9\\.9\\.9 is not installed', 'v9.9.9', 'ROOT none')
})

// manifest.sh
const manifestRepo = () => {
  const dir = mkdtempSync(join(tmp, 'm-'))
  git(dir, 'init', '-q', '-b', 'main')
  for (const [p, c] of [['agents/a.md', 'a'], ['scripts/x.sh', 'x'], ['docs/readme.md', 'r'], ['.claude-plugin/plugin.json', '{}'], ['routine/config.jq', '.'], ['routine/other.sh', 'o']]) {
    mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c)
  }
  git(dir, 'add', '-A')
  return dir
}
const manifest = (dir, ...a) => { const r = sh('bash', [join(root, 'scripts/manifest.sh'), ...a, dir]); return { code: r.status, out: r.stdout.trim() } }

test('manifest.sh --write lists the shipped files sorted, and --check says OK', () => {
  const dir = manifestRepo()
  assert.equal(manifest(dir, '--write').code, 0)
  const lines = readFileSync(join(dir, '.claude-plugin/files.txt'), 'utf8').trim().split('\n')
  assert.deepEqual(lines.map((l) => l.split(' ')[1]), ['.claude-plugin/plugin.json', 'agents/a.md', 'routine/config.jq', 'scripts/x.sh'])
  assert.equal(lines[1].split(' ')[0], git(dir, 'hash-object', 'agents/a.md'))
  assert.deepEqual(manifest(dir, '--check'), { code: 0, out: 'MANIFEST OK' })
})

test('manifest.sh --check names a changed, an added and a missing file', () => {
  const dir = manifestRepo()
  manifest(dir, '--write')
  writeFileSync(join(dir, 'agents/a.md'), 'changed'); writeFileSync(join(dir, 'scripts/new.sh'), 'n')
  git(dir, 'rm', '-q', '-f', 'scripts/x.sh'); git(dir, 'add', '-A')
  const r = manifest(dir, '--check')
  assert.equal(r.code, 1)
  assert.deepEqual(r.out.split('\n'), ['MANIFEST changed agents/a.md', 'MANIFEST added scripts/new.sh', 'MANIFEST missing scripts/x.sh'])
})

test('manifest.sh --check without a files.txt fails', () => {
  const r = manifest(manifestRepo(), '--check')
  assert.equal(r.code, 1)
  assert.equal(r.out, 'MANIFEST missing .claude-plugin/files.txt')
})

const realGit = sh('bash', ['-c', 'command -v git']).stdout.trim()
writeFileSync(join(stubBin, 'git'), `#!/bin/bash
# Answers ls-remote from $LS_REMOTE (a file), or fails when $LS_FAIL is set; passes every other command to git.
if [ "$1" = ls-remote ]; then
  echo "$@" >> "$CURL_LOG"
  [ -z "\${LS_FAIL:-}" ] || { echo "fatal: unable to access" >&2; exit 128; }
  cat "$LS_REMOTE"; exit 0
fi
exec ${realGit} "$@"
`)
chmodSync(join(stubBin, 'git'), 0o755)

const SHA = 'a'.repeat(40)
const latest = (w, remoteTags, args, extra = {}, cap = "1.0.0") => {
  if (cap) { mkdirSync(join(w.serve, "HEAD/.claude-plugin"), { recursive: true }); writeFileSync(join(w.serve, "HEAD/.claude-plugin/plugin.json"), JSON.stringify({ version: cap })) }
  writeFileSync(join(w.dir, 'ls.txt'), remoteTags.map((t) => `${SHA}\trefs/tags/${t}`).join('\n') + (remoteTags.length ? '\n' : ''))
  const p = print('--latest', ...args, '--repo', 'o/r')
  assert.equal(p.status, 0, p.stderr)
  const script = join(w.dir, 'setup.sh'); writeFileSync(script, p.stdout)
  return sh('bash', [script], { cwd: w.dir, env: { ...env(w), LS_REMOTE: join(w.dir, 'ls.txt'), ...extra } })
}
const installed = (w) => readdirSync(w.opt).filter((f) => existsSync(join(w.opt, f, '.complete'))).sort()

test('--latest 3 installs the newest three tags at or above v0.8.0, by version order', () => {
  const w = world(['v0.8.0', 'v0.8.1', 'v0.9.0', 'v0.10.0'])
  const r = latest(w, ['v0.7.0', 'v0.8.0', 'v1.0.0-rc1', 'v0.8.1', 'v0.10.0', 'v0.9.0'], ['3'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(installed(w), ['v0.10.0', 'v0.8.1', 'v0.9.0'])
  assert.ok(existsSync(join(w.home, '.claude/agents/apl-v0-10-0-tester.md')))
  assert.match(readFileSync(w.curlLog, 'utf8'), /ls-remote --tags --refs https:\/\/github\.com\/o\/r refs\/tags\/v\*/)
})

test('--latest ignores a tag below v0.8.0 and a pre-release tag', () => {
  const w = world(['v0.8.0'])
  const r = latest(w, ['v0.7.9', 'v1.0.0-rc1', 'v0.8.0'], ['3'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(installed(w), ['v0.8.0'])
})

test('--latest adds a named older tag once, even when it is also among the newest', () => {
  const w = world(['v0.8.0', 'v0.8.1', 'v0.9.0'])
  const r = latest(w, ['v0.8.0', 'v0.8.1', 'v0.9.0'], ['1', 'v0.8.0', 'v0.9.0'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(installed(w), ['v0.8.0', 'v0.9.0'])
  const fetches = readFileSync(w.curlLog, 'utf8').split('\n').filter((u) => u.endsWith('/refs/tags/v0.9.0/.claude-plugin/files.txt'))
  assert.equal(fetches.length, 1)
})

test('--latest with a failed ls-remote and no named tag exits 1 and installs nothing', () => {
  const w = world(['v0.8.0'])
  const r = latest(w, ['v0.8.0'], ['3'], { LS_FAIL: '1' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /tag lookup failed/)
  assert.deepEqual(installed(w), [])
  assert.equal(existsSync(join(w.bin, 'apl-start')), false)
})

test('--latest with a failed ls-remote still installs the named tags', () => {
  const w = world(['v0.8.0'])
  const r = latest(w, ['v0.8.0'], ['3', 'v0.8.0'], { LS_FAIL: '1' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stderr, /tag lookup failed/)
  assert.deepEqual(installed(w), ['v0.8.0'])
})

test('--latest ignores a remote tag above the version of the default branch', () => {
  const w = world(['v0.8.0', 'v0.8.1', 'v99.0.0'])
  const r = latest(w, ['v0.8.0', 'v0.8.1', 'v99.0.0', 'v0.9.0'], ['3'], {}, '0.8.1')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(installed(w), ['v0.8.0', 'v0.8.1'])
  assert.equal(readFileSync(w.curlLog, 'utf8').includes('v99.0.0'), false)
})

test('--latest with an unreadable default branch version installs only the named tags', () => {
  const w = world(['v0.8.0', 'v0.8.1'])
  const r = latest(w, ['v0.8.0', 'v0.8.1'], ['3', 'v0.8.0'], {}, null)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stderr, /cannot read the version/)
  assert.deepEqual(installed(w), ['v0.8.0'])
})

test('apl-start never names a release that --latest found but no one named as ROOT', () => {
  const w = world(['v9.9.8', 'v9.10.0']); const { work } = setupRepo(w, 'v9.9.9')
  const r = latest(w, ['v9.9.8', 'v9.10.0'], ['3', 'v9.9.8'], {}, '99.0.0')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(installed(w), ['v9.10.0', 'v9.9.8'])
  stopped(aplStart(w, work), 'release v9\\.9\\.9 is not installed', 'v9.9.9', `ROOT ${join(w.opt, 'v9.9.8')}`)
  rmSync(join(w.opt, 'v9.9.8', '.named'))
  stopped(aplStart(w, work), 'release v9\\.9\\.9 is not installed', 'v9.9.9', 'ROOT none')
})

test('--latest with no tag found exits 1 and installs nothing', () => {
  const w = world(['v0.8.0'])
  const r = latest(w, ['v0.7.0', 'v1.0.0-rc1'], ['3'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no release tag found/)
  assert.deepEqual(installed(w), [])
})

test('--latest needs a count of 1 or more; --print with no tag and no --latest is still a usage error', () => {
  assert.equal(print('--latest', '0', '--repo', 'o/r').status, 2)
  assert.equal(print('--latest', 'x', '--repo', 'o/r').status, 2)
  assert.equal(print('--repo', 'o/r').status, 2)
})
