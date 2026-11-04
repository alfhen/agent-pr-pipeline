#!/bin/bash
# Usage: io.sh <script.sh> <args>...
# Runs one script from this folder between two marker lines, so the workflow reads the exit code from the text and not from an agent's words.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=${1:-}
echo "pipeline-io: begin"
if ! [[ "$name" =~ ^[a-z-]+\.sh$ ]] || [ ! -f "$here/$name" ]; then
  echo "io.sh: no such script: $name" >&2
  echo "pipeline-io: exit 64"
  exit 64
fi
shift
out=$(bash "$here/$name" "$@" 2>&1)
code=$?
[ -z "$out" ] || printf '%s\n' "$out"
echo "pipeline-io: exit $code"
exit "$code"
