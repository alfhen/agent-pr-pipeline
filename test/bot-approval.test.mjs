// Runs scripts/bot-approval.jq on fixture input, and merge-pr.sh against test/fake-gh for the older-approval case.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const JQ = join(root, 'scripts/bot-approval.jq')
const BOT = 'gitar-bot[bot]'
const HEAD = 'h'.repeat(40)
const OLD = 'o'.repeat(40)
const review = (state, commit, login = BOT) => ({ id: 1, user: { login }, state, body: 'x', commit_id: commit, submitted_at: '2026-01-01T00:00:00Z' })
const check = (conclusion, name = 'Gitar', status = 'completed') => ({ name, status, conclusion })
const gate = (reviews, checks) => {
  const r = spawnSync('jq', ['-c', '-f', JQ], { input: JSON.stringify({ reviews, comments: [], checks, head: HEAD, bots: 'coderabbit|gitar|\\[bot\\]' }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('an approval on an older commit with no check run does not clear', () => {
  const reviews = [review('APPROVED', OLD)]
  assert.notEqual(reviews[0].commit_id, HEAD)
  assert.deepEqual(gate(reviews, []), [])
})

test('an approval on an older commit with a neutral check does not clear', () => {
  assert.deepEqual(gate([review('APPROVED', OLD)], [check('neutral')]), [])
})

test('an approval on an older commit with a check still running does not clear', () => {
  assert.deepEqual(gate([review('APPROVED', OLD)], [check(null, 'Gitar', 'in_progress')]), [])
})

test('an approval on an older commit with a successful check of another bot does not clear', () => {
  assert.deepEqual(gate([review('APPROVED', OLD)], [check('success', 'CodeRabbit')]), [])
})

test('an approval on an older commit with a successful check on the head clears as approved earlier', () => {
  assert.deepEqual(gate([review('APPROVED', OLD)], [check('success')]), [`${BOT} (approved earlier)`])
})

test('an approval on the head clears with no check, as a bare login', () => {
  assert.deepEqual(gate([review('APPROVED', HEAD)], []), [BOT])
})

test('a changes request with no later approval still blocks', () => {
  assert.deepEqual(gate([review('CHANGES_REQUESTED', HEAD)], [check('success')]), [])
})

test('bot-status.sh strips every suffix that bot-approval.jq can print', () => {
  const jq = readFileSync(JQ, 'utf8')
  const words = [...jq.matchAll(/" \(([a-z ]+)\)"/g)].map((m) => m[1])
  assert.deepEqual([...words].sort(), ['answered', 'approved earlier'])
  const sh = readFileSync(join(root, 'scripts/bot-status.sh'), 'utf8')
  const sub = sh.match(/sub\("([^"]+)"; ""\)/)[1]
  const re = new RegExp(sub.replace(/\\\\/g, '\\'))
  for (const w of words) assert.equal(`${BOT} (${w})`.replace(re, ''), BOT, w)
})

test('merge-pr.sh does not merge an older approval with no check on the head', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-approval-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const put = (name, v) => writeFileSync(join(fx, name), JSON.stringify(v))
  const P = 'repos__o__r'
  put(`${P}.json`, { default_branch: 'main' })
  put(`${P}__pulls__7.json`, { merged: false, mergeable: true, head: { sha: HEAD, ref: 'feat/x', repo: { full_name: 'o/r' } } })
  put(`${P}__commits__${HEAD}__check-runs.json`, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
  put(`${P}__commits__${HEAD}__status.json`, { state: 'success', statuses: [] })
  put(`${P}__pulls__7__reviews.json`, [review('APPROVED', OLD)])
  put(`${P}__pulls__7__comments.json`, [])
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: fx, FAKE_GH_LOG: join(dir, 'log'), PIPELINE_TEST_FAST: '1' }
  delete env.CLAUDECODE
  const r = spawnSync('bash', [join(root, 'scripts/merge-pr.sh'), '--person', 'o/r', '7', HEAD, 'feat/x'], { env, encoding: 'utf8' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /approved=\[\]/)
  assert.match(r.stdout, /NOT merged/)
})
