#!/bin/bash
# usage: filemap.sh <owner/repo> <plan file> <entry id> <cache folder> <clone folder>
# Prints one JSON line {"cache"} with the absolute cache folder, then for each file named in backticks on the Touches line
# of the plan entry that exists at the head of a shallow clone of the default branch, one line {"file","blob","map","present"}.
# Writes only into the cache folder and the clone folder, and never deletes the clone folder (cleanup.sh clones does).
# FILEMAP_REMOTE: a local path used in place of the GitHub URL, for tests.
R=$1; plan=$2; id=$3; cache=$4; clone=$5
[ -n "$clone" ] || { echo "usage: filemap.sh <owner/repo> <plan file> <entry id> <cache folder> <clone folder>" >&2; exit 2; }
fail() { echo "filemap: $1" >&2; exit 1; }
json() { local s=${1//\\/\\\\}; printf '%s' "${s//\"/\\\"}"; }

case "$cache" in
  "~/"*)
    [ -n "$HOME" ] || fail "no home folder"
    cache="$HOME/${cache#\~/}" ;;
  /*) ;;
  *) fail "cache folder must be absolute" ;;
esac
mkdir -p "$cache" 2>/dev/null && [ -d "$cache" ] || fail "cannot create $cache"

if [ ! -d "$clone" ]; then
  remote=${FILEMAP_REMOTE:-https://github.com/$R.git}
  # git ignores --depth for a plain local path
  case "$remote" in /*) remote="file://$remote" ;; esac
  mkdir -p "$(dirname "$clone")" || fail "cannot create $clone"
  git clone --quiet --depth 1 "$remote" "$clone" || fail "cannot clone $R"
fi

[ -f "$clone/$plan" ] || fail "no plan file $plan"
grep -qF "**$id " "$clone/$plan" || fail "no entry $id"
touches=$(awk -v id="$id" '
  index($0, "**" id " ") == 1 { inside = 1; next }
  inside && (/^\*\*/ || /^#/) { exit }
  inside && /^Touches:/ { print; exit }
' "$clone/$plan")

find "$cache" -maxdepth 1 -type f -name '*@*.md' -mtime +30 -delete 2>/dev/null

printf '{"cache":"%s"}\n' "$(json "$cache")"
seen=$'\n'
while IFS= read -r tok; do
  path=${tok#\`}; path=${path%\`}
  [ -n "$path" ] || continue
  case "$seen" in *$'\n'"$path"$'\n'*) continue ;; esac
  seen+="$path"$'\n'
  [ "$(git -C "$clone" cat-file -t "HEAD:$path" 2>/dev/null)" = blob ] || continue
  blob=$(git -C "$clone" rev-parse "HEAD:$path") || continue
  map="$cache/${path//\//%2F}@$blob.md"
  present=false
  [ -s "$map" ] && present=true
  printf '{"file":"%s","blob":"%s","map":"%s","present":%s}\n' "$(json "$path")" "$blob" "$(json "$map")" "$present"
done < <(printf '%s\n' "$touches" | grep -o '`[^`]*`')
exit 0
