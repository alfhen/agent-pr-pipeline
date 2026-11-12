# Plan for 0.9.4

## Status (2026-11-13)

- Draft, narrowed after plan review. Written after the 0.9.3 release, checked against `main` at ff1cfc7 (K01, #735). Nothing is built.
- This release is the first part of iteration 2 of the maintainer's decision D10. The batches of iteration 2 run on the release that holds the evals-check entries (Release).
- Plan review of the first draft (eight entries) did not converge: round 1 had 3 blockers and 9 majors, round 2 had 6 blockers and 13 majors, most of them on mechanism detail of C01, C02, C03, C06 and C07. The assessment session decided under the maintainer's overnight rule: this plan keeps the entries that settled (C04, C05, C08), and the others are held. Amendment 1 adds C01, C06 and C07 back in what-must-be-true form.
- Amendment 1: C01, C06, C07 in what-must-be-true form. Each bullet says what holds after the change, the build chooses the mechanism, and each open design choice is written with its pick. They are waves D1 (C01) and D2 (C07, C06). C02 and C03 stay held for the maintainer (Held for the maintainer).
- K07 (#631, wave B2 of `docs/plan-0.9.2.md`) is still in its run. This plan does not touch its parts of `workflows/run-wave.js` (`runPRSteps`, the not-ready exits after the bot answer; `evaluatePrompt`) or `scripts/ledger.sh`.

## Summary in plain words

Iteration 1 showed two large problems and three small ones. The large ones are the evals check (of 16 eval lists, 5 were accepted on the first attempt and 5 stopped for a person) and the merge gate (no bot can clear a PR since Gitar's free plan ran out). Their entries need more design work, so they are held for an amendment and for the maintainer.

This plan builds the three small ones now:

- C04: a resume that signs off runs the minor pass, like a first run.
- C05: a tests-only PR records its mutation proof, and a check is "not run" only when no role ran it.
- C08: a dropped minor pass keeps the fixes its check did not fault.

Readers: the maintainer and the sessions that run the batches and Tagreeve. Out: new roles, new run-wave arguments, the batch fixes, the Wavewright rename. Each entry is one PR. A PR is done when its acceptance test passes in CI, an adversarial review reports no blockers or majors, and it is squash-merged.

## Goals this release serves

- Automatic improvement (goal 7): C04 and C08 keep minor fixes that iteration 1 filed or lost. C05 makes a tests-only proof part of the record, so a tests-only PR needs no person for it.
- Goal 8 share: every entry is work on the pipeline's own output, so the share is 3 of 3.

## Findings

| Finding | Issue | What is wrong |
| --- | --- | --- |
| A resume that signs off skips the minor pass. | none (0.9.1 report) | K01 and K05 had no pass, so their minors were filed, not fixed. |
| A dropped minor pass reverts every fix, also the ones its check did not fault. | #702 | K02 and K03 lost fixes that were fine. An outside-marked minor is also lost when the pass drops for another reason. |
| The PR body of a tests-only PR says its mutation checks "were refused and not run", but three agents ran them. | none (Q630, #731) | The tester of the minor-pass check declined by its own scope and reported `refused`. The verifier's record says not-applicable for every eval, so the proof is only in prose. |

## Scope

In:

| Group | Entries | Issues | Size |
| --- | --- | --- | --- |
| A resume that signs off runs the minor pass | C04 | none | S |
| Tests-only proof and "not run" | C05 | #705, #721, #729 | S |
| A dropped pass keeps the fixes it did not fault | C08 | #701, #702 | M |
| The writer maps the entry to its evals (amendment 1) | C01 | #698 | M |
| The size of a list is limited per coverage item (amendment 1) | C07 | none | S |
| The evals check ranks its points (amendment 1) | C06 | none | M |

Not in:

| Issue | Why it waits |
| --- | --- |
| #736, and the gate entries C02, C03 | Held for the maintainer (Held for the maintainer). |
| #706 | A sim case that fails alone. A batch fix with the other sim minors. |
| #708 | A ledger touch reason. `scripts/ledger.sh` is K07's, and the batches take the ledger minors together. |
| #723, #724, #726, #727 | Wording and numbering in the A09 and A10 scripts. A batch fix. |
| #732, #733, #734 | The land-fix list. They touch the `landFix` branch that K07 changes now. A batch fix after K07. |

## Held for the maintainer

| Entry | What it is for | Why it is held |
| --- | --- | --- |
| C02 The merge gate reads a clean bot review of the head (#736) | The gate while no bot approves. | It sets what clears the merge gate (whose reply counts, a check run with no App, the request rule). The maintainer decides first. |
| C03 One review for each final head | The review budget. | It sets when a review is asked, and its draft step needs a call that the REST-only rule forbids. The maintainer decides first, with C02. |

## Order and waves

```mermaid
flowchart LR
  P[Plan PR and amendment 1] --> C1[Wave C1 on v0.9.3: C04 C05]
  P --> D1[Wave D1 on v0.9.3: C01]
  C1 --> C2[Wave C2 on v0.9.3: C08]
  D1 --> D2[Wave D2 on v0.9.3: C07 C06]
  C2 --> R[Version PR, release 0.9.4]
  D2 --> R
  R --> B[Iteration 2 batches on v0.9.4]
```

Summary: waves C1 and D1 build at the same time, because they edit different parts. C08 follows C04, and C07 and C06 follow C01. The version PR waits for all six.

Why this order:

- C08 goes to wave C2, after C04 is on `main`. C04 changes `minorPassRuns`, and C08's evals use the resume path that C04 opens to reach the pass.
- C01 and C07 both refuse a list in code before the evals check, and both need the writer loop line next to `const bad = evalsVerdict(w.evals, pr, meta)` in `writeEvals`. C07 puts its size rule inside the function that C01 adds (`coverageVerdict`), so it adds no second call to that line. That is only possible after C01 is on `main`, so C07 is in wave D2.
- C06 changes the evals check's answer and what happens after `checkEvals` returns. It uses C01's coverage items to rank the points per item, so it also goes in wave D2.
- Wave C1 runs beside wave D1, and wave C2 beside wave D2. The parts tables below show that no two entries of waves that run together edit the same part.
- All waves run on the installed v0.9.3. A fix must not judge itself, and `pluginRoot` is never `main`.

The entries edit different parts of `workflows/run-wave.js`:

| Entry | Parts of `workflows/run-wave.js` |
| --- | --- |
| C04 | `minorPassRuns` |
| C05 | `refusedText`, `verifyPrompt` (only the tests-only break-check sentence), `VERIFY` (the `breakCheck` enum), `verifyOutcome` (the `testsOnly` branch), `breakCheckOf` (the new value), `TESTS_ONLY_LINE` and its rule in `openPrompt` (only the tests-only sentence) |
| C08 (wave C2) | `MINORFIX` (the commit map), `MINORREVIEW` (a `fixes` field on each finding), `normalizeFindings` and `absorb` (only the copy of the `fixes` field), `minorFixPrompt` (one commit for each fix), `minorPass` (the `drop` branch and the result), `minorReviewPrompt` (the Return line), `minorRevertPrompt`, `minorRestore` (the partial-revert check through `scripts/minor-partial.sh`), and in `runPRSteps` only the `pass.outside` return |
| C01 (wave D1) | `EVALS` (the `coverage` field and each eval's `inputFrom`), `evalsRules` (the coverage and input-shape sentences), `evalsPrompt` (step 3 and the Return line), `evalsCheckPrompt` (step 2), a new `coverageVerdict` after `evalsVerdict`, and in `writeEvals` only the line after `const bad = evalsVerdict(...)` in the writer loop, plus the matching line in the given-list branch |
| C07 (wave D2) | the body of `coverageVerdict` (one new size rule at its end), and in `writeEvals` only the given-list branch line that calls `coverageVerdict` (the condition for a list equal to the record) |
| C06 (wave D2) | `EVALSCHECK` (ranked points), `checkEvals` (its return), the `writeEvals` writer loop from the `const c = ...` line to the end of the loop, one new block after the loop (the fresh attempt), `evalsPrompt` (the `last` text), `evalsCheckPrompt` (step 3 and the Return line) |

`skills/pr-pipeline/SKILL.md` has one line for each step of "The loop for one PR", so two edits of one step always conflict:

| Entry | Parts of SKILL.md |
| --- | --- |
| C04 | "The loop for one PR" step 7 (one sentence on a resume) |
| C05 | "The loop for one PR" step 2 |
| C08 (wave C2) | "The loop for one PR" step 7 (the drop sentences) |
| C01 (wave D1) | "Step 1: write the plan" the "Evals." bullet |
| C07 (wave D2) | "Step 1: write the plan" one sentence on the size at the end of the "Evals." bullet |
| C06 (wave D2) | "When things go wrong" the `evals refused:` and `evals check:` row |

C04 and C08 both edit step 7, in different waves. C01 and C07 both edit the "Evals." bullet, in different waves.

Parts of other shared files (amendment 1):

| Entry | File and part |
| --- | --- |
| C01 | `agents/evals-writer.md` the coverage and input-shape rules; `templates/plan.md` the bullet rule; `skills/pr-pipeline/SKILL.md` "Step 1: write the plan" the "Evals." bullet; `test/sim-pipeline.mjs` the `withMeta` and `accepted1` helpers and the `OK_LIST`-style writer answers, changed in place to hold a coverage, and its new block after "E01-1 + E03a: the writer list that E01 accepted reaches the verifier, and a PR with no list goes to the tester"; `test/build-against-evals.test.mjs` and `test/evals-writer.test.mjs`, only their writer answers (`OK_LIST`), changed in place to hold a coverage; `test/evals-coverage.test.mjs` (new) |
| C07 | `agents/evals-writer.md` the size sentence; `skills/pr-pipeline/SKILL.md` "Step 1: write the plan" one sentence on the size at the end of the "Evals." bullet; `test/sim-pipeline.mjs` the case "A06-7 a list of 21 evals is not refused by the check code", changed in place, and its new block after that case |
| C06 | `agents/arch-reviewer.md` and `agents/product-reviewer.md` the evals-check rank rule; `agents/evals-writer.md` a new "Corrections" section; `skills/pr-pipeline/SKILL.md` "When things go wrong" the `evals refused:` and `evals check:` row; `test/sim-pipeline.mjs` the E01 cases that assert the calls of a stop after the last writer attempt, changed in place to expect the fresh attempt, and its new block after the C01 block; `test/evals-rank.test.mjs` (new) |
 In `test/sim-pipeline.mjs` each entry adds its cases as one block after the anchor case its Touches line names, and no two entries share an anchor.

## How the iteration runs

- Both waves run from a local session with `pluginRoot` at the installed v0.9.3, never at `main`.
- `evals`, `breakCheck` and `docsUpdate` are on. The plan PR gets the product review and the architecture review.
- Every entry touches a gated path. Until a gate change is released, each PR merges under the maintainer's standing rule of 2026-11-12: after a completed CodeRabbit review of the final head and green CI, with a merge record and a basis note. `merge-safety` does not run for them.
- After each run: `scripts/after-run.sh` from v0.9.3. A resume uses only the arguments that `scripts/resume-args.sh` prints.
- An evals-check stop gets one fresh rebuild with the refusal in the notes, as in iteration 1. A second stop moves the entry to the next iteration.
- The builder session reports to the assessment session when the plan PR opens, at the end of each wave, when a PR stops for the second time, and when the release is cut.

## Pass criteria (written before the build)

For the entries of this plan:

1. **The four per-PR criteria of iteration 1** (a list before the build, a result for each eval id in the PR body, the break check ran, a ledger record with tokens by role) hold for C04, C05 and C08.
2. **C04 on a real resume.** The first resume in the batches that signs off makes a minor pass, and its result has a `minorPass` field.
3. **C05 on a real tests-only PR.** The first tests-only PR in the batches has a `fails-on-mutation` result for each eval whose statement says it fails when a rule is removed, and its PR body has no "refused" line for a check that a role ran.
4. **C08 on a real partial drop.** When a minor-pass check in the batches faults some fixes and not others, the result lists the kept fixes, or the report says that no such case came up.

The list-acceptance criteria (at least 3 in 4 lists accepted on attempt 1, and no evals-check stop for a person, against iteration 1's base of 16 lists: 5 accepted on attempt 1, 6 on attempt 2, 5 stopped) apply to the batches. They are measured on the release that holds the entries of amendment 1, not on this plan's entries alone.

## Rules for every PR

- Read `AGENTS.md` and `docs/goals.md`.
- Each PR adds tests that fail when the change is removed. The PR description says how that was checked.
- Each negative test checks that its input really contains what the check looks for.
- An entry with an **Invariants** line: the reviewer checks each invariant in every round, and the tests cover each one.
- Each acceptance run is `node test/sim-pipeline.mjs`, `node --test test/*.test.mjs` and `bash scripts/check-syntax.sh` in full.
- Every eval can be checked from a clean clone of the branch: no PR body, labels, bot comments, CI results or merges.
- An eval that says it fails on `main` must fail on `main`. A behaviour that already holds on `main` is kind `regression`.
- Simulation tests check only what code decides. What an agent judges is checked by its prompt text or by a code step after it.
- A fixture of a GitHub answer is built from a real answer of the same endpoint (a check run of PR 731 or 735, a review list, a comment list), with no data from another repo and no real paths of the maintainer's machine. The test says which endpoint it stands for.
- New tests go in new files. Named exception: `test/sim-pipeline.mjs`, where each entry adds its cases as one block after the anchor case its Touches line names, and edits the existing helpers and cases its Touches line names.
- `workflows/run-wave.js` stays plain JavaScript with no filesystem, no `Date.now`, no `Math.random`.
- No entry adds a role, a step or a run-wave argument. A new field in an agent answer or in the result is allowed when the entry names it.
- Every entry runs with `docsUpdate` on. This repo has no `CHANGELOG.md`.
- Docs: Simplified Technical English, no em dashes, Mermaid with a one-line summary under each. Code comments only for why.
- Each behaviour and each invariant of an entry is its own bullet, and the entry says what must be true, not how the code does it. The mechanism is the build's.

## PRs

### Wave C1

**C04 A resume that signs off runs the minor pass.** Round cap 2. Touches: `workflows/run-wave.js` (`minorPassRuns`), `test/sim-pipeline.mjs` (the existing case "minor pass: a skipImpl rerun or a resume runs no pass", which keeps its `skipImpl` half and drops its resume half; and cases after "minor pass: a major from the check does the same"), `skills/pr-pipeline/SKILL.md` (see the table).
- A resume that signs off runs the minor pass, like a first run.
- A `skipImpl` rerun, a docs PR and a plan PR still skip it.
Evals:

| Id | Kind | What must be true | How to check |
| --- | --- | --- | --- |
| C04-1 | behaviour | A resume that signs off with a minor in a file in scope makes a `minorfix:` call. | Sim: `resume: { history, findings, evals }` with one minor; a `minorfix:C1` call. On `main` there is none. |
| C04-2 | regression | A `skipImpl` rerun, a docs PR and a plan PR make no `minorfix:` call. | Sim: three cases. Each case holds a minor in a file in scope, so on a run that does the pass a `minorfix:` call happens and the case fails. |
| C04-3 | behaviour | SKILL.md step 7 says a resume that signs off runs the pass. | `grep -c` on the step line prints 1. |

Acceptance: `node test/sim-pipeline.mjs` passes; C04-1 fails on `main` because `minorPassRuns` is false for a resume.

**C05 A tests-only PR records its proof, and "not run" means no role ran it (#705, #721, #729).** Round cap 2. Touches: `workflows/run-wave.js` (see the table), `agents/verifier.md` (the tests-only rule), `agents/tester.md` (the scope rule), `test/break-check-mutation.test.mjs` (new), `test/verifier-agent.test.mjs` (the tests-only sentence at line 58 changes with the rule), `test/sim-pipeline.mjs` (the F659 tests-only cases that pin the "could not prove" sentence change; and cases after the tests-only cases of #659), `skills/pr-pipeline/SKILL.md` (see the table).
- On a tests-only PR the verifier runs, for each eval whose statement says it fails when a rule is removed, a named mutation of the code under test in its clone, and reports `breakCheck: fails-on-mutation` with the mutation in `breakWhy` when the case fails. It restores the file after each mutation.
- The `VERIFY` schema allows `fails-on-mutation` in `breakCheck`. `verifyOutcome` keeps the value on a tests-only PR, where it sets it to null today.
- `breakCheckOf` counts `fails-on-mutation` as proof, like `fails-without-change`.
- `TESTS_ONLY_LINE` says the break check could not prove the tests can fail only when no eval has a mutation proof. With a proof it says which evals the mutation proved. The F659 cases and `test/verifier-agent.test.mjs` are updated to match, and keep the old sentence for the no-proof case.
- A tests-only eval with no such statement stays not-applicable.
- A tester that does not run a step because the step is outside its task reports it as `skipped: outside scope`, not as `refused`. `refused` is only for a permission check or a file that could not run.
- SKILL.md step 2 says that a missing file the change adds is proof (#721), and a test pins the wording (#729).
- The full-file fallback of a case that fails alone with the change does not give `fails-without-change` (#705).
Evals:

| Id | Kind | What must be true | How to check |
| --- | --- | --- | --- |
| C05-1 | behaviour | A tests-only verify answer with `fails-on-mutation` counts as a break-check fail in the history row, and the PR body line does not say "could not prove" for it. | Sim: a tests-only PR whose verifier answers `fails-on-mutation` for C1-1; the row's `breakCheck.fails` holds C1-1 and the open prompt holds the proof sentence. On `main` `breakCheck` is null for a tests-only PR. |
| C05-2 | behaviour | The verify prompt of a tests-only PR asks for a named mutation for each "fails when removed" eval and the restore step. | Sim: the `verify:C1#1` prompt of a tests-only PR holds the rule. |
| C05-3 | behaviour | `agents/tester.md` and `refusedText` say a step outside the task is `skipped: outside scope`, not `refused`. | `test/break-check-mutation.test.mjs`. |
| C05-4 | behaviour | SKILL.md step 2 holds the added-file proof sentence, and the test fails when it is removed. | The same test file. |
| C05-5 | error path | A case that fails alone with the change and passes in the full file gives no `fails-without-change`. | The same test file, with the prompt text of `verifyPrompt`. |

Acceptance: `node --test test/break-check-mutation.test.mjs` and `node test/sim-pipeline.mjs` pass; C05-1 fails on `main`.

### Wave C2

**C08 A dropped minor pass keeps the fixes its check did not fault (#701, #702).** Round cap 3. Touches: `workflows/run-wave.js` (see the table), `agents/reviewer.md` (the per-fix fault rule of the minor check), `scripts/minor-partial.sh` (new), `AGENTS.md` (step 6, the drop sentences), `test/minor-partial.test.mjs` (new, runs the script on a scratch repo), `test/sim-pipeline.mjs` (cases after the C04 block), `skills/pr-pipeline/SKILL.md` (see the table).
- The fix agent makes one commit for each fix, and `MINORFIX` returns a commit map: the fix number and its sha.
- The minor-check answer names, for each blocker or major, the numbers of the pass fixes it faults.
- The `MINORREVIEW` schema gives each finding a `fixes` field (the numbers of the pass fixes it faults). `normalizeFindings` and `absorb` copy that field, so it is not lost when findings are merged, and two findings with one title keep the union of their fix numbers.
- When the tests pass and every blocker or major names its fixes, the pass reverts only the faulted fix commits, and the tester and the check run once more on the new head. When they find nothing, the other fixes stay, and the result lists them as fixed.
- Code does not trust the reverting agent's head. `scripts/minor-partial.sh` builds a scratch branch from the signed-off sha with a cherry-pick of the kept commits from the commit map, and the new head is accepted only when its tree equals the tree of that branch. A cherry-pick conflict, a missing sha, or a tree that differs drops the whole pass. The agent of `minorRevertPrompt` is told to revert the named commits only.
- When the tests fail, or a blocker or major names no fix, the whole pass drops as today.
- There is no third run: a finding on the second run drops the whole pass.
- An outside-marked minor stays in the minors list when the pass drops for any reason (#702).
- The `needs human: untrusted path outside the minor pass:` stop keeps its prefix in every path (#701).
- `AGENTS.md` step 6 says a pass reverts only the faulted fixes when the tests pass, and drops whole otherwise.
Invariants: a kept pass fix was checked by a tester run and a check run on a head that holds it and no faulted fix, and the script checked that head.
Evals:

| Id | Kind | What must be true | How to check |
| --- | --- | --- | --- |
| C08-1 | behaviour | A check major that faults fix 2 of 3 reverts fix 2 only, a second check runs, and fixes 1 and 3 are in the result's fixed list. | Sim: calls hold `minorrevert:C1`, `test:C1#minor2` and `minorreview:C1#2`; `minorPass.fixed` has two titles. On `main` the pass drops all three. |
| C08-2 | error path | A failing test, or a major that names no fix, drops the whole pass. | Sim: two cases; `minorPass.kept` is false. |
| C08-3 | error path | A finding on the second check drops the whole pass, with no third run. | Sim: no `minorreview:C1#3`. |
| C08-4 | behaviour | An outside-marked minor stays in the minors when the pass drops because the tests failed. | Sim (#702). |
| C08-5 | behaviour | `agents/reviewer.md` asks the minor check to name the faulted fixes, `minorFixPrompt` asks for one commit for each fix, and `minorRevertPrompt` names the commits to revert. | `test/minor-partial.test.mjs`. |
| C08-6 | error path | A partial revert that the agent reports as done but whose head still holds the faulted fix drops the whole pass. | Sim: the reverter returns `reverted: true` with a head whose tree differs from the script's; `minorPass.kept` is false and no kept fix is listed. |
| C08-7 | behaviour | `scripts/minor-partial.sh` accepts a head whose tree equals the kept-commits tree, and refuses a tree that holds the faulted fix and a cherry-pick conflict. | `test/minor-partial.test.mjs`: three cases on a scratch repo. |
| C08-8 | behaviour | `AGENTS.md` step 6 holds the partial-revert sentence. | The same test file greps it. |
| C08-9 | behaviour | Two minor-check findings with one title, one faulting fix 1 and one faulting fix 3, merge into one finding that faults fixes 1 and 3. | Sim: the `minorreview:C1` answer has the two findings; the pass reverts fixes 1 and 3 and keeps fix 2. On `main` the answer has no `fixes` field to keep. |

Acceptance: `node --test test/minor-partial.test.mjs` and `node test/sim-pipeline.mjs` pass; C08-1 fails on `main`.

### Wave D1

**C01 The writer maps the entry to its evals (#698).** Round cap 3. Touches: `workflows/run-wave.js`, `agents/evals-writer.md`, `templates/plan.md`, `skills/pr-pipeline/SKILL.md`, `test/sim-pipeline.mjs`, `test/build-against-evals.test.mjs`, `test/evals-writer.test.mjs` (only the parts in the tables above), `test/evals-coverage.test.mjs` (new).

- A writer answer holds a coverage: a list of items, each with a short text and the ids of the evals that cover it.
- The unit of a coverage item depends on the input:
  - for a plan entry, each bullet and each invariant;
  - for a quick fix, each line of the trusted quick brief and of the Evals comment on the issue;
  - for a batch entry, each issue the PR closes.
- Code refuses a writer list before the evals check, with a reason that starts `evals refused: coverage`, when:
  - the coverage is missing or empty;
  - an item has no eval id;
  - an item names an id that is not in the list.
- Code checks only those three points. Whether the items are all the bullets of the entry is the evals check's judgment, and the check judges it item by item. The entry promises no more than that.
- The evals check's prompt shows the coverage and asks, for each item, whether its evals prove it, and whether a bullet, invariant, brief line or issue has no item.
- Each eval whose check reads an input that a producer makes (a workflow result, a journal line, a GitHub REST answer, a script's output) names that producer in an `inputFrom` field. The evals check judges that the fixture has the producer's real shape.
- `templates/plan.md` says: each behaviour and each invariant of an entry is its own bullet.
- A given list (`prs[].evals`) or a resumed list that equals its accepted record needs no coverage, so a resume of a list accepted before 0.9.4 still runs.
- A given or resumed list that differs from its record, or has no record, needs a coverage. It is refused the same way when the coverage is missing.
- Invariant: no writer list reaches the evals check without a coverage whose every item has an id in the list.

Choice: may an eval belong to no coverage item? Pick: yes. A regression, time bound or size limit eval can serve the entry as a whole and no single bullet, and refusing it would push the writer to invent items.

Choice: where does the batch or quick-fix unit come from, when the workflow cannot read files? Pick: from the writer's own answer, judged by the evals check, as for a plan entry. Code cannot see the brief or the issue list either, so the same limit holds, and the entry says so.

Evals:

| Id | Kind | What must be true | How to check |
| --- | --- | --- | --- |
| C01-1 | behaviour | A writer list with a coverage whose every item has ids in the list reaches the evals check, and the check prompt holds each item. | Sim: a writer answer with a coverage of two items; one `evalsarch:` call whose prompt holds both item texts. On `main` the prompt holds no coverage. |
| C01-2 | error path | A writer list with no coverage stops before any evals check, with a reason that starts `evals refused: coverage`. | Sim: a writer answer with no `coverage`, on its last attempt; the reason starts `evals refused: coverage`, and there is no `evalsarch:` call for that attempt. |
| C01-3 | error path | An item with no id, and an item that names an id not in the list, are each refused the same way. | `test/evals-coverage.test.mjs`: two sim runs, one per case; each reason starts `evals refused: coverage`. |
| C01-4 | behaviour | An eval named by no item does not refuse the list. | Sim: a coverage that leaves out one regression eval; the list reaches the check. |
| C01-5 | behaviour | A resume whose list equals its record runs with no coverage. | Sim: the A01-1 resume setup with a list and record from before 0.9.4 (no coverage); no `evals refused:` stop, and the `verify:` prompt holds each id. |
| C01-6 | error path | A given list that differs from its record and has no coverage is refused with the coverage reason. | Sim: `prs[].evals` with a changed list and no coverage; the reason starts `evals refused: coverage`. |
| C01-7 | behaviour | The writer prompt and `agents/evals-writer.md` name the three coverage units and the `inputFrom` rule, and the check prompt asks per item. | `test/evals-coverage.test.mjs`: reads the agent file and the `evals:C1` and `evalsarch:C1#1` prompts from a sim run. |
| C01-8 | behaviour | `templates/plan.md` holds the rule that each behaviour and invariant is its own bullet. | The same test file reads the template. |
| C01-9 | regression | The tests whose writer answers now hold a coverage pass, and the E01 and A01 cases pass. | `node --test test/*.test.mjs` and `node test/sim-pipeline.mjs` pass in full. |

Acceptance: `node --test test/evals-coverage.test.mjs` and `node test/sim-pipeline.mjs` pass. C01-2 fails on `main`, because a list with no coverage reaches the check.

Review points answered: "code cannot see the entry's bullets" (the third and fourth bullets, and the second choice: code checks structure only, and the claim is narrowed); "refuses every writer list with no coverage, which breaks two other test files" (Touches names both files, changed in place); "C01-6 says A01 cases pass unchanged" (C01-5 and C01-9: the helpers change in place, and a list equal to its record needs no coverage); "the same place as C07" (the wave split).

### Wave D2

**C07 The size of a list is limited per coverage item.** Round cap 2. Touches: `workflows/run-wave.js`, `agents/evals-writer.md`, `skills/pr-pipeline/SKILL.md`, `test/sim-pipeline.mjs` (only the parts in the tables above).

- Code refuses a writer list, before the evals check, with a reason that starts `evals refused: size`, when it holds more evals than its limit, or when one coverage item names more than 6 evals.
- The limit of a list is the larger of 6 and 3 times the number of its coverage items, and no single coverage item names more than 6 evals. So 7 items give a limit of 21, 12 items give 36, and 1 item gives 6.
- Evals that a reviewer adds inside a run (ids with `-R`) are not counted.
- A given or resumed list that equals its accepted record is not refused for its size, also when it holds reviewer evals. A list that was within the limit when it was accepted stays accepted.
- A given list that differs from its record is counted the same way as a writer list, without its reviewer evals.
- `agents/evals-writer.md` states the limit with the same rule, in the same words.
- The existing case "A06-7 a list of 21 evals is not refused by the check code" is changed in place: 21 evals over 7 coverage items pass. Its name says that a list within the limit is not refused.
- Invariant: no list is refused for size because of evals that a reviewer added.

Choice: the numbers. Pick: the rule above, because the batch rule gives one or two evals per issue, so a batch of 7 issues fits at 14 and a batch of 12 at 24 under its limit of 36. The A01 entry (about 10 bullets, 20 evals) also fits. A06's "3 to 6 per issue" stays the writer's aim, inside the limit.

Choice: does the limit apply to the evals check's point count? Pick: no. Only code counts, so the limit is the same in every run.

Evals:

| Id | Kind | What must be true | How to check |
| --- | --- | --- | --- |
| C07-1 | error path | A writer list over its limit is refused with `evals refused: size` before any evals check. | Sim block after A06-7: 2 items (limit 6) and 7 evals; the reason starts `evals refused: size`, and there is no `evalsarch:` call for that attempt. |
| C07-2 | behaviour | A list at its limit passes: 21 evals over 7 items, and 6 evals over 1 item. | A06-7 changed in place, and one new case for 1 item; `implement:C1` runs in both. |
| C07-3 | error path | One item that names 7 evals is refused, also when the list is within its limit. | Sim: 3 items (limit 9), one naming 7 ids (9 evals in all); the reason starts `evals refused: size`. |
| C07-4 | behaviour | Reviewer evals do not count: an accepted list at its limit with one reviewer eval added runs on. | Sim: an accepted list at its limit, and a reviewer eval added in round 1; no `evals refused:` stop. |
| C07-5 | behaviour | A resume whose list equals its record is not refused, also with a reviewer eval in it. | Sim: the C07-4 result resumed with the A09 object form; no `evals refused: size`, and `verify:` runs. |
| C07-6 | error path | A given list that differs from its record and is over the limit is refused. | Sim: `prs[].evals` over the limit with a changed eval; the reason starts `evals refused: size`. |
| C07-7 | behaviour | The writer file holds the same rule. | Sim block: reads `agents/evals-writer.md` and finds the sentence "The limit of a list is the larger of 6 and 3 times the number of its coverage items, and no single coverage item names more than 6 evals." |

Acceptance: `node test/sim-pipeline.mjs` passes. C07-1 fails on `main` after C01, because no size rule exists.

Review points answered: "the 20-eval limit sits in the shared `evalsVerdict`, so reviewer-added evals are refused" (the reviewer bullets and C07-4); "refuses the resume of a list that C07-4 itself allows" (the record bullets and C07-5); "reverses the existing sim case A06-7 and has no sim file" (Touches names the sim file, and A06-7 is changed in place); "the same place as C01" (the wave split and the parts table); the assessment's point that a flat 20 refuses the batches (the numbers choice).

**C06 The evals check ranks its points.** Round cap 3. Touches: `workflows/run-wave.js`, `agents/arch-reviewer.md`, `agents/product-reviewer.md`, `agents/evals-writer.md`, `skills/pr-pipeline/SKILL.md`, `test/sim-pipeline.mjs` (only the parts in the tables above), `test/evals-rank.test.mjs` (new).

- The evals check returns each point with a rank, `contract` or `correction`, and with the coverage item it is about. The rules for each rank are in the reviewer files:
  - contract: an item is not proven, an item is missing, an eval cannot be checked from a clean clone, a claim about `main` is false, an edit falls outside Touches, or an input shape has no producer;
  - correction: a fix to an eval that otherwise proves its item.
- Each correction names the eval id, the field, and one of two edit kinds: `add case`, with the case text, or `replace text`, with the old and the new text.
- On a writer list, a contract point refuses the list, as today.
- On a writer list with correction points only, the writer applies each correction once. Code accepts the corrected list with no second evals check only when:
  - for `add case`, the new check holds the old check unchanged plus the given case text, and the statement, kind and `inputFrom` are equal;
  - for `replace text`, the old text is gone and the new text is in, in that field only;
  - no other eval and no other field changed, and the coverage is unchanged.
- When a correction is not applied exactly, the list is refused with a reason that starts `evals refused: correction`, and the next writer attempt runs as today.
- On a given list, a resumed list and a dispute change, any point refuses, as today. There is no writer there to apply a correction.
- A verdict of `ok` with a contract point refuses. Two corrections to one field of one eval refuse.
- After the last writer attempt is refused, one more writer attempt runs fresh, with no earlier list and with the refusal in its notes. Its list goes through the coverage rules and the evals check like any other. If it is refused, the PR stops as today.
- The stop result keeps its fields and the `evalsMeta` shape. The corrections that were applied are listed in a new result field, `evalCorrections`.
- A kind label that code can settle (whether an eval fails on `main`) is not an evals-check point. The verifier's break check reports a mismatch as a minor finding.
- Invariant: no list that the evals check refused reaches the build except through an exactly applied correction, checked by code.

Choice: how many fresh attempts? Pick: one. This is the hand rebuild that the stop rule did by hand in iteration 1, where it worked in 4 of 5 cases, and more attempts would spend the check each time.

Choice: does a corrected list get a second check when a correction touches a coverage item's only eval? Pick: no. The edit kinds cannot change what an eval proves, because the statement and the kind stay equal and code checks it, so a second check adds cost and no safety.

Evals:

| Id | Kind | What must be true | How to check |
| --- | --- | --- | --- |
| C06-1 | behaviour | A check answer with correction points only, applied exactly, gives an accepted list with no second `evalsarch:` call. | Sim: `evalsarch:C1#1` returns one `add case` correction; the writer's next answer adds the case; one `evalsarch:` call in all, `implement:C1` runs, and `evalCorrections` holds the correction. |
| C06-2 | error path | A correction that replaces the whole check instead of adding the case is refused with `evals refused: correction`. | Sim: the writer answer replaces the check text; the reason or the next attempt's notes start `evals refused: correction`. |
| C06-3 | error path | A correction that also changes another eval is refused the same way. | Sim: the writer changes a third eval's statement; refused. |
| C06-4 | behaviour | A contract point refuses the list, and a verdict `ok` with a contract point refuses too. | Sim: two cases; each gives a next writer attempt. |
| C06-5 | error path | On a given list, a resumed list and a dispute change, a correction point refuses. | Sim: three cases (`prs[].evals`, `resume.evals`, a dispute `change`), each with an answer holding one correction; each is refused or ruled out as today. |
| C06-6 | behaviour | After the last attempt is refused, one fresh attempt runs with the refusal in its notes, and a refusal of it stops the PR. | Sim: every check refuses; the writer labels are `evals:C1`, `evals:C1#w2` and one fresh attempt; the fresh prompt holds the last refusal and no earlier list; then a stop. |
| C06-7 | regression | The stop result keeps `evalsMeta` and its fields. The E01 cases pass, the call-list ones changed in place only for the fresh attempt. | `node test/sim-pipeline.mjs` passes in full. |
| C06-8 | behaviour | The reviewer files hold the two ranks and their rules, and the writer file holds the corrections rule. | `test/evals-rank.test.mjs` reads the three files. |

Acceptance: `node --test test/evals-rank.test.mjs` and `node test/sim-pipeline.mjs` pass. C06-1 fails on `main`, because a correction gets a second check there.

Review points answered: "C06-6 says the E01 cases pass unchanged" (the result shape bullet, and Touches names the call-list cases changed in place); "accepts a corrected list with no second check, and verifies only that the edits are present" and "cannot check that a new-case edit only adds a case" (the two edit kinds and code's exact compare, with C06-2 and C06-3); "does not say what the given-list and dispute paths do" (the given, resumed and dispute bullet, and C06-5); mixed answers (the `ok` with a contract point bullet and the two-corrections bullet).

## Release

- No tag for C04, C05 and C08 alone. Each tag costs the maintainer a plugin reload, and these three do little for the batches.
- 0.9.4 is tagged once C04, C05, C08, C01, C07 and C06 are on `main`, without C02 and C03, and with no live run (the maintainer waived it for 0.9.4). The gate entries become 0.9.5 after the maintainer's decision.
- If amendment 1 does not converge in its plan review, there is no 0.9.4 tag until it does.

## Date estimate

- Size: 3 PRs, this plan PR, amendment 1 with 3 more PRs, and the version PR. About 5 to 8 million subagent tokens without cache reads (a planning figure, from iteration 1: 0.9M to 2.1M per PR).
- The gate is the slow part: about one completed CodeRabbit review an hour, so about one merge an hour.
- Dates: this plan PR on 2026-11-13; waves C1 and C2 on 2026-11-13; amendment 1 and its entries on 2026-11-13 to 2026-11-14; the 0.9.4 release on 2026-11-14. **Range: 2026-11-14 to 2026-11-15.**
- The whole of D10 to the Tagreeve start: 0.9.4 by about 2026-11-15; the gate entries as 0.9.5 after the maintainer's decision; then the batches of iterations 2 and 3 (7 batches each) at about one merge an hour, about 1.5 to 2 days each; then the Wavewright rename release. **Tagreeve start: about 2026-11-19 to 2026-11-21.**

## Flagged concerns

- **Two plans in a row whose review grew worse on mechanism detail.** Plan 0.9.2 amendment 1 (1 blocker and 4 majors, then 2 majors, then 4 majors) and this plan's first draft (3 blockers and 9 majors, then 6 blockers and 13 majors). From now on every entry is in what-must-be-true form: each bullet says what holds after the change, and the mechanism is the build's. An open design choice is written as a choice with a pick.
- **C08 adds a second check run to the minor pass.** It costs a tester and a reviewer more on a partly faulted pass, and saves the fixes that iteration 1 lost. Whether the cost is worth it is the maintainer's to judge from the batches.
- **C05 trusts the verifier's mutation.** A mutation that does not touch the rule under test could still make the case fail. The verifier names the mutation in `breakWhy`, so the reviewer and the report can read it.
- **The coverage map and plan review.** The idea of C01 may carry over to plan review: each goal and each finding of a plan mapped to an entry. A candidate for release 3's planner, not part of this release.

## Out of scope

| Item | Why it waits |
| --- | --- |
| The iteration 2 batches (about 7 issues each, one deliberate batch of 10 to 12) | They run on v0.9.4, after the entries of amendment 1. |
| The gate entries C02 and C03 | The maintainer decides first. |
| The Wavewright rename | Its own release after D10 and before Tagreeve. |
| A second reviewer bot, and any CodeRabbit setting | The maintainer's. |
| Any change in `alfhen/tagreeve` | Its maintainer's PRs. |
