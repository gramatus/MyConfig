# stack-plan: moving commits from a wip branch into the stack below it

How to use `scripts/stack-plan` to decide which stacked branch each commit on a wip branch belongs to, keep that decision safe across rebases and aborts, and check the result afterwards. It is written for me returning to this after a while, knowing `git rebase -i` but not the details of this tool. The rebase itself is still run by hand, as described under "Not built yet".

## Cheatsheet

| Command             | What it does                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `stack-plan export` | Replaces stackplan.txt. Commits with a note are put at the right place.                    |
| `stack-plan apply`  | Adds notes to the commits about the target branch. Add `--dry-run` to see what it will do. |
| (missing)           | Applies the rebase according to stackplan.txt                                              |
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

Each git command the script runs is echoed to stderr as `$ git …` before it runs, so the output doubles as a record of what it did. `2>/dev/null` hides that trace and keeps only the result.

### 1. Export the plan

```shell
stack-plan export
```

This writes `.agent-context/active-work-context/stackplan.txt`, beside `branchlist.md`. An existing file is copied to `stackplan.txt.bak` first. Success prints the path and how many commits are waiting and untagged.

Export again after any rebase of the wip branch, because the file's SHAs are then gone and `apply` refuses it. Commits that merely landed on top since the export leave the file usable, as step 3 describes. A re-export keeps only placements already applied as notes, and the edited file survives as `stackplan.txt.bak`.

### 2. Place each commit

The file is shaped like a rebase todo:

```text
# stack-plan for gramatus/wip on origin/main, exported 2026-09-26T13:54:08.513Z
# pre-rebase: c2db5abc775659028ed267814355ba53f1aa7047
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

The dry run prints each `tag` and `untag` it would make. Without `--dry-run` it writes them to `refs/notes/target`. Success ends with the number of notes changed, or `Notes already match the plan`.

Commits made on top of the wip branch after the export are left untagged and listed as `Left untagged, committed after export`. `apply` then rewrites the file's `pre-rebase:` line to the tip it checked, so `verify` compares against the state right before the rebase. Place such a commit in a later round, or add its `pick` line to the file before applying.

`apply` checks the whole file before writing anything, and on any problem it writes no notes and names the offending line. Nearly every refusal comes from the wip branch having been rewritten or the stack having changed since export, and exporting again is the remedy.

### 4. Rebase

This step is manual for now. The agents must be idle first: they all share one worktree and one HEAD, so a commit made mid-rebase lands on whatever commit the rebase has reached and is carried along from there.

```shell
git rebase -i <base>
```

In the todo, move each pick above the `update-ref` of the branch its note names. The `pre-rebase:` line in `stackplan.txt` is the tip `verify` compares against, and `apply` sets it to the tip it saw. Run the rebase right after `apply` with nothing committed in between, or run `apply` again first.

The base has to sit below the lowest branch receiving a commit, because a branch whose tip is the base gets no `update-ref` line in the todo. Use the tip of the branch directly under the lowest receiving branch, or `origin/main` when the lowest branch of the stack receives. Everything above the base is rewritten either way, so a higher base only shortens the todo.

`git log --notes=target --oneline <base>..` shows the notes beside the commits while you edit.

### 5. Verify

```shell
stack-plan verify
```

A rebase that only moves commits leaves the wip branch's final tree exactly as it was, and `verify` checks that in two ways.

`git diff --stat <pre-rebase> <wip>` should be empty, and then it prints `Tree matches the pre-rebase tip`. When the tree differs, it lists the files and prints the command that puts the old tree back as uncommitted changes:

```shell
git restore --source=<pre-rebase> --staged --worktree :/
```

That is `restore` rather than `git checkout <sha> .`, because `checkout` only writes paths that exist in the source commit. A file that the rebase brought back, and that the old tip did not have, survives `checkout` unnoticed and is removed by `restore`. Read the stat before restoring: the list says where a resolution went wrong, and restoring first hides it.

`git range-diff <base>..<pre-rebase> <base>..<wip>` then pairs each old commit with its rewritten version. `verify` prints a count per marker and the full entry for everything that is not `=`:

- `=` — the patch is identical. A moved commit normally shows this.
- `!` — the patch changed, and range-diff prints the diff between the two diffs beneath it. On a moved commit that can be only its context lines shifting, but a conflict resolution shows up here too, so read it.
- `<` — the commit was dropped.
- `>` — the commit is new.

After a clean reorder the count reads `0 dropped, 0 added`, and each `!` has been read and understood.

## Where things live

- The plan: `.agent-context/active-work-context/stackplan.txt` in the repository it was exported from, plus `stackplan.txt.bak`. It is gitignored scratch.
- The notes: `refs/notes/target`, shared across worktrees. Notes stay local, because the default push refspec leaves `refs/notes/*` out.
- The script: [`scripts/stack-plan.mts`](../scripts/stack-plan.mts), with `scripts/stack-plan` linking to it.

## Not built yet

- Generating the rebase todo from the notes, and starting the rebase from the right base, so step 4 stops being manual.
- A conflict preview before rebasing, simulating each move in memory with `git merge-tree --write-tree --merge-base`.
- Removing notes from commits that have landed in their branch. Nothing reads them once the commit has left the wip branch, but they stay in `refs/notes/target`.
