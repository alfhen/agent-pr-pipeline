## How a change is made

Each change is one PR on its own branch from the default branch. Big work is split into a plan first (`docs/plan-*.md`): each entry has a **Touches** line and an **Acceptance** line, and entries in the same wave touch different files so they can be built in parallel.

A plan is checked against the product's goals and non-goals before anything is built. An agent that finds an entry widening the product or touching a non-goal stops the plan and asks the maintainer. Only the maintainer changes product scope.

Every PR goes through the same loop. Each step is a separate agent, so no agent checks its own work.

1. **Implement.** An agent builds the plan entry on its branch, with unit tests and the test named in the Acceptance line. It runs every check until it passes, and makes sure the acceptance test fails when the feature is broken. It pushes the branch. It does not open the PR.
2. **Test from a clean clone.** A second agent clones the branch fresh and runs install, lint, typecheck, unit tests and the e2e tests the PR adds or changes. CI runs the full e2e suite. It checks that the acceptance test exists and really ran. It changes no code.
3. **Adversarial review.** A third agent, on a stronger model, reviews the diff against the spec and the plan entry. It looks for bugs, spec drift, privacy and security problems, scope creep, broken rules, and tests that pass for the wrong reason. It ranks each finding as blocker, major or minor.
   When the plan entry has a QA line, a QA agent also uses the built feature like a user, at the same time, and reports what it ran, what it expected and what happened.
4. **Architecture review.** In round 1, a separate agent on a stronger model checks the PR against the architecture document. It lists the new concepts the PR introduces and says whether they fit. If they do not and the PR can fix it, its findings are majors. If the architecture itself should change to fit this and later work, it stops the PR and asks the maintainer, with options and a recommendation. Only the maintainer changes the architecture.
5. **Fix.** If tests failed or there are blockers or majors, a fix agent fixes them on the same branch, adding commits, never force-pushing. If it thinks a finding is wrong, it says why, with evidence. Then steps 2 and 3 run again. The loop stops when there are no blockers or majors, or after four rounds, when a person decides.
6. **Docs.** When the code is clean, a docs agent updates every doc the change makes wrong or incomplete: README, markdown docs and the docs site. It changes no code. If it changed anything, a clean-clone test and a docs review check the new head before the PR opens.
7. **Open the PR and handle the bots.** An agent opens a ready PR that says how it was tested and how many review rounds it took. It files each minor finding as a GitHub issue with the label `review-minor`. It waits for CI and the review bots, and replies on every bot thread: it fixes the point, or says why not.
8. **Merge.** A PR is merged when CI passes on the head commit and a review bot has approved it, or answered its comments and raised nothing new on the head. Merges are squash merges, done by the person's main session, never by a worker agent. The branch is deleted only after GitHub shows the PR as merged.

PR bodies put each `Closes #N` on its own line. GitHub closes only the first issue on a line like `Closes #1, #2`.

Open `review-minor` issues are fixed in batches between plan waves, grouped by the files they touch.

Never publish a package or create a release without the maintainer's say-so. Never force-push the default branch.
