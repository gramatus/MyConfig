import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  buildStack,
  makeRepo,
  type Repo,
  type Run,
} from './stack-plan.fixture.mts';

const output = (run: Run) => `${run.stdout}\n${run.stderr}`;
const tip = (repo: Repo, ref: string) => repo.git('rev-parse', ref).trim();
const subjects = (repo: Repo, range: string) =>
  repo.git('log', '--format=%s', range).trim();
const noteOn = (repo: Repo, sha: string) => {
  try {
    return repo.git('notes', '--ref=refs/notes/target', 'show', sha).trim();
  } catch {
    return '';
  }
};

const planPath = (repo: Repo) =>
  join(repo.dir, '.agent-context/active-work-context/stackplan.txt');

/** Exports the plan, then rewrites its lines with `edit`, as a person editing stackplan.txt would. */
const editPlan = (repo: Repo, edit: (lines: string[]) => string[]) => {
  const exported = repo.stackPlan('export', '-b', 'main');
  assert.equal(exported.status, 0, output(exported));
  const lines = readFileSync(planPath(repo), 'utf8').split('\n');
  writeFileSync(planPath(repo), edit(lines).join('\n'));
};

const isPickOf = (sha: string) => (line: string) =>
  line.startsWith(`pick ${sha.slice(0, 7)}`);

/** Puts `line` right above the line `target` matches, taking it out of where it was if it was there. */
const placeAbove = (
  lines: string[],
  line: string,
  target: (line: string) => boolean,
) => {
  const rest = lines.filter((candidate) => candidate !== line);
  rest.splice(rest.findIndex(target), 0, line);
  return rest;
};

const pickAbove = (sha: string, branch: string) => (lines: string[]) =>
  placeAbove(
    lines,
    lines.find(isPickOf(sha)) ?? `pick ${sha}`,
    (line) => line === `update-ref refs/heads/${branch}`,
  );

/** `p1` and `p2` add a file each, and one commit waits on wip, above `wip notes`. */
const waitingCommit = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'add two', files: { 'two.txt': 'two\n' } },
  ]);
  const waiting = repo.commit('more one', { 'one.txt': 'one\nmore\n' });
  return { repo, waiting };
};

const applied = (repo: Repo, ...flags: string[]) => {
  const run = repo.stackPlan('apply', '-b', 'main', ...flags);
  assert.equal(run.status, 0, output(run));
  return run;
};

test('apply moves a waiting commit placed above a branch to the end of that branch, and verify passes', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));

  const run = applied(repo);

  assert.equal(subjects(repo, 'main..p1'), 'more one\nadd one');
  assert.equal(subjects(repo, 'p1..p2'), 'add two');
  assert.equal(subjects(repo, 'p2..wip'), 'wip notes');
  assert.match(output(run), /tree matches the pre-rebase tip/);
});

test('preview saves the placement as a note, previews the replay and rewrites nothing', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));
  const wipTip = tip(repo, 'wip');

  const run = repo.stackPlan('preview', '-b', 'main');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /all \d+ picks apply cleanly in memory/);
  assert.equal(noteOn(repo, waiting), 'p1');
  assert.equal(tip(repo, 'wip'), wipTip);
});

test('preview -n previews the placements in the file without writing a note', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));

  const run = repo.stackPlan('preview', '-n', '-b', 'main');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /all \d+ picks apply cleanly in memory/);
  assert.equal(noteOn(repo, waiting), '');
});

test('apply refuses a plan whose replay would conflict, names -f, and rewrites nothing', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
  ]);
  repo.commit('edit one', { 'one.txt': 'edited\n' });
  const again = repo.commit('edit one again', { 'one.txt': 'again\n' });
  editPlan(repo, pickAbove(again, 'p1'));
  const wipTip = tip(repo, 'wip');

  const run = repo.stackPlan('apply', '-b', 'main');

  assert.equal(run.status, 1, output(run));
  assert.match(output(run), /Nothing rewritten/);
  assert.match(output(run), /stack-plan apply -f/);
  assert.equal(tip(repo, 'wip'), wipTip);
});

test('apply moves a branch whose update-ref line moved, with its own commits as a block', (t) => {
  const { repo } = waitingCommit(t);
  editPlan(repo, (lines) =>
    placeAbove(
      lines,
      'update-ref refs/heads/p2',
      (line) => line === 'update-ref refs/heads/p1',
    ),
  );

  applied(repo);

  assert.equal(subjects(repo, 'main..p2'), 'add two');
  assert.equal(subjects(repo, 'p2..p1'), 'add one');
  assert.equal(repo.git('config', '--get', 'stackplan.order').trim(), 'p2 p1');
});

test('apply creates a branch named by a new update-ref line, holding the picks above it', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, (lines) =>
    pickAbove(
      waiting,
      'p3',
    )(
      placeAbove(lines, 'update-ref refs/heads/p3', (line) =>
        line.startsWith('# ---- untagged'),
      ),
    ),
  );

  applied(repo);

  assert.equal(subjects(repo, 'p2..p3'), 'more one');
  assert.equal(subjects(repo, 'p3..wip'), 'wip notes');
});

test('apply moves a commit from one stack branch to the end of another when its pick line is added there', (t) => {
  const { repo } = waitingCommit(t);
  const two = tip(repo, 'p2');
  editPlan(repo, pickAbove(two, 'p1'));

  applied(repo);

  assert.equal(subjects(repo, 'main..p1'), 'add two\nadd one');
  assert.equal(subjects(repo, 'p1..p2'), '');
});

test('apply pauses at a stop with its message, and verify after continue counts the commit made there as made at a stop', (t) => {
  const { repo } = waitingCommit(t);
  editPlan(repo, (lines) =>
    placeAbove(
      lines,
      'stop run yarn install',
      (line) => line === 'update-ref refs/heads/p1',
    ),
  );

  const paused = applied(repo);
  assert.match(output(paused), /end of p1: run yarn install/);
  repo.commit('add lockfile', { 'yarn.lock': 'lock\n' });
  const resumed = repo.stackPlan('continue', '-b', 'main');

  assert.equal(resumed.status, 0, output(resumed));
  assert.equal(subjects(repo, 'main..p1'), 'add lockfile\nadd one');
  assert.match(output(resumed), /1 made at stops/);
  assert.match(
    output(resumed),
    /tree matches the pre-rebase tip \S+, apart from files changed at stops: yarn\.lock/,
  );
});

test('apply cherry-picks a commit from outside the stack into the branch its pick line sits in, and verify counts it as adopted', (t) => {
  const { repo } = waitingCommit(t);
  repo.git('checkout', '-q', '--detach', 'main');
  const outside = repo.commit('add side', { 'side.txt': 'side\n' });
  repo.git('checkout', '-q', 'wip');
  editPlan(repo, pickAbove(outside, 'p1'));

  const run = applied(repo);

  assert.equal(subjects(repo, 'main..p1'), 'add side\nadd one');
  assert.match(output(run), /1 adopted/);
  assert.match(
    output(run),
    /apart from files changed by adopted commits: side\.txt/,
  );
});

test('apply folds a fixup! commit into the commit its subject names, with no edit to the plan, and verify counts it as from folds', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
  ]);
  repo.commit('fixup! add one', { 'one.txt': 'one, fixed\n' });
  editPlan(repo, (lines) => lines);

  const run = applied(repo);

  assert.equal(subjects(repo, 'main..p1'), 'add one');
  assert.equal(repo.git('show', 'p1:one.txt'), 'one, fixed\n');
  assert.match(output(run), /from folds/);
});
