// The last line of land-commits.sh, and the prompt sentences and docs around it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
  assert.equal(r.status, 0, args.join(' ') + r.stderr)
  return r.stdout.trim()
}
const NO_CODE = 'land-commits: no code added by the land fix'

// clean: main adds another file. Otherwise both sides edit line 1 and the merge is resolved by hand.
const fixture = clean => {
  const dir = mkdtempSync(join(tmpdir(), 'land-last-'))
  const remote = join(dir, 'r.git'); const w = join(dir, 'w')
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote)
  git(dir, 'clone', '-q', remote, w)
  git(w, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(w, 's.txt'), 'one\ntwo\n'); git(w, 'add', '.'); git(w, 'commit', '-qm', 'base'); git(w, 'push', '-q', 'origin', 'main')
  git(w, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(w, 's.txt'), 'feature one\ntwo\n'); git(w, 'commit', '-qam', 'f')
  const before = git(w, 'rev-parse', 'HEAD')
  git(w, 'push', '-q', 'origin', 'feature')
  git(w, 'checkout', '-q', 'main')
  if (clean) { writeFileSync(join(w, 'm.txt'), 'm\n'); git(w, 'add', '.') } else writeFileSync(join(w, 's.txt'), 'main one\ntwo\n')
  git(w, 'commit', '-qam', 'm'); git(w, 'push', '-q', 'origin', 'main')
  git(w, 'checkout', '-q', 'feature')
  const merged = spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd: w, encoding: 'utf8', env: GIT_ENV })
  if (!clean) {
    assert.notEqual(merged.status, 0)
    writeFileSync(join(w, 's.txt'), 'hand resolved\ntwo\n'); git(w, 'add', '.'); git(w, 'commit', '-qm', 'merge')
  } else assert.equal(merged.status, 0)
  const after = git(w, 'rev-parse', 'HEAD'); git(w, 'push', '-q', 'origin', 'feature')
  return { dir, remote, before, after }
}
const runIo = (f, env = {}) => spawnSync('bash', [join(root, 'scripts/io.sh'), 'land-commits.sh', 'o/r', f.before, f.after, join(f.dir, 'tmp')], {
  encoding: 'utf8', env: { ...GIT_ENV, LAND_COMMITS_REMOTE: f.remote, PIPELINE_IO_TMP: f.dir, ...env },
})
const body = out => out.split('\n').slice(1, -2)

test('the last line holds the cksum and the byte length of every line before it', () => {
  const r = runIo(fixture(false))
  assert.equal(r.status, 0, r.stderr)
  const lines = body(r.stdout)
  const last = lines.pop()
  const [crc, bytes] = spawnSync('cksum', { input: lines.join('\n'), encoding: 'utf8' }).stdout.trim().split(/\s+/)
  assert.equal(last, `land-commits: sum ${crc}:${bytes}`)
  assert.match(lines.join('\n'), /hand resolved/)
})

test('a clean merge prints only the no-code line', () => {
  const r = runIo(fixture(true))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(body(r.stdout), [NO_CODE])
})

for (const word of ['log', 'diff-tree', '--parents', '--name-only']) {
  test(`a failed git command with ${word} prints no last line`, () => {
    const f = fixture(false)
    const shim = join(f.dir, 'shim'); mkdirSync(shim)
    const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(shim, 'git'), `#!/bin/bash\nfor a in "$@"; do [ "$a" = "${word}" ] && exit 1; done\nexec ${real} "$@"\n`)
    chmodSync(join(shim, 'git'), 0o755)
    assert.match(runIo(f).stdout, /land-commits: sum /)
    const r = runIo(f, { PATH: `${shim}:${process.env.PATH}` })
    assert.doesNotMatch(r.stdout, /land-commits: (sum|no code)/)
  })
}

const src = readFileSync(join(root, 'workflows/run-wave.js'), 'utf8')
const sectionOf = (from, to) => { const i = src.indexOf(from); return src.slice(i, src.indexOf(to, i)) }

test('the land review prompt tells the reviewer to check the last line of a file', () => {
  const t = sectionOf('const landReviewPrompt', 'prBlock(pr)')
  assert.match(t, /last line/)
  assert.match(t, /cksum/)
  assert.match(t, /\bblocker\b/)
})

test('the marker comment is posted in step 7 of the answer prompt, after the push', () => {
  const lines = sectionOf('const answerPrompt =', 'const botReviewPrompt =').split('\n')
  const at = lines.findIndex(l => l.includes('<!-- pipeline-bot-answer head='))
  assert.match(lines[at], /^7\. .*push/)
  assert.deepEqual(lines.filter(l => /^[1-6]\. /.test(l) && (l.includes('pipeline-bot-answer') || l.includes('issues/${n}/comments'))), [])
})

test('the docs say the marker is posted last and the land check reads the last line', () => {
  const skill = readFileSync(join(root, 'skills/pr-pipeline/SKILL.md'), 'utf8')
  assert.match(skill, /which it posts last, after its final push/)
  assert.match(skill, /`land-commits: sum <crc>:<bytes>`/)
  assert.match(readFileSync(join(root, 'agents/bot-answerer.md'), 'utf8'), /Post it last, after your final push/)
  for (const f of ['scripts/land-commits.sh', 'workflows/run-wave.js', 'skills/pr-pipeline/SKILL.md']) {
    assert.doesNotMatch(readFileSync(join(root, f), 'utf8'), /Empty output means the fixer added no code|A clean merge of the default branch prints nothing/)
  }
})
