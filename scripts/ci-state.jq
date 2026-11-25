# The one rule for the CI state of a head. Used by wait-ci.sh, land-wave.sh, merge-pr.sh and release.sh.
# Input: {runs: [{name, status, conclusion, details_url}], statuses: [{context, state}]}, the check runs and
# the commit statuses of one head. Use it as: jq -c -f ci-state.jq
# Output: {state, failed, failedRuns, failedStatuses, pending, noRuns}.
#   failed: names of failed check runs and failed commit statuses. failedRuns: {name, details_url} of the failed check runs.
#   failedStatuses: names of the failed commit statuses. A status can share its name with a run, so callers use this list, never a name match against failedRuns.
#   pending: names of check runs that are not complete and of pending commit statuses.
#   noRuns: the head has no check run at all.
#   state: failure when anything failed (even while another check is pending), else pending when anything is pending,
#   else noRuns when there is no check run, else success. A head with only commit statuses is never success.
# Fail closed: a completed run is green only with the conclusion success, skipped or neutral (so cancelled, stale and
# startup_failure fail), and a commit status is green only as success.
(.runs // []) as $r
| (.statuses // []) as $s
| [$r[] | select(.status == "completed" and (.conclusion | IN("success", "skipped", "neutral") | not))] as $badRuns
| [$s[] | select(.state != "success" and .state != "pending")] as $badSts
| ([$badRuns[].name] + [$badSts[].context]) as $failed
| ([$r[] | select(.status != "completed") | .name] + [$s[] | select(.state == "pending") | .context]) as $pending
| ($r | length == 0) as $noRuns
| {
    state: (if ($failed | length) > 0 then "failure" elif ($pending | length) > 0 then "pending" elif $noRuns then "noRuns" else "success" end),
    failed: $failed,
    failedRuns: [$badRuns[] | {name, details_url: (.details_url // "")}],
    failedStatuses: [$badSts[].context],
    pending: $pending,
    noRuns: $noRuns
  }
