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
# always match as substrings. A title that already has an open pipeline-feedback issue is skipped. A title that
# matches only a closed one is filed with a line "Seen before in #<n> (closed)".
# Exit: 0 all done, 1 error, 2 at least one item refused. Uses gh api REST calls only.
#
# --auto (0.8.0) adds the quality bar (evidence, suggestedChange and a known severity), the limits in the settings of
# --repo (feedbackItems per call; feedbackPerDay new issues in 24 hours, over that an item is HELD), and a body that
# ends with <!-- pipeline:auto-filed --> and "Source: this repo" or "Source: another repo"; a "Seen before" line can follow. Forms of the collect path:
#   --auto --outbox <source repo> <run> [--dups <file>] --repo <feedbackRepo>
#       files the open outbox <run> of <source repo>, whole or not at all, then records feedback-filed
#   --auto --dups <file> <feedback.json> ...   <file> is a list of { item, issue }: one "Seen again" comment on that open issue
#   --auto --drop-old --repo <feedbackRepo>    drops the open outboxes older than 7 days (of --repo and its collectFrom repos)
#   --auto --check <feedback.json> ...         prints OK, DROP or REFUSED per item and calls nothing
# These forms print "paused <repo>" and write nothing for a paused repo, and print WOULD lines at stage 0.
# With --outbox: exit 65 when the run is not an open outbox or may not be filed; refused items are counted, not an error.
set -u
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
file=""; deny=""; repo=""; source=""; dry=0; auto=0; check=0; dropold=0; dups=""; outbox_src=""; outbox_run=""
while [ $# -gt 0 ]; do
  case "$1" in
    --denylist) deny=$2; shift 2 ;;
    --repo) repo=$2; shift 2 ;;
    --source) source=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    --auto) auto=1; shift ;;
    --check) check=1; shift ;;
    --drop-old) dropold=1; shift ;;
    --dups) [ $# -ge 2 ] || { echo "--dups needs a file"; exit 1; }; dups=$2; shift 2 ;;
    --outbox) [ $# -ge 3 ] || { echo "--outbox needs a source repo and a run"; exit 1; }; outbox_src=$2; outbox_run=$3; shift 3 ;;
    -*) echo "unknown option $1"; exit 1 ;;
    *) file=$1; shift ;;
  esac
done
slug='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
usage="usage: file-feedback.sh <feedback.json> --denylist <denylist.json> --repo <owner/name> --source <owner/name> [--dry-run]"
collect=0
if [ "$auto" = 0 ]; then
  [ "$check$dropold" = 00 ] && [ -z "$dups$outbox_src" ] || { echo "--check, --drop-old, --dups and --outbox need --auto"; exit 1; }
else
  [ -n "$outbox_src" ] || [ -n "$dups" ] || [ "$dropold" = 1 ] && collect=1
  [ -z "$outbox_src" ] || [ "$dropold" = 0 ] || { echo "--outbox and --drop-old do not go together"; exit 1; }
fi
if [ "$collect" = 1 ]; then
  [[ $repo =~ $slug ]] || { echo "--repo must be owner/name"; exit 1; }
  [ -z "$outbox_src" ] || { [[ $outbox_src =~ $slug ]] && [[ $outbox_run =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]]; } || { echo "--outbox needs owner/name and a run like 20261105T120000Z-0a1b2c3d"; exit 1; }
  [ -z "$outbox_src" ] || source=$outbox_src
  if [ -z "$outbox_src" ] && [ "$dropold" = 0 ]; then
    [ -n "$file" ] && [ -n "$deny" ] && [ -n "$source" ] || { echo "$usage"; exit 1; }
  fi
elif [ "$dropold" = 1 ]; then :
else
  [ -n "$file" ] && [ -n "$deny" ] && [ -n "$repo" ] && [ -n "$source" ] || { echo "$usage"; exit 1; }
fi
[ -z "$dups" ] || jq -e 'type == "array" and all(.[]; type == "object" and (.item | type == "number" and . == floor and . >= 0) and (.issue | type == "number" and . == floor and . >= 1))' "$dups" >/dev/null 2>&1 \
  || { echo "$dups is not a JSON list of { item, issue }"; exit 1; }

tmp=""; cleanup() { [ -z "$tmp" ] || rm -rf "$tmp"; }
trap cleanup EXIT
fail() { echo "$*" >&2; exit 1; }

# Settings, pause and stage of a repo come from the same scripts as the routine uses.
RS="$here/routine-state.sh"
CONFIG="$here/../routine/config.jq"
gate_of() { # repo -> prints "paused", "init needed" or "stage <n>"
  bash "$RS" "$1" gate 2>/dev/null || fail "cannot read the state of $1"
}
settings_of() { # repo -> prints the checked routine object, or null
  local raw checked
  raw=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$1/contents/.github/pipeline.json") || fail "cannot read .github/pipeline.json in $1"
  checked=$(jq -c --arg form pipeline -f "$CONFIG" <<<"$raw" 2>/dev/null) || fail "bad .github/pipeline.json in $1"
  jq -c '.routine' <<<"$checked"
}
stop_unless_running() { # repo -> sets GSTAGE, or prints why not and exits 0
  local g
  g=$(gate_of "$1") || exit 1
  case "$g" in
    paused) echo "paused $1"; exit 0 ;;
    "init needed") echo "init needed $1"; exit 0 ;;
    "stage "*) GSTAGE=${g#stage } ;;
    *) fail "unexpected gate answer for $1" ;;
  esac
}

stage0=0
if [ "$collect" = 1 ]; then
  GSTAGE=1; stop_unless_running "$repo"
  [ "$GSTAGE" != 0 ] || stage0=1
fi

if [ "$dropold" = 1 ]; then
  cfg=$(settings_of "$repo") || exit 1
  srcs=$(jq -r --arg r "$repo" '[$r] + (.collectFrom // []) | unique | .[]' <<<"$cfg") || exit 1
  status=0
  for src in $srcs; do
    GSTAGE=1; g=$(gate_of "$src") || exit 1
    case "$g" in
      paused|"init needed") echo "paused $src"; continue ;;
      "stage "*) sstage=${g#stage } ;;
    esac
    list=$(bash "$RS" "$src" list outboxes) || { echo "cannot list the outboxes of $src"; status=1; continue; }
    for run in $(jq -r 'select(.ageSeconds > 604800) | .run' <<<"$list"); do
      if [ "$stage0" = 1 ] || [ "$sstage" = 0 ]; then echo "WOULD drop $run"; continue; fi
      bash "$RS" "$src" put feedback-dropped "$run" >/dev/null || { echo "FAILED drop $run"; status=1; continue; }
      echo "DROPPED $run"
    done
  done
  exit $status
fi

if [ -n "$outbox_src" ]; then
  tmp=$(mktemp -d) || fail "cannot make a temporary folder"
  GSTAGE=1; stop_unless_running "$source"
  [ "$GSTAGE" != 0 ] || stage0=1
  box=$(bash "$RS" "$source" get outbox "$outbox_run" 2>"$tmp/err"); rc=$?
  if [ "$rc" != 0 ]; then
    cat "$tmp/err"
    [ "$rc" = 65 ] && exit 65
    exit 1
  fi
  jq -e --arg s "$source" --arg r "$repo" '.source == $s and (.feedbackRepo | ascii_downcase) == ($r | ascii_downcase)
    and (.items | type == "array") and (.denylist | type == "array" and all(.[]; type == "string"))' <<<"$box" >/dev/null 2>&1 \
    || { echo "outbox $outbox_run does not belong to $source and $repo"; exit 65; }
  jq -c '.items' <<<"$box" > "$tmp/items.json"; jq -c '.denylist' <<<"$box" > "$tmp/deny.json"
  file="$tmp/items.json"; deny="$tmp/deny.json"
  if [ "$(tr 'A-Z' 'a-z' <<<"$source")" != "$(tr 'A-Z' 'a-z' <<<"$repo")" ] && [ "$(jq length "$deny")" = 0 ]; then
    echo "outbox $outbox_run has an empty denylist but its source differs from $repo"; exit 65
  fi
fi

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


deny_hit() { # item-json -> prints the first denylist string the item holds, or nothing; fails when the check fails
  jq -r --argjson deny "$deny_all" '[.. | strings] | join("\n") | ascii_downcase as $text
    | def edge($c): $c | test("[a-z0-9]");
      def pat: . as $d | (if edge($d[0:1]) then "(^|[^a-z0-9])" else "" end) + gsub("(?<c>[^a-z0-9])"; "\\" + .c) + (if edge($d[-1:]) then "($|[^a-z0-9])" else "" end);
      [($deny.subs[] | select(length > 0) | ascii_downcase | select(. as $d | $text | contains($d))),
       ($deny.words[] | select(length > 0) | ascii_downcase | select(. as $d | $text | test($d | pat)))] | first // empty' <<<"$1"
}

# Every field the body prints must be a string: deny_hit reads strings only, and jq prints any other type
# (an object prints its keys) into the issue.
text_fields_ok() { # item-json
  jq -e 'type == "object" and (.title == null or (.title | type == "string")) and all(.detail, .evidence, .suggestedChange, .severity; . == null or type == "string")' <<<"$1" >/dev/null 2>&1
}

# The title check comes before the type check so a missing title keeps its "no title" refusal for any item shape.
item_title() { # item-json
  jq -r 'try (.title // "") catch ""' <<<"$1" 2>/dev/null
}

# Sets J_KIND to ok, drop or refused, and J_MSG. The quality bar and the marker check are for --auto only.
judge() { # item-json
  local title hit
  J_KIND=ok; J_MSG=""
  title=$(item_title "$1")
  [ -n "$title" ] || { J_KIND=refused; J_MSG="no title"; return; }
  text_fields_ok "$1" || { J_KIND=refused; J_MSG="a field is not a string"; return; }
  if [ "$auto" = 1 ]; then
    J_MSG=$(jq -r 'def filled: type == "string" and (gsub("\\s"; "") | length) > 0;
      if (.evidence | filled | not) then "no evidence"
      elif (.suggestedChange | filled | not) then "no suggested change"
      elif ((.severity | type) != "string" or (.severity | IN("blocker", "major", "minor") | not)) then "unknown severity"
      else empty end' <<<"$1") || { J_KIND=drop; J_MSG="quality check failed"; return; }
    [ -z "$J_MSG" ] || { J_KIND=drop; return; }
  fi
  hit=$(deny_hit "$1") || { J_KIND=refused; J_MSG="denylist check failed"; return; }
  if [ -n "$hit" ]; then J_KIND=refused; J_MSG="contains \"$hit\""; return; fi
  if [ "$auto" = 1 ] && jq -e '[.. | strings] | any(contains("<!--"))' <<<"$1" >/dev/null; then
    J_KIND=refused; J_MSG="holds a comment marker"
  fi
  return 0
}

count=$(jq length "$file")

if [ "$check" = 1 ]; then
  for ((i = 0; i < count; i++)); do
    judge "$(jq -c ".[$i]" "$file")"
    case "$J_KIND" in ok) echo "OK $i" ;; drop) echo "DROP $i: $J_MSG" ;; *) echo "REFUSED $i: $J_MSG" ;; esac
  done
  exit 0
fi

# Fail closed: without the list of open issues, a duplicate could be filed.
open=$(gh api --paginate --slurp "repos/$repo/issues?state=open&labels=pipeline-feedback&per_page=100") || { echo "cannot list open issues in $repo"; exit 1; }
titles=$(jq -c '[add // [] | .[] | select(has("pull_request") | not) | .title | ascii_downcase | gsub("^\\s+|\\s+$"; "")]' <<<"$open") || exit 1
# The closed list only adds a line, so a failed read does not hold the filing.
closed=$(gh api --paginate --slurp "repos/$repo/issues?state=closed&labels=pipeline-feedback&per_page=100") || { echo "cannot list closed issues in $repo: no Seen before lines"; closed='[]'; }
closed_map=$(jq -c '[add // [] | .[] | select(has("pull_request") | not) | {key: (.title | ascii_downcase | gsub("^\\s+|\\s+$"; "")), n: .number}] | sort_by(.n) | map({(.key): .n}) | add // {}' <<<"$closed") || exit 1
seen_before() { jq -r --arg k "$1" '.[$k] // empty | "Seen before in #\(.) (closed)"' <<<"$closed_map"; }

status=0
seen='[]'

if [ "$auto" = 0 ]; then
  for ((i = 0; i < count; i++)); do
    item=$(jq -c ".[$i]" "$file")
    title=$(jq -r '.title // ""' <<<"$item")
    [ -n "$title" ] || { echo "REFUSED item $i: no title"; [ "$status" = 0 ] && status=2; continue; }
    text_fields_ok "$item" || { echo "REFUSED item $i: a field is not a string"; [ "$status" = 0 ] && status=2; continue; }
    hit=$(deny_hit "$item") || { echo "REFUSED $title: denylist check failed"; [ "$status" = 0 ] && status=2; continue; }
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
    before=$(seen_before "$key")
    [ -z "$before" ] || body="$body

$before"
    if [ "$dry" = 1 ]; then
      echo "WOULD FILE $title [pipeline-feedback] in $repo"
      [ -z "$before" ] || echo "$before"
      continue
    fi
    url=$(gh api --method POST "repos/$repo/issues" -f "title=$title" -f "body=$body" -f "labels[]=pipeline-feedback" --jq .html_url) || { echo "FAILED $title"; status=1; continue; }
    echo "FILED $title $url"
  done
  exit $status
fi

# ---- --auto ----
AUTO_MARK='<!-- pipeline:auto-filed -->'
cfg=$(settings_of "$repo") || exit 1
[ "$cfg" != null ] || cfg=$(jq -nc -f "$CONFIG" | jq -c '.routine') || fail "cannot read the default limits"
items_max=$(jq -r '.limits.feedbackItems' <<<"$cfg"); per_day=$(jq -r '.limits.feedbackPerDay' <<<"$cfg")
[[ $items_max =~ ^[0-9]+$ ]] && [[ $per_day =~ ^[0-9]+$ ]] || fail "the feedback limits of $repo are not numbers"
me=$(gh api user --jq .login) || fail "cannot read GET /user"
[ -n "$me" ] || fail "GET /user returned no login"
all=$(gh api --paginate --slurp "repos/$repo/issues?state=all&labels=pipeline-feedback&per_page=100") || fail "cannot list the pipeline-feedback issues of $repo"
mine=$(jq -c --arg me "$me" '[add // [] | .[] | select((has("pull_request") | not) and .user.login == $me)]' <<<"$all") || fail "cannot read the pipeline-feedback issues of $repo"
recent=$(jq -r --arg m "$AUTO_MARK" '[.[] | select((.body // "") | contains($m)) | select((try (.created_at | fromdateiso8601) catch 0) > now - 86400)] | length' <<<"$mine") || exit 1
open_numbers=$(jq -c '[add // [] | .[] | select(has("pull_request") | not) | .number]' <<<"$open") || exit 1
[ "$(tr 'A-Z' 'a-z' <<<"$source")" = "$(tr 'A-Z' 'a-z' <<<"$repo")" ] && srckind="this repo" || srckind="another repo"
[ "$stage0" = 1 ] && dry=1

# Plan every item first, so an outbox is filed whole or not at all.
act=(); target=(); kept=0; refused=0; marker_hits=0
for ((i = 0; i < count; i++)); do
  item=$(jq -c ".[$i]" "$file")
  title=$(item_title "$item")
  judge "$item"
  if [ "$J_KIND" != ok ]; then
    echo "REFUSED $title: $J_MSG"
    act[i]=refused; refused=$((refused + 1))
    [ -z "$outbox_src" ] && status=2
    continue
  fi
  kept=$((kept + 1))
  if [ "$kept" -gt "$items_max" ]; then
    echo "DROPPED over the limit of $items_max items: $title"
    act[i]=refused; refused=$((refused + 1)); continue
  fi
  omark=""
  [ -z "$outbox_src" ] || omark="<!-- pipeline:outbox $outbox_run:$i -->"
  dup_issue=""
  [ -z "$dups" ] || dup_issue=$(jq -r --argjson i "$i" --argjson open "$open_numbers" '[.[] | select(.item == $i and (.issue as $n | $open | index($n) != null))][0].issue // empty' "$dups")
  key=$(jq -r 'ascii_downcase | gsub("^\\s+|\\s+$"; "")' <<<"$(jq -Rn --arg t "$title" '$t')")
  if [ -n "$dup_issue" ]; then
    act[i]=comment; target[i]=$dup_issue
  elif [ -n "$omark" ] && jq -e --arg m "$omark" 'any(.[]; (.body // "") | contains($m))' <<<"$mine" >/dev/null; then
    echo "SKIP already filed: $title"
    act[i]=filed
  elif jq -e --arg k "$key" 'index($k) != null' <<<"$titles" >/dev/null || jq -e --arg k "$key" 'index($k) != null' <<<"$seen" >/dev/null; then
    echo "SKIP duplicate: $title"
    act[i]=skip
  else
    seen=$(jq -c --arg k "$key" '. + [$k]' <<<"$seen")
    act[i]=file
  fi
done

tofile=0
for ((i = 0; i < count; i++)); do [ "${act[i]:-}" = file ] && tofile=$((tofile + 1)); done
if [ -n "$outbox_src" ] && [ "$tofile" -gt 0 ] && [ $((recent + tofile)) -gt "$per_day" ]; then
  echo "HELD outbox $outbox_run: $tofile new issues, $recent filed in the last 24 hours, limit $per_day"
  exit 0
fi

filed=0; seen_again=0; created=0
for ((i = 0; i < count; i++)); do
  item=$(jq -c ".[$i]" "$file")
  title=$(item_title "$item")
  omark=""
  [ -z "$outbox_src" ] || omark="<!-- pipeline:outbox $outbox_run:$i -->"
  case "${act[i]:-}" in
    filed) filed=$((filed + 1)) ;;
    comment)
      n=${target[i]}
      text="Seen again in a wave ($srckind): $title"
      if [ "$dry" = 1 ]; then echo "WOULD comment $n"; seen_again=$((seen_again + 1)); continue; fi
      if [ -n "$omark" ]; then
        prior=$(gh api --paginate --slurp "repos/$repo/issues/$n/comments?per_page=100") || { echo "FAILED comment $n"; status=1; continue; }
        if jq -e --arg me "$me" --arg m "$omark" '[add // [] | .[] | select(.user.login == $me and ((.body // "") | contains($m)))] | length > 0' <<<"$prior" >/dev/null; then
          echo "SKIP already commented: $title"; seen_again=$((seen_again + 1)); continue
        fi
        text="$text
$omark"
      fi
      gh api --method POST "repos/$repo/issues/$n/comments" -f "body=$text" >/dev/null || { echo "FAILED comment $n"; status=1; continue; }
      echo "COMMENTED $n $title"; seen_again=$((seen_again + 1)) ;;
    file)
      if [ -z "$outbox_src" ] && [ $((recent + created)) -ge "$per_day" ]; then echo "HELD $title"; continue; fi
      key=$(jq -r 'ascii_downcase | gsub("^\\s+|\\s+$"; "")' <<<"$(jq -Rn --arg t "$title" '$t')")
      before=$(seen_before "$key")
      if [ "$dry" = 1 ]; then echo "WOULD file $title"; [ -z "$before" ] || echo "$before"; created=$((created + 1)); filed=$((filed + 1)); continue; fi
      body=$(jq -r --arg kind "$srckind" --arg mark "$AUTO_MARK" --arg om "$omark" '"Severity: \(.severity)\n\n\(.detail // "")\n\nEvidence: \(.evidence)\n\nSuggested change: \(.suggestedChange)\n\nFiled by the end-of-run evaluation.\n\n\($mark)\n" + (if $om != "" then $om + "\n" else "" end) + "Source: \($kind)"' <<<"$item")
      [ -z "$before" ] || body="$body
$before"
      url=$(gh api --method POST "repos/$repo/issues" -f "title=$title" -f "body=$body" -f "labels[]=pipeline-feedback" --jq .html_url) || { echo "FAILED $title"; status=1; continue; }
      echo "FILED $title $url"; created=$((created + 1)); filed=$((filed + 1)) ;;
  esac
done

if [ -n "$outbox_src" ]; then
  counts=$(jq -nc --argjson f "$filed" --argjson s "$seen_again" --argjson r "$refused" '{filed: $f, seenAgain: $s, refused: $r}')
  [ "$status" = 0 ] || { echo "outbox $outbox_run is not complete; it stays open"; exit 1; }
  if [ "$dry" = 1 ]; then echo "WOULD put feedback-filed $outbox_run"; exit 0; fi
  bash "$RS" "$source" put feedback-filed "$outbox_run" "$counts" >/dev/null || { echo "FAILED to record outbox $outbox_run"; exit 1; }
  echo "RECORDED outbox $outbox_run $counts"
fi
exit $status
