#!/bin/bash
# Usage: [PIPELINE_IO_TMP=<dir>] io.sh <script.sh> <args>...
# Runs one script from this folder between two marker lines, so the workflow reads the exit code from the text and not from an agent's words.
# Output over IO_LIMIT bytes goes to a new file in PIPELINE_IO_TMP, and the answer names the file. The Bash tool of Claude Code returns
# at most 30000 characters inline and saves the rest where the exit line is lost, so the answer must stay under that.
set -uo pipefail
IO_LIMIT=25000
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
size=$(printf '%s' "$out" | wc -c | tr -d ' ')
if [ "$size" -gt "$IO_LIMIT" ]; then
  file=""
  if [ -n "${PIPELINE_IO_TMP:-}" ]; then
    file=$(mktemp "$PIPELINE_IO_TMP/io-large.XXXXXX" 2>/dev/null) || file=""
  fi
  if [ -n "$file" ] && printf '%s\n' "$out" > "$file" 2>/dev/null; then
    echo "pipeline-io: large output, $size bytes, saved at $file"
  else
    echo "pipeline-io: could not write the output file: $size bytes were lost (PIPELINE_IO_TMP is unset or not writable)"
    [ "$code" -ne 0 ] || code=70
  fi
else
  [ -z "$out" ] || printf '%s\n' "$out"
fi
echo "pipeline-io: exit $code"
exit "$code"
