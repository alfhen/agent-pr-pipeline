// Large output of io.sh: the answer stays under the Bash tool's inline limit and the full text goes to a file in the given temp folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync, chmodSync, accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const LIMIT = Number(/^IO_LIMIT=(\d+)$/m.exec(readFileSync(join(root, 'scripts/io.sh'), 'utf8'))[1])
const INLINE_MAX = 30000

const scripts = mkdtempSync(join(tmpdir(), 'io-large-scripts-'))
copyFileSync(join(root, 'scripts/io.sh'), join(scripts, 'io.sh'))
const stub = (name, body) => writeFileSync(join(scripts, name), `#!/bin/bash\n${body}\n`)
const letters = (n, ch) => `head -c ${n} /dev/zero | tr '\\0' ${ch}`
stub('at-limit.sh', letters(LIMIT, 'a'))
stub('over-limit.sh', letters(LIMIT + 1, 'a'))
stub('big-err.sh', `${letters(100000, 'b')}; echo; echo "the stderr line" >&2; exit 3`)
stub('big-a.sh', letters(100000, 'a'))
stub('big-b.sh', letters(100000, 'b'))
stub('big-ok.sh', letters(100000, 'c'))
stub('small.sh', 'printf "0123456789"')

const fresh = prefix => mkdtempSync(join(tmpdir(), prefix))
const env = tmp => ({ PATH: process.env.PATH, HOME: fresh('io-large-home-'), ...(tmp === undefined ? {} : { PIPELINE_IO_TMP: tmp }) })
const run = (script, tmp, cwd = fresh('io-large-cwd-')) => spawnSync('bash', [join(scripts, 'io.sh'), script], { encoding: 'utf8', cwd, env: env(tmp) })
const pathOf = stdout => /saved at (\S+)\n/.exec(stdout)[1]

test('the limit leaves room for the marker lines under the inline limit of the Bash tool', () => {
  const T = fresh('io-large-t-')
  const r = run('at-limit.sh', T)
  assert.ok(r.stdout.length <= INLINE_MAX, String(r.stdout.length))
})

test('output at the limit comes back inline and writes no file', () => {
  const T = fresh('io-large-t-')
  const r = run('at-limit.sh', T)
  assert.equal(r.stdout, `pipeline-io: begin\n${'a'.repeat(LIMIT)}\npipeline-io: exit 0\n`)
  assert.deepEqual(readdirSync(T), [])
})

test('output one byte over the limit takes the large path', () => {
  const T = fresh('io-large-t-')
  const r = run('over-limit.sh', T)
  assert.ok(r.stdout.startsWith('pipeline-io: begin\npipeline-io: large output'))
  assert.ok(!r.stdout.includes('aaaa'))
  assert.ok(r.stdout.endsWith('pipeline-io: exit 0\n'))
  assert.equal(readFileSync(pathOf(r.stdout), 'utf8'), 'a'.repeat(LIMIT + 1) + '\n')
})

test('a 100 KB output keeps its exit code and comes back byte for byte, with stderr, from the named file', () => {
  const T = fresh('io-large-t-')
  const r = run('big-err.sh', T)
  assert.equal(r.status, 3)
  assert.ok(r.stdout.length < LIMIT)
  assert.ok(r.stdout.startsWith('pipeline-io: begin\n'))
  assert.ok(r.stdout.endsWith('\npipeline-io: exit 3\n'))
  const inline = spawnSync('bash', ['-c', `bash ${join(scripts, 'big-err.sh')} 2>&1`], { encoding: 'utf8' }).stdout
  assert.equal(readFileSync(pathOf(r.stdout), 'utf8').replace(/\n+$/, ''), inline.replace(/\n+$/, ''))
  assert.match(readFileSync(pathOf(r.stdout), 'utf8'), /the stderr line/)
})

test('the file is inside the given temp folder and nothing else is written', () => {
  const T = fresh('io-large-t-')
  const home = fresh('io-large-home-')
  const cwd = fresh('io-large-cwd-')
  const before = readdirSync(scripts).sort()
  const r = spawnSync('bash', [join(scripts, 'io.sh'), 'big-ok.sh'], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH, HOME: home, PIPELINE_IO_TMP: T } })
  const file = resolve(pathOf(r.stdout))
  assert.ok(file.startsWith(resolve(T) + '/'), file)
  assert.deepEqual(readdirSync(home), [])
  assert.deepEqual(readdirSync(cwd), [])
  assert.deepEqual(readdirSync(scripts).sort(), before)
})

test('two large outputs at the same time get two files that each hold their own output', async () => {
  const T = fresh('io-large-t-')
  const go = script => new Promise(done => {
    const p = spawn('bash', [join(scripts, 'io.sh'), script], { env: env(T), cwd: fresh('io-large-cwd-') })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('close', () => done(out))
  })
  const [a, b] = await Promise.all([go('big-a.sh'), go('big-b.sh')])
  assert.notEqual(pathOf(a), pathOf(b))
  assert.equal(readFileSync(pathOf(a), 'utf8'), 'a'.repeat(100000) + '\n')
  assert.equal(readFileSync(pathOf(b), 'utf8'), 'b'.repeat(100000) + '\n')
})

test('an output file that cannot be written is a failure, never exit 0 and never a fallback folder', () => {
  const ro = fresh('io-large-ro-')
  chmodSync(ro, 0o500)
  let writable = true
  try { accessSync(ro, constants.W_OK); writable = true } catch { writable = false }
  const sysBefore = readdirSync(tmpdir()).filter(f => f.startsWith('io-large.'))
  const home = fresh('io-large-home-')
  const cwd = fresh('io-large-cwd-')
  const cases = [['missing folder', join(fresh('io-large-t-'), 'nope')], ['unset', undefined]]
  if (!writable) cases.push(['read-only folder', ro])
  for (const [name, tmp] of cases) {
    const r = spawnSync('bash', [join(scripts, 'io.sh'), 'big-ok.sh'], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH, HOME: home, ...(tmp === undefined ? {} : { PIPELINE_IO_TMP: tmp }) } })
    assert.ok(r.stdout.length < LIMIT, name)
    const last = r.stdout.trimEnd().split('\n').pop()
    assert.match(last, /^pipeline-io: exit [1-9]\d*$/, name)
    assert.notEqual(r.status, 0, name)
    assert.match(r.stdout, /could not write the output file/, name)
    const small = spawnSync('bash', [join(scripts, 'io.sh'), 'small.sh'], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH, HOME: home, ...(tmp === undefined ? {} : { PIPELINE_IO_TMP: tmp }) } })
    assert.equal(small.stdout, 'pipeline-io: begin\n0123456789\npipeline-io: exit 0\n', name)
  }
  assert.deepEqual(readdirSync(home), [])
  assert.deepEqual(readdirSync(cwd), [])
  assert.deepEqual(readdirSync(tmpdir()).filter(f => f.startsWith('io-large.')), sysBefore)
  if (writable) console.log('skipped the read-only case: the folder stays writable for this user')
})
