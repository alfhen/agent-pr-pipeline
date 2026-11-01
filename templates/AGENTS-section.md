## How a change is made

Each change is one PR on its own branch from the default branch. Big work is split into a plan first (`docs/plan-*.md`): each entry has a **Touches** line and an **Acceptance** line, and entries in the same wave touch different files so they can be built in parallel.

Every PR goes through the same loop. Each step is a separate agent, so no agent checks its own work.

1. **Implement.** An agent builds the plan entry on its branch, with unit tests and the test named in the Acceptance line. It runs every check until it passes, and makes sure the acceptance test fails when the feature is broken. It pushes the branch. It does not open the PR.
2. **Test from a clean clone.** A second agent clones the branch fresh and runs install, lint, typecheck, unit tests and e2e. It checks that the acceptance test exists and really ran. It changes no code.
3. **Adversarial review.** A third agent, on a stronger model, reviews the diff against the spec and the plan entry. It looks for bugs, spec drift, privacy and security problems, scope creep, broken rules, and tests that pass for the wrong reason. It ranks each finding as blocker, major or minor.
4. **Fix.** If tests failed or there are blockers or majors, a fix agent fixes them on the same branch, adding commits, never force-pushing. If it thinks a finding is wrong, it says why, with evidence. Then steps 2 and 3 run again. The loop stops when there are no blockers or majors, or after four rounds, when a person decides.
5. **Open the PR and handle the bots.** An agent opens a ready PR that says how it was tested and how many review rounds it took. It files each minor finding as a GitHub issue with the label `review-minor`. It waits for CI and the review bots, and replies on every bot thread: it fixes the point, or says why not.
6. **Merge.** A PR is merged when CI passes on the head commit and a review bot has approved it. Merges are squash merges, done by the person's main session, never by a worker agent. The branch is deleted only after GitHub shows the PR as merged.

PR bodies put each `Closes #N` on its own line. GitHub closes only the first issue on a line like `Closes #1, #2`.

Open `review-minor` issues are fixed in batches between plan waves, grouped by the files they touch.

Never publish a package or create a release without the maintainer's say-so. Never force-push the default branch.
