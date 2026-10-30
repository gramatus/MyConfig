import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
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

const synced = (repo: Repo, ...flags: string[]) =>
  repo.stackPlan('sync', '-b', 'main', ...flags);

/** `p1` and `p2` add a file each, and both are pushed with main, as PR branches. */
const pushedStack = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'add two', files: { 'two.txt': 'two\n' } },
  ]);
  repo.addOrigin();
  repo.git('push', '-q', '-u', 'origin', 'main', 'p1', 'p2');
  return repo;
};

/** Makes origin's `branch` the commits of `picks` on `onto`, plus `extra`, as GitHub leaves it after a rebase or a pushed fix. */
const setOnOrigin = (
  repo: Repo,
  branch: string,
  onto: string,
  picks: string[],
  extra?: { subject: string; files: Record<string, string> },
) => {
  repo.git('checkout', '-q', '--detach', onto);
  for (const sha of picks) repo.git('cherry-pick', sha);
  if (extra) repo.commit(extra.subject, extra.files);
  repo.git('push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`);
  repo.git('checkout', '-q', 'wip');
};

/** GitHub squash-merges `p1`, deletes its branch and rebases `p2` onto main. */
const mergeBottomOnGitHub = (repo: Repo) => {
  landOnMain(repo, 'add one (#1)', { 'one.txt': 'one\n' });
  repo.git('push', '-q', 'origin', 'main');
  repo.git('push', '-q', 'origin', '--delete', 'p1');
  setOnOrigin(repo, 'p2', 'main', [tip(repo, 'p2')]);
};

test('sync without --apply cuts a branch GitHub merged and takes the rebased copy above it, as safe because only the base changed', (t) => {
  const repo = pushedStack(t);
  mergeBottomOnGitHub(repo);
  const wipTip = tip(repo, 'wip');

  const check = synced(repo);

  assert.equal(check.status, 0, output(check));
  assert.match(output(check), /p1 {2}cut, contained in main/);
  assert.match(
    output(check),
    /p2 {2}origin\/p2 {2}0 new from origin · 1 replaced by origin's copy · 0 kept local/,
  );
  assert.match(output(check), /1 commit only rebased locally; syncing is safe/);
  assert.match(output(check), /To do it: stack-plan sync --apply/);
  assert.equal(tip(repo, 'wip'), wipTip);
});

test('sync --apply puts a branch exactly on its rebased origin copy, replays wip on top and keeps the cut branch', (t) => {
  const repo = pushedStack(t);
  const cutTip = tip(repo, 'p1');
  mergeBottomOnGitHub(repo);

  const run = synced(repo, '--apply');

  assert.equal(run.status, 0, output(run));
  assert.equal(tip(repo, 'p2'), tip(repo, 'origin/p2'));
  assert.equal(parentOf(repo, 'wip'), tip(repo, 'p2'));
  assert.equal(subjects(repo, 'main..wip'), 'wip notes\nadd two');
  assert.equal(tip(repo, 'p1'), cutTip);
});

test('sync --apply brings in a review fix pushed on GitHub, and verify counts it as from origin', (t) => {
  const repo = pushedStack(t);
  setOnOrigin(repo, 'p2', 'p2', [], {
    subject: 'address review',
    files: { 'review.txt': 'fix\n' },
  });

  const run = synced(repo, '--apply');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /p2 {2}origin\/p2 {2}1 new from origin/);
  assert.equal(tip(repo, 'p2'), tip(repo, 'origin/p2'));
  assert.equal(repo.git('show', 'wip:review.txt'), 'fix\n');
  assert.match(output(run), /1 from origin/);
});

test('sync refuses when a review fix pushed to a lower PR branch leaves the PR above it on the old tip, because origin has no one line to sync onto', (t) => {
  const repo = pushedStack(t);
  setOnOrigin(repo, 'p1', 'p1', [], {
    subject: 'address review',
    files: { 'review.txt': 'fix\n' },
  });
  const wipTip = tip(repo, 'wip');

  const run = synced(repo, '--apply');

  assert.equal(run.status, 1, output(run));
  assert.match(
    output(run),
    /origin\/p2 does not sit on origin\/p1; origin's stack is not one line/,
  );
  assert.equal(tip(repo, 'wip'), wipTip);
});

test('sync keeps a local commit origin lacks on top of its branch, listed as kept local', (t) => {
  const repo = pushedStack(t);
  mergeBottomOnGitHub(repo);
  repo.git('checkout', '-q', '--detach', 'p2');
  repo.commit('more two', { 'two.txt': 'two\nmore\n' });
  repo.git('branch', '-f', 'p2', 'HEAD');
  repo.git('cherry-pick', tip(repo, 'wip'));
  repo.git('checkout', '-q', '-B', 'wip');

  const run = synced(repo, '--apply');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /1 replaced by origin's copy · 1 kept local/);
  assert.equal(parentOf(repo, 'p2'), tip(repo, 'origin/p2'));
  assert.equal(subjects(repo, 'origin/p2..p2'), 'more two');
});

test("sync refuses a commit reworded after pushing, because syncing would bring back origin's message", (t) => {
  const repo = pushedStack(t);
  repo.git('checkout', '-q', '--detach', 'p1');
  repo.git('cherry-pick', tip(repo, 'p2'));
  repo.git('commit', '-q', '--amend', '-m', 'add two, reworded');
  repo.git('branch', '-f', 'p2', 'HEAD');
  repo.git('cherry-pick', tip(repo, 'wip'));
  repo.git('checkout', '-q', '-B', 'wip');

  const check = synced(repo);

  assert.equal(check.status, 1, output(check));
  assert.match(
    output(check),
    /1 commit reworded locally; syncing drops that, so push instead/,
  );
});

test('sync reports a stack that already matches origin as having nothing to sync', (t) => {
  const repo = pushedStack(t);

  const check = synced(repo);

  assert.equal(check.status, 0, output(check));
  assert.match(
    output(check),
    /the stack is already in line with origin; nothing to sync/,
  );
});

test('sync refuses an origin stack holding a merge commit, which the rebase cannot replay', (t) => {
  const repo = pushedStack(t);
  repo.git('checkout', '-q', '--detach', 'main');
  repo.commit('side', { 'side.txt': 'side\n' });
  const side = tip(repo, 'HEAD');
  repo.git('checkout', '-q', '--detach', 'p2');
  repo.git('merge', '-q', '--no-ff', '-m', 'merge main into p2', side);
  repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/p2');
  repo.git('checkout', '-q', 'wip');

  const check = synced(repo);

  assert.equal(check.status, 1, output(check));
  assert.match(output(check), /origin's stack holds merge commits/);
});

/** A stack pushed nowhere, with only an empty origin to fetch from. */
const unpushedStack = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
  ]);
  repo.addOrigin();
  return repo;
};

test('sync moves an unpushed stack onto newer main commits', (t) => {
  const repo = unpushedStack(t);
  landOnMain(repo, 'unrelated', { 'other.txt': 'other\n' });

  const run = synced(repo, '--apply');

  assert.equal(run.status, 0, output(run));
  assert.equal(parentOf(repo, 'p1'), tip(repo, 'main'));
  assert.equal(subjects(repo, 'main..wip'), 'wip notes\nadd one');
});

test('sync refuses an unpushed stack already on the tip of main, with nothing to do', (t) => {
  const repo = unpushedStack(t);

  const check = synced(repo);

  assert.equal(check.status, 1, output(check));
  assert.match(
    output(check),
    /no stack branch is on origin, none has merged, and the stack already sits on main; nothing to sync/,
  );
});

test('sync cuts a pushed branch whose origin branch was deleted, as merged, when no stack branch is left on origin', (t) => {
  const repo = unpushedStack(t);
  repo.git('push', '-q', '-u', 'origin', 'p1');
  landOnMain(repo, 'add one (#1)', { 'one.txt': 'one\n' });
  repo.git('push', '-q', 'origin', '--delete', 'p1');
  const cutTip = tip(repo, 'p1');

  const run = synced(repo, '--apply');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /p1 {2}cut, contained in main/);
  assert.equal(subjects(repo, 'main..wip'), 'wip notes');
  assert.equal(tip(repo, 'p1'), cutTip);
});

test('sync never cuts a branch that was never pushed, even once main holds its change', (t) => {
  const repo = unpushedStack(t);
  landOnMain(repo, 'add one (#1)', { 'one.txt': 'one\n' });

  const check = synced(repo);

  assert.equal(check.status, 0, output(check));
  assert.match(output(check), /no branch below origin's stack to cut/);
});

test('sync drops a landed __ branch from an unpushed stack', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: '__a', subject: 'add a', files: { 'a.txt': 'a\n' } },
    { branch: 'p', subject: 'add p', files: { 'p.txt': 'p\n' } },
  ]);
  repo.addOrigin();
  landOnMain(repo, 'add a (#1)', { 'a.txt': 'a\n' });
  const sourceTip = tip(repo, '__a');

  const run = synced(repo, '--apply');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /__a {2}dropped, landed in main/);
  assert.equal(subjects(repo, 'main..wip'), 'wip notes\nadd p');
  assert.equal(tip(repo, '__a'), sourceTip);
});
