// Runs the BR2 sim cases (land-fix results, stop returns, round numbering) as one node test, with the filter on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const simPath = fileURLToPath(new URL('./sim-pipeline.mjs', import.meta.url))
const ids = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 18, 19, 20]

test('BR2 sim cases all run and pass', () => {
  const env = { ...process.env, SIM_CASE_FILTER: 'BR2-' }
  const r = spawnSync(process.execPath, [simPath], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const oks = r.stdout.split('\n').filter(l => l.startsWith('ok  BR2-'))
  for (const id of ids) assert.ok(oks.some(l => l.startsWith(`ok  BR2-${id}:`)), `BR2-${id} did not run`)
})
