#!/bin/bash
# usage: after-run.sh <owner/repo> <workflow output file> <temp folder> --run <wf_id> [--transcripts <folder>] [--land-fix] [--feedback <file>]
# Step 4 of the skill in one command: token-report.sh writes the run's token figures to <temp folder>/tokens-<run>.json,
# then ledger.sh put writes one ledger record per PR of the output file with those figures and the given run id.
# <run> is the run's wf_<id>, one per workflow start (a resume too). It is never taken from the transcript folder name.
# --land-fix goes on to ledger.sh put. --feedback goes on to token-report.sh. Without --transcripts the records say comparable false.
# Stops before any ledger call when token-report.sh refuses the output file. It never makes the ledger issue.
# Exit: 0 done, 64 bad argument, otherwise the code of token-report.sh (1) or ledger.sh (2, 3, 65).
set -u
usage="usage: after-run.sh <owner/repo> <workflow output file> <temp folder> --run <wf_id> [--transcripts <folder>] [--land-fix] [--feedback <file>]"
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
here=$(cd "$(dirname "$self")" && pwd -P)

pos=(); run=""; tdir=""; landfix=""; fb=""
while [ $# -gt 0 ]; do
  case "$1" in
    --run) [ $# -ge 2 ] || { echo "$usage" >&2; exit 64; }; run=$2; shift 2 ;;
    --transcripts) [ $# -ge 2 ] || { echo "$usage" >&2; exit 64; }; tdir=$2; shift 2 ;;
    --feedback) [ $# -ge 2 ] || { echo "$usage" >&2; exit 64; }; fb=$2; shift 2 ;;
    --land-fix) landfix=--land-fix; shift ;;
    -*) echo "$usage" >&2; exit 64 ;;
    *) pos+=("$1"); shift ;;
  esac
done
{ [ ${#pos[@]} -eq 3 ] && [ -n "$run" ]; } || { echo "$usage" >&2; exit 64; }
repo=${pos[0]}; out=${pos[1]}; tmp=${pos[2]}
[ -d "$tmp" ] || { echo "after-run: $tmp is not a folder" >&2; exit 64; }
[[ $run =~ ^[A-Za-z0-9_.:-]+$ ]] || { echo "$usage" >&2; exit 64; }

tokens="$tmp/tokens-$run.json"
targs=("$out")
[ -n "$tdir" ] && targs+=("$tdir")
targs+=(--json "$tokens")
[ -n "$fb" ] && targs+=(--feedback "$fb")
bash "$here/token-report.sh" "${targs[@]}" || exit $?

largs=("$repo" put "$out" --run "$run" --tokens "$tokens")
[ -n "$landfix" ] && largs+=("$landfix")
bash "$here/ledger.sh" "${largs[@]}"
