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
# Nitpick answer lines (nitAnswerLines) need the #N or "Note, not filed:" at the start of the line; an inline reply may hold #N anywhere.
def answerLine: gsub("^\\s+|\\s+$"; "") | (test("#[0-9]+") or startswith("Note, not filed:"));
# Rule A ranks inline findings, and the items of a nitpick block when the review has no count line and no inline comment.
# The body of a review must be exactly the frame of the real CodeRabbit bodies, each block at
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
# A nitpick block of the body: one group per file, one item per finding. Only the text of an item between its title and its
# markers is free; the frame of everything else is read as strictly as the rest of the body.
def itemHead($named): "`[0-9]+(?:-[0-9]+)?`: \\*\\*" + pic + "\\s*" + (if $named then "(?<w>[A-Za-z]+)" else "[A-Za-z]+" end) + "\\*\\*(?: · \\*\\*[^*\\n]+\\*\\*)*[ \\t]*\\n\\s*\\*\\*"
  + (if $named then "(?<t>[^\\n]+?)" else "[^\\n]+?" end) + "\\*\\*";
def nitItem: itemHead(false) + "\\s*(?:(?!<!-- ai-agent-prompt:start -->|<!-- cr-comment:)[\\s\\S])*"
  + "(?:<!-- ai-agent-prompt:start -->\\s*" + blk("Prompt for AI Agents"; oneFence) + "\\s*<!-- ai-agent-prompt:end -->\\s*)?"
  + "<!-- cr-comment:v1:[0-9a-f]+ -->\\s*(?:_Source: [^_\\n]+_\\s*)?";
def nitFile: "<details>\\s*<summary>[^<\\n]+?: [0-9]+</summary><blockquote>\\s*<dl>\\s*<dd>\\s*<br>\\s*(?:" + nitItem + ")+</dd>\\s*</dl>\\s*</blockquote></details>\\s*";
def nitBlk: "<details>\\s*<summary>\\s*" + pic + "Nitpick comments: (?<nn>[0-9]+)</summary><blockquote>\\s*<dl>\\s*<dd>\\s*<br>\\s*(?:" + nitFile + ")+</dd>\\s*</dl>\\s*</blockquote></details>\\s*";
def topRe: "\\A\\s*(?:\\*\\*Actionable comments posted: (?<n>[0-9]+)\\*\\*\\s*)?(?<nit>" + nitBlk + ")?"
  + "(?:---\\s*)?(?:- \\[[ x]\\]\\s*Fix comments: Fix CodeRabbit comments on this PR\\s*)?(?:" + blk("Prompt to fix all issues"; oneFence) + "\\s*)?"
  + "(?:<h6>\\s*<details>\\s*<summary>\\s*" + pic + "Review info</summary>\\s*<dl>\\s*<dd>\\s*<br>\\s*" + runCfg + "\\s*" + commitsBlk + "\\s*" + filesBlk + "\\s*(?:" + noRevBlk + "\\s*)?(?:" + availLine + ")?</dd>\\s*</dl>\\s*</details>\\s*</h6>\\s*)?\\z";
# The items of a nitpick block that topRe matched: the path of the file group, the rank word and the title of each, and whether the
# count of every file group and of the block fits.
def nitParse($nit; $total):
  [$nit | match("<details>\\s*<summary>(?<path>[^<\\n]+?): (?<k>[0-9]+)</summary><blockquote>"; "g")
    | {s: .offset, path: (.captures[0].string), k: (.captures[1].string | tonumber)}
    | select(.path | startswith("Nitpick comments") | not)] as $files
  | [range(0; $files | length) as $i
      | ($nit[$files[$i].s : (if $i + 1 < ($files | length) then $files[$i + 1].s else ($nit | length) end)]) as $chunk
      | ($chunk | gsub("<!-- ai-agent-prompt:start -->[\\s\\S]*?<!-- ai-agent-prompt:end -->"; "") | gsub("```[\\s\\S]*?```"; "")) as $heads
      | [$heads | capture(itemHead(true); "g") | {path: $files[$i].path, w, t}] as $its
      | {k: $files[$i].k, its: $its}] as $groups
  | ($groups | map(.its) | add // []) as $items
  | {items: $items, countsFit: (($items | length) == $total and all($groups[]; .k == (.its | length)))};
# The count of a body that is the frame and nothing else, or null. Each part of the frame can be absent. The text inside the fence
# of the prompt block is not read. A body with a nitpick block and no count line has the nitpick block read as well.
def parseBody:
  ([capture(topRe)] | first) as $m
  | if ($m == null or (test("\\S") | not)) or ($m.items != null and ([$m.items | scan("\\* `")] | length) != ($m.fc | tonumber))
      or ($m.nitems != null and ([$m.nitems | scan("\\* ")] | length) != ($m.nc | tonumber)) then null
    else {n: (if $m.n == null then null else $m.n | tonumber end), nit: (if $m.nn == null then null else nitParse($m.nit; $m.nn | tonumber) end)} end;
# The lines of the answer comment of the user for the head that are an answer line of a nitpick item: they start with #N or with
# "Note, not filed:". The marker is the one bot-status.sh reads.
def answerBodies: [$issue[] | objects | select($user != null and (.user | objects | .login) == $user and ((.body | strings) // "" | startswith("<!-- pipeline-bot-answer head=" + $in.head + " -->"))) | .body];
def nitAnswerLines: [answerBodies[] | split("\n")[1:][] | gsub("^\\s+|\\s+$"; "") | select(test("\\A#[0-9]+") or startswith("Note, not filed:"))];
def nitName: sub("[\\s.]+\\z"; "");
# The line names the item when, after its #N or "Note, not filed:" start, it holds the whole path and the whole title (a reason may
# follow). A substring match would let the path of one file clear an item of a file whose path it ends with, and the title of one
# item clear an item whose title it starts.
def reEsc: gsub("(?<c>[\\\\.^$*+?()\\[\\]{}|/-])"; "\\" + .c);
def nitNames($l; $it):
  ($l | gsub("`"; "") | sub("\\A#[0-9]+"; "") | ltrimstr("Note, not filed:") | gsub("^\\s+|\\s+$"; "")) as $r
  | ($it.path | gsub("`"; "")) as $p | ($it.t | gsub("`"; "") | nitName) as $t
  | ($r | test("(\\A|[\\s,:;(])" + ($p | reEsc) + "(\\z|[\\s,:;)])"))
    and ($r | test("(\\A|[\\s,:;(])" + ($t | reEsc) + "(\\z|[.:;,)])"));
def nitProblems($id; $nit):
  nitAnswerLines as $lines
  | $nit.items as $items
  | ((if $nit.countsFit | not then "review " + $id + " has a nitpick block whose number of items differs from its summary" else empty end),
     (if any($items[]; .w | isRankMinor | not) then "review " + $id + " has a nitpick item above Minor or with no rank" else empty end),
     (if answerBodies == [] then "review " + $id + " has a nitpick block and no pipeline-bot-answer comment of the user for the head, so its items have no answer"
       elif $lines == [] then "review " + $id + " has a nitpick block and the answer comment of the head has no answer line (#N or Note, not filed:)"
       else ($items[] | . as $it | select(any($lines[]; . as $l | nitNames($l; $it) and ([$items[] | select(nitNames($l; .))] | length) == 1) | not)
         | "review " + $id + " has a nitpick item (" + $it.path + ": " + $it.t + ") with no answer line of its own that names its path and its title") end));
# Problems of rule A for one review of the bot on the head: a list of texts, empty when the review passes. A review with an empty
# body and only replies is the container GitHub makes for a reply of the bot, and it has no problem.
def ruleA($rv):
  ($rv.body // "" | gsub(frameComment; "") | gsub("^\\s+|\\s+$"; "")) as $body
  | ($rv.body // "" | test("\\S")) as $nonEmpty
  | ($body | parseBody) as $p
  | [$comments[] | select(.user.login == $cr and .in_reply_to_id == null and .pull_request_review_id == $rv.id)] as $inline
  | ($rv.id | tostring) as $id
  | [
      (if $nonEmpty and ($body | test("Actionable comments posted: [0-9]+") | not) and ($body | test("Nitpick comments: [0-9]+</summary>") | not) then "review " + $id + " has no count line (Actionable comments posted: N)"
        elif $nonEmpty and $p == null then "review " + $id + " has text outside the frame of a review, which rule A does not read"
        elif $p != null and $p.n == 0 then "review " + $id + " has a count line of 0, so its finding is in its text"
        elif $p != null and $p.n == null and $p.nit == null then "review " + $id + " has no count line (Actionable comments posted: N)"
        elif $p != null and $p.n != null and $p.nit != null then "review " + $id + " has a count line and a nitpick block, which rule A does not read together"
        else empty end),
      (if $p != null and $p.n == null and $p.nit != null and ($inline | length) > 0 then "review " + $id + " has a nitpick block and an inline comment, which rule A does not read together" else empty end),
      (if $p != null and $p.n != null and $p.n != ($inline | length) then "review " + $id + " says " + ($p.n | tostring) + " inline comments and has " + ($inline | length | tostring) else empty end),
      (if ($nonEmpty | not) and ($inline | length) > 0 then "review " + $id + " has an empty body and a top-level inline comment" else empty end),
      (if any($inline[]; (.body // "" | rankOf) as $w | ($w == null or ($w | isRankMinor | not))) then "review " + $id + " has an inline comment above Minor or with no rank" else empty end),
      (if any($inline[] | . as $t | select(any($comments[]; .in_reply_to_id == $t.id and $user != null and .user.login == $user and (.body // "" | answerLine)) | not); true)
        then "review " + $id + " has an inline finding with no answer of the user" else empty end),
      (if $p != null and $p.n == null and $p.nit != null then nitProblems($id; $p.nit) else empty end)
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
