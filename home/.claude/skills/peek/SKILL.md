---
name: peek
description: Show the user changes or files on their phone - an overview of what changed, each file's change as a word, edit or diff view, a walk through the changes one file per turn, or a preview of a file. Typed only.
disable-model-invocation: true
---

# Peek

ARGUMENTS: $ARGUMENTS

When the `ARGUMENTS:` line is not expanded, use the user's invocation text.

The user reads the result on a phone, through the Claude app. **A card is a markdown file sent with `SendUserFile`, with `display: 'render'`**: the app renders markdown, `diff` fences included, and offers any other file type only as a download. The script writes every card, so never send a raw `.diff` or source file.

| Arguments | Does |
| --- | --- |
| none | Overview of the uncommitted changes, untracked files included |
| `<commit>` or `<a>..<b>` | Overview of that commit or range |
| `<path>` | Preview of that file |
| `walk [target]` | Walks the changes of the working tree, or of the commit or range given, one file per turn |

An argument that names an existing file is a path. Otherwise it is a target, and the script refuses one that is not a commit or a range.

The script is `node <this skill's base directory>/scripts/peek.mts`, with the absolute path printed when this skill loaded. It runs in the repository the session is in, and writes cards under `.agent-context/.tmp/peek/`.

## Overview

Run `peek.mts overview [target]`. Each entry ends with the view the file gets by default, and the share of its changed lines that were edited in place rather than added or removed whole. Prose files, and files where at least half the changed lines were edited in place, get `words`. Other modified files get `edit`, or `diff` above 40 changed lines. New, deleted and binary files always get `diff`.

Reply with its first line, then its numbered list, keeping the numbers and the views, and add to each entry one line on what the change does. To write that line, read the file's diff with git yourself. The overview sends no card. The user answers with numbers: "show 2" shows that file in its view, "show 2 as edit", "as words" or "as diff" shows it in that one instead, and "walk" starts a walk.

## Showing a file

In chat, say in a sentence or two what the change does and anything in it that looks wrong or surprising, so the user knows what to look for before opening it. Then show it in its view:

| View | Run | Then |
| --- | --- | --- |
| `words` | `peek.mts words <path> [target]` | Send the card it prints. Removed words are struck through in red and added words are green. |
| `diff` | `peek.mts diff <path> [target]` | Send the card it prints. |
| `edit` | `peek.mts edit <path> [target]` | Replay the regions, as below. |

**Replaying an edit.** The script prints the path of a scratch copy of the old version, then each changed region as an `<<<<<<< old` block and a `>>>>>>> new` block, split by `=======`. Read the scratch copy with `limit: 1`, which is enough for Edit to accept it. Then make one Edit per region, in order, with the old block as `old_string` and the new block as `new_string`, copied exactly. The app shows each Edit as a diff view, so the Edits are what the user reads: send no card. Where the script refuses a file, as it does for a new file or a region it cannot place uniquely, show it as `diff` instead.

## Preview

Run `peek.mts file <path>` and send the file it prints. A markdown file is sent as it is. Any other file is wrapped in a fence. Say nothing about the content unless the user asks.

## Walk

1. Run the overview, and show it.
2. Take the files in the overview's order, one per turn. For each, show it in its view, as "Showing a file" says, and reply with what the change does, anything that looks wrong, and the position, such as "3 of 7". Then stop and wait.
3. The user answers "next", asks about the change, asks for another view of the same file, such as "as diff", or gives a note. Before showing the next file, record the file in `.agent-context/.tmp/peek/walk-<target>.md` under a heading of its path, with the user's notes in their words, or "no note". `<target>` is `worktree` for the working tree, and otherwise the target with every character other than a letter, digit, dot or dash replaced by `_`. A walk whose file exists continues from the first file it has no heading for.
4. After the last file, send the notes file as a card, and stop. **A walk changes nothing in the repository.** Acting on a note is a separate request from the user.
