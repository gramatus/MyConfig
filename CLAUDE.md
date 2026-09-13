<!-- agent-harness guard file — refreshed by scripts/link-harness.mjs; edit it there, not here. -->

# Agent instructions

The shared instruction set for this repository lives in a nested checkout at
`.agent-harness/`, which is gitignored and recreated by the devcontainer.

**If the import at the bottom of this file did not resolve — if `.agent-harness/CLAUDE.md`
is not readable — then almost none of this repository's conventions are loaded.** Say so
and stop. Do not infer the conventions and do not proceed on what you can see: what is
missing is most of it.

To restore the wiring:

    node .agent-harness/scripts/link-harness.mjs

If the directory is absent entirely, clone it first. The devcontainer's
`postStartCommand` normally does both on every container start.

@.agent-harness/CLAUDE.md
