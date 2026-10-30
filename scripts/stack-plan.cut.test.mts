import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  addToLayer,
  buildStack,
  landOnMain,
  makeRepo,
  type Repo,
  type Run,
} from './stack-plan.fixture.mts';

const output = (run: Run) => `${run.stdout}\n${run.stderr}`;
const tip = (repo: Repo, ref: string) => repo.git('rev-parse', ref).trim();
const parentOf = (repo: Repo, ref: string) => tip(repo, `${ref}^`);
const subjects = (repo: Repo, range: string) =>
  repo.git('log', '--format=%s', range).trim();

/** `p1` adds a file and `p2` adds another on top, a stack of branches with PRs. */
const twoBranchStack = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'add two', files: { 'two.txt': 'two\n' } },
  ]);
  return repo;
};

/** `__a` and `__b` add a file each, below `p`, which has a PR. */
const sourcesBelowBranch = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: '__a', subject: 'add a', files: { 'a.txt': 'a\n' } },
    { branch: '__b', subject: 'add b', files: { 'b.txt': 'b\n' } },
    { branch: 'p', subject: 'add p', files: { 'p.txt': 'p\n' } },
  ]);
  return repo;
};

/** Extracts the `__` branches, squash-merges `a` on main, and lists its PR as merged on GitHub. */
const mergedCopy = (repo: Repo) => {
  repo.addOrigin();
  const extract = repo.stackPlan('extract', '--apply', '-b', 'main');
  assert.equal(extract.status, 0, output(extract));
  landOnMain(repo, 'add a (#7)', { 'a.txt': 'a\n' });
  const landed = tip(repo, 'main');
  repo.setPullRequests('merged', [
    {
      number: 7,
      headRefName: 'a',
      headRefOid: tip(repo, 'a'),
      baseRefName: 'main',
      mergedAt: new Date(Date.now() + 60_000).toISOString(),
      mergeCommit: { oid: landed },
    },
  ]);
};

test('cut without --apply reports a landed bottom branch as contained, names the command and moves nothing', (t) => {
  const repo = twoBranchStack(t);
  landOnMain(repo, 'add one (#1)', { 'one.txt': 'one\n' });
  const wipTip = tip(repo, 'wip');

  const check = repo.stackPlan('cut', 'p1', '-b', 'main');

  assert.equal(check.status, 0, output(check));
  assert.match(output(check), /p1 {2}contained in main/);
  assert.match(
    output(check),
    /cutting at p1 and rebasing onto main loses no work/,
  );
  assert.match(output(check), /To do it: stack-plan cut p1 --apply/);
  assert.equal(tip(repo, 'wip'), wipTip);
});

test('cut reports a branch whose change main lacks as lost, with its files, and fails', (t) => {
  const repo = twoBranchStack(t);

  const check = repo.stackPlan('cut', 'p1', '-b', 'main');

  assert.equal(check.status, 1, output(check));
  assert.match(
    output(check),
    /p1 {2}would be lost: main lacks its changes to\n\s+one\.txt/,
  );
  assert.match(output(check), /cutting at p1 would lose work/);
});

test("cut can't tell whether a branch landed when main changed its lines again after the squash merge, and asks for a look by hand", (t) => {
  const repo = twoBranchStack(t);
  landOnMain(repo, 'add one (#1)', { 'one.txt': 'one\n' });
  landOnMain(repo, 'reword one', { 'one.txt': 'one, reworded\n' });

  const check = repo.stackPlan('cut', 'p1', '-b', 'main');

  assert.equal(check.status, 1, output(check));
  assert.match(
    output(check),
    /p1 {2}can't tell: main changed these again since/,
  );
  assert.match(output(check), /needs a look by hand/);
});

test('cut flags a commit above the cut that conflicts with main once replayed there', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'edit readme', files: { 'README.md': 'p2\n' } },
  ]);
  landOnMain(repo, 'add one (#1)', { 'one.txt': 'one\n' });
  landOnMain(repo, 'edit readme on main', { 'README.md': 'main\n' });

  const check = repo.stackPlan('cut', 'p1', '-b', 'main');

  assert.equal(check.status, 1, output(check));
  assert.match(output(check), /p1 {2}contained in main/);
  assert.match(output(check), /needs a look by hand/);
});

test('cut --apply moves the rest of the stack onto main, keeps the cut branch at its old tip and prints its delete', (t) => {
  const repo = twoBranchStack(t);
  landOnMain(repo, 'add one (#1)', { 'one.txt': 'one\n' });
  const cutTip = tip(repo, 'p1');

  const run = repo.stackPlan('cut', 'p1', '--apply', '-b', 'main');

  assert.equal(run.status, 0, output(run));
  assert.equal(parentOf(repo, 'p2'), tip(repo, 'main'));
  assert.equal(subjects(repo, 'main..wip'), 'wip notes\nadd two');
  assert.equal(tip(repo, 'p1'), cutTip);
  assert.match(output(run), /git branch -D p1/);
});

test('cut --apply rewrites nothing when the check finds lost work, and names -f', (t) => {
  const repo = twoBranchStack(t);
  const wipTip = tip(repo, 'wip');

  const run = repo.stackPlan('cut', 'p1', '--apply', '-b', 'main');

  assert.equal(run.status, 1, output(run));
  assert.match(
    output(run),
    /Nothing rewritten\. To cut anyway: stack-plan cut p1 --apply -f/,
  );
  assert.equal(tip(repo, 'wip'), wipTip);
});

test('cut --apply -f cuts despite lost work', (t) => {
  const repo = twoBranchStack(t);

  const run = repo.stackPlan('cut', 'p1', '--apply', '-f', '-b', 'main');

  assert.equal(subjects(repo, 'main..wip'), 'wip notes\nadd two', output(run));
  assert.equal(parentOf(repo, 'p2'), tip(repo, 'main'));
});

test('cut of a __ branch drops only its commits, wherever it sits, and moves the branches around it onto main', (t) => {
  const repo = sourcesBelowBranch(t);
  landOnMain(repo, 'add b (#1)', { 'b.txt': 'b\n' });
  const sourceTip = tip(repo, '__b');

  const run = repo.stackPlan('cut', '__b', '--apply', '-b', 'main');

  assert.equal(run.status, 0, output(run));
  assert.equal(subjects(repo, 'main..wip'), 'wip notes\nadd p\nadd a');
  assert.equal(parentOf(repo, '__a'), tip(repo, 'main'));
  assert.equal(tip(repo, '__b'), sourceTip);
});

test('cut of a __ branch refuses when a branch with a PR sits below it, because moving that branch would rewrite its PR', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p', subject: 'add p', files: { 'p.txt': 'p\n' } },
    { branch: '__b', subject: 'add b', files: { 'b.txt': 'b\n' } },
  ]);
  landOnMain(repo, 'add b (#1)', { 'b.txt': 'b\n' });
  const wipTip = tip(repo, 'wip');

  const run = repo.stackPlan('cut', '__b', '--apply', '-b', 'main');

  assert.equal(run.status, 1, output(run));
  assert.match(
    output(run),
    /p {2}sits below, and moving it onto main would rewrite it; cut it first/,
  );
  assert.equal(tip(repo, 'wip'), wipTip);
});

test('cut refuses a branch without the prefix named among __ branches', (t) => {
  const repo = sourcesBelowBranch(t);

  const run = repo.stackPlan('cut', '__a', 'p', '-b', 'main');

  assert.equal(run.status, 2, output(run));
  assert.match(
    output(run),
    /cut takes one branch to cut at, or one or more __ branches/,
  );
});

test("cut takes a copy's merged PR as proof a __ branch landed, where main changed its lines again since", (t) => {
  const repo = sourcesBelowBranch(t);
  mergedCopy(repo);
  landOnMain(repo, 'reword a', { 'a.txt': 'a, reworded\n' });

  const check = repo.stackPlan('cut', '__a', '-b', 'main');

  assert.match(output(check), /__a {2}a merged on GitHub as #7/);
  assert.doesNotMatch(output(check), /__a {2}can't tell/);
});

test("cut lets the content decide when a __ branch gained a commit after its copy's PR merged", (t) => {
  const repo = sourcesBelowBranch(t);
  mergedCopy(repo);
  addToLayer(repo, '__a', ['__b', 'p'], 'more a', { 'more-a.txt': 'more\n' });

  const check = repo.stackPlan('cut', '__a', '-b', 'main');

  assert.equal(check.status, 1, output(check));
  assert.match(output(check), /#7 merged without 1 commit of it/);
  assert.match(
    output(check),
    /__a {2}would be lost: main lacks its changes to\n\s+more-a\.txt/,
  );
});

test('cut --merged picks only the __ branches that have landed', (t) => {
  const repo = sourcesBelowBranch(t);
  landOnMain(repo, 'add a (#1)', { 'a.txt': 'a\n' });

  const check = repo.stackPlan('cut', '--merged', '-b', 'main');

  assert.equal(check.status, 0, output(check));
  assert.match(output(check), /Drop __a, onto main/);
  assert.match(output(check), /To do it: stack-plan cut --merged --apply/);
});

test('cut --merged drops nothing when no __ branch has landed', (t) => {
  const repo = sourcesBelowBranch(t);
  const wipTip = tip(repo, 'wip');

  const run = repo.stackPlan('cut', '--merged', '--apply', '-b', 'main');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /no __ branch has landed; nothing to drop/);
  assert.equal(tip(repo, 'wip'), wipTip);
});

test("cut of a __ branch rebuilds the copy that sat on the cut branch's copy on main, and prints the delete for both", (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    {
      branch: '__lower',
      subject: 'add shared',
      files: { 'shared.txt': 'one\n' },
    },
    {
      branch: '__upper',
      subject: 'edit shared',
      files: { 'shared.txt': 'two\n' },
    },
  ]);
  const extract = repo.stackPlan('extract', '--apply', '-b', 'main');
  assert.equal(extract.status, 0, output(extract));
  landOnMain(repo, 'add shared (#1)', { 'shared.txt': 'one\n' });

  const run = repo.stackPlan('cut', '__lower', '--apply', '-b', 'main');

  assert.equal(run.status, 0, output(run));
  assert.equal(parentOf(repo, 'upper'), tip(repo, 'main'));
  assert.equal(repo.git('show', 'upper:shared.txt'), 'two\n');
  assert.match(output(run), /git branch -D __lower lower/);
});
