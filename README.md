# agent-pr-pipeline

A Claude Code plugin for building a release as a series of small PRs. Separate role agents implement, test from a clean clone, review adversarially, fix, update the docs, open the PR and answer the review bots. The main session merges a PR that passed the path gate and the merge-safety agent. The maintainer merges every other PR, including every rerun.

It grew out of building [Tagreeve](https://github.com/alfhen/tagreeve) (first called Pingwright) 0.1 to 0.4 this way: more than 150 PRs, each one through the same loop.

## What is in it

- **Skills.** `pr-pipeline` runs the loop: plan, waves, land and merge. `write-goals` interviews the maintainer and writes the product goals document that the pipeline needs before its first run.
- **Role agents.** `implementer`, `tester`, `reviewer`, `qa`, `arch-reviewer`, `product-reviewer`, `fixer`, `docs-writer`, `docs-reviewer`, `pr-opener`, `bot-waiter`, `bot-answerer`, `land-fixer`, `merge-safety`, `goals-preflight`, `triager`, `pipeline-io`, `evaluator` and `feedback-redactor`. Each has its own rules, model, effort and the smallest tool set its role needs.
- **Workflow.** `run-wave` runs one wave of PRs through the loop with the role agents.
- **Scripts and templates.** The land and merge scripts, `gate-files.sh`, `bot-status.sh`, `wait-bots.sh`, `quick-brief.sh`, `io.sh`, `cleanup.sh`, `check-version.sh`, `scripts/release.sh`, the goals check, `scripts/file-feedback.sh`, and the plan, goals, `AGENTS.md` and `pipeline.json` templates.

## Install

The repo is its own plugin marketplace. You need `gh` signed in, with git using it (`gh auth setup-git`), because the repo is private.

For yourself:

```bash
claude plugin marketplace add alfhen/agent-pr-pipeline
claude plugin install agent-pr-pipeline@agent-pr-pipeline
```

In a session, `/plugin marketplace add alfhen/agent-pr-pipeline` and `/plugin install agent-pr-pipeline@agent-pr-pipeline` do the same.

On Claude Code 2.1.275 or later, one step also works: `/plugin install agent-pr-pipeline --marketplace alfhen/agent-pr-pipeline`.

For a team repo, add this to the repo's `.claude/settings.json`. Claude Code offers the plugin to each person who trusts the folder. If someone does not get it, they run the install command above with `--scope project`.

```json
{
  "extraKnownMarketplaces": {
    "agent-pr-pipeline": { "source": { "source": "github", "repo": "alfhen/agent-pr-pipeline" } }
  },
  "enabledPlugins": { "agent-pr-pipeline@agent-pr-pipeline": true }
}
```

Updates: `claude plugin update agent-pr-pipeline@agent-pr-pipeline`. A new version reaches users when `version` in `.claude-plugin/plugin.json` changes.

## Before the first run in a repo

Run `/agent-pr-pipeline:write-goals`. It asks you for the product's goals, non-goals and users, writes the goals document (for example `docs/goals.md`) and checks it. Merge it in its own PR. The pipeline refuses to start without it.

Then copy `templates/pipeline.json` to `.github/pipeline.json` and add the paths the repo wants gated. Without the file, `gate-files.sh` uses the plugin's default gates, and `release.sh` refuses because `autoRelease` is not true. `knownFlakes` in the same file lists check names that may fail for reasons outside a PR. `land-wave.sh` reruns the failed jobs of only those checks, once.

## Use

Ask Claude Code to plan and build a release or a set of issues with the pipeline. It will:

1. triage the issues against the code,
2. write a plan with waves, Touches and Acceptance lines, and put the plan through review,
3. run each wave with the `run-wave` workflow. A single issue can skip the plan with the `quick` option: a triager agent first decides `build`, `plan` or `decline`, and a build of size L or risk high becomes a plan. A small, low-risk build gets lighter checks,
4. land the ready PRs with `scripts/land-wave.sh`.
   - It merges only the commit the pipeline checked, with green CI and a review bot's approval (or its comments answered and nothing new raised).
   - First a script checks the changed files against the gated paths. The merge-safety agent then decides `safe` or `person` for the rest.
   - The land value from the workflow ends in `:auto` only for a PR that passed both. Only a `:auto` PR is merged by an agent.
   - A PR with an untested item (a check a permission check refused, or a QA scenario that did not run) never gets `:auto`. Its body lists the items, and the maintainer runs them before the merge.
   - A rerun PR (land fix, `skipImpl`, resume or decision rerun) skips both checks and never gets `:auto`. The maintainer merges it.
   - Code that a land fix adds is tested and reviewed by other agents before the PR can land.
   - For a merge you asked for in the conversation, the merge scripts take `--person`.
5. show the maintainer the feedback items from the end-of-run evaluation and, after approval, file them with `scripts/file-feedback.sh`. For a wave in another repo, a redactor and a denylist keep that repo's details out of the issues.
6. clean up. When a PR's work ends, a small agent deletes its clones and its finished worktrees, and after the evaluation the rest of the temp folder goes too. `cleanup: false` turns this off, and the result has a `cleanup` field that lists what was removed or kept.

Read [skills/pr-pipeline/SKILL.md](skills/pr-pipeline/SKILL.md) for the loop, the workflow arguments, the role agents, cost and caching, and what to do when a step fails.

## The triage routine

An optional scheduled job triages the open `pipeline-feedback` issues of a repo, with guards that let it read and record but not build or merge. It runs at the installed minutes of each hour (`install.sh --minutes`, default 7). It starts in `observe` mode, which changes nothing on GitHub. Install it with `routine/install.sh <owner/repo>`. See [docs/routine.md](docs/routine.md).

## Needs

- Claude Code with the Workflow tool and `gh` signed in.
- A review bot on the repo, such as CodeRabbit or Gitar. Its approval is the merge gate.
- CI that runs the same checks the agents run, and the full e2e suite.

## Develop

- Load your working copy without installing: `claude --plugin-dir .`
- Check the manifests: `claude plugin validate .` and `claude plugin validate .claude-plugin/plugin.json`
- Simulate the workflow with a fake `agent()`: `node test/sim-pipeline.mjs`. Run it after every change to `workflows/run-wave.js` or `agents/`. Script tests: `node --test test/*.test.mjs`.
- Run the checks in [AGENTS.md](AGENTS.md) before you push. The `ci` workflow runs the same checks on every PR.
- The `ci` workflow also runs `scripts/check-version.sh`. The manifest version must be semantic and, in a PR that changes it, higher than the latest tag.
- The `release` workflow runs when a release is published. It runs the simulation and checks that the manifest version matches the tag.
- `.github/pipeline.json` lists the gated paths of this repo, its `knownFlakes` and `autoRelease`. A PR that touches a gated path is merged by the maintainer, never by an agent. `templates/pipeline.json` is the starting file for another repo.
- `scripts/release.sh` makes a release from the main session after the last wave. It runs only when `autoRelease` is true and its checks pass. The skill lists the checks. It refuses until a tag exists, so the maintainer makes the first release. It never publishes a package: the repo's CI does that.

## Explainer

`docs/explainer.html` explains the loop in plain words, for people who will not run it. It is a page fragment for a host that adds the HTML skeleton.

## License

MIT
