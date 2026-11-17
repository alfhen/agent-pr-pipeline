import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import cksum from './cksum.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))

for (const [name, text, want] of [
  ['the empty text', '', '4294967295 0'],
  ['one line', 'one line\n', '665489461 9'],
  ['many lines', 'l1\nl2\nl3\nl4\nl5\n', '3855182126 15'],
  ['bytes above 127', 'café €\n', '3838460761 10']
]) {
  test(`cksum gives the POSIX line for ${name}`, () => assert.equal(cksum(text), want))
}

test('cksum gives the same line for a Buffer as for its text', () => {
  assert.equal(cksum(Buffer.from('café €\n', 'utf8')), '3838460761 10')
})

test('every test file that starts the sim with spawnSync gives the call a timeout', () => {
  const start = new RegExp('spawnSync\\(process\\.execPath, \\[sim')
  const files = readdirSync(here).filter(f => f.endsWith('.test.mjs'))
  const starters = files.filter(f => start.test(readFileSync(here + f, 'utf8')))
  assert.ok(starters.includes('sim-filter.test.mjs') && starters.includes('land-fix-stop-returns.test.mjs'), `found ${starters}`)
  for (const f of starters) {
    const lines = readFileSync(here + f, 'utf8').split('\n')
    lines.forEach((l, i) => {
      if (start.test(l)) assert.match(lines.slice(i, i + 4).join('\n'), /timeout/, `test/${f} starts the sim with no timeout`)
    })
  }
})
