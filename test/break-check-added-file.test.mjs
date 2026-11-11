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
const texts = {
  'agents/verifier.md': normal(read('agents/verifier.md').replace(/^---\n[\s\S]*?\n---\n/, '')),
  'verify prompt': normal(await verifyPrompt() || ''),
};

for (const [name, text] of Object.entries(texts)) {
  test(`${name}: a missing file the change adds is fails-without-change`, () => {
    assert.match(text, /Break check/);
    assert.match(text, /missing-file, import, or exit 127 error[^.]*fails-without-change[^.]*change adds[^.]*new file in the diff/);
  });

  test(`${name}: the added-file rule is marked as an exception to the not-run rule`, () => {
    assert.match(text, /One exception to the not-run rule[^.]*change adds/);
  });

  test(`${name}: not-run only when the test file itself or a file the change does not add fails to load`, () => {
    assert.match(text, /not-run[^.]*the test file itself[^.]*a file the change does not add/);
  });

  test(`${name}: no not-run example for a missing added file`, () => {
    assert.match(text, /Break check/);
    assert.match(text, /Delete a file the PR adds/);
    assert.doesNotMatch(text, /added file is missing[^.]*not-run/);
    assert.doesNotMatch(text, /fails only because the added file is missing/);
  });
}
