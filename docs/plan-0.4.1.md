# Plan for 0.4.1

0.4.1 fixes how the routine's triager reads the code and how the routine records the triager's reason (#165). The end-to-end test of 0.4.0 showed both: a triager was refused when it listed files, so it decided from the goals file alone, and the session reworded the triager's `why` before it recorded it. The maintainer decided both design questions on 2026-11-03 (see Decisions). One entry, one PR. It is done when its acceptance test passes in CI, an adversarial review reports no blockers or majors, and it is squash-merged.

## Goals this release serves

- Automatic improvement (goal 7): the routine's triage decisions rest on the code, and its records hold the triager's own reason.
- My attention (goal 3): the maintainer reads a record and gets the triager's reasoning, not a summary of it.
- Non-goals it comes close to: none. The routine stays local, read-only apart from `put`, and in the same two modes.

## Findings

| Finding | Issue | What is wrong |
| --- | --- | --- |
| The triager cannot list or search files | #165 | Neither settings file allows Read, Glob or Grep, and Bash is allowed only for the guard-path commands. A triager that lists files with `ls` or `find` is refused, and `dontAsk` gives it no other way. |
| The session rewrites the triager's `why` | #165 | `routine/prompt.md` step 3 says to put the `why` in double quotes with no quote character inside it, so the session shortens or rewords it. `put` itself accepts quotes. |
| Reinstall resets the schedule | (maintainer, 2026-11-03) | `install.sh` writes the plist from `routine/launchd.plist` with minute 7 only. The maintainer runs the routine at minutes 7 and 37 while the queue is long, and every reinstall undoes that. |

## Decisions

- **Read access (maintainer, 2026-11-03): scoped read rules.** Both settings files allow `Read`, `Glob` and `Grep` only inside the work clone, with the absolute-path rule form `Read(//<clone>/**)` (and the same for `Glob` and `Grep`). No Bash listing command (`ls`, `find`) is allowed, because a prefix rule cannot stop `find -delete` or `-exec`.
- **Reason text (maintainer, 2026-11-03): swap only the risky characters.** The session records the triager's `why` word for word, and replaces only `"`, `$`, `` ` `` and `\` (with `'`, `S`, `'` and `/`). The `put` command, its allow rule and its checks do not change.

## Rules for every PR

- Read `AGENTS.md` and `docs/goals.md`.
- Each PR adds checks in a `test/*.test.mjs` file that fail when the change is removed. The PR description says how that was checked.
- Each negative test checks that its input really contains what the check looks for.
- Docs: Simplified Technical English, no em dashes, Mermaid for diagrams with a one-line text summary under each. Code comments only for why or hidden constraints.
- No test, QA case or agent loads the `launchd` job or writes to the real `~/Library/LaunchAgents`. `install.sh` writes its plist under `$HOME`, whatever `AGENT_PR_PIPELINE_HOME` is, so every test and QA run of `install.sh` sets `HOME` to a temp folder too.
- R04 touches `routine/**`, which is a gated path, so the maintainer merges it.

## Wave 1

**R04 Routine triager reads the clone, and the record keeps the triager's words.** Issue: #165. Touches: `routine/settings/observe.json`, `routine/settings/triage.json`, `routine/install.sh`, `routine/launchd.plist`, `routine/prompt.md`, `test/routine-guard.test.mjs`, `docs/routine.md`.
- **Read rules.** Both settings files get `Read(//CLONE/**)`, `Glob(//CLONE/**)` and `Grep(//CLONE/**)` in `allow`. `install.sh` fills `CLONE` with the work clone's real path without the leading `/` (it sets `clone=$(cd "$guard/../.." && pwd -P)/work/<slug>/clone` from the resolved guard, exactly the `run.sh` method, so the rule is the same string as the `{{clone}}` that `run.sh` puts in the prompt), in the same `sed` step that fills `GUARD`. The rules stay in `allow` only; `deny` keeps Edit, Write, NotebookEdit, Workflow, `Bash(git *)` and the agents.
- **Prompt, step 2.** The triager brief tells it to read and search the clone with the Read, Glob and Grep tools only, never with Bash commands such as `ls`, `find`, `cat` or `grep`, because the routine refuses them.
- **Prompt, step 3.** The `why` goes in double quotes on one line, word for word as the triager returned it, with each `"` replaced by `'`, each `$` by `S`, each `` ` `` by `'` and each `\` by `/`, and with line breaks replaced by spaces. Nothing else is shortened or reworded. `routine-state.sh` does not change.
- **Schedule.** `install.sh` takes an optional `--minutes <list>` (comma-separated minutes, each 0 to 59, default `7`). `routine/launchd.plist` holds a `MINUTES` placeholder that `install.sh` fills with one `StartCalendarInterval` dict per minute. When there is no `--minutes`, `install.sh` reads the minutes of the installed plist before it writes the new one, and keeps them, so a reinstall does not reset the schedule. It reads every `Minute` integer in the file, so it accepts the 0.4.0 form (one dict with minute 7), a hand-edited array with several minutes, and the form it writes itself. If the plist is missing, unreadable or has no minute, the default is 7. `install.sh --print` shows the minutes it would write, kept ones included.
- **Docs.** `docs/routine.md`: the read rules and why Bash listing is not allowed, the `why` rule, and `--minutes`. Update the "launchd, minute 7" node in the One run diagram to name the installed minutes. Remove the "subagent permissions" limit only if the QA log shows the triager's Read, Glob and Grep calls with no refusal; otherwise keep it and say what was seen.
- **Acceptance.** `test/routine-guard.test.mjs`: (1) the existing test that no settings file has a read rule outside the clone changes to: each settings file has `Read`, `Glob` and `Grep` rules, each anchored at `//CLONE/**`, and no other `Read`, `Glob` or `Grep` rule; after an install into a temp home, each rule names the absolute clone path and matches no path outside it, and equals the `{{clone}}` that `run.sh` passes in the prompt. The existing test 'a home reached through a symlink gives a prompt whose command lines match the installed allow rules' also covers the Read, Glob and Grep rules. (2) Both prompts tell the triager to use Read, Glob and Grep and name `ls` and `find` as refused. (3) The triage prompt's step 3 names the four replacements and says nothing else is changed. (4) `install.sh --minutes 7,37` writes two `StartCalendarInterval` entries; a second install with no `--minutes` keeps them; a plist in the 0.4.0 single-dict form with minute 7, installed first, is kept at 7 by a reinstall with no `--minutes`; a hand-edited plist with an array of minutes 7 and 37 keeps both; a missing or unreadable plist gives 7; `--print` shows the kept minutes; `--minutes 60` and `--minutes x` are refused with exit 64. Each part fails when its change is removed.
- **QA.** Install the routine for `alfhen/pipeline-dogfood` from the branch with `HOME` and `AGENT_PR_PIPELINE_HOME` both set to temp folders, open one scratch issue whose decision needs the code, run the guard's `run.sh` once in `triage` mode with the real `HOME` so the `claude` session can authenticate, and check in the log that the triager read files with no refusal and that the stored `why` matches the triager's words apart from the four replacements.

## Out of scope

| What | Why |
| --- | --- |
| Passing the `why` by stdin or an encoding | The maintainer chose the character swap. An encoding needs a new allow rule, and an agent typing a long base64 string broke the quick-brief step four times on 2026-11-03. |
| The quick-brief base64 typing failures | Separate pipeline issue, filed from the 0.4.1 quick waves. |
| Version 0.4.1 and the release | After R04 merges, with the maintainer's go-ahead. |
