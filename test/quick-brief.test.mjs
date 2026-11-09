// Runs scripts/quick-brief.sh against test/fake-gh on the fixtures in test/fixtures/quick-brief/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const SCRIPT = join(root, 'scripts/quick-brief.sh')
const ENTRY = 'Touches: src/a.js\nAcceptance: node --test passes'

const sumOf = s => {
  const out = spawnSync('cksum', { input: s, encoding: 'utf8' }).stdout.trim().split(/\s+/)
  return `${out[0]}:${out[1]}`
}

const run = (fixture, mode = 'get', extra = [], entryArgs, stub, fileText = ENTRY, sum = sumOf(fileText.replace(/\n+$/, ''))) => {
  const dir = mkdtempSync(join(tmpdir(), 'quick-brief-test-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  if (stub) writeFileSync(join(bin, 'gh'), stub)
  else copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh'))
  chmodSync(join(bin, 'gh'), 0o755)
  const log = join(dir, 'log')
  const entry = join(dir, 'entry.md')
  writeFileSync(entry, fileText)
  const r = spawnSync('bash', [SCRIPT, mode, 'o/r', '5', ...(mode === 'put' ? (entryArgs ?? [entry, '--sum', sum]) : []), ...extra], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: join(root, 'test/fixtures/quick-brief', fixture), FAKE_GH_LOG: log },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { ...r, calls, posts: calls.filter(l => l.startsWith('POST ')) }
}

test('get uses the one trusted comment and drops the marker line', () => {
  const r = run('trusted')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), ENTRY)
})

test('get ignores a marker comment by another account and reports no brief', () => {
  const r = run('other-account')
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /no trusted brief/)
})

test('get uses the trusted comment when a forged one comes first', () => {
  const r = run('forged-first')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), ENTRY)
  assert.doesNotMatch(r.stdout, /merge-pr/)
})

test('get fails when two trusted comments exist', () => {
  const r = run('two-trusted')
  assert.equal(r.status, 2)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /more than one trusted brief/)
})

test('get reports invalid comments JSON as such, not as two briefs', () => {
  const r = run('invalid-json')
  assert.equal(r.status, 3)
  assert.match(r.stderr, /not valid JSON/)
  assert.doesNotMatch(r.stderr, /more than one/)
})

test('get skips malformed comment elements and still finds the one brief', () => {
  const r = run('malformed-element')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), ENTRY)
  assert.doesNotMatch(r.stderr, /more than one/)
})

// A gh that answers the user call and then prints nothing for the comments.
const EMPTY_COMMENTS = '#!/bin/bash\ncase "$*" in *comments*) exit 0 ;; *) echo alfhen ;; esac\n'

test('an empty comments response is an error for get and put, and put posts nothing', () => {
  for (const mode of ['get', 'put']) {
    const r = run('trusted', mode, [], undefined, EMPTY_COMMENTS)
    assert.equal(r.status, 3, mode)
    assert.match(r.stderr, /came back empty/, mode)
    assert.equal(r.stdout, '', mode)
  }
})

test('put posts nothing when a trusted brief exists and prints that one', () => {
  const r = run('trusted', 'put')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.posts.length, 0)
  assert.equal(r.stdout.trim(), ENTRY)
})

test('put refuses when two trusted briefs exist', () => {
  const r = run('two-trusted', 'put')
  assert.equal(r.status, 2)
  assert.equal(r.posts.length, 0)
})

const NEW = 'Touches: src/b.js\nAcceptance: node --test other.mjs'
const markerOf = text => `<!-- pipeline:quick-brief ${sumOf(text)} -->`

test('put with a file and the right sum posts one comment whose marker holds the sum', () => {
  const r = run('other-account', 'put')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.posts.length, 1)
  assert.ok(r.posts[0].startsWith(`POST /repos/o/r/issues/5/comments body=${markerOf(ENTRY)}`), r.posts[0])
  assert.ok(r.posts[0].includes('Touches: src/a.js'))
  assert.equal(r.stdout.trim(), ENTRY)
})

test('put accepts a file with a trailing newline when the sum is of the text without it', () => {
  const r = run('other-account', 'put', [], undefined, undefined, ENTRY + '\n\n', sumOf(ENTRY))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.posts.length, 1)
})

test('put with a wrong sum exits 65 and posts nothing', () => {
  const r = run('other-account', 'put', [], undefined, undefined, ENTRY, sumOf(ENTRY + 'x'))
  assert.equal(r.status, 65)
  assert.equal(r.calls.length, 0)
  assert.match(r.stderr, /checksum/)
})

test('put without --sum exits 65 and posts nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qb-nosum-'))
  const f = join(dir, 'e.md')
  writeFileSync(f, ENTRY)
  const r2 = run('other-account', 'put', [], [f])
  assert.equal(r2.status, 65)
  assert.equal(r2.posts.length, 0)
})

test('put --b64 is refused with exit 64 and makes no call', () => {
  const r = run('other-account', 'put', [], ['--b64', Buffer.from(ENTRY).toString('base64'), '--sum', sumOf(ENTRY)])
  assert.equal(r.status, 64)
  assert.equal(r.calls.length, 0)
})

test('put with the same text as the stored brief writes nothing, with a sum marker or a 0.4 marker', () => {
  for (const fixture of ['pipeline-same', 'trusted']) {
    const r = run(fixture, 'put')
    assert.equal(r.status, 0, fixture + r.stderr)
    assert.equal(r.calls.filter(l => !l.startsWith('GET ')).length, 0, fixture)
    assert.equal(r.stdout.trim(), ENTRY)
  }
})

test('put replaces an unedited pipeline brief with one PATCH to that comment and no POST', () => {
  const r = run('pipeline-same', 'put', [], undefined, undefined, NEW)
  assert.equal(r.status, 0, r.stderr)
  const writes = r.calls.filter(l => !l.startsWith('GET '))
  assert.equal(writes.length, 1)
  assert.ok(writes[0].startsWith(`PATCH /repos/o/r/issues/comments/2 body=${markerOf(NEW)}`), writes[0])
  assert.equal(r.posts.length, 0)
  assert.equal(r.stdout.trim(), NEW)
})

test('put leaves a brief whose text does not match its marker sum alone: exit 4', () => {
  const r = run('pipeline-edited', 'put', [], undefined, undefined, NEW)
  assert.equal(r.status, 4)
  assert.equal(r.calls.filter(l => !l.startsWith('GET ')).length, 0)
})

test('a brief saved with CRLF line endings is edited: get and put exit 4, put writes nothing', () => {
  assert.equal(run('pipeline-edited-crlf').status, 4)
  const r = run('pipeline-edited-crlf', 'put', [], undefined, undefined, NEW)
  assert.equal(r.status, 4)
  assert.equal(r.calls.filter(l => !l.startsWith('GET ')).length, 0)
})

test('put leaves a 0.4 brief (no sum) alone when the entry differs: exit 4', () => {
  const r = run('trusted', 'put', [], undefined, undefined, NEW)
  assert.equal(r.status, 4)
  assert.equal(r.calls.filter(l => !l.startsWith('GET ')).length, 0)
})

test('put never touches a marker comment by another account', () => {
  const r = run('other-account', 'put', [], undefined, undefined, NEW)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.posts.length, 1)
  assert.equal(r.calls.filter(l => l.startsWith('PATCH ')).length, 0)
})

test('get exits 4 for an edited brief and reads a 0.4 marker and a sum marker', () => {
  const edited = run('pipeline-edited')
  assert.equal(edited.status, 4)
  assert.equal(edited.stdout, '')
  for (const fixture of ['trusted', 'pipeline-same']) {
    const r = run(fixture)
    assert.equal(r.status, 0, fixture)
    assert.equal(r.stdout.trim(), ENTRY)
  }
})

test('a brief that ends with the cloud session footer is a pipeline brief for get and put', () => {
  const g = run('footer')
  assert.equal(g.status, 0, g.stderr)
  assert.equal(g.stdout.trim(), ENTRY)
  const same = run('footer', 'put')
  assert.equal(same.status, 0, same.stderr)
  assert.equal(same.stdout.trim(), ENTRY)
  assert.equal(same.calls.filter(l => !l.startsWith('GET ')).length, 0)
  const replaced = run('footer', 'put', [], undefined, undefined, NEW)
  assert.equal(replaced.status, 0, replaced.stderr)
  assert.equal(replaced.calls.filter(l => l.startsWith('PATCH /repos/o/r/issues/comments/2 ')).length, 1)
  assert.equal(replaced.posts.length, 0)
})

test('a person line before the footer, or a footer with changed words, is an edit: exit 4', () => {
  for (const fixture of ['footer-person-line', 'footer-changed']) {
    const g = run(fixture)
    assert.equal(g.status, 4, fixture)
    assert.equal(g.stdout, '')
    const p = run(fixture, 'put')
    assert.equal(p.status, 4, fixture)
    assert.equal(p.calls.filter(l => !l.startsWith('GET ')).length, 0, fixture)
  }
})

test('the sum is the POSIX cksum of the text, the same as the workflow computes', () => {
  assert.equal(sumOf(ENTRY), '452653:48')
})

test('get --clear empties a brief-* folder and refuses any other folder', () => {
  const base = mkdtempSync(join(tmpdir(), 'quick-brief-clear-'))
  const dir = join(base, 'brief-X')
  mkdirSync(dir)
  writeFileSync(join(dir, 'entry-1.md'), 'old')
  const r = run('trusted', 'get', ['--clear', dir])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(dir))
  const keep = join(base, 'keep')
  mkdirSync(keep)
  const bad = run('trusted', 'get', ['--clear', keep])
  assert.equal(bad.status, 64)
  assert.ok(existsSync(keep))
})

test('a stored brief that ends with a newline is read, kept and replaced like one without', () => {
  for (const fixture of ['footer-newline', 'pipeline-newline']) {
    const g = run(fixture)
    assert.equal(g.status, 0, fixture + g.stderr)
    assert.equal(g.stdout.trim(), ENTRY)
    const same = run(fixture, 'put')
    assert.equal(same.status, 0, fixture + same.stderr)
    assert.equal(same.calls.filter(l => !l.startsWith('GET ')).length, 0, fixture)
    const replaced = run(fixture, 'put', [], undefined, undefined, NEW)
    assert.equal(replaced.status, 0, fixture + replaced.stderr)
    assert.equal(replaced.calls.filter(l => l.startsWith('PATCH /repos/o/r/issues/comments/2 ')).length, 1, fixture)
    assert.ok(replaced.calls.some(l => l.startsWith(`PATCH /repos/o/r/issues/comments/2 body=${markerOf(NEW)}`)), fixture)
    assert.equal(replaced.posts.length, 0)
  }
})

test('put with the same text but a wrong marker sum is edited: exit 4, nothing written', () => {
  assert.equal(run('pipeline-badsum').status, 4)
  const r = run('pipeline-badsum', 'put')
  assert.equal(r.status, 4)
  assert.equal(r.calls.filter(l => !l.startsWith('GET ')).length, 0)
})
