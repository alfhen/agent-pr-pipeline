#!/bin/bash
# Usage: install.sh [--print] <owner/repo>
# Sets up the guard folder <home>/routine/<owner>-<repo>/ and replaces its plugin/ copy with this plugin.
# <home> is $AGENT_PR_PIPELINE_HOME or ~/.agent-pr-pipeline. It writes the literal repo into the settings and the
# launchd file, creates the file `repo`, and creates `mode` with the word observe when there is none. It opens the
# tracking issue (routine-state.sh init) and writes ~/Library/LaunchAgents/<label>.plist.
# It does not load the launchd job: it prints the commands, and the maintainer runs them.
# --print writes nothing and prints what the install would do.
set -euo pipefail

print=0; repo=""
for a in "$@"; do
  if [ "$a" = --print ]; then print=1; elif [ -z "$repo" ]; then repo=$a; else repo=""; break; fi
done
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "usage: install.sh [--print] <owner/repo>" >&2; exit 64; }

src=$(cd "$(dirname "$0")/.." && pwd -P)
home=${AGENT_PR_PIPELINE_HOME:-$HOME/.agent-pr-pipeline}
slug=${repo//\//-}
guard="$home/routine/$slug"
label="com.agent-pr-pipeline.routine.$slug"
plist="$HOME/Library/LaunchAgents/$label.plist"
load="launchctl bootstrap gui/\$(id -u) $plist"
unload="launchctl bootout gui/\$(id -u)/$label"

if [ $print = 1 ]; then
  echo "would copy the plugin from $src to $guard/plugin"
  echo "would write $guard/repo and, when there is none, $guard/mode with observe"
  echo "would run $src/scripts/routine-state.sh $repo init"
  echo "would write $plist (hourly at minute 7)"
  echo "To start the hourly job: $load"
  echo "To stop it: $unload"
  exit 0
fi

claude_bin=$(command -v claude || true)
[ -n "$claude_bin" ] || { echo "install.sh: claude is not on PATH; the hourly job could not start a session" >&2; exit 1; }
claude_dir=$(dirname "$claude_bin")

if [ -d "$guard/lock" ]; then echo "install.sh: a run holds $guard/lock; try again when it ends" >&2; exit 1; fi

# init refuses to run from a guard folder, so it runs from the source plugin, and before `repo` exists in the
# guard folder. A failure here changes nothing on disk.
"$src/scripts/routine-state.sh" "$repo" init >/dev/null || { echo "install.sh: routine-state.sh init failed; nothing installed" >&2; exit 1; }

mkdir -p "$guard/logs" "$home/work/$slug" "$HOME/Library/LaunchAgents"

if [ -e "$guard/plugin" ]; then chmod -R u+w "$guard/plugin"; rm -rf "$guard/plugin"; fi
mkdir "$guard/plugin"
for d in .claude-plugin agents skills scripts routine templates workflows; do
  [ -d "$src/$d" ] && cp -R "$src/$d" "$guard/plugin/$d"
done

# The settings name the wrapper and the state script by absolute path: the session's shell can put another gh
# ahead of routine/bin on PATH, so a rule for a bare `gh` would let the real one run.
# Sed replacement text: escape the characters that mean something there.
lit=$(printf '%s' "$repo" | sed 's/[&|\\]/\\&/g')
glit=$(printf '%s' "$guard" | sed 's/[&|\\]/\\&/g')
for f in "$guard"/plugin/routine/settings/*.json; do
  sed -i.bak -e "s|OWNER/REPO|$lit|g" -e "s|GUARD|$glit|g" "$f"; rm -f "$f.bak"
done
# launchd's PATH is short; the job needs the folder that holds claude (the native installer uses ~/.local/bin).
cdir=$(printf '%s' "$claude_dir" | sed 's/[&|\\]/\\&/g')
sed -e "s|CLAUDE_DIR|$cdir|g" -e "s|OWNER/REPO|$lit|g" -e "s|GUARD|$glit|g" -e "s|OWNER-REPO|$slug|g" \
  "$guard/plugin/routine/launchd.plist" > "$plist"

[ -f "$guard/repo" ] && chmod u+w "$guard/repo"
printf '%s\n' "$repo" > "$guard/repo"
if [ ! -f "$guard/mode" ]; then printf 'observe\n' > "$guard/mode"; fi
chmod a-w "$guard/repo" "$guard/mode"
chmod -R a-w "$guard/plugin"

echo "installed $(jq -r .version "$guard/plugin/.claude-plugin/plugin.json") for $repo in $guard (mode: $(tr -d '[:space:]' < "$guard/mode"))"
echo "To start the hourly job: $load"
echo "To stop it: $unload"
