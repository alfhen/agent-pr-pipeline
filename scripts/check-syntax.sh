#!/usr/bin/env bash
# The one list of shell files that get a syntax check. AGENTS.md and CI call this script.
# Usage: check-syntax.sh [root]
set -u

root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$root" || exit 1

bad=0
count=0
for pattern in 'scripts/*.sh' 'routine/*.sh' 'routine/bin/gh' 'routine/bin-full/*'; do
  files=()
  while IFS= read -r f; do files+=("$f"); done < <(compgen -G "$pattern" | sort)
  if [ "${#files[@]}" -eq 0 ]; then
    echo "MISSING $pattern"
    bad=1
    continue
  fi
  for f in "${files[@]}"; do
    count=$((count + 1))
    if ! bash -n "$f" 2>/dev/null; then
      echo "SYNTAX $f"
      bad=1
    fi
  done
done

[ "$bad" -eq 0 ] || exit 1
echo "OK $count files"
