---
name: stack-check
description: Run each stacked branch's CI checks locally, bottom up, before its pull request is opened, and report the branch where each failure starts. Typed only, because typing it approves the worktree operations its script performs.
disable-model-invocation: true
---

# Stack check

ARGUMENTS: $ARGUMENTS

When the `ARGUMENTS:` line is not expanded, use the user's invocation text. Arguments name the range as `<from> [<to>]`, two branches from the stack. With none, the range runs from the lowest branch without an open pull request to the top of the stack.

Find out which branches would go red in CI before their pull requests exist, so no GitHub Actions minutes go on code already known to fail. This command reports only. `/repos/MyConfig/docs/stack-plan.md` describes the stack and its saved order.

**Name every branch by its name, and every commit by its subject, in anything the user reads.** A sha may follow as a second handle, never stand alone.

## What typing this command approves

**The user typing `/stack-check` approves the operations `scripts/worktree.mts` performs, and nothing else**: adding, moving and removing one scratch worktree, and linking the main checkout's `node_modules` into it.

- Run the script as `node <this skill's base directory>/scripts/worktree.mts <subcommand>`, with the absolute path printed when this skill loaded.
- **Never install dependencies.** The script links the main checkout's installs. Where `goto` warns that a lockfile differs, results for that package may not match the branch: say so in the report, and do not install.
- **Never fix, commit or change a branch.** A fix goes on the wip branch and moves into its branch with stack-plan, which is the user's.
- Run checks only inside the worktree, never in the main checkout.

| Subcommand | Does |
| --- | --- |
| `open` | Adds the worktree at `.agent-context/.tmp/stack-check`, links every `node_modules`, then runs `branches` |
| `branches` | Lists the stack bottom first, marking each branch with an open pull request |
| `goto <branch>` | Discards what the last checks changed, checks the branch out, and warns where a lockfile differs from the main checkout's |
| `close` | Removes the links, then the worktree |

## Work out the checks

1. Read the repository's CI definitions: `.github/workflows/*.yml`, or whatever CI system it uses. Read them in the worktree at the top of the range.
2. Keep the steps that check code: build, typecheck, lint, test, format check and drift check. Drop setup, install, cache, upload and summary steps.
3. Turn each kept step into a command that runs in the worktree. A step that runs an npm script becomes `npm --prefix <worktree> run <script>`. Any other command uses its tool's own directory option. A matrix runs once, on the local toolchain, and the versions left out go under "Not covered".
4. Skip a step that needs secrets, a service, a deployment or a tool that is not installed, and list it under "Not covered".
5. Read the repository's testing guide, such as `agent-project/testing-ops.md`, for failures it says happen in a worktree. Report those as known, never as red.

## Walk the stack

1. Run `open`, and take the range from the arguments or from the pull request marks. Say in one line how many branches and checks the run covers, then go on without waiting.
2. **Start one branch below the range, as the baseline.** Its failures existed before the range, so a failure it shares is not the range's.
3. For each branch, bottom first: run `goto <branch>`, then every check. Record each check's result, and for a failure the test or file and its first error line. Go on to the next branch after a failure.
4. **A failure that also happened on the branch below is inherited.** Compare by test name, file and error message, not by exit status alone.
5. **A failure caused by a missing file that git ignores is a setup gap, not red.** `git check-ignore <path>` in the main checkout tells you. List it under "Not covered".
6. A step whose script does not exist yet on a branch is not red. Note that the check starts on a later branch.
7. Run `close` when the walk ends, including when you stop early.

## The report

- **Header:** which branches in the range are green, and which branches a failure starts on.
- **Body:** one numbered item per branch. A green branch gets one line. A red branch lists each failure that starts there, naming the check, the test or file, and the first error line. Inherited failures appear only as a count, naming the branch where each started.
- **Not covered:** skipped steps, left-out matrix versions, setup gaps, known worktree failures and lockfile warnings.
