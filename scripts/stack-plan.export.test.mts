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
const planLines = (repo: Repo) =>
  readFileSync(planPath(repo), 'utf8').split('\n');
const isMarker = (line: string) => line.startsWith('# ---- untagged');

/** The line right above `update-ref refs/heads/<branch>` in the plan file. */
const lineAbove = (repo: Repo, branch: string) => {
  const lines = planLines(repo);
  return lines[lines.indexOf(`update-ref refs/heads/${branch}`) - 1];
};

const header = (repo: Repo, prefix: string) =>
  planLines(repo)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);

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

const run = (repo: Repo, command: string, ...flags: string[]) => {
  const result = repo.stackPlan(command, '-b', 'main', ...flags);
  assert.equal(result.status, 0, output(result));
  return result;
};

test('export writes a commit placed and saved in an earlier round already in its branch section, so only new commits need placing', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));
  run(repo, 'save');

  const exported = run(repo, 'export');

  assert.equal(
    lineAbove(repo, 'p1'),
    `pick ${waiting.slice(0, 10)} >>> [moved] more one`,
  );
  assert.match(output(exported), /2 waiting · 1 placed/);
});

test('export marks a stack commit saved as moving to another branch with >>> [moved] in its new section', (t) => {
  const { repo } = waitingCommit(t);
  const two = tip(repo, 'p2');
  editPlan(repo, pickAbove(two, 'p1'));
  run(repo, 'save');

  run(repo, 'export');

  assert.equal(
    lineAbove(repo, 'p1'),
    `pick ${two.slice(0, 10)} >>> [moved] add two`,
  );
});

test('export drops a placement that was edited but never saved, and keeps the edited file as stackplan.txt.bak', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));
  const edited = readFileSync(planPath(repo), 'utf8');

  run(repo, 'export');

  assert.equal(readFileSync(`${planPath(repo)}.bak`, 'utf8'), edited);
  const lines = planLines(repo);
  assert.ok(
    lines.indexOf(`pick ${waiting.slice(0, 10)} more one`) >
      lines.findIndex(isMarker),
    lines.join('\n'),
  );
});

test("export records wip's tip as exported-at and carries the last rebase's pre-rebase line over", (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));
  const beforeRebase = tip(repo, 'wip');
  run(repo, 'apply');

  run(repo, 'export');

  assert.equal(header(repo, '# exported-at: '), tip(repo, 'wip'));
  assert.equal(header(repo, '# pre-rebase: '), beforeRebase);
});

test('export names extract on the mirror line of a __ branch with no copy, and ends the __ block with the other-stacks marker', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: '__a', subject: 'add a', files: { 'a.txt': 'a\n' } },
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
  ]);

  run(repo, 'export');

  assert.equal(
    lineAbove(repo, '__a'),
    '# mirror: a · not extracted → stack-plan extract',
  );
  const lines = planLines(repo);
  const marker = lines.indexOf('# --- Other stacks stop here ---');
  assert.ok(
    lines.indexOf('update-ref refs/heads/__a') < marker &&
      marker < lines.indexOf('update-ref refs/heads/p1'),
    lines.join('\n'),
  );
});

test('export shows an extracted copy as up to date, then as behind with the extract command once its source gains a commit', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: '__a', subject: 'add a', files: { 'a.txt': 'a\n' } },
  ]);
  run(repo, 'extract', '--apply');

  run(repo, 'export');
  assert.equal(lineAbove(repo, '__a'), '# mirror: a · up to date');

  addToLayer(repo, '__a', [], 'more a', { 'a.txt': 'a\nmore\n' });
  run(repo, 'export');
  assert.equal(
    lineAbove(repo, '__a'),
    '# mirror: a · 1 commit behind → stack-plan extract',
  );
});
