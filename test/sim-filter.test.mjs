import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const simPath = fileURLToPath(new URL('./sim-pipeline.mjs', import.meta.url));
const simSource = readFileSync(simPath, 'utf8');
const names = [...simSource.matchAll(/^await check\('((?:[^'\\]|\\.)*)'/gm)].map(m => m[1].replace(/\\(.)/g, '$1'));

const runSim = filter => {
  const env = { ...process.env };
  delete env.SIM_CASE_FILTER;
  if (filter !== undefined) env.SIM_CASE_FILTER = filter;
  const r = spawnSync(process.execPath, [simPath], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  const oks = r.stdout.split('\n').filter(l => l.startsWith('ok  '));
  return { status: r.status, oks, out: r.stdout + r.stderr };
};

test('a filter of one full case name runs only that case', () => {
  const name = names.find(n => n.startsWith('E03b-11: a ci'));
  assert.ok(name, 'the case exists');
  assert.equal(names.filter(n => n.includes(name)).length, 1);
  const r = runSim(name);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.oks, ['ok  ' + name]);
});

test('a filter that several names hold runs exactly those cases', () => {
  const r = runSim('E03b-10');
  assert.equal(r.status, 0, r.out);
  assert.equal(r.oks.length, names.filter(n => n.includes('E03b-10')).length);
  assert.ok(r.oks.length >= 2);
  assert.ok(r.oks.every(l => l.includes('E03b-10')));
});

test('a filter that matches no case exits non-zero, says so and prints no ok line', () => {
  const filter = 'zz-no-such-case-qq';
  assert.ok(!simSource.includes(filter), 'the filter is in no case name');
  const r = runSim(filter);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /no case matched/);
  assert.ok(r.out.includes(filter));
  assert.equal(r.oks.length, 0);
});

test('with no filter, and with a filter every name holds, every case runs', () => {
  assert.ok(names.every(n => n.includes(' ')));
  const all = runSim();
  const spaced = runSim(' ');
  assert.equal(all.status, 0, all.out);
  assert.equal(spaced.status, 0, spaced.out);
  assert.deepEqual(spaced.oks, all.oks);
  const calls = (simSource.match(/await check\(/g) || []).length;
  assert.ok(all.oks.length >= calls, `${all.oks.length} ok lines for ${calls} calls`);
});
