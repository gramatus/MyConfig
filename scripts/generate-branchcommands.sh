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

# The checked-out branch is left out of the stack only when its name contains "wip".
current_branch="$(git symbolic-ref --short -q HEAD || true)"
wip_branch=""
if [[ "${current_branch,,}" == *wip* ]]; then wip_branch="$current_branch"; fi
lines=(main)
while IFS= read -r decoration; do
  [[ -z "$decoration" ]] && continue
  IFS=',' read -ra refs <<< "$decoration"
  kept=()
  for ref in "${refs[@]}"; do
    ref="${ref# }"
    [[ -n "$wip_branch" && "$ref" == "$wip_branch" ]] && continue
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

# A __ branch is an extract source: it stays local, and the branch named without the prefix gets its PR.
is_source() { [[ "$1" == __* ]]; }

# The note printed for a stack branch whose PR cannot exist while it sits on a local __ branch.
waits_on_source() {
  echo "_Waits: \`${lines[$1]}\` sits on \`${lines[$1 - 1]}\`, which stays local; its PR waits until the extracted chains merge._"
}

# Each extracted copy, bottom first, with its PR base: the nearest copy below that it contains, else main.
copies=()
declare -A copy_base
for branch in "${lines[@]:1}"; do
  is_source "$branch" || continue
  copy="${branch#__}"
  copies+=("$copy")
  git show-ref --verify --quiet "refs/heads/$copy" || continue
  copy_base[$copy]=main
  for below in "${copies[@]}"; do
    [[ "$below" == "$copy" || -z "${copy_base[$below]:-}" ]] && continue
    if git merge-base --is-ancestor "$below" "$copy"; then copy_base[$copy]="$below"; fi
  done
  if [[ -n "${pr_number[$copy]:-}" && "${pr_base[$copy]}" != "${copy_base[$copy]}" ]]; then
    echo "Warning: #${pr_number[$copy]} ($copy) targets ${pr_base[$copy]}, not ${copy_base[$copy]}." >&2
  fi
done
extracted=()
for copy in "${copies[@]}"; do
  if [[ -n "${copy_base[$copy]:-}" ]]; then extracted+=("$copy"); fi
done

# Pass "blank" as the second argument to follow the marker with an empty line.
marker_before() {
  if $pr_found && (( $1 == stop_at )); then
    echo "$MARKER"
    if [[ "${2:-}" == blank ]]; then echo ""; fi
  fi
}

mkdir -p "$AWC_DIR"
NOTEPAD_LINK="$AWC_DIR/notepad.md"
if [[ -e "$NOTEPAD_LINK" && ! -L "$NOTEPAD_LINK" ]]; then
  echo "Warning: $NOTEPAD_LINK is a real file; not replacing it with a symlink." >&2
else
  ln -sfn "$NOTEPAD" "$NOTEPAD_LINK"
fi
{
  echo "Notepad: [notepad.md](notepad.md)"
  echo "Pre-Rebase commits: [stackplan-rebases.log](stackplan-rebases.log)"
  echo ""
  echo "## sp cheatsheet"
  echo "\`\`\`shell"
  echo "sp cut # check that dropping the branches up to <branch> and rebasing the rest onto the base loses no work"
  echo "sp mode short/full"
  echo "sp prepare # record the pre-rebase tip before a rebase run by hand"
  echo "\`\`\`"
  echo ""
  echo "## Stack"
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
  echo "## Compare links"
  echo ""

  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i"
    is_source "${lines[i]}" && continue
    if is_source "${lines[i-1]}"; then waits_on_source "$i"; continue; fi
    echo "${COMPARE_BASE}/${lines[i-1]}...${lines[i]}?expand=1"
  done
  marker_before "${#lines[@]}"

  echo ""
  echo "## PR review"
  echo ""

  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i" blank
    is_source "${lines[i]}" && continue
    echo "/pr-review ${lines[i]} ${lines[i-1]}"
    echo ""
  done
  marker_before "${#lines[@]}" blank

  echo "## PR summary"
  echo ""

  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i" blank
    is_source "${lines[i]}" && continue
    echo "/pr-summary ${lines[i]} ${lines[i-1]} body-only "
    echo ""
  done
  marker_before "${#lines[@]}" blank

  echo "## Reset to origin"
  echo ""

  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i"
    is_source "${lines[i]}" && continue
    echo "git fetch origin +${lines[i]}:${lines[i]}"
  done
  marker_before "${#lines[@]}"

  echo ""
  echo "## Push to origin"
  echo ""

  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i"
    is_source "${lines[i]}" && continue
    echo "git push -u origin ${lines[i]} --force"
  done
  marker_before "${#lines[@]}"

  echo ""
  echo "## Create PR"
  echo ""

  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i"
    is_source "${lines[i]}" && continue
    if is_source "${lines[i-1]}"; then waits_on_source "$i"; continue; fi
    echo "pr-create ${lines[i]} ${lines[i-1]}"
  done
  marker_before "${#lines[@]}"

  echo ""
  echo "## Create from origin"
  echo ""

  for ((i = 1; i < ${#lines[@]}; i++)); do
    marker_before "$i"
    is_source "${lines[i]}" && continue
    echo "git branch ${lines[i]} origin/${lines[i]}"
  done
  marker_before "${#lines[@]}"

  if (( ${#copies[@]} )); then
    echo ""
    echo "## Extracted chains"
    echo ""
    echo "Each copy's PR targets the copy below it in its chain, or main. Push and create them bottom first."
    echo ""
    echo '```text'
    for copy in "${copies[@]}"; do
      if [[ -z "${copy_base[$copy]:-}" ]]; then
        echo "__$copy  not extracted yet: stack-plan extract --apply"
      else
        echo "$copy → ${copy_base[$copy]}${pr_number[$copy]:+ #${pr_number[$copy]}}"
      fi
    done
    echo '```'
  fi
  if (( ${#extracted[@]} )); then
    echo ""
    echo "### Compare links"
    echo ""
    for copy in "${extracted[@]}"; do
      echo "${COMPARE_BASE}/${copy_base[$copy]}...${copy}?expand=1"
    done
    echo ""
    echo "### PR review"
    echo ""
    for copy in "${extracted[@]}"; do
      echo "/pr-review ${copy} ${copy_base[$copy]}"
      echo ""
    done
    echo "### PR summary"
    echo ""
    for copy in "${extracted[@]}"; do
      echo "/pr-summary ${copy} ${copy_base[$copy]} body-only "
      echo ""
    done
    echo "### Push to origin"
    echo ""
    for copy in "${extracted[@]}"; do
      echo "git push -u origin ${copy}"
    done
    echo ""
    echo "### Create PR"
    echo ""
    for copy in "${extracted[@]}"; do
      [[ -n "${pr_number[$copy]:-}" ]] && continue
      echo "pr-create ${copy} ${copy_base[$copy]}"
    done
  fi
} > "$OUTPUT"

echo "Generated $OUTPUT with ${#lines[@]} branches ($(( ${#lines[@]} - 1 )) pairs)"
