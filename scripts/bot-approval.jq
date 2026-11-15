# Input: {reviews, comments, checks, head, bots, user}: the PR's REST reviews and review comments, the check
# runs of its head commit, its head sha, the review-bot logins (a list) and the login of
# the user from GET /user. With no user, only a bot's own reply answers one of its threads.
# Output: the bots that clear the gate, as "login" (approved on the head), "login (approved earlier)" or
# "login (answered)". bot-status.sh strips every suffix printed here.
# A bot clears it when its latest review is APPROVED on the head, or APPROVED on an older commit, or when
# that review is COMMENTED on an older commit and every inline thread the bot opened has a reply of the bot or of the user. On an
# older commit the bot's own check run on the head must also have finished with success. A run is the bot's when its App slug
# with [bot] added is the bot's login. That check run is the proof the bot looked at the head: a finding that still holds would come
# back as a new review there. A CHANGES_REQUESTED without a later APPROVED from the same bot always blocks.
. as $in
| $in.bots as $bots
| ($in.user // null) as $user
| def checkedHead($login): any($in.checks[]; .status == "completed" and .conclusion == "success" and ((.app.slug // "") != "") and (.app.slug + "[bot]") == $login);
def answered($t): any($in.comments[]; .in_reply_to_id == $t.id and (.user.login == $t.user.login or ($user != null and .user.login == $user)));
[$in.reviews[]
    | select(.user.login | IN($bots[]))
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
    | $r.user.login as $login
    | select(
        ([$mine[] | select(.state == "CHANGES_REQUESTED")] | last) as $cr
        | ($cr == null or ([$mine[] | select(.state == "APPROVED" and .submitted_at > $cr.submitted_at)] | length) > 0))
    | select(
        ($r.state == "APPROVED" and ($r.commit_id == $in.head or checkedHead($login)))
        or ($r.state == "COMMENTED" and $r.commit_id != $in.head
            and ([$in.comments[] | select(.user.login == $login and .in_reply_to_id == null) | select(answered(.) | not)] | length) == 0
            and checkedHead($login)))
    | $r.user.login + (if $r.state == "COMMENTED" then " (answered)" elif $r.commit_id != $in.head then " (approved earlier)" else "" end))
