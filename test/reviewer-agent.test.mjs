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

test('reviewer asks for one finding with the rule and a list found by a run', () => {
  assert.match(body, /complete set that only a run of the code or of the tests can give/);
  assert.match(body, /write one finding that states the rule/);
  assert.match(body, /find the set by a run and to list it in the message of the commit that applies the rule/);
  assert.match(body, /every form of input that a parser must refuse/);
  assert.match(body, /every test whose expected result a change alters/);
});

test('reviewer checks the commit messages in a later round and ranks a missing member as a minor about the list', () => {
  assert.match(body, /In a later round, read the commit messages of the branch \(git log\)/);
  assert.match(body, /that the list is there and that the rule was applied/);
  assert.match(body, /lacks is a minor about the list only/);
});

test('reviewer keeps the rank for code that breaks the rule and ranks a wrong rule blocker or major', () => {
  assert.match(body, /the finding is about the code and keeps the rank of the rank list: at least major, never a minor, on a path that real runs take/);
  assert.match(body, /shows the rule itself is wrong is ranked blocker or major and says why the rule is wrong/);
});

test('reviewer does not rank the completeness of a list in a plan entry', () => {
  const sec = body.slice(body.indexOf('## Plan PRs'), body.indexOf('## Rules'));
  assert.match(sec, /names the likely members and the rule: do not rank the completeness of that list as blocker or major/);
  assert.match(sec, /A statement of the entry that a member breaks keeps the rank of the rank list/);
});
