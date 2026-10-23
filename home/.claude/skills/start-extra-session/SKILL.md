---
name: start-extra-session
description: Start a remote-control Claude Code session on a folder under /repos, detached in tmux, so it can be driven from the phone. Typed only, because typing it approves starting that session.
disable-model-invocation: true
---

# Start extra session

ARGUMENTS: $ARGUMENTS

When the `ARGUMENTS:` line is not expanded, use the user's invocation text. The argument is one folder name directly under `/repos`, such as `github-vending`.

**The user typing `/start-extra-session` approves running this skill's script once, with the folder they named, and nothing else.** Where no folder is named, ask for one and stop.

Run `node <this skill's base directory>/scripts/start.mts <folder>`, with the absolute path printed when this skill loaded. Pass the folder exactly as typed: the script validates it, and adjusting the name to make it pass defeats that check.

Relay the script's output as it is: the session URL or where to find the session, any `⚠` warning about the repository's origin, and the stop command. Where it fails, give its message and leave the failure standing rather than retrying with a changed command. A pending trust or "Enable Remote Control?" prompt is for the user to answer at the computer with `tmux attach -t <session>`, never for you to answer, because answering it grants trust the user has not given.

The session starts in the default permission mode, so every permission prompt waits for the user in the Claude app. `tmux ls` lists the sessions this skill has started, each named `cc-<folder>`.
