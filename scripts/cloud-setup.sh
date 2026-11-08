#!/bin/bash
# usage: cloud-setup.sh --print [--latest <n>] [<tag>...] [--repo <owner/repo>]
# Prints the setup script for a Claude Code cloud environment. The printed script needs no file of this repo:
# it fetches each named release from raw.githubusercontent.com, checks every file against the release's
# files.txt, installs it under /opt/agent-pr-pipeline/<tag>/, writes the role agents with a version prefix to
# ~/.claude/agents/, and installs the launcher apl-start. This file is the one place for the install folder,
# the agent name rule and the launcher text.
# With --latest <n>, the printed script reads the release tags of the repo when it runs and installs the newest n
# (v0.8.0 up to the version in plugin.json on the default branch) plus the named tags.
# Only a named tag can become ROOT of apl-start. A found tag is installed only when its commit is on the default
# branch, and a found tag that fails to install is skipped.
set -u
here=$(cd "$(dirname "$0")" && pwd)
usage() { echo "usage: cloud-setup.sh --print [--latest <n>] [<tag>...] [--repo <owner/repo>]" >&2; exit 2; }

[ "${1:-}" = "--print" ] || usage
shift
tags=(); repo=""; latest=""
while [ $# -gt 0 ]; do
  case "$1" in
    --latest) [ $# -ge 2 ] || usage; latest=$2; shift 2 ;;
    --repo) [ $# -ge 2 ] || usage; repo=$2; shift 2 ;;
    -*) usage ;;
    *) tags+=("$1"); shift ;;
  esac
done
if [ -n "$latest" ]; then
  [[ "$latest" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "cloud-setup.sh: refused --latest '$latest': a count of 1 or more" >&2; exit 2; }
else
  [ ${#tags[@]} -gt 0 ] || usage
fi
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

# Only a release the maintainer named can become ROOT, or anyone who can create a tag could choose the scripts that
# run on a stop. The list is $ROOT/.named-tags, written by the setup script. It must stay outside every release
# folder: a release fills its own folder from its own manifest and could otherwise list itself.
highest() {
  local t
  [ -f "$ROOT/.named-tags" ] || return 0
  while read -r t; do
    [ -f "$ROOT/$t/.complete" ] && [[ "$t" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo "$t"
  done < "$ROOT/.named-tags" | sort -V | tail -1
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
hashes=$(cd "$root" && git hash-object --stdin-paths <<<"$paths") || stop "cannot hash the files of $pin"
[ "$(wc -l <<<"$hashes")" -eq "$(wc -l <"$manifest")" ] || stop "cannot hash the files of $pin"
changed=$(paste -d' ' <(awk '{ print $1 }' "$manifest") <(echo "$hashes") <(echo "$paths") | awk '$1 != $2 { print $3; exit }')
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
# Made by cloud-setup.sh of agent-pr-pipeline. Installs the named releases; any failure exits 1, except a found release that fails, which is skipped.
set -euo pipefail
umask 022
ROOT=${APL_ROOT:-/opt/agent-pr-pipeline}
BIN=${APL_BIN:-/usr/local/bin}
AGENTS=$HOME/.claude/agents
STAGE=
trap '[ -z "$STAGE" ] || rm -rf "$STAGE"; [ -z "${VR:-}" ] || rm -rf "$VR"' EXIT
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

install_tag() {
  TAG=$1
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad tag: $TAG" >&2; exit 1; }
  local v=${TAG//./-} p name
  mkdir -p "$ROOT" "$AGENTS"
  STAGE=$(mktemp -d "$ROOT/.stage-$TAG.XXXXXX")
  export RAW TAG STAGE
  mkdir -p "$STAGE/.claude-plugin"
  curl -fsSL --retry 3 -o "$STAGE/.claude-plugin/files.txt" "$RAW/refs/tags/$TAG/.claude-plugin/files.txt" || { echo "fetch failed: files.txt of $TAG" >&2; exit 1; }
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
}
EOF

# The floor is v0.8.0: older tags have no files.txt. sort -V, not a text sort, so v0.10.0 is above v0.9.0.
# The ceiling is the version in plugin.json on the default branch. Anyone with write access can create a tag on any
# commit, but the default branch is protected, so a tag above the ceiling is not installed. A failed lookup returns
# 1, and the script exits 1.
read -r -d '' RESOLVE <<'EOF' || true

resolve_tags() {
  local out cap
  out=$(git ls-remote --tags --refs "https://github.com/$REPO" 'refs/tags/v*') || { echo "tag lookup failed for $REPO" >&2; return 1; }
  cap=$(curl -fsSL --retry 3 "$RAW/HEAD/.claude-plugin/plugin.json" | jq -r '.version // ""') || cap=
  [[ "$cap" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "cannot read the version of the default branch of $REPO" >&2; return 1; }
  out=$(printf '%s\n' "$out" | awk '{ sub("^refs/tags/", "", $2); print $2 }' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | awk -v c="$cap" 'BEGIN { split(c, a, ".") }
        { split(substr($0, 2), b, ".")
          if (b[1] + 0 == 0 && b[2] + 0 < 8) next
          if (b[1] + 0 != a[1] + 0) { if (b[1] + 0 < a[1] + 0) print; next }
          if (b[2] + 0 != a[2] + 0) { if (b[2] + 0 < a[2] + 0) print; next }
          if (b[3] + 0 <= a[3] + 0) print }' \
    | sort -V | tail -n "$LATEST") || true
  [ -n "$out" ] || { echo "no release tag found for $REPO at or below $cap" >&2; return 1; }
  printf '%s\n' "$out"
}
EOF

# A found tag is installed only when its commit is an ancestor of the default branch, because a tag can be made on
# any commit. This also guards the agent files, which sessions load. The check runs over git, which works for a repo
# that is not attached to the session; the compare API answers 403 there. A check that cannot run exits 1; only a
# tag proven off the branch returns 1.
read -r -d '' VERIFY <<'EOF' || true

VR=
verify_fetch() {
  local t refs=()
  for t in "$@"; do refs+=("+refs/tags/$t:refs/tags/$t"); done
  VR=$(mktemp -d "$ROOT/.verify.XXXXXX") || { echo "cannot make a folder for the ancestry check" >&2; exit 1; }
  git init -q --bare "$VR" && git -C "$VR" fetch -q --no-tags --filter=tree:0 "https://github.com/$REPO" '+HEAD:refs/heads/default' "${refs[@]}" \
    || { echo "cannot fetch the history of $REPO for the ancestry check" >&2; exit 1; }
}
on_default_branch() {
  local rc=0
  git -C "$VR" merge-base --is-ancestor "refs/tags/$1" refs/heads/default || rc=$?
  [ "$rc" -le 1 ] || { echo "ancestry check failed for $1" >&2; exit 1; }
  return "$rc"
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
printf 'NAMED=(%s)\n' "${tags[*]-}"
if [ -n "$latest" ]; then
  printf '%s\n' "$RESOLVE" "$VERIFY"
  printf 'LATEST=%s\n' "$latest"
  printf '%s\n' 'found=$(resolve_tags)' \
    'mkdir -p "$ROOT"' \
    'verify_fetch $found' \
    'for tag in "${NAMED[@]+"${NAMED[@]}"}"; do install_tag "$tag"; done'
else
  printf '%s\n' 'for tag in "${NAMED[@]}"; do install_tag "$tag"; done'
fi
printf '%s\n' 'mkdir -p "$ROOT"' \
  'printf "%s\n" "${NAMED[@]+"${NAMED[@]}"}" > "$ROOT/.named-tags.new"' \
  'mv "$ROOT/.named-tags.new" "$ROOT/.named-tags"'
if [ -n "$latest" ]; then
  printf '%s\n' 'for tag in $found; do' \
    '  case " ${NAMED[*]-} " in *" $tag "*) continue ;; esac' \
    '  if on_default_branch "$tag"; then' \
    '    install_tag "$tag" & wait "$!" || { echo "skipped $tag: install failed" >&2; rm -rf "${ROOT:?}/.stage-$tag".*; }' \
    '  else echo "skipped $tag: not on the default branch" >&2; fi' \
    'done'
fi
printf '%s\n' "$SETUP_TAIL"
printf '%s\n' "$LAUNCHER" | FN="$AGENT_FN" awk '$0 == "AGENT_FN_HERE" { print ENVIRON["FN"]; next } { print }'
printf '%s\n' "APL_START_EOF"
printf '%s\n' 'chmod 755 "$BIN/.apl-start.new"' 'mv "$BIN/.apl-start.new" "$BIN/apl-start"'
