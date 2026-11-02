# agent-pr-pipeline

A Claude Code skill for building a release as a series of small PRs. Separate agents implement, test from a clean clone, review adversarially, fix, open the PR and answer the review bots. The main session merges.

It grew out of building [Tagreeve](https://github.com/alfhen/tagreeve) (first called Pingwright) 0.1 to 0.4 this way: more than 150 PRs, each one through the same loop.

## Install

Copy the folder into your skills directory:

```bash
git clone https://github.com/alfhen/agent-pr-pipeline.git ~/.claude/skills/agent-pr-pipeline
```

Or, for one project, into `.claude/skills/agent-pr-pipeline` in that repo.

The repo has a second skill, [write-goals](skills/write-goals/SKILL.md). It interviews you and writes the product goals document that the pipeline needs before its first run. Claude Code finds skills only one folder deep, so link it next to the first one:

```bash
ln -s ~/.claude/skills/agent-pr-pipeline/skills/write-goals ~/.claude/skills/write-goals
```

The main skill stays at the repo root, so its paths and the clone command above do not change. `skills/` is also where a Claude Code plugin keeps its skills, so the repo can become a plugin later without moving files.

## Use

Ask Claude Code to plan and build a release or a set of issues with this skill. It will:

1. triage the issues against the code,
2. write a plan with waves, Touches and Acceptance lines, and put the plan through review,
3. run each wave with `workflow/pr-pipeline.js`,
4. merge ready PRs with `scripts/merge-wave.sh` after you can see them.

Read [SKILL.md](SKILL.md) for the loop, the workflow arguments and what to do when a step fails.

## Needs

- Claude Code with the Workflow tool (multi-agent workflows) and `gh` signed in.
- A review bot on the repo, such as CodeRabbit or Gitar. One approval is the merge gate.
- CI that runs the same checks the agents run.

## License

MIT

## Explainer

`docs/explainer.html` explains the loop in plain words, for people who will not run it. It is a page fragment for a host that adds the HTML skeleton.
