---
name: stack-review
description: Review a finished stack of branches as the pull requests a reviewer will meet - one topic each, standing alone, in an order that reads - and report which commits or branches to move. Typed only, run after the rebases are done.
disable-model-invocation: true
---

# Stack review

ARGUMENTS: $ARGUMENTS

When the `ARGUMENTS:` line is not expanded, use the user's invocation text. Arguments name the range as `<from> [<to>]`, two branches from the stack. With none, the range is the whole stack.

Judge whether the stack is a set of branches that makes sense, after `/rebase-resolve` has put each commit where the plan said. CI cannot answer this, and `/stack-check` answers the CI question, so run this one first: a stack whose shape is about to change is not worth testing. `/repos/MyConfig/docs/stack-plan.md` describes the stack and its saved order.

**Name every branch by its name, and every commit by its subject, in anything the user reads.** A sha may follow as a second handle, never stand alone.

**This command reports only.** Run no mutating git verb, and leave stackplan.txt and the notes under `refs/notes/target` alone. A move is the user's, made with stack-plan and carried out with `/rebase-resolve`.

## Read the stack

1. Read the order and the base as [commit-placement.md](../../guides/commit-placement.md) → "Reading the stack" says. The wip branch on top is out of scope.
2. Mark each branch with an open pull request, from `gh pr list --state open --json number,headRefName`. Where `gh` fails, say so once and mark none.
3. For each branch in the range, bottom first, read its commits with `git log --stat --format='%h %s%n%b' <branch below>..<branch>`. Read a commit's diff with `git show <sha>` where its subject and files leave its purpose unclear.
4. **Write each branch's summary: the one-line title its pull request would carry.** Every check below measures the branch against that line.

## The checks

Run each check on every branch in the range. Read the branches outside the range only for comparison.

1. **Cohesion.** A summary that needs "and" to cover the branch is two topics. Name the commits behind each topic.
2. **Placement.** Apply [commit-placement.md](../../guides/commit-placement.md) to every commit, not just the ones the last plan moved.
3. **Split concepts.** A concept may start on one branch and finish on a higher one. Look for a commit on a higher branch that completes code a lower branch's commit created, on the lower branch's topic. The lower branch then ships its summary half done. Report it where the lower branch's summary would be false without the higher commit.
4. **Standing alone.** Each branch has to make sense with only itself and the branches below it. Look for a name the branch uses that only a higher branch adds: a symbol, a file, a link target, a skill, a command or a config key. `git log -S'<name>' --format='%h %s' <base>..<top>` finds the commit that adds it. `git cat-file -e <branch>:<path>` checks a link target. The build catches a missing symbol, never a dangling link in prose, so check both.
5. **Churn.** A higher branch may rewrite or revert what a lower one added. For each file a branch adds or changes, `git log --format='%h %s' <branch>..<top> -- <file>` lists the later commits on it. Read those that remove lines the branch added. Report where a large part of the branch's change never ships, because its reviewer reviews code a later branch replaces.
6. **Grain.** A branch whose topics have nothing to do with each other may need a split. A branch whose summary is a part of its neighbour's may need a merge. Report a grain finding only with a concrete split or merge.

**A move into or out of a branch with an open pull request costs its reviewer a second review.** Say so on any finding that suggests one, and prefer a fix that keeps the reviewed branch as it is.

## The report

- **Header:** whether the stack holds together, and which branches have findings.
- **Body:** one numbered item per branch in the range, bottom first, opening with its summary and any pull request number. A branch without findings gets that line only. Each finding under it takes `F1`, `F2` and so on across the whole report. It names the check, the commits by subject and the move: the branch a commit belongs on, a split, a merge or a reorder. Where a suggested move has a cost, such as a conflict it would likely bring or a reviewer it would affect, say so.
- **Unclear:** what the review could not decide, such as a commit whose topic its subject and diff leave open. Leave this section out when it is empty.
