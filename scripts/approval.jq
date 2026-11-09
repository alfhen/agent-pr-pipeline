# Input: the issue's events (GET issues/<n>/events, pages joined into one array).
# Args: $maintainer, $label, $after (GitHub's time format YYYY-MM-DDTHH:MM:SSZ, may be empty; any other
# format is an error).
# Output: created_at of the newest `labeled` event for $label if the maintainer made it with no GitHub App
# mark and it is newer than $after; else null.
# The newest event decides, whoever made it: a session that re-adds a label the maintainer removed must
# not bring the old approval back. `unlabeled` events are never read: a session's removal carries no app
# mark, so it looks like the maintainer's. Removal is checked against the current labels by the caller.
# Events in the same second are ordered by id.
(if $after == "" then null
 elif ($after | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) then $after | fromdateiso8601
 else error("after must be YYYY-MM-DDTHH:MM:SSZ") end) as $cut
| [.[]?
  | select(type == "object" and .event == "labeled" and .label.name == $label and (.created_at | type) == "string")]
| sort_by([.created_at, (.id // 0)])
| last
| if . != null
    and .actor.login == $maintainer
    and .performed_via_github_app == null
    and ($cut == null or (.created_at | fromdateiso8601) > $cut)
  then .created_at else null end
