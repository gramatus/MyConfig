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
OUTPUT="$AWC_DIR/branchcommands.md"

DOTFILES_ROOT="$(dirname "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")")"
NOTEPAD="$DOTFILES_ROOT/docs/notepad.md"

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

# Open PRs keyed by head branch; the marker goes before the first stack branch without one.
declare -A pr_number pr_base
pr_found=false
if command -v gh >/dev/null && pr_rows="$(gh pr list --repo "$slug" --state open --limit 500 \
    --json number,headRefName,baseRefName \
    --jq '.[] | "\(.headRefName) \(.number) \(.baseRefName)"' 2>/dev/null)"; then
  pr_found=true
  while read -r head number base; do
    [[ -z "$head" ]] && continue
    pr_number[$head]="$number"
    pr_base[$head]="$base"
  done <<< "$pr_rows"
else
  echo "Warning: could not list PRs with gh; no PR marker in the output." >&2
fi

MARKER="--- PRs stop here ---"
stop_at=${#lines[@]}
if $pr_found; then
  for ((i = 1; i < ${#lines[@]}; i++)); do
    branch="${lines[i]}"
    if [[ -z "${pr_number[$branch]:-}" ]]; then
      (( stop_at == ${#lines[@]} )) && stop_at=$i
      continue
    fi
    if (( stop_at < i )); then
      echo "Warning: #${pr_number[$branch]} ($branch) sits above a branch with no PR." >&2
    fi
    if [[ "${pr_base[$branch]}" != "${lines[i-1]}" ]]; then
      echo "Warning: #${pr_number[$branch]} ($branch) targets ${pr_base[$branch]}, not ${lines[i-1]}." >&2
    fi
  done
fi

# Pass "blank" as the second argument to follow the marker with an empty line.
marker_before() {
  if $pr_found && (( $1 == stop_at )); then
    echo "$MARKER"
    if [[ "${2:-}" == blank ]]; then echo ""; fi
  fi
}

mkdir -p "$AWC_DIR"
{
  echo "Notepad: [$NOTEPAD](file://$NOTEPAD)"
  echo ""
  echo '```text'
  marker_printed=false
  while IFS= read -r decoration; do
    IFS=',' read -ra refs <<< "$decoration"
    numbers=""
    uncovered=false
    for ref in "${refs[@]}"; do
      ref="${ref# }"
      if [[ -n "${pr_number[$ref]:-}" ]]; then numbers+=" #${pr_number[$ref]}"; fi
      covered=false
      for ((i = 1; i < stop_at; i++)); do
        if [[ "${lines[i]}" == "$ref" ]]; then covered=true; fi
      done
      if ! $covered; then uncovered=true; fi
    done
    if $pr_found && $uncovered && ! $marker_printed; then
      echo "$MARKER"
      marker_printed=true
    fi
    echo "${decoration}${numbers:+ ${numbers}}"
  done <<< "$stack_log"
  if $pr_found && ! $marker_printed; then echo "$MARKER"; fi
  echo '```'
  echo ""
  echo "---"
  echo ""

  # Compare links
  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i"
    echo "${COMPARE_BASE}/${lines[i-1]}...${lines[i]}?expand=1"
  done
  marker_before "${#lines[@]}"

  echo ""
  echo "---"
  echo ""

  # PR review commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i" blank
    echo "/pr-review ${lines[i]} ${lines[i-1]}"
    echo ""
  done
  marker_before "${#lines[@]}" blank

  echo "---"
  echo ""

  # PR summary commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i" blank
    echo "/pr-summary-simple ${lines[i]} ${lines[i-1]}"
    echo ""
  done
  marker_before "${#lines[@]}" blank

  echo "---"
  echo ""

  # Reset each branch to what is currently on origin
  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i"
    echo "git fetch origin +${lines[i]}:${lines[i]}"
  done
  marker_before "${#lines[@]}"

  echo ""
  echo "---"
  echo ""

  # Push to origin commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i"
    echo "git push -u origin ${lines[i]} --force"
  done
  marker_before "${#lines[@]}"

  echo ""
  echo "---"
  echo ""

  # Read from origin commands
  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i"
    echo "git branch ${lines[i]} origin/${lines[i]}"
  done
  marker_before "${#lines[@]}"
} > "$OUTPUT"

echo "Generated $OUTPUT with ${#lines[@]} branches ($(( ${#lines[@]} - 1 )) pairs)"
