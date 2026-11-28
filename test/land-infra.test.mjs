// land-wave.sh, the infra rerun path: a job that failed in a setup or install step is rerun once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const FX = join(root, 'test/fixtures/land')
const SHA = 'a'.repeat(40)
const OTHER = 'f'.repeat(40)
const P = 'repos__o__r'
const PULL = `${P}__pulls__7`
const CONTENTS = `${P}__contents__.github__pipeline.json`
const put = (fx, name, v) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))
const readJson = (s, name) => JSON.parse(readFileSync(join(s.fx, name), 'utf8'))

const run = (s, args = ['o/r', `7:${SHA}`]) => {
  const e = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: s.fx, FAKE_GH_LOG: s.log, PIPELINE_TEST_FAST: '1' }
  delete e.CLAUDECODE
  const r = spawnSync('bash', [join(root, 'scripts/land-wave.sh'), ...args], { env: e, encoding: 'utf8' })
  const log = existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean) : []
  return { code: r.status, out: r.stdout + r.stderr, log }
}
const failed = (name, runId = 55) => ({ name, status: 'completed', conclusion: 'failure', details_url: `https://github.com/o/r/actions/runs/${runId}/job/9` })
const passed = (name) => ({ name, status: 'completed', conclusion: 'success' })
const step = (name, conclusion = 'failure') => ({ name, status: 'completed', conclusion })
const job = (name, conclusion, firstFailed) => ({ name, conclusion, steps: [step('Set up job', 'success'), ...(firstFailed ? [step(firstFailed, conclusion === 'cancelled' ? 'cancelled' : 'failure')] : [])] })
const jobsOf = (...jobs) => ({ total_count: jobs.length, jobs })
const JOBS = (id) => `${P}__actions__runs__${id}__jobs`

// The fixture of the first test: one failed check `ci` of run 55 whose only job failed in step `Install dependencies`.
const setup = ({ checks = [[failed('ci')], [failed('ci')], [passed('ci')]], jobs = jobsOf(job('ci', 'failure', 'Install dependencies')), runs = { 55: { run_attempt: 1, head_sha: SHA } }, extraJobs = {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'land-infra-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx')
  mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  put(fx, `${P}.json`, { default_branch: 'main' })
  put(fx, `${PULL}.json`, { merged: false, mergeable: true, head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } } })
  put(fx, 'pull-merged.json', { merged: true, head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } } })
  put(fx, `${PULL}__merge.PUT.then`, `pull-merged.json ${PULL}.json\n`)
  put(fx, `${PULL}__merge.PUT.json`, { merged: true })
  checks.forEach((c, i) => put(fx, `${P}__commits__${SHA}__check-runs.call${i + 1}.json`, { check_runs: c }))
  put(fx, `${P}__commits__${SHA}__status.json`, { state: 'success', statuses: [] })
  for (const [id, r] of Object.entries(runs)) put(fx, `${P}__actions__runs__${id}.json`, r)
  if (jobs) put(fx, `${JOBS(55)}.json`, jobs)
  for (const [id, j] of Object.entries(extraJobs)) put(fx, `${JOBS(id)}.json`, j)
  put(fx, `${CONTENTS}@ref=refs__heads__main.json`, readFileSync(join(FX, 'pipeline-flake.json'), 'utf8'))
  put(fx, `${PULL}__reviews.json`, [{ id: 1, user: { login: 'gitar-bot[bot]' }, state: 'APPROVED', body: '', commit_id: SHA, submitted_at: '2026-01-01T10:00:00Z' }])
  put(fx, `${PULL}__comments.json`, [])
  put(fx, `${P}__issues__7__comments.json`, [])
  put(fx, `${P}__commits__${SHA}__check-suites.json`, { total_count: 0, check_suites: [] })
  put(fx, 'user.json', { login: 'alfhen' })
  return { dir, bin, fx, log: join(dir, 'log') }
}
const done = (s, f) => { try { f() } finally { rmSync(s.dir, { recursive: true, force: true }) } }
const reruns = (r) => r.log.filter((l) => /^POST .*rerun-failed-jobs/.test(l))
const merges = (r) => r.log.filter((l) => /^PUT .*\/pulls\/7\/merge/.test(l))
const jobsGets = (r, id = 55) => r.log.filter((l) => l.startsWith(`GET /repos/o/r/actions/runs/${id}/jobs`))
const idx = (r, re) => r.out.split('\n').findIndex((l) => re.test(l))
const failedStep = (s, id = 55) => readJson(s, `${JOBS(id)}.json`).jobs.find((j) => j.conclusion === 'failure').steps.find((x) => x.conclusion === 'failure')?.name
// A refused infra rerun: the NO RERUN line, then LAND FIX, exit 3, no POST, and a jobs read when the cause came from the jobs.
const refused = (r, cause, { read = true, id = 55 } = {}) => {
  assert.equal(r.code, 3, r.out)
  const c = idx(r, cause)
  assert.ok(c >= 0, r.out)
  assert.match(r.out.split('\n')[c], /^NO RERUN #7: /)
  assert.ok(idx(r, /^LAND FIX #7/) > c, r.out)
  assert.equal(r.log.filter((l) => /^POST /.test(l)).length, 0, r.log.join('\n'))
  if (read) assert.ok(jobsGets(r, id).length > 0, r.log.join('\n'))
}

test('land infra: an install-step failure is rerun once and a second failure stops with LAND FIX', () => {
  const s = setup()
  done(s, () => {
    assert.equal(failedStep(s), 'Install dependencies')
    const r = run(s)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^RERUN #7: infra failure in ci step Install dependencies, failed jobs rerun once$/m)
    assert.doesNotMatch(r.out, /NO RERUN/)
    assert.equal(reruns(r).length, 1)
    assert.ok(reruns(r)[0].includes('/actions/runs/55/rerun-failed-jobs'))
    assert.ok(jobsGets(r).some((l) => l.includes('per_page=100')), r.log.join('\n'))
    assert.equal(merges(r).length, 1)
  })
  const s2 = setup({ checks: [[failed('ci')]] })
  done(s2, () => {
    const r = run(s2)
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /^LAND FIX #7 /m)
    assert.equal(reruns(r).length, 1)
    assert.equal(merges(r).length, 0)
  })
})

test('land infra: a failure in step Run tests is not rerun', () => {
  const s = setup({ jobs: jobsOf(job('ci', 'failure', 'Run tests')) })
  done(s, () => {
    assert.equal(failedStep(s), 'Run tests')
    refused(run(s), /^NO RERUN #7: .+; run 55 job ci failed in step Run tests$/)
  })
})

test('land infra: a jobs read that returns 404 is not rerun', () => {
  const s = setup({ jobs: null })
  done(s, () => {
    assert.equal(existsSync(join(s.fx, `${JOBS(55)}.json`)), false)
    refused(run(s), /^NO RERUN #7: .+; cannot read the jobs of run 55$/)
  })
})

test('land infra: a run with run_attempt 2 is not rerun by the infra path', () => {
  const s = setup({ runs: { 55: { run_attempt: 2, head_sha: SHA } } })
  done(s, () => {
    assert.equal(readJson(s, `${P}__actions__runs__55.json`).run_attempt, 2)
    refused(run(s), /^NO RERUN #7: .+; run 55 has run_attempt 2$/, { read: false })
  })
})

test('land infra: a run of another head is not rerun by the infra path', () => {
  const s = setup({ runs: { 55: { run_attempt: 1, head_sha: OTHER } } })
  done(s, () => {
    assert.notEqual(readJson(s, `${P}__actions__runs__55.json`).head_sha, SHA)
    refused(run(s), /^NO RERUN #7: .+; run 55 is not a run of the head$/, { read: false })
  })
})

test('land infra: a run of another head with run_attempt 2 is not a run of the head', () => {
  const s = setup({ runs: { 55: { run_attempt: 2, head_sha: OTHER } } })
  done(s, () => {
    const info = readJson(s, `${P}__actions__runs__55.json`)
    assert.equal(info.head_sha, OTHER)
    assert.equal(info.run_attempt, 2)
    const r = run(s)
    refused(r, /^NO RERUN #7: .+; run 55 is not a run of the head$/, { read: false })
    assert.doesNotMatch(r.out, /has run_attempt/)
  })
})

test('land infra: a run that lists no failed job is not rerun', () => {
  const s = setup({ jobs: jobsOf(job('ci', 'success', null)) })
  done(s, () => {
    assert.equal(readJson(s, `${JOBS(55)}.json`).jobs[0].conclusion, 'success')
    refused(run(s), /^NO RERUN #7: .+; run 55 lists no failed job$/)
  })
})

test('land infra: a timed_out job is not rerun', () => {
  const s = setup({ jobs: jobsOf(job('ci', 'timed_out', 'Install dependencies')) })
  done(s, () => {
    assert.equal(readJson(s, `${JOBS(55)}.json`).jobs[0].conclusion, 'timed_out')
    refused(run(s), /^NO RERUN #7: .+; run 55 job ci ended timed_out$/)
  })
})

// A matrix run: two failed checks of run 55; ci (1) failed in Install dependencies, ci (2) was cancelled by fail-fast.
const matrix = (j1 = job('ci (1)', 'failure', 'Install dependencies'), j2 = job('ci (2)', 'cancelled', 'Run tests')) =>
  setup({ checks: [[failed('ci (1)'), failed('ci (2)')], [failed('ci (1)'), failed('ci (2)')], [passed('ci (1)'), passed('ci (2)')]], jobs: jobsOf(j1, j2) })

test('land infra: an infra job next to a timed_out job is not rerun', () => {
  const s = matrix(undefined, job('ci (2)', 'timed_out', 'Run tests'))
  done(s, () => {
    assert.equal(readJson(s, `${JOBS(55)}.json`).jobs[1].conclusion, 'timed_out')
    refused(run(s), /ended timed_out$/)
  })
})

test('land infra: a run whose only failed jobs are cancelled is not rerun', () => {
  const s = matrix(job('ci (1)', 'cancelled', 'Install dependencies'))
  done(s, () => {
    assert.equal(readJson(s, `${JOBS(55)}.json`).jobs[0].conclusion, 'cancelled')
    refused(run(s), /^NO RERUN #7: .+; run 55 job ci \(1\) ended cancelled$/)
  })
})

test('land infra: an infra job next to a test-step job is not rerun', () => {
  const s = matrix(undefined, job('ci (2)', 'failure', 'Run tests'))
  done(s, () => {
    assert.equal(failedStep(s), 'Install dependencies')
    assert.equal(readJson(s, `${JOBS(55)}.json`).jobs[1].steps[1].name, 'Run tests')
    refused(run(s), /^NO RERUN #7: .+; run 55 job ci \(2\) failed in step Run tests$/)
  })
})

test('land infra: a failed job with no failed step is rerun', () => {
  const s = setup({ jobs: jobsOf({ name: 'ci', conclusion: 'failure', steps: [step('Set up job', 'success'), step('Install dependencies', 'success')] }) })
  done(s, () => {
    assert.equal(readJson(s, `${JOBS(55)}.json`).jobs[0].steps.some((x) => x.conclusion === 'failure' || x.conclusion === 'cancelled'), false)
    const r = run(s)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^RERUN #7: infra failure in ci/m)
    assert.ok(jobsGets(r).length > 0)
    assert.equal(reruns(r).length, 1)
    assert.doesNotMatch(r.out, /NO RERUN/)
  })
})

test('land infra: an install failure with a cancelled matrix sibling is rerun once', () => {
  const s = matrix()
  done(s, () => {
    assert.equal(readJson(s, `${JOBS(55)}.json`).jobs[1].conclusion, 'cancelled')
    const r = run(s)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^RERUN #7: infra failure in ci \(1\) step Install dependencies/m)
    assert.ok(jobsGets(r).length > 0)
    assert.equal(reruns(r).length, 1)
    assert.doesNotMatch(r.out, /NO RERUN/)
  })
})

test('land infra: each setup or install step prefix is infra', () => {
  for (const name of ['Set up job', 'Install dependencies', 'INSTALL deps', 'Set up node', 'Setup Go', 'Checkout', 'Run actions/checkout@v4', 'run actions/setup-node@v4', 'Run actions/cache@v4']) {
    const s = setup({ jobs: jobsOf({ name: 'ci', conclusion: 'failure', steps: [step(name)] }) })
    done(s, () => {
      assert.equal(failedStep(s), name)
      const r = run(s)
      assert.match(r.out, /^RERUN #7: infra failure in/m, name)
      assert.equal(reruns(r).length, 1, name)
    })
  }
  const s = setup({ jobs: jobsOf({ name: 'ci', conclusion: 'failure', steps: [step('Run npm install')] }) })
  done(s, () => {
    const r = run(s)
    assert.match(r.out, /failed in step Run npm install$/m)
    assert.match(r.out, /^LAND FIX #7/m)
    assert.equal(reruns(r).length, 0)
  })
})

test('land infra: a failed commit status next to an install failure is not rerun', () => {
  const s = setup()
  done(s, () => {
    put(s.fx, `${P}__commits__${SHA}__status.json`, { state: 'failure', statuses: [{ context: 'ext/ci', state: 'failure' }] })
    assert.equal(readJson(s, `${P}__commits__${SHA}__status.json`).statuses[0].state, 'failure')
    const r = run(s)
    refused(r, /^NO RERUN #7: commit status failed$/, { read: false })
    assert.equal(jobsGets(r).length, 0)
  })
})

test('land infra: a known-flake rerun followed by an install failure makes one rerun', () => {
  const s = setup({ checks: [[failed('e2e')]] })
  done(s, () => {
    assert.equal(failedStep(s), 'Install dependencies')
    const r = run(s)
    assert.equal(r.code, 3, r.out)
    assert.equal(r.log.filter((l) => /^POST /.test(l)).length, 1)
    assert.match(r.out, /^RERUN #7: known flake\(s\)/m)
    assert.doesNotMatch(r.out, /infra failure in/)
    assert.match(r.out, /^LAND FIX #7/m)
  })
})

test('land infra: a green-parents rerun followed by an install failure makes one rerun', () => {
  const P0 = '1'.repeat(40); const P1 = '2'.repeat(40)
  const s = setup({ checks: [[failed('ci')]] })
  done(s, () => {
    put(s.fx, `${P}__commits__${SHA}.json`, { parents: [{ sha: P0 }, { sha: P1 }] })
    put(s.fx, `${P}__branches__main.json`, { commit: { sha: P1 } })
    for (const p of [P0, P1]) put(s.fx, `${P}__commits__${p}__check-runs.json`, { check_runs: [passed('ci')] })
    assert.equal(failedStep(s), 'Install dependencies')
    const r = run(s)
    assert.equal(r.code, 3, r.out)
    assert.equal(r.log.filter((l) => /^POST /.test(l)).length, 1)
    assert.match(r.out, /^RERUN #7: green parents/m)
    assert.doesNotMatch(r.out, /infra failure in/)
    assert.match(r.out, /^LAND FIX #7/m)
  })
})

test('land infra: a step name with a newline prints one line', () => {
  const s = setup({ jobs: jobsOf(job('ci', 'failure', 'Run\ntests\u0007')) })
  done(s, () => {
    assert.match(failedStep(s), /\n/)
    const r = run(s)
    const lines = r.out.split('\n').filter((l) => l.startsWith('NO RERUN #7:'))
    assert.equal(lines.length, 1, r.out)
    assert.match(lines[0], /Run/)
    assert.match(lines[0], /tests/)
    assert.doesNotMatch(lines[0], /[\u0000-\u001f\u007f]/)
    assert.equal(r.out.split('\n').some((l) => l.startsWith('tests')), false)
    assert.match(r.out, /^LAND FIX #7/m)
    assert.equal(reruns(r).length, 0)
  })
  const s2 = setup({ jobs: jobsOf(job('ci\nlinux', 'failure', 'Install dependencies')) })
  done(s2, () => {
    assert.match(readJson(s2, `${JOBS(55)}.json`).jobs[0].name, /\n/)
    const r = run(s2)
    const lines = r.out.split('\n').filter((l) => l.startsWith('RERUN #7: infra failure in ci'))
    assert.equal(lines.length, 1, r.out)
    assert.match(lines[0], /linux/)
    assert.doesNotMatch(lines[0], /[\u0000-\u001f\u007f]/)
  })
})

test('land infra: the jobs read reads every page', () => {
  const s = setup({ jobs: null })
  done(s, () => {
    put(s.fx, `${JOBS(55)}.1.json`, jobsOf(job('lint', 'success', null)))
    put(s.fx, `${JOBS(55)}.2.json`, jobsOf(job('ci', 'failure', 'Install dependencies')))
    assert.equal(existsSync(join(s.fx, `${JOBS(55)}.json`)), false)
    const r = run(s)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^RERUN #7: infra failure in/m)
    assert.equal(reruns(r).length, 1)
  })
})

const two = (j56) => setup({
  checks: [[failed('ci', 55), failed('lint', 56)], [failed('ci', 55), failed('lint', 56)], [passed('ci'), passed('lint')]],
  runs: { 55: { run_attempt: 1, head_sha: SHA }, 56: { run_attempt: 1, head_sha: SHA } },
  extraJobs: { 56: jobsOf(j56) },
})

test('land infra: two failed runs that failed in install steps are both rerun', () => {
  const s = two(job('lint', 'failure', 'Install dependencies'))
  done(s, () => {
    const r = run(s)
    assert.match(readJson(s, `${P}__commits__${SHA}__check-runs.call1.json`).check_runs.map((c) => c.details_url).join(' '), /runs\/55\/.*runs\/56\//)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^RERUN #7: infra failure in/m)
    assert.ok(jobsGets(r, 55).length > 0 && jobsGets(r, 56).length > 0)
    assert.equal(reruns(r).filter((l) => l.includes('/runs/55/')).length, 1)
    assert.equal(reruns(r).filter((l) => l.includes('/runs/56/')).length, 1)
    // merge-pr.sh posts a merge record after the merge, so only the rerun POSTs are counted.
    assert.equal(reruns(r).length, 2)
    assert.doesNotMatch(r.out, /NO RERUN/)
    assert.equal(merges(r).length, 1)
  })
})

test('land infra: a second failed run with a test-step job blocks the infra rerun', () => {
  const s = two(job('lint', 'failure', 'Run tests'))
  done(s, () => {
    assert.equal(failedStep(s, 55), 'Install dependencies')
    assert.equal(failedStep(s, 56), 'Run tests')
    refused(run(s), /^NO RERUN #7: .+; run 56 job lint failed in step Run tests$/, { id: 56 })
  })
})
