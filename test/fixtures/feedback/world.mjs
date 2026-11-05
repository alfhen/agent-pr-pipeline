// A fake GitHub world for file-feedback.sh --auto and feedback-outbox.sh: settings, tracking issues, records and
// pipeline-feedback issues of a feedback repo and a source repo, served by test/fake-gh from one fixture folder.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const root = new URL('../../../', import.meta.url).pathname
export const FB = 'alfhen/agent-pr-pipeline'
export const SRC = 'acme/widgets'
export const ME = 'alfhen'
const fname = path => path.replaceAll('/', '__')
export const ago = minutes => new Date(Date.now() - minutes * 60e3).toISOString().replace(/\.\d+Z$/, 'Z')
export const DAY = 24 * 60
export const runId = n => `20261105T1200${String(n).padStart(2, '0')}Z-0a1b2c3${n % 10}`
export const MARK = '<!-- pipeline:auto-filed -->'

export const item = (title, extra = {}) => ({ title, detail: 'The step stalled.', evidence: 'wave results', suggestedChange: 'Add a timeout.', severity: 'major', ...extra })
export const routineSettings = (o = {}) => ({
  stage: 1, pipelineVersion: 'v0.8.0', maintainer: ME, waveArgs: { goals: 'docs/goals.md', checks: ['node test/sim-pipeline.mjs'] }, ...o,
})
let nextId = 1000
export const outboxRec = (run, rec = {}, o = {}) => ({
  id: ++nextId, user: { login: o.user ?? ME }, created_at: o.at ?? ago(60),
  body: `<!-- pipeline:routine feedback-outbox ${run} -->\n${JSON.stringify({ source: SRC, feedbackRepo: FB, items: [item('Tester reports a stale sha')], denylist: ['acme', 'widgets'], dropped: 0, ...rec })}`,
})
export const filedRec = (run, o = {}) => ({
  id: ++nextId, user: { login: ME }, created_at: o.at ?? ago(30),
  body: `<!-- pipeline:routine feedback-filed ${run} -->\n{"filed":1,"seenAgain":0,"refused":0}`,
})
export const fbIssue = (number, title, o = {}) => ({
  number, title, state: o.state ?? 'open', user: { login: o.user ?? ME }, created_at: o.at ?? ago(60),
  body: o.body ?? '', labels: [{ name: 'pipeline-feedback' }], ...(o.pr ? { pull_request: {} } : {}),
})
export const autoIssue = (number, o = {}) => fbIssue(number, o.title ?? `Filed earlier ${number}`, { ...o, body: `text\n\n${MARK}${o.extra ? `\n${o.extra}` : ''}\nSource: another repo` })

// o: { fb, src, settingsFb, settingsSrc, noRoutineFb, noRoutineSrc, pausedFb, pausedSrc, recordsFb, recordsSrc,
//      issues (pipeline-feedback issues of the feedback repo), comments: { issue number: [] } }
export function world(o = {}) {
  const fb = o.fb ?? FB; const src = o.src ?? SRC
  const dir = mkdtempSync(join(tmpdir(), 'feedback-world-'))
  const bin = join(dir, 'bin'); const fx = join(dir, 'fx'); mkdirSync(bin); mkdirSync(fx)
  copyFileSync(join(root, 'test/fake-gh'), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const put = (path, v) => writeFileSync(join(fx, `${fname(path)}.json`), JSON.stringify(v))
  put('user', { login: ME })
  const tracking = paused => ({ number: 100, state: 'open', title: 'routine', user: { login: ME }, created_at: ago(9999), body: '', labels: [{ name: 'pipeline-routine' }, ...(paused ? [{ name: 'routine-paused' }] : [])] })
  const side = (repo, settings, noRoutine, paused, records, feedbackIssues) => {
    put(`repos/${repo}/contents/.github/pipeline.json`, noRoutine ? {} : { routine: routineSettings(settings) })
    put(`repos/${repo}/issues`, [tracking(paused), ...feedbackIssues])
    put(`repos/${repo}/issues/100/comments`, records)
    writeFileSync(join(fx, `${fname(`repos/${repo}/issues/100/comments`)}.POST.json`), JSON.stringify({ id: 5000 }))
  }
  const same = fb.toLowerCase() === src.toLowerCase()
  const fbIssues = o.issues ?? []
  side(fb, { ...(o.settingsFb ?? {}), ...(same ? o.settingsSrc ?? {} : {}) }, o.noRoutineFb, o.pausedFb, [...(o.recordsFb ?? []), ...(same ? o.recordsSrc ?? [] : [])], fbIssues)
  if (!same) side(src, o.settingsSrc, o.noRoutineSrc, o.pausedSrc, o.recordsSrc ?? [], [])
  for (const i of fbIssues) put(`repos/${fb}/issues/${i.number}/comments`, o.comments?.[i.number] ?? [])
  writeFileSync(join(fx, `${fname(`repos/${fb}/issues`)}.POST.json`), JSON.stringify({ html_url: `https://github.com/${fb}/issues/99` }))
  const log = join(dir, 'log')
  const sh = (script, args) => {
    const r = spawnSync('bash', [script.startsWith('/') ? script : join(root, 'scripts', script), ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURES: fx, FAKE_GH_LOG: log },
    })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
    const writes = calls.filter(l => /^(POST|PUT|PATCH|DELETE) /.test(l))
    return {
      ...r, calls, writes,
      issuePosts: writes.filter(l => l.startsWith(`POST /repos/${fb}/issues `)),
      records: writes.filter(l => /^POST \/repos\/[^/]+\/[^/]+\/issues\/100\/comments /.test(l)),
      comments: writes.filter(l => /^POST \/repos\/[^/]+\/[^/]+\/issues\/(?!100\/)\d+\/comments /.test(l)),
    }
  }
  const files = (items, deny = []) => {
    writeFileSync(join(dir, 'items.json'), JSON.stringify(items)); writeFileSync(join(dir, 'deny.json'), JSON.stringify(deny))
    return [join(dir, 'items.json'), '--denylist', join(dir, 'deny.json')]
  }
  return {
    dir, fb, src, sh,
    auto: (items, deny, ...flags) => sh('file-feedback.sh', [...files(items, deny), '--repo', fb, '--source', src, '--auto', ...flags]),
    outbox: (run, ...flags) => sh('file-feedback.sh', ['--auto', '--outbox', src, run, '--repo', fb, ...flags]),
    dropOld: (...flags) => sh('file-feedback.sh', ['--auto', '--drop-old', '--repo', fb, ...flags]),
    file: (name, v) => { writeFileSync(join(dir, name), JSON.stringify(v)); return join(dir, name) },
    list: () => sh('routine-state.sh', [src, 'list', 'outboxes']).stdout.trim(),
  }
}

// The JSON of the record in a POST to a tracking issue (the log shows a newline as a backslash and an n).
export const recordOf = call => JSON.parse(call.split('body=')[1].split('\\n').slice(1).join('\\n'))
