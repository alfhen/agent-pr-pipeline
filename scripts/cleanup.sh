#!/bin/bash
# usage: cleanup.sh init <tmp>
#        cleanup.sh clones <tmp> <id>|--all
#        cleanup.sh worktrees <owner/repo> <path>...
# Deletes the pipeline's own clones and finished worktrees. Prints one line per item, REMOVED or KEPT, and exits 0
# when it only kept things, so a cleanup never fails a PR. Exit 2 is a usage error.
# A worktree is removed without --force, and its branch is deleted with -D only after its head commit is on GitHub:
# PRs land by squash merge, so git branch -d never succeeds for a writer's branch.
MARK=.pipeline-tmp

usage() { echo "usage: cleanup.sh init <tmp> | clones <tmp> <id>|--all | worktrees <owner/repo> <path>..." >&2; exit 2; }
canon() { (cd "$1" 2>/dev/null && pwd -P); }

# Prints why a folder may not hold clones and returns 0 when it is refused. init and clones both ask, so a stale marker in a refused folder deletes nothing.
refused() {
  local tmp=$1 home shared
  home=$(canon "$HOME")
  if [ -z "$tmp" ] || [ "$tmp" = / ] || [ "$tmp" = "$home" ]; then echo "not a temp folder"; return 0; fi
  if [ "$(git -C "$tmp" rev-parse --show-toplevel 2>/dev/null)" = "$tmp" ]; then echo "top of a git repo"; return 0; fi
  for shared in /tmp /private/tmp "${TMPDIR:-}"; do
    [ -n "$shared" ] && [ "$tmp" = "$(canon "$shared")" ] && { echo "shared temp folder"; return 0; }
  done
  return 1
}

cmd=$1; shift
case "$cmd" in
  init)
    [ $# -eq 1 ] || usage
    mkdir -p "$1" || { echo "KEPT $1 cannot make the folder"; exit 0; }
    tmp=$(canon "$1")
    refusal=$(refused "$tmp") && { echo "KEPT $1 refused: $refusal"; exit 0; }
    if [ ! -f "$tmp/$MARK" ] && [ -n "$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]; then echo "KEPT $1 refused: has folders and no $MARK marker"; exit 0; fi
    : > "$tmp/$MARK" && echo "MARKED $tmp" || echo "KEPT $1 cannot write the marker"
    ;;
  clones)
    [ $# -eq 2 ] || usage
    tmp=$(canon "$1"); id=$2
    [ -n "$tmp" ] && [ -f "$tmp/$MARK" ] || { echo "KEPT $1 no $MARK marker"; exit 0; }
    refusal=$(refused "$tmp") && { echo "KEPT $1 refused: $refusal"; exit 0; }
    if [ "$id" = --all ]; then
      while IFS= read -r d; do
        if rm -rf "$d"; then echo "REMOVED $d"; else echo "KEPT $d cannot delete"; fi
      done < <(find "$tmp" -mindepth 1 -maxdepth 1 -type d)
      # Only the wave end removes these: another PR of the wave may still read one. find -type f skips symbolic links.
      while IFS= read -r f; do
        [[ "${f##*/}" =~ ^io-large\.[A-Za-z0-9]+$ ]] || continue
        if rm -f "$f"; then echo "REMOVED $f"; else echo "KEPT $f cannot delete"; fi
      done < <(find "$tmp" -mindepth 1 -maxdepth 1 -type f)
    else
      [[ "$id" =~ ^[A-Za-z0-9._]+$ ]] || { echo "KEPT $id not a plain id"; exit 0; }
      shopt -s nullglob
      for d in "$tmp"/*-"$id"-* "$tmp"/*-"$id"; do
        [ -d "$d" ] && [ ! -L "$d" ] || continue
        if rm -rf "$d"; then echo "REMOVED $d"; else echo "KEPT $d cannot delete"; fi
      done
    fi
    ;;
  worktrees)
    [ $# -ge 2 ] || usage
    R=$1; shift
    for p in "$@"; do
      path=$(canon "$p")
      keep() { echo "KEPT $p $1"; }
      [ -n "$path" ] || { keep "not a folder"; continue; }
      case "$path" in */.claude/worktrees/?*) ;; *) keep "not under a .claude/worktrees folder"; continue ;; esac
      [ "$(git -C "$path" rev-parse --show-toplevel 2>/dev/null)" = "$path" ] || { keep "not the top of a worktree"; continue; }
      common=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { keep "cannot find the repo"; continue; }
      [ "$(git -C "$path" rev-parse --absolute-git-dir)" != "$common" ] || { keep "the main checkout"; continue; }
      case "$(pwd -P)/" in "$path"/*) keep "the script runs inside it"; continue ;; esac
      status=$(git -C "$path" status --porcelain --untracked-files=all 2>&1) || { keep "cannot read the status"; continue; }
      [ -z "$status" ] || { keep "uncommitted or untracked changes"; continue; }
      sha=$(git -C "$path" rev-parse HEAD 2>/dev/null) || { keep "no head commit"; continue; }
      gh api "repos/$R/commits/$sha" --jq .sha >/dev/null 2>&1 || { keep "head $sha is not on GitHub"; continue; }
      branch=$(git -C "$path" symbolic-ref --short -q HEAD)
      out=$(git --git-dir="$common" worktree remove "$path" 2>&1) || { keep "git worktree remove refused: $(echo "$out" | head -n 1)"; continue; }
      msg="REMOVED $p"
      if [ -n "$branch" ]; then
        if out=$(git --git-dir="$common" branch -D "$branch" 2>&1); then msg="$msg branch $branch"
        else msg="$msg (branch $branch kept: $(echo "$out" | head -n 1))"; fi
      fi
      # Claude Code starts each worktree on worktree-<folder>; the writer then switches away, so that branch is left behind.
      auto="worktree-$(basename "$path")"
      if [ "$auto" != "$branch" ] && git --git-dir="$common" show-ref --verify -q "refs/heads/$auto"; then
        tip=$(git --git-dir="$common" rev-parse "refs/heads/$auto")
        if git --git-dir="$common" worktree list --porcelain | grep -qx "branch refs/heads/$auto"; then msg="$msg (branch $auto kept: checked out in another worktree)"
        elif git --git-dir="$common" merge-base --is-ancestor "$tip" "$sha" 2>/dev/null || gh api "repos/$R/commits/$tip" --jq .sha >/dev/null 2>&1; then
          if out=$(git --git-dir="$common" branch -D "$auto" 2>&1); then msg="$msg branch $auto"
          else msg="$msg (branch $auto kept: $(echo "$out" | head -n 1))"; fi
        else msg="$msg (branch $auto kept: tip $tip is not on GitHub)"; fi
      fi
      echo "$msg"
    done
    ;;
  *) usage ;;
esac
exit 0
