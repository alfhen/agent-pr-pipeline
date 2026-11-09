import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../agents/reviewer.md', import.meta.url), 'utf8');
const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');

test('reviewer checks negative assertions in acceptance and leak tests', () => {
  assert.match(body, /negative assertion in an acceptance or leak test/);
  assert.match(body, /where the checked value comes from in the real run/);
  assert.match(body, /how the test reads it when the run fails/);
  assert.match(body, /preconditions that cannot hold in the real data/);
  assert.match(body, /fixture placement that decides which error the old code throws/);
  assert.match(body, /can pass without testing anything/);
});

test('reviewer reports every finding in round 1', () => {
  assert.match(body, /Report every finding you can see in round 1/);
  assert.match(body, /Do not hold any back for later rounds/);
});

test('reviewer keeps the unsure rule', () => {
  assert.ok(body.includes('When unsure, report no finding'));
});

test('reviewer sweeps sibling places for each blocker and major', () => {
  assert.match(body, /For each blocker and major, look for the same weakness in sibling places/);
  assert.match(body, /other callers of the same function/);
  assert.match(body, /other prompts or scripts with the same job/);
  assert.match(body, /other plan entries and states/);
  assert.match(body, /report each sibling with the weakness as a finding/);
  assert.match(body, /check that the sweep is complete/);
});

test('reviewer checks the invariants of an entry in every round', () => {
  assert.match(body, /Invariants line, check each invariant in every round/);
  assert.match(body, /one row per invariant, with `holds` and `evidence`/);
});

test('reviewer has the plan PR checklist for every round', () => {
  assert.match(body, /In every round of a plan PR/);
  assert.match(body, /where each policy value is read from/);
  assert.match(body, /who can write each signal or record/);
  assert.match(body, /what each script runner can execute/);
  assert.match(body, /what ends each state/);
});
