#!/bin/bash
# usage: cloud-setup.sh --print <tag>... [--repo <owner/repo>]
# Prints the setup script for a Claude Code cloud environment. The printed script needs no file of this repo:
# it fetches each named release from raw.githubusercontent.com, checks every file against the release's
# files.txt, installs it under /opt/agent-pr-pipeline/<tag>/, writes the role agents with a version prefix to
# ~/.claude/agents/, and installs the launcher apl-start. This file is the one place for the install folder,
# the agent name rule and the launcher text.
set -u
here=$(cd "$(dirname "$0")" && pwd)
usage() { echo "usage: cloud-setup.sh --print <tag>... [--repo <owner/repo>]" >&2; exit 2; }

[ "${1:-}" = "--print" ] || usage
shift
tags=(); repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || usage; repo=$2; shift 2 ;;
    -*) usage ;;
    *) tags+=("$1"); shift ;;
  esac
done
[ ${#tags[@]} -gt 0 ] || usage
for t in "${tags[@]}"; do
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

highest() {
  local d
  for d in "$ROOT"/v*; do
    [ -f "$d/.complete" ] && [[ "${d##*/}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo "${d##*/}"
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
settings=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$repo/contents/.github/pipeline.json?ref=$branch" 2>/dev/null) \
  || stop "cannot read .github/pipeline.json of $repo"
want=$(jq -r '.routine.pipelineVersion // ""' <<<"$settings" 2>/dev/null)
[[ "$want" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || stop "routine.pipelineVersion is not a release tag"
pin=$want
sha=$(git rev-parse --verify -q "refs/remotes/origin/$branch^{commit}") || stop "no origin/$branch in the clone"

root=$ROOT/$pin
manifest=$root/.claude-plugin/files.txt
[ -f "$root/.complete" ] || stop "release $pin is not installed"
[ -s "$manifest" ] || stop "files.txt of $pin is missing"
grep -qvE '^[0-9a-f]{40} [A-Za-z0-9._/-]+$' "$manifest" && stop "files.txt of $pin has a bad line"
grep -qE '(^| |/)\.\.(/|$)|^/| /' "$manifest" && stop "files.txt of $pin has a path outside the release"
paths=$(awk '{ print $2 }' "$manifest")
for p in $paths; do [ -f "$root/$p" ] || stop "file missing from $pin: $p"; done
changed=$(paste -d' ' <(awk '{ print $1 }' "$manifest") <(cd "$root" && git hash-object --stdin-paths <<<"$paths") <(echo "$paths") | awk '$1 != $2 { print $3; exit }')
[ -z "$changed" ] || stop "file changed in $pin: $changed"

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
fetch_one() {
  local sha=$1 path=$2
  [[ "$sha" =~ ^[0-9a-f]{40}$ && "$path" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && "$path" != *..* ]] || { echo "bad manifest line: $sha $path" >&2; exit 1; }
  mkdir -p "$STAGE/$(dirname "$path")"
  curl -fsSL --retry 3 -o "$STAGE/$path" "$RAW/$TAG/$path" || { echo "fetch failed: $path" >&2; exit 1; }
  [ "$(git hash-object "$STAGE/$path")" = "$sha" ] || { echo "hash mismatch: $path" >&2; exit 1; }
}
export -f fetch_one

install_tag() {
  TAG=$1
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad tag: $TAG" >&2; exit 1; }
  local v=${TAG//./-} p name
  mkdir -p "$ROOT" "$AGENTS"
  STAGE=$(mktemp -d "$ROOT/.stage-$TAG.XXXXXX")
  export RAW TAG STAGE
  mkdir -p "$STAGE/.claude-plugin"
  curl -fsSL --retry 3 -o "$STAGE/.claude-plugin/files.txt" "$RAW/$TAG/.claude-plugin/files.txt"
  [ -s "$STAGE/.claude-plugin/files.txt" ] || { echo "files.txt of $TAG is empty" >&2; exit 1; }
  ! grep -qvE '^[0-9a-f]{40} [A-Za-z0-9._/-]+$' "$STAGE/.claude-plugin/files.txt" || { echo "files.txt of $TAG has a bad line" >&2; exit 1; }
  xargs -P 8 -n 2 bash -c 'fetch_one "$0" "$1"' < "$STAGE/.claude-plugin/files.txt"
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
printf 'for tag in %s; do install_tag "$tag"; done\n' "${tags[*]}"
printf '%s\n' "$SETUP_TAIL"
printf '%s\n' "$LAUNCHER" | FN="$AGENT_FN" awk '$0 == "AGENT_FN_HERE" { print ENVIRON["FN"]; next } { print }'
printf '%s\n' "APL_START_EOF"
printf '%s\n' 'chmod 755 "$BIN/.apl-start.new"' 'mv "$BIN/.apl-start.new" "$BIN/apl-start"'
