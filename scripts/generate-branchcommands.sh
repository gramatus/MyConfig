#!/usr/bin/env bash
# Reads the branch stack between main and the checked-out wip branch from git, then
# generates branchcommands.md with compare links, pr-review, pr-summary and push commands.
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
PAGER=cat git log --first-parent --simplify-by-decoration --decorate-refs='refs/heads/*' --format='%D' main..HEAD --reverse
```

## Full rebase recover

```shell
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
  n=$(git reflog show "$b" --format='%gs' \
      | grep -n -m1 -E 'rewritten during rebase|^rebase \(finish\)' \
      | cut -d: -f1)
  [ -n "$n" ] || continue
  #echo "$b: $(git rev-parse --short "$b") -> $(git rev-parse --short "$b@{$n}")"
  echo git update-ref "refs/heads/$b" "$b@{$n}"     # drop the echo to apply
done
```

## Get write repos

gh repo list helse-sorost --json name,viewerPermission -L 1000 --jq '.[] | select(.viewerPermission == "WRITE" or .viewerPermission == "MAINTAIN" or .viewerPermission == "ADMIN") | .name'

EOF
  echo "Seeded a basic $INPUT — edit it (one branch per line, blank line to end) and re-run." >&2
  exit 0
fi

stack_log="$(git log --first-parent --simplify-by-decoration --decorate-refs='refs/heads/*' --format='%D' main..HEAD --reverse)"

# The checked-out branch is the wip branch, and is left out of the stack.
current_branch="$(git symbolic-ref --short -q HEAD || true)"
lines=(main)
while IFS= read -r decoration; do
  [[ -z "$decoration" ]] && continue
  IFS=',' read -ra refs <<< "$decoration"
  kept=()
  for ref in "${refs[@]}"; do
    ref="${ref# }"
    [[ "$ref" == "$current_branch" ]] && continue
    kept+=("$ref")
  done
  if (( ${#kept[@]} > 1 )); then
    echo "Warning: branches on the same commit, kept in log order: ${kept[*]}" >&2
  fi
  lines+=("${kept[@]}")
done <<< "$stack_log"

if (( ${#lines[@]} < 2 )); then
  echo "Need at least 1 branch between main and HEAD, found $(( ${#lines[@]} - 1 ))" >&2
  exit 1
fi

mkdir -p "$AWC_DIR"
{
  echo '```text'
  echo "$stack_log"
  echo '```'
  echo ""
  echo "---"
  echo ""

  # Compare links
  for ((i = 1; i < ${#lines[@]}; i++)); do
    echo "${COMPARE_BASE}/${lines[i-1]}...${lines[i]}?expand=1"
  done

  echo ""
  echo "---"
  echo ""

  # PR review commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    echo "/pr-review ${lines[i]} ${lines[i-1]}"
    echo ""
  done

  echo "---"
  echo ""

  # PR summary commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    echo "/pr-summary-simple ${lines[i]} ${lines[i-1]}"
    echo ""
  done

  echo "---"
  echo ""

  # Reset each branch to what is currently on origin
  for ((i = 1; i < ${#lines[@]}; i++)); do
    echo "git fetch origin +${lines[i]}:${lines[i]}"
  done

  echo ""
  echo "---"
  echo ""

  # Push to origin commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    echo "git push -u origin ${lines[i]} --force"
  done

  echo ""
  echo "---"
  echo ""

  # Read from origin commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    echo "git branch ${lines[i]} origin/${lines[i]}"
  done
} > "$OUTPUT"

echo "Generated $OUTPUT with ${#lines[@]} branches ($(( ${#lines[@]} - 1 )) pairs)"
