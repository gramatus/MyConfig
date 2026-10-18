# Commit placement

How to tell that a commit sits on the wrong branch of a stack. `/rebase-resolve` applies this to the commits a plan moves, before the rebase. `/stack-review` applies it to every commit in the stack, after the rebases.

## Reading the stack

`git config --get stackplan.order` lists the stack's branches, bottom first. The first line of `.agent-context/active-work-context/stackplan.txt` names the base the lowest branch sits on. Read only that file: it is the user's plan.

Read each branch's own commits with `git log --stat --format='%h %s' <branch below>..<branch>`, using the base as the branch below the lowest one. Compare each commit's subject, scope and files with those of its own branch and of every other branch.

## The signs

The list is illustrative, not exhaustive:

- it is a `fixup!` or `squash!` of a commit on another branch, or its subject names one;
- it touches files no other commit on its branch touches, while another branch's commits touch them;
- its conventional-commit scope matches another branch's commits and none of its own branch's.

**One sign from the last two alone is too weak to report.** Where the better branch is directly above or below, say so: a line one `update-ref` off in the plan is the usual slip.

## Not a sign

**Code the commit uses from a higher branch is not a sign of wrong placement.** Moving a concept below the code it was written on is an ordinary reorder. Whether the commit still works at its new position is a separate question. `/rebase-resolve` asks it as the feasibility check before the move, and `/stack-review` asks it as the standing-alone check after.
