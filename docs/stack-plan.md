# stack-plan: moving commits from a wip branch into the stack below it

How to use `scripts/stack-plan` to decide which stacked branch each commit on a wip branch belongs to, keep that decision safe across rebases and aborts, and check the result afterwards. It is written for me returning to this after a while, knowing `git rebase -i` but not the details of this tool.

## Cheatsheet

| Command             | What it does                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `stack-plan export` | Replaces stackplan.txt. Commits with a note are put at the right place.                    |
| `stack-plan apply`  | Adds notes to the commits about the target branch. Add `--dry-run` to see what it will do. |
| `stack-plan rebase` | Moves each tagged commit into its branch, then runs `verify`.                              |
| `stack-plan verify` | Checks that the last rebase kept everything "as before", except the reordering.            |

## The problem it solves

Work lands on a wip branch sitting on top of a stack of feature branches, and every so often an interactive rebase moves those commits down into the branches they belong to. Remembering where each commit goes is the hard part, and an aborted rebase used to throw the whole plan away with it. `stack-plan` stores the plan as git notes on the commits themselves, so it survives an abort, a re-export and any number of rebases in between.

Notes rather than a `Target:` trailer in the commit message, because a note sits beside the commit instead of inside it. The final history carries no bookkeeping, and the SHAs are unaffected by tagging.

## What it relies on

`install.sh` sets these globally. Each one matters for a reason the script cannot show:

- `notes.rewriteRef refs/notes/target` — git copies a note onto the rewritten commit on rebase and amend only for refs named here. Without it, every rebase leaves the notes behind on the old SHAs, and the plan is lost the first time something below the commit moves.
- `rebase.updateRefs true` — the rebase todo gets an `update-ref` line per stacked branch, and the plan file borrows that shape.
- `rebase.missingCommitsCheck error` — a todo that leaves a commit out stops the rebase instead of dropping the commit.
- `rerere.enabled true` and `rerere.autoupdate true` — a conflict resolved once is replayed and staged on the next attempt. Replaying a wrong resolution without looking is the risk, and `stack-plan verify` below is what catches it for a rebase that only moves commits.

`install.sh` also links `scripts/` to `~/scripts`, which `.zshrc` puts on `PATH`, so `stack-plan` runs by name from any repository.

## The loop

Every step runs from inside the repository, with the wip branch checked out. `--base <ref>` changes the ref the stack sits on, and defaults to `origin/main`.

Each git command the script runs is echoed to stderr as `$ git …` before it runs, so the output doubles as a record of what it did. `2>/dev/null` hides that trace and keeps only the result. In a terminal the trace is dimmed and the results are coloured: branches cyan, SHAs yellow, and outcomes marked green `✓`, yellow `!` or red `✗`. Setting `NO_COLOR`, or piping the output, turns colour off.

### 1. Export the plan

```shell
stack-plan export
```

This writes `.agent-context/active-work-context/stackplan.txt`, beside `branchlist.md`. An existing file is copied to `stackplan.txt.bak` first. Success prints the path and how many commits are waiting and untagged.

The header carries two SHAs with separate jobs. `exported-at:` is the wip tip at export, and `apply` uses it to tell commits added since from a rewritten branch. `pre-rebase:` is the tip before the last `stack-plan rebase`, and only `verify` reads it. Export copies `pre-rebase:` over from the old file, so exporting between a rebase and its `verify` leaves the comparison intact.

Export again after any rebase of the wip branch, because the file's SHAs are then gone and `apply` refuses it. Commits that merely landed on top since the export leave the file usable, as step 3 describes. A re-export keeps only placements already applied as notes, and the edited file survives as `stackplan.txt.bak`.

### 2. Place each commit

The file is shaped like a rebase todo:

```text
# stack-plan for gramatus/wip on origin/main, exported 2026-09-26T13:54:08.513Z
# exported-at: c2db5abc775659028ed267814355ba53f1aa7047
# pre-rebase: bf0097a45ad1d2898dc1dc8ec57f9e6a1a8b16ab
# A pick belongs to the first update-ref below it. ...

pick acc88e23da docs(threat-model): record Azure DevOps token risk
update-ref refs/heads/docs/rewritten-threat-model
update-ref refs/heads/agents/instruction-rules
...
update-ref refs/heads/docs/usage
pick 64ea8ef896 TMP: add hook sharing stuff
# ---- untagged: move each line above the update-ref of its branch ----
pick 9a4e1943c1 WiP: harness-compat
```

Move `pick` lines and leave everything else as exported:

- A pick belongs to the first `update-ref` below it. In the example, `acc88e23da` goes to `docs/rewritten-threat-model`.
- A pick between the last `update-ref` and the untagged marker stays on the wip branch. That is recorded too, so commits meant to stay, like the TMP ones, are already in place on the next export.
- A pick below the marker is untagged. Moving a tagged commit back below the marker removes its note.

Commits tagged in an earlier round are exported already sitting in their section, so the file only ever needs the new ones placed.

### 3. Apply

```shell
stack-plan apply --dry-run
stack-plan apply
```

The dry run lists the notes it would write, grouped under their branch, and the ones it would remove under `untag`. Without `--dry-run` it writes them to `refs/notes/target`. Success ends with `✓` and the number of notes changed, or `notes already match the plan`.

Commits made on top of the wip branch after the export are left untagged and listed as `left untagged, committed after export`. `apply` then moves the file's `exported-at:` line to the tip it checked, which is the line it compares against next time. Place such a commit in a later round, or add its `pick` line to the file before applying.

`apply` checks the whole file before writing anything, and on any problem it writes no notes and names the offending line. Nearly every refusal comes from the wip branch having been rewritten or the stack having changed since export, and exporting again is the remedy.

### 4. Rebase

The agents must be idle first: they all share one worktree and one HEAD, so a commit made mid-rebase lands on whatever commit the rebase has reached and is carried along from there.

```shell
stack-plan rebase --dry-run
stack-plan rebase
```

The dry run lists each move and the base it would use, then previews the rebase. The preview replays the planned todo in memory, one pick at a time: `git merge-tree --merge-base=<pick>^` applies each pick onto the simulated state so far, and `git commit-tree` records the result. It writes objects but moves no ref and leaves the worktree alone. It either reports that every pick applies cleanly, or names the first pick that would conflict and its files. A real `rebase` runs the same preview first and rewrites nothing when it predicts a conflict. `stack-plan rebase --anyway` goes ahead regardless, for a conflict you would rather resolve by hand. The preview cannot see resolutions `rerere` has recorded, so a predicted conflict may still resolve itself.

`rebase` reads the notes, not `stackplan.txt`, so what `apply` wrote is what moves. It records the wip tip in the file's `pre-rebase:` line and at the top of `stackplan-rebases.log`, then runs `git rebase -i --update-refs <base>` with itself as git's sequence editor: it takes each tagged pick out of git's todo and puts it back just above its branch's `update-ref` line. Then it opens the todo in the editor git would have used, with the picks already placed and marked `[moved]` after their hash. Git ignores everything after the hash on a `pick` line, so the marker never reaches a commit message. Save and close to start the rebase. Empty the todo, or exit the editor with an error (`:cq` in Vim), to call it off. When the rebase finishes, `rebase` runs `verify`.

The base is the branch directly under the lowest branch receiving a commit, or `--base` (`origin/main`) when the lowest branch of the stack receives. It has to sit below that branch, because a branch whose tip is the base gets no `update-ref` line in the todo.

If the sequence editor cannot place a pick, because the commit is not in the todo or its branch has no `update-ref` line, it names the problem and exits non-zero. Git then does not start the rebase. When a pick conflicts, the rebase stops as usual: resolve it, `git rebase --continue`, then run `stack-plan verify` yourself.

### 5. Verify

```shell
stack-plan verify
```

A rebase that only moves commits leaves the wip branch's final tree exactly as it was, and `verify` checks that in two ways. Any range-diff entries worth reading come first, under `Range diff changes`. The verdicts come last, under `Conclusion`, so the end of the output is the answer.

`git diff --stat <pre-rebase> <wip>` should be empty, and then it prints `✓ tree matches the pre-rebase tip`. When the tree differs, it lists the files and prints the command that puts the old tree back as uncommitted changes:

```shell
git restore --source=<pre-rebase> --staged --worktree :/
```

That is `restore` rather than `git checkout <sha> .`, because `checkout` only writes paths that exist in the source commit. A file that the rebase brought back, and that the old tip did not have, survives `checkout` unnoticed and is removed by `restore`. Read the stat before restoring: the list says where a resolution went wrong, and restoring first hides it.

`git range-diff <base>..<pre-rebase> <base>..<wip>` then pairs each old commit with its rewritten version. `verify` prints a count per marker and the full entry for everything that is not `=`:

- `=` — the patch is identical. A moved commit normally shows this.
- `!` — the patch changed, and range-diff prints the diff between the two diffs beneath it. `verify` splits these in two. When only the context lines around the change differ, which is normal for a moved commit, it counts the entry as `context only` and prints just its header line. When the change itself differs, as after a conflict resolution, it counts it as `changed` and prints the whole entry.
- `<` — the commit was dropped.
- `>` — the commit is new.

The summary line starts with `✓` when no change differs, `!` when some did and are worth reading, and `✗` when a commit was dropped or added. After a clean reorder it reads `0 changed · 0 dropped · 0 added`. In a terminal the entries keep git's own range-diff colours.

Reading a printed entry: the body has two marker columns. The first compares the two versions of the patch (`-` only in the old, `+` only in the new). The second is the patch's own `+`, `-` or context space. A first-column `+` or `-` followed by a space is a context line that moved. A first-column marker followed by `+` or `-` is the commit's actual change differing, and that is the line to read.

## Where things live

- The plan: `.agent-context/active-work-context/stackplan.txt` in the repository it was exported from, plus `stackplan.txt.bak`. It is gitignored scratch.
- The rebase log: `stackplan-rebases.log` beside the plan, one `[yymmdd hhmm] <sha>` line per `stack-plan rebase`, newest first. Each SHA is the wip tip from before that rebase, the one to hand `git restore --source=` to go back.
- The notes: `refs/notes/target`, shared across worktrees. Notes stay local, because the default push refspec leaves `refs/notes/*` out.
- The script: [`scripts/stack-plan.mts`](../scripts/stack-plan.mts), with `scripts/stack-plan` linking to it.

## Not built yet

- Removing notes from commits that have landed in their branch. Nothing reads them once the commit has left the wip branch, but they stay in `refs/notes/target`.
