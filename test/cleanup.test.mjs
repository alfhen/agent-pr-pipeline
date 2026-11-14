// Runs cleanup.sh against a real temporary git repo with worktrees, and test/fake-gh for the GitHub commits call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
for (const target of ['T01', '--all']) {
  test(`clones prints KEPT when a folder cannot be deleted (${target})`, () => {
    const t = build()
    run(t, ['init', t.tmp])
    mkdirs(t, 'test-T01-r1')
    const locked = join(t.tmp, 'test-T01-r1', 'locked')
    mkdirSync(locked); writeFileSync(join(locked, 'f'), 'x'); chmodSync(locked, 0o555)
    try {
      const r = run(t, ['clones', t.tmp, target])
      assert.equal(r.status, 0)
      assert.match(r.out, /^KEPT .*test-T01-r1 cannot delete$/m)
      assert.doesNotMatch(r.out, /^REMOVED /m)
    } finally { chmodSync(locked, 0o755) }
  })
}

const GIT_ENV ={ ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
  return { status: r.status, out: r.stdout.trim() }
}
const must = (cwd, ...args) => { const r = git(cwd, ...args); assert.equal(r.status, 0, args.join(' ')); return r.out }

// repo has one commit on main; fx holds the GitHub commits fixtures; tmp holds clone folders.
const build = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-test-')))
  const repo = join(dir, 'repo'); const bin = join(dir, 'bin'); const fx = join(dir, 'fx'); const tmp = join(dir, 'tmp'); const home = join(dir, 'home')
  for (const d of [repo, bin, fx, tmp, home]) mkdirSync(d)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  must(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n'); must(repo, 'add', '.'); must(repo, 'commit', '-qm', 'base')
  const t = { dir, repo, bin, fx, tmp, home }
  t.onGitHub = sha => writeFileSync(join(fx, `repos__o__r__commits__${sha}.json`), JSON.stringify({ sha }))
  t.worktree = (name, { onGitHub = true } = {}) => {
    const path = join(repo, '.claude/worktrees', name)
    must(repo, 'worktree', 'add', '-q', '-b', `branch-${name}`, path)
    if (onGitHub) t.onGitHub(must(path, 'rev-parse', 'HEAD'))
    return path
  }
  return t
}
const run = (t, args, env = {}) => {
  const r = spawnSync('bash', [join(root, 'scripts/cleanup.sh'), ...args], {
    cwd: t.dir, encoding: 'utf8', env: { ...GIT_ENV, PATH: `${t.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: t.fx, HOME: t.home, ...env },
  })
  return { status: r.status, out: r.stdout + r.stderr, lines: (r.stdout + r.stderr).split('\n').filter(Boolean) }
}
const branches = t => must(t.repo, 'branch', '--format=%(refname:short)').split('\n')
const mkdirs = (t, ...names) => names.forEach(n => { mkdirSync(join(t.tmp, n)); writeFileSync(join(t.tmp, n, 'f'), 'x') })

test('init writes the marker and refuses /, the home folder and the top of a git repo', () => {
  const t = build()
  const ok = run(t, ['init', t.tmp])
  assert.equal(ok.status, 0)
  assert.match(ok.out, /^MARKED /)
  assert.ok(existsSync(join(t.tmp, '.pipeline-tmp')))
  for (const bad of ['/', t.home, t.repo]) {
    const r = run(t, ['init', bad])
    assert.equal(r.status, 0, bad)
    assert.match(r.out, /^KEPT .* refused/, bad)
  }
  assert.ok(!existsSync(join(t.home, '.pipeline-tmp')))
  assert.ok(!existsSync(join(t.repo, '.pipeline-tmp')))
  assert.ok(!existsSync('/.pipeline-tmp'))
})

test('init refuses shared temp folders and unmarked folders that hold folders, and accepts a marked one', () => {
  const t = build()
  for (const shared of ['/tmp', '/private/tmp'].filter(existsSync)) {
    const r = run(t, ['init', shared])
    assert.match(r.out, /refused: shared temp folder/, shared)
    assert.ok(!existsSync(join(shared, '.pipeline-tmp')), shared)
  }
  assert.match(run(t, ['init', t.tmp], { TMPDIR: t.tmp }).out, /^KEPT .* refused/)
  mkdirs(t, 'other-project')
  assert.match(run(t, ['init', t.tmp]).out, /^KEPT .* refused/)
  assert.ok(!existsSync(join(t.tmp, '.pipeline-tmp')))
  assert.match(run(t, ['clones', t.tmp, '--all']).out, /^KEPT/)
  assert.ok(existsSync(join(t.tmp, 'other-project/f')))
  writeFileSync(join(t.tmp, '.pipeline-tmp'), '')
  assert.match(run(t, ['init', t.tmp]).out, /^MARKED /)
})

test('clones deletes nothing in a refused folder even when a marker is there', () => {
  const t = build()
  mkdirs(t, 'test-T01-r1')
  writeFileSync(join(t.tmp, '.pipeline-tmp'), '')
  for (const args of [['clones', t.tmp, '--all'], ['clones', t.tmp, 'T01']]) {
    const r = run(t, args, { TMPDIR: t.tmp })
    assert.match(r.out, /^KEPT .* refused: shared temp folder/, args.join(' '))
    assert.ok(existsSync(join(t.tmp, 'test-T01-r1')))
  }
  must(t.tmp, 'init', '-q')
  assert.match(run(t, ['clones', t.tmp, '--all']).out, /^KEPT .* refused: top of a git repo/)
  assert.ok(existsSync(join(t.tmp, 'test-T01-r1')))
})

test('clones deletes nothing without the marker', () => {
  const t = build()
  mkdirs(t, 'test-T01-r1')
  const r = run(t, ['clones', t.tmp, 'T01'])
  assert.equal(r.status, 0)
  assert.match(r.out, /KEPT .* no \.pipeline-tmp marker/)
  assert.ok(existsSync(join(t.tmp, 'test-T01-r1')))
  run(t, ['clones', t.tmp, '--all'])
  assert.ok(existsSync(join(t.tmp, 'test-T01-r1')))
})

test('clones deletes only the folders of the given id', () => {
  const t = build()
  run(t, ['init', t.tmp])
  mkdirs(t, 'test-T01-r1', 'test-T01-docs1', 'safety-T01', 'test-T011-r1', 'test-T02-r1', 'T01')
  const r = run(t, ['clones', t.tmp, 'T01'])
  assert.equal(r.status, 0)
  for (const gone of ['test-T01-r1', 'test-T01-docs1', 'safety-T01']) assert.ok(!existsSync(join(t.tmp, gone)), gone)
  for (const kept of ['test-T011-r1', 'test-T02-r1', 'T01']) assert.ok(existsSync(join(t.tmp, kept)), kept)
  assert.equal(r.lines.filter(l => l.startsWith('REMOVED ')).length, 3)
})

test('clones refuses an id with a glob or a slash', () => {
  const t = build()
  run(t, ['init', t.tmp])
  mkdirs(t, 'test-T01-r1', 'safety-T02')
  for (const id of ['*', 'T01/../..', '']) {
    const r = run(t, ['clones', t.tmp, id])
    assert.equal(r.status, 0)
    assert.match(r.out, /^KEPT /)
  }
  assert.ok(existsSync(join(t.tmp, 'test-T01-r1')) && existsSync(join(t.tmp, 'safety-T02')))
})

test('clones --all removes every folder and keeps the marker', () => {
  const t = build()
  run(t, ['init', t.tmp])
  mkdirs(t, 'test-T01-r1', 'safety-T02', 'land-commits.abc')
  const r = run(t, ['clones', t.tmp, '--all'])
  assert.equal(r.status, 0)
  assert.equal(r.lines.filter(l => l.startsWith('REMOVED ')).length, 3)
  for (const n of ['test-T01-r1', 'safety-T02', 'land-commits.abc']) assert.ok(!existsSync(join(t.tmp, n)), n)
  assert.ok(existsSync(join(t.tmp, '.pipeline-tmp')))
})

test('a clean worktree whose head is on GitHub is removed with its branch', () => {
  const t = build()
  const wt = t.worktree('clean')
  const r = run(t, ['worktrees', 'o/r', wt])
  assert.equal(r.status, 0)
  assert.match(r.out, /^REMOVED .*clean branch branch-clean/)
  assert.ok(!existsSync(wt))
  assert.ok(!branches(t).includes('branch-clean'))
})

test('the worktree-<name> branch Claude Code makes is deleted too, once the writer has switched branches', () => {
  const t = build()
  const wt = join(t.repo, '.claude/worktrees/wf_x-1')
  must(t.repo, 'worktree', 'add', '-q', '-b', 'worktree-wf_x-1', wt)
  must(wt, 'checkout', '-q', '-B', 'other')
  t.onGitHub(must(wt, 'rev-parse', 'HEAD'))
  const r = run(t, ['worktrees', 'o/r', wt])
  assert.match(r.out, /^REMOVED .*branch other branch worktree-wf_x-1/)
  assert.ok(!existsSync(wt))
  assert.ok(!branches(t).includes('other'))
  assert.ok(!branches(t).includes('worktree-wf_x-1'))
})

test('the worktree-<name> branch is kept when it holds commits not on GitHub', () => {
  const t = build()
  const wt = join(t.repo, '.claude/worktrees/wf_y-1')
  must(t.repo, 'worktree', 'add', '-q', '-b', 'worktree-wf_y-1', wt)
  writeFileSync(join(wt, 'b.txt'), 'b\n'); must(wt, 'add', '.'); must(wt, 'commit', '-qm', 'work')
  must(wt, 'checkout', '-q', '-B', 'other', 'main')
  t.onGitHub(must(wt, 'rev-parse', 'HEAD'))
  const r = run(t, ['worktrees', 'o/r', wt])
  assert.match(r.out, /branch worktree-wf_y-1 kept: tip .* is not on GitHub/)
  assert.ok(branches(t).includes('worktree-wf_y-1'))
})

test('a detached worktree is removed and no branch is touched', () => {
  const t = build()
  const wt = t.worktree('detached')
  must(wt, 'checkout', '-q', '--detach')
  const r = run(t, ['worktrees', 'o/r', wt])
  assert.match(r.out, /^REMOVED /)
  assert.ok(!existsSync(wt))
  assert.ok(branches(t).includes('branch-detached'))
})

test('worktrees that are not safe to delete are kept with a reason, and the exit code is 0', () => {
  const t = build()
  const modified = t.worktree('modified'); writeFileSync(join(modified, 'a.txt'), 'changed\n')
  const untracked = t.worktree('untracked'); writeFileSync(join(untracked, 'new.txt'), 'new\n')
  const unpushed = t.worktree('unpushed', { onGitHub: false })
  writeFileSync(join(unpushed, 'b.txt'), 'b\n'); must(unpushed, 'add', '.'); must(unpushed, 'commit', '-qm', 'local only')
  const locked = t.worktree('locked'); must(t.repo, 'worktree', 'lock', locked)
  const outside = join(t.dir, 'outside'); must(t.repo, 'worktree', 'add', '-q', '-b', 'branch-outside', outside); t.onGitHub(must(outside, 'rev-parse', 'HEAD'))
  const cases = [[modified, /uncommitted or untracked/], [untracked, /uncommitted or untracked/], [unpushed, /is not on GitHub/], [locked, /git worktree remove refused/], [outside, /not under a \.claude\/worktrees/], [t.repo, /not under a \.claude\/worktrees/], [join(t.dir, 'missing'), /not a folder/]]
  const r = run(t, ['worktrees', 'o/r', ...cases.map(c => c[0])])
  assert.equal(r.status, 0)
  assert.equal(r.lines.length, cases.length)
  cases.forEach(([p, why], i) => { assert.match(r.lines[i], new RegExp(`^KEPT ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `)); assert.match(r.lines[i], why) })
  for (const p of [modified, untracked, unpushed, locked, outside, t.repo]) assert.ok(existsSync(p), p)
  for (const b of ['branch-modified', 'branch-untracked', 'branch-unpushed', 'branch-locked', 'branch-outside']) assert.ok(branches(t).includes(b), b)
})

test('a worktree is kept when GitHub does not answer', () => {
  const t = build()
  const wt = t.worktree('quiet', { onGitHub: false })
  const r = run(t, ['worktrees', 'o/r', wt])
  assert.equal(r.status, 0)
  assert.match(r.out, /is not on GitHub/)
  assert.ok(existsSync(wt))
})

test('the script never forces a worktree removal', () => {
  const src = readFileSync(join(root, 'scripts/cleanup.sh'), 'utf8')
  assert.match(src, /worktree remove/)
  assert.doesNotMatch(src, /worktree remove[^\n]*(--force| -f\b)/)
})

test('a usage error exits 2', () => {
  const t = build()
  assert.equal(run(t, []).status, 2)
  assert.equal(run(t, ['worktrees', 'o/r']).status, 2)
  assert.equal(run(t, ['clones', t.tmp]).status, 2)
})

test('clones keeps the open folder of each keep id, per id and with --all', () => {
  const t = build()
  run(t, ['init', t.tmp])
  mkdirs(t, 'open-T01', 'test-T01-r1', 'safety-T01', 'open-T02', 'test-T02-r1')
  const r = run(t, ['clones', t.tmp, 'T01', 'T01'])
  assert.equal(r.status, 0)
  for (const kept of ['open-T01', 'open-T02', 'test-T02-r1']) assert.ok(existsSync(join(t.tmp, kept)), kept)
  for (const gone of ['test-T01-r1', 'safety-T01']) assert.ok(!existsSync(join(t.tmp, gone)), gone)
  const u = build()
  run(u, ['init', u.tmp])
  mkdirs(u, 'open-T01', 'test-T01-r1', 'safety-T01', 'open-T02', 'test-T02-r1')
  assert.equal(run(u, ['clones', u.tmp, '--all', 'T01']).status, 0)
  assert.ok(existsSync(join(u.tmp, 'open-T01')) && existsSync(join(u.tmp, '.pipeline-tmp')))
  for (const gone of ['open-T02', 'test-T01-r1', 'safety-T01', 'test-T02-r1']) assert.ok(!existsSync(join(u.tmp, gone)), gone)
  for (const args of [['T01'], ['--all']]) {
    const v = build()
    run(v, ['init', v.tmp])
    mkdirs(v, 'open-T01')
    assert.equal(run(v, ['clones', v.tmp, ...args]).status, 0)
    assert.ok(!existsSync(join(v.tmp, 'open-T01')), args.join(' '))
  }
})

test('keep words do not weaken the refusals of clones', () => {
  const t = build()
  run(t, ['init', t.tmp])
  mkdirs(t, 'test-T01-r1', 'open-T01', 'safety-T02')
  for (const id of ['*', 'T01/../..']) {
    const r = run(t, ['clones', t.tmp, id, 'T01'])
    assert.equal(r.status, 0)
    assert.match(r.out, /^KEPT /)
  }
  for (const n of ['test-T01-r1', 'open-T01', 'safety-T02']) assert.ok(existsSync(join(t.tmp, n)), n)
  const u = build()
  mkdirs(u, 'test-T01-r1')
  const r = run(u, ['clones', u.tmp, '--all', 'T01'])
  assert.equal(r.status, 0)
  assert.match(r.out, /^KEPT /)
  assert.ok(existsSync(join(u.tmp, 'test-T01-r1')))
})
