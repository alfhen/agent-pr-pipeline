# Goals

A Claude Code plugin that builds a release as small PRs, each checked by separate agents, and merged by the main session. It is primarily for me and the Claude sessions that work with me, on my repos.

## Goals

1. **Self-improvement (most important).** After each pipeline run ends, agents evaluate what worked well and what didn't. They show me the feedback first, then submit it to this repo as issues, with details of the other repo (code, data, names) left out.
2. **Quality.** No agent checks its own work, and no code lands that no other agent checked.
3. **My attention.** I step in only for decisions: scope, architecture, and any merge or tag the safety evaluation does not clear.
4. **Cost.** Fewer tokens per merged PR.
5. **Speed matched to effort.** How fast a PR goes, and how much checking it gets, follows how big or risky the change is. A single quick fix can skip the full plan, but only after a small triage step: an adversarial review checks whether its size and risk allow going straight to build.
6. **Works on all my repos:** laravel-idioms, Tagreeve, Gossamr and the rest, whatever the stack.
7. **Automatic improvement.** A scheduled routine triages the issues the evaluation agents file, plans releases from them and runs those releases through the pipeline. Agents may merge, tag and publish when an evaluation says the build is safe. They publish only where the repo's CI allows automatic releases.

## Non-goals

- **Other agent tools.** It works only with Claude Code, for now.
- **A product for other people.** It isn't one.
- **Replacing CI or the review bots.** It doesn't do that.
- **A hosted service.** It isn't one.

Why: this is a personal tool for me, and I decide how my agents run.

## Users

- **Me.** I decide scope and architecture, approve the evaluation feedback before it becomes issues, and handle any merge, tag or release the safety evaluation does not clear.
- **Claude sessions that work with me.** They plan releases and run waves on my repos.
- **The scheduled routine.** It triages the filed issues, plans releases and runs them through the pipeline.

## How to change this file

Agents may propose changes to this file in a PR of their own. They may clarify wording or add an example. Adding, removing or reversing a goal or non-goal is my decision. I merge every change to this file myself, even where agents may merge other PRs. Plans are checked against this file before anything is built.
