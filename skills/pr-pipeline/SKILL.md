---
name: pr-pipeline
description: Plan and build a release or a batch of changes as small PRs, where separate agents implement, test from a clean clone, review adversarially, fix, open the PR, answer review bots and bring it to green CI, and the main session merges. Use when the user asks to plan and build a release, a milestone or a set of issues "with the usual workflow", to run waves of PRs through review, or to set up this loop in a new repo. Not for a single quick fix.
---

# Agent PR pipeline

One PR at a time is easy to check. Many PRs at once are not, unless each PR goes through the same fixed loop and no agent checks its own work. This skill is that loop.

This skill is part of the agent-pr-pipeline plugin. The plugin folder is `${CLAUDE_PLUGIN_ROOT}`: the scripts, templates and the workflow are there. Each step runs as one of the plugin's role agents (`agent-pr-pipeline:<role>`, see "Role agents").

```mermaid
flowchart LR
  P[Plan PR] --> PF{Product fit: plan serves the goals?}
  PF -- escalate --> PH[Person decides scope]
  PH --> P
  PF -- aligned or notes --> I[Implement]
  I --> T[Test from a clean clone]
  I --> R[Adversarial review]
  I --> AR[Architecture review]
  I -. QA line or qa .-> Q[QA: use it like a user]
  AR -- escalate --> H[Person decides the architecture]
  H --> I
  T --> D{Tests pass and no blockers or majors?}
  R --> D
  AR -- fits or needs-change --> D
  Q --> D
  D -- no --> F[Fix] --> T
  F --> R
  D -- yes --> DA[Docs agent updates the affected docs]
  DA -- no change --> O[Open PR, file minors]
  DA -- docs changed --> DC{Clean-clone test and docs review pass?}
  DC -- no --> DF[Fix] --> DC
  DC -- yes --> O
  O --> W[Small agent waits for the bots]
  W -- comments --> A[Answer the bots]
  W -- none --> EV[Last step of the workflow: evaluator, and redactor for another repo]
  A --> EV
  EV --> S[Land script: CI green, merge]
  S -- conflict or red CI --> X[Land-fix agent] --> S
  S --> FB[Maintainer approves, main session adds land problems, file-feedback.sh files the items]
```

Summary: a plan is reviewed first, including whether it still serves the product's goals. Then different agents build, test, review for bugs, review for architecture and (where the plan asks) try each PR like a user until it is clean, or until a person settles an architecture question. A docs agent then brings the docs in line, and a short round checks its commits. Then the PR is opened, the bots are answered, and a script in the main session merges it. At the end of the workflow, before landing, an evaluator turns the run into feedback items about the pipeline. After landing, the maintainer approves them, the main session adds the land problems, and a script files them as issues.

## The loop for one PR

1. **Implement.** A worker agent builds one plan entry on its own branch, with unit tests and the acceptance test. It breaks the feature on purpose to see the test fail, then restores it. It runs the fast checks and the e2e files the PR adds or changes, pushes the branch, and does not open a PR.
2. **Test from a clean clone.** A second agent clones the branch fresh and runs the fast checks (install, lint, types, unit tests) and the PR's own e2e files. It changes no code. A clean clone catches what a dirty worktree hides: missing files, lockfile drift, a test that only passes with local state. The full e2e suite is CI's job.
3. **Adversarial review.** A third agent, on a stronger model, reads the diff against the spec and the plan entry. It ranks findings as blocker, major or minor. It runs in parallel with the tester.
4. **QA.** For a code PR whose plan entry has a **QA:** line (the main session sets `qa` on it) or with `"qa": "all"`, a Sonnet agent at medium effort uses the built feature like a user, in parallel with the reviewer. It runs the acceptance case, then edge cases, error paths, combinations with existing options and what the docs promise, and gives the command, the expected and the actual result for each finding. Its blockers and majors go to the fix agent; it runs again in the next round only if it found any. It does not read the code for bugs or rerun the test suite.
5. **Architecture review.** In round 1, in parallel with the tester and the adversarial reviewer, an Opus agent reads the architecture document, the plan and the diff. It lists every new concept the PR introduces (module, record type or field, command, flag, config file, dependency, boundary, place where state lives) and gives one verdict:
   - **fits:** nothing to do.
   - **needs-change:** the PR goes against the architecture in a way the PR can fix. Its findings count as majors for the fix agent, and it checks again in the next round.
   - **escalate:** the architecture itself should change, because the PR or the plan shows the structure will not hold for what comes next, or the PR needs a decision that is not the PR's to make. The PR stops with `needs human: architecture`, a question, options and a recommendation. A person decides; the PR resumes with that decision.
   Docs-only PRs skip it. Plan PRs get it too: a plan is where new concepts usually first appear.
6. **Fix.** If a check failed or there are blockers or majors, a fix agent adds commits to the same branch. It never force-pushes. If it thinks a finding is wrong, it says why with evidence. Then steps 2 and 3 run again (and 4 and 5, if they asked for changes). Stop after `maxRounds` (default 4; plan PRs 2); then a person decides.
7. **Docs.** After a code PR signs off, a docs agent reads the diff and finds every doc the change makes wrong or incomplete: README, markdown docs, and the docs site if there is one. It updates only those places, on the same branch, and builds the site if it can. If nothing needs a change, it pushes nothing and the PR goes on. If it pushed, the tester and a Sonnet docs reviewer check the new head. If they find problems, the docs writer fixes them in the docs only and reverts any code change, and the check runs again (`docsRounds`, default 2). The code fixer never runs in this step, so code that passed review cannot change without review. So the sha the land script merges is always one the pipeline checked. Docs and plan PRs skip this step.
8. **Open the PR.** An agent opens a ready PR and files every minor finding as an issue (label `review-minor`). The PR body says which docs the PR updates.
9. **Bots.** A small agent (Haiku, low effort) waits for the review bots and counts their open comments. Only if there are any does an answer agent run: it fixes the point or says why not, on every thread, and adds `Closes #N` to the PR body for each minor issue its fix settles. If it changed code, the tester and a reviewer that reads only the answer's commits check the new head, with a fix round if needed (`botCheckRounds`, default 2). So no code lands that no other agent checked.
10. **Land and merge.** The main session runs `${CLAUDE_PLUGIN_ROOT}/scripts/land-wave.sh` with the `<pr>:<sha>` pairs from the `prs` of the workflow result. It waits for CI and squash-merges only when the PR's head is still the commit the pipeline checked, every check passed, and a review bot cleared the PR (see Step 3). It deletes the branch only after GitHub shows MERGED. A PR that conflicts or has a red check is reported as `LAND FIX`. A land-fix agent handles only that PR; then the bots are waited for and answered on its new head, like in step 9.

11. **Evaluate.** This runs inside the workflow, before the land script, so the evaluator does not see land outcomes; Step 4 adds those. After every PR in the wave has finished (or the wave was refused), an evaluator agent (Sonnet, medium, read-only) reads the wave's results and, through `gh api`, the PRs. It returns feedback items about the pipeline: title, what worked or went wrong, evidence, a suggested change and severity. It also returns the paths the wave changed. When the wave's repo is not `feedbackRepo` (default `alfhen/agent-pr-pipeline`), a redactor agent (Haiku, low) rewrites each item without the other repo's code, data, file paths, names or URLs, and drops items it cannot make generic. The redactor is the first pass only. The workflow also returns a `denylist`: the source repo's owner, name and URL, and the changed paths. A run where every PR is a `landFix` PR does not evaluate. `feedback: false` turns the step off.

## Before the first run in a repo

- **Write the goals document first. The pipeline refuses to start without it.** Run the `agent-pr-pipeline:write-goals` skill: it asks the maintainer for the goals, non-goals and users, writes the goals template into the repo (for example `docs/goals.md`) and checks it. Or copy the template and fill in the Goals and Non-goals sections by hand, at least one item each. Only the maintainer decides the content. Check it with `${CLAUDE_PLUGIN_ROOT}/scripts/check-goals.sh <owner/repo> docs/goals.md`; the workflow runs the same check as its first step and refuses every PR in the wave if the file is missing or incomplete.
- Add the loop to the repo's `AGENTS.md` (or `CLAUDE.md`). `${CLAUDE_PLUGIN_ROOT}/templates/AGENTS-section.md` is a starting point. Workers read it, so hard rules go there once instead of in every prompt.
- Install at least one review bot on the repo (CodeRabbit, Gitar or similar). One of them clearing the PR is the merge gate.
- Know the check commands (install, lint, typecheck, unit, e2e) and how long e2e takes.
- Pick a temp folder for clones that is not shared `/tmp`.

## Step 1: write the plan, then review the plan

Big work starts as a plan document, for example `docs/plan-<version>.md`. Copy `${CLAUDE_PLUGIN_ROOT}/templates/plan.md`. The plan is the brief for every worker, so it must be concrete:

- **One entry per PR**, with an ID (`T01`, `U02`...), the issues it closes, a **Touches** line (every file it edits) and an **Acceptance** line (the test that proves it, and how that test fails without the change).
- **Waves.** Entries in one wave touch different files, so they can be built in parallel without conflicts. A Mermaid diagram of the waves, with a one-line summary.
- **Shared files.** If several PRs must add to one file (a CHANGELOG), the plan PR adds one marker per PR with a blank line between each pair. Each PR replaces only its own marker. Git sees no conflict because no two PRs edit adjacent lines.
- **Out of scope.** A table of what waits and why.

Triage before planning when the input is a pile of issues: give each read-only agent a group of issues, ask it to check each one against the code (not the title), and return still-valid, size, milestone and reasons. Some "bugs" turn out to be fixed already, and some "nits" turn out to be real bugs.

Run the plan itself through the pipeline with `skipImpl: true` and `kind: "plan"`.

**Product fit.** In round 1 of a plan PR, an Opus agent reads the product's goals and non-goals (the `goals` document) and the plan, and judges every entry: it serves a stated goal, is neutral, widens the product in a direction the goals do not mention, or touches a non-goal. It suggests keep, trim, defer, cut or change-goals for each.
- **aligned:** nothing to do.
- **notes:** small drift; each becomes a minor issue and the plan goes on.
- **escalate:** the plan stops with `needs human: product` and one question. Product scope is the person's call, never an agent's. Typical catches: a second interface next to the main one (an MCP server on a CLI tool), a hosted service, a new audience, polish no goal asks for.
After the person decides, rerun with `productDecision` set; if the decision changes the goals, update the goals document first.

For the rest of the plan review, the reviewer checks that claims about the code are true, Touches lines are complete, acceptance tests can fail, and the scope matches the goal. Plans usually need several rounds.

## Step 2: run one wave

Run the plugin's `run-wave` workflow, one wave per run: call the Workflow tool with `name: "agent-pr-pipeline:run-wave"` and the arguments below. If that name does not resolve, use `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/run-wave.js"`. Load the workflow-authoring skill only if you change the script.

The workflow starts every agent as its role agent (`agentType: "agent-pr-pipeline:<role>"`). The role rules are in the agent definitions; the workflow's prompts carry only the data: repo, plan, branch, commands, findings.

### Workflow arguments

```json
{
  "repo": "owner/name",
  "tmp": "/absolute/temp/folder",
  "plan": "docs/plan-1.2.md",
  "spec": "docs/design.md",
  "architecture": "docs/architecture.md",
  "goals": "docs/goals.md",
  "context": "Project facts and hard rules every agent needs, in a few lines.",
  "checks": ["pnpm install --frozen-lockfile", "pnpm lint", "pnpm typecheck", "pnpm test"],
  "e2ePattern": "\\.e2e\\.test\\.ts$",
  "e2eCommand": "pnpm exec vitest run {files}",
  "maxRounds": 4,
  "planRounds": 2,
  "botWaitMinutes": 20,
  "bots": "CodeRabbit (login coderabbitai) and Gitar (login contains \"gitar\")",
  "milestone": "1.2.0",
  "docs": ["README.md", "docs/"],
  "docsBuild": "pnpm docs:build",
  "steps": { "review": { "model": "opus", "effort": "high" } },
  "skills": { "impl": ["laravel-idioms:laravel-idioms"], "open": ["humanizer:humanizer"] },
  "prs": [
    { "id": "T01", "title": "Short PR title", "branch": "fix/short-name", "kind": "code", "notes": "Build plan entry T01. Settle minor #123. PR body: Closes #45 on its own line." },
    { "id": "T02", "title": "Sign webhook payloads", "branch": "feat/webhook-signing", "sensitive": true, "notes": "Build plan entry T02." }
  ]
}
```

- `checks` are the **fast** checks. Agents also run the e2e files the PR adds or changes (`e2ePattern`, run with `e2eCommand`). The full e2e suite runs only in CI, so CI must run it on every PR.
- `architecture`: the document the architecture reviewer checks against (defaults to `spec`). Set `"architectureReview": false` to turn the step off.
- `goals` (**required**): the product goals document. Without it the workflow throws before any agent starts, and a preflight agent refuses the wave if the file has no Goals or Non-goals items. `productReview: false` turns off the review step, not this requirement. `"productReview": "all"` also runs it on code PRs; `false` turns it off.
- `qa`: `"all"` runs the QA agent on every code PR; `false` turns it off. Without it, QA runs only on PRs with `qa` set. Set `qa: true` on each PR whose plan entry has a QA line, or `qa: "<what to try>"` to give the agent its cases directly.
- `feedback`: `false` turns the end-of-run evaluation off. `feedbackRepo`: where feedback is filed (default `alfhen/agent-pr-pipeline`). The redactor runs only when `repo` differs from it.
- `docs`: where the docs are, for example `["README.md", "docs/", "site/"]`. Without it the docs agent finds them. `docsBuild`: the command that builds the docs site, if any. `docsUpdate: false` turns the docs step off for the wave (or for one PR). `docsRounds`: rounds for the docs check (default 2).
- `skills`: which skills each step's agent loads before it starts. See "Pair skills with steps" below. Default: none.
- `kind`: `code` (default), `docs` or `plan`. Docs and plan PRs get a Sonnet reviewer at high effort instead of Opus. Plan PRs stop after `planRounds` (default 2); fix what is left by hand, then rerun with `skipImpl`.

Models and effort per step are in the table under "Role agents". Override a step for the whole wave in `steps`, for example `{ "review": { "model": "opus", "effort": "xhigh" } }`. `reviewDocs` sets the reviewer of docs and plan PRs and the docs check (default sonnet, high).

PR options: `skipImpl: true` when the branch is already built (a plan PR, or a branch you pushed). `resume: { history, minors, findings }` to continue a PR whose rounds ran out. `landFix: true` with `prNumber` runs only the land-fix agent for that PR. `architectureDecision: "..."` carries a person's answer to an architecture escalation into every agent's brief for that PR; the architecture reviewer then checks the PR follows it and does not escalate the same question again. `productDecision: "..."` carries a person's answer to a product-fit escalation in the same way. `sensitive: true` adds a security-review skill to this PR's reviewer (see below). `skills: { ... }` adds skills for this PR only, on top of the wave's `skills`. `docsUpdate: false` skips the docs step for this PR.

The result is `{ prs, feedback, denylist, source, feedbackRepo }`. `source` is the wave's repo. `feedback` holds the evaluator's items (redacted for another repo) and `denylist` the strings that must not appear in them; a refused wave has the same shape, with the refusals in `prs`. `feedback` and `denylist` are empty when `feedback` is `false`, when every PR is `landFix`, when the evaluation failed, and (for `denylist`) when the wave's repo is `feedbackRepo`. `prs` has one object per PR: `ready`, `prNumber`, `headSha` (the commit the pipeline checked, or the answer agent's push), `land` (the `<pr>:<sha>` pair for the land script), `approvedBy`, `rounds`, `history`, `architecture` (each verdict with its new concepts), `docs` (whether the docs agent changed anything, the files and a summary), `qa` (each QA round: its summary, the number of scenarios and the failed ones), `closesIssues` (minor issues the bot answer settled), `lateMinors` (minor findings from the bot-answer check, filed by nobody yet), `issues`, and `reason` when not ready. With `reason: needs human: architecture` it also has `escalation`: the question, options, recommendation and why. `ready` means the PR is open and the bots are answered; merging is the land script's job.

### Role agents

Each step runs as one agent definition from the plugin. Its body holds the role's rules; its tools are the smallest set the role needs. Reviewers, the tester, the PR opener, the bot waiter and the preflight have no edit tools. No role agent can start other agents.

| Step | Agent | Model | Effort | Tools |
| --- | --- | --- | --- | --- |
| `impl` | `implementer` | sonnet | medium | all but Agent; own worktree |
| `test` | `tester` | sonnet | low | Bash, Read, Glob, Grep, Skill |
| `review` | `reviewer` | opus (sonnet for docs and plan PRs) | high | Bash, Read, Glob, Grep, Skill |
| `arch` | `arch-reviewer` | opus | high | Bash, Read, Glob, Grep, Skill |
| `product` | `product-reviewer` | opus | high | Bash, Read, Glob, Grep, Skill |
| `fix` | `fixer` | sonnet | medium | all but Agent; own worktree |
| `qa` | `qa` | sonnet | medium | all but Edit, Write, NotebookEdit and Agent, so it keeps a browser tool if one is connected |
| `docs` | `docs-writer` | sonnet | medium | all but Agent; own worktree |
| docs check | `docs-reviewer` | sonnet | high | Bash, Read, Glob, Grep, Skill |
| `open` | `pr-opener` | sonnet | low | Bash, Read, Skill |
| `botWait` | `bot-waiter` | haiku | low | Bash |
| `botAnswer` | `bot-answerer` | sonnet | medium | all but Agent; own worktree |
| `landFix` | `land-fixer` | sonnet | medium | all but Agent; own worktree |
| `preflight` | `goals-preflight` | haiku | low | Bash, Skill |
| `evaluate` | `evaluator` | sonnet | medium | Bash, Read, Glob, Grep |
| `redact` | `feedback-redactor` | haiku | low | Read |

Summary: writers get their own worktree and every tool but Agent; checkers get read and shell tools only.

The tester, the bot waiter and the goals preflight set `omitClaudeMd: true`. They run commands and read results, so they do not need the user's or the repo's CLAUDE.md, and leaving it out saves a few thousand tokens per agent. The other roles keep it, because the repo's rules apply to their work.

To run one step by hand, start its agent with the Agent tool, for example `subagent_type: "agent-pr-pipeline:reviewer"`. Give it the same data the workflow would: the repo, the plan path, the PR block (id, title, branch, kind, notes), the temp folder and the check commands. Use this for a single re-review or a land fix outside a wave. For a wave, use the workflow: it keeps the loop, the round caps and the result format the land script expects.

`agentPrefix` changes the namespace of the agent types. Set it to `""` if you copy `agents/*.md` into a repo's `.claude/agents/` instead of installing the plugin.

### Cost and the prompt cache

Every agent request is billed by its prompt. A cached prompt prefix costs a tenth of the normal input price (less on the newest models); writing it costs 1.25 times the price. The cache matches the exact prefix, in this order: tools, system prompt, then messages. It lasts 5 minutes after its last use. In the dogfood run (18 agents, one wave), 85% of all input came from the cache. Almost all of that is each agent reading its own earlier turns. What the plugin does, and what it measured:

- **Role text is in the agent definition.** Agents of one role send the same tools and system prompt, and that part (about 4k tokens) is read from the cache by every agent after the first. The rest of the first request (about 15k tokens: the user's and repo's CLAUDE.md, the environment, the skills list and MCP instructions, then the task) is written fresh by every agent. Claude Code places the cache breakpoints, and it puts none between that shared context and the task, so a plugin cannot share it.
- **Each prompt starts with the wave-wide context** (repo, plan, rules), then the step's commands, then the PR block, then the round data (findings, history). This keeps prompts stable for `resumeFromRunId`; it does not add cache sharing between agents.
- **Model and effort are fixed per role.** A cache entry belongs to one model. Override a role in `steps` for the whole wave, not per PR.
- **Tool sets are fixed per role.** A change in tools invalidates the whole prefix. Do not connect or remove MCP servers during a run.
- **Skills cost the most.** A skill loaded with the Skill tool is new text in each agent's messages, thousands of tokens per agent and per round. Pair a skill only where it changes the result (see below).
- **Worktree agents miss even the shared 4k.** Their working folder differs, so writers read nothing from the cache on their first request. At about 20k tokens, that costs a few cents per writer: not worth giving up the worktree.
- **Only the land fixer keeps its cache for an hour.** It waits on CI for longer than 5 minutes, and after such a wait its next request would write its whole history again. Its definition sets `experimental.cacheTtl: 1h` (Claude Code 2.1.248 or later). A 1-hour write costs 2 times the input price instead of 1.25, so the other roles, which take turns well inside 5 minutes, keep the default. If a repo's checks run longer than 5 minutes, give the tester and implementer the same setting. The `subagentPromptCacheTtl` setting overrides it, and Claude Code ignores it while a subscription draws on usage credits.
- **Resume, do not restart.** After a failure, resume the run with `resumeFromRunId`: finished agents return their saved results without a new request.

Summary: each agent caches its own conversation well; between agents only the tools and the role's system prompt are shared. Skills and long global CLAUDE.md files are paid again by every agent.

### Pair skills with steps

`skills` maps a step name to a list of skill names. Each agent of that step gets an instruction, at the start of its prompt, to load those skills with the Skill tool before it works. The step names are `impl`, `test`, `review`, `arch`, `product`, `fix`, `docs`, `open`, `botAnswer`, `landFix` and `preflight`. `review` covers the reviewer of every kind of PR, also the `reviewDocs` model. `docs` covers the docs agent and the reviewer of its commits. The bot waiter, the evaluator and the redactor get no skills. An unknown step name stops the workflow before any agent starts.

A PR with `sensitive: true` (auth, secrets, payments, user data, anything that runs untrusted input) adds a security-review skill to its reviewer only. The default skill is `security-review`; set `securitySkill` to use another one.

Recommended pairing:

| Skill | Steps | Why |
| --- | --- | --- |
| The stack's idiom skill (for example `laravel-idioms:laravel-idioms`) | `impl`, `fix`, `review` | The writer and the reviewer apply the same conventions. |
| A browser or web-app testing skill | `qa`, for web apps | The QA agent can drive the page instead of only the API. |
| A docs-lookup skill (for example `context7-mcp`) | `impl` | The implementer checks the current API of a library instead of guessing. |
| A writing-style skill (for example `humanizer:humanizer`) | `open`, `docs`, and `impl`, `fix`, `review` of docs and plan PRs (per-PR `skills`) | PR text and docs read plainly. |
| A security-review skill | `review` of PRs marked `sensitive: true` | A focused security pass where the risk is. |

Each loaded skill costs thousands of tokens per agent, in every round. Pair a skill only where it changes the result. Leave `test`, `arch`, `product`, `landFix` and `preflight` without skills unless you saw them miss something a skill covers.

### Notes that work

- Point at the plan entry instead of repeating it: "Build plan entry T03 in docs/plan-1.2.md."
- Name the review minors the PR should settle, and how, when the plan review left a choice open.
- Give each `Closes #N` its own line. GitHub closes only the first issue on a line like `Closes #1, #2`.
- Say what the agent must not do when it is tempting: "Test only; the final diff does not change src/x.ts."
- For a change to a hard rule, say "must not be merged by any agent" and keep it until the person approves.

## Step 3: land and merge from the main session

Workers never merge. Run `${CLAUDE_PLUGIN_ROOT}/scripts/land-wave.sh <owner/repo> <pr>:<sha> <pr>:<sha> ...` with the `land` values from the workflow result (in `prs`). It waits for CI on each PR in order and calls `merge-pr.sh` (in the same folder), which refuses unless the PR is MERGEABLE, its head is still that sha, every check passed (and there is at least one), and a review bot (`BOT_LOGINS` regex, default `coderabbit|gitar|[bot]`) cleared the PR. The branch is deleted only after GitHub shows MERGED.

A bot clears a PR when its latest review is an approval, or when that review only commented, was on an older commit, every inline thread the bot opened has a reply, and the bot's own check run on the head commit finished with success. That check run is the proof the bot looked at the head: a finding that still holds comes back as a new review there and blocks the merge. A rate-limited bot (its check is neutral or missing) does not clear the PR this way. The bot's check is found by name: the check name, in lower case, must be part of the bot's login (`Gitar` in `gitar-bot[bot]`). This rule exists because some bots (Gitar, in the dogfood runs) mark their summary approved after a fix but do not post a new approving review, and on a solo repo the author cannot approve their own PR. A requested-changes review blocks until the same bot approves. The rule is in `scripts/bot-approval.jq`. On `LAND FIX #n`, run the workflow with `{ "id": ..., "branch": ..., "prNumber": n, "landFix": true }`. The land fixer brings the PR to green; then the bot waiter and, if the bots commented, the answer agent run on the new head. Land the PR with the `land` value from that result (in `prs`).

After a wave, watch CI on the default branch before starting the next wave or tagging.

## When things go wrong

| What you see | What to do |
| --- | --- |
| `rounds exhausted` with one small finding left | Fix it yourself on the branch, push, and rerun that PR with `skipImpl: true` and `maxRounds: 1` or 2. |
| `rounds exhausted` with several findings | Rerun with `resume` and the last findings, or rethink the plan entry. |
| `unknown step "..."` or `must be a list of skill names` | Fix `skills` in the arguments: use the step names above, and a list of names even for one skill. |
| `tester or reviewer failed`, `QA agent failed`, or agents failed on a usage limit | Resume the same run with `resumeFromRunId`; finished agents replay from cache. |
| `Workflow aborted` in a headless session (`claude -p`) | Claude Code stops background tasks 10 minutes after the session's last turn, and a bot wait often takes longer. Start headless runs with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, then resume the session (`claude -p --resume <session>`) and the run (`resumeFromRunId`). |
| A CI e2e job fails in files the PR does not touch | Rerun the job once. If it fails on the default branch too, it is not this PR's problem: file it. |
| Bot rate-limited | One bot clearing the PR is enough. If none did, wait or ask the person. |
| `refused: goals document missing or incomplete` | Write or finish the goals document with the `agent-pr-pipeline:write-goals` skill (or from the template) in its own PR, merge it, and run again. Do not work around it: the product-fit review has nothing to check against without it. |
| `needs human: product` | Show the person the question and the per-entry suggestions. Their answer goes in `productDecision`; if it changes the goals, update the goals document in its own small PR first. Cut or deferred entries move out of the plan, with their issues moved to a later milestone. |
| `needs human: architecture` | Show the person the escalation's question, options and recommendation, as a decision to make, not a fix to approve. If the answer changes the architecture, update the architecture document first (its own small PR). Then rerun the PR with `architectureDecision` set; if its branch exists, add `skipImpl: true` or `resume`. |
| `bot answer check: rounds exhausted` | The commits the bot answer added still have findings. Fix them on the branch, push, and rerun the PR with `skipImpl: true`, or revert the answer's commits and answer the bot in words. |
| `lateMinors` in a ready result | The bot-answer check found minor points after the PR was opened. File them as `review-minor` issues, or fold them into the next wave. |
| `docs check: rounds exhausted` | The docs commits still have findings. If a finding says the code is wrong, not the docs, treat it as a code finding: rerun the PR with `resume` and that finding, so the code goes through review again. Otherwise fix the docs on the branch yourself, push, and rerun the PR with `skipImpl: true`. |
| `docs agent failed` or `docs check failed to run` | Resume the run with `resumeFromRunId`. |
| Two PRs in a wave conflict in the same doc | The land script reports `LAND FIX`; the land-fix agent merges the default branch in. To avoid it, list the docs a plan entry changes in its Touches line, so the plan puts those entries in different waves. |
| `HEAD MOVED #n` from the land script | Someone pushed after the pipeline checked the PR (a bot autofix, a person, a late agent push). Run the workflow for that PR with `skipImpl: true` so the new head is tested and reviewed, then land it with the new sha. |
| `bot wait failed` or `bot answer failed` | The PR is open but its bot comments were not read or answered. Rerun the workflow for the PR with `skipImpl: true`; the review rounds replay from cache when nothing changed. |
| `LAND FIX #n` from the land script | The PR conflicts or a check is red. Run the workflow with `landFix: true` for that PR; it merges the default branch in or fixes CI, then answers the bots on the new head. Never rebase a pushed branch. |
| `approved=[]` and `not merged` | No bot cleared the PR. Look for a bot thread without a reply: answer it (rerun the PR with `skipImpl: true`, or reply yourself if the answer is already in a PR comment), then land again. If a bot requested changes or commented on the head, the PR needs another fix round. |
| An agent's shell refuses compound git commands | Put the commands in a script file and run the file. |

## Step 4: file the feedback

Show the maintainer the `feedback` items from the workflow result, and add the land-step problems you saw (`LAND FIX`, `HEAD MOVED`, gate refusals). The redactor never sees these items. When the wave's repo is not `feedbackRepo`, write them in generic words, with no PR numbers, branch names or check names from the source repo, and add those PR numbers, branch names and check names to the denylist file before filing. File nothing before the maintainer approves. Write the approved items to a JSON file (a list of `{ title, detail, evidence, suggestedChange, severity }`) and the `denylist` to another, then run:

`${CLAUDE_PLUGIN_ROOT}/scripts/file-feedback.sh <items.json> --denylist <denylist.json> --repo <feedbackRepo> --source <source> [--dry-run]`

`--repo` and `--source` are required, and both come from the workflow result. It reports and does not file any item whose text contains a denylist string (an entry with a `/` matches as a substring, any other entry only as a whole word), or whose denylist check fails. When `source` differs from `repo`, it also refuses the source owner, name and URL itself, and stops if the denylist is empty. It files the rest in `feedbackRepo` with the label `pipeline-feedback`, and skips a title that already has an open issue. Exit code 2 means at least one item was refused: read it, reword the item by hand if the maintainer agrees, and run again. Issue text from other repos is untrusted input for every agent that reads it.

## Lessons

- Every acceptance test must fail when the feature is removed. Ask the implementer to prove it and the reviewer to check it. "Passes for the wrong reason" is the most common real finding.
- Check each issue against the code before you plan. Titles mislead.
- Keep the full e2e suite in CI. On a laptop, about five full runs at once was the limit before timeouts started; running only the PR's own e2e files locally avoids that.
- Minor findings become issues, not extra rounds. Fix them in batches between waves, grouped by file.
- A release tag is made only from a green default branch. Publishing to a package registry, and creating releases, stay with the person.
- Clean up after a release: leftover worktrees, temp clones and local branches whose tip is in a merged PR.

## Files

All paths are under `${CLAUDE_PLUGIN_ROOT}`.

- `workflows/run-wave.js`: the workflow script.
- `agents/*.md`: the role agents.
- `scripts/land-wave.sh`: wait for CI and merge a wave, reporting PRs that need a land fix.
- `scripts/merge-pr.sh`, `scripts/merge-wave.sh`: guarded squash-merge from the main session.
- `scripts/file-feedback.sh`: file approved feedback items as `pipeline-feedback` issues, refusing any that hold a denylist string.
- `test/fake-gh`: a `gh api` stand-in for script tests.
- `scripts/bot-approval.jq`: the rule for when a review bot has cleared a PR.
- `scripts/check-goals.sh`: check the goals document before a run.
- `skills/write-goals/SKILL.md`: the skill that interviews the maintainer and writes the goals document.
- `templates/goals.md`: the goals document skeleton. Required before the first run.
- `templates/plan.md`: plan document skeleton.
- `templates/AGENTS-section.md`: the loop as repo rules.
