#!/usr/bin/env bash
# Reads branchlist.md up to the first empty line, then generates branchcommands.md
# with compare links, pr-review, pr-summary, and git branch -f commands.
#
# Repo-agnostic: operates on whichever git repo you are currently inside
# (resolved via `git rev-parse --show-toplevel`), so a single copy on PATH
# works in every checkout. The GitHub slug for compare links is derived from
# `git remote get-url origin`.

set -euo pipefail

# Locate the repo you're standing in (not where this script lives — once this
# file is symlinked into ~/scripts, its own dir is the dotfiles repo).
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: not inside a git repository." >&2
  exit 1
}

AWC_DIR="$REPO_ROOT/.agent-context/active-work-context"
INPUT="$AWC_DIR/branchlist.md"
OUTPUT="$AWC_DIR/branchcommands.md"

# Derive "owner/repo" from origin, normalizing both URL forms:
#   https://github.com/OWNER/REPO(.git)  ->  OWNER/REPO
#   git@github.com:OWNER/REPO(.git)      ->  OWNER/REPO
origin_url="$(git remote get-url origin 2>/dev/null || true)"
slug="${origin_url%.git}"
slug="${slug#*github.com[:/]}"
if [[ -z "$slug" || "$slug" == *://* || "$slug" == *github.com* ]]; then
  echo "Warning: could not derive a GitHub slug from origin ('$origin_url'); compare links may be wrong." >&2
fi
COMPARE_BASE="https://github.com/${slug}/compare"

# Seed a basic branchlist.md if it doesn't exist yet, then stop so you can edit it.
if [[ ! -f "$INPUT" ]]; then
  mkdir -p "$AWC_DIR"
  cat > "$INPUT" <<'EOF'
main
<your-branch>

## Pre-Rebase commit

0000000000000000000000000000000000000000

## Review results

Good findings. Please fix them all, considering these comments:
...
Do it on this branch (it contains all the changes from the reviewed branch). I.e., do not check out the reviewed branch.

## Useful commands

```shell
git log --oneline --decorate --simplify-by-decoration main..HEAD
git for-each-ref --merged HEAD --no-merged main --format='%(refname:short)' refs/heads/ --sort=-committerdate
```
EOF
  echo "Seeded a basic $INPUT — edit it (one branch per line, blank line to end) and re-run." >&2
  exit 0
fi

# Read lines until the first empty line
# Each entry stores "branch [commit]" — branch name is the first word
lines=()
while IFS= read -r line; do
  [[ -z "$line" ]] && break
  lines+=("$line")
done < "$INPUT"

if (( ${#lines[@]} < 2 )); then
  echo "Need at least 2 branches, found ${#lines[@]}" >&2
  exit 1
fi

# Extract just the branch name (first word) from a line
branch_name() { echo "${1%% *}"; }

{
  # Compare links
  for ((i = 1; i < ${#lines[@]}; i++)); do
    yyy="$(branch_name "${lines[i-1]}")"
    xxx="$(branch_name "${lines[i]}")"
    echo "${COMPARE_BASE}/${yyy}...${xxx}?expand=1"
  done

  echo ""
  echo "---"
  echo ""

  # PR review commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    yyy="$(branch_name "${lines[i-1]}")"
    xxx="$(branch_name "${lines[i]}")"
    echo -e "/pr-review\nreview the ${xxx} branch with the ${yyy} branch as the base."
    echo ""
  done

  echo "---"
  echo ""

  # PR summary commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    yyy="$(branch_name "${lines[i-1]}")"
    xxx="$(branch_name "${lines[i]}")"
    echo -e "/pr-summary\ndo this for the ${xxx} branch with the ${yyy} branch as the base."
    echo ""
  done

  echo "---"
  echo ""

  # Git branch -f commands — includes commit hash if present
  for ((i = 1; i < ${#lines[@]}; i++)); do
    echo "git branch -f ${lines[i]}"
  done

  echo ""
  echo "---"
  echo ""

  # Push to origin commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    xxx="$(branch_name "${lines[i]}")"
    echo "git push origin ${xxx} --force"
  done

  echo ""
  echo "---"
  echo ""

  # Read from origin commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    xxx="$(branch_name "${lines[i]}")"
    echo "git branch ${xxx} origin/${xxx}"
  done
} > "$OUTPUT"

echo "Generated $OUTPUT with ${#lines[@]} branches ($(( ${#lines[@]} - 1 )) pairs)"
