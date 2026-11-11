import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../agents/reviewer.md', import.meta.url), 'utf8');
const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
const lineWith = re => body.split('\n').find(l => re.test(l)) || '';

test('the rank list has a rule for untrusted text that reaches a read, a command or a prompt', () => {
  const rule = lineWith(/untrusted text/);
  assert.notEqual(rule, '', 'reviewer.md holds no rule about untrusted text');
  assert.match(rule, /at least major/);
  for (const w of ['path', 'command', 'URL', 'file read', 'reviewer prompt']) assert.ok(rule.includes(w), w);
  for (const w of ['agent answer', 'script output', 'PR comment', 'bot thread']) assert.ok(rule.includes(w), w);
});

test('the minor-pass sentence lets the check report an untrusted-path finding outside the pass and mark it', () => {
  const sentence = lineWith(/minor-pass check/);
  assert.notEqual(sentence, '', 'reviewer.md holds no minor-pass sentence');
  assert.match(sentence, /untrusted-path finding/);
  assert.match(sentence, /outside those commits/);
  assert.match(sentence, /outsidePass/);
  assert.match(sentence, /Report a blocker or major only for a real fault in those commits/);
});
