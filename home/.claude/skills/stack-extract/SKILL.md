---
name: stack-extract
description: Find the ready stack branches that could leave the stack as pull requests of their own, check that each still builds without the branches below it, then mark them as __ branches and extract them on the user's word. Typed only, because typing it approves the worktree operations, checks, renames and extract its scripts perform.
argument-hint: <last-ready-branch> | mark | extract
disable-model-invocation: true
---

# Stack extract

Find out which branches in the stack can become `__` branches, the extract sources that `stack-plan extract` copies onto the base as pull requests of their own. `stack-plan extractable` answers that for the text: whether each branch's commits apply without the branches below it. This skill adds what the text cannot show: whether the code still builds there, and what the change uses from other branches. `/repos/MyConfig/docs/stack-plan.md` → "8. Extract branches that need not be stacked" describes the commands.

## The three modes

| Invocation | Does |
| --- | --- |
| `/stack-extract <last-ready-branch>` | Steps 1 to 3 and the report. Changes nothing in the stack |
| `/stack-extract mark`, or the user's word after the report | Step 4: renames the branches the report listed to their `__` names and exports the plan with them in place |
| `/stack-extract extract` | Step 5: creates or moves forward the extracted copies |

**Every branch up to and including `<last-ready-branch>` is ready for extraction, and nothing above it is.** The user runs this command only when that holds, so never ask about a single branch's readiness, and never offer a branch above the cut. Where the argument is missing, ask for it.

**Never mark in the report's own turn.** The user reads the report first and decides. Between step 4 and step 5 the user runs `stack-plan preview`, `apply` and `verify` themselves where the `__` block has to move, and they create the pull requests themselves from `branchcommands.md`.

## What typing this command approves

**The user typing `/stack-extract` approves what this skill's scripts and the mode's `stack-plan` command do, and nothing else**: adding, cleaning, moving and removing one scratch worktree, linking the main checkout's `node_modules` into it, saving results under `.agent-context/.tmp/stack-extract-results/`, running the repository's own npm scripts inside that worktree, `stack-plan needs` as step 2 gives it, and, in the modes that name them, `stack-plan mark`, `stack-plan preview -n` and `stack-plan extract --apply`. `generate-branchcommands.sh` is the user's to run, never yours. Run `stack-plan` as `node /home/torgst/scripts/stack-plan.mts <command>`. Never push, and never create a pull request.

- Run each script as `node <this skill's base directory>/scripts/<script> <arguments>`, with the absolute path printed when this skill loaded.
- **Never install dependencies.** Where a lockfile differs from the main checkout's, results for that package may not match the commit: say so in the report, and do not install.
- Run checks only inside the worktree, never in the main checkout.

| Script | Does |
| --- | --- |
| `candidates.mts <last-ready-branch>` | Runs `stack-plan extractable --json`, cuts each chain at the first branch above the last ready one, saves the result as `candidates.json`, and saves each candidate's own change as `<branch>.diff`, with `/` turned into `-` |
| `worktree.mts open` | Adds the worktree at `.agent-context/.tmp/stack-extract` and links every `node_modules` |
| `worktree.mts goto <ref>` | Discards what the last checks left, sparing the `node_modules` links, and checks out the ref detached |
| `worktree.mts close` | Removes the links, then the worktree |
| `checks.mts <script>... [--changed <script>...]` | Runs each npm script at the base, then at each candidate's replay commit, chains bottom first, and sorts each result. Scripts after `--changed` get the candidate's changed files |

## 1. Find the candidates

Run `candidates.mts <last-ready-branch>` from the repository, with the wip branch checked out. It prints one block per candidate: the branch, its own change as a `<start>..<replay>` range, the path of the saved diff, and the diff's stat. A chain's members follow each other in the order they would be extracted as one stack, and each member's range starts at the replay commit of the member below it. `candidates.json` also gives what each member needs, and under `declared` which of those `stack-plan needs` recorded. A chain may open with `__` branches, each printed as a `---` line and flagged `marked` in `candidates.json`. They are not candidates: the last of them is the base the chain's first candidate stacks on.

It prints a line marked `!` for a chain that conflicts when moved down, which is not a candidate, and a line marked `✗` for each branch that cannot leave. Carry both into the report as they are. A last `not ready` line names the branches above the cut, which the report leaves out. Say in one line how many candidates there are, then go on without waiting.

**Name every branch by its name in anything the user reads.** The replay commits carry the placeholder message `stack-plan preview`, and they change on every run, because each takes the time it was made. So take every sha from the latest `candidates.json`, never from an earlier run.

## 2. Read each candidate for what it uses

The replay applied cleanly, but the change can still use something only a branch below it adds. For each candidate, read its saved diff, and list what the added lines use from outside the change:

- imports and the paths they name
- functions, types, constants and components
- config keys, environment variables, script names and CLI flags
- migrations, schema fields and fixtures
- relative links and the headings their anchors name, and log lines, guards or commands a document says exist

For each one, check that it exists at the replay sha: `git cat-file -e <sha>:<path>` for a file, and `git grep -n <name> <sha>` for a name. **Something missing at the replay sha that exists on the wip branch is a dependency the text did not show.** Find where it comes from with `git log --format='%h %s' -S<name> origin/main..<wip>`, then find which candidate's saved diff adds it. `git branch --contains <commit>` also lists every branch stacked above that one, so it does not settle the branch alone.

Sort each dependency by where it points, because that decides what the report does with it:

| Points at | Report it as |
| --- | --- |
| A member below it in its own chain | Nothing. The chain carries it |
| A member above it in its own chain | A finding that heals once the chain merges. It holds nothing back |
| A branch above the cut | A finding. The document is ahead of the code until that branch merges, and it holds nothing back |
| A member of another chain, below it in the stack | **The candidate joins that chain.** Run `stack-plan needs <candidate> <member>`, then run step 1 again, so the chains, ranges and checks all come from the joined chain. Each change stays the same text, so this step's findings still hold |
| A `__` branch | **The candidate stacks on it.** Run `stack-plan needs <candidate> <__branch>`, then run step 1 again. The chain then opens with the whole `__` chain that branch sits in, and the candidate's pull request goes on the extracted copy of that chain's top member |
| A branch with a PR | **Hold the candidate back.** It can leave once that pull request has merged |
| A member of another chain, above it in the stack | **Hold the candidate back**, with every member above it in its chain. A pull request has one base, and the needed branch would have to sit below it. It can leave once the other chain has merged |

## 3. Check that each candidate builds

1. Work out the checks from the repository's CI definitions and `package.json` scripts. Keep typecheck and lint. Leave tests out unless the user asked for them, and list them under "Not covered".
   - **Lint only the files each candidate changes, through an npm script that takes paths.** A lint of the whole tree at every commit can use up the machine's memory. For ESLint 9 the script needs `--no-warn-ignored` beside `--max-warnings 0`, because it warns about every ignored path it is given, such as a Markdown file. **Where the repository has no such script, stop and ask the user before running any check.** They may want to add one.
   - **Leave out every check that writes into `node_modules`, and list it under "Not covered".** The worktree's `node_modules` are links to the main checkout's installs, so such a check overwrites them, or fails with `EACCES`. Backstage's build is one: `backstage-cli repo build` writes generated files into `packages/app/node_modules`.
2. Read the repository's testing guide, such as `agent-project/testing-ops.md`, for failures it says happen in a worktree. Report those as known, never as red.
3. Run `worktree.mts open`, then `checks.mts` with the npm script names, then `worktree.mts close`. Run `close` also when you stop early. Name the scripts that take paths after `--changed`, as in `checks.mts tsc format:check --changed lint:changed`. `checks.mts` gives each of them the files the candidate's own change adds or modifies, and skips them at the base.

**Report each result as it lands, because a run can take an hour and shows the user nothing until it ends.** Start `checks.mts` with `run_in_background`, its output sent to `.agent-context/.tmp/stack-extract-results/checks-progress.txt` with `> <file> 2>&1`. Then watch that file with the Monitor tool, `tail -n +1 -F <file>` and `timeout_ms` at its 30-minute cap. For each line that arrives, tell the user in one sentence which branch and script finished, its verdict, and progress as branches done out of the candidate count, such as "branch 5 of 17". Leave out the `baseline` lines from the count, and report them as the base's result. Leave out the `(marked)` lines too. They check a `__` branch only so that its errors count as inherited for the candidate above it. When the monitor expires before the run ends, re-arm it with `tail -n 0 -F <file>`, so lines already reported do not come again. Never re-arm by starting `checks.mts` again. Once the background run's completion notice arrives, stop the monitor with TaskStop.

`checks.mts` prints one line per commit and script, saves it to `checks/summary.txt`, and saves each script's output beside it. It compares error lines, leaving out line and column, and each line carries one verdict:

| Verdict | Means |
| --- | --- |
| `pass` | The script exits 0 |
| `skipped` | A script after `--changed` at the base, or at a candidate that only deletes files |
| `absent` | The script does not exist at that commit, so the check starts on a later branch. Not red |
| `inherited` | Every error line also appears at the base or at the chain member below. Not this candidate's |
| `setup gap` | Every new error is in a file that imports a path git ignores or a package missing from the linked `node_modules`. A fresh worktree lacks those, so list it under "Not covered", never as red |
| `fails` | An error of its own, and the line names the first one |

**Read the output behind every `fails` before reporting it.** The comparison only sees lines containing the word "error", so a tool that reports its errors otherwise shows as `fails` with `no error line found`. An ESLint run whose only problems are "File ignored" warnings is clean: the base's lint script may lack `--no-warn-ignored` where a candidate adds it. A lockfile warning closes the summary, naming the commits it applies to.

## The report

The report answers three questions, in this order, in its header:

1. **Which chains can be posted now**, each as its members in order. A stand-alone branch is a chain of one. A chain that opens with `__` branches is posted on the extracted copy of the last of them, so name that copy as its base. A chain whose build fails or that step 2 holds back is not among them.
2. **Which candidates wait, and for what**: each one held back for depending on a chain above it, with the chain it waits for, and each red build with its first error line.
3. **What happens next**: the `stack-plan mark` line below, and that the user's word or `/stack-extract mark` runs it.

- **Body:** one numbered item per chain, giving each step 2 finding with the branch it points at and how the table above sorted it. Name each need `candidates.json` lists under `declared`, with what it rests on, because the text does not show it and the user did not watch it being declared. A clean chain gets one line.
- **The mark line:** `stack-plan mark` followed by every branch of the chains in answer 1, in stack order, leaving out the `__` branches. Step 4 runs exactly this line.
- **Not covered:** skipped checks, setup gaps, known worktree failures, lockfile warnings, and anything step 2 could not settle.

## 4. Mark

Run only on the user's word after the report, or on `/stack-extract mark`. Take the mark line from the latest report in this conversation. Where there is none, say so and ask for `/stack-extract <last-ready-branch>` first.

1. Run `stack-plan mark <branches> -n` and compare its renames with the mark line. Stop where they differ.
2. Run `stack-plan mark <branches>`. It renames each branch to `__<name>`, moves the notes of waiting commits placed in it, rewrites the saved order with the `__` block directly above the PR branches, and exports the plan. The plan the user had is in `stackplan.txt.bak`.
3. Run `stack-plan preview -n`, which writes no notes, to learn whether the `__` block has to move. Where the marked branches already sat at the bottom of the stack in chain order, it ends with `nothing to move`.
4. Reply with the renames and the user's next step. Where nothing moves, that is `/stack-extract extract`, because `apply` and `verify` have nothing to do. Otherwise it is `stack-plan preview`, then `stack-plan apply` and `stack-plan verify`, then `/stack-extract extract`.

## 5. Extract

Run only on `/stack-extract extract`, after the user has applied the plan.

1. Run `stack-plan extract`. Where it reports a finding, stop and report it, with the line it printed. Never pass `-f`.
2. Run `stack-plan extract --apply`.
3. Reply with each extracted copy and its base, and ask the user to run `bash /home/torgst/scripts/generate-branchcommands.sh`. Its `## Extracted chains` section in `.agent-context/active-work-context/branchcommands.md` gives each extracted copy's push and `pr-create` command with the base the chain needs.
4. Once the user says it has run, read that section and check each copy's base against the chains.
