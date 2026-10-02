#!/usr/bin/env bash
# agent-harness fallback guard — refreshed from the harness; edit it there, not here.
# Runs the guard bundle when the harness checkout is present, and the fallback matcher when not.
# --home: the copy in ~/.cursor, which stays silent where the workspace has a bundle.
set -euo pipefail

here="${BASH_SOURCE[0]%/*}"
if [[ "${1:-}" == "--home" ]]; then
  if [[ -f "${PWD}/.claude/hooks/dist/run.mjs" ]]; then
    exit 0
  fi
  exec node "${here}/matcher.mts" --home
fi

bundle="${here}/../hooks/dist/run.mjs"
if [[ -f "${bundle}" ]]; then
  exec node "${bundle}"
fi
exec node "${here}/matcher.mts"
