#!/usr/bin/env bash
# agent-harness fallback guard — refreshed from the harness; edit it there, not here.
# Every .claude/settings.json hook runs through this. Cursor imports that file beside
# .cursor/hooks.json and would run each hook twice, so this copy stands down there.
# Usage: skip-in-cursor.sh <guard.sh | a bundle under .claude/hooks/dist/>
set -euo pipefail

here="${BASH_SOURCE[0]%/*}"
target="${1:?usage: skip-in-cursor.sh <guard.sh | bundle>}"
payload="$(cat)"
# - CURSOR_VERSION: Cursor sets it for its hooks, and no tool input can set a hook's environment.
# - The key's own quote, then a colon: inside an escaped string value the quote is \", so no match.
if [[ -n "${CURSOR_VERSION:-}" && "${payload}" =~ \"cursor_version\"[[:space:]]*: ]]; then
  exit 0
fi
if [[ "${target}" == "guard.sh" ]]; then
  exec bash "${here}/guard.sh" <<<"${payload}"
fi
exec node "${here}/../hooks/dist/${target}" <<<"${payload}"
