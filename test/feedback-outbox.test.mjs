// Runs scripts/feedback-outbox.sh against test/fake-gh and the real routine-state.sh.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as W from './fixtures/feedback/world.mjs'

const RUN = W.runId(1)
const result = (feedback, o = {}) => ({ feedback, denylist: ['acme', 'widgets'], source: W.SRC, feedbackRepo: W.FB, ...o })
const outbox = (w, res, run = RUN) => {
  writeFileSync(join(w.dir, 'result.json'), JSON.stringify(res))
  return w.sh('feedback-outbox.sh', [w.src, join(w.dir, 'result.json'), '--run', run])
}
const noWrites = r => assert.deepEqual(r.writes, [], r.writes.join('\n'))

test('a result from another repo with an empty denylist is refused (65) and writes nothing', () => {
  const r = outbox(W.world(), result([W.item('Tester slow')], { denylist: [] }))
  assert.equal(r.status, 65, r.stderr)
  noWrites(r)
})

test('the same repo may have an empty denylist', () => {
  const w = W.world({ fb: W.SRC, src: W.SRC })
  const r = outbox(w, result([W.item('Tester slow')], { denylist: [], feedbackRepo: W.SRC }))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, `outbox ${RUN}\n`)
})

test('one record holds source, feedbackRepo, items, denylist and dropped', () => {
  const r = outbox(W.world(), result([W.item('Tester slow')]))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, `outbox ${RUN}\n`)
  assert.equal(r.records.length, 1)
  assert.match(r.records[0], new RegExp(`feedback-outbox ${RUN} -->`))
  assert.deepEqual(W.recordOf(r.records[0]), { source: W.SRC, feedbackRepo: W.FB, items: [W.item('Tester slow')], denylist: ['acme', 'widgets'], dropped: 0 })
})

test('items without evidence or a suggested change are dropped and counted', () => {
  const r = outbox(W.world(), result([W.item('No evidence', { evidence: '' }), W.item('No change', { suggestedChange: ' ' }), W.item('Kept')]))
  const rec = W.recordOf(r.records[0])
  assert.deepEqual(rec.items.map(i => i.title), ['Kept'])
  assert.equal(rec.dropped, 2)
})

test('five items with feedbackItems 3 keep three', () => {
  const r = outbox(W.world(), result(['A', 'B', 'C', 'D', 'E'].map(t => W.item(`Problem ${t}`))))
  const rec = W.recordOf(r.records[0])
  assert.deepEqual(rec.items.map(i => i.title), ['Problem A', 'Problem B', 'Problem C'])
  assert.equal(rec.dropped, 2)
})

test('feedbackItems from the settings is the limit', () => {
  const r = outbox(W.world({ settingsFb: { limits: { feedbackItems: 1 } }, settingsSrc: { limits: { feedbackItems: 1 } } }), result([W.item('One'), W.item('Two')]))
  assert.deepEqual(W.recordOf(r.records[0]).items.map(i => i.title), ['One'])
})

test('an item that the denylist check refuses is dropped and does not use up a slot', () => {
  const r = outbox(W.world(), result([W.item('Leaks acme'), W.item('Two'), W.item('Three'), W.item('Four')]))
  const rec = W.recordOf(r.records[0])
  assert.deepEqual(rec.items.map(i => i.title), ['Two', 'Three', 'Four'])
  assert.equal(rec.dropped, 1)
})

test('no item left means no outbox and no write', () => {
  const r = outbox(W.world(), result([W.item('Leaks acme')]))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'no outbox: no item passed the checks\n')
  noWrites(r)
  const empty = outbox(W.world(), result([]))
  assert.equal(empty.stdout, 'no outbox: no feedback items\n')
})

test('stage 0 prints WOULD and writes nothing', () => {
  const r = outbox(W.world({ settingsSrc: { stage: 0 } }), result([W.item('Tester slow')]))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^WOULD feedback-outbox /)
  noWrites(r)
})

test('a paused repo gets no outbox', () => {
  for (const flag of [{ pausedSrc: true }, { noRoutineSrc: true }]) {
    const r = outbox(W.world(flag), result([W.item('Tester slow')]))
    assert.equal(r.stdout, 'no outbox: paused\n')
    noWrites(r)
  }
})

test('a result from a different repo than the one named is refused', () => {
  const r = outbox(W.world(), result([W.item('Tester slow')], { source: 'acme/other' }))
  assert.equal(r.status, 65)
  noWrites(r)
})

test('a second outbox with the same run is refused by the record rules', () => {
  const r = outbox(W.world({ recordsSrc: [W.outboxRec(RUN)] }), result([W.item('Tester slow')]))
  assert.equal(r.status, 65)
  assert.match(r.stdout, /^no outbox: /)
  noWrites(r)
})

test('an item with an object detail is dropped and does not reach the record', () => {
  const r = outbox(W.world(), result([W.item('Bad', { detail: { 'Seen in acme/widgets': 1 } }), W.item('Good')]))
  const rec = W.recordOf(r.records[0])
  assert.deepEqual(rec.items.map(i => i.title), ['Good'])
  assert.equal(rec.dropped, 1)
})

test('bad arguments exit 64', () => {
  const w = W.world()
  assert.equal(outbox(w, result([W.item('x')]), 'not-a-run').status, 64)
  assert.equal(w.sh('feedback-outbox.sh', [w.src, join(w.dir, 'missing.json'), '--run', RUN]).status, 64)
  writeFileSync(join(w.dir, 'bad.json'), '{"feedback": 1}')
  assert.equal(w.sh('feedback-outbox.sh', [w.src, join(w.dir, 'bad.json'), '--run', RUN]).status, 64)
})
