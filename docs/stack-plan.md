# stack-plan: moving commits from a wip branch into the stack below it

How to use `scripts/stack-plan` to decide which stacked branch each commit on a wip branch belongs to, keep that decision safe across rebases and aborts, and check the result afterwards. It is written for me returning to this after a while, knowing `git rebase -i` but not the details of this tool.

## Cheatsheet

`sp` is an alias for `stack-plan`, and zsh tab-completes its commands, the flags each one takes, and the refs after `-b`.

| Command | What it does |
| --- | --- |
| `sp export` | Replaces stackplan.txt. Commits with a note are put at the right place. |
| `sp save` | Saves the file as notes on the commits. Add `-n` to see what it will do. |
| `sp preview` | Saves the file as notes, then previews the rebase. Add `-n` to write no notes either. |
| `sp apply` | Saves the file as notes, then rebases. Add `-f` to rebase despite a predicted conflict. |
| `sp prepare` | Records the pre-rebase tip, so `verify` works after a rebase you run by hand. |
| `sp verify` | Checks that the last rebase kept everything "as before", except the reordering. |
| `sp cut <b>` | Checks that dropping the branches up to `b` and rebasing the rest onto the base loses no work. `--apply` does it. |
| `sp cut <__b>...` | The same for only the named `__` branches, wherever they sit, once their extracted copies have merged. |
| `sp cut --merged` | The same for every `__` branch that has landed, without naming them. |
| `sp sync` | Checks putting each stack branch on its origin copy, with local work replayed on top. `--apply` does it. |
| `sp extract` | Checks copying each `__` branch off the stack, onto its name without the prefix. `--apply` does it. |
| `sp extractable` | Lists the branches that could become `__` branches, as far as the text shows. |
| `sp mark <b>...` | Renames each branch to its `__` name, carrying its notes and the saved order along, and exports the plan with them as one block. Add `-n` to see what it will do. |
| `sp mode full` | Makes export list every commit, for reordering like a rebase todo. `short` switches back. |

The usual round is `export`, edit, `preview`, `apply`, `verify`. `save` alone is rarely needed, because `preview` and `apply` both save first.

`e`, `s`, `a` and `v` are short for `export`, `save`, `apply` and `verify`. `-n` is `--dry-run`, `-f` is `--anyway` and `-b` is `--base`. A flag that does not fit the command is refused rather than ignored. `--verbose` fits every command.

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

`--verbose` echoes each git command to stderr as `$ git …` before it runs. The trace then records what the tool did, such as writing notes, setting `stackplan.*` config and starting the rebase, and shows how each answer was reached. It also gives `verify`'s `range-diff` and `diff --stat` in a form you can rerun by hand. Without `--verbose`, only the results are printed. In a terminal the trace is dimmed and the results are coloured: branches cyan, SHAs yellow, and outcomes marked green `✓`, yellow `!` or red `✗`. Setting `NO_COLOR`, or piping the output, turns colour off.

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

Export also asks `gh` for the open pull requests and writes `# --- PRs stop here ---` above the first branch that has none. A pick placed above that line lands in a branch already under review. Export warns about a PR that sits above a branch with no PR, and about one whose base is not the branch below it. When `gh` cannot list the PRs, export warns and leaves the marker out.

Branches named with a `__` prefix are extract sources, which step 8 describes. Export writes a `# mirror:` line above each one, giving the state of its extracted copy, and `# --- Other stacks stop here ---` below the last one. It warns about a PR branch above a `__` branch, because pushing it would carry that branch's commits, and about `__` branches that do not form one block.

#### Full mode

`stack-plan mode full` makes every later export list each commit since the base, not only the ones waiting on the wip branch. The file then reads like a complete rebase todo: reorder picks within a branch, move a commit from one branch to another, or out of the stack onto the wip branch. `stack-plan mode short` switches back, and `stack-plan mode` alone shows which one is active. The mode lives in git config as `stackplan.mode`.

The export marks the file with a `# mode: full` line, and `save` refuses a file exported in the other mode, so export again after switching. Every commit has to stay in the file exactly once.

Full mode also takes `fixup` (`f`), `fixup -C` and `squash` (`s`) in place of `pick`, as in a rebase todo. Either one folds the commit into the pick above it, so it has to follow a pick in the same branch rather than an `update-ref` line. A squash stops the rebase for the combined message. `save` removes the note from a folded commit, because that commit stops existing. `apply` records each fold in the file's `# folded:` line. `verify` then lists the range-diff entries those folds account for under "from folds", rather than as dropped or added, and the tree check still covers them.

Notes record which branch a commit goes to, but not its order within the branch. So in full mode `preview` and `apply` take the todo from the file itself, rather than from the notes. `save` still writes notes for the waiting commits and stores the order, so switching back to short mode loses no placement. A re-export before `apply` does lose any reordering within a branch, except in `stackplan.txt.bak`.

#### Folding by subject

A commit whose subject starts with `fixup!`, `squash!` or `amend!` folds into the commit its subject names, as `git rebase --autosquash` would fold it. The subject is the whole instruction: `preview` and `apply` fold it in either mode, with no edit to the plan.

The text after the prefix names the target. Like git, stack-plan looks for it among the earlier commits since the base, in this order:

1. A commit with exactly that subject.
2. A commit whose SHA starts with that text.
3. A commit whose subject starts with that text.

Nested prefixes, as in `fixup! fixup! feat: x`, fold into the commit at the root. A subject that matches no earlier commit stays an ordinary commit, and `export` and `preview` warn about it. A subject naming a commit the base already holds is the usual case.

The outer prefix gives the verb. `fixup!` becomes `fixup`, which keeps the target's message. `squash!` becomes `squash`, which stops the rebase for the combined message. `amend!` becomes `fixup -C`, which replaces the target's message with the amend commit's message. Git leaves out the `amend!` line itself.

The fold goes straight after its target, and after any earlier folds into it. It follows the target wherever the target lands: in its own branch, or in the branch a waiting target moves to. The target's branch then counts as changed, so the rebase starts at the branch below it. `save` removes the note from a folding commit, and the rebase ignores it.

In short mode the plan file shows a folding commit only as a comment under its target's branch, such as `# fold fixup 56f119bbf5 fixup! feat(hooks): … → into 3a1c9e0b2d`. `save` ignores that comment. In full mode export writes the real `fixup`, `squash` or `fixup -C` line after the target. In either mode `save` refuses a folding commit listed as `pick`, and exporting again replaces that line.

Only `preview` and `apply` fold. `cut`, `sync` and `extract` replay a folding commit as it is.

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

Both save the file as notes first, and stop there when `save` refuses it. `preview` then lists each move and the base it would use, and previews the rebase. It saves for real, so `apply` afterwards rebases exactly what it showed. `preview -n` writes no notes, so the preview uses the file's placements in their stead. That is the way to preview an edit before any note is written. The preview replays the planned todo in memory, one pick at a time: `git merge-tree --merge-base=<pick>^` applies each pick onto the simulated state so far, and `git commit-tree` records the result. It writes objects but moves no ref and leaves the worktree alone. It either reports that every pick applies cleanly, or lists every pick that would conflict. To get past a conflict it assumes you keep the pick's side: it redoes the merge with `-X theirs`, and takes the pick's whole version of any file that still conflicts, as a modify/delete does. Each conflict opens with the commit and the branch it lands on. Next come the commits that change the same files and that it now comes after or before, which in a reorder is nearly always the cause. Each of those shows its own branch too, or `base` for a commit the base already holds. Then each conflicted file, with the size of the conflict: how many marked regions, and how many lines they hold across both sides. The kind of conflict git reports is shown only where it is not plain `content`, such as `modify/delete`. A later conflict in files an earlier one shares is listed under it as `also conflicting`, because it may only follow from that guess. It names only the commits the earlier entry has not. The headline counts those as one conflict, and gives the number of picks they span. Where the commit now comes before commits on a higher branch, a closing `to keep the old order` line names the lowest branch that puts it after all of them again. That restores the order without promising a clean replay, and moving a whole branch is the other way out. The headline comes last, so the end of the output is the answer. `apply` runs the same preview first and rewrites nothing when it predicts a conflict. `stack-plan apply -f` (`--anyway`) goes ahead regardless, for a conflict you would rather resolve by hand. The preview cannot see resolutions `rerere` has recorded, so a predicted conflict may still resolve itself.

The rebase reads the notes and the saved order, not `stackplan.txt`, so what `save` wrote is what moves. Full mode is the exception, and its todo is the file's own sequence of lines. It rebases from the last commit where that sequence still matches the history. It records the wip tip in the file's `pre-rebase:` line and at the top of `stackplan-rebases.log`, then runs `git rebase -i --update-refs <base>` with itself as git's sequence editor. It builds the whole todo itself, branch by branch in the saved order: each branch's own commits, then the picks moving into it, then its `update-ref` line. It swaps that in for git's todo only when both hold the same picks, and the preview replays the same todo. Then it opens the todo in the editor git would have used, with moved picks marked `[moved]` after their hash, and a `# [new branch]` or `# [moved branch]` comment above each branch that changes. Git ignores everything after the hash on a `pick` line, so the marker never reaches a commit message. Save and close to start the rebase. Empty the todo, or exit the editor with an error (`:cq` in Vim), to call it off. When the rebase finishes, `apply` runs `verify`.

The base is the branch directly under the lowest branch that changes, whether it receives a commit, moves or is new. When that is the lowest branch of the stack, the base is the commit where the stack leaves `--base` (`origin/main`), and the preview shows that commit. Moving the bottom branch therefore rebases the whole stack, but keeps it where it was on `origin/main`. Moving the stack onto newer `origin/main` commits is the work of `cut` and `sync`.

If git's todo and the planned one do not hold the same picks, the sequence editor names the difference and exits non-zero. Git then does not start the rebase. The `pre-rebase:` line already holds the new tip by then, because `apply` and `cut` record it before git runs, and that is intended: once you have run either, the tip before an earlier rebase is no longer the one to verify against. When a pick conflicts, the rebase stops as usual: resolve it, `git rebase --continue`, then run `stack-plan verify` yourself. The same goes for an `edit` or `break` you add while reviewing the todo. Git exits 0 at that pause, so stack-plan checks for a rebase still in progress and stops there instead of verifying.

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

When the tree matches and nothing was dropped or added, `verify` removes the notes from every commit that has landed in its branch, in one `git notes remove`, and then prints the tree verdict as its last line. Commits still waiting on the wip branch keep theirs. The pre-rebase commits keep their own copies too, so resetting to a SHA from `stackplan-rebases.log` loses no placement. `verify --dry-run` only counts the notes it would remove.

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

Before rebasing, it records the pre-rebase tip as `apply` does, plus a `# cut:` line holding the old cut tip, the new base and the cut branches. `verify` reads that line, so after a cut it compares the commits above the old cut with those on the new base. In place of the tree check, which cannot match once the base has moved, it compares the net change as `cut` does. It also checks that the tip tree changed only in files where the new base differs from the old cut tip. A commit the rebase dropped because the base already holds its change counts as `already in the base`, not dropped. Once that passes, `verify` removes the cut branches from `stackplan.order` and prints the `git branch -D` that deletes them. It never deletes them itself. `prepare` and `apply` clear the `# cut:` line, so it only ever describes the latest rebase.

### 7. Sync with origin after GitHub rebased the stack

```shell
stack-plan sync
```

```shell
stack-plan sync --apply
```

When GitHub merges the bottom pull request of a stack, it rebases the ones above it, and every local branch then shows as diverged in `git-tools sync-check`. `sync` puts each stack branch back on its origin copy, and replays everything origin lacks on top. Its origin copy is the branch's upstream, or `origin/<branch>`. Like `cut`, it changes nothing without `--apply`, and `-f` (`--anyway`) does it despite a finding. It first runs `git fetch --prune origin`, so it compares against origin as it is now. `--no-fetch` skips that, for working offline or for comparing two runs against the same refs.

It sorts every commit since the base, bottom to top, by its `git patch-id`, which a rebase leaves unchanged:

- A local commit whose change origin holds under another SHA gives way to origin's copy. Origin's copy is taken whole, so a review fix pushed on GitHub comes along too.
- A local commit origin lacks stays in its branch, on top of that branch's origin commits. It is listed as `kept local`. The branches above it then differ from origin again, and need a force push.
- A branch that is not on origin, and the wip branch, have their commits replayed above the branch below them. The wip branch's own origin copy is left alone.
- Origin's stack is the run of origin branches, counted from the top down, where each sits on the one below. A branch below that run is cut, because origin's stack has moved past it. That holds whether origin deleted the branch after merging it or still has a copy left behind. A branch that origin's stack still sits on is kept. Each cut branch gets the same containment check as `cut`. A branch the base does not plainly contain is listed with its files, as a finding to compare by hand. A squash merge that review changed, or lines the base changed again since, cause that. A cut branch keeps its old tip, so its commits stay reachable.

It refuses when origin's branches do not sit on one another in stack order, or when origin's stack holds a merge commit. It reports a finding when you reworded a commit or changed its author after pushing it, because syncing would bring back origin's version, and pushing is what you want. A commit that differs from origin's copy only in its base or its dates is not a finding: syncing it is safe and avoids the CI runs and reset approvals a push would cause.

It also compares origin's stack with the base. Where the local stack sits on a newer base than origin's, it lists the base commits that syncing takes out from under the stack. Where origin's stack would conflict on merge into the base, it names the lowest conflicting branch and its files. Syncing leaves that conflict in place, and a rebase onto the base followed by a push is what fixes it. Neither is a finding, because syncing loses no work either way. It also reports one when the in-memory replay predicts a conflict.

When the replay is clean, two checks stand in for the tree check, which cannot match once the base has moved. The net change from the topmost origin branch up to wip must be the same before and after, as after a `cut`. The tip tree must also be unchanged, except in files where origin's copy of the stack differs from yours. A file that changes anywhere else means work went missing or appeared on the way, and it is a finding. When the tip tree is identical to the old one, a cut branch the containment check could not clear loses nothing either, so its flag stops counting as a finding.

`--apply` runs `git rebase -i --update-refs --empty=drop --onto <onto> <fork>`. `<onto>` is where origin's lowest branch leaves the base, and `<fork>` is where the local stack does. Git's todo then holds exactly the local commits. The planned todo picks origin's commits, which git reuses unchanged where their parent matches, so a branch with nothing kept local ends up identical to origin. Each commit giving way is a `drop` line, which `rebase.missingCommitsCheck error` requires. Local commits kept in an origin branch carry `>>> [local]` after their hash.

It records a `# sync:` line, which works like the `# cut:` line. After a sync, `verify` compares the old stack with the new one from where each leaves the base. It counts commits only origin had as `from origin`, and a dropped commit whose change origin holds as already there. It then runs the two checks the preview ran, on the real result. Cut branches are then removed from `stackplan.order` as after a cut.

### 8. Extract branches that need not be stacked

```shell
stack-plan extract
```

```shell
stack-plan extract --apply
```

Some branches in a stack do not depend on the branches below them, and could be pull requests of their own on the base. `extract` lets such a branch leave the stack while wip keeps its commits. Inside the stack the branch keeps a `__` prefix, as in `__skills/foo`, and is called an extract source. Its extracted copy is the branch named without the prefix, `skills/foo`, and it sits on the base rather than in the stack. The prefix is reserved for this, so every `__` branch in the stack is an extract source.

`stack-plan extractable` finds the candidates. It tests each branch above the PR branches and the `__` block, and changes nothing. A branch is a candidate when two in-memory replays are clean:

- Its own commits replayed onto `--base`. When that conflicts, it adds the branches below that change the conflicting files and tries again, so a branch that needs another one is reported together with it. A needed branch that has a PR, or sits in the `__` block, makes the branch no candidate.
- The stack replayed with the branch, and any branches it needs, moved to just above the PR branches and the `__` block. That is the todo a `preview` of the move would run.

Candidates that need each other form a chain, and the output groups them that way. It lists the branches that stand alone first, then each chain in stack order with what each member needs, then the branches that cannot leave. A chain is extracted as one stack in that order, so keep its members in that order in the `__` block. A chain shaped like a tree is flattened: a member that needs only the bottom branch still sits on the member below it. It ends with the `stack-plan mark` line that marks the candidates. A clean replay only shows that the text applies, not that the code still builds: a branch can still call something a branch below it adds. Each candidate's line ends with `replays to <sha>`, the in-memory commit its replay onto the base ends at. `--json` prints the same result as JSON, with each chain member's start and replay commits. The `/stack-extract` skill checks that commit out in a scratch worktree, runs the typecheck and build there, and reads the change for what it uses from below.

A branch can need another without any text conflict, such as a link to a file the other one adds. `stack-plan needs <branch> <needed>...` records that, and `extractable` and `extract` then treat it like a need a conflict found. The branch joins the needed branch's chain, its replay starts on that branch's replay, and its extracted copy goes on that branch's copy. The output marks such a need `(declared)`, and `--json` lists it under each member's `declared`. A declared need brings its own declared needs along. `needs` refuses a branch that is not in the stack or sits above the one that needs it. Naming no others shows what is recorded, and `--clear` forgets it first. The record is the multi-valued git config key `branch.<name>.stackNeeds`. `git branch -m` moves it along, so it follows `mark`'s rename, and a needed branch matches with or without its `__` prefix. A need no longer in the stack counts as landed. A declared need that sits above its branch after a reorder, or that may not join, makes the branch no candidate.

The `__` branches go in one block directly above the branches that have PRs. `stack-plan mark <branch>...` gets them there:

- It renames each branch to its `__` name.
- It rewrites the note of each waiting commit placed in the branch, and the saved order in `stackplan.order` and `stackplan.new`, all of which name branches. A plain `git branch -m` leaves them naming the old one.
- It saves the order with the marked branches as one block directly above the PR branches and any `__` block already there, in stack order, so each chain keeps its order.
- It exports the plan, keeping the earlier file as `stackplan.txt.bak`.

It refuses a branch that is not in the stack, already has the prefix, has a PR, or whose `__` name is taken. `-n` prints the renames and the moves without making them. Then run `preview`, `apply` and `verify`. The preview also tells you whether the branch depended on something it now sits below, because that shows as a conflict. It cannot tell whether the branch depends on the PR branches that stay below it. `extract` checks that part.

`extract` changes nothing without `--apply`. It works through the `__` branches from the bottom up:

- An extracted copy that does not exist yet is made by replaying the source's own commits. It first works out the chains among the `__` branches, the same way `extractable` does. A branch that stands alone goes on `--base`. A branch in a chain goes on the extracted copy of the member below it, so each copy holds everything it needs. A branch that needs something outside the block is a finding.
- An extracted copy that exists gets the source's commits that it lacks, matched by `git patch-id`, replayed on top. That only moves it forward, so its PR needs no force push. If the copy holds commits the source lacks, such as a review fix pushed on GitHub, that is a finding, and the branch is left alone until those commits are in the source too.
- An extracted copy that sits on the copy of a lower `__` branch, where that lower copy has moved since, is rebuilt. Its own commits are replayed onto the lower copy's new tip, followed by any source commits it lacks. Rebuilding rewrites the branch, so `--apply` resets the local branch and ends by printing the `git push --force-with-lease` its PR needs. Export's `# mirror:` line shows such a copy as `on an old <branch>`.
- An extracted copy that sits on commits the base already holds is rebuilt where a new copy would go: on `--base`, or on the copy of the member below it in its chain. That happens when a lower member of its chain merged and was cut. Its own commits are the run at its tip that match the source by `git patch-id`, and the commits under that run must merge into the base without changing it. Export's `# mirror:` line shows such a copy as `on landed commits`.
- A `__` branch whose unprefixed name is also a stack branch is a finding.

The replay writes real commits, keeping each commit's author, author date and message, and stops at the first conflict. It signs every commit it writes, and fails when git has no signing key, because the org requires signed commits. `--apply` then moves each extracted copy with `git update-ref`, which refuses if the branch was created or moved since the check. It runs no rebase and leaves the worktree and the stack alone, so the agents need not be idle. `-f` (`--anyway`) moves the branches that came out clean despite a finding elsewhere. Run it again whenever a `__` branch gets new commits; a second run adds only what is new.

Once an extracted copy has been squash-merged, `extract` reports its `__` branch as already in the base, or as merged on GitHub, and leaves it alone. Fetch, then take the branch out of the stack with `cut`:

```shell
stack-plan cut __skills/foo
```

```shell
stack-plan cut __skills/foo --apply
```

`stack-plan cut --merged` names them for you. It picks every `__` branch that has landed by the first test below, and lists each one it leaves out because the content check can't tell. The rest goes as for named branches, and `stack-plan cut --merged --apply` does it. Merged branches of the main stack, the ones without the prefix, stay with `sync`, which also puts the branches above them back on GitHub's rebased copies.

Given `__` branches, `cut` drops only those, wherever they sit, rather than everything up to them. It refuses a name without the prefix among them. It checks three things:

- Every branch below the lowest named one is a `__` branch. Those are never pushed, so moving them onto the base rewrites no branch with a PR. A branch without the prefix below is a finding, and cutting it first is the remedy.
- Each named branch has landed. `gh` decides first: a copy whose PR merged after the copy was made counts as landed. The merge time ties the PR to the copy, because review fixes and GitHub's rebases change the PR's head, and an older PR may have used the same branch name. Otherwise the base must contain the branch, checked on its own as `cut` checks a branch below the cut. That content check says "can't tell" when later merges changed the same lines again, which is why GitHub's answer comes first.
- The rest of the stack replays onto the base in memory without a conflict. Its net change is the same as before, apart from files that end as they did on wip. A file that ends differently and that the base also changed since the fork is "can't tell", not lost, because the two changes may simply sit side by side. `cut` prints a `git diff` for each such file, from the old wip to the replayed result. Read it, then drop with `-f`. The tip tree changes only in files where the base moved since the stack left it.

`--apply` then runs `git rebase -i --update-refs --empty=drop --onto <base> <fork>`, where `<fork>` is where the stack leaves the base. The todo has a `drop` line for each commit of the named branches and leaves out their `update-ref` lines, so those branches keep their old tips. It refuses on a finding, and `-f` (`--anyway`) drops regardless. It records a `# cut:` line whose old range starts at the fork. `verify` then counts the dropped commits as already in the base, and runs the same two checks on the real result. Once they pass, it removes the named branches from `stackplan.order`. It then rebuilds every extracted copy that sat on the copy of a cut branch, as `extract` does, along with the copies chained above them. Last, it prints the `git branch -D` that deletes the cut branches and their extracted copies. `verify --dry-run` only reports the rebuilds. The rebuild moves local branches only, so a rebuilt copy's PR needs a force push, and a PR whose base was a merged copy needs its base changed by hand.

## Where things live

- The plan: `.agent-context/active-work-context/stackplan.txt` in the repository it was exported from, plus `stackplan.txt.bak`. It is gitignored scratch.
- The rebase log: `stackplan-rebases.log` beside the plan, one `[yymmdd hhmm] <sha>` line per rebase `stack-plan apply` ran, newest first. Each SHA is the wip tip from before that rebase, the one to hand `git restore --source=` to go back.
- The notes: `refs/notes/target`, shared across worktrees. Notes stay local, because the default push refspec leaves `refs/notes/*` out.
- The stack order: `stackplan.order` and, while a branch waits to be created, `stackplan.new`, in the repository's git config.
- The script: [`scripts/stack-plan.mts`](../scripts/stack-plan.mts), with `scripts/stack-plan` linking to it.
