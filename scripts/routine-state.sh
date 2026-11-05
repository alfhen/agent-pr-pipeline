#!/bin/bash
# Usage: routine-state.sh <owner/repo> init
#        routine-state.sh <owner/repo> next [--mode observe|triage|full]
#        routine-state.sh <owner/repo> put triaged <issue> <decision> <size> <risk> <why>
#        routine-state.sh <owner/repo> put build-started <issue> <run> <branch>
#        routine-state.sh <owner/repo> put blocked <issue> <run>
# State of the unattended routine: one open issue labelled pipeline-routine, opened by the account from GET /user,
# and one comment on it per triaged issue. A record counts only when scripts/trusted-comment.jq accepts it.
# next prints one JSON line: init needed, triage (open pipeline-feedback issues with no record, or a decline record
# that was not completed, oldest first, at most five) or idle. next exits non-zero on an error.
# put is the one write path of the routine. Every argument is checked here, not in the prompt.
# A build of size L or risk high is stored as plan; workflows/run-wave.js applies the same rule to quick fixes
# and this is the source of the rule until #88 puts both in one place.
# next --mode full prints one JSON line: step (init needed, block, build, triage, wait or idle), session (true for the
# steps in SESSION_STEPS), the step's data, held (issues the routine skips, for the log) and heldBy ("limits").
# Outcomes are read from GitHub: a build has a PR when GitHub lists one from its branch.
# In a guard folder put needs a mode that allows the record: triaged needs triage or full, build-started and
# blocked need full. init never runs in a guard folder.
# Exit: 0 done, 2 two trusted records or tracking issues, 3 a call to GitHub failed, 64 a bad argument,
# 65 refused (issue not eligible, wrong repo or mode).
set -uo pipefail
export LC_ALL=C

# The routine's own gh wrapper is read-only. put and next call the real one.
# Only /routine/bin is removed. /routine/bin-full must stay on PATH: a session in full mode then reaches the full
# wrapper, which refuses record bodies, and the runner (which has no bin-full on PATH) reaches the real gh.
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
SESSION_STEPS="build triage"

die() { local code=$1; shift; echo "routine-state: $*" >&2; exit "$code"; }
usage() { die 64 "usage: routine-state.sh <owner/repo> init|next [--mode observe|triage|full]|put triaged|build-started|blocked ..."; }

repo=${1:-}; cmd=${2:-}
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
nmode=triage
case "$cmd" in
  init) [ $# -eq 2 ] || usage ;;
  next)
    if [ $# -eq 4 ] && [ "$3" = --mode ]; then
      nmode=$4
      case "$nmode" in observe|triage|full) ;; *) usage ;; esac
    else
      [ $# -eq 2 ] || usage
    fi ;;
  put)
    case "${3:-}" in
      triaged) [ $# -eq 8 ] || usage ;;
      build-started) [ $# -eq 6 ] || usage ;;
      blocked) [ $# -eq 5 ] || usage ;;
      *) usage ;;
    esac ;;
  *) usage ;;
esac

branch_prefix() {
  local f="$here/../routine/branch-prefix" p
  [ -f "$f" ] || die 3 "$f is missing"
  p=$(head -n 1 "$f" | tr -d '[:space:]')
  [ -n "$p" ] || die 3 "$f is empty"
  printf '%s' "$p"
}

in_guard=0
if [ -n "$guard" ] && [ -f "$guard/repo" ]; then
  in_guard=1
  [ "$(tr -d '[:space:]' < "$guard/repo")" = "$repo" ] || die 65 "$repo is not the routine's repo"
  [ "$cmd" != init ] || die 65 "init is for the maintainer, not the routine"
fi

put_mode_check() { # allowed modes...
  [ "$in_guard" = 1 ] || return 0
  local m a
  m=$(tr -d '[:space:]' < "$guard/mode" 2>/dev/null)
  for a in "$@"; do [ "$m" = "$a" ] && return 0; done
  die 65 "put $ptype needs the mode $*"
}

if [ "$cmd" = put ]; then
  ptype=$3; issue=$4
  [[ $issue =~ ^[1-9][0-9]{0,8}$ ]] || die 64 "the issue must be a number"
  case "$ptype" in
    triaged)
      decision=$5; size=$6; risk=$7; why=$8
      case "$decision" in build|plan|decline) ;; *) die 64 "decision must be build, plan or decline" ;; esac
      case "$size" in S|M|L) ;; *) die 64 "size must be S, M or L" ;; esac
      case "$risk" in low|medium|high) ;; *) die 64 "risk must be low, medium or high" ;; esac
      [ -n "$why" ] || die 64 "why is empty"
      # Cc includes the C1 controls, which are multibyte and slip past [[:cntrl:]] in the C locale.
      jq -en --arg w "$why" '$w | test("\\p{Cc}") | not' >/dev/null || die 64 "why holds a control character"
      put_mode_check triage full ;;
    build-started|blocked)
      run_id=$5
      [[ $run_id =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || die 64 "the run must look like 20261105T120000Z-1234"
      if [ "$ptype" = build-started ]; then
        branch=$6
        want_branch=$(branch_prefix) || exit $?
        want_branch="${want_branch}issue-$issue"
        [ "$branch" = "$want_branch" ] || die 64 "the branch must be $want_branch"
      fi
      put_mode_check full ;;
  esac
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

trusted_all() { # comments-json prefix -> JSON list of every trusted body that starts with the prefix
  printf '%s' "$1" | jq -c --arg prefix "$2" --arg user "$user" --arg all 1 -f "$TRUSTED" || die 3 "cannot read the records that start with $2"
}

# comments-json type issue -> {"state":"absent"}, {"state":"bad"} or {"state":"ok","rec":{...}}.
# Two trusted records, or one whose second line is not the JSON the type needs, are bad: the key counts as present.
record_state() {
  local list
  list=$(trusted_all "$1" "<!-- pipeline:routine $2 $3 -->") || exit $?
  jq -c --arg t "$2" '
    def valid: type == "object" and (
      if $t == "triaged" then (.decision | IN("build", "plan", "decline"))
      elif $t == "build-started" then ((.run | type) == "string" and (.run | test("^[0-9]{8}T[0-9]{6}Z-[0-9]+$")) and (.branch | type) == "string")
      else (.reason | type) == "string" and (.run | type) == "string" end);
    if length == 0 then {state: "absent"}
    elif length > 1 then {state: "bad"}
    else (.[0] | split("\n") | (.[1] // "") | try fromjson catch null) as $r
      | if $r | valid then {state: "ok", rec: $r} else {state: "bad"} end end' <<<"$list"
}

next_full() {
  local n comments prefix owner limits cfg="" cfgfile=""
  n=$(tracking_number) || exit $?
  held='[]'; heldby=""
  if [ -z "$n" ]; then emit_step "init needed" '{}'; return; fi

  [ -f "$here/../routine/config.jq" ] || die 3 "$here/../routine/config.jq is missing"
  if [ "$in_guard" = 1 ] && [ -f "$guard/routine.json" ]; then
    limits=$(jq -c -f "$here/../routine/config.jq" "$guard/routine.json" 2>/dev/null | jq -c .limits 2>/dev/null) || limits=""
  fi
  if [ -z "${limits:-}" ]; then
    limits=$(jq -nc -f "$here/../routine/config.jq" | jq -c .limits) || die 3 "config.jq failed"
    cfg=defaults
  fi
  prefix=$(branch_prefix) || exit $?
  owner=${repo%%/*}
  comments=$(pages "repos/$repo/issues/$n/comments") || exit $?

  local routine_issues numbers i bs bl tr block_issue="" block_run="" pending=() st
  routine_issues=$(pages "repos/$repo/issues?state=open&labels=routine-build&per_page=100") || exit $?
  numbers=$(jq -r '[.[] | select((has("pull_request") | not) and .state == "open" and any(.labels[]?; .name == "routine-build"))]
    | sort_by(.created_at, .number) | .[].number' <<<"$routine_issues") || exit 3
  for i in $numbers; do
    bs=$(record_state "$comments" build-started "$i") || exit $?
    bl=$(record_state "$comments" blocked "$i") || exit $?
    st=$(jq -r .state <<<"$bs")
    if [ "$st" = bad ]; then add_held "$i" "bad build-started record"; continue; fi
    if [ "$st" = ok ]; then
      if [ "$(jq -r .state <<<"$bl")" != absent ]; then add_held "$i" "blocked"; continue; fi
      if [ -z "$block_issue" ] && [ "$(has_pr "$prefix" "$owner" "$i")" = false ]; then
        block_issue=$i; block_run=$(jq -r .rec.run <<<"$bs")
      fi
      continue
    fi
    tr=$(record_state "$comments" triaged "$i") || exit $?
    case "$(jq -r .state <<<"$tr")" in
      bad) add_held "$i" "bad triaged record" ;;
      ok) [ "$(jq -r .rec.decision <<<"$tr")" = build ] && pending+=("$i") ;;
    esac
  done

  local open_prs recent recent_runs
  open_prs=$(pages "repos/$repo/pulls?state=open&per_page=100" | jq -r --arg user "$user" --arg p "$prefix" \
    '[.[] | select(.user.login == $user and (.head.ref | strings | startswith($p)))] | length') || exit $?
  recent=$(jq -c '[.[] | objects | select((try (.created_at | fromdateiso8601) catch 0) > now - 86400)]' <<<"$comments") || exit 3
  recent_runs=$(trusted_all "$recent" "<!-- pipeline:routine build-started " \
    | jq -r '[.[] | split("\n") | (.[1] // "") | (try fromjson catch null) | objects | .run | strings | select(test("^[0-9]{8}T[0-9]{6}Z-[0-9]+$"))] | unique | length') || exit $?

  if [ -n "$block_issue" ]; then
    emit_step block "$(jq -nc --argjson i "$block_issue" --arg r "$block_run" '{issue: $i, run: $r, reason: "build ended with no PR"}')"
    return
  fi

  local can_build
  can_build=$(jq -r --argjson o "$open_prs" --argjson w "$recent_runs" '.openPRs > $o and .wavesPerDay > $w and .buildIssues > 0' <<<"$limits")
  if [ ${#pending[@]} -gt 0 ]; then
    if [ "$can_build" = true ]; then
      local data
      data=$(printf '%s\n' "${pending[@]}" | jq -cs --arg p "$prefix" --argjson l "$limits" \
        '{issues: (.[:$l.buildIssues] | map({issue: ., branch: ($p + "issue-" + tostring)}))}')
      emit_step build "$data"
      return
    fi
    heldby=limits
  fi

  local feedback candidates todo=() rec
  feedback=$(pages "repos/$repo/issues?state=open&labels=pipeline-feedback&per_page=100") || exit $?
  candidates=$(jq -r --arg user "$user" '[.[] | select((has("pull_request") | not) and .state == "open" and .user.login == $user and any(.labels[]?; .name == "pipeline-feedback"))]
    | sort_by(.created_at, .number) | .[].number' <<<"$feedback") || exit 3
  for i in $candidates; do
    rec=$(record_state "$comments" triaged "$i") || exit $?
    case "$(jq -r .state <<<"$rec")" in
      absent) todo+=("$i") ;;
      bad) add_held "$i" "bad triaged record" ;;
      ok)
        if [ "$(jq -r .rec.decision <<<"$rec")" = decline ] && [ "$(closed_by_account "$i")" = false ]; then todo+=("$i"); fi ;;
    esac
  done
  if [ ${#todo[@]} -gt 0 ]; then
    emit_step triage "$(printf '%s\n' "${todo[@]:0:5}" | jq -cs '{issues: .}')"
  elif [ "$heldby" = limits ] || [ "$open_prs" -gt 0 ]; then
    emit_step wait '{}'
  else
    emit_step idle '{}'
  fi
}

put_run_record() { # build-started and blocked: the runner's records
  local n comments existing body
  if [ "$ptype" = build-started ]; then
    local issue_json
    issue_json=$(gh api "repos/$repo/issues/$issue") || die 3 "cannot read issue $issue"
    jq -e '(has("pull_request") | not) and .state == "open" and any(.labels[]?; .name == "routine-build")' <<<"$issue_json" >/dev/null \
      || die 65 "issue $issue is closed, is a pull request or has no routine-build label"
  fi
  n=$(tracking_number) || exit $?
  [ -n "$n" ] || die 65 "no tracking issue; the maintainer runs init"
  comments=$(pages "repos/$repo/issues/$n/comments") || exit $?
  if [ "$ptype" = build-started ]; then
    local rec
    rec=$(record_of "$comments" "$issue") || exit $?
    [ -n "$rec" ] && [ "$(jq -r .decision <<<"$rec")" = build ] || die 65 "issue $issue has no trusted triaged record with decision build"
    body=$(jq -nc --arg r "$run_id" --arg b "$branch" '{run: $r, branch: $b}')
  else
    body=$(jq -nc --arg r "$run_id" '{reason: "build ended with no PR", run: $r}')
  fi
  existing=$(trusted_all "$comments" "<!-- pipeline:routine $ptype $issue -->") || exit $?
  [ "$(jq length <<<"$existing")" = 0 ] || die 65 "a $ptype record for issue $issue exists"
  gh api --method POST "repos/$repo/issues/$n/comments" -f body="<!-- pipeline:routine $ptype $issue -->
$body" >/dev/null || die 3 "could not store the record"
  echo "$body"
}

add_held() { # issue why
  held=$(jq -c --argjson i "$1" --arg w "$2" '. + [{issue: $i, why: $w}]' <<<"$held")
}

has_pr() { # prefix owner issue -> true or false: a PR by the account from the issue's branch, in any state
  pages "repos/$repo/pulls?state=all&head=$2:$1issue-$3" | jq -r --arg user "$user" --arg ref "$1issue-$3" \
    'any(.[]; .user.login == $user and .head.ref == $ref)'
}

emit_step() { # step data-json
  jq -nc --arg step "$1" --argjson data "$2" --argjson held "$held" --arg by "$heldby" --arg cfg "${cfg:-}" --arg ss "$SESSION_STEPS" \
    '{step: $step, session: ($step | IN($ss | split(" ")[]))} + $data + {held: $held}
     + (if $by != "" then {heldBy: $by} else {} end) + (if $cfg != "" then {config: $cfg} else {} end)'
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
    if [ "$nmode" = full ]; then next_full; exit $?; fi
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
    if [ "$ptype" != triaged ]; then put_run_record; exit $?; fi
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
