#!/bin/bash
# usage: cloud-setup.sh --print [--latest] [<tag>...] [--repo <owner/repo>]
# Prints the setup script for a Claude Code cloud environment. The printed script needs no file of this repo:
# it fetches each named release from raw.githubusercontent.com, checks every file against the release's
# files.txt, installs it under /opt/agent-pr-pipeline/<tag>/, writes the role agents with a version prefix to
# ~/.claude/agents/, and installs the launcher apl-start. This file is the one place for the install folder,
# the agent name rule and the launcher text. With --latest the printed script also installs each release listed
# in .claude-plugin/releases.txt on the default branch, a protected file, so a new release needs no new paste.
set -u
here=$(cd "$(dirname "$0")" && pwd)
usage() { echo "usage: cloud-setup.sh --print [--latest] [<tag>...] [--repo <owner/repo>]" >&2; exit 2; }

[ "${1:-}" = "--print" ] || usage
shift
tags=(); repo=""; latest=0
while [ $# -gt 0 ]; do
  case "$1" in
    --latest) latest=1; shift ;;
    --repo) [ $# -ge 2 ] || usage; repo=$2; shift 2 ;;
    -*) usage ;;
    *) tags+=("$1"); shift ;;
  esac
done
[ ${#tags[@]} -gt 0 ] || [ "$latest" = 1 ] || usage
for t in "${tags[@]+"${tags[@]}"}"; do
  [[ "$t" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "cloud-setup.sh: refused tag '$t': a tag is v<major>.<minor>.<patch>" >&2; exit 2; }
done
[ -n "$repo" ] || repo=$(bash "$here/plugin-repo.sh") || exit 1
[[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "cloud-setup.sh: refused repo '$repo'" >&2; exit 2; }

# Both the installer and the launcher call this, so the name rule has one text. Only the first name: line of
# the frontmatter changes.
read -r -d '' AGENT_FN <<'EOF' || true
agent_text() {
  awk -v n="$1" '
    fm < 2 && /^---[ \t]*$/ { fm++; print; next }
    fm == 1 && !done && /^name:/ { print "name: " n; done = 1; next }
    { print }' "$2"
}
EOF

read -r -d '' LAUNCHER <<'EOF' || true
#!/bin/bash
# usage: apl-start <owner/repo>
# Run at the start of a routine session, in the clone of the repo. Prints one JSON line
# {version, pluginRoot, agentPrefix, defaultSha}, or APL STOP <reason>, PIN <tag> and ROOT <path|none> with exit 1.
# It writes no record and sends no notice.
set -uo pipefail
ROOT=${APL_ROOT:-/opt/agent-pr-pipeline}
AGENTS=$HOME/.claude/agents
repo=${1:-}
[[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "usage: apl-start <owner/repo>" >&2; exit 2; }
pin=none
AGENT_FN_HERE

# Prints why release <tag> fails its file check and returns 1; prints nothing when every file matches its files.txt.
check_release() {
  local tag=$1 root=$ROOT/$1 manifest paths hashes changed p
  manifest=$root/.claude-plugin/files.txt
  [ -f "$root/.complete" ] || { echo "release $tag is not installed"; return 1; }
  [ -s "$manifest" ] || { echo "files.txt of $tag is missing"; return 1; }
  grep -qvE '^[0-9a-f]{40} [A-Za-z0-9._/-]+$' "$manifest" && { echo "files.txt of $tag has a bad line"; return 1; }
  grep -qE '(^| |/)\.\.(/|$)|^/| /' "$manifest" && { echo "files.txt of $tag has a path outside the release"; return 1; }
  paths=$(awk '{ print $2 }' "$manifest")
  for p in $paths; do [ -f "$root/$p" ] || { echo "file missing from $tag: $p"; return 1; }; done
  hashes=$(cd "$root" && git hash-object --stdin-paths <<<"$paths") || { echo "cannot hash the files of $tag"; return 1; }
  [ "$(wc -l <<<"$hashes")" -eq "$(wc -l <"$manifest")" ] || { echo "cannot hash the files of $tag"; return 1; }
  changed=$(paste -d' ' <(awk '{ print $1 }' "$manifest") <(echo "$hashes") <(echo "$paths") | awk '$1 != $2 { print $3; exit }')
  [ -z "$changed" ] || { echo "file changed in $tag: $changed"; return 1; }
}

# The pin is never offered as ROOT: a stop can be its failed file check, and the prompt runs scripts from ROOT.
# Another release is offered only when it passes the same check, so ROOT is never a tree nobody checked.
highest() {
  local d t
  for d in "$ROOT"/v*; do
    t=${d##*/}
    [ "$t" != "$pin" ] && [[ "$t" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && check_release "$t" >/dev/null && echo "$t"
  done | sort -V | tail -1
}
stop() {
  local h
  h=$(highest)
  echo "APL STOP $1"
  echo "PIN $pin"
  if [ -n "$h" ]; then echo "ROOT $ROOT/$h"; else echo "ROOT none"; fi
  exit 1
}

# The clone can lag the default branch; every later read uses origin/<branch>, so this runs before anything is printed.
git fetch origin >/dev/null 2>&1 || stop "fetch failed"
branch=$(gh api "repos/$repo" --jq .default_branch 2>/dev/null) && [ -n "$branch" ] || stop "cannot read the default branch of $repo"
settings=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$repo/contents/.github/pipeline.json?ref=refs/heads/$branch" 2>/dev/null) \
  || stop "cannot read .github/pipeline.json of $repo"
want=$(jq -r '.routine.pipelineVersion // ""' <<<"$settings" 2>/dev/null)
[[ "$want" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || stop "routine.pipelineVersion is not a release tag"
pin=$want
sha=$(git rev-parse --verify -q "refs/remotes/origin/$branch^{commit}") || stop "no origin/$branch in the clone"

root=$ROOT/$pin
manifest=$root/.claude-plugin/files.txt
reason=$(check_release "$pin") || stop "$reason"

prefix=apl-${pin//./-}-
for p in $(awk '$2 ~ /^agents\/[^\/]+\.md$/ { print $2 }' "$manifest"); do
  name=${p#agents/}; name=${name%.md}
  f=$AGENTS/$prefix$name.md
  [ -f "$f" ] || stop "agent file missing: $prefix$name"
  cmp -s <(agent_text "$prefix$name" "$root/$p") "$f" || stop "agent file changed: $prefix$name"
done

jq -n -c --arg v "$pin" --arg r "$root" --arg p "$prefix" --arg s "$sha" '{version: $v, pluginRoot: $r, agentPrefix: $p, defaultSha: $s}'
EOF

read -r -d '' SETUP_HEAD <<'EOF' || true
#!/bin/bash
# Made by cloud-setup.sh of agent-pr-pipeline. Installs the named releases; any failure exits 1.
set -euo pipefail
umask 022
ROOT=${APL_ROOT:-/opt/agent-pr-pipeline}
BIN=${APL_BIN:-/usr/local/bin}
AGENTS=$HOME/.claude/agents
STAGE=
trap '[ -z "$STAGE" ] || rm -rf "$STAGE"' EXIT
EOF

read -r -d '' SETUP_BODY <<'EOF' || true

RAW=https://raw.githubusercontent.com/$REPO
# refs/tags/ is explicit: a bare name is ambiguous with a branch of the same name.
fetch_one() {
  local sha=$1 path=$2
  [[ "$sha" =~ ^[0-9a-f]{40}$ && "$path" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && "$path" != *..* ]] || { echo "bad manifest line: $sha $path" >&2; exit 1; }
  mkdir -p "$STAGE/$(dirname "$path")"
  curl -fsSL --retry 3 -o "$STAGE/$path" "$RAW/refs/tags/$TAG/$path" || { echo "fetch failed: $path" >&2; exit 1; }
  [ "$(git hash-object "$STAGE/$path")" = "$sha" ] || { echo "hash mismatch: $path" >&2; exit 1; }
}
export -f fetch_one

COUNT=0
# $2 is "listed" or "named". A listed tag whose files.txt gives 404 is a release not cut yet, so it is skipped.
# Every other failure exits 1.
install_tag() {
  TAG=$1
  local mode=$2 code
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad tag: $TAG" >&2; exit 1; }
  local v=${TAG//./-} p name
  mkdir -p "$ROOT" "$AGENTS"
  STAGE=$(mktemp -d "$ROOT/.stage-$TAG.XXXXXX")
  export RAW TAG STAGE
  mkdir -p "$STAGE/.claude-plugin"
  code=$(curl -sSL --retry 3 -o "$STAGE/.claude-plugin/files.txt" -w '%{http_code}' "$RAW/refs/tags/$TAG/.claude-plugin/files.txt") || { echo "fetch failed: files.txt of $TAG" >&2; exit 1; }
  if [ "$code" = 404 ] && [ "$mode" = listed ]; then
    echo "skipped $TAG: files.txt gives 404, the release is not cut yet"
    rm -rf "$STAGE"; STAGE=
    return 0
  fi
  [ "$code" = 200 ] || { echo "fetch failed: files.txt of $TAG (HTTP $code)" >&2; exit 1; }
  [ -s "$STAGE/.claude-plugin/files.txt" ] || { echo "files.txt of $TAG is empty" >&2; exit 1; }
  ! grep -qvE '^[0-9a-f]{40} [A-Za-z0-9._/-]+$' "$STAGE/.claude-plugin/files.txt" || { echo "files.txt of $TAG has a bad line" >&2; exit 1; }
  xargs -P 8 -n 2 bash -c 'fetch_one "$0" "$1"' < "$STAGE/.claude-plugin/files.txt" || { echo "fetch or check failed for $TAG" >&2; exit 1; }
  find "$STAGE" -name '*.sh' -exec chmod +x {} +
  chmod 755 "$STAGE"
  rm -rf "${ROOT:?}/$TAG"
  mv "$STAGE" "$ROOT/$TAG"
  STAGE=
  for p in $(awk '$2 ~ /^agents\/[^\/]+\.md$/ { print $2 }' "$ROOT/$TAG/.claude-plugin/files.txt"); do
    name=${p#agents/}; name=${name%.md}
    agent_text "apl-$v-$name" "$ROOT/$TAG/$p" > "$AGENTS/apl-$v-$name.md.new"
    mv "$AGENTS/apl-$v-$name.md.new" "$AGENTS/apl-$v-$name.md"
  done
  : > "$ROOT/$TAG/.complete"
  COUNT=$((COUNT + 1))
}
EOF

read -r -d '' LATEST_FN <<'EOF' || true

# One tag per line, newest first, at most 3, from the protected default branch.
fetch_list() {
  local text
  text=$(curl -fsSL --retry 3 "$RAW/refs/heads/main/.claude-plugin/releases.txt") || { echo "cannot read releases.txt" >&2; exit 1; }
  [ -n "$text" ] || { echo "releases.txt is empty" >&2; exit 1; }
  [ "$(printf '%s\n' "$text" | wc -l)" -le 3 ] || { echo "releases.txt has more than 3 lines" >&2; exit 1; }
  ! printf '%s\n' "$text" | grep -qvE '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "releases.txt has a bad line" >&2; exit 1; }
  printf '%s\n' "$text"
}
EOF

read -r -d '' SETUP_TAIL <<'EOF' || true

mkdir -p "$BIN"
cat > "$BIN/.apl-start.new" <<'APL_START_EOF'
EOF

printf '%s\n' "$SETUP_HEAD"
printf 'REPO=%s\n' "$repo"
printf '%s\n' "$AGENT_FN"
printf '%s\n' "$SETUP_BODY"
named=()
for t in "${tags[@]+"${tags[@]}"}"; do
  case " ${named[*]+"${named[*]}"} " in *" $t "*) ;; *) named+=("$t") ;; esac
done
if [ "$latest" = 1 ]; then
  printf '%s\n' "$LATEST_FN"
  printf 'NAMED="%s"\n' "${named[*]+"${named[*]}"}"
  printf '%s\n' 'LISTED=$(fetch_list) || exit 1' \
    'for tag in $LISTED; do case " $NAMED " in *" $tag "*) ;; *) install_tag "$tag" listed ;; esac; done' \
    'for tag in $NAMED; do install_tag "$tag" named; done' \
    '[ "$COUNT" -gt 0 ] || { echo "no release installed" >&2; exit 1; }'
else
  printf 'for tag in %s; do install_tag "$tag" named; done\n' "${named[*]}"
fi
printf '%s\n' "$SETUP_TAIL"
printf '%s\n' "$LAUNCHER" | FN="$AGENT_FN" awk '$0 == "AGENT_FN_HERE" { print ENVIRON["FN"]; next } { print }'
printf '%s\n' "APL_START_EOF"
printf '%s\n' 'chmod 755 "$BIN/.apl-start.new"' 'mv "$BIN/.apl-start.new" "$BIN/apl-start"'
