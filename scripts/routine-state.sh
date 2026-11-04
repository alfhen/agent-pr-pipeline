#!/bin/bash
# Usage: routine-state.sh <owner/repo> init
#        routine-state.sh <owner/repo> next
#        routine-state.sh <owner/repo> put triaged <issue> <decision> <size> <risk> <why>
# State of the unattended routine: one open issue labelled pipeline-routine, opened by the account from GET /user,
# and one comment on it per triaged issue. A record counts only when scripts/trusted-comment.jq accepts it.
# next prints one JSON line: init needed, triage (open pipeline-feedback issues with no record, or a decline record
# that was not completed, oldest first, at most five) or idle. next exits non-zero on an error.
# put is the one write path of the routine. Every argument is checked here, not in the prompt.
# A build of size L or risk high is stored as plan; workflows/run-wave.js applies the same rule to quick fixes
# and this is the source of the rule until #88 puts both in one place.
# put runs in a guard folder only when its mode file says triage. init never runs in a guard folder.
# Exit: 0 done, 2 two trusted records or tracking issues, 3 a call to GitHub failed, 64 a bad argument,
# 65 refused (issue not eligible, wrong repo or mode).
set -uo pipefail
export LC_ALL=C

# The routine's own gh wrapper is read-only. put and next call the real one.
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/routine/bin$' | paste -sd: -)
export PATH

self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
here=$(cd "$(dirname "$self")" && pwd -P)
guard=$(cd "$here/../.." 2>/dev/null && pwd -P || true)
TRUSTED="$here/trusted-comment.jq"

die() { local code=$1; shift; echo "routine-state: $*" >&2; exit "$code"; }
usage() { die 64 "usage: routine-state.sh <owner/repo> init|next|put triaged <issue> <decision> <size> <risk> <why>"; }

repo=${1:-}; cmd=${2:-}
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
case "$cmd" in
  init|next) [ $# -eq 2 ] || usage ;;
  put) [ $# -eq 8 ] || usage ;;
  *) usage ;;
esac

in_guard=0
if [ -n "$guard" ] && [ -f "$guard/repo" ]; then
  in_guard=1
  [ "$(tr -d '[:space:]' < "$guard/repo")" = "$repo" ] || die 65 "$repo is not the routine's repo"
  [ "$cmd" != init ] || die 65 "init is for the maintainer, not the routine"
fi

if [ "$cmd" = put ]; then
  [ "$3" = triaged ] || die 64 "the only record type is triaged"
  issue=$4; decision=$5; size=$6; risk=$7; why=$8
  [[ $issue =~ ^[1-9][0-9]{0,8}$ ]] || die 64 "the issue must be a number"
  case "$decision" in build|plan|decline) ;; *) die 64 "decision must be build, plan or decline" ;; esac
  case "$size" in S|M|L) ;; *) die 64 "size must be S, M or L" ;; esac
  case "$risk" in low|medium|high) ;; *) die 64 "risk must be low, medium or high" ;; esac
  [ -n "$why" ] || die 64 "why is empty"
  # Cc includes the C1 controls, which are multibyte and slip past [[:cntrl:]] in the C locale.
  jq -en --arg w "$why" '$w | test("\\p{Cc}") | not' >/dev/null || die 64 "why holds a control character"
  if [ "$in_guard" = 1 ]; then
    [ "$(tr -d '[:space:]' < "$guard/mode" 2>/dev/null)" = triage ] || die 65 "put needs the mode triage"
  fi
fi

user=$(gh api user --jq .login) || die 3 "cannot read GET /user"
[ -n "$user" ] || die 3 "GET /user returned no login"

pages() { # path -> one JSON array of all pages
  local out
  out=$(gh api --paginate --slurp "$1") || die 3 "cannot read $1"
  printf '%s' "$out" | jq -c 'add // [] | if type == "array" then . else error("not a list") end' || die 3 "$1 is not a list"
}

tracking_number() { # prints the number, or nothing when there is none
  local nums
  nums=$(pages "repos/$repo/issues?state=open&labels=pipeline-routine&per_page=100" | jq -c --arg user "$user" \
    '[.[] | select((has("pull_request") | not) and .state == "open" and .user.login == $user and any(.labels[]?; .name == "pipeline-routine")) | .number]') || exit $?
  [ "$(jq length <<<"$nums")" -le 1 ] || die 2 "more than one open pipeline-routine issue"
  jq -r '.[0] // empty' <<<"$nums"
}

trusted() { # comments-json prefix -> body or null
  printf '%s' "$1" | jq -r --arg prefix "$2" --arg user "$user" -f "$TRUSTED" || die 2 "more than one trusted comment starts with $2"
}

record_of() { # comments-json issue -> record JSON line, or nothing
  local body
  body=$(trusted "$1" "<!-- pipeline:routine triaged $2 -->") || exit $?
  [ "$body" = null ] && return 0
  printf '%s\n' "$body" | tail -n +2 | jq -ce 'select(type == "object" and (.decision | IN("build", "plan", "decline")))' || die 2 "the record for issue $2 is not valid"
}

closed_by_account() { # issue -> true or false
  pages "repos/$repo/issues/$1/events" | jq -r --arg user "$user" 'any(.[]; .event == "closed" and .actor.login == $user)'
}

case "$cmd" in
  init)
    n=$(tracking_number) || exit $?
    if [ -z "$n" ]; then
      n=$(gh api --method POST "repos/$repo/issues" -f title="Pipeline routine state" \
        -f body="State of the unattended routine. Records are comments by this account. Do not edit or remove them." \
        -f "labels[]=pipeline-routine" --jq .number) || die 3 "could not open the tracking issue"
    fi
    echo "$n" ;;

  next)
    n=$(tracking_number) || exit $?
    if [ -z "$n" ]; then echo '{"step":"init needed"}'; exit 0; fi
    comments=$(pages "repos/$repo/issues/$n/comments") || exit $?
    issues=$(pages "repos/$repo/issues?state=open&labels=pipeline-feedback&per_page=100") || exit $?
    candidates=$(jq -r --arg user "$user" '[.[] | select((has("pull_request") | not) and .state == "open" and .user.login == $user and any(.labels[]?; .name == "pipeline-feedback"))]
      | sort_by(.created_at, .number) | .[].number' <<<"$issues") || exit 3
    todo=()
    for i in $candidates; do
      rec=$(record_of "$comments" "$i") || exit $?
      if [ -z "$rec" ]; then todo+=("$i"); continue; fi
      if [ "$(jq -r .decision <<<"$rec")" = decline ]; then
        done_close=$(closed_by_account "$i") || exit $?
        [ "$done_close" = false ] && todo+=("$i")
      fi
    done
    if [ ${#todo[@]} -eq 0 ]; then echo '{"step":"idle"}'; exit 0; fi
    printf '%s\n' "${todo[@]:0:5}" | jq -cs '{step: "triage", issues: .}' ;;

  put)
    issue_json=$(gh api "repos/$repo/issues/$issue") || die 3 "cannot read issue $issue"
    jq -e --arg user "$user" '(has("pull_request") | not) and .state == "open" and .user.login == $user and any(.labels[]?; .name == "pipeline-feedback")' \
      <<<"$issue_json" >/dev/null || die 65 "issue $issue is closed, is a pull request, has no pipeline-feedback label or was opened by another account"
    n=$(tracking_number) || exit $?
    [ -n "$n" ] || die 65 "no tracking issue; the maintainer runs init"
    comments=$(pages "repos/$repo/issues/$n/comments") || exit $?
    rec=$(record_of "$comments" "$issue") || exit $?
    stored=1
    if [ -z "$rec" ]; then
      stored=0
      # The cut is done in jq so it counts code points and never splits a multibyte character.
      rec=$(jq -nc --arg d "$decision" --arg s "$size" --arg r "$risk" --arg w "$why" '
        ([$w | match("[.!?](?= |\\z)"; "g") | select(.offset < 500) | .offset + 1] | last // 500) as $end
        | {decision: $d, size: $s, risk: $r, why: (if ($w | length) > 500 then $w[:$end] else $w end)}
        | if ($w | length) > 500 then . + {whyCut: true} else . end
        | if .decision == "build" and (.size == "L" or .risk == "high") then . + {decision: "plan", triagerDecision: "build"} else . end')
    fi
    final=$(jq -r .decision <<<"$rec")

    case "$final" in
      decline)
        mark="<!-- pipeline:routine declined $issue -->"
        own=$(pages "repos/$repo/issues/$issue/comments") || exit $?
        if [ "$(trusted "$own" "$mark")" = null ]; then
          gh api --method POST "repos/$repo/issues/$issue/comments" -f body="$mark
$(jq -r .why <<<"$rec")" >/dev/null || die 3 "could not post the decline reason"
        fi ;;
      build|plan)
        label=routine-$final
        if ! jq -e --arg l "$label" 'any(.labels[]?; .name == $l)' <<<"$issue_json" >/dev/null; then
          gh api --method POST "repos/$repo/issues/$issue/labels" -f "labels[]=$label" >/dev/null || die 3 "could not add the label $label"
        fi ;;
    esac

    if [ "$stored" = 0 ]; then
      gh api --method POST "repos/$repo/issues/$n/comments" -f body="<!-- pipeline:routine triaged $issue -->
$rec" >/dev/null || die 3 "could not store the record"
    fi

    if [ "$final" = decline ]; then
      closed=$(closed_by_account "$issue") || exit $?
      if [ "$closed" = false ]; then
        gh api --method PATCH "repos/$repo/issues/$issue" -f state=closed >/dev/null || die 3 "could not close issue $issue"
      fi
    fi
    echo "$rec" ;;
esac
