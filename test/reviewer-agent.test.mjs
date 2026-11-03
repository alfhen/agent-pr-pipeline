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
