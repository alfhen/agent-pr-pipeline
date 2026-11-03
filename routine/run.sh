#!/bin/bash
# Usage: run.sh   (the launchd job runs <guard>/plugin/routine/run.sh, never a file in a clone)
# One run of the routine for the repo named in <guard>/repo. Layout, set up by install.sh:
#   <home>/routine/<owner>-<repo>/{plugin,mode,repo,lock,logs}   guard folder, outside every clone
#   <home>/work/<owner>-<repo>/clone                              what the session may read
# Without work to do it starts no session. Exit 0 on idle, a live lock or a finished session; 1 on an error.
set -uo pipefail
export LC_ALL=C

self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
here=$(cd "$(dirname "$self")" && pwd -P)
plugin=$(cd "$here/.." && pwd -P)
guard=$(cd "$plugin/.." && pwd -P)
repo=$(tr -d '[:space:]' < "$guard/repo" 2>/dev/null || true)
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "run.sh: $guard/repo is missing or invalid" >&2; exit 1; }
work="$(cd "$guard/../.." && pwd -P)/work/${repo//\//-}"
clone="$work/clone"
logs="$guard/logs"

mkdir -p "$logs" "$work" || exit 1
logfile="$logs/$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
log() { echo "$(date -u +%FT%TZ) $*" >> "$logfile"; }

version=$(jq -r '.version // "unknown"' "$plugin/.claude-plugin/plugin.json" 2>/dev/null || echo unknown)
log "agent-pr-pipeline $version repo $repo"

# Files the session could reach stay read-only. A plugin update changes nothing until install.sh runs.
chmod -R a-w "$plugin" 2>/dev/null
chmod a-w "$guard/mode" "$guard/repo" 2>/dev/null
find "$logs" -name '*.log' ! -path "$logfile" -exec chmod a-w {} + 2>/dev/null

mode=$(tr -d '[:space:]' < "$guard/mode" 2>/dev/null || true)
case "$mode" in
  observe|triage) ;;
  *) log "mode file is missing or says '${mode}'; acting as observe"; mode=observe ;;
esac
log "mode $mode"

lockdir="$guard/lock"
take_lock() { mkdir "$lockdir" 2>/dev/null && echo $$ > "$lockdir/pid"; }
if ! take_lock; then
  pid=$(cat "$lockdir/pid" 2>/dev/null || true)
  if [ -z "$pid" ]; then sleep 1; pid=$(cat "$lockdir/pid" 2>/dev/null || true); fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "another run is live (pid $pid); nothing to do"
    exit 0
  fi
  log "stale lock (pid ${pid:-none}); taking it over"
  rm -rf "$lockdir"
  take_lock || { log "cannot take the lock"; exit 1; }
fi
trap 'rm -rf "$lockdir"' EXIT

if [ ! -d "$clone/.git" ]; then
  git clone --quiet "https://github.com/$repo.git" "$clone" >> "$logfile" 2>&1 || { log "cannot clone $repo"; exit 1; }
fi
{
  git -C "$clone" fetch --quiet origin &&
  git -C "$clone" remote set-head origin --auto >/dev/null &&
  git -C "$clone" checkout --quiet --force --detach origin/HEAD &&
  git -C "$clone" clean --quiet -fdx
} >> "$logfile" 2>&1 || { log "cannot reset the clone to the default branch"; exit 1; }

# The settings allow the wrapper and routine-state.sh by absolute path only. PATH is not a boundary: the session's
# shell can put another gh first. routine-state.sh runs here with the real gh.
export PATH="$plugin/scripts:$PATH"
cd "$clone" || exit 1
next=$(routine-state.sh "$repo" next 2>> "$logfile")
rc=$?
if [ $rc -ne 0 ]; then
  log "routine-state.sh next failed with exit $rc; no session"
  exit 1
fi
step=$(jq -r '.step // empty' <<<"$next" 2>/dev/null || true)
log "next: $next"
case "$step" in
  triage) ;;
  idle) log "idle; no session"; exit 0 ;;
  "init needed") log "init needed: the maintainer runs routine-state.sh $repo init; no session"; exit 0 ;;
  *) log "unexpected output from next; no session"; exit 1 ;;
esac

if [ "$mode" = observe ]; then
  last="$logs/last-next"
  if [ -f "$last" ] && [ "$(cat "$last")" = "$next" ]; then
    log "observe: same work as the last run; no session"
    exit 0
  fi
fi

prompt_file="$plugin/routine/prompt.md"
if [ -f "$prompt_file" ]; then
  prompt=$(cat "$prompt_file")
else
  prompt="Run $plugin/scripts/routine-state.sh $repo next and say what you would do for each issue. Change nothing."
fi

log "starting session"
PATH="$plugin/routine/bin:$PATH" claude -p "$prompt" \
  --permission-mode dontAsk \
  --settings "$plugin/routine/settings/$mode.json" \
  --setting-sources "" \
  --plugin-dir "$plugin" \
  --strict-mcp-config >> "$logfile" 2>&1
rc=$?
log "session ended with exit $rc"
# The key is recorded only after success, so a failed session is tried again on the next run.
if [ "$mode" = observe ] && [ $rc -eq 0 ]; then printf '%s' "$next" > "$last"; fi
exit $rc
