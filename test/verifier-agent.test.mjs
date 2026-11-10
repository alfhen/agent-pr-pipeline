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

test('E03b-4 and E03b-7: the break check pushes nothing, restores the clone and treats added and changed files differently', () => {
  assert.match(body, /Never push, and never touch the branch/);
  assert.match(body, /then restore the clone/);
  assert.match(body, /Reset a file the PR changes with `git checkout origin\/HEAD -- <file>`/);
  assert.match(body, /Delete a file the PR adds, because it is not on `origin\/HEAD`/);
});

test('E03b-10: a load, import, missing-file, syntax or exit 127 error is not-run, not a proof', () => {
  assert.match(body, /fails on its own assertion/);
  assert.match(body, /A load, import, missing-file, syntax or exit 127 error is not that/);
  assert.match(body, /set `not-run` and give the reason/);
});

test('E03b-8 and E03b-9: kinds that pass by design are not-applicable, an unmapped eval is not-run, a ci eval gets none', () => {
  assert.match(body, /`not-applicable` for kinds `regression`, `quality bar`, `size limit`, `time bound` and `reference`/);
  assert.match(body, /cannot map the eval to a test/);
  assert.match(body, /A `ci` eval gets no break check/);
});
