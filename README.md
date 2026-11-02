# agent-pr-pipeline

A Claude Code plugin for building a release as a series of small PRs. Separate role agents implement, test from a clean clone, review adversarially, fix, update the docs, open the PR and answer the review bots. The main session merges.

It grew out of building [Tagreeve](https://github.com/alfhen/tagreeve) (first called Pingwright) 0.1 to 0.4 this way: more than 150 PRs, each one through the same loop.

## What is in it

- **Skills.** `pr-pipeline` runs the loop: plan, waves, land and merge. `write-goals` interviews the maintainer and writes the product goals document that the pipeline needs before its first run.
- **Role agents.** `implementer`, `tester`, `reviewer`, `qa`, `arch-reviewer`, `product-reviewer`, `fixer`, `docs-writer`, `docs-reviewer`, `pr-opener`, `bot-waiter`, `bot-answerer`, `land-fixer`, `goals-preflight`, `evaluator` and `feedback-redactor`. Each has its own rules, model, effort and the smallest tool set its role needs.
- **Workflow.** `run-wave` runs one wave of PRs through the loop with the role agents.
- **Scripts and templates.** The land and merge scripts, the goals check, `scripts/file-feedback.sh`, and the plan, goals and `AGENTS.md` templates.

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

## Use

Ask Claude Code to plan and build a release or a set of issues with the pipeline. It will:

1. triage the issues against the code,
2. write a plan with waves, Touches and Acceptance lines, and put the plan through review,
3. run each wave with the `run-wave` workflow,
4. land the ready PRs with `scripts/land-wave.sh`, which merges only the commit the pipeline checked, with green CI and a review bot's approval (or its comments answered and nothing new raised),
5. show the maintainer the feedback items from the end-of-run evaluation and, after approval, file them with `scripts/file-feedback.sh`. For a wave in another repo, a redactor and a denylist keep that repo's details out of the issues.

Read [skills/pr-pipeline/SKILL.md](skills/pr-pipeline/SKILL.md) for the loop, the workflow arguments, the role agents, cost and caching, and what to do when a step fails.

## Needs

- Claude Code with the Workflow tool and `gh` signed in.
- A review bot on the repo, such as CodeRabbit or Gitar. Its approval is the merge gate.
- CI that runs the same checks the agents run, and the full e2e suite.

## Develop

- Load your working copy without installing: `claude --plugin-dir .`
- Check the manifests: `claude plugin validate .` and `claude plugin validate .claude-plugin/plugin.json`
- Simulate the workflow with a fake `agent()`: `node test/sim-pipeline.mjs`. Run it after every change to `workflows/run-wave.js` or `agents/`. Script tests: `node --test test/*.test.mjs`.
- Run the checks in [AGENTS.md](AGENTS.md) before you push. The `ci` workflow runs the same checks on every PR.
- The `release` workflow runs when a release is published. It runs the simulation and checks that the manifest version matches the tag.
- `.github/pipeline.json` lists the gated paths of this repo. A PR that touches one is merged by the maintainer, never by an agent. `templates/pipeline.json` is the starting file for another repo.

## Explainer

`docs/explainer.html` explains the loop in plain words, for people who will not run it. It is a page fragment for a host that adds the HTML skeleton.

## License

MIT
