#!/usr/bin/env bash
#
# gh-activity.sh — Show your GitHub activity for a given day in chronological order.
# Usage: ./gh-activity.sh 2026-02-25
#        Defaults to today if no date is provided.
#
# Requires: gh (GitHub CLI, authenticated), jq

set -euo pipefail

# --- Dependency check ---
for cmd in gh jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not installed." >&2
    exit 1
  fi
done

# --- Auth handling ---
# Codespace tokens (ghu_*) have limited scope — only the current repo.
# We cache a broader token from `gh auth login` for cross-org access.
TOKEN_CACHE="$HOME/.config/gh-activity/token"

ensure_broad_token() {
  # 1) Try cached token
  if [[ -f "$TOKEN_CACHE" ]]; then
    local cached_token
    cached_token=$(cat "$TOKEN_CACHE")
    if GH_TOKEN="$cached_token" gh api user --jq '.login' &>/dev/null; then
      export GH_TOKEN="$cached_token"
      echo "Using cached token from $TOKEN_CACHE" >&2
      return
    fi
    echo "Cached token expired or invalid, re-authenticating..." >&2
    rm -f "$TOKEN_CACHE"
  fi

  # 2) Check if current token is a limited codespace token
  if [[ "${GITHUB_TOKEN:-}" == ghu_* ]]; then
    echo "Codespace token detected — limited repo access." >&2
    echo "Logging in with broader access (repo + read:org)..." >&2
    # Unset GITHUB_TOKEN so gh auth login stores to config instead of conflicting
    GITHUB_TOKEN='' gh auth login --hostname github.com --web --scopes repo,read:org
    local token
    token=$(GITHUB_TOKEN='' gh auth token --hostname github.com)
    mkdir -p "$(dirname "$TOKEN_CACHE")"
    printf '%s' "$token" > "$TOKEN_CACHE"
    chmod 600 "$TOKEN_CACHE"
    export GH_TOKEN="$token"
    echo "Token cached at $TOKEN_CACHE" >&2
  else
    echo "Using default gh token" >&2
  fi
}

ensure_broad_token

# --- Date handling ---
if [[ $# -ge 1 ]]; then
  TARGET_DATE="$1"
  # Validate format
  if ! date -d "$TARGET_DATE" &>/dev/null 2>&1; then
    echo "Error: Invalid date '$TARGET_DATE'. Use YYYY-MM-DD format." >&2
    exit 1
  fi
else
  TARGET_DATE=$(date +%Y-%m-%d)
fi

NEXT_DATE=$(date -d "$TARGET_DATE + 1 day" +%Y-%m-%d)
# Single-day range for GitHub search (inclusive on both ends, so same date = exact day)
DATE_RANGE="${TARGET_DATE}..${TARGET_DATE}"
# Broader range for --updated queries where jq does the precise filtering
UPDATED_RANGE="${TARGET_DATE}..${NEXT_DATE}"

# Display timestamps in Norwegian time
export TZ="Europe/Oslo"

USERNAME=$(gh api user --jq '.login')

echo "=== GitHub activity for $USERNAME on $TARGET_DATE ==="
echo ""

# --- Collect all events into a temp file as JSON lines ---
EVENTS=$(mktemp)
trap 'rm -f "$EVENTS"' EXIT

# 1) Commits (across all repos you contributed to)
gh search commits --author="$USERNAME" --committer-date="$DATE_RANGE" \
  --json repository,sha,commit --jq '.[] | {
    time: .commit.committer.date,
    type: "commit",
    repo: (.repository.nameWithOwner // .repository.fullName),
    title: .commit.message | split("\n")[0],
    url: "https://github.com/\(.repository.nameWithOwner // .repository.fullName)/commit/\(.sha)"
  }' >> "$EVENTS" || echo "Warning: commits query failed" >&2

# 2) PRs created
gh search prs --author="$USERNAME" --created="$DATE_RANGE" \
  --json repository,title,url,createdAt,number --jq '.[] | {
    time: .createdAt,
    type: "pr-created",
    repo: .repository.nameWithOwner,
    title: "#\(.number) \(.title)",
    url: .url
  }' >> "$EVENTS" || echo "Warning: PRs-created query failed" >&2

# 3) PRs reviewed by user (via REST search + per-PR review details)
reviewed_prs_json=$(gh search prs --reviewed-by="$USERNAME" --updated="$UPDATED_RANGE" \
  --json repository,title,url,number) || {
  echo "Warning: reviewed-PRs search failed" >&2
  reviewed_prs_json="[]"
}

while IFS= read -r pr_json; do
  [[ -z "$pr_json" ]] && continue
  repo=$(jq -r '.repository.nameWithOwner' <<< "$pr_json")
  num=$(jq -r '.number' <<< "$pr_json")
  title=$(jq -r '.title' <<< "$pr_json")
  pr_url=$(jq -r '.url' <<< "$pr_json")

  if reviews_response=$(gh api "repos/$repo/pulls/$num/reviews" 2>&1); then
    jq --arg user "$USERNAME" \
       --arg date_start "${TARGET_DATE}T00:00:00Z" \
       --arg date_end "${NEXT_DATE}T00:00:00Z" \
       --arg repo "$repo" \
       --arg num "$num" \
       --arg title "$title" \
       --arg pr_url "$pr_url" '
      .[] | select(.user.login == $user and .submitted_at >= $date_start and .submitted_at < $date_end) |
      {
        time: .submitted_at,
        type: "pr-review (\(.state | ascii_downcase))",
        repo: $repo,
        title: "#\($num) \($title)",
        url: $pr_url
      }
    ' <<< "$reviews_response" >> "$EVENTS" || echo "Warning: failed to parse reviews for $repo#$num" >&2
  else
    echo "Warning: failed to fetch reviews for $repo#$num" >&2
  fi
done < <(jq -c '.[]' <<< "$reviewed_prs_json")

# 4) Issues created
gh search issues --author="$USERNAME" --created="$DATE_RANGE" \
  --json repository,title,url,createdAt,number --jq '.[] | {
    time: .createdAt,
    type: "issue-created",
    repo: .repository.nameWithOwner,
    title: "#\(.number) \(.title)",
    url: .url
  }' >> "$EVENTS" || echo "Warning: issues-created query failed" >&2

# 5) Additional events via Events API (catches review comments, branch creates, pushes, releases)
gh api "users/$USERNAME/events" --paginate | \
  jq --arg date_start "$TARGET_DATE" --arg date_end "$NEXT_DATE" '
  .[] | select(.created_at >= ($date_start + "T00:00:00Z") and .created_at < ($date_end + "T00:00:00Z")) |
  select(.type == "PullRequestReviewEvent" or .type == "PullRequestReviewCommentEvent" or
         .type == "IssueCommentEvent" or .type == "CreateEvent" or .type == "DeleteEvent" or
         .type == "PushEvent" or .type == "ReleaseEvent") |
  {
    time: .created_at,
    type: (
      if .type == "PullRequestReviewEvent" then "pr-review"
      elif .type == "PullRequestReviewCommentEvent" then "pr-review-comment"
      elif .type == "IssueCommentEvent" then (if .payload.issue.pull_request then "pr-comment" else "issue-comment" end)
      elif .type == "CreateEvent" then "create-\(.payload.ref_type // "unknown")"
      elif .type == "DeleteEvent" then "delete-\(.payload.ref_type // "unknown")"
      elif .type == "PushEvent" then "push"
      elif .type == "ReleaseEvent" then "release"
      else .type end
    ),
    repo: .repo.name,
    title: (
      if .type == "PullRequestReviewEvent" then (.payload.pull_request.title // "(deleted PR)")
      elif .type == "PullRequestReviewCommentEvent" then ((.payload.comment.body // "")[:80] | gsub("[\\n\\t\\r]"; " "))
      elif .type == "IssueCommentEvent" then (.payload.issue.title // "(deleted issue)")
      elif .type == "CreateEvent" then "\(.payload.ref_type // "unknown"): \(.payload.ref // "default branch")"
      elif .type == "DeleteEvent" then "\(.payload.ref_type // "unknown"): \(.payload.ref // "unknown")"
      elif .type == "PushEvent" then "\(.payload.size // 0) commit(s) to \((.payload.ref // "unknown") | split("/")[-1])"
      elif .type == "ReleaseEvent" then (.payload.release.tag_name // "unknown")
      else "" end
    ),
    url: (
      if .type == "PullRequestReviewEvent" then (.payload.pull_request.html_url // "https://github.com/\(.repo.name)")
      elif .type == "PullRequestReviewCommentEvent" then (.payload.comment.html_url // "https://github.com/\(.repo.name)")
      elif .type == "IssueCommentEvent" then (.payload.issue.html_url // "https://github.com/\(.repo.name)")
      elif .type == "ReleaseEvent" then (.payload.release.html_url // "https://github.com/\(.repo.name)")
      else "https://github.com/\(.repo.name)" end
    )
  } | select(.time != null and .type != null)
' >> "$EVENTS" || echo "Warning: events-API query failed" >&2

# --- Deduplicate and sort chronologically ---
if [[ ! -s "$EVENTS" ]]; then
  echo "No activity found for $TARGET_DATE."
  exit 0
fi

# Deduplicate by (type + url), keeping earliest occurrence
DEDUPED=$(jq -s 'group_by(.type + .url) | map(sort_by(.time)[0])[]' "$EVENTS")

# Sort by epoch seconds and display
echo "$DEDUPED" | jq -r '"\(.time)\t\(.type)\t\(.repo)\t\(.title)\t\(.url)"' | \
while IFS=$'\t' read -r time type repo title url; do
  epoch=$(date -d "$time" +%s 2>/dev/null || echo "0")
  printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$epoch" "$time" "$type" "$repo" "$title" "$url"
done | sort -n -t$'\t' -k1,1 | while IFS=$'\t' read -r _epoch time type repo title url; do
  local_dt=$(date -d "$time" +"%Y-%m-%d %H:%M" 2>/dev/null || echo "${time:0:16}")
  printf "%-16s  %-24s  %-40s  %s\n" "$local_dt" "[$type]" "$repo — $title" "$url"
done

# --- Statistics ---
echo ""
echo "$DEDUPED" | jq -s '
  group_by(
    if .type | startswith("pr-review") then "reviews"
    elif .type == "commit" then "commits"
    elif .type | startswith("pr-") then "pull requests"
    elif .type | startswith("issue") then "issues"
    else .type end
  ) |
  map({type: .[0] | (
    if .type | startswith("pr-review") then "reviews"
    elif .type == "commit" then "commits"
    elif .type | startswith("pr-") then "pull requests"
    elif .type | startswith("issue") then "issues"
    else .type end
  ), count: length}) |
  sort_by(-.count)[] |
  "  \(.type): \(.count)"
' -r
total=$(echo "$DEDUPED" | jq -s 'length')
echo "  total: $total"
