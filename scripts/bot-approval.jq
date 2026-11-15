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
# Rule A accounts for the whole body of a review. The body must be exactly the known blocks of the real CodeRabbit bodies, each at
# most once and in the order the real bodies have them; any text left makes the body not match, and rule A refuses it.
def blk($title; $inner): "<details>\\s*<summary>\\s*" + $title + "</summary>\\s*<dl>\\s*<dd>\\s*" + $inner + "</dd>\\s*</dl>\\s*</details>";
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
def availLine: "\\*\\*Included review availability:\\*\\* This review used your included allowance\\. Your plan provides up to [0-9]+ included reviews? per hour; [0-9]+ remain after this review\\.\\s*";
def nitRe: "<details>\\s*<summary>\\s*Nitpick comments: (?<k>[0-9]+)</summary>\\s*<blockquote>\\s*<dl>\\s*<dd>\\s*<br>(?<inner>[\\s\\S]*?)</dd>\\s*</dl>\\s*</blockquote></details>\\s*</dd>\\s*</dl>\\s*</blockquote></details>";
def topRe: "^\\s*\\*\\*Actionable comments posted: (?<n>[0-9]+)\\*\\*\\s*"
  + "(?:" + nitRe + "\\s*)?"
  + "(?:---\\s*- \\[[ x]\\]\\s*Fix comments: Fix CodeRabbit comments on this PR\\s*(?:" + blk("Prompt to fix all issues"; "(?<fix>```\\n(?:(?!```)[\\s\\S])*\\n```)\\s*") + "\\s*)?)?"
  + "(?:<h6>\\s*<details>\\s*<summary>\\s*Review info</summary>\\s*<dl>\\s*<dd>\\s*<br>\\s*" + runCfg + "\\s*" + commitsBlk + "\\s*" + filesBlk + "\\s*(?:" + availLine + ")?</dd>\\s*</dl>\\s*</details>\\s*</h6>\\s*)?\\z";
def findingHead: "(?m)^`[0-9]+(?:-[0-9]+)?`: \\*\\*\\s*[A-Za-z]+\\*\\*(?: · \\*\\*[^*\\n]+\\*\\*)*[ \\t]*$";
def fileRe: "<details>\\s*<summary>\\s*(?<path>[^\\s<:`]+): (?<n>[0-9]+)</summary>\\s*<blockquote>\\s*<dl>\\s*<dd>\\s*<br>(?<fbody>[\\s\\S]*?)</dd>\\s*</dl>\\s*</blockquote></details>";
def aboveMinor: "(?<![A-Za-z])(Critical|Major|Blocker|High|Medium|Low|Potential issues?|Outside diff|Duplicate comments)(?![A-Za-z])";
# A finding is one bold title line, prose, and at most one prompt block at its end. A heading, a list or table line, a tag, a second
# bold-only line, a finding line or a word of a higher rank is a form no real fixture has.
def findingTextOk:
  sub("\\s*" + blk("Prompt for AI Agents"; oneFence) + "\\s*\\z"; "") as $t
  | ([$t | split("\n")[] | gsub("^\\s+|\\s+$"; "") | select(length > 0)]) as $ls
  | ($ls | length) > 0
    and ($ls[0] | test("^\\*\\*(?:(?!\\*\\*).)+\\*\\*$"))
    and all($ls[1:][]; test("^\\*\\*(?:(?!\\*\\*).)*\\*\\*$") | not)
    and all($ls[]; test("^([-*+]|[0-9]+[.)])\\s|^\\||^#|<[A-Za-z/!]|^Line [0-9]|^`[0-9]+(-[0-9]+)?`:") | not)
    and ($t | test(aboveMinor; "i") | not);
# The ranks of the findings of a nitpick section, or null when the section is not per-file blocks of findings in the real form.
# nitRe ends the inner before the closer of the last per-file block, so it is added back here.
def nitRanks($k):
  (. + "</dd></dl></blockquote></details>") as $x
  | [$x | match(fileRe; "g") | .captures | map(select(.name != null) | {(.name): .string}) | add] as $files
  | (if ($files | length) == 0 or ($x | gsub(fileRe; "") | test("\\S")) then null
    else
      [$files[] | . as $f
        | ($f.fbody | split(findingHead; "g")) as $parts
        | [$f.fbody | match(findingHead; "g").string] as $heads
        | if ($parts | length) - 1 == ($f.n | tonumber) and ($heads | length) > 0 and ($parts[0] | test("\\S") | not)
            and all($parts[1:][]; findingTextOk) and all($heads[]; sub("^[^*]*\\*\\*\\s*[A-Za-z]+\\*\\*"; "") | test(aboveMinor; "i") | not)
          then $heads[] | sub("^`[^`]*`: \\*\\*\\s*"; "") | sub("\\*\\*.*$"; "")
          else null end] as $r
      | if any($r[]; . == null) then null else $r end
    end)
  | if . != null and length != $k then null else . end;
# A failed pre-merge check is a finding of the body with no rank: one for each line "- <name> check:" under the label in the fence.
def failedChecks:
  if . == null then 0
  else sub("^[\\s\\S]*?Failed pre-merge checks:"; "") as $t
    | if $t == . then 0 else [$t | scan("(?m)^- [^\\n]+ check:[ \\t]*$")] | length end end;
# The parsed body: its count, nitpick ranks and failed checks, or null when the body is not exactly the known blocks.
def parseBody:
  ([capture(topRe)] | first) as $m
  | if $m == null then null
    else (if $m.inner == null then [] else ($m.inner | nitRanks($m.k | tonumber)) end) as $r
      | if $r == null or ($m.items != null and ([$m.items | scan("\\* `")] | length) != ($m.fc | tonumber)) then null
        else {n: ($m.n | tonumber), k: ($m.k // "0" | tonumber), ranks: $r, failed: ($m.fix | failedChecks)} end
    end;
# Problems of rule A for one review of the bot on the head: a list of texts, empty when the review passes.
# Second output: the findings its body ranks, which the answer comment must cover.
def ruleA($rv):
  ($rv.body // "" | stripComments | gsub("<picture>[\\s\\S]*?</picture>"; "")) as $body
  | ($body | parseBody) as $p
  | [$comments[] | select(.user.login == $cr and .in_reply_to_id == null and .pull_request_review_id == $rv.id)] as $inline
  | ($p.ranks // []) as $ranked
  | ($rv.id | tostring) as $id
  | {problems: ([
      (if ($body | length) > 0 and $p == null then "review " + $id + " has text that rule A does not know" else empty end),
      (if ($body | length) > 0 and $p != null and $p.n != ($inline | length) then "review " + $id + " says " + ($p.n | tostring) + " inline comments and has " + ($inline | length | tostring) else empty end),
      (if ($body | length) == 0 and ($inline | length) > 0 then "review " + $id + " has inline comments and no count" else empty end),
      (if any($ranked[]; isRankMinor | not) then "review " + $id + " ranks a finding above Minor or with a word rule A does not know" else empty end),
      (if any($inline[]; (.body // "" | rankOf) as $w | ($w == null or ($w | isRankMinor | not))) then "review " + $id + " has an inline comment above Minor or with no rank" else empty end),
      (if any($inline[] | . as $t | select(any($comments[]; .in_reply_to_id == $t.id and $user != null and .user.login == $user and (.body // "" | answerLine)) | not); true)
        then "review " + $id + " has an inline finding with no answer of the user" else empty end)
    ]), ranked: (($ranked | length) + ($p.failed // 0))};
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
