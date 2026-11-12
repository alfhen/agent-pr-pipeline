// Runs scripts/after-run.sh against test/fake-gh in a temp HOME and folder under os.tmpdir(). Each test name starts with its eval id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT = join(root, 'scripts/after-run.sh')
const ISSUE = 7
const COMMENTS = `repos__o__r__issues__${ISSUE}__comments`

const msg = (id, u) => ({ type: 'assistant', message: { id, usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] } } })

function setup({ issue = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'after-run-test-'))
  const home = join(dir, 'home'); mkdirSync(home)
  const bin = join(dir, 'bin'); mkdirSync(bin)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const fx = join(dir, 'fx'); mkdirSync(fx)
  writeFileSync(join(fx, 'user.json'), JSON.stringify({ login: 'alfhen' }))
  writeFileSync(join(fx, 'repos__o__r__issues.json'), JSON.stringify(issue ? [{ number: ISSUE, state: 'open', user: { login: 'alfhen' }, labels: [{ name: 'pipeline-ledger' }] }] : []))
  writeFileSync(join(fx, `${COMMENTS}.json`), '[]')
  writeFileSync(join(fx, `${COMMENTS}.POST.json`), JSON.stringify({ id: 900 }))
  const work = join(dir, 'work'); mkdirSync(work)
  const tmp = join(dir, 'tmp'); mkdirSync(tmp)
  const out = join(dir, 'output.json')
  writeFileSync(out, JSON.stringify({
    summary: 's', agentCount: 4, totalTokens: 9000, logs: [],
    result: { prs: [{ id: 'X1', ready: true, reason: null, history: [{ round: 1 }] }, { id: 'X2', ready: false, reason: 'needs human: x', history: [{ round: 1 }] }] },
  }, null, 2))
  const folder = join(dir, 'transcripts-t1'); mkdirSync(folder)
  ;[['X1', 'reviewer'], ['X2', 'reviewer'], ['X1', 'tester'], ['X2', 'tester']].forEach(([pr, role], i) => {
    writeFileSync(join(folder, `agent-${i}.jsonl`), [{ type: 'user', message: { content: 'x' } }, msg(`m${i}`, [1, 10, 100, 5])].map(l => JSON.stringify(l)).join('\n') + '\n')
    writeFileSync(join(folder, `agent-${i}.meta.json`), JSON.stringify({ agentType: `agent-pr-pipeline:${role}`, description: `${role}:${pr}#1` }))
  })
  return { dir, home, bin, fx, work, tmp, out, folder, log: join(dir, 'log') }
}

function run(s, args) {
  rmSync(s.log, { force: true })
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd: s.work, encoding: 'utf8',
    env: { ...process.env, HOME: s.home, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log },
  })
  const calls = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  const writes = calls.filter(c => /^(POST|PATCH|PUT|DELETE) /.test(c))
  const posts = calls.filter(c => c.startsWith(`POST /repos/o/r/issues/${ISSUE}/comments`))
  const records = posts.map(p => JSON.parse(p.split('```json\\n')[1].split('\\n```')[0]))
  return { ...r, calls, writes, posts, records }
}
const tokenFiles = s => readdirSync(s.tmp).filter(f => f.startsWith('tokens'))
const withTr = (s, id) => [ 'o/r', s.out, s.tmp, '--run', id, '--transcripts', s.folder ]

test('A09-1 writes the tokens file and one record per PR under the given run id', () => {
  const s = setup()
  const r = run(s, withTr(s, 'wf_t1'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /total tokens: /)
  assert.equal(r.posts.length, 2)
  assert.equal(r.posts.filter(p => p.includes('<!-- pipeline:ledger v1 wf_t1 X1 -->')).length, 1)
  assert.equal(r.posts.filter(p => p.includes('<!-- pipeline:ledger v1 wf_t1 X2 -->')).length, 1)
  assert.ok(r.posts.every(p => !p.includes('transcripts-t1')))
  for (const rec of r.records) { assert.equal(rec.tokens.source, 'transcripts'); assert.equal(rec.tokens.comparable, true); assert.equal(rec.run, 'wf_t1') }
  const files = tokenFiles(s)
  assert.equal(files.length, 1)
  const t = JSON.parse(readFileSync(join(s.tmp, files[0]), 'utf8'))
  assert.equal(t.comparable, true)
  assert.deepEqual(t.prs.map(p => p.id).sort(), ['X1', 'X2'])
})

test('A09-2 without transcripts the records say comparable false; a bad output file writes nothing', () => {
  const s = setup()
  const a = run(s, ['o/r', s.out, s.tmp, '--run', 'wf_t2'])
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /transcripts: not available/)
  assert.equal(a.posts.length, 2)
  assert.ok(a.posts[0].includes('<!-- pipeline:ledger v1 wf_t2 X1 -->'))
  assert.ok(a.posts[1].includes('<!-- pipeline:ledger v1 wf_t2 X2 -->'))
  for (const rec of a.records) { assert.equal(rec.tokens.comparable, false); assert.equal(rec.tokens.source, 'totals') }

  const b = setup()
  const rb = run(b, ['o/r', join(b.dir, 'nope.json'), b.tmp, '--run', 'wf_t3', '--transcripts', b.folder])
  assert.ok([1, 64, 65].includes(rb.status), `status ${rb.status}`)
  assert.ok(rb.stderr.includes(join(b.dir, 'nope.json')))
  assert.equal(rb.writes.length, 0)
  assert.deepEqual(tokenFiles(b), [])

  const c = setup()
  const bad = join(c.dir, 'bad.json'); writeFileSync(bad, '{"x":1}')
  const rc = run(c, ['o/r', bad, c.tmp, '--run', 'wf_t3', '--transcripts', c.folder])
  assert.ok([1, 64, 65].includes(rc.status), `status ${rc.status}`)
  assert.ok(rc.stderr.includes(bad) || rc.stderr.includes('not a workflow output'))
  assert.equal(rc.posts.length, 0)
  assert.deepEqual(tokenFiles(c), [])
})

test('A09-22 no --run exits 64 with the usage line and does nothing', () => {
  const s = setup()
  const r = run(s, ['o/r', s.out, s.tmp, '--transcripts', s.folder])
  assert.equal(r.status, 64)
  assert.match(r.stderr, /usage:/)
  assert.match(r.stderr, /--run/)
  assert.equal(r.writes.length, 0)
  assert.deepEqual(tokenFiles(s), [])
})

test('A09-10 --land-fix goes on to ledger.sh put', () => {
  const s = setup()
  const a = run(s, [...withTr(s, 'wf_l1'), '--land-fix'])
  assert.equal(a.status, 0, a.stderr)
  assert.equal(a.records.length, 2)
  assert.ok(a.records.every(r => r.kind === 'land-fix'))
  const b = run(s, withTr(s, 'wf_l2'))
  assert.equal(b.status, 0, b.stderr)
  assert.ok(b.records.length === 2 && b.records.every(r => r.kind === 'wave'))
})

test('A09-11 no ledger issue: exits non-zero, passes the message on, writes nothing', () => {
  const s = setup({ issue: false })
  const r = run(s, withTr(s, 'wf_n1'))
  assert.notEqual(r.status, 0)
  assert.notEqual(r.status, 127)
  assert.match(r.stdout + r.stderr, /no ledger issue/)
  assert.equal(r.writes.length, 0)
})
