---
name: rebase-resolve
description: Run a stack-plan rebase that moves commits to a verified finish, resolving every conflict on the way. Typed only, because typing it approves the git operations its scripts perform.
disable-model-invocation: true
---

# Rebase resolve

ARGUMENTS: $ARGUMENTS

When the `ARGUMENTS:` line is not expanded, use the user's invocation text. Any arguments are extra flags for `stack-plan apply`, such as `-b <ref>`.

Take a stack-plan reorder from preview to a verified result without handing git steps back to the user. `/repos/MyConfig/docs/stack-plan.md` is the tool's guide: read it before the first step if this session has not.

**Name every commit by its subject, or a recognisable part of it, in anything the user reads.** A sha may follow as a second handle, never stand alone, because the user does not keep shas in their head. This binds the asks above all, which the user must be able to answer without looking anything up.

## Where you come in

**The usual case is a rebase the user has already started.** Their own `sp preview` showed a few minor conflicts, they ran `sp apply -f`, and they typed this command at the first stop. Check `git status` first. Where it shows a rebase in progress, skip "Before the rebase starts" and begin at "At each stop". The user has read the preview and chosen the placements, and they started the rebase, so whether other sessions are idle is already settled. The feasibility check that step 7 of "At each stop" points back to still applies.

Where no rebase is in progress, run the whole skill from "Before the rebase starts".

## What typing this command approves

**The user typing `/rebase-resolve` approves the git operations `scripts/rebase.mts` performs, and nothing else.** This is a declared exception to two rules that otherwise bind you: the system prompt's "commit or push only when the user asks", and a harness guide's "a blocked operation is never wrapped". The exception covers this script and this rebase, so:

- Run the script as `node <this skill's base directory>/scripts/rebase.mts <subcommand>`, with the absolute path printed when this skill loaded. A `~` or `$HOME` in the command trips other shell rules.
- Run `stack-plan` through the script, never directly. A harness may refuse the bare command.
- Never run a mutating git verb yourself: no `add`, `commit`, `rebase`, `reset`, `checkout`, `push` or branch deletion. Where the script cannot do what a stop needs, stop and report, leaving the rebase where it is.
- Edit stackplan.txt only when the user asks, before `start`. It is a file edit, not a git operation, so this exception is not what allows it.

| Subcommand | Does |
| --- | --- |
| `preview [flags]` | `stack-plan preview`, passing the flags through |
| `start [flags]` | `stack-plan apply -f`, accepting the todo without an editor, then `status` at the first stop |
| `status` | The pre-rebase tip, the commit being picked, the next command, and each unmerged path |
| `continue [paths…] [--message-file <file>]` | Refuses while any marker remains or other unstaged changes exist. Stages the unmerged paths and the named ones, commits with the message file when given, continues, then shows the next stop or runs `stack-plan verify` |
| `abort` | `git rebase --abort`. Only when the user says so |
| `verify [flags]` | `stack-plan verify` |

Paths are relative to the repository root.

## Before the rebase starts

1. Run `preview`.
2. **Check that every moved commit landed on the branch it belongs to, conflict or not.** The user often moves many commits across many branches in one plan, and a commit placed on the wrong branch usually applies cleanly, so no conflict reveals it. [commit-placement.md](../../guides/commit-placement.md) says how to read each branch's commits and which signs to look for. Apply it to each moved commit at the branch the preview gives it.

3. For each conflict the preview predicts, read the moving commit's diff of the conflicting file with `git show <sha> -- <file>`. Grep the branch the commit will sit on for every symbol that diff relies on.
4. Decide whether the move is feasible. A commit moved below the commits it was written on top of is the usual cause, and it is feasible when the symbols it needs exist at its new position. Where it would need rewriting beyond conflict resolution, stop and say so. Name the preview's "to keep the old order" line as the fallback.
5. **Where a moved commit lands below a commit on the same topic that created the code it edits, the concept may have moved only in part.** The step 6 message asks whether to move that commit as well, ahead of the fallback.
6. Send one message, then wait. It names each suspect placement from step 2: the commit, where it lands, where it probably belongs and why. It asks whether other sessions on this repository are idle. They share one HEAD, so a commit made mid-rebase lands wherever the rebase has got to. **Where this session has been working on something else, suggest in the same message running the rebase in a fresh session**, and go on in this one if they say so.

Where the plan changes, usually by the user's own edit of stackplan.txt, run `preview` again and repeat steps 2 to 5, stopping again only for something the new preview raises. From `start` onwards, run through without asking.

## At each stop

1. Read `status`. The commit being picked decides what the resolution must hold.
2. **Resolve so the file holds that commit's change applied to the code at this position.** At a lower position, keep the older shapes the commit was written against, such as a function's earlier signature. The later commits bring their own parts back when they replay. Where a later commit's replay conflicts with lines you added, keep both changes.
3. **Copy any line you bring in exactly as the pre-rebase tip has it**, so later picks merge cleanly. `git grep -n <symbol> <pre-rebase tip> -- <file>` shows the spelling.
4. **Check what git did not flag.** Run the repository's typecheck. An import or symbol the commit used may come from a commit that now lands later, in a file git merged cleanly.
5. **Separate older breakage from yours.** For each typecheck error in a file this stop did not touch, check the same symbol at the original commit with `git grep -n <symbol> <original sha> -- <path>`. An error the original commit already had is a finding to report, never a fix to make here.
6. Run `git diff <pre-rebase tip> -- <file>`. It should differ only by commits still to replay.
7. **Where `status` marks a path modify/delete, its missing markers do not mean it is resolved**, and `git diff` shows nothing for it. A file absent at this position holds the commit's whole later version, with content from commits that now land later. Go back to the feasibility check in "Before the rebase starts", and stop and report unless the move is still feasible. Where the commit deletes the file, decide whether the deletion still holds here. Where it does, delete the file from the working tree, and `continue` stages the removal.
8. **Where `status` shows any other unmerged path with no markers, rerere has replayed an earlier resolution.** Read `git diff` before continuing. rerere matches the conflict text, not the commit's purpose, so it can drop the side this rebase exists to bring back.
9. **Where the resolution makes the commit's message false**, write a corrected message to the repository's scratch directory and pass it with `--message-file`. Change only the sentences that went false, in the message's own words.
10. Run `continue`.

A stop that shows the same commit again did not advance. Read git's output above the status before trying anything else.

**Git and `stack-plan` write their hints for a person running git by hand.** Where one says to `git add` or run `git rebase --continue`, run this script's `continue`, which does both. It stages a removal only for a file already gone from the working tree, so where one says `git rm`, follow step 7 first.

## After the rebase

`stack-plan verify` runs when the rebase finishes: `start` runs it on a rebase with no stops, and `continue` after the last stop. Read its conclusion:

- **The tree must match the pre-rebase tip.** Where it does not, report the files it lists and stop. Restoring is the user's call.
- **The "changed" entries must be exactly the commits you resolved at a stop.** Any other changed, dropped or added entry is a finding.

Stop there. Do not test the branches: `/stack-review` judges the stack's shape next, and `/stack-check` runs each branch's checks once that shape holds. Name both in the report.

## The report

- **Header:** whether the tree matched, and that `/stack-review` and then `/stack-check` come next.
- **Body:** one numbered item per stop, naming the commit, the file and what the resolution kept.
- **Findings:** older breakage, each as `F1`, `F2` and so on, naming the commit that introduced it and the branches that carry it. Never fix one in this run.
