# Input: {reviews, comments, head, bots} where reviews and comments are the REST lists for a PR,
# head is its head sha and bots a regex for review-bot logins.
# Output: the bots that clear the gate, as "login" (approved) or "login (answered)".
# A bot clears it when its latest review is APPROVED, or when that review is COMMENTED on an older
# commit and every inline thread the bot opened has a reply: bots review each push, so a finding that
# still holds comes back as a new review on the head.
. as $in
| [$in.comments[] | select(.in_reply_to_id != null) | .in_reply_to_id] as $answered
| [$in.reviews[] | select(.user.login | test($in.bots))]
| group_by(.user.login)
| map(sort_by(.submitted_at) | last)
| map(. as $r
    | select(
        $r.state == "APPROVED"
        or ($r.state == "COMMENTED" and $r.commit_id != $in.head
            and ([$in.comments[] | select(.user.login == $r.user.login and .in_reply_to_id == null) | .id] - $answered | length) == 0))
    | $r.user.login + (if $r.state == "APPROVED" then "" else " (answered)" end))
