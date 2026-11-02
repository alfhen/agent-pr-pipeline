// Runs scripts/file-feedback.sh against test/fake-gh on fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
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
