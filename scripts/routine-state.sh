#!/bin/bash
# Usage: routine-state.sh <owner/repo> init
#        routine-state.sh <owner/repo> next [--mode observe|triage|full]
#        routine-state.sh <owner/repo> put triaged <issue> <decision> <size> <risk> <why>
#        routine-state.sh <owner/repo> put build-started <issue> <run> <branch>
#        routine-state.sh <owner/repo> put blocked <issue> <run>
# Cloud forms (0.8.0, settings from .github/pipeline.json): gate | next --mode cloud-triage | next --mode cloud-build --start <file>
#        | issue-text <n> | list outboxes | get outbox <run> | put adopt|untrusted|revoke|triaged|triage-failed|build-started|built|
#        blocked|needs-plan|pr-seen|exhausted|env-stale|env-ok|feedback-outbox|feedback-filed|feedback-dropped (see the record keys below).
#        put built <issue> <run> <pr> <ready> <reasonCode> [<result file>]: with pr none, the file's prs[0].reason is stored as why.
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
nmode=triage; cloud=0; start_file=""
case "$cmd" in
  init) [ $# -eq 2 ] || usage ;;
  next)
    if [ $# -eq 4 ] && [ "$3" = --mode ]; then
      nmode=$4
      case "$nmode" in observe|triage|full) ;; cloud-triage) cloud=1 ;; *) usage ;; esac
    elif [ $# -eq 6 ] && [ "$3" = --mode ] && [ "$4" = cloud-build ] && [ "$5" = --start ]; then
      nmode=cloud-build; start_file=$6; cloud=1
    else
      [ $# -eq 2 ] || usage
    fi ;;
  gate) [ $# -eq 2 ] || usage; cloud=1 ;;
  issue-text) [ $# -eq 3 ] || usage; cloud=1 ;;
  list) [ $# -eq 3 ] && [ "$3" = outboxes ] || usage; cloud=1 ;;
  get) [ $# -eq 4 ] && [ "$3" = outbox ] || usage; cloud=1 ;;
  put)
    case "${3:-}" in
      triaged) if [ $# -eq 8 ]; then :; elif [ $# -eq 9 ]; then cloud=1; else usage; fi ;;
      build-started) if [ $# -eq 6 ]; then :; elif [ $# -eq 7 ]; then cloud=1; else usage; fi ;;
      blocked) if [ $# -eq 5 ]; then :; elif [ $# -eq 6 ]; then cloud=1; else usage; fi ;;
      adopt|untrusted|pr-seen|exhausted|needs-plan|triage-failed|env-stale|env-ok|feedback-dropped) [ $# -eq 4 ] || usage; cloud=1 ;;
      revoke|feedback-outbox|feedback-filed) [ $# -eq 5 ] || usage; cloud=1 ;;
      built) [ $# -eq 8 ] || [ $# -eq 9 ] || usage; cloud=1 ;;
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

if [ "$cmd" = put ] && [ "$cloud" = 0 ]; then
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

# ---- Cloud routines (0.8.0). State is the labels on issues and records on the tracking issue. ----
# Records are comments `<!-- pipeline:routine <kind> <key> -->` plus one JSON line. Keys, by kind:
#   triaged, triage-failed  <n>:<epoch>   epoch = id of the issue's newest untrusted or revoked record, or 0
#   needs-plan              <n>:<approval time>, or <n>:<blocked record id> after a plan stop
#   untrusted               <n>:<hash>:<time>      revoked  <n>:<cause>:<time>
#   build-started, blocked, built  <n>:<attempt>
#   env-stale, env-ok       <pin>:<time>           outbox kinds  <run>
# A put refuses a second record of one kind and key. Every step lists an issue only while its put would write.
CONFIG="$here/../routine/config.jq"
APPROVAL="$here/approval.jq"
RUN_RE='^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$'
STATE_LABELS="ready-to-build needs-approval declined building build-failed needs-plan needs-maintainer"
routine_cfg=null; stage=0; tracking=""; GATE=""; maintainer=""; tcomments="[]"; recs="[]"

read -r -d '' PLAN_JQ <<'JQ'
def lc: if type == "string" then ascii_downcase else "" end;
def mx: if length == 0 then null else max end;
def inl($a): . as $x | any($a[]; . == $x);
def ctime: [.created_at, (.updated_at // .created_at)] | map(select(. != null)) | mx;
def within($s): (try (.at | fromdateiso8601) catch 0) > (now - $s);
# A lost race leaves a second record of the key; only the first counts.
def firstPerKey: reduce .[] as $x ([]; if any(.[]; .key == $x.key) then . else . + [$x] end);
def byAge: sort_by([.i.created_at, .i.number]);
def hasl($l): .L | index($l) != null;

($cfg.trustedAuthors | map(lc)) as $ta
| $cfg.limits as $lim
| ["ready-to-build", "needs-approval", "declined", "building", "build-failed", "needs-plan", "needs-maintainer"] as $stateLabels
| def facts($c):
    $c.issue as $i | $i.number as $n
    | ([$i.labels[]? | .name]) as $L
    | ($recs | map(select(.n == $n))) as $r
    | ($r | map(select(.kind == "untrusted" or .kind == "revoked"))) as $ur
    | ($ur | last) as $lu
    | ($ur | length > 0) as $hasUR
    | ($lu.id // 0) as $epoch
    | ($lu.at // "") as $urAt
    | (($i.user.login | lc) | inl($ta)) as $trusted
    | (if ($L | index("maintainer-approved")) != null and $c.approval != null and ($urAt == "" or $c.approval > $urAt) then $c.approval else null end) as $A
    | (if $hasUR then $A != null else $trusted end) as $authorPart
    | ([$A, (if $hasUR or ($L | index("ready-to-build")) == null then null else $c.rtb end)] | map(select(. != null)) | mx) as $ref0
    | ($ref0 // $i.created_at) as $R
    | ([$c.comments[]? | objects | select((.user.login | lc | inl($ta)) | not) | ctime | select(. > $R)]) as $off
    | (if ($authorPart | not) then "author"
       elif ($hasUR and ($c.hash != $lu.rec.hash)) then "hash"
       elif ($off | length) > 0 then "comment"
       else null end) as $reason
    | ($r | map(select(.kind == "triaged")) | last) as $tr
    | ($r | map(select(.kind == "build-started" and (.key | contains(":")))) | firstPerKey) as $bs
    | ($r | map(select(.kind == "blocked" and (.key | contains(":"))))) as $bl
    | ($r | map(select(.kind == "built" and (.key | contains(":"))))) as $bt
    | ($r | any(.kind == "build-started" and (.key | contains(":") | not) and within($lim.buildHours * 3600))) as $legacyLive
    | ($r | any((.kind == "build-started" or .kind == "blocked") and (.key | contains(":") | not))) as $legacyBuilt
    | ($bs | last) as $ls
    | {n: $n, i: $i, comments: $c.comments, L: $L, r: $r, lu: $lu, hasUR: $hasUR, epoch: $epoch, trusted: $trusted,
       A: $A, authorPart: $authorPart, reason: $reason, newestOff: ($off | mx), hasPr: $c.hasPr,
       skipped: (($L | any(inl($cfg.skipLabels))) or ($L | index("declined")) != null),
       excluded: (($L | any(inl($cfg.skipLabels))) or ($L | index("declined")) != null or $c.hasPr),
       tr: $tr, trNew: ($tr != null and $tr.id > $epoch),
       att: ($bs | map(.key) | unique | length), ls: $ls, lb: ($r | map(select(.kind == "blocked")) | last), legacyBuilt: $legacyBuilt,
       inflight: ($bs | any(.key as $k | ($bl | any(.key == $k)) | not)),
       legacyLive: $legacyLive,
       ended: ($ls != null and ($bl | any(.key == $ls.key))),
       built: ($ls != null and ($bt | any(.key == $ls.key))),
       builtCode: ($ls as $s | $bt | map(select(.key == $s.key)) | last | .rec.reasonCode)}
  ;
  def ge: .n >= $cfg.triageFrom;
  def pathOk: (.lb == null and (hasl("ready-to-build") or .A != null)) or (.lb != null and .A != null and .A > .lb.at);
  def adoptLabels: .tr.rec as $x
    | [(if $x.decision == "decline" then "declined"
        elif .legacyBuilt then "build-failed"
        elif $x.decision == "build" and $x.size != "L" and $x.risk != "high" then "ready-to-build"
        else "needs-approval" end)]
      + (if ($x.size | IN("S", "M", "L")) then ["size:" + $x.size] else [] end);
  [$ctx[] | facts(.)] as $F
  | ([$F[] | select(.tr != null and (.tr.key | contains(":") | not) and ((.tr.rec | type) == "object") and .tr.rec.type == null
        and (.tr.rec.decision | IN("build", "plan", "decline"))
        and (.L | any(inl($stateLabels)) | not) and (.excluded | not) and .reason == null)] | byAge) as $adopt
  | ([$F[] | select((.trusted | not) and ge and (.skipped | not) and (.r | any(.kind == "untrusted") | not) and (.r | any(.kind == "triaged") | not))] | byAge) as $untrusted
  | ([$F[] | select(.authorPart and (.reason == "hash" or .reason == "comment") and (.excluded | not))] | byAge) as $revoke
  | ([$F[] | . as $f | select($f.authorPart and $f.reason == null and ($f | ge) and ($f.excluded | not) and ($f.trNew | not)
        and ($f.r | any(.kind == "triage-failed" and .key == "\($f.n):\($f.epoch)") | not))] | byAge) as $eligible
  | ([$recs[] | select((.kind == "triaged" or .kind == "triage-failed") and within(86400))] | length) as $used
  | ([$lim.triagePerRun, ($lim.triagePerDay - $used)] | min | if . < 0 then 0 else . end) as $slots
  | ($eligible[:$slots] | map(.n)) as $triage
  | ([$F[] | select(hasl("building") and (.hasPr or ((.inflight | not) and (.legacyLive | not))))] | byAge) as $prseen
  | ([$F[] | select(.ls != null and (.ended | not) and (.hasPr | not)
        and (.built or ((try (.ls.at | fromdateiso8601) catch 0) < now - ($lim.buildHours * 3600))))] | byAge) as $block
  | ([$F[] | select((hasl("build-failed") or .lb.rec.reasonCode == "triage-plan") and (hasl("needs-maintainer") | not) and .A != null and .lb != null and .A > .lb.at
        and .att >= $lim.buildAttempts and .authorPart)] | byAge) as $exhausted
  | ([$F[] | . as $f | select($f.A != null and $f.reason == null and ($f.excluded | not) and $f.trNew
        and ($f.tr.rec.size == "L" or $f.tr.rec.risk == "high" or $f.tr.rec.decision == "plan")
        and ($f.r | any(.kind == "needs-plan" and .key == "\($f.n):\($f.A)") | not))] | byAge) as $needsPlan
  | ([$F[] | select(.authorPart and .reason == null and (.excluded | not) and (hasl("building") | not) and (.inflight | not)
        and .att < $lim.buildAttempts and .trNew and .tr.rec.decision == "build" and .tr.rec.size != "L" and .tr.rec.risk != "high" and pathOk)] | byAge) as $buildable
  | ([$pulls[] | select(.user.login == $user and (.head.ref | strings | startswith($prefix)))] | length) as $openPrs
  | ([$recs | map(select(.kind == "build-started")) | firstPerKey | .[] | select(within(86400)) | .rec.run | strings] | unique | length) as $runs
  | (($openPrs >= $lim.openPRs) or ($runs >= $lim.wavesPerDay)) as $limitsHold
  | (if $mode == "build" then
      ($prseen | map({step: "pr-seen", issue: .n}))
      + ($revoke | map(select(hasl("ready-to-build") or hasl("maintainer-approved"))) | map({step: "revoke", issue: .n, cause: .reason}))
      + ($block | map({step: "block", issue: .n, run: .ls.rec.run, attempt: (.ls.key | split(":")[1] | tonumber),
          reasonCode: (if .builtCode | IN("triage-plan", "triage-decline", "rounds-exhausted", "needs-human") then .builtCode else "other" end)}))
      + ($exhausted | map({step: "exhausted", issue: .n}))
      + ($needsPlan | map({step: "needs-plan", issue: .n}))
      + (if ($buildable | length) > 0 and ($limitsHold | not) then
          $buildable[0] as $b
          | [{step: (if $stage == 0 then "would-build" else "build" end), issue: $b.n, attempt: ($b.att + 1),
              branch: ($prefix + "issue-" + ($b.n | tostring)), run: $run,
              args: ($cfg.waveArgs + {repo: $repo, tmp: ("/tmp/apl-" + $run), pluginRoot: $start.pluginRoot, agentPrefix: $start.agentPrefix,
                     feedback: true, feedbackRepo: $cfg.feedbackRepo,
                     prs: [{quick: {issue: $b.n}, branch: ($prefix + "issue-" + ($b.n | tostring))}]})}]
        else [] end)
    else
      ($adopt | map({step: "adopt", issue: .n, labels: adoptLabels}))
      + ($untrusted | map({step: "untrusted", issue: .n}))
      + ($revoke | map(select(ge)) | map({step: "revoke", issue: .n, cause: .reason}))
      + (if ($triage | length) > 0 then [{step: (if $stage == 0 then "would-triage" else "triage" end), issues: $triage}] else [] end)
    end) as $lines
  | {lines: $lines,
     idle: (if $mode == "build" and ($buildable | length) > 0 and $limitsHold then {step: "wait", heldBy: "limits"} else {step: "idle"} end),
     adopt: ($adopt | map({issue: .n, labels: adoptLabels})),
     untrusted: ($untrusted | map(.n)),
     revoke: ($revoke | map({issue: .n, cause: .reason})),
     eligible: ($eligible | map(.n)),
     prseen: ($prseen | map(.n)),
     prseenFailed: ($prseen | map(select(.hasPr | not) | select(.ended)) | map(.n)),
     block: ($block | map({issue: .n})),
     exhausted: ($exhausted | map(.n)),
     needsPlan: ($needsPlan | map({issue: .n, key: "\(.n):\(.A)"})),
     buildable: ($buildable | map({issue: .n, attempt: (.att + 1)})),
     limitsHold: $limitsHold,
     f: ($F[0] // null | if . == null then null else {epoch, A, L, reason, att, ended, lb} end),
     text: ($F[0] // null | if . != null and .reason == null then
         {number: .n, title: .i.title, body: (.i.body // ""),
          comments: [.comments[]? | objects | select(.user.login | lc | inl($ta)) | {author: .user.login, body: .body}]}
       else null end)}
JQ

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }
text_hash() { jq -j '(.title // "") + "\n" + (.body // "")' <<<"$1" | sha256; }

num_arg() { [[ $1 =~ ^[1-9][0-9]{0,8}$ ]] || die 64 "the issue must be a number"; }
run_arg() { [[ $1 =~ $RUN_RE ]] || die 64 "the run must look like 20261105T120000Z-0a1b2c3d"; }

# Every argument is checked here, before any call to GitHub.
cloud_validate() {
  case "$cmd" in
    issue-text) issue=$3; num_arg "$issue" ;;
    get) run_arg "$4" ;;
    put)
      ptype=$3
      case "$ptype" in
        env-stale|env-ok) pin=$4; [[ $pin =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 64 "the pin must look like v0.8.0" ;;
        feedback-dropped) run_arg "$4" ;;
        feedback-outbox)
          run_arg "$4"; ofile=$5
          [ -f "$ofile" ] || die 64 "$ofile is not a file"
          jq -e '(type == "object") and ((keys | sort) == ["denylist", "dropped", "feedbackRepo", "items", "source"])
            and (.source | type == "string" and test("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$"))
            and (.feedbackRepo | type == "string" and test("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$"))
            and (.items | type == "array" and all(.[]; type == "object"))
            and (.denylist | type == "array" and all(.[]; type == "string"))
            and (.dropped | type == "number" or type == "array")
            and (tojson | length) <= 60000' "$ofile" >/dev/null 2>&1 || die 64 "the outbox file must hold exactly source, feedbackRepo, items, denylist and dropped, and fit in one comment" ;;
        feedback-filed)
          run_arg "$4"; counts=$5
          jq -e 'type == "object" and ((keys | sort) == ["filed", "refused", "seenAgain"]) and all(.[]; type == "number" and . == floor and . >= 0)' <<<"$counts" >/dev/null 2>&1 \
            || die 64 "the counts must be JSON with filed, seenAgain and refused as whole numbers" ;;
        *)
          issue=$4; num_arg "$issue"
          case "$ptype" in
            revoke) cause=$5; case "$cause" in hash|comment) ;; *) die 64 "the cause must be hash or comment" ;; esac ;;
            triaged)
              decision=$5; size=$6; risk=$7; itype=$8; why=$9
              case "$decision" in build|plan|decline) ;; *) die 64 "decision must be build, plan or decline" ;; esac
              case "$size" in S|M|L) ;; *) die 64 "size must be S, M or L" ;; esac
              case "$risk" in low|medium|high) ;; *) die 64 "risk must be low, medium or high" ;; esac
              case "$itype" in bug|feat|docs|chore|test) ;; *) die 64 "type must be bug, feat, docs, chore or test" ;; esac
              [ -n "$why" ] || die 64 "why is empty"
              jq -en --arg w "$why" '$w | test("\\p{Cc}") | not' >/dev/null || die 64 "why holds a control character" ;;
            build-started)
              run_arg "$5"; run_id=$5; branch=$6; attempt=$7
              [[ $attempt =~ ^[1-9][0-9]?$ ]] || die 64 "the attempt must be a number"
              want_branch=$(branch_prefix) || exit $?
              [ "$branch" = "${want_branch}issue-$issue" ] || die 64 "the branch must be ${want_branch}issue-$issue" ;;
            built)
              run_arg "$5"; run_id=$5; pr=$6; ready=$7; reason=$8; result_file=${9:-}
              [[ $pr =~ ^([1-9][0-9]{0,8}|none)$ ]] || die 64 "pr must be a number or none"
              case "$ready" in true|false) ;; *) die 64 "ready must be true or false" ;; esac
              case "$reason" in opened|triage-plan|triage-decline|rounds-exhausted|needs-human|other) ;; *) die 64 "bad reason code" ;; esac
              [ -z "$result_file" ] || [ -f "$result_file" ] || die 64 "$result_file is not a file" ;;
            blocked)
              run_arg "$5"; run_id=$5; reason=$6
              case "$reason" in opened|triage-plan|triage-decline|rounds-exhausted|needs-human|other) ;; *) die 64 "bad reason code" ;; esac ;;
          esac ;;
      esac ;;
  esac
}

load_settings() { # sets routine_cfg: the checked routine object, or null when the file has no routine key
  local raw out
  [ -f "$CONFIG" ] || die 3 "$CONFIG is missing"
  raw=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$repo/contents/.github/pipeline.json") || die 3 "cannot read .github/pipeline.json"
  out=$(printf '%s' "$raw" | jq -c --arg form pipeline -f "$CONFIG" 2>&1) || die 3 "${out:-config.jq failed}"
  routine_cfg=$(jq -c '.routine' <<<"$out") || die 3 "config.jq gave no routine"
  maintainer=$(jq -r '.maintainer // ""' <<<"$routine_cfg")
}

# Sets GATE to paused, "init needed" or "stage <n>", plus stage, tracking and routine_cfg.
gate_state() {
  local tobj
  load_settings
  if [ "$routine_cfg" = null ]; then GATE=paused; return; fi
  tobj=$(tracking_obj) || exit $?
  if [ -z "$tobj" ]; then GATE="init needed"; return; fi
  tracking=$(jq -r .number <<<"$tobj")
  if jq -e 'any(.labels[]?; .name == "routine-paused")' <<<"$tobj" >/dev/null; then GATE=paused; return; fi
  stage=$(jq -r .stage <<<"$routine_cfg")
  GATE="stage $stage"
}

# comments-json -> the trusted records, oldest first: {kind, key, n, id, at, rec}
# Trust is decided by trusted-comment.jq; the comment's id and time are joined back by body.
# A record is the marker line and one JSON line; a cloud session's proxy adds a footer after it.
records() {
  local t
  t=$(trusted_all "$1" "<!-- pipeline:routine ") || exit $?
  jq -c --slurpfile t <(printf '%s' "$t") --arg user "$user" '
    $t[0] as $t | . as $c
    | [$t[] | . as $b | ($b | split("\n")) as $lines
       | ($lines[0] | capture("^<!-- pipeline:routine (?<kind>[a-z-]+) (?<key>[^ ]+) -->\\z")?) as $h
       | ([$c[] | objects | select(.user.login == $user and .body == $b)] | last) as $m
       | $h + {n: (try ($h.key | split(":")[0] | tonumber) catch null), id: ($m.id // 0), at: ($m.created_at // ""),
               rec: (try (($lines[1] // "") | fromjson) catch null)}]' <<<"$1" || die 3 "cannot read the records"
}

load_records() {
  tcomments=$(pages "repos/$repo/issues/$tracking/comments") || exit $?
  recs=$(records "$tcomments") || exit $?
}

WRITES=0
write_record() { # kind key json -> sets REC_ID
  local out
  out=$(gh api --method POST "repos/$repo/issues/$tracking/comments" -f body="<!-- pipeline:routine $1 $2 -->
$3" --jq .id) || die 3 "could not store the $1 record"
  REC_ID=$out
  [[ $REC_ID =~ ^[0-9]+$ ]] || REC_ID=0
}

refuse_dup() { # kind key
  jq -e --arg k "$1" --arg key "$2" 'any(.[]; .kind == $k and .key == $key)' <<<"$recs" >/dev/null && die 65 "a $1 record with the key $2 exists"
  return 0
}

add_labels() { # issue label...
  local n=$1 args=() l; shift
  for l in "$@"; do args+=(-f "labels[]=$l"); done
  gh api --method POST "repos/$repo/issues/$n/labels" "${args[@]}" >/dev/null || die 3 "could not add labels to issue $n"
}

remove_labels() { # issue label... (only those the live issue holds)
  local n=$1 l; shift
  for l in "$@"; do
    if jq -e --arg l "$l" 'any(.labels[]?; .name == $l)' <<<"$issue_live" >/dev/null; then
      gh api --method DELETE "repos/$repo/issues/$n/labels/$l" >/dev/null || die 3 "could not remove the label $l from issue $n"
    fi
  done
}

would() { # words...: stage 0 prints what the put would do and writes nothing
  if [ "$stage" = 0 ]; then echo "WOULD $*"; exit 0; fi
  return 0
}

open_issues() { # all open issues, no pull requests, not the tracking issue
  pages "repos/$repo/issues?state=open&per_page=100" | jq -c --argjson t "${tracking:-0}" \
    '[.[] | select((has("pull_request") | not) and .state == "open" and .number != $t)
      | {number, title, body, state, created_at, user: {login: .user.login}, labels: [.labels[]? | {name}]}]'
}

has_pr_from() { # issue -> true or false: a PR by the account from claude/issue-<n> or the 0.7.0 branch
  local a b prefix owner=${repo%%/*}
  prefix=$(branch_prefix) || exit $?
  a=$(has_pr "$prefix" "$owner" "$1") || exit $?
  b=$(has_pr "routine/" "$owner" "$1") || exit $?
  if [ "$a" = true ] || [ "$b" = true ]; then echo true; else echo false; fi
}

gather() { # issues-json-array -> one context object per issue
  local n obj comments events appr rtb hash hp ctx='[]'
  for n in $(jq -r '.[].number' <<<"$1"); do
    obj=$(jq -c --argjson n "$n" 'map(select(.number == $n))[0]' <<<"$1")
    comments=$(pages "repos/$repo/issues/$n/comments" | jq -c '[.[] | {id, created_at, updated_at, body, user: {login: .user.login}}]') || exit $?
    events='[]'
    if jq -e 'any(.labels[]?; .name == "maintainer-approved" or .name == "ready-to-build")' <<<"$obj" >/dev/null; then
      events=$(pages "repos/$repo/issues/$n/events") || exit $?
    fi
    appr=$(jq -c --arg maintainer "$maintainer" --arg label maintainer-approved --arg after "" -f "$APPROVAL" <<<"$events") || die 3 "approval.jq failed"
    rtb=$(jq -c '[.[]? | objects | select(.event == "labeled" and .label.name == "ready-to-build") | .created_at | strings] | if length == 0 then null else max end' <<<"$events") || exit 3
    hash=$(text_hash "$obj")
    hp=$(has_pr_from "$n") || exit $?
    ctx=$(jq -c --slurpfile o <(printf '%s' "$obj") --slurpfile c <(printf '%s' "$comments") --argjson a "$appr" --argjson r "$rtb" --arg h "$hash" --argjson p "$hp" \
      '. + [{issue: $o[0], comments: $c[0], approval: $a, rtb: $r, hash: $h, hasPr: $p}]' <<<"$ctx")
  done
  printf '%s' "$ctx"
}

# mode (triage|build|text) issues-json-array -> the plan; needs routine_cfg, recs and tracking
make_plan() {
  local ctx pulls='[]' start=null run prefix
  prefix=$(branch_prefix) || exit $?
  ctx=$(gather "$2") || exit $?
  if [ "$1" = build ]; then pulls=$(pages "repos/$repo/pulls?state=open&per_page=100" | jq -c '[.[] | {user: {login: .user.login}, head: {ref: .head.ref}}]') || exit $?; fi
  [ -z "$start_json" ] || start=$start_json
  run="$(utc_stamp)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  jq -nc --slurpfile ctx <(printf '%s' "$ctx") --slurpfile recs <(printf '%s' "$recs") --slurpfile cfg <(printf '%s' "$routine_cfg") \
    --slurpfile pulls <(printf '%s' "$pulls") --argjson start "$start" \
    --arg user "$user" --arg prefix "$prefix" --arg repo "$repo" --arg run "$run" --arg mode "$1" --argjson stage "$stage" \
    '$ctx[0] as $ctx | $recs[0] as $recs | $cfg[0] as $cfg | $pulls[0] as $pulls | '"$PLAN_JQ" \
    || die 3 "the plan failed"
}
start_json=""

check_start() { # start file -> sets start_json; the file must match the pin
  local v
  [ -f "$start_file" ] || die 64 "no such file: $start_file"
  start_json=$(jq -c 'if type == "object" then {version, pluginRoot, agentPrefix} else error("not an object") end' "$start_file" 2>/dev/null) \
    || die 65 "the --start file is not apl-start's output"
  v=$(jq -r .pipelineVersion <<<"$routine_cfg")
  jq -e --arg v "$v" '.version == $v and (.pluginRoot | type == "string" and startswith("/") and endswith("/" + $v)) and (.agentPrefix | type == "string" and length > 0)' \
    <<<"$start_json" >/dev/null || die 65 "the --start file does not match the pin $v"
}

cloud_next() {
  local issues p
  gate_state
  case "$GATE" in paused|"init needed") jq -nc --arg s "$GATE" '{step: $s}'; return ;; esac
  if [ "$nmode" = cloud-build ]; then check_start; fi
  load_records
  issues=$(open_issues) || exit $?
  if [ "$nmode" = cloud-build ]; then
    issues=$(jq -c --slurpfile recs <(printf '%s' "$recs") '$recs[0] as $recs | [.[] | .number as $n | select(any(.labels[]?; .name | IN("building", "ready-to-build", "maintainer-approved", "build-failed"))
      or any($recs[]; .kind == "build-started" and .n == $n))]' <<<"$issues")
    p=$(make_plan build "$issues") || exit $?
  else
    issues=$(jq -c --argjson cfg "$routine_cfg" '[.[] | select(any(.labels[]?; .name == "declined" or (.name | IN($cfg.skipLabels[]))) | not)]' <<<"$issues")
    p=$(make_plan triage "$issues") || exit $?
  fi
  jq -c --argjson stage "$stage" 'if (.lines | length) == 0 then .idle elif $stage == 0 then .lines[] else .lines[0] end' <<<"$p"
}

cloud_issue_text() {
  local p
  gate_state
  case "$GATE" in paused|"init needed") die 65 "$GATE" ;; esac
  load_records
  issue_live=$(gh api "repos/$repo/issues/$issue") || die 3 "cannot read issue $issue"
  jq -e '(has("pull_request") | not) and .state == "open"' <<<"$issue_live" >/dev/null || die 65 "issue $issue is closed or is a pull request"
  p=$(make_plan text "[$issue_live]") || exit $?
  jq -e '.text != null' <<<"$p" >/dev/null || die 65 "issue $issue does not pass the live check"
  jq -c .text <<<"$p"
}

open_outboxes() { # recs -> the feedback-outbox records that have no feedback-filed or feedback-dropped record
  jq -c '. as $a | [.[] | select(.kind == "feedback-outbox" and (.rec | type) == "object") | select(.key as $k | ($a | any(.key == $k and (.kind == "feedback-filed" or .kind == "feedback-dropped"))) | not)]' <<<"$1"
}

outbox_tracking() { # sets tracking and recs without the settings (reads only)
  local o
  o=$(tracking_obj) || exit $?
  [ -n "$o" ] || die 65 "no tracking issue; the maintainer runs init"
  tracking=$(jq -r .number <<<"$o")
  load_records
}

issue_live=""; plan_json=""

tracking_prelude() {
  gate_state
  case "$GATE" in paused) die 65 "paused" ;; "init needed") die 65 "no tracking issue; the maintainer runs init" ;; esac
  load_records
}

issue_prelude() { # mode
  tracking_prelude
  issue_live=$(gh api "repos/$repo/issues/$issue") || die 3 "cannot read issue $issue"
  jq -e --argjson t "$tracking" '(has("pull_request") | not) and .state == "open" and .number != $t' <<<"$issue_live" >/dev/null \
    || die 65 "issue $issue is closed, is a pull request or is the tracking issue"
  plan_json=$(make_plan "$1" "[$issue_live]") || exit $?
}

in_plan() { jq -e --argjson n "$issue" --arg c "${cause:-}" --argjson a "${attempt:-0}" "$1" <<<"$plan_json" >/dev/null; }

started_key() { # issue run -> the key of its build-started record, or nothing
  jq -r --argjson n "$1" --arg r "$2" '[.[] | select(.kind == "build-started" and .n == $n and .rec.run == $r)][0].key // empty' <<<"$recs"
}

do_needs_plan() { # issue key
  refuse_dup needs-plan "$2"
  add_labels "$1" needs-plan
  remove_labels "$1" needs-approval
  write_record needs-plan "$2" "$(jq -nc --argjson i "$1" '{issue: $i}')"
  echo "NOTICE needs-plan $repo $1"
}

put_adopt() {
  local labels
  issue_prelude triage
  in_plan 'any(.adopt[]; .issue == $n)' || die 65 "issue $issue has no 0.7.0 record to adopt, or has a state label"
  labels=$(jq -r --argjson n "$issue" '.adopt[] | select(.issue == $n) | .labels[]' <<<"$plan_json")
  would adopt "$issue"
  # shellcheck disable=SC2086
  add_labels "$issue" $labels
  echo "ok adopt $issue"
}

put_untrusted() {
  local h
  issue_prelude triage
  in_plan 'any(.untrusted[]; . == $n)' || die 65 "issue $issue is not waiting for the untrusted step"
  h=$(text_hash "$issue_live")
  would untrusted "$issue"
  add_labels "$issue" needs-approval untrusted-author
  write_record untrusted "$issue:$h:$(utc_stamp)" "$(jq -nc --arg h "$h" '{hash: $h}')"
  echo "ok untrusted $issue"
}

put_revoke() {
  local h
  issue_prelude triage
  in_plan 'any(.revoke[]; .issue == $n and .cause == $c)' || die 65 "issue $issue passes the live check, or fails it for another cause"
  h=$(text_hash "$issue_live")
  would revoke "$issue" "$cause"
  write_record revoked "$issue:$cause:$(utc_stamp)" "$(jq -nc --arg c "$cause" --arg h "$h" '{cause: $c, hash: $h}')"
  remove_labels "$issue" maintainer-approved ready-to-build
  add_labels "$issue" needs-approval
  echo "ok revoke $issue $cause"
}

put_triaged() {
  local epoch key rec final tlabel mark
  issue_prelude triage
  in_plan 'any(.eligible[]; . == $n)' || die 65 "issue $issue is not waiting for triage, or fails the live check"
  epoch=$(jq -r .f.epoch <<<"$plan_json")
  key="$issue:$epoch"
  refuse_dup triaged "$key"
  # The cut is done in jq so it counts code points and never splits a multibyte character.
  rec=$(jq -nc --arg d "$decision" --arg s "$size" --arg r "$risk" --arg t "$itype" --arg w "$why" '
    ([$w | match("[.!?](?= |\\z)"; "g") | select(.offset < 500) | .offset + 1] | last // 500) as $end
    | {decision: $d, size: $s, risk: $r, type: $t, why: (if ($w | length) > 500 then $w[:$end] else $w end)}
    | if ($w | length) > 500 then . + {whyCut: true} else . end
    | if .decision == "build" and (.size == "L" or .risk == "high") then . + {decision: "plan", triagerDecision: "build"} else . end')
  final=$(jq -r .decision <<<"$rec")
  # The labels go first: a failure after them leaves an issue that triage lists again, never one that no step reads.
  would triaged "$issue" "$final"
  tlabel=$(jq -r --arg t "$itype" '.typeLabels[$t]' <<<"$routine_cfg")
  case "$final" in
    decline)
      add_labels "$issue" declined "$tlabel" "size:$size"
      remove_labels "$issue" needs-approval
      write_record triaged "$key" "$rec"
      mark="Declined by the triage routine: $(jq -r .why <<<"$rec")"
      gh api --method POST "repos/$repo/issues/$issue/comments" -f body="$mark" >/dev/null || die 3 "could not post the decline reason" ;;
    build)
      add_labels "$issue" ready-to-build "$tlabel" "size:$size"
      remove_labels "$issue" needs-approval
      write_record triaged "$key" "$rec" ;;
    *)
      add_labels "$issue" needs-approval "$tlabel" "size:$size"
      write_record triaged "$key" "$rec" ;;
  esac
  echo "$rec"
}

put_triage_failed() {
  local key
  issue_prelude triage
  in_plan 'any(.eligible[]; . == $n)' || die 65 "issue $issue is not waiting for triage, or fails the live check"
  key="$issue:$(jq -r .f.epoch <<<"$plan_json")"
  refuse_dup triage-failed "$key"
  would triage-failed "$issue"
  add_labels "$issue" needs-maintainer
  write_record triage-failed "$key" '{"reason":"triage failed"}'
  echo "NOTICE triage-failed $repo $issue"
}

put_build_started() {
  local key rec first
  issue_prelude build
  in_plan 'any(.buildable[]; .issue == $n and .attempt == $a)' || die 65 "issue $issue is not ready to build as attempt $attempt"
  [ "$(jq -r .limitsHold <<<"$plan_json")" = false ] || die 65 "a limit holds"
  key="$issue:$attempt"
  refuse_dup build-started "$key"
  would build-started "$issue" "$attempt"
  rec=$(jq -nc --arg r "$run_id" --arg b "$branch" --argjson a "$attempt" '{run: $r, branch: $b, attempt: $a}')
  write_record build-started "$key" "$rec"
  # Two runs can pass the checks together. The oldest record of the key wins; the other run stops.
  # The losing record stays: the account may not be allowed to delete comments, and the planner reads only the first record of a key.
  load_records
  first=$(jq -r --arg k "$key" '[.[] | select(.kind == "build-started" and .key == $k)] | .[0].rec.run // ""' <<<"$recs")
  if [ -n "$first" ] && [ "$first" != "$run_id" ]; then die 66 "lost the race for attempt $attempt of issue $issue"; fi
  remove_labels "$issue" ready-to-build
  add_labels "$issue" building
  echo "$rec"
}

put_built() {
  local key rec why=""
  tracking_prelude
  key=$(started_key "$issue" "$run_id")
  [ -n "$key" ] || die 65 "no build-started record for issue $issue and run $run_id"
  refuse_dup built "$key"
  would built "$issue"
  if [ "$pr" = none ] && [ -n "$result_file" ]; then
    why=$(jq -r '.prs[0].reason // "" | if type == "string" then . else "" end' "$result_file") || die 64 "$result_file is not JSON"
  fi
  # One line, cut at a sentence end or 500 characters, as the why of a triaged record. The cut counts code points.
  rec=$(jq -nc --arg r "$run_id" --arg p "$pr" --arg d "$ready" --arg c "$reason" --arg w "$why" '
    ($w | gsub("\\p{Cc}"; " ") | gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "")) as $w
    | ([$w | match("[.!?](?= |\\z)"; "g") | select(.offset < 500) | .offset + 1] | last // 500) as $end
    | {run: $r, pr: (if $p == "none" then "none" else ($p | tonumber) end), ready: ($d == "true"), reasonCode: $c}
    | if $w != "" then . + {why: ((if ($w | length) > 500 then $w[:$end] else $w end) | gsub("@(?!​)"; "@​"))} else . end
    | if ($w | length) > 500 then . + {whyCut: true} else . end')
  write_record built "$key" "$rec"
  echo "ok built $issue"
}

blocked_comment() { # issue reasonCode why -> prints the comment body
  local first
  case "$2" in
    triage-plan) first="The build routine stopped and opened no PR. Its triage step decided that this issue needs a plan." ;;
    triage-decline) first="The build routine stopped and opened no PR. Its triage step decided to decline this issue." ;;
    rounds-exhausted) first="The build routine stopped and opened no PR. The review rounds ran out before the change was ready." ;;
    needs-human) first="The build routine stopped and opened no PR. A step needs a person to decide." ;;
    *) first="The build routine stopped and opened no PR." ;;
  esac
  # A zero-width space after each @ keeps the text from notifying anybody.
  jq -rn --arg f "$first" --arg w "$3" '$f + (if $w == "" then "" else "\n" + ($w | gsub("@(?!​)"; "@​")) end)'
}

put_blocked() {
  local key bid why body
  tracking_prelude
  key=$(started_key "$issue" "$run_id")
  [ -n "$key" ] || die 65 "no build-started record for issue $issue and run $run_id"
  refuse_dup blocked "$key"
  issue_live=$(gh api "repos/$repo/issues/$issue") || die 3 "cannot read issue $issue"
  would blocked "$issue"
  write_record blocked "$key" "$(jq -nc --arg r "$run_id" --arg c "$reason" --argjson a "${key#*:}" '{run: $r, reasonCode: $c, attempt: $a}')"
  bid=$REC_ID
  # triage-plan gets needs-plan, not build-failed; $exhausted reads the reason code of this record instead.
  [ "$reason" = triage-plan ] || add_labels "$issue" build-failed
  remove_labels "$issue" building ready-to-build maintainer-approved
  if [ "$reason" = triage-plan ]; then do_needs_plan "$issue" "$issue:$bid"; else echo "NOTICE blocked $repo $issue $run_id $reason"; fi
  why=$(jq -r --arg k "$key" '[.[] | select(.kind == "built" and .key == $k)] | last | .rec.why // "" | if type == "string" then . else "" end' <<<"$recs")
  body=$(blocked_comment "$issue" "$reason" "$why")
  gh api --method POST "repos/$repo/issues/$issue/comments" -f body="$body" >/dev/null \
    || echo "WARNING could not post the block comment on issue $issue" >&2
}

put_needs_plan() {
  local key
  issue_prelude build
  key=$(jq -r --argjson n "$issue" '[.needsPlan[] | select(.issue == $n)][0].key // empty' <<<"$plan_json")
  [ -n "$key" ] || die 65 "issue $issue needs no plan step"
  would needs-plan "$issue"
  do_needs_plan "$issue" "$key"
}

put_pr_seen() {
  issue_prelude build
  in_plan 'any(.prseen[]; . == $n)' || die 65 "issue $issue has no building label or no PR from its branch"
  would pr-seen "$issue"
  if jq -e --argjson n "$issue" 'any(.prseenFailed[]; . == $n)' <<<"$plan_json" >/dev/null; then add_labels "$issue" build-failed; fi
  remove_labels "$issue" building
  echo "ok pr-seen $issue"
}

put_exhausted() {
  issue_prelude build
  in_plan 'any(.exhausted[]; . == $n)' || die 65 "issue $issue has not used its attempts, or needs no notice"
  would exhausted "$issue"
  add_labels "$issue" needs-maintainer
  echo "NOTICE exhausted $repo $issue"
}

# env-stale and env-ok read only the tracking issue, the pause label and the stage, so an older release
# started from the highest installed root still works when the settings hold keys it does not know.
put_env() {
  local raw st tobj newest last_ok
  raw=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$repo/contents/.github/pipeline.json") || die 3 "cannot read .github/pipeline.json"
  st=$(jq -c 'if type == "object" and (.routine | type) == "object" then {ok: true, stage: (.routine.stage // 0)} else {ok: false} end' <<<"$raw") \
    || die 3 "pipeline.json is not JSON"
  tobj=$(tracking_obj) || exit $?
  [ -n "$tobj" ] || die 65 "no tracking issue; the maintainer runs init"
  if [ "$(jq -r .ok <<<"$st")" != true ] || jq -e 'any(.labels[]?; .name == "routine-paused")' <<<"$tobj" >/dev/null; then echo paused; return; fi
  stage=$(jq -r .stage <<<"$st")
  [[ $stage =~ ^[0-9]$ ]] || die 3 "routine.stage is not a stage"
  tracking=$(jq -r .number <<<"$tobj")
  would "$ptype" "$pin"
  load_records
  newest=$(jq -r '[.[] | select(.kind == "env-stale" or .kind == "env-ok")] | last | .kind // ""' <<<"$recs")
  if [ "$ptype" = env-stale ]; then
    last_ok=$(jq -r '[.[] | select(.kind == "env-ok") | .id] | max // 0' <<<"$recs")
    if jq -e --argjson o "$last_ok" 'any(.[]; .kind == "env-stale" and .id > $o)' <<<"$recs" >/dev/null; then echo known; return; fi
    write_record env-stale "$pin:$(utc_stamp)" "$(jq -nc --arg p "$pin" '{pin: $p}')"
    echo "NOTICE env-stale $repo $pin"
  elif [ "$newest" = env-stale ]; then
    write_record env-ok "$pin:$(utc_stamp)" "$(jq -nc --arg p "$pin" '{pin: $p}')"
  fi
}

open_outbox_or_die() { # run
  jq -e --arg r "$1" 'any(.[]; .key == $r)' <<<"$(open_outboxes "$recs")" >/dev/null || die 65 "run $1 is not an open outbox"
}

put_outbox() {
  tracking_prelude
  case "$ptype" in
    feedback-outbox)
      refuse_dup feedback-outbox "$run_arg_key"
      would feedback-outbox "$run_arg_key"
      write_record feedback-outbox "$run_arg_key" "$(jq -c . "$ofile")" ;;
    feedback-filed)
      open_outbox_or_die "$run_arg_key"
      would feedback-filed "$run_arg_key"
      write_record feedback-filed "$run_arg_key" "$(jq -c . <<<"$counts")" ;;
    feedback-dropped)
      open_outbox_or_die "$run_arg_key"
      would feedback-dropped "$run_arg_key"
      write_record feedback-dropped "$run_arg_key" '{}' ;;
  esac
  echo "ok $ptype $run_arg_key"
}

cloud_put() {
  case "$ptype" in
    adopt) put_adopt ;;
    untrusted) put_untrusted ;;
    revoke) put_revoke ;;
    triaged) put_triaged ;;
    triage-failed) put_triage_failed ;;
    build-started) put_build_started ;;
    built) put_built ;;
    blocked) put_blocked ;;
    needs-plan) put_needs_plan ;;
    pr-seen) put_pr_seen ;;
    exhausted) put_exhausted ;;
    env-stale|env-ok) put_env ;;
    feedback-outbox|feedback-filed|feedback-dropped) run_arg_key=$4; put_outbox ;;
  esac
}

cloud_main() {
  local open rec
  case "$cmd" in
    gate) gate_state; echo "$GATE" ;;
    next) cloud_next ;;
    issue-text) cloud_issue_text ;;
    list)
      outbox_tracking
      open=$(open_outboxes "$recs")
      jq -c '.[] | {run: .key, at: .at, ageSeconds: (now - (try (.at | fromdateiso8601) catch now) | floor)}' <<<"$open" ;;
    get)
      outbox_tracking
      open=$(open_outboxes "$recs")
      rec=$(jq -c --arg r "$4" '[.[] | select(.key == $r)] | last | .rec // empty' <<<"$open") || exit 3
      [ -n "$rec" ] || die 65 "run $4 is not an open outbox"
      echo "$rec" ;;
    put) cloud_put "$@" ;;
  esac
}


[ "$cloud" = 0 ] || cloud_validate "$@"

user=$(gh api user --jq .login) || die 3 "cannot read GET /user"
[ -n "$user" ] || die 3 "GET /user returned no login"

pages() { # path -> one JSON array of all pages
  local out
  out=$(gh api --paginate --slurp "$1") || die 3 "cannot read $1"
  printf '%s' "$out" | jq -c 'add // [] | if type == "array" then . else error("not a list") end' || die 3 "$1 is not a list"
}

tracking_obj() { # prints the open pipeline-routine issue as JSON, or nothing when there is none
  local objs
  objs=$(pages "repos/$repo/issues?state=open&labels=pipeline-routine&per_page=100" | jq -c --arg user "$user" \
    '[.[] | select((has("pull_request") | not) and .state == "open" and .user.login == $user and any(.labels[]?; .name == "pipeline-routine"))]') || exit $?
  [ "$(jq length <<<"$objs")" -le 1 ] || die 2 "more than one open pipeline-routine issue"
  jq -c '.[0] // empty' <<<"$objs"
}

tracking_number() { # prints the number, or nothing when there is none
  local o
  o=$(tracking_obj) || exit $?
  jq -r '.number // empty' <<<"$o"
}

trusted() { # comments-json prefix -> body or null
  printf '%s' "$1" | jq -r --arg prefix "$2" --arg user "$user" -f "$TRUSTED" || die 2 "more than one trusted comment starts with $2"
}

record_of() { # comments-json issue -> record JSON line, or nothing
  local body
  body=$(trusted "$1" "<!-- pipeline:routine triaged $2 -->") || exit $?
  [ "$body" = null ] && return 0
  printf '%s\n' "$body" | tail -n +2 | jq -ce "$TRIAGED_DEF select(triaged_valid)" || die 2 "the record for issue $2 is not valid"
}

TRIAGED_DEF='def triaged_valid: type == "object" and (.decision | IN("build", "plan", "decline"));'

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
  jq -c --arg t "$2" "$TRIAGED_DEF"'
    def valid:
      if $t == "triaged" then triaged_valid
      elif $t == "build-started" then (type == "object" and (.run | type) == "string" and (.run | test("^[0-9]{8}T[0-9]{6}Z-[0-9]+\\z")) and (.branch | type) == "string")
      else (type == "object" and (.reason | type) == "string" and (.run | type) == "string") end;
    if length == 0 then {state: "absent"}
    elif length > 1 then {state: "bad"}
    else (.[0] | split("\n") | (.[1] // "") | try fromjson catch null) as $r
      | if $r | valid then {state: "ok", rec: $r} else {state: "bad"} end end' <<<"$list"
}

triage_todo() { # comments-json on-bad (die|hold) -> fills todo; hold adds bad records to held
  local feedback candidates i rec st dc
  feedback=$(pages "repos/$repo/issues?state=open&labels=pipeline-feedback&per_page=100") || exit $?
  candidates=$(jq -r --arg user "$user" '[.[] | select((has("pull_request") | not) and .state == "open" and .user.login == $user and any(.labels[]?; .name == "pipeline-feedback"))]
    | sort_by(.created_at, .number) | .[].number' <<<"$feedback") || exit 3
  for i in $candidates; do
    if [ "$2" = die ]; then
      rec=$(record_of "$1" "$i") || exit $?
      if [ -z "$rec" ]; then st=absent; else st=ok; rec=$(jq -c '{rec: .}' <<<"$rec"); fi
    else
      rec=$(record_state "$1" triaged "$i") || exit $?
      st=$(jq -r .state <<<"$rec")
    fi
    case "$st" in
      absent) todo+=("$i") ;;
      bad) add_held "$i" "bad triaged record" ;;
      ok)
        if [ "$(jq -r .rec.decision <<<"$rec")" = decline ]; then
          dc=$(closed_by_account "$i") || exit $?
          [ "$dc" = false ] && todo+=("$i")
        fi ;;
    esac
  done
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

  local routine_issues numbers i bs bl tr block_issue="" block_run="" pending=() st hp
  routine_issues=$(pages "repos/$repo/issues?state=open&labels=routine-build&per_page=100") || exit $?
  numbers=$(jq -r '[.[] | select((has("pull_request") | not) and .state == "open" and any(.labels[]?; .name == "routine-build"))]
    | sort_by(.created_at, .number) | .[].number' <<<"$routine_issues") || exit 3
  for i in $numbers; do
    bs=$(record_state "$comments" build-started "$i") || exit $?
    bl=$(record_state "$comments" blocked "$i") || exit $?
    st=$(jq -r .state <<<"$bs")
    if [ "$(jq -r .state <<<"$bl")" != absent ]; then add_held "$i" "blocked"; continue; fi
    if [ "$st" = bad ]; then add_held "$i" "bad build-started record"; continue; fi
    if [ "$st" = ok ]; then
      if [ -z "$block_issue" ]; then
        hp=$(has_pr "$prefix" "$owner" "$i") || exit $?
        if [ "$hp" = false ]; then block_issue=$i; block_run=$(jq -r .rec.run <<<"$bs"); fi
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
    | jq -r '[.[] | split("\n") | (.[1] // "") | (try fromjson catch null) | objects | .run | strings | select(test("^[0-9]{8}T[0-9]{6}Z-[0-9]+\\z"))] | unique | length') || exit $?

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

  todo=()
  triage_todo "$comments" hold
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
    existing=$(trusted_all "$comments" "<!-- pipeline:routine blocked $issue -->") || exit $?
    [ "$(jq length <<<"$existing")" = 0 ] || die 65 "a blocked record for issue $issue exists"
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

if [ "$cloud" = 1 ]; then cloud_main "$@"; exit $?; fi

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
    todo=()
    triage_todo "$comments" die
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
