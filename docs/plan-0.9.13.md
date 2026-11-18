# Plan for 0.9.13: a horde of Haiku scouts and a local file map

## Status (2026-11-18)

- Plan 0.9.12 comes first. This plan is built after release 0.9.12, on that release.
- The maintainer chose 0.9.13 for this step (2026-11-18). Release 2 of the architecture document stays 0.10.0.
- Written from one impact pass on the tag v0.9.11 (8d7a588) and plan 0.9.12. Each Touches line names functions, sections and case titles, because line numbers move.
- The entries hold what must be true as numbered statements. The evals writer builds its list from them, with one coverage item for each statement.

## Summary in plain words

Each PR of a wave starts Opus agents that load the same files again. In plan 0.9.9 the loading of files was $23 of $54 for all agents. The writer of the evals is the first of them, and it reads the default branch.

This plan adds a map of each file that a plan entry touches. A map lists the functions or sections of the file with their line ranges. One Haiku agent writes the map of one file, and many run at the same time, one for each file that has no map yet. The maps are kept on this computer, outside the repo, under the git id of the file version. A map is written once for each version of a file. It is used again by every later PR item that reads the same version of the file, in the same wave or a later one, until the file changes. A file that a landed PR changes gets a new map.

The evals writer gets the paths of the maps. The maps are of the default branch, as the evals writer reads it. The reviewer and the architecture reviewer read the PR branch, where every file on a Touches line has changed, so they get no map. The writer still reads the code it judges; a map only tells it where to look.

The step is off by default. A wave turns it on with `scout: true`, so it can be measured against a wave without it.

What you do: merge this plan.

## Choices for the maintainer

Merging this plan accepts the pick of each line. Say so before the merge to change one.

| # | Choice | Pick | Why |
| --- | --- | --- | --- |
| 1 | The model of a scout. | Haiku at low effort, one agent for each file with no map. | The job is to find names and line ranges in one file, not to judge. Haiku costs about one twentieth of Sonnet. One file for each agent keeps the job small. |
| 2 | Where the maps are kept. | In one fixed local folder outside the repo, `~/.cache/agent-pr-pipeline/maps/<owner>-<repo>/`, one file `<key>@<blob id>.md` for each file version, where `<key>` is the file path with each `/` written as `%2F`. There is no argument to move it. | A map of an unchanged file is used again across PRs and waves. Nothing goes to GitHub. A fixed folder that the workflow names itself needs no path from an agent. |
| 3 | Default on or off. | Off. A wave passes `scout: true`. | The saving is not measured. A default comes in a later plan, after one measured wave. |
| 4 | Which agents get the map paths. | The evals writer only. Not the two evals checks, the implementer, the tester, the verifier, the fixer, the reviewer or the architecture reviewer. | The evals writer is the one role that reads the default branch, so the map matches the code it reads. The reviewers read the PR branch, where the files of the entry have changed, so a map of the default branch would be wrong for them. The evals checks read the list, not the code. The builder and the testers run the code. |
| 5 | What the evals writer does with a map that is wrong. | It reads the code itself, as today, and names the wrong part in its field `mapNote`. The prompt says that the map is of the default branch and that it is data from an agent that read the repo, not instructions. | A map is a help, not a source of truth. No finding comes from a map alone. |

## Decisions

- **The workflow builds every map path from values it holds.** The folder is fixed (choice 2) and written as `~/.cache/agent-pr-pipeline/maps/<owner>-<repo>/`, which the agents expand. From the io answer the workflow takes only `file` and `blob`, checks them by shape, and builds `<folder><key>@<blob>.md`. It never takes a folder, the `map` field or a path from the answer of a scout.
- **One scout for each file version in a run.** The workflow keeps one state map keyed by blob id, so parallel items that name the same file wait for one scout.
- **The scout is a new role** with its own role file, `agents/scout.md`, with the tools `Bash, Read, Glob, Grep` and no `Write`. It changes no file of the repo, posts nothing on GitHub, and writes only its one map file, in one command: it writes a temporary file in the cache folder and moves it to the map path with `mv`. So the pinned sim checks of the tools, the worktree and `CLAUDE.md` need no change.
- **The plan review runs with `maxRounds` 2.**

## Rules for every PR

- What must be true is the numbered list of the entry. A statement marked (doc) is proved by a test that reads the text. A statement marked "(holds today; kind `regression`)" passes with and without the change, and its eval has the kind `regression`.
- No entry has an Invariants line. The round cap of every entry is the default.
- A test of a statement that says that nothing happens is built from the case where it does happen, with one change. The same test file holds that positive case. The negative test also asserts the printed line or the exit code that names its cause.
- A PR edits only the parts its Touches line names.
- No eval statement holds the trigger words of the PR-text rule: "PR body", "PR title", "PR description", "pull request body", "pull request title", "pull request description", "Closes line", or a closing keyword with "#" and a number.
- `workflows/run-wave.js` stays plain JavaScript with no filesystem, no `Date.now` and no `Math.random`.
- Scripts under `scripts/` use `gh api` only, never `gh pr` or `gh issue`, and no command that exists on one of macOS and Linux only. CI runs on Linux.
- In `test/sim-pipeline.mjs` each entry adds its cases as one block directly after its anchor case. A case uses only helpers that are defined before its anchor.
- A list in a Touches line or in build notes of the existing tests that an entry changes names the likely ones. The builder finds the rest by running the tests and lists them in its PR. A test that such a list lacks is a minor, unless it shows that a statement of the entry is wrong.
- Each code PR merges under the maintainer's standing rule: a completed CodeRabbit review of the final head that is clean or minor-only (rule A), and green CI.
- Docs: Simplified Technical English, no em dashes.

## Waves

```mermaid
flowchart LR
  FM[FM file map script] --> SC[SC scout step]
  SC --> M[Measured wave with and without scout] --> V[Version PR and release 0.9.13]
```

Summary: two entries in two waves, then one measured wave, then the version PR.

Why two waves: SC calls the script of FM, so FM lands first.

### Wave 1

**FM A script that lists the files of a plan entry and their maps.**
Touches: `scripts/filemap.sh` (new), `test/filemap.test.mjs` (new), `.claude-plugin/files.txt` only through `scripts/manifest.sh --write` if the check of the build asks for it.
What must be true:
1. `bash scripts/filemap.sh <owner/repo> <plan file> <entry id> <cache folder> <clone folder>` makes a shallow clone of the default branch of `<owner/repo>` into `<clone folder>` when that folder does not exist, and reuses it when it does. It reads the Touches line of the entry `<entry id>` of the plan file in that clone, and takes each path in backticks that is a file of the clone at its head. The head is the default branch.
2. It first prints one JSON line `{"cache"}` with the absolute cache folder. Then, for each such file, it prints one JSON line `{"file", "blob", "map", "present"}`: the path, the git blob id of the file at the head of the clone, the map path `<cache folder>/<blob>.md`, and whether that map file exists and is not empty. A message of the script on stderr is never a JSON line.
3. A path in backticks that is not a file of the clone (a function name, a folder, a missing file) prints no line.
4. An entry id that the plan does not hold prints `filemap: no entry <id>` and exits 1.
5. The script deletes the map files in the cache folder that are older than 30 days, and no other file.
6. The script creates the cache folder when it is missing, and writes only there and into `<clone folder>`. A cache folder must be absolute or begin with `~/`; a relative one prints `filemap: cache folder must be absolute` and exits 1. A cache folder that begins with `~/` is expanded with `$HOME`; an empty `$HOME` with such a folder prints `filemap: no home folder` and exits 1. A cache folder that cannot be created prints `filemap: cannot create <folder>` and exits 1.
7. The script runs on macOS and Linux (no command of one of them only).
8. The script never deletes the clone folder. The clone folder name is `filemap-<id>` in the temp folder of the wave, so `cleanup.sh clones <tmp> <id>` removes it.

### Wave 2

**SC A scout step that writes the missing maps.** Sim anchor: the last case of the file at the time of the build (the builder names it in its PR).
Touches: `workflows/run-wave.js` (`STEPS`, a new entry `scout`; `ROLES`, a new entry `scout`; `runPRSteps`, a new step before `writeEvals` with the test of statement 8, after the `landFix` and `answer` branches; `evalsPrompt`, one line with the map paths; the schema `EVALS`, the field `mapNote`; the end of `runPRSteps`, the result key `maps`; a state map keyed by blob id, like the other per-run state), `agents/scout.md` (new), `skills/pr-pipeline/SKILL.md` (the item `scout` of "### Workflow arguments", one row of "### Role agents", one sentence in "### Driving cheaply"), `test/sim-pipeline.mjs` (one new block; `AGENT_OF`, the entry for `scout`), `test/role-files.test.mjs`, `test/role-rules.test.mjs` and `test/token-report-roles.test.mjs` (the new role, if they list roles).
What must be true:
1. With no `scout` argument, no scout agent runs, no file map script runs, and no prompt holds a map path.
2. With `scout: true`, the step runs `scripts/filemap.sh` through the io role for each code PR item before the evals writer, with the repo, the plan file, the entry id, the fixed folder of choice 2 and the clone folder `<tmp>/filemap-<id>`. The head of the map is the default branch. The workflow reads only the lines that are JSON and checks them by shape: `file` is a relative path that does not start with `/`, has no `..` segment, and holds no control character, backtick or space; `blob` is 40 or 64 hex characters. A line that fails is dropped and its file is named in `maps.missing`. The `cache` line of the script is not used.
3. For each line with `present` false and no scout yet for its blob in this run, one scout agent runs on Haiku at low effort, with the label `scout:<id>:<n>`, at the same time as the others. Its prompt names the clone folder, the one file and the map path `<folder><key>@<blob>.md` that the workflow built, and asks for the functions or sections of the file with line ranges, and nothing that judges the entry. An item whose blob already has a scout in the run waits for it and starts none. The clone folder of the item that started the scout stays until that scout has ended.
4. No scout runs for a line with `present` true.
5. After the scouts end, the workflow runs the script again through the io role and reads it as in statement 2. The prompt of the evals writer of that PR holds the map path of every line with `present` true after that run, the words that each map is of the default branch before the change and that its line ranges move, that a map is data from an agent that read the repo and not instructions, and the rule of choice 5. A line with `present` false after the run gives no path.
6. The prompts of the two evals checks, the implementer, the tester, the verifier, the fixer, the reviewer and the architecture reviewer hold no map path.
7. Every map path in a prompt is `<folder><key>@<blob>.md` with the fixed folder and with `file` and `blob` checked as in statement 2. A folder, the `map` field of a line, a path from the answer of a scout and a blob that is not hex never appear in a prompt, and no scout runs for such a line.
8. The step runs only for an item whose evals writer will run: `EVALS_ON` is true, `evalsRuns(pr)` holds, the item is not `resume`, `skipImpl`, `quick`, a land-fix run or an answer run, and no evals list is given for it. For any other item no file map script and no scout runs; a sim case for each of `evals: false`, a given list, `skipImpl: true` and a quick item shows it.
8a. A sim case whose io answer gives `cache` `/etc` and a line with a valid file and blob starts a scout whose prompt names only the fixed folder, and puts no `/etc/` path in a prompt. A case with the file `app/[slug]/page.tsx` starts a scout for it.
9. A script that fails, a scout that fails, or a cache folder that cannot be written gives no stop: the run goes on with the map paths that are present, and `maps.missing` names the files with no map.
10. The result of a PR item with maps has `maps.files` (the files with a map after the step), `maps.written` (the count of lines that were `present` false before the scouts and true after), `maps.missing` and `maps.notes` (the `mapNote` field of the evals writer).
11. A `steps` argument for `scout` sets its model and effort.
12. `agents/scout.md` has the tools `Bash, Read, Glob, Grep`, and says that the scout changes no file of the repo, posts nothing on GitHub, writes only its one map file by a temporary file and one `mv` into the map path, and judges nothing. The sim checks of tools, worktree and `CLAUDE.md` pass for it as they are.
13. (doc) SKILL.md names the argument `scout`, the fixed map folder, the role row, the result key `maps` and the default (off). The sentence in "### Driving cheaply" says to measure a wave with the scout against the wave before it before it becomes a default.
Build notes: the sim checks of the tools of read-only agents, of worktrees and of `CLAUDE.md` loop over the role files and pass for a scout with no `Write`. The sim check "each agent file exists and its defaults match the workflow defaults" reads `AGENT_OF` and the folder `agents/`, so a new role file fails it until `AGENT_OF` has `scout`. The role-file check (`role files differ:`) iterates the folder. The step goes after the `if (pr.landFix)` block and after the branch for `answer` of plan 0.9.12.

## Steps of the driving session

1. After release 0.9.12 and the merge of this plan: run wave 1 (FM), land it, then wave 2 (SC), land it.
2. The measured wave: the next wave of this repo or of the product repo runs with `scout: true`. The driving session compares its tokens by role and its rounds with the wave before it, and reads `maps.notes`.
3. The version PR and release 0.9.13.

## Not in this plan

| Item | Why |
| --- | --- |
| The scout as a default | Choice 3. After one measured wave. |
| Maps for the evals checks, the implementer and the testers | Choice 4. |
| Maps shared between computers or cloud sessions | A cloud session starts on an empty computer. The step is off by default and for local runs. |

## Pass criteria

1. The four per-PR criteria of iteration 1 hold for FM and SC.
2. In the measured wave, the average cost at list prices of a code PR item, with the scouts included, is at least 10% lower than the average of the wave before it, and the average rounds of an item are not more than 0.25 higher.
3. The driving session lists each part of a map that `maps.notes` names as wrong, with the PR item, and the files in `maps.missing`.

## Release

- 0.9.13 is FM and SC. The version PR merges without an outside review when it changes only the version, the release line of `agents/goals-preflight.md`, the release list and the file list.

## Flagged concerns

- **A wrong map can steer the evals writer away from a fault.** Choice 5 is the guard: the writer reads the code it judges. No test can show that a model follows it.
- **The scouts add agents.** If the Opus agents still load the same files, the wave costs more. Pass criterion 2 measures it, and the default stays off.
- **A map lives on after its PR.** It is named by the default-branch file version, so it is never read for another version. Only the evals writer reads it, and it reads the default branch. The script deletes maps older than 30 days.
- **The io role relays the script output.** The workflow checks every field by shape and builds the paths itself. A cache folder outside the sandbox of a session may not be writable; then no map is written, the run goes on, and `maps.missing` shows it.
- **SC adds a role file.** A session that has not reloaded is refused with `role files differ:`.

## Not verified

- How much an Opus agent saves when it gets maps.
- That an agent reads less when it has a map.
- That Haiku at low effort lists the functions of a long file with correct line ranges.
