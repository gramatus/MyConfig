#!/usr/bin/env bash
# agent-harness bootstrap — refreshed from the harness at managed/agent-harness.sh; edit it there, not here.
# Clones the shared agent harness if it is missing, then wires this repository to it.
# Re-run it whenever you want the latest harness — this is the only thing that pulls.
# Arguments reach the linker: `bash agent-harness.sh --check` reports drift, writing nothing.
set -eu

# The linker rewrites these two lines for the repository it writes this file into. The
# values below are the harness's own, and are what an unrewritten copy would use.
harness_dir=".agent-harness"
harness_url="https://github.com/helse-sorost/gnist-agent-instructions.git"

cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -d "$harness_dir/.git" ]; then
  git clone "$harness_url" "$harness_dir"
fi

exec node "$harness_dir/scripts/link-harness.mjs" "$@"
