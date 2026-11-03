#!/bin/bash
# Usage: install.sh [--print] [--minutes <list>] <owner/repo>
# Sets up the guard folder <home>/routine/<owner>-<repo>/ and replaces its plugin/ copy with this plugin.
# <home> is $AGENT_PR_PIPELINE_HOME or ~/.agent-pr-pipeline. It writes the literal repo into the settings and the
# launchd file, creates the file `repo`, and creates `mode` with the word observe when there is none. It opens the
# tracking issue (routine-state.sh init) and writes ~/Library/LaunchAgents/<label>.plist.
# It does not load the launchd job: it prints the commands, and the maintainer runs them.
# --print writes nothing and prints what the install would do.
# --minutes 7,37 sets the minutes of each hour the job starts at (each 0 to 59). Without it the install keeps the
# minutes of the installed plist, or uses 7 when there are none.
set -euo pipefail

print=0; repo=""; minutes=""; given=0; bad=0
while [ $# -gt 0 ]; do
  case "$1" in
    --print) print=1 ;;
    --minutes) if [ $# -ge 2 ]; then minutes=$2; given=1; shift; else bad=1; fi ;;
    *) if [ -z "$repo" ]; then repo=$1; else bad=1; fi ;;
  esac
  shift
done
usage="usage: install.sh [--print] [--minutes <list>] <owner/repo>"
[ $bad = 0 ] && [[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "$usage" >&2; exit 64; }
if [ $given = 1 ]; then
  [[ $minutes =~ ^[0-9]{1,2}(,[0-9]{1,2})*$ ]] || { echo "install.sh: --minutes takes a comma-separated list of minutes from 0 to 59" >&2; exit 64; }
  IFS=, read -ra parts <<< "$minutes"
  for m in "${parts[@]}"; do
    [ $((10#$m)) -le 59 ] || { echo "install.sh: --minutes takes a comma-separated list of minutes from 0 to 59" >&2; exit 64; }
  done
fi

src=$(cd "$(dirname "$0")/.." && pwd -P)
home=${AGENT_PR_PIPELINE_HOME:-$HOME/.agent-pr-pipeline}
slug=${repo//\//-}
guard="$home/routine/$slug"
label="com.agent-pr-pipeline.routine.$slug"
plist="$HOME/Library/LaunchAgents/$label.plist"
load="launchctl bootstrap gui/\$(id -u) $plist"
unload="launchctl bootout gui/\$(id -u)/$label"

if [ $given = 0 ]; then
  # Every Minute integer of the installed plist, so the 0.4.0 form, a hand-edited array and our own form all count.
  minutes=$(cat "$plist" 2>/dev/null | tr '\n' ' ' | grep -oE '<key>Minute</key>[[:space:]]*<integer>[0-9]+</integer>' | grep -oE '[0-9]+</integer>' | grep -oE '^[0-9]+' | while read -r m; do [ $((10#$m)) -le 59 ] && echo $((10#$m)); done | awk '!seen[$0]++' | paste -sd, - || true)
  [ -n "$minutes" ] || minutes=7
fi
minutes=$(printf '%s\n' "$minutes" | tr ',' '\n' | while read -r m; do echo $((10#$m)); done | awk '!seen[$0]++' | paste -sd, -)

if [ $print = 1 ]; then
  echo "would copy the plugin from $src to $guard/plugin"
  echo "would write $guard/repo and, when there is none, $guard/mode with observe"
  echo "would run $src/scripts/routine-state.sh $repo init"
  echo "would write $plist (hourly at minute $minutes)"
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
# run.sh fills its own pwd -P guard path into the prompt; the allow rules must carry the same string.
guard=$(cd "$guard" && pwd -P)
# The same string run.sh puts in the prompt as the clone; the Read rule names it without the leading /.
clone="$(cd "$guard/../.." && pwd -P)/work/$slug/clone"

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
clit=$(printf '%s' "${clone#/}" | sed 's/[&|\\]/\\&/g')
for f in "$guard"/plugin/routine/settings/*.json; do
  sed -i.bak -e "s|OWNER/REPO|$lit|g" -e "s|CLONE|$clit|g" -e "s|GUARD|$glit|g" "$f"; rm -f "$f.bak"
done
# launchd's PATH is short; the job needs the folder that holds claude (the native installer uses ~/.local/bin).
cdir=$(printf '%s' "$claude_dir" | sed 's/[&|\\]/\\&/g')
dicts=""
while read -r m; do dicts+="    <dict><key>Minute</key><integer>$m</integer></dict>"$'\n'; done < <(tr ',' '\n' <<< "$minutes")
dicts=${dicts%$'\n'}
# MINUTES is filled first, so a repo or path that contains the word cannot be changed by it.
tmpl=$(<"$guard/plugin/routine/launchd.plist")
sed -e "s|CLAUDE_DIR|$cdir|g" -e "s|OWNER/REPO|$lit|g" -e "s|GUARD|$glit|g" -e "s|OWNER-REPO|$slug|g" \
  <<< "${tmpl//MINUTES/$dicts}" > "$plist"

[ -f "$guard/repo" ] && chmod u+w "$guard/repo"
printf '%s\n' "$repo" > "$guard/repo"
if [ ! -f "$guard/mode" ]; then printf 'observe\n' > "$guard/mode"; fi
chmod a-w "$guard/repo" "$guard/mode"
chmod -R a-w "$guard/plugin"

echo "installed $(jq -r .version "$guard/plugin/.claude-plugin/plugin.json") for $repo in $guard (mode: $(tr -d '[:space:]' < "$guard/mode"))"
echo "To start the hourly job: $load"
echo "To stop it: $unload"
