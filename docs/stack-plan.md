# stack-plan: moving commits from a wip branch into the stack below it

How to use `scripts/stack-plan` to decide which stacked branch each commit on a wip branch belongs to, keep that decision safe across rebases and aborts, and check the result afterwards. It is written for me returning to this after a while, knowing `git rebase -i` but not the details of this tool.

## Cheatsheet

`sp` is an alias for `stack-plan`, and zsh tab-completes its commands, the flags each one takes, and the refs after `-b`.

| Command         | What it does                                                                              |
| --------------- | ----------------------------------------------------------------------------------------- |
| `sp export`     | Replaces stackplan.txt. Commits with a note are put at the right place.                   |
| `sp save`       | Saves the file as notes on the commits. Add `-n` to see what it will do.                  |
| `sp preview`    | Saves the file as notes, then previews the rebase. Add `-n` to write no notes either.     |
| `sp apply`      | Saves the file as notes, then rebases. Add `-f` to rebase despite a predicted conflict.   |
| `sp prepare`    | Records the pre-rebase tip, so `verify` works after a rebase you run by hand.             |
| `sp verify`     | Checks that the last rebase kept everything "as before", except the reordering.           |
| `sp cut <b>`    | Checks that dropping the branches up to `b` and rebasing the rest onto the base loses no work. `--apply` does it. |
| `sp mode full`  | Makes export list every commit, for reordering like a rebase todo. `short` switches back. |

The usual round is `export`, edit, `preview`, `apply`, `verify`. `save` alone is rarely needed, because `preview` and `apply` both save first.

`e`, `s`, `a` and `v` are short for `export`, `save`, `apply` and `verify`. `-n` is `--dry-run`, `-f` is `--anyway` and `-b` is `--base`. A flag that does not fit the command is refused rather than ignored.

## The problem it solves

Work lands on a wip branch sitting on top of a stack of feature branches, and every so often an interactive rebase moves those commits down into the branches they belong to. Remembering where each commit goes is the hard part, and an aborted rebase used to throw the whole plan away with it. `stack-plan` stores the plan as git notes on the commits themselves, so it survives an abort, a re-export and any number of rebases in between.

Notes rather than a `Target:` trailer in the commit message, because a note sits beside the commit instead of inside it. The final history carries no bookkeeping, and the SHAs are unaffected by tagging.

## What it relies on

`install.sh` sets these globally. Each one matters for a reason the script cannot show:

- `notes.rewriteRef refs/notes/target` — git copies a note onto the rewritten commit on rebase and amend only for refs named here. Without it, every rebase leaves the notes behind on the old SHAs, and the plan is lost the first time something below the commit moves.
- `rebase.updateRefs true` — the rebase todo gets an `update-ref` line per stacked branch, and the plan file borrows that shape.
- `rebase.missingCommitsCheck error` — a todo that leaves a commit out stops the rebase instead of dropping the commit.
- `rerere.enabled true` and `rerere.autoupdate false` — a conflict resolved once is replayed into the file on the next attempt, but left unstaged, so the rebase still stops and the replay gets a look before `git add`. A wrong replay is the risk, and step 4 says how to undo one. `stack-plan verify` below catches one that slipped through, for a rebase that only moves commits.

`install.sh` also links `scripts/` to `~/scripts`, which `.zshrc` puts on `PATH`, so `stack-plan` runs by name from any repository. `.zshrc` also defines the `sp` alias and the completion.

## The loop

Every step runs from inside the repository, with the wip branch checked out. `--base <ref>` (`-b`) changes the ref the stack sits on, and defaults to `origin/main`.

Each git command the script runs is echoed to stderr as `$ git …` before it runs, so the output doubles as a record of what it did. `2>/dev/null` hides that trace and keeps only the result. In a terminal the trace is dimmed and the results are coloured: branches cyan, SHAs yellow, and outcomes marked green `✓`, yellow `!` or red `✗`. Setting `NO_COLOR`, or piping the output, turns colour off.

### 1. Export the plan

```shell
stack-plan export
```

This writes `.agent-context/active-work-context/stackplan.txt`, beside `branchlist.md`. An existing file is copied to `stackplan.txt.bak` first. Success prints the path and how many commits are waiting and untagged.

The header carries two SHAs with separate jobs. `exported-at:` is the wip tip at export, and `save` uses it to tell commits added since from a rewritten branch. `pre-rebase:` is the tip before the last rebase `stack-plan apply` ran, and only `verify` reads it. Export copies `pre-rebase:` over from the old file, so exporting between a rebase and its `verify` leaves the comparison intact.

Export again after any rebase of the wip branch, because the file's SHAs are then gone and `save` refuses it. Commits that merely landed on top since the export leave the file usable, as step 3 describes. A re-export keeps only placements already saved as notes, and the edited file survives as `stackplan.txt.bak`.

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

Move `pick` lines, and `update-ref` lines when the stack itself should change:

- A pick belongs to the first `update-ref` below it. In the example, `acc88e23da` goes to `docs/rewritten-threat-model`.
- A pick between the last `update-ref` and the untagged marker stays on the wip branch. That is recorded too, so commits meant to stay, like the TMP ones, are already in place on the next export.
- A pick below the marker is untagged. Moving a tagged commit back below the marker removes its note.
- The order of the `update-ref` lines is the stack order. Moving one moves that branch, and its own commits go with it as a block.
- An `update-ref` line naming a branch that does not exist adds that branch to the stack, with the picks above it or empty. The rebase creates it.

Commits tagged in an earlier round are exported already sitting in their section, so the file only ever needs the new ones placed. The same goes for a stack order saved but not yet rebased. Export marks them the way the apply todo does: `>>> [moved]` after the hash of a pick whose note moves it into a branch, and a `# >>> [new branch]` or `# >>> [moved branch]` line above a branch the saved order adds or moves. The markers show what was saved at export, not your edits since, and `save` ignores them.

#### Full mode

`stack-plan mode full` makes every later export list each commit since the base, not only the ones waiting on the wip branch. The file then reads like a complete rebase todo: reorder picks within a branch, move a commit from one branch to another, or out of the stack onto the wip branch. `stack-plan mode short` switches back, and `stack-plan mode` alone shows which one is active. The mode lives in git config as `stackplan.mode`.

The export marks the file with a `# mode: full` line, and `save` refuses a file exported in the other mode, so export again after switching. Every commit has to stay in the file exactly once.

Full mode also takes `fixup` (`f`) and `squash` (`s`) in place of `pick`, as in a rebase todo. Either one folds the commit into the pick above it, so it has to follow a pick in the same branch rather than an `update-ref` line. A squash stops the rebase for the combined message. `save` removes the note from a folded commit, because that commit stops existing. `apply` records each fold in the file's `# folded:` line. `verify` then lists the range-diff entries those folds account for under "from folds", rather than as dropped or added, and the tree check still covers them.

Notes record which branch a commit goes to, but not its order within the branch. So in full mode `preview` and `apply` take the todo from the file itself, rather than from the notes. `save` still writes notes for the waiting commits and stores the order, so switching back to short mode loses no placement. A re-export before `apply` does lose any reordering within a branch, except in `stackplan.txt.bak`.

### 3. Save

```shell
stack-plan save --dry-run
stack-plan save
```

`preview` and `apply` both run this step first, so running it on its own is only for checking the notes before anything else.

The dry run lists the notes it would write, grouped under their branch, and the ones it would remove under `untag`. Without `--dry-run` it writes them to `refs/notes/target`. Success ends with `✓` and the number of notes changed, or `notes already match the plan`.

Commits made on top of the wip branch after the export are left untagged and listed as `left untagged, committed after export`. `save` then moves the file's `exported-at:` line to the tip it checked, which is the line it compares against next time. Place such a commit in a later round, or add its `pick` line to the file before saving.

`save` also stores the order of the `update-ref` lines in the repository's git config, as `stackplan.order`, and lists each branch that is new or moves. A branch still to be created is kept in `stackplan.new` until a `verify` finds it exists. The order stays saved after that, because branches sharing a commit, as an empty one does with the branch under it, have no order in git itself.

`save` checks the whole file before writing anything, and on any problem it writes nothing and names the offending line. It refuses a stack branch whose `update-ref` line is gone or doubled, a new name that is already a branch outside the stack, and a new empty branch at the very bottom, which git could not tell from the base. Nearly every other refusal comes from the wip branch having been rewritten since export, and exporting again is the remedy.

### 4. Preview and apply

The agents must be idle before `apply`: they all share one worktree and one HEAD, so a commit made mid-rebase lands on whatever commit the rebase has reached and is carried along from there.

```shell
stack-plan preview
stack-plan apply
```

Both save the file as notes first, and stop there when `save` refuses it. `preview` then lists each move and the base it would use, and previews the rebase. It saves for real, so `apply` afterwards rebases exactly what it showed. `preview -n` writes no notes, so the preview uses the file's placements in their stead. That is the way to preview an edit before any note is written. The preview replays the planned todo in memory, one pick at a time: `git merge-tree --merge-base=<pick>^` applies each pick onto the simulated state so far, and `git commit-tree` records the result. It writes objects but moves no ref and leaves the worktree alone. It either reports that every pick applies cleanly, or names the first pick that would conflict. For a conflict it lists each file with the kind of conflict git reports, such as `content` or `modify/delete`, and the size of the conflict: how many marked regions, and how many lines they hold across both sides. It then names the commits that change the same files and that the pick now sits on, or no longer does. In a reorder that is nearly always the cause. `apply` runs the same preview first and rewrites nothing when it predicts a conflict. `stack-plan apply -f` (`--anyway`) goes ahead regardless, for a conflict you would rather resolve by hand. The preview cannot see resolutions `rerere` has recorded, so a predicted conflict may still resolve itself.

The rebase reads the notes and the saved order, not `stackplan.txt`, so what `save` wrote is what moves. Full mode is the exception, and its todo is the file's own sequence of lines. It rebases from the last commit where that sequence still matches the history. It records the wip tip in the file's `pre-rebase:` line and at the top of `stackplan-rebases.log`, then runs `git rebase -i --update-refs <base>` with itself as git's sequence editor. It builds the whole todo itself, branch by branch in the saved order: each branch's own commits, then the picks moving into it, then its `update-ref` line. It swaps that in for git's todo only when both hold the same picks, and the preview replays the same todo. Then it opens the todo in the editor git would have used, with moved picks marked `[moved]` after their hash, and a `# [new branch]` or `# [moved branch]` comment above each branch that changes. Git ignores everything after the hash on a `pick` line, so the marker never reaches a commit message. Save and close to start the rebase. Empty the todo, or exit the editor with an error (`:cq` in Vim), to call it off. When the rebase finishes, `apply` runs `verify`.

The base is the branch directly under the lowest branch that changes, whether it receives a commit, moves or is new. It is `--base` (`origin/main`) when that is the lowest branch of the stack. Moving the bottom branch therefore rebases the whole stack.

If git's todo and the planned one do not hold the same picks, the sequence editor names the difference and exits non-zero. Git then does not start the rebase. When a pick conflicts, the rebase stops as usual: resolve it, `git rebase --continue`, then run `stack-plan verify` yourself.

#### When rerere replays the wrong resolution

rerere matches on the conflict text, not on what the commit is for. A conflict once resolved by dropping one side is resolved the same way next time, even when this rebase exists to bring that side back. A fixup that ends up empty is the usual sign.

When rerere has a resolution, git prints `Resolved '<file>' using previous resolution.` and writes it into the file. That is why there are no conflict markers, while `git status` still lists the file as `both modified`. Check it with `git diff` before `git add`.

To throw the recorded resolution away and resolve again, while the rebase is still stopped:

```shell
git rerere forget <file>
git checkout -m <file>
```

`forget` deletes the entry for this conflict, and `checkout -m` puts the markers back. Resolve, `git add`, `git rebase --continue`, and rerere records the new resolution in its place.

`forget` only works while the conflict is open. Once the rebase has moved on, the bad entry stays in `.git/rr-cache/` and replays on the next identical conflict. The lost change is still in the old commit, reachable from the SHA in `stackplan-rebases.log`.

### 5. Verify

```shell
stack-plan verify
```

For a rebase you run by hand, run `stack-plan prepare` first. It records the wip tip in the `pre-rebase:` line and in `stackplan-rebases.log`, as `apply` does, creating `stackplan.txt` if there is none. It also clears any `folded:` line, so folds from an earlier `apply` are not taken for this rebase's.

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

When the tree matches and nothing was dropped or added, `verify` finally removes the notes from every commit that has landed in its branch, in one `git notes remove`. Commits still waiting on the wip branch keep theirs. The pre-rebase commits keep their own copies too, so resetting to a SHA from `stackplan-rebases.log` loses no placement. `verify --dry-run` only counts the notes it would remove.

### 6. Cut the stack once its bottom has landed

```shell
git fetch
stack-plan cut <branch>
```

Once the bottom branches have been squash-merged into the base, the stack should lose them and sit on the base instead. `cut` checks, without changing anything, whether dropping every branch up to and including `<branch>`, and rebasing the rest onto `--base`, would lose any work. Fetch first, because it compares against the base as it is locally.

Below the cut it checks each branch on its own, because a squash merge leaves only a branch's end state in the base. It merges the branch's changes into the base in memory, and reads the result:

- `✓ contained` — the merge changes nothing, so the base already has everything the branch did.
- `✗ would be lost` — the merge changes the listed files, so the base lacks part of the branch.
- `! can't tell` — the merge conflicts. Usually the base changed those lines again after merging them, so compare by hand.

Above the cut it replays the remaining commits onto the base, as `preview` does, and reports the first conflict if there is one. When everything applies, it compares the net change of `<branch>..wip` before and after, with `git patch-id`, which ignores line numbers. A file that ends exactly as on wip counts as already in the base rather than lost.

`stack-plan cut <branch> --apply` runs the same check, then does the cut: `git rebase -i --update-refs --empty=drop --onto <base> <branch>`, with the todo opened in your editor as for `apply`. It refuses when the check finds lost work, something it cannot tell, or a conflict, and `-f` (`--anyway`) cuts regardless. `--empty=drop` drops a commit the base already holds, which would otherwise stop the rebase.

Before rebasing, it records the pre-rebase tip as `apply` does, plus a `# cut:` line holding the old cut tip, the new base and the cut branches. `verify` reads that line, so after a cut it compares the commits above the old cut with those on the new base. In place of the tree check, which cannot match once the base has moved, it compares the net change as `cut` does. A commit the rebase dropped because the base already holds its change counts as `already in the base`, not dropped. Once that passes, `verify` removes the cut branches from `stackplan.order` and prints the `git branch -D` that deletes them. It never deletes them itself. `prepare` and `apply` clear the `# cut:` line, so it only ever describes the latest rebase.

## Where things live

- The plan: `.agent-context/active-work-context/stackplan.txt` in the repository it was exported from, plus `stackplan.txt.bak`. It is gitignored scratch.
- The rebase log: `stackplan-rebases.log` beside the plan, one `[yymmdd hhmm] <sha>` line per rebase `stack-plan apply` ran, newest first. Each SHA is the wip tip from before that rebase, the one to hand `git restore --source=` to go back.
- The notes: `refs/notes/target`, shared across worktrees. Notes stay local, because the default push refspec leaves `refs/notes/*` out.
- The stack order: `stackplan.order` and, while a branch waits to be created, `stackplan.new`, in the repository's git config.
- The script: [`scripts/stack-plan.mts`](../scripts/stack-plan.mts), with `scripts/stack-plan` linking to it.
