#!/bin/bash
# usage: file-feedback.sh <feedback.json> --denylist <denylist.json> --repo <owner/name> --source <owner/name> [--dry-run]
# Files each feedback item as an issue with the label pipeline-feedback in --repo. --source is the repo the
# wave ran in. When it differs from --repo, the script itself also refuses the source owner, name, owner/name
# and URL, and refuses to run with an empty denylist. <feedback.json> is a list of { title, detail, evidence, suggestedChange, severity };
# <denylist.json> is a list of strings. An item whose text contains a denylist string (any case) is reported
# as REFUSED and never filed. An entry matches as a substring, except a short or generic entry without a /
# (under 4 characters, or a common word such as docs or README.md), which matches as a whole word: it needs a
# non-alphanumeric neighbour on each side where it ends in a letter or digit. So a bare PR number "123" does
# not catch "PR123"; add "#123". The source owner and name follow the same rule; the source owner/name and URL
# always match as substrings. A title that already has an open pipeline-feedback issue is skipped.
# Exit: 0 all done, 1 error, 2 at least one item refused. Uses gh api REST calls only.
set -u
file=""; deny=""; repo=""; source=""; dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --denylist) deny=$2; shift 2 ;;
    --repo) repo=$2; shift 2 ;;
    --source) source=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -*) echo "unknown option $1"; exit 1 ;;
    *) file=$1; shift ;;
  esac
done
[ -n "$file" ] && [ -n "$deny" ] && [ -n "$repo" ] && [ -n "$source" ] || { echo "usage: file-feedback.sh <feedback.json> --denylist <denylist.json> --repo <owner/name> --source <owner/name> [--dry-run]"; exit 1; }
slug='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
[[ $repo =~ $slug ]] && [[ $source =~ $slug ]] || { echo "--repo and --source must be owner/name"; exit 1; }
jq -e 'type == "array"' "$file" >/dev/null 2>&1 || { echo "$file is not a JSON list"; exit 1; }
jq -e 'type == "array" and all(.[]; type == "string")' "$deny" >/dev/null 2>&1 || { echo "$deny is not a JSON list of strings"; exit 1; }

# Strings the script refuses whatever the denylist file holds. A short or generic entry without a / would refuse
# nearly every item as a substring (a repo named api, a file named README.md), so it matches as a whole word.
classify='def generic: ["docs","test","tests","core","main","site","tool","tools","build","utils","common","readme.md","package.json","license","changelog.md","makefile","dockerfile"];
  def word: (contains("/") | not) and (length < 4 or (ascii_downcase | IN(generic[])));'
deny_all=$(jq -c "$classify"' {subs: [.[] | select(word | not)], words: [.[] | select(word)]}' "$deny")
if [ "$(tr 'A-Z' 'a-z' <<<"$source")" != "$(tr 'A-Z' 'a-z' <<<"$repo")" ]; then
  [ "$(jq length "$deny")" -gt 0 ] || { echo "$deny is empty but the source repo $source differs from $repo"; exit 1; }
  deny_all=$(jq -c --arg s "$source" "$classify"' ([.[]] + [($s | split("/")[0]), ($s | split("/")[1])]) as $all
    | {subs: ([$all[] | select(word | not)] + [$s, "https://github.com/\($s)"]), words: [$all[] | select(word)]}' "$deny")
fi

# Fail closed: without the list of open issues, a duplicate could be filed.
open=$(gh api --paginate --slurp "repos/$repo/issues?state=open&labels=pipeline-feedback&per_page=100") || { echo "cannot list open issues in $repo"; exit 1; }
titles=$(jq -c '[add // [] | .[] | select(has("pull_request") | not) | .title | ascii_downcase | gsub("^\\s+|\\s+$"; "")]' <<<"$open") || exit 1

status=0
seen='[]'
count=$(jq length "$file")
for ((i = 0; i < count; i++)); do
  item=$(jq -c ".[$i]" "$file")
  title=$(jq -r '.title // ""' <<<"$item")
  [ -n "$title" ] || { echo "REFUSED item $i: no title"; [ "$status" = 0 ] && status=2; continue; }
  hit=$(jq -r --argjson deny "$deny_all" '[.. | strings] | join("\n") | ascii_downcase as $text
    | def edge($c): $c | test("[a-z0-9]");
      def pat: . as $d | (if edge($d[0:1]) then "(^|[^a-z0-9])" else "" end) + gsub("(?<c>[^a-z0-9])"; "\\" + .c) + (if edge($d[-1:]) then "($|[^a-z0-9])" else "" end);
      [($deny.subs[] | select(length > 0) | ascii_downcase | select(. as $d | $text | contains($d))),
       ($deny.words[] | select(length > 0) | ascii_downcase | select(. as $d | $text | test($d | pat)))] | first // empty' <<<"$item") || { echo "REFUSED $title: denylist check failed"; [ "$status" = 0 ] && status=2; continue; }
  if [ -n "$hit" ]; then
    echo "REFUSED $title: contains \"$hit\""
    [ "$status" = 0 ] && status=2
    continue
  fi
  key=$(jq -r 'ascii_downcase | gsub("^\\s+|\\s+$"; "")' <<<"$(jq -Rn --arg t "$title" '$t')")
  if jq -e --arg k "$key" 'index($k) != null' <<<"$titles" >/dev/null || jq -e --arg k "$key" 'index($k) != null' <<<"$seen" >/dev/null; then
    echo "SKIP duplicate: $title"
    continue
  fi
  seen=$(jq -c --arg k "$key" '. + [$k]' <<<"$seen")
  body=$(jq -r '"Severity: \(.severity // "unrated")\n\n\(.detail // "")\n\nEvidence: \(.evidence // "none")\n\nSuggested change: \(.suggestedChange // "none")\n\nFiled by the end-of-run evaluation."' <<<"$item")
  if [ "$dry" = 1 ]; then
    echo "WOULD FILE $title [pipeline-feedback] in $repo"
    continue
  fi
  url=$(gh api --method POST "repos/$repo/issues" -f "title=$title" -f "body=$body" -f "labels[]=pipeline-feedback" --jq .html_url) || { echo "FAILED $title"; status=1; continue; }
  echo "FILED $title $url"
done
exit $status
