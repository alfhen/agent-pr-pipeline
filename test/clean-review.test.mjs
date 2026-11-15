// The fourth way to clear the gate: a clean CodeRabbit review that the session asked for. Runs scripts/merge-pr.sh and
// scripts/bot-status.sh against test/fake-gh with fixtures from test/fixtures/clean-review/ (real answers of PRs 793, 794, 800, 801, 804 and 805, and one made fixture).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const P = 'repos__o__r'
const BOT = 'coderabbitai[bot]'
const CLEAN = `approved=[${BOT} (clean review)]`
const fixture = (name) => JSON.parse(readFileSync(join(root, 'test/fixtures/clean-review', name), 'utf8'))
const pr794 = () => fixture('pr794-33b6f35.json')
const pr793 = () => fixture('pr793-334a3cb.json')
const made = () => fixture('made-pr794-900bd64.json')
const pr800 = () => fixture('pr800-3ecb04e.json')
const pr801 = () => fixture('pr801-da0b70d.json')
const pr804 = () => fixture('pr804-f57c99a.json')
const pr805 = () => fixture('pr805-f36bb8e.json')
const mut = (base, f) => { const fx = base(); f(fx); return fx }
const botRun = (fx) => fx.checks.find((c) => c.app.slug === 'coderabbitai' && c.conclusion === 'success')
const ciRun = (fx) => fx.checks.find((c) => c.app.slug === 'github-actions')
const request = (fx) => fx.issueComments.filter((c) => c.body === '@coderabbitai full review').at(-1)
const botReview = (fx) => fx.reviews.find((r) => r.user.login === BOT)
const answer = (fx) => fx.issueComments.find((c) => c.body.startsWith('<!-- pipeline-bot-answer'))
const nitSection = (body) => body.slice(body.indexOf('<details>'), body.indexOf('\n---\n') + 1)
// The made fixture without its nitpick section: one answered inline Minor and the frame only, which clears.
const madeClean = () => mut(made, (fx) => { botReview(fx).body = botReview(fx).body.replace(nitSection(botReview(fx).body), '') })

// A scripts folder other than the repo's can be run, to test a changed rule.
const run = (fx, { scripts = join(root, 'scripts'), script = 'merge-pr.sh', args = ['--person'], pr = 7 } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'clean-review-'))
  const bin = join(dir, 'bin'); const fxd = join(dir, 'fx'); const home = join(dir, 'home')
  mkdirSync(bin); mkdirSync(fxd); mkdirSync(home)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const put = (name, v) => writeFileSync(join(fxd, name), JSON.stringify(v))
  const head = fx.head
  const pull = { merged: false, mergeable: true, title: 't', body: '', head: { sha: head, ref: 'feat/x', repo: { full_name: 'o/r' } } }
  put(`${P}.json`, { default_branch: 'main' })
  put(`${P}__pulls__${pr}.json`, pull)
  put('pull-merged.json', { ...pull, merged: true })
  writeFileSync(join(fxd, `${P}__pulls__${pr}__merge.PUT.then`), `pull-merged.json ${P}__pulls__${pr}.json\n`)
  put(`${P}__pulls__${pr}__merge.PUT.json`, { merged: true })
  put(`${P}__commits__${head}__check-runs.json`, { check_runs: fx.checks })
  put(`${P}__commits__${head}__status.json`, { state: 'success', statuses: [] })
  fx.suites.forEach((page, i) => put(`${P}__commits__${head}__check-suites.${i + 1}.json`, { check_suites: page }))
  if (fx.suites.length === 0) put(`${P}__commits__${head}__check-suites.json`, { check_suites: [] })
  put('user.json', { login: fx.user })
  put(`${P}__pulls__${pr}__reviews.json`, fx.reviews)
  put(`${P}__pulls__${pr}__comments.json`, fx.comments)
  put(`${P}__issues__${pr}__comments.json`, fx.issueComments)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_GH_FIXTURES: fxd, FAKE_GH_LOG: join(dir, 'log'), PIPELINE_TEST_FAST: '1' }
  delete env.CLAUDECODE; delete env.BOT_LOGINS
  const argv = script === 'merge-pr.sh' ? [join(scripts, script), ...args, 'o/r', String(pr), head, 'feat/x'] : [join(scripts, script), 'o/r', String(pr)]
  const r = spawnSync('bash', argv, { env, encoding: 'utf8' })
  let log = ''
  try { log = readFileSync(join(dir, 'log'), 'utf8') } catch {}
  return { status: r.status, out: r.stdout + r.stderr, log, why: (r.stdout.match(/^clean review: .*$/m) || [''])[0] }
}
const puts = (x) => x.log.split('\n').filter((l) => /^PUT \/repos\/o\/r\/pulls\/\d+\/merge/.test(l))
const merged = (x) => {
  assert.equal(x.status, 0, x.out)
  assert.ok(x.out.includes(CLEAN), x.out)
  assert.equal(puts(x).length, 1, x.log)
}
// A refused case prints the empty list, a clean review line that holds `word`, and makes no merge call.
const refused = (x, word) => {
  assert.equal(x.status, 1, x.out)
  assert.ok(x.out.includes('approved=[]'), x.out)
  assert.ok(x.out.includes('NOT merged'), x.out)
  assert.match(x.why, /^clean review: /, x.out)
  assert.match(x.why, word, x.why)
  assert.equal(puts(x).length, 0, x.log)
}
const BOT_RUN = /bot's run/
const CI = /green CI/
const REQUEST = /request comment|push time/
const REPLIES = /replies/
const CHANGES = /CHANGES_REQUESTED/
const RULE_A = /rule A/

test('positive: the clean run of PR 794 at 33b6f35 merges as a clean review', () => {
  const fx = pr794()
  assert.equal(fx.reviews.filter((r) => r.user.login === BOT).length, 0)
  const x = run(fx)
  merged(x)
  assert.match(x.out.split('\n')[0], /^PR \d+ mergeable=\S+ head=\w{7} approved=\[.*\] failing=\[.*\] mode=\w+$/)
})

test('positive: the answered review of PR 793 merges as a clean review', () => {
  const fx = pr793()
  assert.equal(botReview(fx).commit_id, fx.head)
  assert.equal(answer(fx), undefined)
  merged(run(fx))
})

test('positive: the real reviews of PRs 800 and 801 (one inline Minor, a Note answer) merge as a clean review', () => {
  for (const fx of [pr800(), pr801()]) {
    assert.ok(fx.issueComments.some((c) => c.user.login === 'alfhen' && c.body === '@coderabbitai full review'))
    assert.ok(fx.comments.some((c) => c.body.startsWith('Note, not filed:')))
    merged(run(fx))
  }
})

test('the gate never reads the date of the commit', () => {
  const x = run(pr794())
  merged(x)
  assert.equal(x.log.split('\n').filter((l) => /^GET \/repos\/o\/r\/commits\/\w+$/.test(l) || l.includes('/git/commits/')).length, 0, x.log)
  const src = ['review-request.jq', 'bot-approval.jq', 'merge-pr.sh', 'bot-status.sh'].map((f) => readFileSync(join(root, 'scripts', f), 'utf8')).join('\n')
  assert.doesNotMatch(src, /committer|author\.date|\.commit\./)
})

test('the fourth way clears coderabbitai only: the same run made by the App of another bot clears nothing', () => {
  refused(run(mut(pr794, (fx) => { botRun(fx).app.slug = 'gitar-bot' })), BOT_RUN)
})

test('only the newest run of the bot App decides', () => {
  merged(run(madeClean()))
  const fx = mut(madeClean, (f) => { f.checks.find((c) => c.conclusion === 'skipped').started_at = '2026-11-15T00:50:00Z' })
  assert.ok(fx.checks.find((c) => c.conclusion === 'skipped').started_at > request(fx).created_at)
  refused(run(fx), BOT_RUN)
  assert.match(run(fx).why, /skipped/)
})

test('green CI is a successful run of an App that is not a review bot', () => {
  refused(run(mut(pr794, (fx) => { fx.checks = fx.checks.filter((c) => c !== ciRun(fx)) })), CI)
  refused(run(mut(pr794, (fx) => { ciRun(fx).app.slug = 'gitar-bot' })), CI)
  refused(run(mut(pr794, (fx) => { ciRun(fx).conclusion = 'failure' })), /./)
  refused(run(mut(pr794, (fx) => { ciRun(fx).conclusion = 'neutral' })), CI)
})

test('the request: its author, its whole text, its time and the check suites of every page', () => {
  const fx0 = pr794()
  assert.equal(fx0.suites.length, 2)
  assert.ok(fx0.suites[0][0].created_at > request(fx0).created_at)
  assert.ok(fx0.suites[1].every((s) => s.created_at < request(fx0).created_at))
  merged(run(fx0))
  refused(run(mut(pr794, (fx) => { request(fx).user.login = 'someone' })), REQUEST)
  refused(run(mut(pr794, (fx) => { request(fx).body = '@coderabbitai full review please' })), REQUEST)
  refused(run(mut(pr794, (fx) => { request(fx).body = '@coderabbitai review' })), REQUEST)
  refused(run(mut(pr794, (fx) => { request(fx).created_at = '2026-11-15T01:02:00Z'; fx.issueComments = fx.issueComments.filter((c) => c === request(fx) || c.body !== '@coderabbitai full review') })), REQUEST)
  refused(run(mut(pr794, (fx) => { fx.suites = [] })), /push time/)
})

test('a request that is after the start of the run clears nothing', () => {
  refused(run(mut(pr794, (fx) => { request(fx).created_at = '2026-11-15T01:54:30Z' })), REQUEST)
})

test('replies: every top-level inline comment of the bot needs a reply of the user, and a change request blocks', () => {
  merged(run(pr793()))
  refused(run(mut(pr793, (fx) => { fx.comments = fx.comments.filter((c) => c.id !== fx.comments.find((d) => d.user.login === 'alfhen').id) })), REPLIES)
  refused(run(mut(pr793, (fx) => { fx.comments.find((c) => c.user.login === 'alfhen').user.login = BOT })), REPLIES)
  refused(run(mut(pr793, (fx) => { fx.reviews.push({ id: 5, user: { login: BOT }, state: 'CHANGES_REQUESTED', body: '', commit_id: 'a'.repeat(40), submitted_at: '2026-11-14T21:41:00Z' }) })), CHANGES)
  merged(run(mut(pr793, (fx) => {
    fx.reviews.push({ id: 5, user: { login: BOT }, state: 'CHANGES_REQUESTED', body: '', commit_id: 'a'.repeat(40), submitted_at: '2026-11-14T21:00:00Z' })
    fx.reviews.push({ id: 6, user: { login: BOT }, state: 'APPROVED', body: '', commit_id: 'a'.repeat(40), submitted_at: '2026-11-14T21:01:00Z' })
  })))
})

test('rule A, inline findings: the count, the rank and an answer with an issue number or a Note', () => {
  const replies = pr793().comments.filter((c) => c.user.login === 'alfhen')
  assert.equal(replies.length, 2)
  for (const r of replies) assert.ok(/#\d+/.test(r.body) && !r.body.startsWith('Note, not filed:'))
  merged(run(pr793()))
  for (const base of [pr800, pr801]) {
    const [r] = base().comments.filter((c) => c.user.login === 'alfhen')
    assert.ok(r.body.startsWith('Note, not filed:') && !/#\d+/.test(r.body))
    merged(run(base()))
  }
  refused(run(mut(pr800, (fx) => { const r = fx.comments.find((c) => c.user.login === 'alfhen'); r.body = r.body.replace('Note, not filed:', 'Not filed:') })), RULE_A)
  refused(run(mut(pr793, (fx) => { botReview(fx).body = botReview(fx).body.replace('posted: 2', 'posted: 3') })), RULE_A)
  refused(run(mut(pr793, (fx) => { const c = fx.comments.find((d) => d.user.login === BOT); c.body = c.body.replace('Minor', 'Major') })), RULE_A)
  refused(run(mut(pr793, (fx) => { fx.comments.filter((c) => c.user.login === 'alfhen')[0].body = 'fixed' })), RULE_A)
  refused(run(mut(pr793, (fx) => { fx.comments.filter((c) => c.user.login === 'alfhen')[1].body = 'Note: not filed, fixed' })), RULE_A)
})

test('rule A refuses an inline comment whose rank it cannot read', () => {
  refused(run(mut(pr793, (fx) => {
    fx.comments.find((c) => c.user.login === BOT).body = '<!-- coderabbit-ai-generated:v1 -->\n\n_⚠️ Potential issue_ | _🔴 Critical_\n\n**Data loss on throw.**'
  })), RULE_A)
})

test('rule A refuses a body section or finding line in a form no real fixture has', () => {
  refused(run(mut(pr793, (fx) => {
    botReview(fx).body = botReview(fx).body.replace('---', '<details>\n<summary>Potential issues (1)</summary>\n\n`10-12`: _🔴 Critical_ · **Data loss**\n\n</details>\n\n---')
  })), RULE_A)
  refused(run(mut(pr793, (fx) => {
    botReview(fx).body = botReview(fx).body.replace('---', '<details>\n<summary>Nitpick comments</summary>\n\nLine 50: **Trivial** · **Quick win**\n\n</details>\n\n---')
  })), RULE_A)
})

test('rule A refuses what it cannot rank', () => {
  const body = (f) => (fx) => { botReview(fx).body = f(botReview(fx).body) }
  refused(run(mut(pr793, body((b) => b.replace('---', '<details>\n<summary>Outside diff range comments (1)</summary>\n`9-9`: **Minor**\n</details>\n\n---')))), RULE_A)
  refused(run(mut(pr793, body((b) => b + '\n<summary>Duplicate comments (1)</summary>'))), RULE_A)
  refused(run(mut(pr793, body((b) => b.replace('**Actionable comments posted: 2**\n\n', '')))), RULE_A)
  refused(run(mut(pr793, (fx) => { const c = fx.comments.find((d) => d.user.login === BOT); c.body = c.body.replace('Minor', 'Critical') })), RULE_A)
  refused(run(mut(pr793, (fx) => { fx.comments.filter((c) => c.user.login === 'alfhen')[0].body = 'ok' })), RULE_A)
  refused(run(mut(pr793, (fx) => { fx.reviews.push({ ...botReview(fx), id: 2, body: 'Some new format', submitted_at: '2026-11-14T21:41:00Z' }) })), RULE_A)
})

test('rule A refuses a body of a form no real fixture has, whatever its count line says', () => {
  const crit = '<details>\n<summary>Potential issues (1)</summary>\n\n`10-12`: _🔴 Critical_ · **Data loss**\n\n</details>\n'
  refused(run(mut(madeClean, (fx) => { botReview(fx).body = '<!-- coderabbit-ai-generated:v1 -->\n\n**Actionable comments posted: 1**\n\n' + crit })), RULE_A)
  refused(run(mut(madeClean, (fx) => { botReview(fx).body = botReview(fx).body.replace('---', '<details>\n<summary>Refactor comments: 1</summary>\n\n`50-50`: **Trivial** · **Quick win**\n\n</details>\n\n---') })), RULE_A)
  refused(run(mut(pr793, (fx) => { botReview(fx).body = botReview(fx).body.replace('---', '<details>\n<summary>Issues: 1</summary>\n\n- Line 10: **Critical** data loss\n\n</details>\n\n---') })), RULE_A)
  refused(run(mut(pr793, (fx) => { botReview(fx).body = botReview(fx).body.replace('---', '### Potential issues\n\n- Line 10: **Critical** data loss\n\n---') })), RULE_A)
})

test('rule A refuses a body with text left after the known blocks are cut', () => {
  const sentence = 'Also check the null input of parse in foo.js; it can lose data.'
  refused(run(mut(pr793, (fx) => { botReview(fx).body = botReview(fx).body.replace('---', sentence + '\n\n---') })), RULE_A)
  refused(run(mut(madeClean, (fx) => { botReview(fx).body += '\n' + sentence })), RULE_A)
  refused(run(mut(madeClean, (fx) => { botReview(fx).body = '<!-- coderabbit-ai-generated:v1 -->\n\n**Actionable comments posted: 1**\n\n' + sentence + '\n' })), RULE_A)
  merged(run(pr793())); merged(run(madeClean()))
  const noCheckbox = mut(pr793, (fx) => { const b = botReview(fx).body; botReview(fx).body = b.slice(0, b.indexOf('<!-- autofix_checkbox_start -->')) + b.slice(b.indexOf('<!-- autofix_checkbox_end -->') + '<!-- autofix_checkbox_end -->'.length) })
  assert.doesNotMatch(botReview(noCheckbox).body, /Fix comments/)
  merged(run(noCheckbox))
})

test('a run that is not a clean, completed review of the head clears nothing', () => {
  const change = (f, word = BOT_RUN) => refused(run(mut(pr794, (fx) => f(botRun(fx), fx))), word)
  for (const title of ['Review skipped', 'Review paused', 'No files to review', 'Too many files to review', 'Incremental review skipped']) {
    change((r) => { r.conclusion = 'skipped'; r.output.title = title })
  }
  change((r) => { r.conclusion = 'neutral'; r.output.title = 'Review rate limited' })
  change((r) => { r.conclusion = 'cancelled' })
  change((r) => { r.conclusion = 'failure' })
  change((r) => { r.output.title = 'Review failed' })
  change((r) => { r.output.summary = 'Result: Success - Review failed' })
  change((r) => { r.status = 'in_progress'; r.conclusion = null })
  change((r) => { r.head_sha = 'c'.repeat(40) })
  change((r, fx) => { fx.checks = fx.checks.filter((c) => c !== r) })
  change((r) => { r.started_at = '2026-11-15T01:53:00Z' }, REQUEST)
})

test('the line names the first condition that did not hold', () => {
  const x = run(mut(pr794, (fx) => { botRun(fx).conclusion = 'skipped'; fx.checks = fx.checks.filter((c) => c !== ciRun(fx)) }))
  assert.match(x.why, BOT_RUN)
  const y = run(mut(pr794, (fx) => { fx.checks = fx.checks.filter((c) => c !== ciRun(fx)); fx.issueComments = fx.issueComments.filter((c) => c !== request(fx)) }))
  assert.match(y.why, CI); assert.doesNotMatch(y.why, /request/)
  const z = run(mut(pr794, (fx) => {
    fx.issueComments = fx.issueComments.filter((c) => c !== request(fx))
    fx.comments.push({ id: 77, user: { login: BOT }, in_reply_to_id: null, pull_request_review_id: 1, body: '**Minor**' })
  }))
  assert.match(z.why, REQUEST); assert.doesNotMatch(z.why, /replies/)
})

test('a bot that approved the head clears by the old way and prints no clean review line', () => {
  const fx = mut(pr794, (f) => {
    f.reviews.push({ id: 3, user: { login: 'gitar-bot[bot]' }, state: 'APPROVED', body: '', commit_id: f.head, submitted_at: '2026-11-15T01:50:00Z' })
    f.issueComments = f.issueComments.filter((c) => c !== request(f))
  })
  const x = run(fx)
  assert.equal(x.status, 0, x.out)
  assert.ok(x.out.includes('approved=[gitar-bot[bot]]'), x.out)
  assert.doesNotMatch(x.out, /^clean review:/m)
})

test('bot-status.sh prints the bare login in seenHead and keeps its six keys', () => {
  const x = run(pr794(), { script: 'bot-status.sh' })
  const j = JSON.parse(x.out.trim().split('\n').at(-1))
  assert.deepEqual(Object.keys(j), ['head', 'approvedBy', 'seenHead', 'pending', 'openThreads', 'reviewBodies'])
  assert.deepEqual(j.approvedBy, [`${BOT} (clean review)`])
  assert.deepEqual(j.seenHead, [BOT])
})

// A copy of scripts/ with one rule changed, run on the clean case.
const changedScripts = (from, to, file = 'review-request.jq') => {
  const dir = mkdtempSync(join(tmpdir(), 'clean-review-scripts-'))
  const scripts = join(dir, 'scripts')
  cpSync(join(root, 'scripts'), scripts, { recursive: true })
  const text = readFileSync(join(scripts, file), 'utf8')
  assert.ok(text.includes(from), from)
  writeFileSync(join(scripts, file), text.replace(from, to))
  return scripts
}

test('the request rule and the completed-review rule are in review-request.jq, and the gate reads them from there', () => {
  merged(run(pr794()))
  refused(run(pr794(), { scripts: changedScripts('@coderabbitai full review', '@coderabbitai full reviewX') }), REQUEST)
  refused(run(pr794(), { scripts: changedScripts('Result: Success - Review completed', 'Result: Success - Review done') }), BOT_RUN)
  const grep = (text) => spawnSync('grep', ['-rl', '-F', text, join(root, 'scripts')], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map((p) => p.split('/').at(-1))
  assert.deepEqual(grep('@coderabbitai full review'), ['review-request.jq'])
  assert.deepEqual(grep('Review completed'), ['review-request.jq'])
  assert.deepEqual(grep('Actionable comments posted: 0'), ['review-request.jq'])
})

test('(doc) four ways to clear the gate are described, with the clean review that was asked for', () => {
  const read = (f) => readFileSync(join(root, f), 'utf8')
  const skill = read('skills/pr-pipeline/SKILL.md')
  const step10 = skill.split('\n').find((l) => l.startsWith('10. **Bots.**'))
  assert.match(step10, /clean review/); assert.match(step10, /@coderabbitai full review/)
  const gate = skill.split('\n').find((l) => l.includes('bot-approval.jq') && l.includes('three ways') === false && /fourth|four ways/.test(l))
  assert.ok(gate, 'the gate paragraph of Step 3 names a fourth way')
  assert.match(gate, /clean review/); assert.match(gate, /@coderabbitai full review/)
  const row = skill.split('\n').find((l) => l.startsWith('|') && l.includes('approved=[]'))
  assert.match(row, /clean review:/)
  assert.ok(skill.split('\n').some((l) => l.includes('scripts/review-request.jq')))
  for (const f of ['README.md', 'docs/explainer.html']) assert.match(read(f), /clean review/, f)
  assert.match(read('scripts/land-wave.sh').split('\n')[5], /clean review/)
  for (const f of ['skills/pr-pipeline/SKILL.md', 'README.md', 'docs/explainer.html', 'scripts/land-wave.sh', 'scripts/review-request.jq', 'scripts/bot-approval.jq']) assert.doesNotMatch(read(f), /—/, f)
})

test('rule A refuses a Run configuration line with a key no real body has', () => {
  refused(run(mut(pr793, (fx) => {
    botReview(fx).body = botReview(fx).body.replace('- **Layers**: Repository YAML', '- **Layers**: Repository YAML\n- **Potential issue**: Line 10 of foo.js is Critical: data loss')
  })), RULE_A)
})

test('rule A refuses an Included review availability line outside the Review info block', () => {
  refused(run(mut(pr793, (fx) => {
    botReview(fx).body = botReview(fx).body.replace('**Actionable comments posted: 2**', '**Actionable comments posted: 2**\n\n**Included review availability:** Line 10 of foo.js: Critical data loss')
  })), RULE_A)
  merged(run(pr800())); merged(run(pr801()))
})

const bodyOf = (base, f) => refused(run(mut(base, (fx) => { botReview(fx).body = f(botReview(fx).body, fx) })), RULE_A)

test('rule A refuses a Run configuration value in a form no real body has', () => {
  bodyOf(pr793, (b) => b.replace('- **Review profile**: CHILL', '- **Review profile**: CHILL. Critical: foo.js line 10 loses data'))
  for (const fx of [pr793(), pr800(), pr801()]) assert.ok(botReview(fx).body.includes('- **Review profile**: CHILL'))
  merged(run(pr793()))
})

test('rule A refuses a Files selected item that is not a bare file path, or a count that differs', () => {
  bodyOf(pr793, (b) => b.replace('* `scripts/cleanup.sh`', '* `scripts/cleanup.sh`\n* `Critical: foo.js line 10 loses data`'))
  bodyOf(pr793, (b) => b.replace('Files selected for processing: 6', 'Files selected for processing: 7'))
})

test('rule A refuses a prompt block at a place or count no real body has, or with text outside its fence', () => {
  const block = '<details>\n<summary>Prompt to fix all issues</summary>\n<dl>\n<dd>\n\n```\nOutside diff range comments: Critical data loss at foo.js line 10\n```\n\n</dd>\n</dl>\n</details>'
  bodyOf(pr793, (b) => b.replace('**Actionable comments posted: 2**', '**Actionable comments posted: 2**\n\n' + block))
  bodyOf(pr793, (b) => b.replace('review. Visit https://docs.coderabbit.ai/cli?utm_source=ghpr\n```', 'review. Visit https://docs.coderabbit.ai/cli?utm_source=ghpr\n```\n\n### Potential issues\n\n- Line 10: **Critical** data loss\n\n```\n```'))
  bodyOf(pr793, (b) => b.replace('---', '<details>\n<summary>Prompt for AI Agents</summary>\n<dl>\n<dd>\n\n```\nCritical: data loss at line 10 of foo.js\n```\n\n</dd>\n</dl>\n</details>\n\n---'))
  merged(run(pr793())); merged(run(pr800())); merged(run(pr801()))
})

test('rule A refuses a review with a nitpick section, and the gate does not read the answer comment', () => {
  const FRAME = /frame/
  const answerFor = (fx) => { fx.issueComments.push({ id: 9, user: { login: 'alfhen' }, created_at: '2026-11-15T01:00:00Z', body: `<!-- pipeline-bot-answer head=${fx.head} -->\nNote, not filed: the nitpick.` }) }
  const fx0 = made()
  assert.equal(fx0.made, true)
  assert.match(botReview(fx0).body, /\*\*Actionable comments posted: 1\*\*/)
  assert.match(botReview(fx0).body, /Nitpick comments: 1<\/summary>/)
  const inline = fx0.comments.filter((c) => c.user.login === BOT && c.in_reply_to_id === null)
  assert.equal(inline.length, 1)
  assert.match(inline[0].body, /<\/picture> Minor\*\*/)
  assert.ok(fx0.comments.some((c) => c.user.login === 'alfhen' && c.in_reply_to_id === inline[0].id))
  assert.equal(answer(fx0), undefined)
  merged(run(madeClean()))
  const x = run(fx0)
  refused(x, RULE_A); assert.match(x.why, FRAME)
  const withAnswer = mut(made, answerFor)
  assert.ok(answer(withAnswer).created_at > botReview(withAnswer).submitted_at)
  const y = run(withAnswer)
  refused(y, RULE_A); assert.match(y.why, FRAME)
  const z = run(mut(pr793, (fx) => { botReview(fx).body = botReview(fx).body.replace('---', nitSection(botReview(made()).body) + '\n---') }))
  refused(z, RULE_A); assert.match(z.why, FRAME)
  for (const f of ['bot-approval.jq', 'review-request.jq', 'merge-pr.sh']) assert.doesNotMatch(readFileSync(join(root, 'scripts', f), 'utf8'), /pipeline-bot-answer/, f)
})

test('rule A refuses a review that holds an HTML comment other than the comments of the frame', () => {
  bodyOf(pr793, (b) => b.replace('**Actionable comments posted: 2**', '**Actionable comments posted: 2**\n\n<!-- Potential issue: Critical data loss at foo.js line 10 -->'))
  merged(run(pr793())); merged(run(pr800())); merged(run(pr801()))
})

test('the text inside the fence of the prompt block is not read: a failed pre-merge check there changes nothing', () => {
  const fx0 = pr793()
  const body = botReview(fx0).body
  const fence = body.slice(body.indexOf('```'), body.lastIndexOf('```'))
  assert.ok(body.indexOf('Prompt to fix all issues</summary>') < body.indexOf('```'))
  assert.match(fence, /Failed pre-merge checks:\n- Linked Issues check:/)
  assert.equal(answer(fx0), undefined)
  merged(run(fx0))
  const inFence = (f) => merged(run(mut(pr793, (fx) => { const b = botReview(fx).body; const to = f(b); assert.notEqual(to, b); botReview(fx).body = to })))
  inFence((b) => b.replace('\n\nAfter applying the fix', '\n- Title check:\nUse a shorter title.\n\nAfter applying the fix'))
  inFence((b) => b.replace('Failed pre-merge checks:', 'Failed checks:'))
  inFence((b) => b.replace('- Linked Issues check:', '3. Linked Issues check (failed):'))
})

test('rule A refuses a review with no count line, also when the rest of its text is the frame only, and with a count line of 0', () => {
  const fx0 = pr804()
  const mine = fx0.reviews.filter((r) => r.user.login === BOT && r.commit_id === fx0.head)
  assert.deepEqual(mine.map((r) => r.id), [5911879964])
  assert.doesNotMatch(mine[0].body, /Actionable comments posted/)
  assert.equal(fx0.comments.filter((c) => c.user.login === BOT).length, 0)
  assert.ok(request(fx0).created_at < botRun(fx0).started_at)
  const x = run(fx0)
  refused(x, RULE_A); assert.match(x.why, /count/)
  const on794 = (f = () => {}) => mut(pr794, (fx) => { fx.reviews.push({ ...botReview(pr804()), commit_id: fx.head }); f(fx) })
  merged(run(pr794()))
  const w = run(on794())
  refused(w, RULE_A); assert.match(w.why, /count/)
  merged(run(on794((fx) => {
    const rv = fx.reviews.find((r) => r.id === 5911879964)
    rv.body = rv.body.replace('---', '**Actionable comments posted: 1**\n\n---')
    fx.comments.push({ id: 8, user: { login: BOT }, in_reply_to_id: null, pull_request_review_id: rv.id, body: pr800().comments.find((c) => c.user.login === BOT).body, created_at: '2026-11-15T01:58:00Z' })
    fx.comments.push({ id: 9, user: { login: 'alfhen' }, in_reply_to_id: 8, pull_request_review_id: 7, body: 'Note, not filed: made reply for the test.', created_at: '2026-11-15T01:59:00Z' })
  })))
  const y = run(mut(pr793, (fx) => { botReview(fx).body = botReview(fx).body.replace('**Actionable comments posted: 2**\n\n', '') }))
  refused(y, RULE_A); assert.match(y.why, /count/)
  const z = run(mut(madeClean, (fx) => { botReview(fx).body = botReview(fx).body.replace('**Actionable comments posted: 1**', '**Actionable comments posted: 0**'); fx.comments = [] }))
  refused(z, RULE_A); assert.match(z.why, /count/)
})

test('an empty review of the bot that holds only replies is not read, and with a top-level comment it refuses', () => {
  const fx0 = pr805()
  const mine = fx0.reviews.filter((r) => r.user.login === BOT && r.commit_id === fx0.head)
  assert.deepEqual(mine.map((r) => r.id), [5912147219, 5912158174])
  assert.equal(mine[1].body, '')
  const held = fx0.comments.filter((c) => c.pull_request_review_id === 5912158174)
  assert.equal(held.length, 1)
  assert.equal(held[0].in_reply_to_id, 4579602537)
  assert.ok(held[0].created_at > fx0.comments.find((c) => c.id === 4579610201).created_at)
  assert.ok(answer(fx0))
  merged(run(fx0))
  const x = run(mut(pr805, (fx) => {
    fx.comments.push({ id: 8, user: { login: BOT }, in_reply_to_id: null, pull_request_review_id: 5912158174, body: fx.comments.find((c) => c.id === 4579602537).body, created_at: '2026-11-15T18:22:03Z' })
    fx.comments.push({ id: 9, user: { login: 'alfhen' }, in_reply_to_id: 8, pull_request_review_id: 7, body: 'Note, not filed: made reply for the test.', created_at: '2026-11-15T18:23:00Z' })
  }))
  refused(x, RULE_A); assert.match(x.why, /5912158174/); assert.match(x.why, /empty/)
})

test('rule A cuts no picture element outside the summary of a frame block', () => {
  bodyOf(pr800, (b) => b.replace('---', '<picture>\n### Potential issues\n- Line 10: **Critical** data loss\n</picture>\n\n---'))
  const x = run(mut(pr794, (fx) => {
    fx.reviews.push({ id: 99, user: { login: BOT }, state: 'COMMENTED', commit_id: fx.head, submitted_at: '2026-11-15T23:00:00Z', body: '<picture>Outside diff range comments (1): foo.js line 10 is Critical: data loss</picture>' })
  }))
  refused(x, RULE_A)
  for (const b of [pr793, pr800, pr801, pr805]) merged(run(b()))
})

test('a review whose raw body holds only frame comments is not an empty container and has no count line', () => {
  const x = run(mut(pr794, (fx) => {
    fx.reviews.push({ id: 99, user: { login: BOT }, state: 'COMMENTED', commit_id: fx.head, submitted_at: '2026-11-15T23:00:00Z', body: '<!-- coderabbit-ai-generated:v1 -->\n\n<!-- This is an auto-generated comment by CodeRabbit for review status -->' })
  }))
  refused(x, RULE_A); assert.match(x.why, /count/)
  merged(run(pr805()))
})

test('(doc) SKILL.md says that rule A covers inline findings only and refuses a review text that holds more than the frame', () => {
  const skill = readFileSync(join(root, 'skills/pr-pipeline/SKILL.md'), 'utf8')
  const gate = skill.split('\n').find((l) => l.includes('bot-approval.jq') && /fourth|four ways/.test(l) && l.includes('rule A'))
  assert.ok(gate, 'the gate paragraph of Step 3 names rule A')
  assert.match(gate, /inline/); assert.match(gate, /frame/); assert.match(gate, /[Nn]itpick/); assert.match(gate, /refuses/)
  assert.doesNotMatch(gate, /findings in a review body have/)
  assert.doesNotMatch(gate, /pipeline-bot-answer/)
  assert.doesNotMatch(gate, /—/)
})
