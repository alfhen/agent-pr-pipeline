# Input: {reviews, comments, checks, head, bots, user, issueComments, suites}: the PR's REST reviews and review comments, the check
# runs of its head commit (with started_at, head_sha and the title and start of the summary), its head sha, the review-bot logins (a list),
# the login of the user from GET /user, the PR's comments and the check suites of the head. With no user, only a bot's own reply answers one
# of its threads.
# Output: the bots that clear the gate, as "login" (approved on the head), "login (approved earlier)", "login (answered)" or
# "coderabbitai[bot] (clean review)". bot-status.sh strips every suffix printed here. With --arg why 1 the output is one string instead:
# empty when a bot cleared, else a line that starts "clean review:" and names the first condition of the fourth way that did not hold.
# The fourth way: a completed, clean review that was asked for after the push (rules in review-request.jq), green CI, a reply of the
# user on every top-level inline comment, no unanswered change request, and rule A for the findings of the reviews on the head.
# A bot clears it when its latest review is APPROVED on the head, or APPROVED on an older commit, or when
# that review is COMMENTED on an older commit and every inline thread the bot opened has a reply of the bot or of the user. On an
# older commit the bot's own check run on the head must also have finished with success. A run is the bot's when its App slug
# with [bot] added is the bot's login. That check run is the proof the bot looked at the head: a finding that still holds would come
# back as a new review there. A CHANGES_REQUESTED without a later APPROVED from the same bot always blocks.
include "review-request" {search: "./"};
. as $in
| $in.bots as $bots
| ($in.user // null) as $user
| def checkedHead($login): any($in.checks[]; .status == "completed" and .conclusion == "success" and ((.app.slug // "") != "") and (.app.slug + "[bot]") == $login);
def answered($t): any($in.comments[]; .in_reply_to_id == $t.id and (.user.login == $t.user.login or ($user != null and .user.login == $user)));
( [$in.reviews[]
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
    | $r.user.login + (if $r.state == "COMMENTED" then " (answered)" elif $r.commit_id != $in.head then " (approved earlier)" else "" end)) ) as $old
| ($in.comments // []) as $comments
| ($in.issueComments // []) as $issue
| ($in.suites // []) as $suites
| ($in.checks // []) as $allChecks
| "coderabbitai[bot]" as $cr
| def isRankMinor: . == "Minor" or . == "Trivial";
# The rank word of an inline comment, as CodeRabbit writes it: **<picture>..</picture> Minor**.
def rankOf: stripComments | (first(capture("\\A\\*\\*(<picture>.*?</picture>)?\\s*(?<w>[A-Za-z]+)\\*\\*").w) // null);
def answerLine: gsub("^\\s+|\\s+$"; "") | (test("#[0-9]+") or startswith("Note, not filed:"));
# Rule A ranks inline findings only. The body of a review must be exactly the frame of the real CodeRabbit bodies, each block at
# most once and in their order; a section of findings or any other text left makes the body not match, and rule A refuses it.
def pic: "(?:<picture>(?:<(?:source|img)\\b[^>]*>\\s*)+</picture>\\s*)?";
def blk($title; $inner): "<details>\\s*<summary>\\s*" + pic + $title + "</summary>\\s*<dl>\\s*<dd>\\s*" + $inner + "</dd>\\s*</dl>\\s*</details>";
def oneFence: "```\\n(?:(?!```)[\\s\\S])*\\n```\\s*";
def ghUrl: "https://github\\.com/[A-Za-z0-9._/%@~-]+";
def ghLink($text): "\\[" + $text + "\\]\\(<" + ghUrl + ">\\)";
def cfgLine($key; $value): "- \\*\\*" + $key + "\\*\\*: " + $value + "[ \\t]*\\n\\s*";
def runCfg: blk("Run configuration"; "<br>\\s*"
  + cfgLine("Source mode"; "[A-Za-z]+") + cfgLine("Repository"; ghLink("[A-Za-z0-9._-]+/[A-Za-z0-9._-]+"))
  + cfgLine("Branch"; ghLink("[^\\]\\s]+")) + cfgLine("File"; ghLink("[^\\]\\s]+")) + cfgLine("Commit"; ghLink("[0-9a-f]+"))
  + cfgLine("Layers"; "Repository YAML") + cfgLine("Review profile"; "[A-Za-z]+") + cfgLine("Plan"; "[A-Za-z]+") + cfgLine("Run ID"; "`[0-9a-f-]+`"));
def commitsBlk: blk("Commits"; "<br>\\s*Reviewing files that changed from the base of the PR and between [0-9a-f]+ and [0-9a-f]+\\.\\s*");
def filesBlk: blk("Files selected for processing: (?<fc>[0-9]+)"; "<br>\\s*(?<items>(?:\\* `[^\\s`:<]+`\\s*)+)");
def noRevBlk: blk("Files with no reviewable changes: (?<nc>[0-9]+)"; "<br>\\s*(?<nitems>(?:\\* [^\\s`:<]+\\s*)+)");
def availLine: "\\*\\*Included review availability:\\*\\* This review used your included allowance\\. Your plan provides up to [0-9]+ included reviews? per hour; [0-9]+ remain after this review\\.\\s*";
# Only the HTML comments of the frame are cut, so any other comment is text that is left.
def frameComment: "<!-- (?:coderabbit-ai-generated:v[0-9]+|autofix_checkbox_start|autofix_checkbox_end|\\{\"checkboxId\":\"[0-9a-f-]+\"\\}"
  + "|This is an auto-generated comment by CodeRabbit for review status|coderabbit-review-publication v[0-9]+ publication=[0-9a-f-]+ attempt=[0-9a-f-]+ batch=[0-9]+/[0-9]+) -->";
def topRe: "\\A\\s*\\*\\*Actionable comments posted: (?<n>[0-9]+)\\*\\*\\s*"
  + "(?:---\\s*)?(?:- \\[[ x]\\]\\s*Fix comments: Fix CodeRabbit comments on this PR\\s*)?(?:" + blk("Prompt to fix all issues"; oneFence) + "\\s*)?"
  + "(?:<h6>\\s*<details>\\s*<summary>\\s*" + pic + "Review info</summary>\\s*<dl>\\s*<dd>\\s*<br>\\s*" + runCfg + "\\s*" + commitsBlk + "\\s*" + filesBlk + "\\s*(?:" + noRevBlk + "\\s*)?(?:" + availLine + ")?</dd>\\s*</dl>\\s*</details>\\s*</h6>\\s*)?\\z";
# The count of a body that is the frame and nothing else, or null. Each part of the frame can be absent. The text inside the fence
# of the prompt block is not read.
def parseBody:
  ([capture(topRe)] | first) as $m
  | if $m == null or ($m.items != null and ([$m.items | scan("\\* `")] | length) != ($m.fc | tonumber))
      or ($m.nitems != null and ([$m.nitems | scan("\\* ")] | length) != ($m.nc | tonumber)) then null
    else {n: ($m.n | tonumber)} end;
# Problems of rule A for one review of the bot on the head: a list of texts, empty when the review passes. A review with an empty
# body and only replies is the container GitHub makes for a reply of the bot, and it has no problem.
def ruleA($rv):
  ($rv.body // "" | gsub(frameComment; "") | gsub("^\\s+|\\s+$"; "")) as $body
  | ($rv.body // "" | test("\\S")) as $nonEmpty
  | ($body | parseBody) as $p
  | [$comments[] | select(.user.login == $cr and .in_reply_to_id == null and .pull_request_review_id == $rv.id)] as $inline
  | ($rv.id | tostring) as $id
  | [
      (if $nonEmpty and ($body | test("Actionable comments posted: [0-9]+") | not) then "review " + $id + " has no count line (Actionable comments posted: N)"
        elif $nonEmpty and $p == null then "review " + $id + " has text outside the frame of a review, which rule A does not read"
        elif $p != null and $p.n == 0 then "review " + $id + " has a count line of 0, so its finding is in its text"
        else empty end),
      (if $p != null and $p.n != ($inline | length) then "review " + $id + " says " + ($p.n | tostring) + " inline comments and has " + ($inline | length | tostring) else empty end),
      (if ($nonEmpty | not) and ($inline | length) > 0 then "review " + $id + " has an empty body and a top-level inline comment" else empty end),
      (if any($inline[]; (.body // "" | rankOf) as $w | ($w == null or ($w | isRankMinor | not))) then "review " + $id + " has an inline comment above Minor or with no rank" else empty end),
      (if any($inline[] | . as $t | select(any($comments[]; .in_reply_to_id == $t.id and $user != null and .user.login == $user and (.body // "" | answerLine)) | not); true)
        then "review " + $id + " has an inline finding with no answer of the user" else empty end)
    ];
def fourthWhy:
  ([$allChecks[] | select(.head_sha == null or .head_sha == $in.head)]) as $onHead
  | ([$onHead[] | select((.app.slug // "") != "" and (.app.slug + "[bot]") == $cr)] | sort_by(.started_at) | last) as $run
  | pushTime($suites) as $push
  | [$in.reviews[] | select(.user.login == $cr)] as $mine
  | [$mine[] | select(.commit_id == $in.head)] as $onHeadReviews
  | ([$onHeadReviews[] | ruleA(.)] | add // []) as $problems
  | if ($cr | IN($bots[]) | not) then "clean review: " + $cr + " is not in BOT_LOGINS"
    elif $run == null or ($run | completedReview | not) then "clean review: the bot's run on the head is not a completed, clean review (newest run: "
      + (if $run == null then "none" else ($run.status // "") + " " + ($run.conclusion // "") + " " + ($run.output.title // "") end) + ")"
    elif any($onHead[]; .status == "completed" and .conclusion == "success" and (.app.slug // "") != "" and ((.app.slug + "[bot]") | IN($bots[]) | not)) | not
      then "clean review: no green CI on the head (no completed, successful check run of an App other than a review bot)"
    elif $push == null then "clean review: the head has no check suite, so there is no push time and no request after it"
    elif ($user == null or ($issue | requestedBetween($user; $push; $run.started_at) | not))
      then "clean review: no request comment of the user with the text " + requestText + " made after the push time and before the review started"
    elif any($comments[]; .user.login == $cr and .in_reply_to_id == null and ($user == null or (. as $t | any($comments[]; .in_reply_to_id == $t.id and .user.login == $user) | not)))
      then "clean review: not every top-level inline comment of the bot has a reply of the user (replies missing)"
    elif ([$mine[] | select(.state == "CHANGES_REQUESTED")] | last) as $ch | $ch != null and ([$mine[] | select(.state == "APPROVED" and .submitted_at > $ch.submitted_at)] | length) == 0
      then "clean review: a CHANGES_REQUESTED review of the bot has no later approval"
    elif $problems != [] then "clean review: rule A: " + $problems[0]
    else null end;
($old | map(sub(" \\(.*\\)$"; ""))) as $oldLogins
| if $ARGS.named.why == "1" then (if ($old | length) > 0 then "" else (fourthWhy // "") end)
  else $old + (if ($oldLogins | index($cr)) == null and fourthWhy == null then [$cr + " (clean review)"] else [] end) end
