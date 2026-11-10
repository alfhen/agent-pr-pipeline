import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const body = read('agents/verifier.md').replace(/^---\n[\s\S]*?\n---\n/, '');

test('verifier gives each eval id one result and never changes the list', () => {
  assert.match(body, /exactly one result: `pass`, `fail` or `ci`/);
  assert.match(body, /Never change, reword, drop or skip an eval/);
});

test('verifier uses ci only for a refused command and names the check', () => {
  assert.match(body, /Use `ci` only when a permission check denied the command/);
  assert.match(body, /set `ciCheck`/);
});

test('verifier adds at most 3 checks of its own', () => {
  assert.match(body, /up to 3 checks of your own/);
});

test('verifier has the same Rules block as the other agents', () => {
  const tester = read('agents/tester.md');
  assert.equal(body.slice(body.indexOf('## Rules')), tester.slice(tester.indexOf('## Rules')));
});

test('verifier has the tester related-tests and acceptance rules', () => {
  assert.match(body, /import or name the modules the PR touches/);
  assert.match(body, /at most 10 files/);
  assert.match(body, /`declared` is true only when the plan entry has an Acceptance line that names a runnable test/);
});

test('template has ciChecks', () => {
  assert.deepEqual(JSON.parse(read('templates/pipeline.json')).ciChecks, ['ci']);
});
