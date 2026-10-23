---
name: stack-extract
description: Find the stack branches that could leave the stack as pull requests of their own, and check that each one still builds without the branches below it. Typed only, because typing it approves the worktree operations and checks its scripts perform.
disable-model-invocation: true
---

# Stack extract

Find out which branches in the stack can become `__` branches, the extract sources that `stack-plan extract` copies onto the base as pull requests of their own. `stack-plan extractable` answers that for the text: whether each branch's commits apply without the branches below it. This skill adds what the text cannot show: whether the code still builds there. `/repos/MyConfig/docs/stack-plan.md` → "8. Extract branches that need not be stacked" describes both commands.

This command reports only. **Never rename a branch, edit the plan, or run `stack-plan extract`.** Those steps are the user's.

## What typing this command approves

**The user typing `/stack-extract` approves what this skill's three scripts do, and nothing else**: adding, cleaning, moving and removing one scratch worktree, linking the main checkout's `node_modules` into it, saving results under `.agent-context/.tmp/stack-extract-results/`, and running the repository's own npm scripts inside that worktree.

- Run each script as `node <this skill's base directory>/scripts/<script> <arguments>`, with the absolute path printed when this skill loaded.
- **Never install dependencies.** Where a lockfile differs from the main checkout's, results for that package may not match the commit: say so in the report, and do not install.
- Run checks only inside the worktree, never in the main checkout.

| Script | Does |
| --- | --- |
| `candidates.mts` | Runs `stack-plan extractable --json`, saves it as `candidates.json`, and saves each candidate's own change as `<branch>.diff`, with `/` turned into `-` |
| `worktree.mts open` | Adds the worktree at `.agent-context/.tmp/stack-extract` and links every `node_modules` |
| `worktree.mts goto <ref>` | Discards what the last checks left, sparing the `node_modules` links, and checks out the ref detached |
| `worktree.mts close` | Removes the links, then the worktree |
| `checks.mts <script>...` | Runs each npm script at the base, then at each candidate's replay commit, chains bottom first, and sorts each result |

## 1. Find the candidates

Run `candidates.mts` from the repository, with the wip branch checked out. It prints one block per candidate: the branch, its own change as a `<start>..<replay>` range, the path of the saved diff, and the diff's stat. A chain's members follow each other in the order they would be extracted as one stack, and each member's range starts at the replay commit of the member below it. `candidates.json` also gives what each member needs.

It prints a line marked `!` for a chain that conflicts when moved down, which is not a candidate, and a line marked `✗` for each branch that cannot leave. Carry both into the report as they are. Say in one line how many candidates there are, then go on without waiting.

**Name every branch by its name in anything the user reads.** The replay commits carry the placeholder message `stack-plan preview`, and they change on every run, because each takes the time it was made. So take every sha from the latest `candidates.json`, never from an earlier run.

## 2. Read each candidate for what it uses

The replay applied cleanly, but the change can still use something only a branch below it adds. For each candidate, read its saved diff, and list what the added lines use from outside the change:

- imports and the paths they name
- functions, types, constants and components
- config keys, environment variables, script names and CLI flags
- migrations, schema fields and fixtures

For each one, check that it exists at the replay sha: `git cat-file -e <sha>:<path>` for a file, and `git grep -n <name> <sha>` for a name. **Something missing at the replay sha that exists on the wip branch is a dependency the text did not show.** Find where it comes from with `git log --format='%h %s' -S<name> origin/main..<wip>`, then name its branch as the lowest stack branch that `git branch --contains <commit>` lists.

## 3. Check that each candidate builds

1. Work out the checks from the repository's CI definitions and `package.json` scripts. Keep typecheck and build. Add lint where it is quick. Leave tests out unless the user asked for them, and list them under "Not covered".
2. Read the repository's testing guide, such as `agent-project/testing-ops.md`, for failures it says happen in a worktree. Report those as known, never as red.
3. Run `worktree.mts open`, then `checks.mts` with the npm script names, then `worktree.mts close`. Run `close` also when you stop early.

**Report each result as it lands, because a run can take an hour and shows the user nothing until it ends.** Start `checks.mts` with `run_in_background`, its output sent to `.agent-context/.tmp/stack-extract-results/checks-progress.txt` with `> <file> 2>&1`. Then watch that file with the Monitor tool, `tail -n +1 -F <file>` and `timeout_ms` at its 30-minute cap. For each line that arrives, tell the user in one sentence which commit and script finished, its verdict, and how many commits are left. When the monitor expires before the run ends, re-arm it with `tail -n 0 -F <file>`, so lines already reported do not come again. Never re-arm by starting `checks.mts` again. Once the background run's completion notice arrives, stop the monitor with TaskStop.

`checks.mts` prints one line per commit and script, saves it to `checks/summary.txt`, and saves each script's output beside it. It compares error lines, leaving out line and column, and each line carries one verdict:

| Verdict | Means |
| --- | --- |
| `pass` | The script exits 0 |
| `absent` | The script does not exist at that commit, so the check starts on a later branch. Not red |
| `inherited` | Every error line also appears at the base or at the chain member below. Not this candidate's |
| `setup gap` | Every new error is in a file that imports a path git ignores or a package missing from the linked `node_modules`. A fresh worktree lacks those, so list it under "Not covered", never as red |
| `fails` | An error of its own, and the line names the first one |

**Read the output behind every `fails` before reporting it.** The comparison only sees lines containing the word "error", so a tool that reports its errors otherwise shows as `fails` with `no error line found`. A lockfile warning closes the summary, naming the commits it applies to.

## The report

- **Header:** which candidates can leave as far as both the text and the build show, and which only look independent.
- **Body:** one numbered item per stand-alone branch and per chain. A clean one gets one line. One that fails names the check and the first error line, and the dependency from step 2 that explains it, with the branch it comes from.
- **The renames** for the clean candidates, in the order `extractable` printed them, ready to paste. Say that a chain keeps its order in the `__` block.
- **Not covered:** skipped checks, setup gaps, known worktree failures, lockfile warnings, and anything step 2 could not settle.
