#!/bin/bash
# usage: release.sh [--dry-run] <owner/repo> <version>
# Makes a release through the REST releases API, only when every check passes: autoRelease is true in
# .github/pipeline.json on the default branch, a workflow has a release or tag trigger, the default
# branch is green, a tag exists, every commit since the last tag came from a merged PR with a trusted
# merge-cleared comment for that PR's head (see trusted-comment.jq), and each manifest at the checked sha
# has the release version. In the plugin's own repo, .claude-plugin/files.txt must match the tree (manifest.sh). The main session runs this after the last wave landed. It never publishes a package.
# --dry-run prints each check and the release it would make, and calls no write endpoint.
dry=0
[ "$1" = "--dry-run" ] && { dry=1; shift; }
R=$1; version=${2#v}
[[ "$R" == */* && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || { echo "usage: release.sh [--dry-run] <owner/repo> <version>"; exit 2; }
here=$(dirname "$0")
PREFIX='<!-- pipeline:merge-cleared'
cleared="^$PREFIX (auto|person) ([0-9a-f]{40}) -->\$"
missing=()
ok() { echo "ok: $*"; }
miss() { echo "MISSING: $*"; missing+=("$*"); }
stop() { echo "release.sh: cannot go on: $*"; exit 1; }
is404() { [[ "$1" == *"HTTP 404"* ]]; }

branch=$(gh api "repos/$R" --jq .default_branch 2>&1) || stop "cannot read the default branch ($branch)"
sha=$(gh api "repos/$R/commits/$branch" --jq .sha 2>&1) || stop "cannot read the head of $branch ($sha)"
user=$(gh api user --jq .login 2>&1) || stop "cannot read GET /user ($user)"

settings=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/.github/pipeline.json?ref=refs/heads/$branch" 2>&1)
if [ $? -ne 0 ]; then
  is404 "$settings" && settings='{}' || stop "cannot read .github/pipeline.json ($settings)"
fi
if [ "$(jq -r '.autoRelease == true' <<<"$settings" 2>/dev/null)" = true ]; then ok "autoRelease is true on $branch"
else miss "autoRelease is not true in .github/pipeline.json on $branch"; fi

trigger=""
wf=$(gh api "repos/$R/contents/.github/workflows?ref=refs/heads/$branch" 2>&1)
if [ $? -ne 0 ]; then
  is404 "$wf" || stop "cannot list the workflows ($wf)"
else
  for path in $(jq -r '.[] | select(.name | test("\\.ya?ml$")) | .path' <<<"$wf"); do
    text=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/$path?ref=refs/heads/$branch" 2>&1) || stop "cannot read $path ($text)"
    # Only a release key directly under on, or a tags key directly under push, counts: a workflow_dispatch input may share the name.
    if awk '
      /^(on|"on"|true):/ { f = 1; base = -1; top = ""; rest = $0; sub(/^[^:]*:[ \t]*/, "", rest)
        if (rest ~ /(^|[[{, \t])release($|[]},: \t])/) hit = 1
        next }
      /^[^ \t#]/ { f = 0 }
      f && /^[ \t]*(#|$)/ { next }
      f { match($0, /^[ \t]*/); ind = RLENGTH; key = $0; sub(/^[ \t]*/, "", key); sub(/[ \t]*:.*/, "", key)
        if (base < 0) base = ind
        if (ind == base) { top = key; second = -1; if (key == "release") hit = 1 }
        else if (ind > base && top == "push") { if (second < 0) second = ind; if (ind == second && key == "tags") hit = 1 } }
      END { exit !hit }' <<<"$text"; then trigger=$path; break; fi
  done
fi
if [ -n "$trigger" ]; then ok "$trigger runs on a release or a tag"; else miss "no workflow has a release or tag trigger"; fi

pages=$(gh api --paginate "repos/$R/commits/$sha/check-runs?per_page=100" 2>&1) || stop "cannot read the check runs of ${sha:0:7} ($pages)"
runs=$(jq -s -c '[.[].check_runs[]]' <<<"$pages") || stop "unexpected check runs answer"
spages=$(gh api --paginate "repos/$R/commits/$sha/status?per_page=100" 2>&1) || stop "cannot read the commit statuses of ${sha:0:7} ($spages)"
sts=$(jq -s -c '[.[].statuses[]]' <<<"$spages") || stop "unexpected commit status answer"
red=$(jq -n -r --slurpfile r <(printf '%s' "$runs") --slurpfile s <(printf '%s' "$sts") '$r[0] as $r | $s[0] as $s | if ($r | length) == 0 then "no check runs" else
  ([$r[] | select(.status != "completed" or (.conclusion | IN("success", "skipped", "neutral") | not)) | .name] + [$s[] | select(.state != "success") | .context]) | join(", ") end') \
  || stop "cannot judge the check runs"
if [ -z "$red" ]; then ok "$branch is green at ${sha:0:7}"; else miss "$branch is not green at ${sha:0:7}: $red"; fi

tags=$(gh api "repos/$R/tags?per_page=100" 2>&1) || stop "cannot list the tags ($tags)"
last=$(jq -r '[.[].name | select(test("^v?[0-9]+(\\.[0-9]+)*$"))] | .[]' <<<"$tags" | sort -V | tail -1)
if [ "$(jq -r --arg t "v$version" --arg u "$version" '[.[] | select(.name == $t or .name == $u)] | length' <<<"$tags")" != 0 ]; then
  miss "the tag for $version exists already"
fi
if [ -z "$last" ]; then
  miss "no tag yet: the first release needs the maintainer"
else
  lastsha=$(jq -r --arg t "$last" '.[] | select(.name == $t) | .commit.sha' <<<"$tags")
  cpages=$(gh api --paginate "repos/$R/compare/$lastsha...$sha?per_page=100" 2>&1) || stop "cannot compare $last with ${sha:0:7} ($cpages)"
  commits=$(jq -s -r '[.[].commits[].sha] | .[]' <<<"$cpages") || stop "unexpected compare answer"
  total=$(jq -s -r '.[0].total_commits // 0' <<<"$cpages")
  n=$(grep -c . <<<"$commits")
  if [ "$total" = 0 ]; then miss "nothing to release: no commit since $last"
  elif [ "$n" != "$total" ]; then miss "the commit list since $last is cut ($n of $total)"
  else
    bad=()
    for c in $commits; do
      cp=$(gh api "repos/$R/commits/$c/pulls" 2>&1) || stop "cannot read the pull requests of ${c:0:7} ($cp)"
      read -r num head <<<"$(jq -r --arg c "$c" '[.[] | select(.merged_at != null and .merge_commit_sha == $c)] | if length == 1 then "\(.[0].number) \(.[0].head.sha)" else "" end' <<<"$cp")"
      [ -n "$num" ] || { bad+=("${c:0:7} has no merged PR"); continue; }
      cm=$(gh api --paginate --slurp "repos/$R/issues/$num/comments" 2>&1) || stop "cannot read the comments of #$num ($cm)"
      body=$(jq -c 'add // []' <<<"$cm" | jq -r --arg prefix "$PREFIX" --arg user "$user" -f "$here/trusted-comment.jq" 2>/dev/null) \
        || { bad+=("#$num has two merge-cleared comments"); continue; }
      [[ "$body" =~ $cleared ]] || { bad+=("#$num has no merge-cleared comment by $user"); continue; }
      [ "${BASH_REMATCH[2]}" = "$head" ] || bad+=("#$num: the merge-cleared comment is for ${BASH_REMATCH[2]:0:7}, the merged head is ${head:0:7}")
    done
    if [ ${#bad[@]} -eq 0 ]; then ok "all $n commits since $last came from PRs with a merge-cleared record"
    else for b in "${bad[@]}"; do miss "since $last: $b"; done; fi
  fi
fi

found=0
for file in .claude-plugin/plugin.json package.json composer.json; do
  m=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/$file?ref=$sha" 2>&1)
  if [ $? -ne 0 ]; then is404 "$m" && continue; stop "cannot read $file ($m)"; fi
  found=$((found + 1))
  v=$(jq -r '.version // ""' <<<"$m" 2>/dev/null)
  if [ "${v#v}" = "$version" ]; then ok "$file has version $version"; else miss "$file has version '$v', not $version"; fi
done
[ "$found" -gt 0 ] || miss "no manifest with a version at ${sha:0:7}"

pluginRepo=$(bash "$here/plugin-repo.sh" 2>&1) || stop "cannot read the plugin repo ($pluginRepo)"
if [ "$(tr '[:upper:]' '[:lower:]' <<<"$R")" = "$pluginRepo" ]; then
  ftxt=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/.claude-plugin/files.txt?ref=$sha" 2>&1)
  if [ $? -ne 0 ]; then
    is404 "$ftxt" && stop ".claude-plugin/files.txt is missing at ${sha:0:7}" || stop "cannot read .claude-plugin/files.txt ($ftxt)"
  fi
  tree=$(gh api "repos/$R/git/trees/$sha?recursive=1" 2>&1) || stop "cannot read the tree of ${sha:0:7} ($tree)"
  [ "$(jq -r '.truncated // false' <<<"$tree" 2>/dev/null)" = false ] || stop "the tree of ${sha:0:7} is cut, so the manifest cannot be checked"
  diffs=$(jq -r '.tree[] | select(.type == "blob") | "\(.sha) \(.path)"' <<<"$tree" | bash "$here/manifest.sh" --compare <(printf '%s\n' "$ftxt")) \
    || stop ".claude-plugin/files.txt does not match the tree of ${sha:0:7}: $(tr '\n' ';' <<<"$diffs")"
  ok "files.txt matches the tree at ${sha:0:7}"
  rel=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/.claude-plugin/releases.txt?ref=$sha" 2>&1)
  if [ $? -ne 0 ]; then
    is404 "$rel" && rel="" || stop "cannot read .claude-plugin/releases.txt ($rel)"
  fi
  if [ "$(head -n 1 <<<"$rel")" = "v$version" ]; then ok "releases.txt lists v$version first"
  else miss ".claude-plugin/releases.txt does not start with v$version at ${sha:0:7}"; fi
fi

if [ ${#missing[@]} -gt 0 ]; then echo "release.sh: NOT released: ${#missing[@]} check(s) missing"; exit 1; fi
echo "release: v$version on $R, target ${sha}"
[ "$dry" = 1 ] && { echo "dry run: no release made"; exit 0; }
now=$(gh api "repos/$R/commits/$branch" --jq .sha 2>&1) || stop "cannot read the head of $branch again ($now)"
[ "$now" = "$sha" ] || { echo "release.sh: NOT released: $branch moved from ${sha:0:7} to ${now:0:7} after the checks"; exit 1; }
gh api -X POST "repos/$R/releases" -f tag_name="v$version" -f target_commitish="$sha" -f name="v$version" -F generate_release_notes=true >/dev/null \
  || { echo "release.sh: the releases call failed"; exit 1; }
echo "released v$version at ${sha:0:7}; the repo's CI publishes"
