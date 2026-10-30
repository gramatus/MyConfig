import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  buildStack,
  makeRepo,
  type Repo,
  type Run,
} from './stack-plan.fixture.mts';

const output = (run: Run) => `${run.stdout}\n${run.stderr}`;
const tip = (repo: Repo, ref: string) => repo.git('rev-parse', ref).trim();
const noteOn = (repo: Repo, sha: string) => {
  try {
    return repo.git('notes', '--ref=refs/notes/target', 'show', sha).trim();
  } catch {
    return '';
  }
};

/** `p1` adds `lines.txt`, and two commits wait on wip above it: `first` edits line 1 and `second` line 7. */
const twoWaiting = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    {
      branch: 'p1',
      subject: 'add lines',
      files: { 'lines.txt': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n' },
    },
  ]);
  const first = repo.commit('edit first', {
    'lines.txt': 'L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n',
  });
  const second = repo.commit('edit second', { 'second.txt': 'second\n' });
  return { repo, first, second };
};

const verified = (repo: Repo, ...flags: string[]) =>
  repo.stackPlan('verify', '-b', 'main', ...flags);

/** Records the pre-rebase tip, then replaces wip's two waiting commits with `picks`, as a rebase by hand would. */
const rebuildWip = (repo: Repo, picks: string[]) => {
  const prepare = repo.stackPlan('prepare');
  assert.equal(prepare.status, 0, output(prepare));
  repo.git('reset', '-q', '--hard', 'HEAD~2');
  for (const sha of picks) repo.git('cherry-pick', sha);
};

test('verify passes a rebase by hand that only reordered commits, on the tree and the range-diff both', (t) => {
  const { repo, first, second } = twoWaiting(t);
  rebuildWip(repo, [second, first]);

  const run = verified(repo);

  assert.equal(run.status, 0, output(run));
  assert.match(
    output(run),
    /range-diff {2}4 unchanged · 0 context only · 0 changed · 0 dropped · 0 added/,
  );
  assert.match(output(run), /tree matches the pre-rebase tip/);
});

test('verify counts a moved commit whose neighbouring lines changed as context only, not as changed', (t) => {
  const repo = makeRepo(t);
  const lines = (changed: number[]) =>
    Array.from({ length: 10 }, (_, i) =>
      changed.includes(i + 1) ? `L${i + 1}\n` : `l${i + 1}\n`,
    ).join('');
  buildStack(repo, [
    { branch: 'p1', subject: 'add lines', files: { 'lines.txt': lines([]) } },
  ]);
  const first = repo.commit('edit line 1', { 'lines.txt': lines([1]) });
  const second = repo.commit('edit line 4', { 'lines.txt': lines([1, 4]) });
  rebuildWip(repo, [second, first]);

  const run = verified(repo);

  assert.match(output(run), /2 context only · 0 changed · 0 dropped · 0 added/);
  assert.match(output(run), /Only the surrounding lines moved/);
  assert.match(output(run), /tree matches the pre-rebase tip/);
});

test('verify reports a resolution that lost part of a change, with the files and the restore command', (t) => {
  const { repo, first, second } = twoWaiting(t);
  const before = tip(repo, 'wip');
  rebuildWip(repo, [second]);
  repo.git('cherry-pick', '--no-commit', first);
  repo.commit('edit first', { 'lines.txt': 'L1\nl2\nl3\nl4\nl5\nl6\nl7\n' });

  const run = verified(repo);

  assert.match(
    output(run),
    /1 changed · 0 dropped · 0 added; read the changed entries above/,
  );
  assert.match(output(run), /tree differs from the pre-rebase tip/);
  assert.match(output(run), /lines\.txt/);
  assert.match(
    output(run),
    new RegExp(
      `git restore --source=${before.slice(0, 10)} --staged --worktree :/`,
    ),
  );
});

test('verify reports a commit the rebase dropped', (t) => {
  const { repo, second } = twoWaiting(t);
  rebuildWip(repo, [second]);

  const run = verified(repo);

  assert.match(output(run), /1 dropped · 0 added; read the entries above/);
  assert.match(
    output(run),
    /Dropped \(<\) or added \(>\), full entries above:\n.*edit first/,
  );
});

/** A note naming `p1` on `p1`'s own commit, as a finished move leaves it, and one on a commit still waiting on wip. */
const placedAndWaiting = (t: TestContext) => {
  const { repo, first } = twoWaiting(t);
  const placed = tip(repo, 'p1');
  repo.git('notes', '--ref=refs/notes/target', 'add', '-m', 'p1', placed);
  repo.git('notes', '--ref=refs/notes/target', 'add', '-m', 'p1', first);
  const prepare = repo.stackPlan('prepare');
  assert.equal(prepare.status, 0, output(prepare));
  return { repo, placed, waiting: first };
};

test('verify removes the note from a commit now in the branch it names, and keeps the one on a commit still waiting', (t) => {
  const { repo, placed, waiting } = placedAndWaiting(t);

  const run = verified(repo);

  assert.match(output(run), /1 notes removed from commits now in their branch/);
  assert.equal(noteOn(repo, placed), '');
  assert.equal(noteOn(repo, waiting), 'p1');
});

test('verify --dry-run counts the notes it would remove and removes none', (t) => {
  const { repo, placed } = placedAndWaiting(t);

  const run = verified(repo, '--dry-run');

  assert.match(
    output(run),
    /1 notes would be removed from commits now in their branch/,
  );
  assert.equal(noteOn(repo, placed), 'p1');
});

test('verify keeps the note on a stack commit whose move to another branch has not run yet', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'add two', files: { 'two.txt': 'two\n' } },
  ]);
  repo.git('config', 'stackplan.order', 'p1 p2');
  const moving = tip(repo, 'p2');
  repo.git('notes', '--ref=refs/notes/target', 'add', '-m', 'p1', moving);
  const prepare = repo.stackPlan('prepare');
  assert.equal(prepare.status, 0, output(prepare));

  const run = verified(repo);

  assert.equal(run.status, 0, output(run));
  assert.equal(noteOn(repo, moving), 'p1');
});
