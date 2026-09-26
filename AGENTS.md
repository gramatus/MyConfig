<!-- agent-harness guard file — refreshed by scripts/link-harness.mjs; edit it there, not here. -->

# Agent instructions — start here

This repository's agent instructions live in a nested, gitignored checkout at
`.agent-harness/`, wired in through symlinks. This file is deliberately a real file
rather than a link: it is what remains when that checkout is missing.

The always-on instruction body is `.github/copilot-instructions.md`. If your tool has
not already loaded it alongside this file, read it now and follow it before doing
anything else.

**If that file is not readable, almost none of this repository's conventions are
loaded.** Say so and stop. Do not infer the conventions and do not proceed on what you
can see — what is missing is most of it.

**Do not restore the checkout yourself.** Not by cloning, not by linking, not by renaming
back a copy you found on disk. Report the state and stop. Repairing it is the user's call,
and an agent that repairs and then carries on proceeds on conventions nobody loaded.

For the user, once they have decided to restore it: if `.agent-harness/` is absent, clone it
back first — `node .agent-harness/scripts/link-harness.mjs` lives inside that directory and
cannot run until it exists. If the directory is present and only the symlinks are
missing, that command is the whole fix. The devcontainer's `postStartCommand` normally
does both on every container start.
