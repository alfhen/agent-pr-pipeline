# Input: {reviews, comments, checks, head, bots}: the PR's REST reviews and review comments, the check
# runs of its head commit, its head sha, and a regex for review-bot logins.
# Output: the bots that clear the gate, as "login" (approved) or "login (answered)".
# A bot clears it when its latest review is APPROVED, or when that review is COMMENTED on an older commit,
# every inline thread the bot opened has a reply, and the bot's own check run on the head finished with
# success. That check run is the proof the bot looked at the head: a finding that still holds would come
# back as a new review there. A CHANGES_REQUESTED without a later APPROVED from the same bot always blocks.
. as $in
| [$in.comments[] | select(.in_reply_to_id != null) | .in_reply_to_id] as $answered
| [$in.reviews[]
    | select(.user.login | test($in.bots))
    # A COMMENTED review with an empty body and no new top-level inline comment only carries thread
    # replies and holds no verdict. An empty body alone is not enough: Gitar's finding reviews are empty.
    | . as $rv
    | select($rv.state != "COMMENTED"
        or (($rv.body // "") | test("\\S"))
        or ([$in.comments[] | select(.pull_request_review_id == $rv.id and .in_reply_to_id == null)] | length) > 0)]
| group_by(.user.login)
| map(sort_by(.submitted_at)
    | . as $mine
    | last as $r
    | ($r.user.login | ascii_downcase) as $login
    | select(
        ([$mine[] | select(.state == "CHANGES_REQUESTED")] | last) as $cr
        | ($cr == null or ([$mine[] | select(.state == "APPROVED" and .submitted_at > $cr.submitted_at)] | length) > 0))
    | select(
        $r.state == "APPROVED"
        or ($r.state == "COMMENTED" and $r.commit_id != $in.head
            and ([$in.comments[] | select(.user.login == $r.user.login and .in_reply_to_id == null) | .id] - $answered | length) == 0
            and ([$in.checks[] | select((.name | ascii_downcase) as $check
                    | .status == "completed" and .conclusion == "success" and ($login | contains($check)))] | length) > 0))
    | $r.user.login + (if $r.state == "APPROVED" then "" else " (answered)" end))
