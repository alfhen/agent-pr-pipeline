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
# The rank word of an inline comment or of a finding line, as CodeRabbit writes it: **<picture>..</picture> Minor**.
def rankOf: stripComments | (first(capture("^\\*\\*(<picture>.*?</picture>)?\\s*(?<w>[A-Za-z]+)\\*\\*").w) // null);
def answerLine: gsub("^\\s+|\\s+$"; "") | (test("#[0-9]+") or startswith("Note, not filed:"));
# Rule A accounts for the whole body of a review: it cuts the blocks of the real CodeRabbit bodies (the count line, the nitpick
# section, the autofix checkbox, the block "Prompt to fix all issues", the review-info blocks) and refuses when any text is left.
# A form that no real body has is never cut, so it is left and refused. The nitpick section is cut only when every part of it is
# a per-file head, a finding line, finding text or a prompt block.
def blk($title; $inner): "<details>\\s*<summary>\\s*" + $title + "</summary>\\s*<dl>\\s*<dd>\\s*" + $inner + "</dd>\\s*</dl>\\s*</details>";
def nitRe: "<details>\\s*<summary>\\s*Nitpick comments: (?<k>[0-9]+)</summary>\\s*<blockquote>\\s*<dl>\\s*<dd>\\s*<br>(?<inner>[\\s\\S]*?)</dd>\\s*</dl>\\s*</blockquote></details>\\s*</dd>\\s*</dl>\\s*</blockquote></details>";
def findingHead: "(?m)^`[^`\\n]+`: \\*\\*\\s*[A-Za-z]+\\*\\*[^\\n]*$";
def fileRe: "<details>\\s*<summary>\\s*(?<path>[^\\s<:`]+): (?<n>[0-9]+)</summary>\\s*<blockquote>\\s*<dl>\\s*<dd>\\s*<br>(?<fbody>[\\s\\S]*?)</dd>\\s*</dl>\\s*</blockquote></details>";
# Finding text may not hold the form of a finding line, a heading, a count heading, a rank word above Minor or a layout tag.
def findingTextBad: test("(?m)^\\s*(- |\\* )?Line [0-9]|^\\s*`[0-9]+(-[0-9]+)?`:|^#{1,6}\\s|^\\s*\\*\\*[^*\\n]*: [0-9]+\\*\\*\\s*$|[*_]{1,2}\\s*(Critical|Major|Blocker|High|Medium|Low)\\s*[*_]{1,2}|</?(details|summary|dl|dd|blockquote|h[1-6]|table|p|b)[ >]"; "i");
# nitRe ends the inner before the closer of the last per-file block, so it is added back here.
# The nitpick inner is only per-file blocks; each block is its head, then finding heads with their text, and N of the head is the number of finding heads.
def nitInnerOk:
  . + "</dd></dl></blockquote></details>" | gsub(blk("Prompt for AI Agents"; "```[\\s\\S]*?```\\s*"); "") as $x
  | [$x | match(fileRe; "g") | .captures | map(select(.name != null) | {(.name): .string}) | add] as $files
  | ($files | length) > 0
    and ($x | gsub(fileRe; "") | test("\\S") | not)
    and all($files[]; (.fbody | split(findingHead; "g")) as $parts
      | ($parts | length) > 1 and ($parts | length) - 1 == (.n | tonumber) and ($parts[0] | test("\\S") | not) and all($parts[1:][]; findingTextBad | not));
def cutKnown:
  . as $b
  | [match(nitRe; "g") | .captures | map(select(.name != null) | {(.name): .string}) | add] as $secs
  | (if ($secs | length) > 0 and all($secs[]; .inner | nitInnerOk) then {text: ($b | gsub(nitRe; "")), secs: $secs} else {text: $b, secs: []} end) as $c
  | {secs: $c.secs, left: ($c.text
      | gsub("\\*\\*Actionable comments posted: [0-9]+\\*\\*"; "")
      | gsub(blk("Prompt to fix all issues"; "```[\\s\\S]*?```\\s*"); "")
      | gsub("(?m)^---\\s*$"; "")
      | gsub("- \\[[ x]\\]\\s*Fix comments: Fix CodeRabbit comments on this PR"; "")
      | gsub(blk("Run configuration"; "<br>\\s*(- \\*\\*(Source mode|Repository|Branch|File|Commit|Layers|Review profile|Plan|Run ID)\\*\\*: [^\\n]*\\n\\s*)+"); "")
      | gsub(blk("Commits"; "<br>\\s*Reviewing files that changed from the base of the PR and between [0-9a-f]+ and [0-9a-f]+\\.\\s*"); "")
      | gsub(blk("Files selected for processing: [0-9]+"; "<br>\\s*(\\* `[^`\\n]+`\\s*)+"); "")
      | gsub("<h6>\\s*<details>\\s*<summary>\\s*Review info</summary>\\s*<dl>\\s*<dd>\\s*<br>\\s*(\\*\\*Included review availability:\\*\\* This review used your included allowance\\. Your plan provides up to [0-9]+ included reviews? per hour; [0-9]+ remain after this review\\.\\s*)?</dd>\\s*</dl>\\s*</details>\\s*</h6>"; ""))};
# Problems of rule A for one review of the bot on the head: a list of texts, empty when the review passes.
# Second output: the findings its body ranks, which the answer comment must cover.
def ruleA($rv):
  ($rv.body // "" | stripComments | gsub("<picture>[\\s\\S]*?</picture>"; "")) as $body
  | ($body | cutKnown) as $cut
  | [$comments[] | select(.user.login == $cr and .in_reply_to_id == null and .pull_request_review_id == $rv.id)] as $inline
  | [$cut.secs[].inner | scan("(?m)^`[^`\n]+`: \\*\\*\\s*([A-Za-z]+)\\*\\*") | .[0]] as $ranked
  | ([$body | scan("\\*\\*Actionable comments posted: ([0-9]+)\\*\\*") | .[0]]) as $counts
  | (if ($counts | length) == 1 then ($counts[0] | tonumber) else null end) as $n
  | ([$cut.secs[].k | tonumber] | add // 0) as $k
  | ($rv.id | tostring) as $id
  | {problems: ([
      (if ($body | length) > 0 and ($cut.left | test("\\S")) then "review " + $id + " has text that rule A does not know" else empty end),
      (if ($body | length) > 0 and $n == null then "review " + $id + " has no single Actionable comments count" else empty end),
      (if ($body | length) > 0 and $n != null and $n != ($inline | length) then "review " + $id + " says " + ($n | tostring) + " inline comments and has " + ($inline | length | tostring) else empty end),
      (if ($body | length) == 0 and ($inline | length) > 0 then "review " + $id + " has inline comments and no count" else empty end),
      (if ($ranked | length) != $k then "review " + $id + " counts " + ($k | tostring) + " nitpicks and ranks " + ($ranked | length | tostring) else empty end),
      (if any($ranked[]; isRankMinor | not) then "review " + $id + " ranks a finding above Minor or with a word rule A does not know" else empty end),
      (if any($inline[]; (.body // "" | rankOf) as $w | ($w == null or ($w | isRankMinor | not))) then "review " + $id + " has an inline comment above Minor or with no rank" else empty end),
      (if any($inline[] | . as $t | select(any($comments[]; .in_reply_to_id == $t.id and $user != null and .user.login == $user and (.body // "" | answerLine)) | not); true)
        then "review " + $id + " has an inline finding with no answer of the user" else empty end)
    ]), ranked: ($ranked | length)};
def fourthWhy:
  ([$allChecks[] | select(.head_sha == null or .head_sha == $in.head)]) as $onHead
  | ([$onHead[] | select((.app.slug // "") != "" and (.app.slug + "[bot]") == $cr)] | sort_by(.started_at) | last) as $run
  | pushTime($suites) as $push
  | [$in.reviews[] | select(.user.login == $cr)] as $mine
  | [$mine[] | select(.commit_id == $in.head)] as $onHeadReviews
  | ([$onHeadReviews[] | ruleA(.)]) as $checked
  | ([$issue[] | select($user != null and .user.login == $user and ((.body // "") | startswith("<!-- pipeline-bot-answer head=" + $in.head + " -->")))] | sort_by(.created_at) | last) as $answer
  | (($onHeadReviews | map(.submitted_at) | max) // "") as $lastReview
  | ($checked | map(.ranked) | add // 0) as $need
  | (if $answer == null then 0 else [$answer.body | split("\n")[] | select(answerLine)] | length end) as $have
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
    elif ($checked | map(.problems) | add // []) != [] then "clean review: rule A: " + (($checked | map(.problems) | add)[0])
    elif $need > 0 and ($answer == null or $answer.created_at <= $lastReview) then "clean review: rule A: no answer comment of the user for this head made after the newest review"
    elif $have < $need then "clean review: rule A: " + ($have | tostring) + " answer lines for " + ($need | tostring) + " findings in the review bodies"
    else null end;
($old | map(sub(" \\(.*\\)$"; ""))) as $oldLogins
| if $ARGS.named.why == "1" then (if ($old | length) > 0 then "" else (fourthWhy // "") end)
  else $old + (if ($oldLogins | index($cr)) == null and fourthWhy == null then [$cr + " (clean review)"] else [] end) end
