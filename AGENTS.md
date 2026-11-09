# Agent rules for this repo

This repo is the agent-pr-pipeline plugin: `skills/`, `agents/`, `workflows/run-wave.js` (plain JavaScript, no filesystem access), `scripts/`, `templates/`, `routine/` (the cloud routine prompts in `routine/cloud/`, see `docs/cloud-routines.md`, and the local hourly routine, see `docs/routine.md`).

## Checks

Run these before you push. CI (`.github/workflows/ci.yml`, check name `ci`) runs the same.

- `node test/sim-pipeline.mjs`
- `node --test test/*.test.mjs` (when any exist)
- `bash scripts/check-syntax.sh`

## Docs style

Simplified Technical English. No em dashes. Diagrams are Mermaid, with a one-line text summary under each. Code comments say why, never what.

## Gated paths

`.github/pipeline.json` lists the paths an agent never merges. A PR that touches one is merged by the maintainer. `docs/goals.md` changes only in its own PR, merged by the maintainer.

## How a change is made

Each change is one PR on its own branch from the default branch. Big work is split into a plan first (`docs/plan-*.md`): each entry has a **Touches** line and an **Acceptance** line, and entries in the same wave can touch the same file when they edit different parts of it, so they can be built in parallel. Entries that edit the same part stay in different waves, and the Touches line names the function or section for a shared file. A conflict at landing goes through the land fix, one PR at a time.

A plan is checked against the product's goals and non-goals before anything is built. An agent that finds an entry widening the product or touching a non-goal stops the plan and asks the maintainer. Only the maintainer changes product scope.

Every PR goes through the same loop. Each step is a separate agent, so no agent checks its own work.

1. **Implement.** An agent builds the plan entry on its branch, with unit tests and the test named in the Acceptance line. It runs every check until it passes, and makes sure the acceptance test fails when the feature is broken. It pushes the branch. It does not open the PR.
2. **Test from a clean clone.** A second agent clones the branch fresh and runs install, lint, typecheck, unit tests and the e2e tests the PR adds or changes. CI runs the full e2e suite. It checks that the acceptance test exists and really ran. It changes no code.
3. **Adversarial review.** A third agent, on a stronger model, reviews the diff against the spec and the plan entry. It looks for bugs, spec drift, privacy and security problems, scope creep, broken rules, and tests that pass for the wrong reason. It ranks each finding as blocker, major or minor.
   When the plan entry has a QA line, a QA agent also uses the built feature like a user, at the same time, and reports what it ran, what it expected and what happened.
4. **Architecture review.** In round 1, a separate agent on a stronger model checks the PR against the architecture document. It lists the new concepts the PR introduces and says whether they fit. It ranks each finding as blocker, major or minor, so a minor stays a minor. A verdict of needs-change needs at least one blocker or major. A plan PR gets this review in every round. If the PR can fix a finding, the fix agent fixes it. If the architecture itself should change to fit this and later work, it stops the PR and asks the maintainer, with options and a recommendation. Only the maintainer changes the architecture.
5. **Fix.** If tests failed or there are blockers or majors, a fix agent fixes them on the same branch, adding commits, never force-pushing. If it thinks a finding is wrong, it says why, with evidence. Then steps 2 and 3 run again. The loop stops when there are no blockers or majors, or after four rounds, when a person decides.
6. **Minor pass.** When a code PR is clean and has minor findings in files the PR already changes, one fixer pass runs before the docs step. It skips gated paths and any minor that needs a design choice. A tester and a reviewer check only the commits of the pass. If tests fail or the reviewer reports a blocker or major, the pass is dropped with a new revert commit, and the PR goes on. There is no second pass. Plan and docs PRs skip it.
7. **Docs.** When the code is clean, a docs agent updates every doc the change makes wrong or incomplete: README, markdown docs and the docs site. It changes no code. If it changed anything, a clean-clone test and a docs review check the new head before the PR opens.
8. **Open the PR and handle the bots.** An agent opens a ready PR that says how it was tested and how many review rounds it took, with one line for each minor the pass fixed, and lists every untested item. It posts one checklist comment for every minor not fixed. It files a GitHub issue with the label `review-minor` only for a minor the reviewer marked as having a real effect, once per PR. It waits for CI and the review bots, and replies on every bot thread: it fixes the point, or says why not. Code changed to answer a bot is tested and reviewed again by other agents before the PR can land.
9. **Merge safety and merge.** On the final head, a script checks the PR's changed files against the gated paths in `.github/pipeline.json`. For a PR the gate does not hold, a merge-safety agent on a stronger model decides `safe` or `person`: `person` for a public interface change the plan entry does not name, a high-risk quick fix, or anything it cannot judge. Agents merge only a PR that passed both and has no untested item, and the maintainer merges every other PR. A PR is merged when CI passes on the head commit and a review bot has approved it, or answered its comments and raised nothing new on the head. Merges are squash merges through `merge-pr.sh`, which runs the gate again. An agent merge needs `--auto`, and `--person` is only for a merge the maintainer asked for in the conversation. The branch is deleted only after GitHub shows the PR as merged.

PR bodies put each `Closes #N` on its own line. GitHub closes only the first issue on a line like `Closes #1, #2`.

Open `review-minor` issues are fixed in batches between plan waves, grouped by the files they touch.

A release is made only by `scripts/release.sh`, run by the main session after the last wave, and only when its checks pass: `autoRelease` is true, the default branch is green, every commit since the last tag came from a PR with a merge record, and the manifest version equals the release version. The first release needs the maintainer. Never run a publish command: the repo's CI publishes. Never force-push the default branch.
