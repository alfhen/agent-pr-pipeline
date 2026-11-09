// Runs scripts/file-feedback.sh against test/fake-gh on fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const SCRIPT = join(root, 'scripts/file-feedback.sh')
const REPO = 'alfhen/agent-pr-pipeline'
const ISSUES = 'repos__alfhen__agent-pr-pipeline__issues'

const item = (title, extra = {}) => ({ title, detail: 'The step stalled.', evidence: 'wave results', suggestedChange: 'Add a timeout.', severity: 'major', ...extra })

// Page 2 holds the duplicate. The PR in the list has a title an item reuses; a PR is not an issue.
const openIssues = [
  [{ title: 'Unrelated open issue', number: 1 }],
  [{ title: '  Bot wait reports pending ', number: 2 }, { title: 'Reused by a pull request', number: 3, pull_request: {} }],
]

const setup = ({ items, deny = [], issues = openIssues, source = REPO }) => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  if (issues) issues.forEach((page, i) => writeFileSync(join(fx, `${ISSUES}.${i + 1}.json`), JSON.stringify(page)))
  writeFileSync(join(fx, `repos__alfhen__agent-pr-pipeline__issues.POST.json`), JSON.stringify({ html_url: 'https://github.com/alfhen/agent-pr-pipeline/issues/99' }))
  writeFileSync(join(dir, 'feedback.json'), JSON.stringify(items))
  writeFileSync(join(dir, 'denylist.json'), JSON.stringify(deny))
  const log = join(dir, 'log')
  const run = (...flags) => {
    const args = [...(flags.includes('--repo') ? [] : ['--repo', REPO]), ...(flags.includes('--source') ? [] : ['--source', source]), ...flags]
    const r = spawnSync('bash', [SCRIPT, join(dir, 'feedback.json'), '--denylist', join(dir, 'denylist.json'), ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: fx, FAKE_GH_LOG: log },
    })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
    return { ...r, calls, posts: calls.filter(l => l.startsWith('POST ')) }
  }
  return { run, dir }
}

test('dry run reports one create per new title and makes no write call', () => {
  const items = [item('Tester reports a stale sha'), item('Docs step has no timeout')]
  const r = setup({ items }).run('--dry-run')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /WOULD FILE Tester reports a stale sha \[pipeline-feedback\]/)
  assert.match(r.stdout, /WOULD FILE Docs step has no timeout \[pipeline-feedback\]/)
  assert.equal(r.posts.length, 0)
})

test('a real run files each new title once with the label', () => {
  const items = [item('Tester reports a stale sha'), item('Docs step has no timeout'), item('tester reports a STALE sha')]
  const r = setup({ items }).run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.posts.length, 2)
  for (const p of r.posts) {
    assert.match(p, new RegExp(`^POST /repos/${REPO}/issues `))
    assert.match(p, /labels\[\]=pipeline-feedback/)
  }
  assert.match(r.stdout, /FILED Tester reports a stale sha https:\/\/github.com\/alfhen\/agent-pr-pipeline\/issues\/99/)
  assert.match(r.stdout, /SKIP duplicate: tester reports a STALE sha/)
})

test('a title with an open issue on the second page is skipped, and a pull request title is not a duplicate', () => {
  assert.ok(openIssues[1].some(i => i.title.trim() === 'Bot wait reports pending'), 'fixture holds the duplicate')
  assert.ok(openIssues[1].some(i => i.title === 'Reused by a pull request' && i.pull_request))
  const items = [item('bot wait reports pending'), item('Reused by a pull request')]
  const r = setup({ items }).run()
  assert.match(r.stdout, /SKIP duplicate: bot wait reports pending/)
  assert.equal(r.posts.length, 1)
  assert.match(r.posts[0], /title=Reused by a pull request/)
})

const DENY = ['acme', 'widgets', 'https://github.com/acme/widgets', 'src/billing/invoice.ts']
const leaking = [
  ['the repo owner', item('Fixer loops on Acme repos')],
  ['the repo name', item('Tester slow', { detail: 'Slow on the Widgets suite.' })],
  ['a repo URL', item('Opener links wrong', { evidence: 'see https://github.com/acme/widgets/pull/4' })],
  ['a denylist path', item('Reviewer misses a file', { suggestedChange: 'Read SRC/billing/invoice.ts first.' })],
]

for (const [what, bad] of leaking) {
  test(`an item containing ${what} is reported and not filed`, () => {
    const text = JSON.stringify(bad).toLowerCase()
    assert.ok(DENY.some(d => text.includes(d.toLowerCase())), 'the fixture item contains a denylist string')
    const clean = item('Land step waits too long')
    const s = setup({ items: [bad, clean], deny: DENY, source: 'acme/widgets' })
    const r = s.run()
    assert.equal(r.status, 2)
    assert.match(r.stdout, new RegExp(`REFUSED ${bad.title}`))
    assert.equal(r.posts.length, 1)
    assert.match(r.posts[0], /title=Land step waits too long/)
    const control = setup({ items: [bad], deny: [] }).run()
    assert.equal(control.status, 0)
    assert.equal(control.posts.length, 1, 'with an empty denylist the same item is filed')
  })
}

test('a refused item is reported in a dry run too', () => {
  const r = setup({ items: [leaking[0][1]], deny: DENY }).run('--dry-run')
  assert.equal(r.status, 2)
  assert.match(r.stdout, /REFUSED/)
  assert.doesNotMatch(r.stdout, /WOULD FILE/)
})

test('without the list of open issues nothing is filed', () => {
  const r = setup({ items: [item('Anything')], issues: null }).run()
  assert.equal(r.status, 1)
  assert.equal(r.posts.length, 0)
})

test('--repo and --source are required', () => {
  const items = [item('Anything')]
  const s = setup({ items })
  for (const [flag, other] of [['--repo', '--source'], ['--source', '--repo']]) {
    const r = spawnSync('bash', [SCRIPT, join(s.dir, 'feedback.json'), '--denylist', join(s.dir, 'denylist.json'), other, REPO], { encoding: 'utf8' })
    assert.equal(r.status, 1, `missing ${flag}`)
    assert.match(r.stdout, /usage/)
  }
  assert.equal(s.run().status, 0)
})

test('with a source repo that differs from the target, the script refuses its owner and name though the denylist file is not empty', () => {
  const bad = item('Fixer loops', { detail: 'Seen in acme builds.' })
  const r = setup({ items: [bad], deny: ['unrelated'], source: 'acme/widgets' }).run()
  assert.equal(r.status, 2)
  assert.match(r.stdout, /REFUSED Fixer loops: contains "acme"/)
  assert.equal(r.posts.length, 0)
})

test('with a source repo that differs from the target, an empty denylist stops the run', () => {
  const r = setup({ items: [item('Land step waits too long', { detail: 'acme' })], deny: [], source: 'acme/widgets' }).run()
  assert.equal(r.status, 1)
  assert.equal(r.posts.length, 0)
})

test('the script refuses the source URL for an item the redactor never saw', () => {
  const bad = item('Land step', { evidence: 'https://github.com/Acme/Widgets/pull/3' })
  const r = setup({ items: [bad], deny: ['x'], source: 'acme/widgets' }).run()
  assert.equal(r.status, 2)
})

test('an item is refused when the denylist check fails', () => {
  const s = setup({ items: [item('Tester reports a stale sha')] })
  const real = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(join(s.dir, 'bin', 'jq'), `#!/bin/bash\ncase "$*" in *'as $text'*) exit 5 ;; esac\nexec ${real} "$@"\n`)
  chmodSync(join(s.dir, 'bin', 'jq'), 0o755)
  const r = s.run()
  assert.equal(r.status, 2)
  assert.match(r.stdout, /REFUSED Tester reports a stale sha: denylist check failed/)
  assert.equal(r.posts.length, 0)
})

test('a short denylist entry matches only as a whole word, a path matches as a substring', () => {
  const ok = item('Writer lags the code', { detail: 'The documentation step reads the README and runs the apis.' })
  const bad = item('Fixer loops', { detail: 'It edits src/billing/invoice.ts twice.' })
  const r = setup({ items: [ok, bad], deny: ['docs', 'api', 'src/billing/invoice.ts'], source: REPO }).run()
  assert.equal(r.posts.length, 1)
  assert.match(r.stdout, /REFUSED Fixer loops: contains "src\/billing\/invoice.ts"/)
  const word = setup({ items: [item('Docs lag', { detail: 'Fixed in the Docs step.' })], deny: ['docs'] }).run()
  assert.equal(word.status, 2)
})

test('the source owner and name match inside compound words', () => {
  for (const detail of ['AcmeWidgets stalls', 'acmecorp stalls', 'widgetsApi stalls', 'acme2 stalls']) {
    const r = setup({ items: [item('Fixer loops', { detail })], deny: ['unrelated'], source: 'acme/widgets' }).run()
    assert.equal(r.status, 2, detail)
    assert.equal(r.posts.length, 0)
  }
})

test('a denylist entry that starts or ends with punctuation matches next to letters', () => {
  for (const [entry, detail] of [['#123', 'See PR#123 for it.'], ['.env.prod', 'Reads app.env.prod twice.'], ['@acme', 'Mail bob@acme now.']]) {
    const r = setup({ items: [item('Fixer loops', { detail })], deny: [entry] }).run()
    assert.equal(r.status, 2, entry)
    assert.equal(r.posts.length, 0)
  }
})

test('a POST failure keeps exit 1 whether a refusal comes before or after it', () => {
  const bad = item('Fixer loops', { detail: 'Seen in acme builds.' })
  const ok = item('Land step waits too long')
  for (const items of [[ok, bad], [bad, ok]]) {
    const s = setup({ items, deny: ['acme'] })
    writeFileSync(join(s.dir, 'fx', `${ISSUES}.POST.error`), 'HTTP 500')
    const r = s.run()
    assert.equal(r.status, 1, items.map(i => i.title).join(' then '))
    assert.match(r.stdout, /FAILED Land step waits too long/)
    assert.match(r.stdout, /REFUSED Fixer loops/)
  }
})

test('a repo named api does not refuse every item, but still refuses the word', () => {
  const run = detail => setup({ items: [item('Fixer loops', { detail })], deny: ['unrelated'], source: 'acme/api' }).run()
  const ok = run('It calls the apis and a rapid retry.')
  assert.equal(ok.status, 0, ok.stdout)
  assert.equal(ok.posts.length, 1)
  assert.equal(run('It calls the API twice.').status, 2)
})

test('a path entry matches as a substring next to letters', () => {
  const r = setup({ items: [item('Reviewer misses a file', { detail: 'It opens src/billing/invoice.tsx twice.' })], deny: ['src/billing/invoice.ts'] }).run()
  assert.equal(r.status, 2)
  assert.match(r.stdout, /contains "src\/billing\/invoice.ts"/)
})

test('a long slash-free entry matches inside longer forms, a bare short number does not', () => {
  for (const [entry, detail] of [['billing-refactor', 'See billing-refactor2.'], ['acmepay.config.js', 'Reads acmepay.config.json.']]) {
    const r = setup({ items: [item('Fixer loops', { detail })], deny: [entry] }).run()
    assert.equal(r.status, 2, entry)
  }
  const r = setup({ items: [item('Fixer loops', { detail: 'See PR123.' })], deny: ['123'] }).run()
  assert.equal(r.status, 0)
})


// ---- --auto, the outbox and the collect path (0.8.0) ----
import * as W from './fixtures/feedback/world.mjs'

const R1 = W.runId(1)
const ISSUE = W.autoIssue
const writesOf = r => r.writes.join('\n')
const noWrites = (r, msg) => assert.deepEqual(r.writes, [], `${msg}\n${writesOf(r)}`)

test('--auto at the daily cap is HELD: no issue, no record', () => {
  const issues = Array.from({ length: 6 }, (_, k) => ISSUE(10 + k))
  const r = W.world({ issues }).auto([item('Brand new problem')], ['acme', 'widgets'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /HELD Brand new problem/)
  noWrites(r, 'cap')
})

test('--auto counts only the marked issues of the account from the last 24 hours', () => {
  const issues = [
    ...Array.from({ length: 5 }, (_, k) => ISSUE(10 + k)),
    W.fbIssue(20, 'Unmarked issue one'), W.fbIssue(21, 'Unmarked issue two'),
    ISSUE(22, { at: W.ago(W.DAY + 5) }), ISSUE(23, { user: 'mallory' }),
  ]
  const r = W.world({ issues }).auto([item('Brand new problem')], ['acme', 'widgets'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.issuePosts.length, 1, r.stdout)
})

test('--auto under the cap files with the marker and the source kind, never the source name', () => {
  const issues = Array.from({ length: 5 }, (_, k) => ISSUE(10 + k))
  const r = W.world({ issues }).auto([item('Brand new problem')], ['acme', 'widgets'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.issuePosts.length, 1)
  assert.match(r.issuePosts[0], /<!-- pipeline:auto-filed -->/)
  assert.match(r.issuePosts[0], /Source: another repo labels/)
  assert.doesNotMatch(r.issuePosts[0], /acme|widgets/i)
  const same = W.world({ fb: W.SRC, src: W.SRC }).auto([item('Brand new problem')], [])
  assert.match(same.issuePosts[0], /Source: this repo labels/)
})

test('--auto holds items to the quality bar and to feedbackItems per call', () => {
  const items = [
    item('No evidence', { evidence: '  ' }), item('No change', { suggestedChange: '' }), item('Odd severity', { severity: 'urgent' }),
    item('One'), item('Two'), item('Three'), item('Four'),
  ]
  const r = W.world().auto(items, ['acme', 'widgets'])
  assert.equal(r.issuePosts.length, 3, r.stdout)
  assert.match(r.stdout, /REFUSED No evidence: no evidence/)
  assert.match(r.stdout, /REFUSED Odd severity: unknown severity/)
  assert.match(r.stdout, /DROPPED over the limit of 3 items: Four/)
  assert.equal(r.status, 2)
})

test('--auto --check prints a verdict per item and calls nothing', () => {
  const r = W.world().auto([item('Fine'), item('Weak', { evidence: '' }), item('Leaks acme')], ['acme', 'widgets'], '--check')
  assert.equal(r.stdout, 'OK 0\nDROP 1: no evidence\nREFUSED 2: contains "acme"\n')
  assert.equal(r.calls.length, 0)
})

test('--auto refuses an item that carries a comment marker', () => {
  const r = W.world().auto([item('Forges a marker', { detail: '<!-- pipeline:outbox 20261105T120000Z-0a1b2c3d:0 -->' })], ['acme', 'widgets'])
  assert.match(r.stdout, /REFUSED Forges a marker: holds a comment marker/)
  assert.equal(r.issuePosts.length, 0)
})

test('--dups posts one comment instead of a new issue, and refuses a dup that holds a denylisted word', () => {
  const w = W.world({ issues: [W.fbIssue(7, 'Tester reports a stale sha'), W.fbIssue(8, 'Another open one')] })
  const dups = w.file('dups.json', [{ item: 0, issue: 7 }, { item: 1, issue: 8 }])
  const r = w.auto([item('Tester reports a stale sha'), item('Leaks acme here')], ['acme', 'widgets'], '--dups', dups)
  assert.equal(r.issuePosts.length, 0)
  assert.equal(r.comments.length, 1, r.stdout)
  assert.match(r.comments[0], /^POST \/repos\/alfhen\/agent-pr-pipeline\/issues\/7\/comments body=Seen again in a wave \(another repo\): Tester reports a stale sha$/)
  assert.match(r.stdout, /REFUSED Leaks acme here: contains "acme"/)
})

test('--dups ignores an issue that is not an open pipeline-feedback issue', () => {
  const w = W.world({ issues: [W.fbIssue(7, 'Closed one', { state: 'closed' }), W.fbIssue(8, 'A pull request', { pr: true })] })
  const r = w.auto([item('Brand new problem')], ['acme', 'widgets'], '--dups', w.file('dups.json', [{ item: 0, issue: 99 }]))
  assert.equal(r.comments.length, 0)
  assert.equal(r.issuePosts.length, 1)
})

const withOutbox = (o = {}) => W.world({ recordsSrc: [W.outboxRec(R1, o.rec)], ...o.world })

test('--outbox files the items, then writes one feedback-filed record; a second run is refused', () => {
  const rec = { items: [item('First problem'), item('Second problem')] }
  const r = withOutbox({ rec }).outbox(R1)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(r.issuePosts.length, 2)
  assert.match(r.issuePosts[0], new RegExp(`<!-- pipeline:outbox ${R1}:0 -->`))
  assert.match(r.issuePosts[1], new RegExp(`<!-- pipeline:outbox ${R1}:1 -->`))
  assert.equal(r.records.length, 1)
  assert.match(r.records[0], /^POST \/repos\/acme\/widgets\/issues\/100\/comments body=<!-- pipeline:routine feedback-filed /)
  assert.deepEqual(W.recordOf(r.records[0]), { filed: 2, seenAgain: 0, refused: 0 })
  const again = W.world({ recordsSrc: [W.outboxRec(R1, rec), W.filedRec(R1)] }).outbox(R1)
  assert.equal(again.status, 65)
  noWrites(again, 'second run')
})

test('--outbox holds the whole outbox when the new issues would pass the cap, then files all when there is room', () => {
  const rec = { items: [item('Problem A'), item('Problem B'), item('Problem C')] }
  const four = Array.from({ length: 4 }, (_, k) => ISSUE(10 + k))
  const held = W.world({ issues: four, recordsSrc: [W.outboxRec(R1, rec)] }).outbox(R1)
  assert.equal(held.status, 0, held.stderr)
  assert.match(held.stdout, /HELD outbox/)
  noWrites(held, 'held')
  const three = Array.from({ length: 3 }, (_, k) => ISSUE(10 + k))
  const room = W.world({ issues: three, recordsSrc: [W.outboxRec(R1, rec)] }).outbox(R1)
  assert.equal(room.issuePosts.length, 3)
  assert.equal(room.records.length, 1)
})

test('--outbox after a half-done run skips the item that has its marker and records once', () => {
  const rec = { items: [item('Problem A'), item('Problem B'), item('Problem C')] }
  const half = W.autoIssue(30, { title: 'Problem A', state: 'closed', extra: `<!-- pipeline:outbox ${R1}:0 -->` })
  const r = W.world({ issues: [half], recordsSrc: [W.outboxRec(R1, rec)] }).outbox(R1)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /SKIP already filed: Problem A/)
  assert.equal(r.issuePosts.length, 2)
  assert.equal(r.records.length, 1)
  assert.deepEqual(W.recordOf(r.records[0]), { filed: 3, seenAgain: 0, refused: 0 })
})

test('--outbox does not record when a post fails, so the outbox stays open', () => {
  const w = withOutbox({ rec: { items: [item('Problem A')] } })
  writeFileSync(join(w.dir, 'fx', 'repos__alfhen__agent-pr-pipeline__issues.POST.error'), 'HTTP 500')
  const r = w.outbox(R1)
  assert.equal(r.status, 1)
  assert.equal(r.records.length, 0)
})

test('--outbox with --dups comments once and counts it as seen again', () => {
  const w = withOutbox({ rec: { items: [item('Problem A'), item('Problem B')] }, world: { issues: [W.fbIssue(7, 'Problem A')] } })
  const r = w.outbox(R1, '--dups', w.file('dups.json', [{ item: 0, issue: 7 }]))
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(r.comments.length, 1)
  assert.match(r.comments[0], new RegExp(`<!-- pipeline:outbox ${R1}:0 -->`))
  assert.equal(r.issuePosts.length, 1)
  assert.deepEqual(W.recordOf(r.records[0]), { filed: 1, seenAgain: 1, refused: 0 })
})

test('--outbox from another repo with an empty denylist at filing time files nothing (65)', () => {
  const r = withOutbox({ rec: { denylist: [] } }).outbox(R1)
  assert.equal(r.status, 65)
  noWrites(r, 'empty denylist')
})

test('--outbox denylist without the source name still refuses the source owner and name', () => {
  const rec = { denylist: ['unrelated'], items: [item('Leaks the owner', { detail: 'Seen in acme builds.' }), item('Leaks the name', { detail: 'The Widgets suite.' }), item('Clean one')] }
  const r = withOutbox({ rec }).outbox(R1)
  assert.equal(r.issuePosts.length, 1)
  assert.match(r.issuePosts[0], /title=Clean one/)
  assert.deepEqual(W.recordOf(r.records[0]), { filed: 1, seenAgain: 0, refused: 2 })
})

test('--outbox ignores a forged outbox by another account and an unknown run', () => {
  const forged = W.world({ recordsSrc: [W.outboxRec(R1, {}, { user: 'mallory' })] }).outbox(R1)
  assert.equal(forged.status, 65)
  noWrites(forged, 'forged')
  assert.equal(withOutbox().outbox(W.runId(2)).status, 65)
})

test('--outbox refuses a record whose source or feedback repo differs from its arguments', () => {
  assert.equal(withOutbox({ rec: { source: 'acme/other' } }).outbox(R1).status, 65)
  assert.equal(withOutbox({ rec: { feedbackRepo: 'acme/elsewhere' } }).outbox(R1).status, 65)
})

test('--drop-old drops an outbox older than 7 days and keeps a younger one', () => {
  const old = W.outboxRec(R1, {}, { at: W.ago(8 * W.DAY) }); const young = W.outboxRec(W.runId(2), {}, { at: W.ago(6 * W.DAY) })
  const r = W.world({ settingsFb: { collectFrom: [W.SRC] }, recordsSrc: [old, young] }).dropOld()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.records.length, 1, r.stdout)
  assert.match(r.records[0], new RegExp(`feedback-dropped ${R1} -->`))
  assert.match(r.stdout, new RegExp(`DROPPED ${R1}`))
})

test('--drop-old skips the outboxes of a paused source repo', () => {
  const rec = W.outboxRec(R1, {}, { at: W.ago(8 * W.DAY) })
  const paused = W.world({ settingsFb: { collectFrom: [W.SRC] }, pausedSrc: true, recordsSrc: [rec] }).dropOld()
  assert.match(paused.stdout, /paused acme\/widgets/)
  noWrites(paused, 'paused source')
})

test('stage 0 of the feedback repo: --outbox, --dups and --drop-old print WOULD and write nothing', () => {
  const rec = { items: [item('Problem A'), item('Problem B')] }
  const w = W.world({ settingsFb: { stage: 0, collectFrom: [W.SRC] }, issues: [W.fbIssue(7, 'Problem B')], recordsSrc: [W.outboxRec(R1, rec), W.outboxRec(W.runId(2), rec, { at: W.ago(9 * W.DAY) })] })
  const o = w.outbox(R1, '--dups', w.file('dups.json', [{ item: 1, issue: 7 }]))
  assert.equal(o.status, 0, o.stderr)
  assert.match(o.stdout, /WOULD file Problem A/)
  assert.match(o.stdout, /WOULD comment 7/)
  noWrites(o, 'outbox')
  assert.match(w.list(), new RegExp(R1))
  const d = w.auto([item('Problem B')], ['acme', 'widgets'], '--dups', w.file('d2.json', [{ item: 0, issue: 7 }]))
  assert.match(d.stdout, /WOULD comment 7/)
  noWrites(d, 'dups')
  const drop = w.dropOld()
  assert.match(drop.stdout, new RegExp(`WOULD drop ${W.runId(2)}`))
  noWrites(drop, 'drop-old')
  assert.match(w.list(), new RegExp(W.runId(2)))
})

test('stage 0 of the source repo: --outbox prints WOULD and writes nothing', () => {
  const r = W.world({ settingsSrc: { stage: 0 }, recordsSrc: [W.outboxRec(R1)] }).outbox(R1)
  assert.match(r.stdout, /WOULD file Tester reports a stale sha/)
  assert.match(r.stdout, /WOULD put feedback-filed/)
  noWrites(r, 'outbox')
})

test('a paused feedback repo, or one with no routine key, gets no write from the collect path', () => {
  for (const flag of [{ pausedFb: true }, { noRoutineFb: true }]) {
    const w = W.world({ ...flag, settingsFb: { collectFrom: [W.SRC] }, recordsSrc: [W.outboxRec(R1, {}, { at: W.ago(9 * W.DAY) })] })
    for (const r of [w.outbox(R1), w.dropOld(), w.auto([item('X')], ['acme'], '--dups', w.file('d.json', []))]) {
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, 'paused alfhen/agent-pr-pipeline\n')
      noWrites(r, 'paused')
    }
  }
})

test('--outbox for a paused source repo prints paused <source> and leaves the outbox open', () => {
  for (const flag of [{ pausedSrc: true }, { noRoutineSrc: true }]) {
    const w = W.world({ ...flag, recordsSrc: [W.outboxRec(R1)] })
    const r = w.outbox(R1)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'paused acme/widgets\n')
    noWrites(r, 'paused source')
  }
})

test('the manual form does not use the quality bar, the cap or the markers', () => {
  const w = W.world({ issues: Array.from({ length: 6 }, (_, k) => ISSUE(10 + k)) })
  const r = w.sh('file-feedback.sh', [w.file('m.json', [item('Manual one', { evidence: '' })]), '--denylist', w.file('md.json', ['acme', 'widgets']), '--repo', W.FB, '--source', W.SRC])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.issuePosts.length, 1)
  assert.doesNotMatch(r.issuePosts[0], /auto-filed/)
})

const nonStrings = [
  ['an object detail', { detail: { 'Seen in acme/widgets at https://github.com/acme/widgets': 1 } }],
  ['a number detail', { detail: 4512 }],
  ['an object detail with a marker key', { detail: { '<!-- pipeline:outbox 20261105T120000Z-0a1b2c3d:0 -->': 1 } }],
  ['a number title', { title: 4512 }],
]

for (const [what, extra] of nonStrings) {
  test(`--auto refuses ${what} and posts nothing`, () => {
    const r = W.world().auto([item('Bad field', extra)], ['acme', 'widgets', '4512'])
    assert.match(r.stdout, /REFUSED .*: a field is not a string/)
    assert.equal(r.issuePosts.length, 0)
    assert.equal(r.comments.length, 0)
    const c = W.world().auto([item('Bad field', extra)], ['acme', 'widgets', '4512'], '--check')
    assert.match(c.stdout, /^REFUSED 0: a field is not a string/)
  })

  test(`--outbox refuses ${what} and posts no issue`, () => {
    const r = withOutbox({ rec: { items: [item('Bad field', extra)] } }).outbox(R1)
    assert.equal(r.issuePosts.length, 0, r.stdout)
    assert.match(r.stdout, /a field is not a string/)
  })
}

// A copy of main's script is the oracle for the manual form on items whose printed fields are all strings.
const MAIN_SCRIPT = join(root, 'test/fixtures/feedback/main-file-feedback.sh')
const manualCases = [
  ['all strings', item('Tester reports a stale sha')],
  ['a denylisted title', item('Seen in acme/widgets')],
  ['a null item', null],
  ['a string item', 'text'],
  ['no title', { detail: 'd' }],
]
const manualRefused = [
  ['a number title', { title: 4512, detail: 'd' }],
  ['a true title', { title: true, detail: 'd' }],
  ['an empty object title', { title: {}, detail: 'd' }],
  ['an array title', { title: ['x'], detail: 'd' }],
  ['an object detail', item('Bad field', { detail: { 'Seen in acme/widgets': 1 } })],
  ['a number severity', item('Bad field', { severity: 3 })],
  ['a number evidence', item('Bad field', { evidence: 4512 })],
]
for (const [what, bad] of manualRefused) {
  for (const flags of [[], ['--dry-run']]) {
    test(`the manual form refuses ${what} ${flags.join(' ')} and files the next item`, () => {
      const w = W.world()
      const r = w.sh('file-feedback.sh', [w.file('m.json', [bad, item('Second item')]), '--denylist', w.file('md.json', ['acme', 'widgets']), '--repo', W.FB, '--source', W.SRC, ...flags])
      assert.equal(r.status, 2, r.stdout)
      assert.match(r.stdout, /^REFUSED item 0: a field is not a string$/m)
      if (!flags.length) assert.equal(r.issuePosts.length, 1)
      else assert.match(r.stdout, /WOULD FILE Second item/)
    })
  }
}
for (const [what, bad] of manualCases) {
  for (const flags of [[], ['--dry-run']]) {
    test(`the manual form gives main's output for ${what} ${flags.join(' ')}`, () => {
      const run = script => {
        const w = W.world()
        return w.sh(script, [w.file('m.json', [bad, item('Second item')]), '--denylist', w.file('md.json', ['acme', 'widgets', '4512']), '--repo', W.FB, '--source', W.SRC, ...flags])
      }
      const branch = run('file-feedback.sh'); const main = run(MAIN_SCRIPT)
      assert.equal(branch.stdout, main.stdout)
      assert.equal(branch.status, main.status)
      assert.deepEqual(branch.writes, main.writes)
    })
  }
}

test('an item with no title key is refused as no title in every form', () => {
  const noTitle = { detail: 'd', evidence: 'e', suggestedChange: 's', severity: 'minor' }
  const w = W.world()
  const r = w.sh('file-feedback.sh', [w.file('nt.json', [noTitle]), '--denylist', w.file('ntd.json', ['acme', 'widgets', '4512']), '--repo', W.FB, '--source', W.SRC])
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stdout, /^REFUSED item 0: no title$/m)
  assert.equal(r.issuePosts.length, 0)
  const c = W.world().auto([noTitle], ['acme', 'widgets', '4512'], '--check')
  assert.match(c.stdout, /^REFUSED 0: no title/)
})

for (const [what, bad] of [
  ['a null item', null],
  ['a string item', 'text'],
  ['a number item', 7],
  ['an array item', ['x']],
  ['a title of false', { title: false, detail: 'd' }],
  ['an empty title with a non-string field', { title: '', detail: 4512 }],
  ['no title with a non-string field', { detail: { a: 1 } }],
]) {
  test(`${what} is refused as no title in every form`, () => {
    const w = W.world()
    const r = w.sh('file-feedback.sh', [w.file('nt.json', [bad]), '--denylist', w.file('ntd.json', ['acme', 'widgets', '4512']), '--repo', W.FB, '--source', W.SRC])
    assert.equal(r.status, 2, r.stdout)
    assert.match(r.stdout, /^REFUSED item 0: no title$/m)
    assert.equal(r.issuePosts.length, 0)
    const c = W.world().auto([bad], ['acme', 'widgets', '4512'], '--check')
    assert.match(c.stdout, /^REFUSED 0: no title/)
  })
}

test('a failure inside a helper shows its reason on stderr', () => {
  const w = W.world()
  rmSync(join(w.dir, 'fx', `repos__${W.FB.replace('/', '__')}__contents__.github__pipeline.json.json`))
  const r = w.dropOld()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /cannot read/)
})
