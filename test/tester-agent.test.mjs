import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../agents/tester.md', import.meta.url), 'utf8');
const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');

test('tester does not check that the acceptance test fails when the feature is reverted', () => {
  assert.match(body, /Do not check or report that the acceptance test fails when the feature is reverted/);
  assert.match(body, /Do not list it as a gap or a failing check/);
});

test('tester names the implementer and the reviewer as owners of the revert check', () => {
  assert.match(body, /The implementer proves it and the reviewer checks it/);
});

test('tester does not name qa as an owner of the revert check', () => {
  assert.doesNotMatch(body, /\bqa\b/i);
});

test('tester keeps the exists and ran rule', () => {
  assert.ok(body.includes('exists and really ran (was not skipped)'));
});

test('tester reports a refused command as refused and never works around it', () => {
  assert.match(body, /Report it with `refused: true`/);
  assert.match(body, /Never work around the denial/);
});

test('tester fills acceptance honestly and reports the acceptance test as its own check', () => {
  assert.match(body, /Report the acceptance test as a check of its own/);
  assert.match(body, /Fill `acceptance` honestly: `declared` is true only when/);
});
