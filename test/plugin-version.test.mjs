// Runs plugin-version.sh from a temp plugin folder against test/fake-gh, with stub claude and npm that log every call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const RELEASE = 'repos__alfhen__agent-pr-pipeline__releases__latest'

// opts.latest: the tag the release call answers; null makes it a 404.
const setup = ({ pluginVersion, latest }) => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-version-test-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx'); const plugin = join(dir, 'plugin')
  for (const d of [bin, fx, join(plugin, 'scripts'), join(plugin, '.claude-plugin')]) mkdirSync(d, { recursive: true })
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const installs = join(dir, 'installs')
  for (const name of ['claude', 'npm']) {
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${installs}"\n`)
    chmodSync(join(bin, name), 0o755)
  }
  for (const f of ['plugin-version.sh', 'plugin-repo.sh', 'semver.sh']) copyFileSync(join(root, 'scripts', f), join(plugin, 'scripts', f))
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'agent-pr-pipeline', version: pluginVersion, repository: 'https://github.com/alfhen/agent-pr-pipeline' }))
  if (latest) writeFileSync(join(fx, `${RELEASE}.json`), JSON.stringify({ tag_name: latest }))
  else writeFileSync(join(fx, `${RELEASE}.GET.error`), 'gh: Not Found (HTTP 404)')
  return { dir, bin, fx, plugin, installs, log: join(dir, 'log') }
}

const run = (s, running) => {
  const env = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log }
  const r = spawnSync('bash', [join(s.plugin, 'scripts/plugin-version.sh'), running], { env, encoding: 'utf8' })
  const log = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  const lines = (r.stdout + r.stderr).split('\n').filter(Boolean)
  // Nothing installs: neither claude nor npm was called, and gh only read.
  assert.equal(existsSync(s.installs), false, 'an install command ran')
  assert.deepEqual(log.filter((l) => !l.startsWith('GET ')), [])
  return { code: r.status, lines }
}

test('both versions at the latest tag give OK', () => {
  const r = run(setup({ pluginVersion: '0.5.1', latest: 'v0.5.1' }), '0.5.1')
  assert.equal(r.code, 0)
  assert.deepEqual(r.lines, ['OK'])
})

test('an older pluginRoot gives one WARN that names pluginRoot', () => {
  const r = run(setup({ pluginVersion: '0.5.0', latest: 'v0.5.1' }), '0.5.1')
  assert.equal(r.code, 0)
  assert.equal(r.lines.length, 1)
  assert.match(r.lines[0], /^WARN plugin 0\.5\.0 \(pluginRoot\) is older than the latest release v0\.5\.1: run claude plugin update agent-pr-pipeline@agent-pr-pipeline, then \/reload-plugins$/)
})

test('an older running version gives one WARN that names running', () => {
  const r = run(setup({ pluginVersion: '0.5.1', latest: 'v0.5.1' }), '0.5.0')
  assert.equal(r.code, 0)
  assert.equal(r.lines.length, 1)
  assert.match(r.lines[0], /^WARN plugin 0\.5\.0 \(running\) is older than the latest release v0\.5\.1/)
})

test('a pre-release is older than its release', () => {
  const r = run(setup({ pluginVersion: '0.6.0-rc.1', latest: 'v0.6.0' }), '0.6.0-rc.1')
  assert.equal(r.code, 0)
  assert.equal(r.lines.length, 2)
  assert.match(r.lines[0], /^WARN plugin 0\.6\.0-rc\.1 \(running\)/)
  assert.match(r.lines[1], /^WARN plugin 0\.6\.0-rc\.1 \(pluginRoot\)/)
})

test('a version ahead of the latest release gives OK', () => {
  const r = run(setup({ pluginVersion: '0.6.0', latest: 'v0.5.0' }), '0.6.0')
  assert.deepEqual(r.lines, ['OK'])
})

test('a 404 from the release call is CHECK FAILED with exit 3', () => {
  const r = run(setup({ pluginVersion: '0.5.0', latest: null }), '0.5.0')
  assert.equal(r.code, 3)
  assert.match(r.lines[0], /^CHECK FAILED cannot read the latest release of alfhen\/agent-pr-pipeline/)
})

test('a plugin folder with no manifest is CHECK FAILED with exit 3', () => {
  const s = setup({ pluginVersion: '0.5.0', latest: 'v0.5.0' })
  writeFileSync(join(s.plugin, '.claude-plugin/plugin.json'), 'not json')
  const r = run(s, '0.5.0')
  assert.equal(r.code, 3)
  assert.match(r.lines[0], /^CHECK FAILED/)
})

test('a missing running version is a usage error', () => {
  const r = run(setup({ pluginVersion: '0.5.0', latest: 'v0.5.0' }), '')
  assert.equal(r.code, 2)
})

test('the script text never calls claude or npm', () => {
  const text = readFileSync(join(root, 'scripts/plugin-version.sh'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l) && !/echo "WARN/.test(l)).join('\n')
  assert.doesNotMatch(text, /(^|[\s;&|(`])(claude|npm)(\s|$)/)
})

test('VERSION in run-wave.js equals the version in the manifest', () => {
  const version = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version
  const m = /^const VERSION = '([^']+)'$/m.exec(readFileSync(join(root, 'workflows/run-wave.js'), 'utf8'))
  assert.ok(m, 'run-wave.js has no VERSION line')
  assert.equal(m[1], version)
})

test('semver.sh run by itself prints nothing and exits 0', () => {
  const r = spawnSync('bash', [join(root, 'scripts/io.sh'), 'semver.sh'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, 'pipeline-io: begin\npipeline-io: exit 0\n')
})

// The proxy refuses the release read; a stub curl answers the raw read of plugin.json on main.
const proxy = (pluginVersion, error, mainVersion) => {
  const s = setup({ pluginVersion, latest: null })
  writeFileSync(join(s.fx, `${RELEASE}.GET.error`), error)
  const answer = mainVersion ? `echo '${JSON.stringify({ version: mainVersion })}'` : 'exit 22'
  writeFileSync(join(s.bin, 'curl'), `#!/bin/bash\necho "$*" >> "${s.dir}/curl.log"\n${answer}\n`)
  chmodSync(join(s.bin, 'curl'), 0o755)
  return s
}
const PROXY_403 = 'gh: Resource not accessible: releases is not enabled for this session (HTTP 403)'

test('the proxy 403 reads the version on main and warns with latest version on main', () => {
  const s = proxy('0.7.0', PROXY_403, '0.8.0')
  const r = run(s, '0.7.0')
  assert.equal(r.code, 0)
  assert.equal(r.lines.length, 2)
  assert.match(r.lines[0], /^WARN plugin 0\.7\.0 \(running\) is older than the latest version on main 0\.8\.0: run /)
  assert.match(readFileSync(join(s.dir, 'curl.log'), 'utf8'), /https:\/\/raw\.githubusercontent\.com\/alfhen\/agent-pr-pipeline\/main\/\.claude-plugin\/plugin\.json/)
})

test('the proxy 403 with the same version on main gives OK', () => {
  assert.deepEqual(run(proxy('0.8.0', PROXY_403, '0.8.0'), '0.8.0').lines, ['OK'])
})

test('another 403 stays CHECK FAILED and curl is never called', () => {
  const s = proxy('0.7.0', 'gh: Forbidden (HTTP 403)', '0.8.0')
  const r = run(s, '0.7.0')
  assert.equal(r.code, 3)
  assert.match(r.lines[0], /^CHECK FAILED cannot read the latest release of alfhen\/agent-pr-pipeline/)
  assert.equal(existsSync(join(s.dir, 'curl.log')), false)
})

test('the proxy 403 with a failed raw read is CHECK FAILED', () => {
  const r = run(proxy('0.7.0', PROXY_403, null), '0.7.0')
  assert.equal(r.code, 3)
  assert.match(r.lines[0], /^CHECK FAILED cannot read the version on main/)
})
