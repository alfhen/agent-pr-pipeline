// Runs scripts/approval.jq on fixtures shaped like the events of alfhen/pipeline-dogfood #12 (maintainer, app null) and #27 (cloud session, app slug claude).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const JQ = join(root, 'scripts/approval.jq')
const fixture = (name) => readFileSync(join(root, 'test/fixtures/approval', `${name}.json`), 'utf8')
const run = (input, { label = 'maintainer-approved', after = '' } = {}) => {
  const r = spawnSync('jq', ['-c', '--arg', 'maintainer', 'alfhen', '--arg', 'label', label, '--arg', 'after', after, '-f', JQ], { input, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const approval = (name, opts) => run(fixture(name), opts)

const events = (name) => JSON.parse(fixture(name))
const holds = (name, pred) => assert.ok(events(name).some((e) => e && typeof e === 'object' && pred(e)), `${name} holds the event the test is about`)
const labeledBy = (login, label = 'maintainer-approved') => (e) => e.event === 'labeled' && e.label.name === label && e.actor.login === login

test('the maintainer with no app mark counts', () => {
  assert.equal(approval('maintainer-null'), '2026-11-05T10:00:00Z')
})

test('the maintainer with the claude app mark does not count', () => {
  holds('maintainer-claude', (e) => labeledBy('alfhen')(e) && e.performed_via_github_app.slug === 'claude')
  assert.equal(approval('maintainer-claude'), null)
})

test('another login does not count', () => {
  holds('other-login', (e) => labeledBy('someone')(e) && e.performed_via_github_app === null)
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
  holds('unlabeled-only', (e) => e.event === 'unlabeled' && e.label.name === 'maintainer-approved' && e.actor.login === 'alfhen')
  assert.ok(!events('unlabeled-only').some((e) => e.event === 'labeled'))
  assert.equal(approval('unlabeled-only'), null)
})

test('a malformed element is skipped', () => {
  assert.equal(approval('string-in-list'), '2026-11-05T10:00:00Z')
})

test('a labeled event by the maintainer, a removal, then a claude labeled event gives null', () => {
  holds('removed-then-readded-by-claude', labeledBy('alfhen'))
  holds('removed-then-readded-by-claude', (e) => e.event === 'unlabeled' && e.label.name === 'maintainer-approved')
  holds('removed-then-readded-by-claude', (e) => labeledBy('alfhen')(e) && e.performed_via_github_app?.slug === 'claude')
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
  holds('other-label', (e) => labeledBy('alfhen', 'ready-to-build')(e) && e.performed_via_github_app === null)
  assert.ok(!events('other-label').some((e) => e.label.name === 'maintainer-approved'))
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

test('two events in one second: the higher id decides, in any input order', () => {
  assert.equal(approval('same-second-claude-last'), null)
  assert.equal(approval('same-second-maintainer-last'), '2026-11-05T13:37:50Z')
  for (const [name, want] of [['same-second-claude-last', null], ['same-second-maintainer-last', '2026-11-05T13:37:50Z']]) {
    assert.equal(run(JSON.stringify(JSON.parse(fixture(name)).reverse())), want)
  }
})

test('an after with fractional seconds or another format is refused', () => {
  for (const after of ['2026-11-05T10:00:00.500Z', '2026-11-05 10:00:00', '2026-11-05T1:00:00Z', 'yesterday']) {
    const r = spawnSync('jq', ['-c', '--arg', 'maintainer', 'alfhen', '--arg', 'label', 'maintainer-approved', '--arg', 'after', after, '-f', JQ], { input: fixture('maintainer-null'), encoding: 'utf8' })
    assert.notEqual(r.status, 0, after)
  }
})

test('an event input order does not matter', () => {
  const events = JSON.parse(fixture('claude-readd-then-maintainer-again')).reverse()
  assert.equal(run(JSON.stringify(events)), '2026-11-05T11:00:00Z')
})
