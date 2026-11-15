#!/bin/bash
# Usage: role-files.sh <folder of the loaded release> <folder of the workflow release>
# Compares agents/*.md of the two plugin folders byte for byte. Only reads.
# Prints ROLES SAME, ROLES DIFFER <names> or ROLES MISSING <folder> (exit 0), or CHECK FAILED <why> (exit 3).
set -uo pipefail
if [ $# -ne 2 ]; then echo "usage: role-files.sh LOADED_FOLDER WORKFLOW_FOLDER"; exit 2; fi
a=$1 b=$2
if [ ! -d "$a" ]; then echo "ROLES MISSING $a"; exit 0; fi
if [ ! -d "$b/agents" ] || [ ! -r "$b/agents" ]; then echo "CHECK FAILED cannot read $b/agents"; exit 3; fi
if [ "$(cd "$a" && pwd -P)" = "$(cd "$b" && pwd -P)" ]; then echo "CHECK FAILED both folders are the same folder: $a"; exit 3; fi

# Only the release line of goals-preflight.md is left out: it is the one line that must differ between releases.
release_line='^Role files of release [0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.$'
body() {
  if [ "$(basename "$1")" = "goals-preflight.md" ]; then
    grep -v -E "$release_line" "$1"
    # grep ends every line with a newline, so the last byte keeps the compare byte for byte
    tail -c 1 "$1" | od -An -c
  else
    cat "$1"
  fi
}

names=$( { for f in "$a"/agents/*.md "$b"/agents/*.md; do [ -e "$f" ] && basename "$f"; done; } | sort -u)
differ=()
for n in $names; do
  if [ ! -f "$a/agents/$n" ] || [ ! -f "$b/agents/$n" ]; then differ+=("$n"); continue; fi
  cmp -s <(body "$a/agents/$n") <(body "$b/agents/$n") || differ+=("$n")
done
if [ ${#differ[@]} -eq 0 ]; then echo "ROLES SAME"; else echo "ROLES DIFFER ${differ[*]}"; fi
