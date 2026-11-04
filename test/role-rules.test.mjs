import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bodyOf = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
const fixer = bodyOf('agents/fixer.md');
const implementer = bodyOf('agents/implementer.md');
const arch = bodyOf('agents/arch-reviewer.md');
const triager = bodyOf('agents/triager.md');
const plan = bodyOf('templates/plan.md');

test('fixer lists and fixes sibling places in the same round', () => {
  assert.match(fixer, /list every sibling place with the same weakness and fix them in the same round/);
  assert.match(fixer, /For a plan PR, list the other entries and states each edit touches/);
  assert.match(fixer, /Return `siblings`/);
  assert.match(fixer, /`sameAs`/);
});

test('fixer and implementer search for the old value of a changed constant', () => {
  for (const body of [fixer, implementer]) {
    assert.match(body, /change a constant, default, limit or name/);
    assert.match(body, /git grep -n -F/);
    assert.match(body, /update every mention, or say in your answer why one stays/);
  }
});

test('architecture reviewer ranks findings and needs a blocker or major for needs-change', () => {
  assert.match(arch, /Rank each finding blocker, major or minor/);
  assert.match(arch, /needs-change verdict needs at least one blocker or major/);
  assert.match(arch, /check each earlier `fits` against the new head/);
});

test('triager writes invariants for an entry that adds a check', () => {
  assert.match(triager, /adds a check \(a gate, a guard, a refusal or a trust rule\)/);
  assert.match(triager, /`invariants`: one sentence per property that must hold for every input/);
});

test('plan template has an Invariants line and a States table', () => {
  assert.match(plan, /^Invariants: /m);
  assert.match(plan, /\| State \| How it starts \| What ends it \|/);
});

const qa = bodyOf('agents/qa.md');
const opener = bodyOf('agents/pr-opener.md');
const answerer = bodyOf('agents/bot-answerer.md');

test('qa reports a scenario it could not run as not-run, never as pass', () => {
  assert.match(qa, /`not-run` with `whyNotRun`/);
  assert.match(qa, /Never report it as `pass`/);
  assert.match(qa, /run them again and use the same names/);
});

test('the pr opener and the bot answerer write bodies to files in the temp folder', () => {
  assert.match(opener, /Write each issue body and the PR body to a file with the Write tool, only inside the temp folder your task names, and pass it with `--body-file`/);
  assert.match(answerer, /Write each reply to a file inside the temp folder your task names, and send it with `-F body=@<file>`/);
  assert.match(opener, /Untested section/);
});
