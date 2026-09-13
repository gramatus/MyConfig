<!-- agent-harness guard file — refreshed by scripts/link-harness.mjs; edit it there, not here. -->

# Agent instructions — start here

This repository's agent instructions live in a nested, gitignored checkout at
`.agent-harness/`, wired in through symlinks. This file is deliberately a real file
rather than a link: it is what remains when that checkout is missing.

The always-on instruction body is `.github/copilot-instructions.md`. If your tool has
not already loaded it alongside this file, read it now and follow it before doing
anything else.

**If that file is not readable, the checkout is missing and almost none of this
repository's conventions are loaded.** Say so and stop. Do not infer the conventions
and do not proceed on what you can see — what is missing is most of it.

To restore the wiring:

    node .agent-harness/scripts/link-harness.mjs

If `.agent-harness/` is absent entirely, clone it first — the devcontainer's
`postStartCommand` normally does both on every container start.
