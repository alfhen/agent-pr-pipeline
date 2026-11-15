// Runs scripts/role-files.sh on temp plugin folders, and reads the texts that describe the role check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = join(root, 'scripts/role-files.sh')
const text = file => readFileSync(join(root, file), 'utf8')

const preflight = (release, tail = 'tail') => `head\nRole files of release ${release}.\n${tail}\n`
const setup = () => {
  const t = mkdtempSync(join(tmpdir(), 'role-files-test-'))
  for (const [d, release] of [['a', '0.9.6'], ['b', '0.9.7']]) {
    mkdirSync(join(t, d, 'agents'), { recursive: true })
    for (const n of ['alpha.md', 'beta.md']) writeFileSync(join(t, d, 'agents', n), `same ${n}\n`)
    writeFileSync(join(t, d, 'agents/goals-preflight.md'), preflight(release))
  }
  symlinkSync(join(t, 'a'), join(t, 'link'))
  return t
}
const run = (a, b) => {
  const r = spawnSync('bash', [script, a, b], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim() }
}

test('the same files, with other release lines, give ROLES SAME', () => {
  const t = setup()
  assert.deepEqual(run(join(t, 'a'), join(t, 'b')), { code: 0, out: 'ROLES SAME' })
})

test('one changed byte names the file and only that file', () => {
  const t = setup()
  writeFileSync(join(t, 'b/agents/alpha.md'), 'same alpha.md!\n')
  const r = run(join(t, 'a'), join(t, 'b'))
  assert.equal(r.code, 0)
  assert.match(r.out, /^ROLES DIFFER /)
  assert.match(r.out, /alpha/)
  assert.doesNotMatch(r.out, /beta/)
})

test('a changed line in goals-preflight.md, or a release line that is no version, is a difference', () => {
  for (const edit of [(t) => writeFileSync(join(t, 'b/agents/goals-preflight.md'), preflight('0.9.7', 'tail2')),
    (t) => writeFileSync(join(t, 'b/agents/goals-preflight.md'), preflight('banana')),
    (t) => writeFileSync(join(t, 'b/agents/goals-preflight.md'), `head\nRole files of release 0.9.7.\ntail`)]) {
    const t = setup()
    edit(t)
    assert.match(run(join(t, 'a'), join(t, 'b')).out, /^ROLES DIFFER .*goals-preflight/)
  }
})

test('a release line in another file is a difference', () => {
  const t = setup()
  writeFileSync(join(t, 'a/agents/alpha.md'), 'same alpha.md\nRole files of release 0.9.6.\n')
  assert.match(run(join(t, 'a'), join(t, 'b')).out, /^ROLES DIFFER .*alpha/)
})

test('a file in one folder only is a difference', () => {
  for (const [side, name] of [['b', 'gamma.md'], ['a', 'delta.md']]) {
    const t = setup()
    writeFileSync(join(t, side, 'agents', name), 'x\n')
    const r = run(join(t, 'a'), join(t, 'b'))
    assert.equal(r.code, 0)
    assert.match(r.out, new RegExp(`^ROLES DIFFER .*${name.replace('.md', '')}`))
  }
})

test('a first folder that does not exist gives ROLES MISSING with exit 0', () => {
  const t = setup()
  assert.deepEqual(run(join(t, 'none'), join(t, 'b')), { code: 0, out: `ROLES MISSING ${join(t, 'none')}` })
})

test('a second folder that cannot be read, or the same folder, gives CHECK FAILED with exit 3', () => {
  const t = setup()
  for (const [a, b] of [[join(t, 'a'), join(t, 'none')], [join(t, 'a'), join(t, 'a')], [join(t, 'a'), join(t, 'a') + '/'], [join(t, 'a'), join(t, 'link')]]) {
    const r = run(a, b)
    assert.equal(r.code, 3, b)
    assert.match(r.out, /^CHECK FAILED /)
  }
})

test('the script leaves every file and folder as it was', () => {
  const t = setup()
  const snapshot = () => execSync(`(find ${t} | sort; find ${t} -type f -exec cksum {} + | sort)`, { encoding: 'utf8' })
  const before = snapshot()
  writeFileSync(join(t, 'b/agents/alpha.md'), 'other\n')
  const changed = snapshot()
  for (const [a, b] of [['a', 'b'], ['none', 'b'], ['a', 'none'], ['a', 'a'], ['a', 'link']]) run(join(t, a), join(t, b))
  assert.equal(snapshot(), changed)
  assert.notEqual(before, changed)
})

test('the script text writes nothing and uses only commands that exist on macOS and Linux', () => {
  const code = text('scripts/role-files.sh').split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
  assert.doesNotMatch(code, /(^|[\s;&|(`])(rm|mv|cp|touch|mkdir|tee|stat|md5|md5sum|sha256sum|gh)(\s|$)/)
  assert.doesNotMatch(code, /sed -i|readlink -f/)
  assert.doesNotMatch(code.replace(/>\/dev\/null/g, ''), />/)
})

const section = (file, from, to) => {
  const s = text(file)
  const i = s.indexOf(from)
  assert.ok(i >= 0, from)
  const j = s.indexOf(to, i + from.length)
  return s.slice(i, j < 0 ? undefined : j)
}
const skill = text('skills/pr-pipeline/SKILL.md')
const paragraph = start => {
  const line = skill.split('\n').find(l => l.startsWith(start))
  assert.ok(line, start)
  return line
}

test('SKILL.md describes the role check in the result paragraph', () => {
  const p = paragraph('The result is `{ prs,')
  assert.match(p, /role-files\.sh/)
  assert.match(p, /role files differ:/)
})

test('SKILL.md says a role refusal gets no evaluation', () => {
  assert.match(paragraph('**Once per wave: evaluate.**'), /a wave refused for its role files gets no evaluation/)
})

test('SKILL.md says a role refusal needs a reload and a new run, not a resume', () => {
  const p = paragraph('- **Resume, do not restart.**')
  assert.match(p, /role refusal/)
  assert.match(p, /`\/reload-plugins` and a new run/)
  assert.match(p, /does not cure it/)
})

test('SKILL.md says a pluginRoot outside the plugin cache gives no files to compare', () => {
  const p = paragraph('`agentPrefix` changes the namespace')
  assert.match(p, /outside the plugin cache the check can compare no files/)
  assert.match(p, /`agentPrefix` `""` and copied role files/)
})

test('SKILL.md has the Files line of role-files.sh with the release line', () => {
  const line = skill.split('\n').find(l => l.startsWith('- `scripts/role-files.sh`'))
  assert.ok(line)
  assert.match(line, /The version PR writes the line `Role files of release <version>\.`/)
})

test('SKILL.md has the two rows of When things go wrong right after the version warning row', () => {
  const rows = skill.split('\n')
  const at = rows.findIndex(l => l.startsWith('| `WARN plugin ... is older than the latest release`'))
  assert.ok(at > 0)
  const refusal = rows[at + 1]
  for (const re of [/role files differ:/, /`\/reload-plugins`/, /new run/, /fault of the pipeline: the session reports it/, /copied role files/, /`agentPrefix` `""`/]) assert.match(refusal, re)
  const warns = rows[at + 2]
  assert.match(warns, /WARN role files hold no release line:/)
  assert.match(warns, /WARN role check could not run:/)
  assert.match(warns, /`\/reload-plugins` and start a new run/)
})

test('cloud-routines.md and README.md name the role check', () => {
  const pin = section('docs/cloud-routines.md', '## The pin and the setup script', '\n## ')
  assert.match(pin, /The version PR also writes the line `Role files of release <version>\.` in `agents\/goals-preflight\.md`\./)
  assert.match(pin, /The role check does not run in the cloud, because `agentPrefix` is set there\./)
  assert.match(text('README.md').split('\n').find(l => l.startsWith('- **Scripts and templates.**')), /`role-files\.sh`/)
})
