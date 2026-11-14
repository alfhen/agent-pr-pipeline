# Plan for 0.9.7: the iteration 3 batches

## Status (2026-11-14)

- For plan review. Nothing is built.
- This is D10 iteration 3 under the maintainer's decision D17 of 2026-11-13: only issues where the pipeline does the wrong thing today for an input that a real run can produce.
- Written from two impact passes: for each issue the state on `main`, the parts a fix edits, and each test, fixture and doc sentence that pins today's behaviour. The second pass read `main` at 7e93d8a with PR #783 (C12 of plan 0.9.6) merged in; #783 is on `main` since (0170f9e). Line numbers are from that base. Each Touches line names functions, sections and case titles, because line numbers move.
- The entries have no eval tables. What must be true is in each issue the batch closes, as in plan 0.9.5.
- The batches run with `pluginRoot` at the installed v0.9.6 (C10: three writer attempts; C12: the bar for filed minors and the rank rule).

## Summary in plain words

The sort of 2026-11-13 left 20 open issues that pass the bar, and 7 older issues were sorted on 2026-11-14. Of these 27, the maintainer closed 4 (cloud only, or decided), 1 was fixed by BR6, 1 goes with the merge gate, and 4 are below the bar. This plan fixes the other 17 issues, one more that was filed after the sort (#776), and one fault without an issue. That is 18 closing lines, in five batch PRs in two waves.

Readers: the maintainer and the session that runs the batches.

## Decisions

Taken by the maintainer on 2026-11-14 (D18): #398, #771 and #772 (cloud only) and #654 are closed and not built.

Taken by the driving session, inside the merged plans:

- #548 (a login that only contains "gitar" counts as a bot) is not in this plan. Its script half is the merge gate, and the gate plan (C02) settles the identity of a bot.
- #104 stays in batch C, though no run shows its trigger. The step fails open, and the gate step fails closed.
- The `testPattern` argument that #664 asks for is not built: it is a new public option. Batch B fixes the default pattern.
- #665: Markdown files count as docs. The paths of the `docs` argument do not, because that argument can name a docs site with code. A branch is tests-only when every changed file is a test or a Markdown file, and at least one changed file is a test.
- #769: `testsOnlyBranch` returns `null` when it could not read the changed files, and also for an empty list.
- #91: a prompt rule only. A check that fails because a port is in use runs once more, and is then reported as `refused`, which starts no fix round and puts the check on the untested list. No port for each agent: that is a new rule for every repo.
- #89: the `runPR` catch always builds a result and never throws again. The early check that the issue also asks for is not built: with the catch fixed, the reason is in the result.
- #82: settled by the plan-review check alone, which removes the source of the failure. The opener Refs rule and the land-step compare are not built: the opener has no signal for a partial fix, and `merge-pr.sh` already takes the squash message from the PR body, so the closing lines the plan review passes are the ones that merge.
- #766: the new call of `syncUntested` covers a bot code change and also a land fix whose check stored `false`.
- The stop for a finding that the minor-pass check marks as outside the pass gets a reason that is true for both kinds of finding (no issue; found in the build of C12, which already made the schema description of the mark name both kinds).

Also taken by the maintainer on 2026-11-14: #80, #93, #163 and #18 are below the bar and are closed.

## Rules for every PR

- What must be true is in each issue the batch closes. The evals writer builds the list from the issues, with one coverage item for each issue.
- A batch PR edits only the parts its Touches line names.
- No eval statement holds the trigger words of the PR-text rule: "PR body", "PR title", "PR description", "pull request body", "pull request title", "pull request description", "Closes line", or a closing keyword with "#" and a number. Name the function that writes the text, for example `bodyPrompt` or `openPrompt` step 2.
- Each closing line is on its own line in the description of the PR.
- `workflows/run-wave.js` stays plain JavaScript with no filesystem, no `Date.now` and no `Math.random`. No batch adds a role, a step or a run-wave argument.
- Every batch touches `workflows/**`, so each PR merges under the maintainer's standing rule: a completed CodeRabbit review of the final head that is clean or minor-only (rule A), and green CI.
- CodeRabbit's automatic reviews are off (#781). A wave does not wait for that review: its bot step ends after `botWaitMinutes` (set to 5 in the wave arguments) with no bot seen, and the PR result is ready with the land mode `person`. After the wave, the driving session posts `@coderabbitai full review` on the final head of each PR, one head an hour, and merges under the rule above when that review is complete. A finding above minor is fixed in a land-fix run, and the new head is reviewed again.
- In `test/sim-pipeline.mjs` each batch adds its cases as one block after its anchor case and edits only the cases and helpers its Touches line names.
- Docs: Simplified Technical English, no em dashes.

## Waves

```mermaid
flowchart LR
  R[Release 0.9.6, plugin reload] --> W1[Wave 1: B, C] --> W2[Wave 2: A1, A2, D] --> V[Version PR, release 0.9.7]
```

Summary: two batches in wave 1, three in wave 2, then the release.

Why two waves: steps 9 and 10 of SKILL.md (A2 and C) are on lines that touch, and so are steps 1 and 2 (D and B) and steps 11 and 12 (C and A1). Edits of lines that touch conflict at landing. Also #766 (A2) is right only when #769 (B) is on `main`.

| Part | A1 | A2 | B | C | D |
| --- | --- | --- | --- | --- | --- |
| `runPR` (the catch and the `finally`), `cleanupPR`, `finish` (the `--all` call), `runPRSteps` (the two lines that make `history` and `minors`; the two returns after the `open:` call; the return for a finding outside the pass) | x | | | | |
| `openPrompt` (step 2), `bodyPrompt`, `syncUntested` | | x | | | |
| `TEST_FILE`, `testsOnlyBranch`, `verifyPrompt` (the tests-only sentence), `refusedText` | | | x | | |
| `answerPrompt`, `landFixCheck`, `bots()`, `landReviewPrompt` | | | | x | |
| `ctx` (quick branch), `evalsCheckPrompt` (step 2), `reviewEvalRule`, `reviewPrompt` (the plan sentence) | | | | | x |
| `scripts/cleanup.sh`, `scripts/resume-args.sh` (header comment) | x | | | | |
| `agents/pr-opener.md` | | x | | | |
| `agents/verifier.md`, `agents/tester.md`, `agents/qa.md` | | | x | | |
| `agents/bot-answerer.md`, `scripts/land-commits.sh` | | | | x | |
| `agents/reviewer.md` (the paragraph "When your task lists evals") | | | | | x |
| SKILL.md step 7, step 12, the result paragraph, "Files" (the `cleanup.sh` line) | x | | | | |
| SKILL.md step 9 | | x | | | |
| SKILL.md steps 2 and 4 | | | x | | |
| SKILL.md steps 10 and 11, "Files" (the `land-commits.sh` line) | | | | x | |
| SKILL.md step 1, the paragraph "For the rest of the plan review" | | | | | x |

In the sim, B and C both edit the one shared fake `agent` function, in different branches (`#changed` and `#landcommits`) with three unchanged lines between them.

### Wave 1

**B Tests-only branches, and a port that is in use.** Sim anchor: after "F659: the last verifier round decides tests only".
Touches: `workflows/run-wave.js` (`TEST_FILE` and one new pattern for docs beside it; `testsOnlyBranch` and the comment above it; `verifyPrompt`, only the tests-only sentence of the break-check step; `refusedText`), `agents/verifier.md` (the tests-only sentence; the bullet on a denied command), `agents/tester.md` (the bullet on a denied command), `agents/qa.md` (step 4, `not-run`), `skills/pr-pipeline/SKILL.md` (step 2, the sentences on tests only and on a refused check; step 4, one sentence), `test/sim-pipeline.mjs` (the shared fake agent, branch `#changed`, only for a "could not read" answer; one new block after the anchor), one new test file.
Build notes:
- In the verify prompt and in `agents/verifier.md`, keep the words "a script found that every file the PR changes is a test" where they are, keep `not-applicable` and the text `tests only: no change to take out` after them, and put no full stop between them: the case "F659: code finds a tests-only branch, gives no break-check major or untested item, tells the verifier, and signs off" and `test/verifier-agent.test.mjs` pin them. A file ending such as `.md` in that place breaks both pins.
- The other half of that prompt line (the normal break check) is not edited: `test/break-check-rule.test.mjs` and `test/break-check-added-file.test.mjs` read it.
- `test/skill-docs.test.mjs` pins step 2 ("step 2 names acceptance, related and leftOut", and "up to 10 e2e and docs test files"). Leave those sentences alone.
- `test/tester-agent.test.mjs` and `test/role-rules.test.mjs` read the sentences on a refused command and on `not-run`; keep them and add the port rule after them.
- The case "F659: an unreadable or empty changed-file list keeps the break check" passes unchanged.
Closes #664
Closes #665
Closes #769
Closes #91

**C Bots and the land-fix check.** Sim anchor: after "land fix: a short sha from the fixer is completed from the PR head, and a head that does not extend it stops the PR".
Touches: `workflows/run-wave.js` (`answerPrompt`; `landFixCheck`; `bots()`: the head compare, and the full head for every later use of `headSha`; `landReviewPrompt`, one sentence on the last line of the script output), `scripts/land-commits.sh`, `agents/bot-answerer.md` (the bullet on review-body items), `skills/pr-pipeline/SKILL.md` (steps 10 and 11; "Files" the `land-commits.sh` line), `test/land-commits.test.mjs` (the case "a clean merge of the default branch prints nothing"), `test/sim-pipeline.mjs` (the shared fake agent, branch `#landcommits`; the case "land fix: empty output from land-commits.sh starts no tester or reviewer"; one new block after the anchor), one new test file.
Build notes:
- #432: the marker comment becomes a new step 7 of `answerPrompt`, after the last push. Steps 1 to 6 keep their numbers: `test/wave-prompts.test.mjs` pins "6. If you changed code, reply in the thread". Three more cases of that file ("answer prompt tells the agent to read bot review bodies and reply with one PR comment", "the answer prompt names the marker the status script reads", "the wait and answer prompts paginate their reads") and the sim case "bot status: a rerun on the same head does not run the answer agent again" match sentences of the prompt and the marker text; keep those sentences when the marker step moves.
- #104, what must be true: `scripts/land-commits.sh` prints one last line that says how much it printed (no code, or a count and a `cksum`), and it prints that line only after every command that collects the diff succeeded. `landFixCheck` stops the PR when the line is missing or does not match what came back, so an empty or cut inline answer is no longer read as "no code". The count and the sum are of the output as `scripts/io.sh` gives it back, and the workflow uses the `cksum` helper it already has. Output over 25,000 bytes comes back as a file name, and the workflow cannot read a file: there the last line is in the file, and `landReviewPrompt` tells the reviewer to compare the count and the sum of that line with the file before it reads the diff. A file with no such line, or one that does not match, is incomplete and is a blocker. An answer with a file always goes to the tester and the reviewer, as on `main`. The three K04 cases for the large form pass unchanged. The new stop keeps the prefix `land-fix check failed`.
- #595: the compare takes a short sha that is a prefix of the full head and refuses an empty one, as `endFacts` does. The full head then goes into the answer marker, the diff range of the bot check and the returns.
- `test/skill-docs.test.mjs` "step 11 names the land-fix list rule, the head check and the land-commits union" pins `evalsVerdict`, `evals missing:`, "no evals check", `final facts: head moved`, "short sha" and "either parent changed" in step 11.
Closes #104
Closes #432
Closes #595

### Wave 2

**A1 The result of a PR that stops or throws.** Sim anchor: after "BR6 a PR not opened keeps the issues already filed".
Touches: `workflows/run-wave.js` (the `runPR` catch and its `finally`; `cleanupPR`; `finish`, the `--all` call; in `runPRSteps` the two lines that make `history` and `minors`, the two returns right after the `open:` call, and the return for a finding outside the pass; the two comments in `minorPass` that name an untrusted path outside the pass; no code of `minorPass`), `scripts/cleanup.sh` (`clones`), `scripts/resume-args.sh` (the header comment only), `skills/pr-pipeline/SKILL.md` (step 7, the two sentences on a finding outside the pass; step 12; the result paragraph; "Files" the `cleanup.sh` line), `test/cleanup.test.mjs` (the cases "clones deletes only the folders of the given id", "clones --all removes every folder and keeps the marker", "a usage error exits 2"), `test/sim-pipeline.mjs` (the cases "a PR whose run throws is null in the result, and the other PRs and the evaluator still run", "a second failure is not retried again and the step fails", "cleanup: a PR whose run throws is still cleaned up" and the title of "A10-2 a run failed result of a resume carries its history, disputes and deviations; a fresh run carries the list only"; one new block after the anchor), one new test file.
Build notes:
- #89, #748 and #753 are one change: a PR that throws always gets a result with `ready: false`, the reason `run failed: <message>`, and the `history` and the `minors` it had. The three sim cases that assert a `null` result change with it.
- The `minors` of the new results go through `mergeDuplicates`, so the filing check of C12 applies.
- #776: the folder `open-<id>` is kept when the result of the PR is blocked, by the per-PR call and by the wave-end `--all` call. The workflow gives `clones` the ids to keep as words after the id or after `--all`. The kept folder stays until the maintainer deletes the tmp folder of the run, and step 12 of SKILL.md says so. The cases of `test/cleanup-io-large.test.mjs` call `clones <tmp> --all` and `clones <tmp> <id>` with no more words, and pass unchanged. The sim cases "cleanup: a ready PR and a stopped PR each get one clones call and one worktrees call with their writers' paths" and "cleanup: clones --all runs once, after the evaluator and the redactor" match a prefix of the command, so words after the id or after `--all` keep them valid.
- The reason for a finding outside the pass keeps the prefix `needs human:` and names no kind, for example `needs human: finding outside the minor pass: <titles>`. Four sim cases read only the titles or the prefix.
- `test/skill-docs.test.mjs` pins the result paragraph in three cases: keep `evals check:`, "not answer" and `run failed:`; keep `minors` and "resume.minors"; keep the sentence with `prUrl`, `issues`, `docs`, "PR not opened", "blocked", "bot" and "sync"; no `issuesCreated`.
Closes #748
Closes #753
Closes #761
Closes #776
Closes #89

**A2 The description of an open PR.** After batch B is on `main`. Sim anchor: after "reused PR: the open prompt keeps the body".
Touches: `workflows/run-wave.js` (`openPrompt` step 2, the sentence for an open PR; `bodyPrompt`; `syncUntested`), `agents/pr-opener.md` (the "Open a ready PR" bullet), `skills/pr-pipeline/SKILL.md` (step 9), `test/wave-prompts.test.mjs` (the title of the case "the opener keeps the body of a reused PR and changes only the Review line and the Untested section"), `test/sim-pipeline.mjs` (one new block after the anchor), one new test file.
Build notes:
- #746: `test/wave-prompts.test.mjs` and the sim case "reused PR: the open prompt keeps the body" match "Change only the Review line" up to "and the Untested section" in `openPrompt`, and "Change only its Review line and its Untested section" in `agents/pr-opener.md`. Keep those words and put the new words after them.
- #766: a new sentence of `bodyPrompt` holds none of the words "drop", "exactly" or "remove the section" in its land-fix form, and the reason `PR body not updated with the untested items` stays.
- Step 9 of SKILL.md is pinned by `test/skill-docs.test.mjs` (a sentence with "remov" and `Tests only:`, a sentence with "bot" and `testsOnly`, and `needs human: no login`) and by `test/filing-bar.test.mjs` ("real effect", `input`, `outcome`, `notFiled` and the seven words below the bar). Keep those sentences.
Closes #746
Closes #766

**D Eval rules, the quick-fix prompt and the plan review.** Sim anchor: after "C10-12 a list that the evals check sends back three times stops the PR with the notes".
Touches: `workflows/run-wave.js` (`ctx`, the quick branch; `evalsCheckPrompt` step 2; `reviewEvalRule`; `reviewPrompt`, the sentence for a plan PR), `agents/reviewer.md` (the paragraph "When your task lists evals"), `skills/pr-pipeline/SKILL.md` (step 1, the sentence on the evals check; the paragraph that starts "For the rest of the plan review"), `test/sim-pipeline.mjs` (one new block after the anchor), one new test file.
Build notes:
- The new sentence of `reviewEvalRule` goes between its first and its last sentence, which `test/review-after-evals.test.mjs` pins.
- The new sentence of `agents/reviewer.md` holds none of `fileIssue: true`, "untrusted text" and "minor-pass check" (`test/reviewer-rank.test.mjs`, `test/filing-bar.test.mjs`).
- The new sentence of `evalsCheckPrompt` comes after "has no eval?" (`test/evals-writer.test.mjs`, E01-11), and it is not the sentence of C10 that `test/evals-attempts.test.mjs` (C10-8) keeps out of that prompt. The sentences of step 1 on the PR-text rule are not edited (C10-9).
- #82: the plan review checks that each issue an entry closes is fully settled by that entry. The new sentence comes after "Check each entry's Acceptance line against the plan's decisions", which two tests pin.
Closes #649
Closes #655
Closes #438
Closes #82

## Not in this plan

| Issue | Why |
| --- | --- |
| #767 | Fixed by BR6 (#770), closed. |
| #548, #779, #780 | With the merge gate plan (C02, C03). |
| #654, #398, #771, #772 | Closed by the maintainer's decision of 2026-11-14. |
| #80, #93, #163, #18 | Below the bar; closed by the maintainer's decision of 2026-11-14. |
| #596, #705 | Design choices, held with C05 to C09. |

## Pass criteria

1. The four per-PR criteria of iteration 1 hold for each batch.
2. No eval list stops at the evals stage (pass criterion 2 of plan 0.9.6).
3. The batches file at most 1 issue for each 5 they close (pass criterion 4 of plan 0.9.6): at most 3 for 18.
4. After the release nothing is open that is ranked above minor, and the open issues that pass the bar are the three of the gate plan.

## Release

- 0.9.7 is the five batches. The version PR and the tag are made as for 0.9.5.
- After it: the gate plan (C02 with #548 and #779, C03 with #780, C11), then the product run on Tagreeve.

## Flagged concerns

- #104: no run shows a relayed diff that came back wrong or empty.
- #664: this repo has only `test/*.test.mjs`, so the new layouts are tested by pattern cases only.
- #91: this repo has no test with a fixed port, so the rule is tested by prompt text only. It matters for a product repo whose tests start a server.
- Batch A1 has 5 issues and one more fault, in 5 functions and 2 scripts. If its eval list does not settle, split off #776 (`cleanupPR`, `finish`, `scripts/cleanup.sh`, step 12).
- A result for every PR that throws changes what a wave with `evals: false` returns. The scripts that read a result take an object, so they then work for such a PR; before, they stopped.

## Not verified

The lists at the end of the two impact passes hold (`.claude/assessment/drafts/impact-iter3.md` and `impact-iter3b.md`, local notes of the driving session). In short: the trigger of #104 and the docs-step path of #665 were read in code only; no run shows a port clash (#91); the port rule of #91 is tested by prompt text only.
