#!/bin/bash
# Usage: install.sh <owner/repo>
# Sets up the guard folder <home>/routine/<owner>-<repo>/ and replaces its plugin/ copy with this plugin.
# <home> is $AGENT_PR_PIPELINE_HOME or ~/.agent-pr-pipeline. It writes the literal repo into the settings and the
# launchd file, creates the file `repo`, and creates `mode` with the word observe when there is none.
# It does not load the launchd job: it prints the command, and the maintainer runs it.
set -euo pipefail

repo=${1:-}
[ $# -eq 1 ] && [[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "usage: install.sh <owner/repo>" >&2; exit 64; }

src=$(cd "$(dirname "$0")/.." && pwd -P)
home=${AGENT_PR_PIPELINE_HOME:-$HOME/.agent-pr-pipeline}
slug=${repo//\//-}
guard="$home/routine/$slug"

mkdir -p "$guard/logs" "$home/work/$slug"
if [ -d "$guard/lock" ]; then echo "install.sh: a run holds $guard/lock; try again when it ends" >&2; exit 1; fi

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
sed -e "s|OWNER/REPO|$lit|g" -e "s|GUARD|$glit|g" -e "s|OWNER-REPO|$slug|g" \
  "$guard/plugin/routine/launchd.plist" > "$guard/launchd.plist"

[ -f "$guard/repo" ] && chmod u+w "$guard/repo"
printf '%s\n' "$repo" > "$guard/repo"
if [ ! -f "$guard/mode" ]; then printf 'observe\n' > "$guard/mode"; fi
chmod a-w "$guard/repo" "$guard/mode"
chmod -R a-w "$guard/plugin"

echo "installed $(jq -r .version "$guard/plugin/.claude-plugin/plugin.json") for $repo in $guard (mode: $(tr -d '[:space:]' < "$guard/mode"))"
echo "To start the hourly job: cp $guard/launchd.plist ~/Library/LaunchAgents/com.agent-pr-pipeline.routine.$slug.plist && launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.agent-pr-pipeline.routine.$slug.plist"
