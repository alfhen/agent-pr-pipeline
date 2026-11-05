# Run with -f on a routine.json: prints the file with the limit defaults filled in, or fails with one line.
# Run with -n and no file: prints the defaults only.
def defaults: {openPRs: 3, wavesPerDay: 2, buildIssues: 3, maxRunMinutes: 240};
def bad($m): error("routine.json: " + $m);
def int($lo; $hi): type == "number" and . == floor and . >= $lo and . <= $hi;

if input_filename == null and . == null then {limits: defaults}
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
  | (["openPRs", "wavesPerDay", "buildIssues"][] as $k | select($l[$k] != null and ($l[$k] | int(0; 20) | not)) | bad($k + " must be an integer from 0 to 20")) // .
  | if $l.maxRunMinutes != null and ($l.maxRunMinutes | int(10; 1440) | not) then bad("maxRunMinutes must be an integer from 10 to 1440") else . end
  | .limits = (defaults + $l)
end
