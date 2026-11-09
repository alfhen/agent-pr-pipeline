// Runs land-commits.sh against a real temporary git repo (LAND_COMMITS_REMOTE replaces the GitHub URL).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
  return { status: r.status, out: r.stdout.trim() }
}
const must = (cwd, ...args) => { const r = git(cwd, ...args); assert.equal(r.status, 0, args.join(' ')); return r.out }
const commit = (cwd, file, text, msg) => { writeFileSync(join(cwd, file), text); must(cwd, 'add', '.'); must(cwd, 'commit', '-qm', msg); return must(cwd, 'rev-parse', 'HEAD') }

// main has base.txt and shared.txt; feature branches off it and edits shared.txt line 1; main later edits shared.txt line 1 too.
const build = () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-commits-test-'))
  const remote = join(dir, 'remote.git'); const work = join(dir, 'work')
  must(dir, 'init', '-q', '--bare', '-b', 'main', remote)
  must(dir, 'clone', '-q', remote, work)
  must(work, 'checkout', '-q', '-b', 'main')
  commit(work, 'base.txt', 'base\n', 'base')
  commit(work, 'shared.txt', 'one\ntwo\n', 'shared')
  must(work, 'push', '-q', 'origin', 'main')
  must(work, 'checkout', '-q', '-b', 'feature')
  const before = commit(work, 'shared.txt', 'feature one\ntwo\n', 'feature edit')
  must(work, 'checkout', '-q', 'main')
  commit(work, 'other.txt', 'other\n', 'main adds a file')
  commit(work, 'shared.txt', 'main one\ntwo\n', 'main edits shared')
  must(work, 'push', '-q', 'origin', 'main')
  must(work, 'checkout', '-q', 'feature')
  return { dir, remote, work, before }
}
const push = (t) => must(t.work, 'push', '-q', '-f', 'origin', 'feature')
const run = (t, before, after) => spawnSync('bash', [join(root, 'scripts/land-commits.sh'), 'o/r', before, after, join(t.dir, 'tmp')], {
  encoding: 'utf8', env: { ...GIT_ENV, LAND_COMMITS_REMOTE: t.remote },
})
const mergeMain = (t, resolution) => {
  const m = git(t.work, 'merge', '--no-edit', 'origin/main')
  if (resolution !== undefined) {
    assert.notEqual(m.status, 0, 'the merge must conflict for this case')
    writeFileSync(join(t.work, 'shared.txt'), resolution); must(t.work, 'add', '.'); must(t.work, 'commit', '-qm', 'merge main')
  } else assert.equal(m.status, 0, 'the merge must be clean for this case')
  return must(t.work, 'rev-parse', 'HEAD')
}

test('a clean merge of the default branch prints nothing', () => {
  const t = build()
  must(t.work, 'checkout', '-q', '-B', 'feature', 'origin/main~2')
  const before = commit(t.work, 'feature.txt', 'f\n', 'feature file')
  push(t)
  const after = mergeMain(t)
  push(t)
  const r = run(t, before, after)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('a merge with a hand-resolved conflict prints the resolution', () => {
  const t = build(); push(t)
  const after = mergeMain(t, 'hand resolved line\ntwo\n')
  push(t)
  const r = run(t, t.before, after)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /hand resolved line/)
  assert.match(r.stdout, new RegExp(`merge ${after}`))
  assert.doesNotMatch(r.stdout, /main adds a file|other\.txt/)
})

test('a merge plus one fix commit prints only the fix commit', () => {
  const t = build(); push(t)
  mergeMain(t, 'main one\ntwo\n') // equal to main's side: no combined diff
  const after = commit(t.work, 'fix.txt', 'the fix\n', 'fix a test')
  push(t)
  const r = run(t, t.before, after)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /fix a test/)
  assert.match(r.stdout, /the fix/)
  assert.doesNotMatch(r.stdout, /main adds a file|other\.txt|main edits shared/)
})

test('a conflict resolved to the default branch side prints the dropped change', () => {
  const t = build(); push(t)
  const after = mergeMain(t, 'main one\ntwo\n')
  push(t)
  const r = run(t, t.before, after)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /-feature one/)
  assert.match(r.stdout, /took one side of shared\.txt/)
  assert.doesNotMatch(r.stdout, /other\.txt/)
})

test('an unreadable before exits non-zero', () => {
  const t = build(); push(t)
  const after = must(t.work, 'rev-parse', 'HEAD')
  const r = run(t, 'f'.repeat(40), after)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /cannot read/)
})

test('a before that is not a sha is refused', () => {
  const t = build(); push(t)
  const r = run(t, '--output=x', must(t.work, 'rev-parse', 'HEAD'))
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /not a commit sha/)
})

test('a merge that sets a file only the default branch changed back to the base version prints the dropped change', () => {
  const t = build()
  must(t.work, 'checkout', '-q', 'main')
  commit(t.work, 'base.txt', 'main base edit\n', 'main edits base')
  must(t.work, 'push', '-q', 'origin', 'main')
  must(t.work, 'checkout', '-q', 'feature')
  push(t)
  must(t.work, 'fetch', '-q', 'origin')
  must(t.work, 'merge', '--no-commit', '--no-ff', '-X', 'theirs', 'origin/main')
  writeFileSync(join(t.work, 'base.txt'), 'base\n')
  must(t.work, 'add', '.'); must(t.work, 'commit', '-qm', 'merge main')
  const after = must(t.work, 'rev-parse', 'HEAD')
  push(t)
  const r = run(t, t.before, after)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /took one side of base\.txt/)
  assert.match(r.stdout, /main base edit/)
})

test('a merge that sets a file only the feature branch changed back to the base version prints the dropped change', () => {
  const t = build()
  const before = commit(t.work, 'base.txt', 'feature base edit\n', 'feature edits base')
  push(t)
  must(t.work, 'fetch', '-q', 'origin')
  must(t.work, 'merge', '--no-commit', '--no-ff', '-X', 'theirs', 'origin/main')
  writeFileSync(join(t.work, 'base.txt'), 'base\n')
  must(t.work, 'add', '.'); must(t.work, 'commit', '-qm', 'merge main')
  const after = must(t.work, 'rev-parse', 'HEAD')
  push(t)
  const r = run(t, before, after)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /took one side of base\.txt/)
  assert.match(r.stdout, /feature base edit/)
})

test('calls that overlap in the same tmp dir all succeed', async () => {
  const t = build(); push(t)
  const after = commit(t.work, 'fix.txt', 'the fix\n', 'fix a test')
  push(t)
  const once = () => new Promise(resolve => {
    const c = spawn('bash', [join(root, 'scripts/land-commits.sh'), 'o/r', t.before, after, join(t.dir, 'tmp')], { env: { ...GIT_ENV, LAND_COMMITS_REMOTE: t.remote } })
    let out = ''
    c.stdout.on('data', d => { out += d })
    c.on('close', status => resolve({ status, out }))
  })
  for (const r of await Promise.all([once(), once(), once()])) {
    assert.equal(r.status, 0)
    assert.match(r.out, /fix a test/)
  }
})
