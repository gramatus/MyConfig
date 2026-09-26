<!-- agent-harness guard file — refreshed by scripts/link-harness.mjs; edit it there, not here. -->

# Agent instructions

The shared instruction set for this repository lives in a nested checkout at
`.agent-harness/`, which is gitignored and recreated by the devcontainer.

**If the import at the bottom of this file did not resolve — if the shared instruction set
is not already in your context — then almost none of this repository's conventions are
loaded.** Say so and stop. Do not infer the conventions and do not proceed on what you can
see: what is missing is most of it.

**Whether `.agent-harness/CLAUDE.md` is readable is not the test, and checking it that way tells
you everything is fine when it is not.** The file can be perfectly readable while its
content never reached you, and that is what a session opened on a folder below this
repository's root looks like: this file is found by walking up, its import is not
followed, and the guard hooks are not registered either. Reading the instructions yourself
would leave that missing enforcement missing, so the answer there is to reopen the editor
at the repository root.

**Do not restore the checkout yourself.** Not by cloning, not by linking, not by renaming
back a copy you found on disk. Report the state and stop. Repairing it is the user's call,
and an agent that repairs and then carries on proceeds on conventions nobody loaded.

For the user, once they have decided to restore it: if `.agent-harness/` is absent, clone it
back first — `node .agent-harness/scripts/link-harness.mjs` lives inside that directory and
cannot run until it exists. If the directory is present and only the symlinks are
missing, that command is the whole fix. The devcontainer's `postStartCommand` normally
does both on every container start.

@.agent-harness/CLAUDE.md
