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

const applied = (repo: Repo, ...flags: string[]) => {
  const run = repo.stackPlan('extract', '--apply', '-b', 'main', ...flags);
  assert.equal(run.status, 0, output(run));
  return run;
};

/** `__lower` adds a file and `__upper` edits it, so upper's commit cannot replay on main without lower's. */
const chainedStack = (t: TestContext) => {
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
  return repo;
};

const standaloneStack = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: '__a', subject: 'add a', files: { 'a.txt': 'a\n' } },
  ]);
  return repo;
};

test('extract without --apply names the command to run and creates no copy', (t) => {
  const repo = standaloneStack(t);

  const check = repo.stackPlan('extract', '-b', 'main');

  assert.equal(check.status, 0, output(check));
  assert.match(output(check), /__a → a {2}new on main/);
  assert.match(output(check), /To do it: stack-plan extract --apply/);
  assert.throws(() => repo.git('rev-parse', '--verify', 'refs/heads/a'));
});

test("extract --apply makes a standalone branch's copy on main from the source's own commits", (t) => {
  const repo = standaloneStack(t);

  applied(repo);

  assert.equal(parentOf(repo, 'a'), tip(repo, 'main'));
  assert.equal(repo.git('show', 'a:a.txt'), 'a\n');
  assert.equal(repo.git('log', '--format=%s', 'main..a').trim(), 'add a');
});

test('extract puts a branch that conflicts on main on the copy of the __ branch it needs, so each copy holds what it needs', (t) => {
  const repo = chainedStack(t);

  applied(repo);

  assert.equal(parentOf(repo, 'upper'), tip(repo, 'lower'));
  assert.equal(parentOf(repo, 'lower'), tip(repo, 'main'));
});

test('extract stacks a branch on the copy of a branch it is declared to need, even without a conflict', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    {
      branch: '__lower',
      subject: 'add lower',
      files: { 'lower.txt': 'lower\n' },
    },
    {
      branch: '__upper',
      subject: 'add upper',
      files: { 'upper.txt': 'upper\n' },
    },
  ]);
  const needs = repo.stackPlan('needs', '__upper', '__lower', '-b', 'main');
  assert.equal(needs.status, 0, output(needs));

  applied(repo);

  assert.equal(parentOf(repo, 'upper'), tip(repo, 'lower'));
});

test("extract moves a copy forward with the source's new commits, so its PR needs no force push", (t) => {
  const repo = standaloneStack(t);
  applied(repo);
  const oldTip = tip(repo, 'a');
  addToLayer(repo, '__a', [], 'more a', { 'a.txt': 'a\nmore\n' });

  const run = applied(repo);

  assert.match(output(run), /__a → a {2}\+1 commit/);
  assert.equal(parentOf(repo, 'a'), oldTip);
  assert.doesNotMatch(output(run), /force/);
});

test('extract reports an existing copy with no new source commits as up to date and leaves it alone', (t) => {
  const repo = standaloneStack(t);
  applied(repo);
  const oldTip = tip(repo, 'a');

  const run = applied(repo);

  assert.match(output(run), /__a → a {2}up to date/);
  assert.equal(tip(repo, 'a'), oldTip);
});

test('extract refuses a copy holding a commit the source lacks, names --from-copy, and moves nothing', (t) => {
  const repo = standaloneStack(t);
  applied(repo);
  repo.git('checkout', '-q', 'a');
  repo.commit('address review', { 'review.txt': 'fix\n' });
  repo.git('checkout', '-q', 'wip');
  addToLayer(repo, '__a', [], 'more a', { 'a.txt': 'a\nmore\n' });
  const copyTip = tip(repo, 'a');

  const run = repo.stackPlan('extract', '--apply', '-b', 'main');

  assert.equal(run.status, 1, output(run));
  assert.match(
    output(run),
    /__a → a {2}has 1 commit neither __a nor main holds/,
  );
  assert.match(output(run), /stack-plan extract --from-copy __a/);
  assert.equal(tip(repo, 'a'), copyTip);
});

test('extract rebuilds a copy on its lower copy once that lower copy has moved forward', (t) => {
  const repo = chainedStack(t);
  applied(repo);
  addToLayer(repo, '__lower', ['__upper'], 'more lower', {
    'lower.txt': 'more\n',
  });

  const run = applied(repo);

  assert.match(output(run), /__upper → upper {2}rebuilt on lower/);
  assert.equal(parentOf(repo, 'upper'), tip(repo, 'lower'));
  assert.equal(repo.git('show', 'upper:lower.txt'), 'more\n');
});

test('extract makes a deleted lower copy anew and rebuilds the copy that sat on it', (t) => {
  const repo = chainedStack(t);
  applied(repo);
  repo.git('branch', '-D', 'lower');

  applied(repo);

  assert.equal(parentOf(repo, 'lower'), tip(repo, 'main'));
  assert.equal(parentOf(repo, 'upper'), tip(repo, 'lower'));
});

test('extract tells a landed source to be cut rather than extracting it again', (t) => {
  const repo = standaloneStack(t);
  applied(repo);
  landOnMain(repo, 'add a (#1)', { 'a.txt': 'a\n' });

  const run = applied(repo);

  assert.match(
    output(run),
    /__a → a {2}already in main; to drop it from the stack: stack-plan cut __a/,
  );
});

test('extract refuses a __ branch whose unprefixed name is a stack branch above it', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: '__x', subject: 'add x', files: { 'x.txt': 'x\n' } },
    { branch: 'x', subject: 'add y', files: { 'y.txt': 'y\n' } },
  ]);

  const run = repo.stackPlan('extract', '-b', 'main');

  assert.equal(run.status, 1, output(run));
  assert.match(output(run), /x is a stack branch too; rename one of them/);
});

test("extract treats a copy kept at its source's tip as a copy after the source gains commits, as mark leaves a PR branch", (t) => {
  const repo = standaloneStack(t);
  repo.git('branch', 'a', '__a');
  const copyTip = tip(repo, 'a');
  addToLayer(repo, '__a', [], 'more a', { 'a.txt': 'a\nmore\n' });

  const run = applied(repo);

  assert.match(output(run), /__a → a {2}\+1 commit/);
  assert.equal(parentOf(repo, 'a'), copyTip);
});

test('extract puts a missing copy with an open PR back at its source tip, so the PR keeps its commits, and tracks its origin branch', (t) => {
  const repo = standaloneStack(t);
  repo.addOrigin();
  applied(repo);
  repo.git('push', '-q', 'origin', 'a');
  repo.git('fetch', '-q', 'origin');
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
  repo.git('branch', '-D', 'a');

  const run = applied(repo);

  assert.match(
    output(run),
    /__a → a {2}new at __a's tip, so PR #7 keeps its commits/,
  );
  assert.equal(tip(repo, 'a'), tip(repo, '__a'));
  assert.equal(
    repo.git('rev-parse', '--abbrev-ref', 'a@{upstream}').trim(),
    'origin/a',
  );
});

test('extract --from-copy takes a review fix from the copy into its source and keeps it in wip', (t) => {
  const repo = standaloneStack(t);
  applied(repo);
  repo.git('checkout', '-q', 'a');
  repo.commit('address review', { 'review.txt': 'fix\n' });
  repo.git('checkout', '-q', 'wip');

  const run = repo.stackPlan(
    'extract',
    '--from-copy',
    '__a',
    '--apply',
    '-b',
    'main',
  );

  assert.equal(run.status, 0, output(run));
  assert.equal(
    repo.git('log', '--format=%s', 'main..__a').trim(),
    'address review\nadd a',
  );
  assert.equal(repo.git('show', 'wip:review.txt'), 'fix\n');
  assert.equal(repo.git('log', '-1', '--format=%s', 'wip').trim(), 'wip notes');
});

test("extract --from-copy puts the copy's version of a commit in place of the source's when their subjects pair", (t) => {
  const repo = standaloneStack(t);
  applied(repo);
  repo.git('checkout', '-q', '--detach', 'a^');
  repo.commit('add a', { 'a.txt': 'copy version\n' });
  repo.git('branch', '-f', 'a', 'HEAD');
  repo.git('checkout', '-q', 'wip');

  const run = repo.stackPlan(
    'extract',
    '--from-copy',
    '__a',
    '--apply',
    '-b',
    'main',
  );

  assert.equal(run.status, 0, output(run));
  assert.equal(repo.git('log', '--format=%s', 'main..__a').trim(), 'add a');
  assert.equal(repo.git('show', '__a:a.txt'), 'copy version\n');
  assert.equal(repo.git('show', 'wip:a.txt'), 'copy version\n');
});

test('extract --rebase rebuilds a copy left on an older main onto its current tip', (t) => {
  const repo = standaloneStack(t);
  applied(repo);
  landOnMain(repo, 'unrelated', { 'other.txt': 'other\n' });

  const plain = applied(repo);
  assert.match(output(plain), /__a → a {2}up to date/);
  const rebased = applied(repo, '--rebase');

  assert.match(output(rebased), /__a → a {2}rebuilt/);
  assert.equal(parentOf(repo, 'a'), tip(repo, 'main'));
});
