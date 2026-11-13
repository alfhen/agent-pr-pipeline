#!/bin/bash
# Usage: ledger.sh <owner/repo> init
#        ledger.sh <owner/repo> put <workflow output file> --run <id> [--tokens <file>] [--cloud] [--land-fix] [--dry-run]
#        ledger.sh <owner/repo> list
#        ledger.sh <owner/repo> backfill [--dry-run]
#        ledger.sh <owner/repo> report [--since <tag>] [--from <file of record lines>]
#        ledger.sh <owner/repo> hand <pr number> code|process
#        ledger.sh <owner/repo> miss <pr number> <issue number>
# The ledger is one open issue labelled pipeline-ledger, opened by the account from GET /user. It holds one comment for
# each PR of each run: a first line "<!-- pipeline:ledger v1 <run> <pr id> -->" and one fenced JSON record. A record counts
# only when scripts/trusted-comment.jq accepts it. Nothing but init makes the issue, so no repo gets one by itself.
# <run> is the run's wf_<id> for a local run, and the routine run id that `next` printed for a cloud run (--cloud).
# A cloud or totals record with no waveTotal is from before this split and has the wave total in raw and agents.
# --tokens is the file that token-report.sh --json wrote.A cloud record, and a local one whose tokens file is not comparable,
# keep the wave totals in tokens.waveTotal and tokens.waveAgents, so no PR record claims them as its own raw or agents. put writes one record per PR in the result, ready or not, and
# writes nothing for a run and PR that has a record. list prints one JSON line per record: when two records have one run
# and PR id, only the one with the lowest comment id counts, here and in report. put deletes its own record when it is
# not the lowest after the post; a refused delete is logged and does not fail put.
# An eval miss is a defect that no eval caught. put writes one for a PR that has codeChangedByBots true, ready or not (the
# only place that rule lives); miss writes one for a defect traced to a merged PR later. report counts a PR once, however many.
# backfill writes one record per merged PR that has none, with the facts GitHub holds and no tokens.
# report reads the merge mode and the bot threads from GitHub for each merged PR, in one function that backfill uses too.
# --dry-run prints the records and writes nothing, and works with no ledger issue. report --from reads those lines.
# Exit: 0 done, 2 two ledger issues, 3 a call to GitHub failed, 64 bad argument, 65 refused (no ledger issue, bad file).
set -uo pipefail
export LC_ALL=C

self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
here=$(cd "$(dirname "$self")" && pwd -P)
TRUSTED="$here/trusted-comment.jq"
LABEL=pipeline-ledger
PREFIX='<!-- pipeline:ledger v1 '

die() { local code=$1; shift; echo "ledger: $*" >&2; exit "$code"; }
usage() { die 64 "usage: ledger.sh <owner/repo> init|put <output file> --run <id> [--tokens <file>] [--cloud] [--land-fix] [--dry-run]|list|backfill [--dry-run]|report [--since <tag>] [--from <file>]|hand <pr> code|process|miss <pr> <issue>"; }

repo=${1:-}; cmd=${2:-}
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
shift 2 2>/dev/null || usage
out=""; run_id=""; tokfile=""; cloud=0; landfix=0; dry=0; since=""; from=""; hpr=""; hkind=""; mississue=""
case "$cmd" in
  init|list) [ $# -eq 0 ] || usage ;;
  put)
    [ $# -ge 1 ] || usage
    out=$1; shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --run) [ $# -ge 2 ] || usage; run_id=$2; shift 2 ;;
        --tokens) [ $# -ge 2 ] || usage; tokfile=$2; shift 2 ;;
        --cloud) cloud=1; shift ;;
        --land-fix) landfix=1; shift ;;
        --dry-run) dry=1; shift ;;
        *) usage ;;
      esac
    done
    [[ $run_id =~ ^[A-Za-z0-9_.:-]+$ ]] || usage ;;
  backfill) if [ $# -eq 1 ] && [ "$1" = --dry-run ]; then dry=1; else [ $# -eq 0 ] || usage; fi ;;
  report)
    while [ $# -gt 0 ]; do
      case "$1" in
        --since) [ $# -ge 2 ] || usage; since=$2; shift 2 ;;
        --from) [ $# -ge 2 ] || usage; from=$2; shift 2 ;;
        *) usage ;;
      esac
    done ;;
  hand) [ $# -eq 2 ] || usage; hpr=$1; hkind=$2
    [[ $hpr =~ ^[0-9]+$ ]] && [[ $hkind == code || $hkind == process ]] || usage ;;
  miss) [ $# -eq 2 ] || usage; hpr=$1; mississue=$2
    [[ $hpr =~ ^[1-9][0-9]{0,8}$ ]] && [[ $mississue =~ ^[1-9][0-9]{0,8}$ ]] || usage ;;
  *) usage ;;
esac

pages() { # path -> one JSON array of all pages
  local p
  p=$(gh api --paginate --slurp "$1") || return 3
  jq -c 'add // []' <<<"$p" || return 3
}

user=""; issue=""
need_user() { [ -n "$user" ] || user=$(gh api user --jq .login) || die 3 "cannot read GET /user"; [ -n "$user" ] || die 3 "GET /user gave no login"; }
find_issue() { # sets issue to the ledger issue number, or "" when there is none
  need_user
  local list n
  list=$(pages "repos/$repo/issues?state=open&labels=$LABEL&per_page=100") || die 3 "cannot list the ledger issue"
  n=$(jq -c --arg u "$user" '[.[] | objects | select((has("pull_request") | not) and .user.login == $u and any(.labels[]?; .name == "pipeline-ledger")) | .number]' <<<"$list") || die 3 "unexpected issue list"
  [ "$(jq length <<<"$n")" -le 1 ] || die 2 "more than one open $LABEL issue"
  issue=$(jq -r '.[0] // ""' <<<"$n")
}
need_issue() { find_issue; [ -n "$issue" ] || die 65 "no ledger issue in $repo: ask the maintainer to run init"; }

# Parses the trusted ledger comments into records. A cloud session proxy may add a footer after the closing fence.
# With $1 = raw, a run and PR id that has several records keeps all of them.
PARSE='
[.[] | objects
  | select((.user | objects | .login) == $user and (.body | type) == "string" and (.body as $b | any($t[0][]; . == $b)))
  | (.body | capture("^<!-- pipeline:ledger v1 (?<run>[^ ]+) (?<pr>[^ ]+) -->\\s*\\n```json\\n(?<json>.*)\\n```(\\s*---\\s*_Generated by \\[Claude Code\\]\\([^)]*\\)_)?\\s*$"; "s")?) as $h
  | (.id) as $id
  | ($h.json | try fromjson catch null) as $r
  | select(($r | type) == "object")
  | $r + {commentId: $id, _key: "\($h.run) \($h.pr)"}]
| sort_by(.commentId)
| if $raw == "1" then . else unique_by(._key) end'
records_json() {
  local comments trusted
  comments=$(pages "repos/$repo/issues/$issue/comments") || die 3 "cannot read the ledger comments"
  trusted=$(jq -c --arg prefix "$PREFIX" --arg user "$user" --arg all 1 -f "$TRUSTED" <<<"$comments") || die 3 "cannot read the trusted comments"
  jq -c --slurpfile t <(printf '%s' "$trusted") --arg user "$user" --arg raw "${1:-}" "$PARSE" <<<"$comments" || die 3 "cannot parse the ledger comments"
}

post_record() { # <run> <pr id> <record json>: prints the new comment id
  local body
  body="${PREFIX}$1 $2 -->
\`\`\`json
$3
\`\`\`"
  gh api --method POST "repos/$repo/issues/$issue/comments" -f body="$body" --jq .id || return 3
}

# The facts GitHub holds about a merged PR: the merge mode of the merge-cleared record and the bot threads.
github_facts() { # <pr number> -> {mergeMode, botThreads}
  local c rc mode threads
  c=$(pages "repos/$repo/issues/$1/comments") || die 3 "cannot read the comments of #$1"
  mode=$(jq -r --arg prefix '<!-- pipeline:merge-cleared ' --arg user "$user" --arg all 1 -f "$TRUSTED" <<<"$c" | jq -r 'last // "" | split(" ")[2] // ""') || die 3 "cannot read the merge record of #$1"
  rc=$(pages "repos/$repo/pulls/$1/comments") || die 3 "cannot read the review comments of #$1"
  threads=$(jq '[.[] | objects | select(.in_reply_to_id == null and (.user.type == "Bot" or ((.user.login // "") | endswith("[bot]"))))] | length' <<<"$rc") || die 3 "cannot read the review comments of #$1"
  jq -nc --arg m "$mode" --argjson t "$threads" '{mergeMode: (if $m == "" then null else $m end), botThreads: $t}'
}

merged_prs() { # [<since date>] -> [{number, mergedAt, body}]
  local p
  p=$(pages "repos/$repo/pulls?state=closed&per_page=100") || die 3 "cannot list the pull requests"
  jq -c --arg since "${1:-}" '[.[] | objects | select(.merged_at != null and ($since == "" or .merged_at > $since)) | {number, mergedAt: .merged_at, body: (.body // "")}]' <<<"$p" || die 3 "unexpected pull request list"
}

case "$cmd" in
  init)
    find_issue
    if [ -n "$issue" ]; then echo "$issue"; exit 0; fi
    n=$(gh api --method POST "repos/$repo/issues" -f title="Pipeline ledger" -f "labels[]=$LABEL" \
      -f body="One comment per PR per run, written by the pipeline's ledger.sh. Do not edit or close this issue." --jq .number) || die 3 "could not open the ledger issue"
    echo "$n" ;;

  list)
    need_issue
    records_json | jq -c '.[]' ;;

  put)
    [ -f "$out" ] || die 65 "$out is not a file"
    tokens=null
    if [ -n "$tokfile" ]; then
      [ "$cloud" = 0 ] || die 64 "--tokens and --cloud do not go together"
      tokens=$(jq -c . "$tokfile" 2>/dev/null) || die 65 "$tokfile is not JSON"
    fi
    version=$(jq -r '.version // ""' "$here/../.claude-plugin/plugin.json" 2>/dev/null || true)
    kind=wave; [ "$landfix" = 1 ] && kind=land-fix
    recs=$(jq -c --arg repo "$repo" --arg run "$run_id" --arg kind "$kind" --arg ver "$version" --argjson cloud "$cloud" --argjson tk "$tokens" '
      def ids: if type == "array" then map(select(type == "string" or type == "number") | tostring) else [] end;
      . as $root
      | (.result.prs // .prs) as $prs
      | if ($prs | type) != "array" then error("no prs in the output file") else . end
      | $prs[] | objects | . as $p
      | ($p.id | tostring) as $id
      | ($p.history | if type == "array" then [.[] | objects | select((.round | type) == "number" and .round == (.round | floor))] else [] end) as $rows
      | (if $cloud == 1 then {source: "cloud", comparable: false, byRole: null, raw: null, noCacheRead: null, weighted: null, agents: null, wallMinutes: null, waveTotal: ($root.totalTokens // null), waveAgents: ($root.agentCount // null)}
         elif $tk == null then null
         elif $tk.comparable == true then (first($tk.prs[]? | select(.id == $id) | {source: "transcripts", comparable: true, byRole, raw, noCacheRead, weighted, agents, wallMinutes}) // null)
         else {source: "totals", comparable: false, byRole: null, raw: null, noCacheRead: null, weighted: null, agents: null, wallMinutes: null, waveTotal: ($tk.totals.totalTokens // null), waveAgents: ($tk.totals.agentCount // null)} end) as $tok
      | (if $tk != null and $tk.comparable == true then (first($tk.prs[]? | select(.id == $id) | .minorPass.weighted) // null) else null end) as $minorCost
      | def bc($k): [($p.breakCheck | objects | .[$k]) | arrays | ids[]];
      def byRound($k): [$rows[] | select((.evals | type) == "object") | {key: (.round | tostring), value: (.evals[$k] | ids)} | select(.value | length > 0)] | from_entries;
      {v: 1, repo: $repo, run: $run, pluginVersion: (if $ver == "" then null else $ver end), kind: $kind,
       pr: {id: $id, number: ($p.prNumber | if type == "number" then . else null end)},
       ready: ($p.ready == true), reason: ($p.reason // null),
       rounds: (if ($p.history | type) == "array" then ($rows | length) else 0 end),
       evals: ({count: (if ($p.evals | type) == "array" then ($p.evals | length) else ([$rows[] | .evals | objects | (.passed, .failed, .ci) | ids[]] | unique | length) end),
               passed: byRound("passed"), failed: byRound("failed"), ci: byRound("ci")}
              + ({fails: bc("fails"), passes: bc("passes"), notRun: bc("notRun"), notApplicable: bc("notApplicable")} as $b | if ([$b[]] | add | length) > 0 then {breakCheck: $b} else {} end)),
       minorPass: (if ($p.minorPass | type) == "object" and $p.minorPass.ran == true
                   then {ran: true, kept: ($p.minorPass.kept == true), why: ($p.minorPass.why // null), weighted: $minorCost}
                   else {ran: false, kept: null, why: null, weighted: null} end),
       codeChangedByBots: ($p.codeChangedByBots == true),
       evalMisses: (($p.evalMisses | if type == "array" then . else [] end) as $m
                    | if $p.codeChangedByBots == true and ($m | any(.[]?; type == "object" and .source == "bot") | not) then $m + [{source: "bot"}] else $m end),
       tokens: $tok}' "$out" 2>&1) || die 65 "$out is not a workflow output with prs: $recs"
    [ -n "$recs" ] || exit 0
    if [ "$dry" = 1 ]; then find_issue; else need_issue; fi
    existing='[]'
    if [ -n "$issue" ]; then existing=$(records_json raw) || exit $?; fi
    while IFS= read -r rec; do
      id=$(jq -r .pr.id <<<"$rec")
      if jq -e --arg run "$run_id" --arg id "$id" 'any(.[]; .run == $run and .pr.id == $id)' <<<"$existing" >/dev/null; then
        echo "ledger: $id has a record for run $run_id already, nothing written" >&2; continue
      fi
      if [ "$dry" = 1 ]; then echo "$rec"; continue; fi
      cid=$(post_record "$run_id" "$id" "$rec") || die 3 "could not post the record of $id"
      echo "ledger: wrote the record of $id (comment $cid)"
      all=$(records_json raw) || exit $?
      low=$(jq -r --arg run "$run_id" --arg id "$id" '[.[] | select(.run == $run and .pr.id == $id) | .commentId] | min // ""' <<<"$all")
      if [ -n "$cid" ] && [ -n "$low" ] && [ "$low" != "$cid" ]; then
        if gh api --method DELETE "repos/$repo/issues/comments/$cid" >/dev/null 2>&1; then
          echo "ledger: deleted the later record $cid of $id"
        else
          echo "ledger: could not delete the later record $cid of $id, the readers ignore it" >&2
        fi
      fi
    done <<<"$recs"
    exit 0 ;;

  backfill)
    if [ "$dry" = 1 ]; then find_issue; else need_issue; fi
    existing='[]'
    if [ -n "$issue" ]; then existing=$(records_json raw) || exit $?; fi
    merged=$(merged_prs) || exit $?
    need_user
    todo=$(jq -c --slurpfile e <(printf '%s' "$existing") '[.[] | select(.number as $n | any($e[0][]; .pr.number == $n and (.kind != "miss" and .kind != "hand")) | not)]' <<<"$merged") || die 3 "could not list the PRs without a record"
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      n=$(jq -r .number <<<"$p")
      facts=$(github_facts "$n") || exit $?
      rec=$(jq -nc --arg repo "$repo" --argjson p "$p" --argjson f "$facts" '
        first(($p.body | capture("(?i)\\bno blockers or majors after round (?<n>[0-9]+)")), ($p.body | capture("(?i)(?<n>[0-9]+)(?: review)? rounds?\\b")), ($p.body | capture("(?i)\\brounds?:\\s*(?<n>[0-9]+)")), {n: null}) as $m
        | {v: 1, repo: $repo, run: "backfill", pluginVersion: null, kind: "backfill", pr: {id: "pr-\($p.number)", number: $p.number},
           ready: true, reason: null, rounds: ($m.n | if . == null then null else tonumber end), evals: null, minorPass: null,
           codeChangedByBots: null, evalMisses: [], tokens: null, github: $f}') || die 3 "could not build the record of #$n"
      if [ "$dry" = 1 ]; then echo "$rec"; continue; fi
      cid=$(post_record backfill "pr-$n" "$rec") || die 3 "could not post the record of #$n"
      echo "ledger: wrote the record of #$n (comment $cid)"
    done < <(jq -c '.[]' <<<"$todo")
    exit 0 ;;

  hand)
    need_issue
    ts=$(date +%s)
    rec=$(jq -nc --arg repo "$repo" --argjson n "$hpr" --arg k "$hkind" '{v: 1, repo: $repo, run: "hand", pluginVersion: null, kind: "hand", handFix: $k,
      pr: {id: "#\($n)", number: $n}, ready: null, reason: null, rounds: null, evals: null, minorPass: null, codeChangedByBots: null, evalMisses: [], tokens: null}')
    cid=$(post_record "hand-$ts" "#$hpr" "$rec") || die 3 "could not post the hand fix"
    echo "ledger: wrote a $hkind hand fix for #$hpr (comment $cid)"
    exit 0 ;;

  miss)
    need_issue
    ts=$(date +%s)
    rec=$(jq -nc --arg repo "$repo" --argjson n "$hpr" --argjson i "$mississue" '{v: 1, repo: $repo, run: "miss", pluginVersion: null, kind: "miss",
      pr: {id: "#\($n)", number: $n}, ready: null, reason: null, rounds: null, evals: null, minorPass: null, codeChangedByBots: null, evalMisses: [{source: "later", issue: $i}], tokens: null}')
    cid=$(post_record "miss-$ts-$mississue" "#$hpr" "$rec") || die 3 "could not post the eval miss"
    echo "ledger: wrote an eval miss for #$hpr from issue #$mississue (comment $cid)"
    exit 0 ;;

  report)
    sincedate=""
    if [ -n "$since" ]; then
      [ -z "$from" ] || usage
      need_user
      sincedate=$(gh api "repos/$repo/commits/$since" --jq .commit.committer.date) || die 3 "cannot read the tag $since"
      [ -n "$sincedate" ] || die 3 "the tag $since has no date"
    fi
    if [ -n "$from" ]; then
      [ -f "$from" ] || die 65 "$from is not a file"
      records=$(jq -c -s '[.[] | objects]' "$from" 2>/dev/null) || die 65 "$from is not JSON lines"
      merged=$(jq -c '[.[] | .pr.number | select(. != null)] | unique | map({number: .})' <<<"$records")
      facts=$(jq -c '[.[] | select(.github != null and .pr.number != null) | {key: (.pr.number | tostring), value: .github}] | from_entries' <<<"$records")
    else
      need_issue
      records=$(records_json) || exit $?
      merged=$(merged_prs "$sincedate") || exit $?
      merged=$(jq -c 'map({number, mergedAt})' <<<"$merged") || die 3 "unexpected pull request list"
      facts='{}'
      todo=$(jq -r --slurpfile r <(printf '%s' "$records") '($r[0] | map(.pr.number | numbers)) as $have | .[].number | select(IN($have[]))' <<<"$merged") || die 3 "unexpected pull request list"
      for n in $todo; do
        f=$(github_facts "$n") || exit $?
        facts=$(jq -c --arg n "$n" --argjson f "$f" '. + {($n): $f}' <<<"$facts")
      done
    fi
    jq -nr --slurpfile records <(printf '%s' "$records") --slurpfile merged <(printf '%s' "$merged") --slurpfile facts <(printf '%s' "$facts") --arg since "$since" '
      def median: sort | if length == 0 then null elif length % 2 == 1 then .[(length - 1) / 2] else (.[length / 2 - 1] + .[length / 2]) / 2 end;
      def mean: if length == 0 then null else add / length end;
      def num: if . == null then "n/a" else ((. * 10 | round) / 10 | tostring) end;
      $records[0] as $records | $merged[0] as $merged | $facts[0] as $facts
      | ($merged | map(.number)) as $mn
      | ($records | map(select(.pr.number != null))) as $numbered
      | [$records[] | . as $r
          | . + {gkey: (if .pr.number != null then .pr.number
                        else ([$numbered[] | select(.pr.id == $r.pr.id and .repo == $r.repo and .commentId > $r.commentId)] | min_by(.commentId) | .pr.number) end)}] as $joined
      | ($joined | map(select(.gkey == null)) | length) as $unjoined
      | [$joined[] | select(.gkey != null and (.gkey | IN($mn[])))]
      | group_by(.gkey)
      | map(. as $g | ($facts[$g[0].gkey | tostring] // {}) as $f | {
          weighted: ([$g[].tokens.weighted | numbers] | if length > 0 then add else null end),
          noCache: ([$g[].tokens.noCacheRead | numbers] | if length > 0 then add else null end),
          rounds: ([$g[] | select(.kind != "land-fix" and .kind != "hand" and .kind != "miss") | .rounds | numbers] | if length > 0 then max else null end),
          touches: (([$g[] | .reason | strings | select(test("^(needs human:|no progress:|rounds exhausted: the fix changed nothing|checks failed twice:|head moved:|head unknown:|evals check:|evals refused:|fix not saved:|evals missing:|run failed:)"))] | length) + (if $f.mergeMode == "person" then 1 else 0 end)),
          miss: any($g[]; (.evalMisses | arrays | length) > 0),
          defect: any($g[]; .codeChangedByBots == true or ((.evalMisses | arrays | length) > 0)),
          landFixes: ([$g[] | select(.kind == "land-fix")] | length),
          hands: [$g[] | select(.kind == "hand") | .handFix],
          botThreads: ($f.botThreads // 0)}) as $rows
      | ($rows | length) as $n
      | ([$rows[].weighted | numbers]) as $w | ([$rows[].noCache | numbers]) as $nc
      | ([$rows[].rounds | numbers]) as $r
      | (($rows | map(.rounds) | map(select(. == null)) | length)) as $noRounds
      | "Report over \($n) merged PRs\(if $since != "" then " since \($since)" else "" end).",
        "Weighted tokens per merged PR: median \($w | median | num), mean \($w | mean | num), over \($w | length) PRs with tokens.",
        "Tokens without cache reads per merged PR: median \($nc | median | num), mean \($nc | mean | num).",
        "Rounds per merged PR: median \($r | median | num), over \($r | length) PRs, and \($noRounds) PRs have no round count.",
        "PRs with 4 or more rounds: \([$r[] | select(. >= 4)] | length) of \($r | length).",
        "Maintainer touches per PR: \(if $n == 0 then "n/a" else ([$rows[].touches] | add) / $n | num end), \([$rows[].touches] | add // 0) in all.",
        "Defects found after sign-off: \([$rows[] | select(.defect)] | length) PRs.",
        "Eval misses: \([$rows[] | select(.miss)] | length) PRs.",
        "Land fixes: \([$rows[].landFixes] | add // 0) records on \([$rows[] | select(.landFixes > 0)] | length) PRs, counted apart from defects.",
        "Hand fixes: \([$rows[].hands[] | select(. == "code")] | length) by code, \([$rows[].hands[] | select(. == "process")] | length) by process.",
        "Bot threads: \([$rows[].botThreads] | add // 0) in all.",
        "Records left out because no later record of the PR has a number: \($unjoined).",
        "Records with no tokens: \([$rows[] | select(.weighted == null)] | length) of \($n) PRs."' || die 3 "could not build the report" ;;
esac
