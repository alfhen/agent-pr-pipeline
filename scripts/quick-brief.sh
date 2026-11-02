#!/bin/bash
# Usage: quick-brief.sh get <owner/repo> <issue>
#        quick-brief.sh put <owner/repo> <issue> <entry-file>
# The quick-fix brief is one issue comment that starts with MARKER and was written by the account from GET /user.
# get prints the entry (without the marker line). It exits 1 when there is no brief and 2 when two exist.
# put posts the entry once. When a trusted brief exists already it posts nothing and prints that one.
set -uo pipefail
MARKER='<!-- pipeline:quick-brief -->'
PREFIX='<!-- pipeline:quick-brief'
here=$(cd "$(dirname "$0")" && pwd)
mode=${1:-}; repo=${2:-}; issue=${3:-}
usage() { echo "usage: quick-brief.sh get|put <owner/repo> <issue> [entry-file]" >&2; exit 64; }
if [ -z "$repo" ] || ! [[ "$issue" =~ ^[0-9]+$ ]]; then usage; fi

user=$(gh api user --jq .login) || { echo "quick-brief: cannot read GET /user" >&2; exit 3; }
[ -n "$user" ] || { echo "quick-brief: GET /user returned no login" >&2; exit 3; }
pages=$(gh api --paginate --slurp "repos/$repo/issues/$issue/comments") || { echo "quick-brief: cannot read the comments of issue $issue" >&2; exit 3; }
body=$(printf '%s' "$pages" | jq 'add // []' | jq -r --arg prefix "$PREFIX" --arg user "$user" -f "$here/trusted-comment.jq")
if [ $? -ne 0 ]; then echo "quick-brief: more than one trusted brief on issue $issue" >&2; exit 2; fi
[ -n "$body" ] || { echo "quick-brief: the comments of issue $issue are not valid JSON" >&2; exit 3; }

strip() { printf '%s\n' "$1" | tail -n +2; }

case "$mode" in
  get)
    if [ "$body" = null ]; then echo "quick-brief: no trusted brief on issue $issue" >&2; exit 1; fi
    strip "$body" ;;
  put)
    entry=${4:-}
    [ -f "$entry" ] || usage
    if [ "$body" != null ]; then strip "$body"; exit 0; fi
    gh api --method POST "repos/$repo/issues/$issue/comments" -f body="$MARKER
$(cat "$entry")" >/dev/null || { echo "quick-brief: could not post the brief" >&2; exit 3; }
    cat "$entry" ;;
  *) usage ;;
esac
