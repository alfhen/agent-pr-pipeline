#!/bin/bash
# usage: manifest.sh [--write|--check] [root]
#        manifest.sh --compare <files.txt>      (reads "<blob sha> <path>" lines of a tree on stdin)
# The release manifest .claude-plugin/files.txt: one line "<git blob sha> <path>" per shipped file, sorted by
# path. This is the only place that says which files ship. With no flag it prints the manifest.
# --check and --compare print MANIFEST OK, or one "MANIFEST <added|changed|missing> <path>" line each, exit 1.
set -u
SHIPPED='^((agents|scripts|workflows|templates|skills|routine/cloud)/|routine/(config\.jq|branch-prefix)$|\.claude-plugin/plugin\.json$)'

shipped() { awk -v re="$SHIPPED" '$2 ~ re' | LC_ALL=C sort -k2,2; }

# $1: the recorded manifest; stdin: the shipped lines of a tree.
compare() {
  local out
  out=$(awk '
    FILENAME == ARGV[1] { if (NF >= 2) b[$2] = $1; next }
    { a[$2] = $1 }
    END {
      for (p in a) { if (!(p in b)) print "MANIFEST added " p; else if (a[p] != b[p]) print "MANIFEST changed " p }
      for (p in b) if (!(p in a)) print "MANIFEST missing " p
    }' "$1" - | LC_ALL=C sort -k3,3)
  [ -z "$out" ] || { echo "$out"; return 1; }
  echo "MANIFEST OK"
}

if [ "${1:-}" = "--compare" ]; then
  [ -n "${2:-}" ] && [ -r "$2" ] || { echo "MANIFEST missing .claude-plugin/files.txt"; exit 1; }
  shipped | compare "$2"
  exit "${PIPESTATUS[1]}"
fi

mode=print
case "${1:-}" in --write|--check) mode=${1#--}; shift ;; esac
root=${1:-$(cd "$(dirname "$0")/.." && pwd)}
tree() { git -C "$root" ls-files -s | awk -F'[ \t]+' '{ print $2 " " $4 }' | shipped; }

case $mode in
  print) tree ;;
  write) tree > "$root/.claude-plugin/files.txt" ;;
  check)
    [ -f "$root/.claude-plugin/files.txt" ] || { echo "MANIFEST missing .claude-plugin/files.txt"; exit 1; }
    tree | compare "$root/.claude-plugin/files.txt"
    exit "${PIPESTATUS[1]}" ;;
esac
