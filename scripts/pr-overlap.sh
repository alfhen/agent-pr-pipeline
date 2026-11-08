#!/bin/bash
# usage: pr-overlap.sh <owner/repo> <pr>
# Warns on a PR when other open PRs change the same files. Prints "none" when no file is shared and posts nothing.
# Otherwise posts one comment that starts with the marker line and prints "posted". When the same account already
# posted a marker comment on the PR it prints "already posted" and posts nothing. Reads only the first 30 open
# PRs and says so when it stops there. Exits 1 when a GitHub call fails.
R=$1; pr=$2
[ -n "$pr" ] || { echo "usage: pr-overlap.sh <owner/repo> <pr>"; exit 2; }
MARKER='<!-- pipeline:overlap -->'
LIMIT=30
SHOWN=5
fail() { echo "pr-overlap: $1" >&2; exit 1; }

tmp=$(mktemp -d) || fail "cannot make a temporary folder"
trap 'rm -rf "$tmp"' EXIT

me=$(gh api user --jq .login) || fail "cannot read the account"
here=$(cd "$(dirname "$0")" && pwd)
gh api --paginate --slurp "repos/$R/issues/$pr/comments?per_page=100" >"$tmp/pages" || fail "cannot read the comments"
jq 'add // []' "$tmp/pages" >"$tmp/comments" || fail "cannot read the comments"
posted=$(jq --arg prefix "$MARKER" --arg user "$me" --arg all 1 -f "$here/trusted-comment.jq" "$tmp/comments") || fail "cannot read the comments"
if [ "$(jq length <<<"$posted")" -gt 0 ]; then
  echo "already posted"
  exit 0
fi

gh api --paginate "repos/$R/pulls/$pr/files?per_page=100" --jq '.[].filename' >"$tmp/mine" || fail "cannot read the files of #$pr"
gh api "repos/$R/pulls?state=open&per_page=$LIMIT" >"$tmp/open" || fail "cannot list the open pull requests"
if [ "$(jq length "$tmp/open")" -ge "$LIMIT" ]; then echo "stopped at the first $LIMIT open pull requests"; fi

: >"$tmp/shared"
for o in $(jq -r --argjson pr "$pr" '.[] | select(.number != $pr) | .number' "$tmp/open"); do
  gh api --paginate "repos/$R/pulls/$o/files?per_page=100" --jq '.[].filename' >"$tmp/o$o" || fail "cannot read the files of #$o"
  grep -Fxf "$tmp/mine" "$tmp/o$o" | sort -u | jq -R -c --argjson o "$o" '{pr: $o, file: .}' >>"$tmp/shared"
done

if [ ! -s "$tmp/shared" ]; then
  echo "none"
  exit 0
fi

jq -s -r --arg marker "$MARKER" --argjson shown "$SHOWN" '
  ($marker + "\nThis PR changes files that other open PRs also change:\n"),
  (group_by(.pr)[] | "- #\(.[0].pr): " + ([.[:$shown][] | "`\(.file)`"] | join(", "))
    + (if length > $shown then " and \(length - $shown) others" else "" end)),
  "\nMerging one of these PRs makes the others conflict. Merge them one at a time."' "$tmp/shared" >"$tmp/body" || fail "cannot build the comment"
gh api -X POST "repos/$R/issues/$pr/comments" -F body=@"$tmp/body" >/dev/null || fail "cannot post the comment"
echo "posted"
