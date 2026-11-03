// Runs routine/bin/gh (the read-only wrapper), routine/run.sh and routine/install.sh in temporary guard folders.
// The wrapper's real gh is test/fake-gh; run.sh gets a stub claude and a stub routine-state.sh that log their arguments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync, chmodSync, symlinkSync, cpSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const fname = path => path.replaceAll('/', '__')
const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
const writable = path => (statSync(path).mode & 0o222) !== 0

// A guard folder <dir>/routine/o-r with plugin/ built from the repo's routine/ folder, and a clone with a local origin.
function setup({ mode = 'observe', repoFile = 'o/r', next = '{"step":"triage","issues":[7]}', nextRc = 0 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'routine-guard-test-')))
  const guard = join(dir, 'routine/o-r')
  const plugin = join(guard, 'plugin')
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx'); const work = join(dir, 'work/o-r')
  for (const d of [bin, fx, join(plugin, 'scripts'), join(plugin, '.claude-plugin'), join(guard, 'logs'), work]) mkdirSync(d, { recursive: true })
  cpSync(join(root, 'routine'), join(plugin, 'routine'), { recursive: true })
  for (const f of ['observe', 'triage']) {
    const p = join(plugin, 'routine/settings', `${f}.json`)
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll('OWNER/REPO', 'o/r'))
  }
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'x', version: '9.9.9' }))
  if (repoFile !== null) writeFileSync(join(guard, 'repo'), `${repoFile}\n`)
  if (mode !== null) writeFileSync(join(guard, 'mode'), `${mode}\n`)

  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const state = join(plugin, 'scripts/routine-state.sh')
  writeFileSync(state, `#!/bin/bash\necho "$*" >> "${dir}/state.log"\ncat "${dir}/next.out"\nexit $(cat "${dir}/next.rc")\n`)
  chmodSync(state, 0o755)
  writeFileSync(join(dir, 'next.out'), next); writeFileSync(join(dir, 'next.rc'), String(nextRc))
  const claude = join(bin, 'claude')
  writeFileSync(claude, `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/claude.args"\necho "$PATH" > "${dir}/claude.path"\nprintf '%s' "$2" > "${dir}/claude.prompt"\necho started >> "${dir}/claude.log"\necho session-output\nexit $(cat "${dir}/claude.rc" 2>/dev/null || echo 0)\n`)
  chmodSync(claude, 0o755)

  const origin = join(dir, 'origin.git'); const seed = join(dir, 'seed')
  const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r }
  git(dir, 'init', '--bare', '-b', 'main', origin)
  git(dir, 'init', '-b', 'main', seed)
  writeFileSync(join(seed, 'a.txt'), 'a')
  git(seed, 'add', '.')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'one')
  git(seed, 'push', origin, 'main')
  git(dir, 'clone', origin, join(work, 'clone'))
  return { dir, guard, plugin, bin, fx, work, run: join(plugin, 'routine/run.sh'), wrapper: join(plugin, 'routine/bin/gh'), claudeLog: join(dir, 'claude.log'), ghLog: join(dir, 'gh.log') }
}

const env = (s, extra = {}) => {
  const e = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.ghLog, ...extra }
  delete e.CLAUDECODE
  return e
}
const runIt = (s, extra) => spawnSync('bash', [s.run], { env: env(s, extra), encoding: 'utf8' })
const gh = (s, args, extra) => {
  const before = lines(s.ghLog).length
  const r = spawnSync('bash', [s.wrapper, ...args], { env: env(s, extra), encoding: 'utf8' })
  return { code: r.status, err: r.stderr, out: r.stdout, calls: lines(s.ghLog).slice(before) }
}
const newestLog = s => {
  const dir = join(s.guard, 'logs')
  const names = readdirSync(dir).filter(n => n.endsWith('.log')).sort()
  return lines(join(dir, names.at(-1)))
}
const started = s => lines(s.claudeLog).length

const fixture = (s, path, v = {}) => writeFileSync(join(s.fx, `${fname(path)}.json`), JSON.stringify(v))

// ---- the gh wrapper ----

test('the scripts are executable, because the settings allow them by path', () => {
  for (const f of ['routine/bin/gh', 'routine/run.sh', 'routine/install.sh']) {
    assert.ok((statSync(join(root, f)).mode & 0o111) === 0o111, f)
  }
})

const allowed = [
  ['api', 'repos/o/r'],
  ['api', 'user'],
  ['api', 'repos/o/r/issues?state=open&per_page=100', '--paginate', '--slurp'],
  ['api', 'repos/o/r/issues/1', '--jq', '.title'],
  ['api', 'repos/o/r/issues/1', '-q', '.title'],
  ['api', '-H', 'Accept: application/vnd.github.raw+json', 'repos/o/r/contents/a.json?ref=main'],
  ['api', '--header', 'Accept: application/vnd.github+json', 'repos/o/r/pulls/3'],
]
const paths = a => a.filter(t => /^(repos\/|user$)/.test(t))

test('the wrapper passes reads of the routine repo and of user, and logs the call', () => {
  const s = setup()
  for (const a of allowed) for (const p of paths(a)) fixture(s, p.split('?')[0])
  for (const a of allowed) {
    const r = gh(s, a)
    assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`)
    assert.equal(r.calls.length, 1, a.join(' '))
    assert.match(r.calls[0], /^GET \//)
  }
})

const refused = [
  ['write flag -f', ['api', 'repos/o/r/issues', '-f', 'a=b']],
  ['write flag -F', ['api', 'repos/o/r/issues', '-F', 'a=b']],
  ['-X POST', ['api', 'repos/o/r/issues', '-X', 'POST']],
  ['-XPOST', ['api', 'repos/o/r/issues', '-XPOST']],
  ['--method PATCH', ['api', 'repos/o/r/issues/1', '--method', 'PATCH']],
  ['--method=POST', ['api', 'repos/o/r/issues', '--method=POST']],
  ['--input f', ['api', 'repos/o/r/issues', '--input', 'f']],
  ['--input=f', ['api', 'repos/o/r/issues', '--input=f']],
  ['-fa=b', ['api', 'repos/o/r/issues', '-fa=b']],
  ['--field', ['api', 'repos/o/r/issues', '--field', 'a=b']],
  ['--raw-field', ['api', 'repos/o/r/issues', '--raw-field', 'a=b']],
  ['--hostname', ['api', 'repos/o/r', '--hostname', 'example.com']],
  ['--jq=expr', ['api', 'repos/o/r', '--jq=.title']],
  ['method override header', ['api', 'repos/o/r/issues', '-H', 'X-HTTP-Method-Override: POST']],
  ['another repo', ['api', 'repos/o/other/issues']],
  ['a repo whose name starts like the routine repo', ['api', 'repos/o/rr/issues']],
  ['another owner', ['api', 'repos/x/r/issues']],
  ['path with ..', ['api', 'repos/o/r/../other/issues']],
  ['encoded dots', ['api', 'repos/o/r/%2e%2e/other']],
  ['graphql', ['api', 'graphql']],
  ['leading slash', ['api', '/repos/o/r']],
  ['two paths', ['api', 'repos/o/r', 'repos/o/r/issues']],
  ['no path', ['api', '--paginate']],
  ['gh pr create', ['pr', 'create', '--title', 'x']],
  ['gh pr merge', ['pr', 'merge', '3']],
  ['gh api with no api word', ['repos/o/r']],
]

test('the wrapper refuses writes, other repos, other paths and other commands with exit 77 and no call', () => {
  const s = setup()
  for (const [, a] of refused) for (const p of paths(a)) fixture(s, p.split('?')[0])
  for (const [name, a] of refused) {
    const r = gh(s, a)
    assert.equal(r.code, 77, `${name}: exit ${r.code} ${r.err}`)
    assert.equal(r.calls.length, 0, `${name} reached gh`)
    assert.equal(r.err.trim().split('\n').length, 1, name)
    assert.match(r.err, /refused: gh /)
  }
})

test('the wrapper refuses jq expressions that read the environment, and keeps ordinary ones', () => {
  const s = setup()
  fixture(s, 'repos/o/r/issues')
  for (const q of ['$ENV', 'env.GH_TOKEN', 'env', '[.[]|{t:$ENV.HOME}]', 'input', '$__prog_args']) {
    for (const flag of ['--jq', '-q']) {
      const r = gh(s, ['api', 'repos/o/r/issues', flag, q])
      assert.equal(r.code, 77, `${flag} ${q}`)
      assert.equal(r.calls.length, 0, `${flag} ${q} reached gh`)
    }
  }
  const ok = gh(s, ['api', 'repos/o/r/issues', '--jq', '[.[] | {number, environment: .title}] | length'])
  assert.equal(ok.code, 0, ok.err)
})

test('the refused api calls are ones the real gh stand-in would have answered', () => {
  const s = setup()
  const direct = []
  for (const [name, a] of refused) {
    if (a[0] !== 'api' || !a[1]?.startsWith('repos/o/') || name.includes('..') || name.includes('encoded')) continue
    fixture(s, a[1].split('?')[0])
    const r = spawnSync('bash', [join(root, 'test/fake-gh'), ...a], { env: env(s), encoding: 'utf8' })
    assert.equal(r.status, 0, `${name}: the call is not valid on its own (${r.stderr})`)
    direct.push(name)
  }
  assert.ok(direct.length >= 10)
})

test('a missing repo file refuses every call', () => {
  const s = setup({ repoFile: null })
  fixture(s, 'repos/o/r')
  const r = gh(s, ['api', 'repos/o/r'])
  assert.equal(r.code, 77)
  assert.equal(r.calls.length, 0)
})

test('the mode file and the environment change nothing', () => {
  for (const mode of ['observe', 'triage', 'full']) {
    const s = setup({ mode })
    fixture(s, 'repos/o/r'); fixture(s, 'repos/o/other'); fixture(s, 'repos/o/r/issues')
    const extra = { GH_REPO: 'o/other', ROUTINE_REPO: 'o/other', PIPELINE_MODE: 'triage', MODE: 'full' }
    assert.equal(gh(s, ['api', 'repos/o/r'], extra).code, 0, mode)
    assert.equal(gh(s, ['api', 'repos/o/other'], extra).code, 77, mode)
    assert.equal(gh(s, ['api', 'repos/o/r/issues', '-X', 'POST'], extra).code, 77, mode)
  }
})

test('the wrapper reads the repo from the file, not from the repo in the call', () => {
  const s = setup({ repoFile: 'o/other' })
  fixture(s, 'repos/o/r'); fixture(s, 'repos/o/other')
  assert.equal(gh(s, ['api', 'repos/o/r']).code, 77)
  assert.equal(gh(s, ['api', 'repos/o/other']).code, 0)
})

// ---- the runner ----

test('a triage run starts claude with the guard arguments and logs the plugin version first', () => {
  const s = setup({ mode: 'triage' })
  const r = runIt(s)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(started(s), 1)
  const args = readFileSync(join(s.dir, 'claude.args'), 'utf8').split('\n').slice(0, -1)
  const at = flag => args[args.indexOf(flag) + 1]
  assert.equal(at('--permission-mode'), 'dontAsk')
  assert.equal(at('--settings'), join(s.plugin, 'routine/settings/triage.json'))
  assert.equal(at('--plugin-dir'), s.plugin)
  assert.ok(args.includes('--strict-mcp-config'))
  assert.ok(args.includes('--setting-sources'))
  assert.equal(args[args.indexOf('--setting-sources') + 1], '', 'no setting source loads')
  assert.ok(lines(join(s.dir, 'claude.path'))[0].startsWith(`${s.plugin}/routine/bin:`))
  assert.match(newestLog(s)[0], /agent-pr-pipeline 9\.9\.9 repo o\/r/)
  assert.ok(lines(join(s.dir, 'state.log')).includes('o/r next'))
  assert.ok(!existsSync(join(s.guard, 'lock')), 'the lock is removed on exit')
})

test('observe, a missing mode file and the word full all use the observe settings and say so', () => {
  for (const mode of ['observe', null, 'full', 'garbage']) {
    const s = setup({ mode })
    assert.equal(runIt(s).status, 0)
    const args = lines(join(s.dir, 'claude.args'))
    assert.equal(args[args.indexOf('--settings') + 1], join(s.plugin, 'routine/settings/observe.json'), String(mode))
    const log = newestLog(s).join('\n')
    if (mode === 'observe') assert.doesNotMatch(log, /acting as observe/)
    else assert.match(log, /acting as observe/, String(mode))
  }
})

test('a live lock ends the run without claude and stays', () => {
  const s = setup({ mode: 'triage' })
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' })
  try {
    mkdirSync(join(s.guard, 'lock')); writeFileSync(join(s.guard, 'lock/pid'), String(sleeper.pid))
    const r = runIt(s)
    assert.equal(r.status, 0)
    assert.equal(started(s), 0)
    assert.ok(existsSync(join(s.guard, 'lock')))
    assert.match(newestLog(s).join('\n'), /another run is live/)
  } finally { sleeper.kill() }
})

test('a stale lock is taken over', () => {
  const s = setup({ mode: 'triage' })
  const gone = spawnSync('true').pid
  assert.throws(() => process.kill(gone, 0), 'the pid is really gone')
  mkdirSync(join(s.guard, 'lock')); writeFileSync(join(s.guard, 'lock/pid'), String(gone))
  assert.equal(runIt(s).status, 0)
  assert.equal(started(s), 1)
  assert.match(newestLog(s).join('\n'), /stale lock/)
  assert.ok(!existsSync(join(s.guard, 'lock')))
})

test('idle and init needed start no claude, and the run is clean', () => {
  for (const next of ['{"step":"idle"}', '{"step":"init needed"}']) {
    const s = setup({ mode: 'triage', next })
    assert.equal(runIt(s).status, 0)
    assert.equal(started(s), 0, next)
    assert.ok(lines(join(s.dir, 'state.log')).includes('o/r next'), 'next did run')
    assert.match(newestLog(s).join('\n'), /no session/)
  }
})

test('a next that exits non-zero ends the run without claude', () => {
  const s = setup({ mode: 'triage', next: '', nextRc: 1 })
  const r = runIt(s)
  assert.equal(r.status, 1)
  assert.equal(started(s), 0)
  assert.match(newestLog(s).join('\n'), /next failed with exit 1/)
  assert.ok(!existsSync(join(s.guard, 'lock')))
})

test('in observe a second run with the same next output starts no claude, and a changed output starts it', () => {
  const s = setup({ mode: 'observe' })
  runIt(s); assert.equal(started(s), 1)
  runIt(s); assert.equal(started(s), 1, 'same output')
  assert.match(newestLog(s).join('\n'), /same work as the last run/)
  writeFileSync(join(s.dir, 'next.out'), '{"step":"triage","issues":[7,8]}')
  runIt(s); assert.equal(started(s), 2, 'changed output')
})

test('in observe a failed session is tried again on the next run', () => {
  const s = setup({ mode: 'observe' })
  writeFileSync(join(s.dir, 'claude.rc'), '1')
  assert.equal(runIt(s).status, 1); assert.equal(started(s), 1)
  writeFileSync(join(s.dir, 'claude.rc'), '0')
  assert.equal(runIt(s).status, 0); assert.equal(started(s), 2, 'retried')
  runIt(s); assert.equal(started(s), 2, 'recorded after success')
})

test('in triage the same next output starts claude each time', () => {
  const s = setup({ mode: 'triage' })
  runIt(s); runIt(s)
  assert.equal(started(s), 2)
})

test('a run makes the plugin, the mode and earlier logs read-only', () => {
  const s = setup({ mode: 'observe' })
  runIt(s)
  const first = readdirSync(join(s.guard, 'logs')).filter(n => n.endsWith('.log'))[0]
  runIt(s)
  assert.ok(!writable(join(s.plugin, 'scripts/routine-state.sh')))
  assert.ok(!writable(join(s.plugin, 'routine/run.sh')))
  assert.ok(!writable(join(s.guard, 'mode')))
  assert.ok(!writable(join(s.guard, 'logs', first)))
})

test('the runner resets the clone to the default branch', () => {
  const s = setup({ mode: 'observe' })
  const clone = join(s.work, 'clone')
  writeFileSync(join(clone, 'a.txt'), 'changed'); writeFileSync(join(clone, 'junk.txt'), 'x')
  runIt(s)
  assert.equal(readFileSync(join(clone, 'a.txt'), 'utf8'), 'a')
  assert.ok(!existsSync(join(clone, 'junk.txt')))
})

// ---- the settings files ----

const G = '/g'
const STATE = `${G}/plugin/scripts/routine-state.sh`
const WRAP = `${G}/plugin/routine/bin/gh`
const settings = name => JSON.parse(readFileSync(join(root, 'routine/settings', `${name}.json`), 'utf8'))
const rules = (name, kind) => settings(name).permissions[kind].map(r => r.replaceAll('OWNER/REPO', 'o/r').replaceAll('GUARD', G))
const bashRules = (name, kind) => rules(name, kind).filter(r => r.startsWith('Bash(')).map(r => r.slice(5, -1))
const matches = (rule, cmd) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(cmd)
const allowedBash = (name, cmd) => bashRules(name, 'allow').some(r => matches(r, cmd))

test('each settings file is valid JSON with an allow list and a deny list, and neither mode can write or build', () => {
  for (const name of ['observe', 'triage']) {
    const allow = rules(name, 'allow'); const deny = rules(name, 'deny')
    assert.ok(allow.length > 0 && deny.length > 0)
    for (const bad of ['Workflow', 'Edit', 'Write', 'NotebookEdit']) {
      assert.ok(!allow.includes(bad), `${name} allows ${bad}`)
      assert.ok(deny.includes(bad), `${name} does not deny ${bad}`)
    }
    assert.ok(deny.includes('Bash(git *)'))
    assert.ok(!allow.some(r => /^(Read|Glob|Grep)(\(|$)/.test(r)), `${name} has a read rule that reaches outside the clone`)
    assert.ok(!allow.some(r => /^Bash\((git|gh|routine-state\.sh)[ )]/.test(r)), 'Bash rules name files by absolute path')
    assert.ok(allow.filter(r => r.startsWith('Bash(')).every(r => r.startsWith(`Bash(${G}/plugin/`)))
    assert.ok(!allow.some(r => r === 'Bash' || r === 'Agent'), 'no blanket Bash or Agent')
    assert.ok(allow.includes('Agent(triager)'))
    const plugin = readdirSync(join(root, 'agents')).map(f => f.replace(/\.md$/, '')).filter(n => n !== 'triager')
    for (const n of [...plugin, 'Explore', 'Plan', 'general-purpose', 'statusline-setup', 'claude-code-guide', 'output-style-setup', 'claude', 'web-fetch']) {
      assert.ok(deny.includes(`Agent(${n})`), `${name} does not deny Agent(${n})`)
    }
    for (const n of plugin) assert.ok(deny.includes(`Agent(agent-pr-pipeline:${n})`), `${name} does not deny Agent(agent-pr-pipeline:${n})`)
    assert.ok(!deny.includes('Agent(triager)') && !deny.includes('Agent(agent-pr-pipeline:triager)'))
    assert.ok(!settings(name).permissions.defaultMode, 'the runner sets the mode')
  }
})

test('observe allows no put, and triage allows only put triaged', () => {
  assert.ok(!bashRules('observe', 'allow').some(r => r.includes(' put')))
  const puts = bashRules('triage', 'allow').filter(r => r.includes(' put'))
  assert.deepEqual(puts, [`${STATE} o/r put triaged *`])
  const scripts = bashRules('triage', 'allow').filter(r => r.includes('routine-state.sh'))
  assert.deepEqual(scripts.sort(), [`${STATE} o/r next`, `${STATE} o/r put triaged *`])
})

test('the command lines in the prompt match the allow rules and the bad ones match none', () => {
  const next = `${STATE} o/r next`
  const put = `${STATE} o/r put triaged 12 decline S low "why"`
  assert.ok(allowedBash('observe', next)); assert.ok(allowedBash('triage', next))
  assert.ok(allowedBash('triage', put))
  assert.ok(!allowedBash('observe', put))
  for (const mode of ['observe', 'triage']) {
    assert.ok(!allowedBash(mode, `${STATE} o/r put wave-started 1`), mode)
    assert.ok(!allowedBash(mode, `${STATE} next`), `${mode}: no repo in front`)
    assert.ok(!allowedBash(mode, `${STATE} o/other next`), `${mode}: another repo`)
    assert.ok(!allowedBash(mode, `${STATE} o/r init`), mode)
    assert.ok(!allowedBash(mode, 'git push origin main'), mode)
    assert.ok(!allowedBash(mode, 'gh pr merge 3'), mode)
    assert.ok(!allowedBash(mode, 'gh api repos/o/r/issues'), `${mode}: a bare gh is not allowed`)
    assert.ok(!allowedBash(mode, 'routine-state.sh o/r next'), `${mode}: a bare routine-state.sh is not allowed`)
    assert.ok(!allowedBash(mode, '/opt/homebrew/bin/gh api repos/o/r/issues'), `${mode}: the real gh is not allowed`)
  }
  assert.ok(!allowedBash('observe', `${STATE} o/r put triaged 12 decline S low next`))
  assert.ok(allowedBash('observe', `${WRAP} api repos/o/r/issues`))
})

test('the matcher itself tells a match from a miss', () => {
  assert.ok(matches('a b *', 'a b c d'))
  assert.ok(!matches('a b *', 'a bc'))
  assert.ok(!matches('a b', 'a b c'))
  assert.ok(matches('a.b (x)', 'a.b (x)'))
})

// ---- the prompt ----

const promptOf = s => readFileSync(join(s.dir, 'claude.prompt'), 'utf8')
const settingsOf = (s, mode) => JSON.parse(readFileSync(join(s.plugin, 'routine/settings', `${mode}.json`), 'utf8').replaceAll('GUARD', s.guard))
const bashAllow = (s, mode) => settingsOf(s, mode).permissions.allow.filter(r => r.startsWith('Bash(')).map(r => r.slice(5, -1))
const commandLines = p => p.split('\n').filter(l => /^ {4,}\S/.test(l)).map(l => l.trim()).filter(l => l.startsWith('/'))
const fillPlaceholders = (c, s) => c.replace(/<[^>]+>/g, '1').replace(/"1"/, '"why"')

test('run.sh passes the prompt with the guard path, the repo, the clone and the mode filled in', () => {
  const s = setup({ mode: 'triage' })
  runIt(s)
  const p = promptOf(s)
  assert.ok(p.includes(`${s.guard}/plugin/scripts/routine-state.sh o/r next`))
  assert.ok(p.includes(join(s.work, 'clone')))
  assert.match(p, /The mode is triage/)
  assert.doesNotMatch(p, /\{\{|\[\[/)
  assert.match(p, /untrusted/)
})

for (const mode of ['observe', 'triage']) {
  test(`${mode} prompt names routine-state.sh and the wrapper only by guard path, and every command line is allowed`, () => {
    const s = setup({ mode })
    runIt(s)
    const p = promptOf(s)
    for (const m of p.matchAll(/(\S*)routine-state\.sh/g)) assert.equal(m[1], `${s.guard}/plugin/scripts/`, 'routine-state.sh by absolute guard path')
    for (const m of p.matchAll(/(\S*)\bgh\b/g)) assert.equal(m[1], `${s.guard}/plugin/routine/bin/`, 'the wrapper by absolute guard path')
    assert.doesNotMatch(p, /(^|[^/\w-])gh /m, 'no bare gh command')
    const cmds = commandLines(p)
    assert.ok(cmds.length >= 2)
    for (const c of cmds) {
      const cmd = fillPlaceholders(c)
      assert.ok(bashAllow(s, mode).some(r => matches(r, cmd)), `${mode}: ${cmd} matches no allow rule`)
    }
    assert.doesNotMatch(p, /routine-state\.sh \S+ (init|put (?!triaged))/)
    assert.doesNotMatch(p, /\bgit (push|commit|clone)/)
  })
}

test('only the triage prompt holds a put command, and observe tells the session to write the record as text', () => {
  const o = setup({ mode: 'observe' }); runIt(o)
  const t = setup({ mode: 'triage' }); runIt(t)
  assert.doesNotMatch(promptOf(o), /put triaged/)
  assert.match(promptOf(o), /RECORD issue/)
  assert.equal(commandLines(promptOf(t)).filter(c => c.includes(' put triaged ')).length, 1)
  assert.doesNotMatch(promptOf(t), /RECORD issue/)
})

test('the prompt template has a put block and an observe block, so the checks above can fail', () => {
  const raw = readFileSync(join(root, 'routine/prompt.md'), 'utf8')
  assert.match(raw, /^\[\[triage\]\]$[\s\S]*put triaged[\s\S]*^\[\[\/triage\]\]$/m)
  assert.match(raw, /^\[\[observe\]\]$[\s\S]*RECORD issue[\s\S]*^\[\[\/observe\]\]$/m)
})

test('the triager agent is told to use a ready clone and a gh path', () => {
  assert.match(readFileSync(join(root, 'agents/triager.md'), 'utf8'), /ready clone and a `gh` path, read that clone, make no clone/)
})

// ---- the installer ----

// A copy of the plugin whose routine-state.sh is a stub that records how it was called.
function installSetup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'routine-install-test-')))
  const src = join(dir, 'src'); const home = join(dir, 'home'); const cbin = join(dir, 'claude-bin')
  mkdirSync(src); mkdirSync(cbin)
  for (const d of ['.claude-plugin', 'agents', 'skills', 'scripts', 'routine', 'templates', 'workflows']) cpSync(join(root, d), join(src, d), { recursive: true })
  const log = join(dir, 'state.log')
  writeFileSync(join(src, 'scripts/routine-state.sh'), `#!/bin/bash\necho "$0 $*" >> "${log}"\nif [ -e "${home}/routine/o-r/repo" ]; then echo "repo file existed" >> "${log}"; fi\nexit $(cat "${dir}/init.rc" 2>/dev/null || echo 0)\n`)
  chmodSync(join(src, 'scripts/routine-state.sh'), 0o755)
  writeFileSync(join(cbin, 'claude'), '#!/bin/sh\n'); chmodSync(join(cbin, 'claude'), 0o755)
  const run = (...args) => spawnSync('bash', [join(src, 'routine/install.sh'), ...args], { env: { ...process.env, PATH: `${cbin}:${process.env.PATH}`, AGENT_PR_PIPELINE_HOME: home, HOME: dir }, encoding: 'utf8' })
  return { dir, src, home, cbin, log, run, guard: join(home, 'routine/o-r'), plist: join(dir, 'Library/LaunchAgents/com.agent-pr-pipeline.routine.o-r.plist') }
}

test('install.sh builds the guard folder with the literal repo and keeps the mode', () => {
  const i = installSetup()
  let r = i.run('o/r')
  assert.equal(r.status, 0, r.stderr)
  const { guard } = i
  assert.equal(readFileSync(join(guard, 'repo'), 'utf8').trim(), 'o/r')
  assert.equal(readFileSync(join(guard, 'mode'), 'utf8').trim(), 'observe')
  const triage = readFileSync(join(guard, 'plugin/routine/settings/triage.json'), 'utf8')
  assert.ok(triage.includes(`${guard}/plugin/scripts/routine-state.sh o/r put triaged *`))
  assert.ok(!triage.includes('GUARD'))
  assert.ok(!triage.includes('OWNER/REPO'))
  assert.ok(existsSync(join(guard, 'plugin/routine/prompt.md')))
  const plist = readFileSync(i.plist, 'utf8')
  assert.ok(plist.includes(`${guard}/plugin/routine/run.sh`))
  assert.ok(plist.includes('com.agent-pr-pipeline.routine.o-r'))
  assert.ok(plist.includes(`<string>${i.cbin}:`), 'the plist PATH starts with the folder of the claude found at install')
  assert.ok(!plist.includes('CLAUDE_DIR'))
  assert.ok(!writable(join(guard, 'plugin/routine/run.sh')))
  assert.match(r.stdout, /launchctl bootstrap/)
  assert.match(r.stdout, /launchctl bootout/)

  chmodSync(join(guard, 'mode'), 0o644); writeFileSync(join(guard, 'mode'), 'triage\n')
  r = i.run('o/r')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(guard, 'mode'), 'utf8').trim(), 'triage', 'a second install keeps the mode')

  r = spawnSync('bash', [join(i.src, 'routine/install.sh'), 'not a repo'], { env: { ...process.env, AGENT_PR_PIPELINE_HOME: i.home }, encoding: 'utf8' })
  assert.equal(r.status, 64)
})

test('install.sh runs init with the source plugin script, never the guard copy, and before the repo file exists', () => {
  const i = installSetup()
  assert.equal(i.run('o/r').status, 0)
  const calls = lines(i.log)
  assert.deepEqual(calls, [`${i.src}/scripts/routine-state.sh o/r init`])
  assert.ok(!calls.some(c => c.includes(i.guard)), 'the guard copy is not used')
  assert.ok(existsSync(join(i.guard, 'repo')))
})

test('a home reached through a symlink gives a prompt whose command lines match the installed allow rules', () => {
  const i = installSetup()
  const real = join(i.dir, 'real'); const link = join(i.dir, 'link')
  mkdirSync(real); symlinkSync(real, link)
  const home = join(link, 'home')
  writeFileSync(join(i.src, 'scripts/routine-state.sh'), '#!/bin/bash\n[ "$2" = next ] && echo \'{"step":"triage","issues":[7]}\'\nexit 0\n')
  chmodSync(join(i.src, 'scripts/routine-state.sh'), 0o755)
  writeFileSync(join(i.cbin, 'claude'), `#!/bin/bash\nprintf '%s' "$2" > "${i.dir}/claude.prompt"\n`)
  const guard = join(realpathSync(real), 'home/routine/o-r')
  const env = { ...process.env, PATH: `${i.cbin}:${process.env.PATH}`, AGENT_PR_PIPELINE_HOME: home, HOME: i.dir }
  delete env.CLAUDECODE
  let r = spawnSync('bash', [join(i.src, 'routine/install.sh'), 'o/r'], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stdout.includes(guard), 'the printed paths are resolved')
  const git = (cwd, ...a) => { const g = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(g.status, 0, g.stderr) }
  const origin = join(i.dir, 'origin.git'); const seed = join(i.dir, 'seed')
  git(i.dir, 'init', '--bare', '-b', 'main', origin); git(i.dir, 'init', '-b', 'main', seed)
  writeFileSync(join(seed, 'a.txt'), 'a'); git(seed, 'add', '.')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'one'); git(seed, 'push', origin, 'main')
  git(i.dir, 'clone', origin, join(real, 'home/work/o-r/clone'))
  r = spawnSync('bash', [join(home, 'routine/o-r/plugin/routine/run.sh')], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const cmds = commandLines(readFileSync(join(i.dir, 'claude.prompt'), 'utf8'))
  assert.ok(cmds.length >= 2)
  for (const mode of ['observe', 'triage']) {
    const rules = JSON.parse(readFileSync(join(guard, 'plugin/routine/settings', `${mode}.json`), 'utf8')).permissions.allow.filter(x => x.startsWith('Bash(')).map(x => x.slice(5, -1))
    for (const c of cmds.filter(c => mode === 'triage' || !/ put /.test(c))) assert.ok(rules.some(x => matches(x, fillPlaceholders(c))), `${mode}: ${c} matches no installed allow rule`)
  }
})

test('a failed init stops the install and writes nothing', () => {
  const i = installSetup()
  writeFileSync(join(i.dir, 'init.rc'), '1')
  const r = i.run('o/r')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /init failed/)
  assert.ok(!existsSync(i.guard))
  assert.ok(!existsSync(i.plist))
})

test('install.sh --print writes nothing, calls nothing, and names the plist and minute 7', () => {
  const i = installSetup()
  const r = i.run('--print', 'o/r')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(join(i.dir, 'Library')))
  assert.ok(!existsSync(i.home))
  assert.ok(!existsSync(i.log), 'init was not run')
  assert.ok(r.stdout.includes(i.plist))
  assert.match(r.stdout, /Library\/LaunchAgents\/.*\.plist/)
  assert.match(r.stdout, /minute 7/)
  const plist = readFileSync(join(root, 'routine/launchd.plist'), 'utf8')
  assert.match(plist, /<key>Minute<\/key>\s*<integer>7<\/integer>/)
})

test('install.sh refuses when claude is not on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routine-install-test-'))
  const tools = join(dir, 'tools'); mkdirSync(tools)
  for (const t of ['dirname', 'cp', 'mkdir', 'rm', 'chmod', 'sed', 'tr', 'jq', 'cat']) {
    const w = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()
    if (w) symlinkSync(w, join(tools, t))
  }
  const r = spawnSync('/bin/bash', [join(root, 'routine/install.sh'), 'o/r'], { env: { PATH: tools, AGENT_PR_PIPELINE_HOME: join(dir, 'home'), HOME: dir }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /claude is not on PATH/)
  assert.ok(!existsSync(join(dir, 'home/routine/o-r/plugin')))
})
