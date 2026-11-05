// Runs scripts/approval.jq on fixtures shaped like the events of alfhen/pipeline-dogfood #12 (maintainer, app null) and #27 (cloud session, app slug claude).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const JQ = join(root, 'scripts/approval.jq')
const fixture = (name) => readFileSync(join(root, 'test/fixtures/approval', `${name}.json`), 'utf8')
const run = (input, { label = 'maintainer-approved', after = '' } = {}) => {
  const r = spawnSync('jq', ['-c', '--arg', 'maintainer', 'alfhen', '--arg', 'label', label, '--arg', 'after', after, '-f', JQ], { input, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const approval = (name, opts) => run(fixture(name), opts)

test('the maintainer with no app mark counts', () => {
  assert.equal(approval('maintainer-null'), '2026-11-05T10:00:00Z')
})

test('the maintainer with the claude app mark does not count', () => {
  assert.equal(approval('maintainer-claude'), null)
})

test('another login does not count', () => {
  assert.equal(approval('other-login'), null)
})

test('an event at or before after does not count', () => {
  assert.equal(approval('maintainer-null', { after: '2026-11-05T10:00:00Z' }), null)
  assert.equal(approval('maintainer-null', { after: '2026-11-05T10:00:01Z' }), null)
  assert.equal(approval('maintainer-null', { after: '2026-11-05T09:59:59Z' }), '2026-11-05T10:00:00Z')
})

test('two good events give the newest', () => {
  assert.equal(approval('two-good'), '2026-11-05T11:00:00Z')
})

test('an unlabeled event never counts', () => {
  assert.equal(approval('unlabeled-only'), null)
})

test('a malformed element is skipped', () => {
  assert.equal(approval('string-in-list'), '2026-11-05T10:00:00Z')
})

test('a labeled event by the maintainer, a removal, then a claude labeled event gives null', () => {
  assert.equal(approval('removed-then-readded-by-claude'), null)
})

test('a claude re-add and a removal, then the maintainer labels again, gives the last time', () => {
  assert.equal(approval('claude-readd-then-maintainer-again'), '2026-11-05T11:00:00Z')
})

test('a newer labeled event by another login cancels an older maintainer approval', () => {
  assert.equal(approval('readded-by-other-login'), null)
})

test('the maintainer with an app mark other than claude does not count', () => {
  assert.equal(approval('maintainer-other-app'), null)
})

test('a labeled event of another label is ignored', () => {
  assert.equal(approval('other-label'), null)
  assert.equal(approval('other-label-after'), '2026-11-05T10:00:00Z')
  assert.equal(approval('other-label', { label: 'ready-to-build' }), '2026-11-05T10:00:00Z')
})

test('a later removal by anyone leaves the time; the live labels refuse it', () => {
  assert.equal(approval('labeled-then-unlabeled'), '2026-11-05T10:00:00Z')
})

test('an empty list and a non-array input give null', () => {
  assert.equal(run('[]'), null)
  assert.equal(run('{}'), null)
})

test('an event input order does not matter', () => {
  const events = JSON.parse(fixture('claude-readd-then-maintainer-again')).reverse()
  assert.equal(run(JSON.stringify(events)), '2026-11-05T11:00:00Z')
})
