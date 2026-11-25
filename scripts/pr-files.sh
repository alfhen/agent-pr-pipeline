#!/bin/bash
# usage: pr-files.sh <owner/repo> <pr>
# Prints the files a PR changes as one JSON array of {filename, previous_filename}, previous_filename only for a rename. This is
# the only place that reads pulls/<n>/files. Exits 1 when the files cannot be read (the reason is on stderr), exit 4 when the list
# has 3000 files or more: GitHub cuts the list there, so it may miss files.
R=$1; pr=$2
[ -n "$pr" ] || { echo "usage: pr-files.sh <owner/repo> <pr>" >&2; exit 2; }
errf=$(mktemp) || { echo "cannot make a temporary file" >&2; exit 1; }
trap 'rm -f "$errf"' EXIT
# gh writes hints on stderr when it succeeds, so stderr is read only to explain a failure.
pages=$(gh api --paginate --slurp "repos/$R/pulls/$pr/files?per_page=100" 2>"$errf") || {
  t="$pages $(cat "$errf")"; t=${t# }; echo "cannot list the changed files (${t% })" >&2; exit 1; }
list=$(jq -c 'if all(.[]; type == "array") then [add // [] | .[] | {filename, previous_filename} | with_entries(select(.value != null))] else error("pages") end' <<<"$pages" 2>/dev/null) \
  || { echo "unexpected answer for the changed files" >&2; exit 1; }
[ "$(jq length <<<"$list")" -lt 3000 ] || { echo "3000 changed files or more, the list may be cut" >&2; exit 4; }
echo "$list"
