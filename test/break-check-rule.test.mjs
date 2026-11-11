import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const src = read('workflows/run-wave.js').replace('export const meta', 'const meta');
const run = new Function('args', 'agent', 'parallel', 'log', `return (async () => { ${src} })()`);

const EVALS = [
  { id: 'X-1', kind: 'behaviour', statement: 'the flag works', check: 'run it, expect 0' },
  { id: 'X-2', kind: 'error path', statement: 'bad input is refused', check: 'run it with bad input, expect 2' },
];

// Runs the workflow with a fake agent and returns the first verify prompt it sends.
const verifyPrompt = async () => {
  let prompt = null;
  const agent = async (p, o) => {
    if (o.label.startsWith('verify:')) { prompt ??= p; return null; }
    if (/^evals(arch|product):/.test(o.label)) return { verdict: 'ok', notes: '' };
    if (o.label.startsWith('preflight')) return { ok: true, exists: true, goals: 3, nonGoals: 2, missing: [] };
    if (o.label.startsWith('implement')) return { pushed: true, branch: 'b', summary: 's', acceptanceTestPassed: true, worktree: '/wt/x' };
    if (o.label.startsWith('io:')) {
      const out = /#changed/.test(o.label) ? 'CHANGED ["src/a.js"]' : /#cichecks/.test(o.label) ? 'CICHECKS ["ci"]' : '';
      return { exitCode: 0, output: `pipeline-io: begin\n${out}\npipeline-io: exit 0` };
    }
    return null;
  };
  const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)));
  await run({ evals: false, repo: 'o/r', tmp: '/x', plan: 'docs/p.md', architecture: 'docs/design.md', goals: 'docs/goals.md', pluginRoot: '/plug', prs: [{ id: 'C1', title: 't', branch: 'b1', evals: EVALS }] }, agent, parallel, () => {});
  return prompt;
};

const normal = s => s.replace(/`/g, '').replace(/\s+/g, ' ');
const verifier = read('agents/verifier.md').replace(/^---\n[\s\S]*?\n---\n/, '');
const skill = read('skills/pr-pipeline/SKILL.md');
const stepStart = skill.indexOf('2. **Test from a clean clone.**');
const step2 = skill.slice(stepStart, skill.indexOf('\n3. ', stepStart));
const texts = { 'agents/verifier.md': normal(verifier), 'verify prompt': normal(await verifyPrompt() || ''), 'SKILL.md step 2': normal(step2) };

test('the sim run gave a verify prompt with the break-check step', () => {
  assert.match(texts['verify prompt'], /Break check\./);
});

for (const [name, text] of Object.entries(texts)) {
  test(`${name}: any failure but the five not-proof kinds is fails-without-change`, () => {
    assert.match(text, /fails-without-change[^.]*any reason other than a load, import, syntax, missing-file or exit 127 error/);
    assert.match(text, /A load, import, syntax, missing-file or exit 127 error is not that[^.]*not-run/);
    assert.doesNotMatch(text, /own assertion/);
  });

  test(`${name}: a file that stops at its first failure runs each case alone by name`, () => {
    assert.match(text, /stops at its first failing case[^.]*each case alone[^.]*by case name/);
  });

  test(`${name}: a case run alone counts only after it passed alone with the change`, () => {
    assert.match(text, /alone with the change[^.]*first[^.]*passed alone with the change[^.]*full-file run/);
  });

  test(`${name}: a not-run reason names one cause from the six`, () => {
    assert.match(text, /not-run reason in breakWhy names which cause applied: load, import, syntax, missing file, exit 127, or no test for the eval/);
  });
}

for (const name of ['agents/verifier.md', 'verify prompt']) {
  test(`${name}: a TypeError in the test body is a proof`, () => {
    assert.match(texts[name], /TypeError in the test body is such a failure/);
  });
}
