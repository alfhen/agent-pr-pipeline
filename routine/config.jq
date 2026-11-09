# Run with -f on a routine.json (0.7.0 form), or with --arg form pipeline on a whole .github/pipeline.json: prints the file or the routine
# object with defaults filled in, or fails with one line. Run with -n and no file: prints the defaults of both forms and the fixed labels.
def defaults: {openPRs: 3, wavesPerDay: 2, buildIssues: 3, maxRunMinutes: 240};
def cloudLimits: {openPRs: 3, wavesPerDay: 2, buildAttempts: 2, buildHours: 6, triagePerRun: 5, triagePerDay: 20, feedbackItems: 3, feedbackPerDay: 6};
def typeNames: ["bug", "feat", "docs", "chore", "test"];
def fixedLabels: ["ready-to-build", "needs-approval", "maintainer-approved", "declined", "building", "build-failed", "needs-plan", "needs-maintainer", "untrusted-author", "routine-paused", "size:S", "size:M", "size:L"];
def routineDefaults: {stage: 0, triageFrom: 1, skipLabels: ["review-minor"], typeLabels: (typeNames | map({key: ., value: .}) | from_entries), feedbackRepo: "alfhen/agent-pr-pipeline", collectFrom: [], limits: cloudLimits};
def bad($m): error("routine.json: " + $m);
def badp($m): error("pipeline.json: routine." + $m);
def int($lo; $hi): type == "number" and . == floor and . >= $lo and . <= $hi;
def login: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9-]*(\\[bot\\])?\\z");
def repo: type == "string" and test("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\\z");
def refusedWave: ["repo", "tmp", "pluginRoot", "agentPrefix", "prs", "plan", "feedback", "feedbackRepo", "resumeFromRunId", "cleanup"];
def allowedWave: ["goals", "checks", "e2ePattern", "e2eCommand", "relatedTests", "docs", "docsBuild", "bots", "botWaitMinutes", "architecture", "spec", "context", "skills", "steps", "qa", "maxRounds"];
def opt($k; $d): if has($k) and .[$k] != null then .[$k] else $d end;
def uniq: reduce .[] as $x ([]; if index([$x]) == null then . + [$x] else . end);

def routineCheck:
  if type != "object" then badp("must be an object") else . end
  | ((keys - ["stage", "pipelineVersion", "maintainer", "trustedAuthors", "triageFrom", "skipLabels", "typeLabels", "feedbackRepo", "collectFrom", "waveArgs", "limits"])[0] // null) as $extra
  | if $extra != null then badp("unknown key " + $extra) else . end
  | opt("stage"; 0) as $stage
  | if ($stage | int(0; 4) | not) then badp("stage must be an integer from 0 to 4")
    elif $stage > 1 then badp("stage " + ($stage | tostring) + " needs a later release") else . end
  | if (.pipelineVersion | type == "string" and test("^v[0-9]+\\.[0-9]+\\.[0-9]+\\z") | not) then badp("pipelineVersion must be a tag like v0.8.0") else . end
  | if (.maintainer | login | not) or (.maintainer | endswith("[bot]")) then badp("maintainer must be a login") else . end
  | .maintainer as $m
  | opt("trustedAuthors"; [$m]) as $ta
  | if ($ta | type) != "array" or any($ta[]; login | not) then badp("trustedAuthors must be a list of logins")
    elif any($ta[]; endswith("[bot]")) then badp("trustedAuthors must not hold a bot") else . end
  | opt("triageFrom"; 1) as $tf
  | if ($tf | int(1; 1e9) | not) then badp("triageFrom must be an integer of 1 or more") else . end
  | opt("skipLabels"; routineDefaults.skipLabels) as $sl
  | if ($sl | type) != "array" or any($sl[]; type != "string" or . == "") then badp("skipLabels must be a list of labels") else . end
  | opt("typeLabels"; {}) as $tl
  | if ($tl | type) != "object" then badp("typeLabels must be an object")
    elif (($tl | keys) - typeNames | length) > 0 then badp("unknown typeLabels key " + (($tl | keys) - typeNames)[0])
    elif any($tl[]; type != "string" or . == "") then badp("typeLabels values must be label names")
    elif any($tl[]; IN(fixedLabels[]) or . == "pipeline-routine") then badp("typeLabels values must not be a fixed label") else . end
  | opt("feedbackRepo"; routineDefaults.feedbackRepo) as $fr
  | if ($fr | repo | not) then badp("feedbackRepo must be owner/repo") else . end
  | opt("collectFrom"; []) as $cf
  | if ($cf | type) != "array" or any($cf[]; repo | not) then badp("collectFrom must be a list of owner/repo") else . end
  | (.waveArgs | if type == "object" then . else badp("waveArgs must be an object") end) as $w
  | if ($w.goals | type) != "string" then badp("waveArgs.goals must be a string") else . end
  | if ($w.checks | type) != "array" or any($w.checks[]; type != "string") then badp("waveArgs.checks must be a list of strings") else . end
  | (($w | keys) - ($w | keys - refusedWave))[0] as $refused
  | if $refused != null then badp("waveArgs." + $refused + " is not allowed") else . end
  | (($w | keys) - allowedWave)[0] as $unknownWave
  | if $unknownWave != null then badp("unknown waveArgs key " + $unknownWave) else . end
  | opt("limits"; {}) as $l
  | if ($l | type) != "object" then badp("limits must be an object") else . end
  | if (($l | keys) - (cloudLimits | keys) | length) > 0 then badp("unknown limit " + (($l | keys) - (cloudLimits | keys))[0]) else . end
  | (["openPRs", "wavesPerDay", "buildAttempts", "triagePerRun", "triagePerDay", "feedbackPerDay"][] as $k | select($l | has($k)) | select($l[$k] | int(0; 20) | not) | badp($k + " must be an integer from 0 to 20")) // .
  | if ($l | has("buildHours")) and ($l.buildHours | int(1; 48) | not) then badp("buildHours must be an integer from 1 to 48") else . end
  | if ($l | has("feedbackItems")) and ($l.feedbackItems | int(0; 3) | not) then badp("feedbackItems must be an integer from 0 to 3") else . end
  | {stage: $stage, pipelineVersion: .pipelineVersion, maintainer: $m,
     trustedAuthors: (([$m] + $ta) | uniq), triageFrom: $tf, skipLabels: (($sl + ["pipeline-routine"]) | uniq),
     typeLabels: (routineDefaults.typeLabels + $tl), feedbackRepo: $fr, collectFrom: $cf, waveArgs: $w, limits: (cloudLimits + $l)};

if input_filename == null and . == null then {limits: defaults, routine: routineDefaults, labels: fixedLabels}
elif $ARGS.named.form == "pipeline" then
  (if type == "object" then . else badp("must be a JSON object") end) |
  if (.routine // null) == null then {routine: null} else {routine: (.routine | routineCheck)} end
else
  (if type == "object" then . else bad("must be a JSON object") end)
  | ((keys - ["waveArgs", "limits"])[0] // null) as $extra
  | if $extra != null then bad("unknown key " + $extra) else . end
  | (.waveArgs | if type == "object" then . else bad("waveArgs must be an object") end) as $w
  | if ($w.goals | type) != "string" then bad("waveArgs.goals must be a string") else . end
  | if ($w.checks | type) != "array" or any($w.checks[]; type != "string") then bad("waveArgs.checks must be a list of strings") else . end
  | (($w | keys) - (($w | keys) - ["repo", "tmp", "pluginRoot", "prs", "plan", "feedback", "feedbackRepo", "resumeFromRunId"]))[0] as $refused
  | if $refused != null then bad("waveArgs." + $refused + " is not allowed") else . end
  | (.limits // {}) as $l
  | if ($l | type) != "object" then bad("limits must be an object") else . end
  | if (($l | keys) - ["openPRs", "wavesPerDay", "buildIssues", "maxRunMinutes"] | length) > 0 then bad("unknown limit " + (($l | keys) - ["openPRs", "wavesPerDay", "buildIssues", "maxRunMinutes"])[0]) else . end
  | (["openPRs", "wavesPerDay", "buildIssues"][] as $k | select($l | has($k)) | select($l[$k] | int(0; 20) | not) | bad($k + " must be an integer from 0 to 20")) // .
  | if ($l | has("maxRunMinutes")) and ($l.maxRunMinutes | int(10; 1440) | not) then bad("maxRunMinutes must be an integer from 10 to 1440") else . end
  | .limits = (defaults + $l)
end
