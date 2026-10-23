---
name: start-extra-session
description: Start, list or resume remote-control Claude Code sessions on a folder under /repos, detached in tmux, so they can be driven from the phone. Typed only, because typing it approves starting that session.
disable-model-invocation: true
---

# Start extra session

ARGUMENTS: $ARGUMENTS

When the `ARGUMENTS:` line is not expanded, use the user's invocation text. The first argument is one folder name directly under `/repos`, such as `github-vending`. What follows it picks the mode:

| Arguments | Does |
| --- | --- |
| `<folder>` | Starts a new session |
| `<folder> list [count]` | Lists the newest sessions recorded for the folder, five unless a count is given, each with its date, title and id. Starts nothing |
| `<folder> resume <id>` | Resumes that session, which must be one `list` shows for the folder |

**The user typing `/start-extra-session` approves running this skill's script once, with the arguments they typed, and nothing else.** Where no folder is named, ask for one and stop.

Run `node <this skill's base directory>/scripts/start.mts <arguments>`, with the absolute path printed when this skill loaded. Pass the arguments exactly as typed: the script validates them, and adjusting them to make them pass defeats that check. A `resume` without an id is the script's to refuse, never yours to complete from a listing.

For `list`, relay the listing as it is, so the user can copy an id into `resume`. For a start or a resume, relay the session URL or where to find the session, any `⚠` warning about the repository's origin, and the stop command. Where the script fails, give its message and leave the failure standing rather than retrying with a changed command. A pending trust or "Enable Remote Control?" prompt is for the user to answer at the computer with `tmux attach -t <session>`, never for you to answer, because answering it grants trust the user has not given.

Each session starts in the default permission mode, so every permission prompt waits for the user in the Claude app. `tmux ls` lists the sessions this skill has started: a new one is named `cc-<folder>`, a resumed one `cc-<folder>-<first 8 characters of the id>`.
