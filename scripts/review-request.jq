# Library for bot-approval.jq (include "review-request" {search: "./"}) and bot-status.sh (jq -L scripts). It holds the rules for a
# review of CodeRabbit that the session asked for by comment: the request, the push time and a completed review (the gate), and the
# body with no finding (the wait only: the gate's rule A refuses a count of 0), and the listing rule: line 2 of an answer comment
# can list review ids as <!-- pipeline-reviews <id>,<id> -->. The wait skips a listed review and the gate's rule A clears a listed review
# that holds only failed pre-merge checks. Both read the listing through listedReviewIds, so a change of that def changes both.
# No other file of scripts/ keeps a copy of these rules.

def requestText: "@coderabbitai full review";

# $user is the login from GET /user. The whole text must be the request, so a longer comment is not one.
def isRequest($user): .user.login == $user and ((.body // "") | gsub("^\\s+|\\s+$"; "")) == requestText;

# The earliest check suite of the head. The commit's own date is never read: a rebased or back-dated commit has a date
# that is not the time of the push. Null when the head has no check suite.
def pushTime($suites): [$suites[].created_at | strings] | min;

# A request counts for a run when it falls after the push and before the run started.
def requestedBetween($user; $from; $to): $from != null and $to != null
  and any(.[]; isRequest($user) and .created_at > $from and .created_at < $to);

def completedReview: .status == "completed" and .conclusion == "success" and (.output.title // "") == "Finished"
  and ((.output.summary // "") | startswith("Result: Success - Review completed"));

def stripComments: gsub("<!--(.|\n)*?-->"; "") | gsub("^\\s+|\\s+$"; "");

# The known no-finding texts. Any other text can hold a finding, so an unknown format never hides one.
def nofinding: test("^Gitar has auto-approved this PR"; "i")
  or (test("Actionable comments posted: 0") and (test("Outside diff range|Nitpick|Duplicate comments|comments \\([1-9]"; "i") | not));

# The review ids that the second line of each of the given answer comment bodies lists. The caller passes only trusted bodies.
def listedReviewIds($bodies): [$bodies[] | split("\n")[1] // "" | rtrimstr("\r") | capture("^<!-- pipeline-reviews (?<ids>[0-9]+(,[0-9]+)*) -->$") | .ids | split(",")[]];
