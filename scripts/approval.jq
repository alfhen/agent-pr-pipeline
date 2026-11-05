# Input: the issue's events (GET issues/<n>/events, pages joined into one array).
# Args: $maintainer, $label, $after (ISO time, may be empty).
# Output: created_at of the newest `labeled` event for $label if the maintainer made it with no GitHub App
# mark and it is newer than $after; else null.
# The newest event decides, whoever made it: a session that re-adds a label the maintainer removed must
# not bring the old approval back. `unlabeled` events are never read: a session's removal carries no app
# mark, so it looks like the maintainer's. Removal is checked against the current labels by the caller.
[.[]?
  | select(type == "object" and .event == "labeled" and .label.name == $label and (.created_at | type) == "string")]
| sort_by(.created_at)
| last
| if . != null
    and .actor.login == $maintainer
    and .performed_via_github_app == null
    and ($after == "" or .created_at > $after)
  then .created_at else null end
