import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import {
  addToLayer,
  buildStack,
  editPlan,
  makeRepo,
  pickAbove,
  planPath,
  type Repo,
  type Run,
} from './stack-plan.fixture.mts';

const output = (run: Run) => `${run.stdout}\n${run.stderr}`;
const tip = (repo: Repo, ref: string) => repo.git('rev-parse', ref).trim();
const exists = (repo: Repo, branch: string) => {
  try {
    repo.git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};
const upstreamOf = (repo: Repo, branch: string) => {
  try {
    return repo.git('rev-parse', '--abbrev-ref', `${branch}@{upstream}`).trim();
  } catch {
    return '';
  }
};
const noteOn = (repo: Repo, sha: string) => {
  try {
    return repo.git('notes', '--ref=refs/notes/target', 'show', sha).trim();
  } catch {
    return '';
  }
};
const savedOrder = (repo: Repo) =>
  repo.git('config', '--get', 'stackplan.order').trim();

const run = (repo: Repo, ...args: string[]) => {
  const result = repo.stackPlan(...args, '-b', 'main');
  assert.equal(result.status, 0, output(result));
  return result;
};

const refused = (repo: Repo, args: string[], problem: RegExp) => {
  const result = repo.stackPlan(...args, '-b', 'main');
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), problem);
};

/** Three branches that each add a file of their own, so any of them can leave the stack. */
const threeBranches = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'add two', files: { 'two.txt': 'two\n' } },
    { branch: 'p3', subject: 'add three', files: { 'three.txt': 'three\n' } },
  ]);
  return repo;
};

/** `__a` and `__b` stand alone and have their copies on main, with `p1` above them. */
const extractedPair = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: '__a', subject: 'add a', files: { 'a.txt': 'a\n' } },
    { branch: '__b', subject: 'add b', files: { 'b.txt': 'b\n' } },
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
  ]);
  repo.addOrigin();
  run(repo, 'extract', '--apply');
  return repo;
};

/** `p1` has open PR #7, tracking origin/p1, with `p2` above it. */
const pullRequestAtBottom = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'add two', files: { 'two.txt': 'two\n' } },
  ]);
  repo.addOrigin();
  repo.git('push', '-q', '-u', 'origin', 'p1');
  repo.setPullRequests('open', [
    {
      number: 7,
      headRefName: 'p1',
      headRefOid: tip(repo, 'p1'),
      baseRefName: 'main',
      mergedAt: '',
      mergeCommit: null,
    },
  ]);
  return repo;
};

test('mark renames a branch to its __ name, saves it at the bottom of the stack and exports the plan with it', (t) => {
  const repo = threeBranches(t);
  const twoTip = tip(repo, 'p2');

  run(repo, 'mark', 'p2');

  assert.equal(tip(repo, '__p2'), twoTip);
  assert.ok(!exists(repo, 'p2'));
  assert.equal(savedOrder(repo), '__p2 p1 p3');
  const plan = readFileSync(planPath(repo), 'utf8');
  assert.ok(
    plan.indexOf('update-ref refs/heads/__p2') <
      plan.indexOf('update-ref refs/heads/p1'),
    plan,
  );
});

test('mark puts the marked branch directly above the __ block already there', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: '__a', subject: 'add a', files: { 'a.txt': 'a\n' } },
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'add two', files: { 'two.txt': 'two\n' } },
  ]);

  run(repo, 'mark', 'p2');

  assert.equal(savedOrder(repo), '__a __p2 p1');
});

test('mark rewrites the note of a waiting commit placed in the branch to name its __ name', (t) => {
  const repo = threeBranches(t);
  const waiting = repo.commit('more two', { 'two.txt': 'two\nmore\n' });
  editPlan(repo, pickAbove(waiting, 'p2'));
  run(repo, 'save');

  run(repo, 'mark', 'p2');

  assert.equal(noteOn(repo, waiting), '__p2');
});

test('mark -n prints the rename and the move and changes nothing', (t) => {
  const repo = threeBranches(t);

  const result = run(repo, 'mark', '-n', 'p2');

  assert.match(output(result), /p2 → __p2/);
  assert.match(output(result), /To do it: stack-plan mark p2/);
  assert.ok(exists(repo, 'p2'));
  assert.ok(!exists(repo, '__p2'));
});

test('mark refuses a branch that is not in the stack', (t) => {
  const repo = threeBranches(t);
  refused(repo, ['mark', 'nope'], /nope is not a stack branch/);
});

test('mark refuses a branch that already has the prefix', (t) => {
  const repo = threeBranches(t);
  run(repo, 'mark', 'p2');
  refused(repo, ['mark', '__p2'], /__p2 is an extract source already/);
});

test('mark refuses a branch whose __ name is taken', (t) => {
  const repo = threeBranches(t);
  repo.git('branch', '__p2', 'main');
  refused(repo, ['mark', 'p2'], /__p2 exists already/);
});

test('mark keeps a PR branch at its tip as the copy, with its upstream, so the PR goes on without a push', (t) => {
  const repo = pullRequestAtBottom(t);
  const oneTip = tip(repo, 'p1');

  const result = run(repo, 'mark', 'p1');

  assert.match(
    output(result),
    /stays at \w+ as the copy, so PR #7 goes on unchanged/,
  );
  assert.equal(tip(repo, 'p1'), oneTip);
  assert.equal(tip(repo, '__p1'), oneTip);
  assert.equal(upstreamOf(repo, 'p1'), 'origin/p1');
  assert.equal(upstreamOf(repo, '__p1'), '');
  assert.equal(savedOrder(repo), '__p1 p2');
  assert.match(output(run(repo, 'extract')), /__p1 → p1 {2}up to date/);
});

test('mark refuses a PR branch sitting on a branch without a PR that is not marked with it, because its copy would lose its base', (t) => {
  const repo = threeBranches(t);
  repo.addOrigin();
  repo.setPullRequests('open', [
    {
      number: 8,
      headRefName: 'p2',
      headRefOid: tip(repo, 'p2'),
      baseRefName: 'p1',
      mergedAt: '',
      mergeCommit: null,
    },
  ]);
  refused(
    repo,
    ['mark', 'p2'],
    /p2 has PR #8 and sits on a branch whose copy would not be its base/,
  );
});

test('unmark deletes a copy holding the same commits, renames the branch back and saves it directly above the __ block', (t) => {
  const repo = extractedPair(t);
  const sourceTip = tip(repo, '__a');

  const result = run(repo, 'unmark', '__a');

  assert.match(
    output(result),
    /a {2}deleted, it holds the same commits as its source/,
  );
  assert.equal(tip(repo, 'a'), sourceTip);
  assert.ok(!exists(repo, '__a'));
  assert.equal(savedOrder(repo), '__b a p1');
});

test('unmark -n shows the deletion and the rename and changes nothing', (t) => {
  const repo = extractedPair(t);
  const copyTip = tip(repo, 'a');

  const result = run(repo, 'unmark', '-n', '__a');

  assert.match(output(result), /a {2}would be deleted/);
  assert.match(output(result), /__a → a/);
  assert.equal(tip(repo, 'a'), copyTip);
  assert.ok(exists(repo, '__a'));
});

test('unmark refuses a branch without the prefix', (t) => {
  const repo = extractedPair(t);
  refused(repo, ['unmark', 'p1'], /p1 is not an extract source/);
});

test('unmark refuses a copy holding a commit its source lacks, and names -f', (t) => {
  const repo = extractedPair(t);
  repo.git('checkout', '-q', 'a');
  repo.commit('review fix', { 'a.txt': 'a, fixed\n' });
  repo.git('checkout', '-q', 'wip');

  refused(
    repo,
    ['unmark', '__a'],
    /a does not hold the same commits as __a: 0 commits missing from it, 1 commit only on it; to delete it anyway: -f/,
  );
  assert.ok(exists(repo, '__a'));
});

test('unmark -f deletes a copy whose commits differ and prints the git branch that restores it', (t) => {
  const repo = extractedPair(t);
  repo.git('checkout', '-q', 'a');
  const fix = repo.commit('review fix', { 'a.txt': 'a, fixed\n' });
  repo.git('checkout', '-q', 'wip');

  const result = run(repo, 'unmark', '-f', '__a');

  assert.match(
    output(result),
    new RegExp(`to restore it: git branch a ${fix}`),
  );
  assert.ok(!exists(repo, '__a'));
});

test("unmark refuses a copy that another __ branch's copy sits on, unless that branch is unmarked too", (t) => {
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
  repo.addOrigin();
  run(repo, 'extract', '--apply');

  refused(
    repo,
    ['unmark', '__lower'],
    /upper sits on lower; unmark __upper too/,
  );
  run(repo, 'unmark', '__lower', '__upper');

  assert.ok(!exists(repo, '__lower'));
  assert.ok(!exists(repo, '__upper'));
});

test('unmark hands a PR back to the renamed branch when its copy sits at the source tip, as mark left it', (t) => {
  const repo = pullRequestAtBottom(t);
  run(repo, 'mark', 'p1');

  const result = run(repo, 'unmark', '__p1');

  assert.match(output(result), /PR #7 goes on with __p1 renamed back/);
  assert.ok(!exists(repo, '__p1'));
  assert.equal(upstreamOf(repo, 'p1'), 'origin/p1');
  assert.equal(savedOrder(repo), 'p1 p2');
});

test('unmark refuses a copy with an open PR once its source has moved past it', (t) => {
  const repo = extractedPair(t);
  repo.setPullRequests('open', [
    {
      number: 7,
      headRefName: 'a',
      headRefOid: tip(repo, 'a'),
      baseRefName: 'main',
      mergedAt: '',
      mergeCommit: null,
    },
  ]);
  addToLayer(repo, '__a', ['__b', 'p1'], 'more a', { 'a.txt': 'a\nmore\n' });

  refused(
    repo,
    ['unmark', '__a'],
    /a has PR #7 and is not at __a's tip; close the PR first/,
  );
});
