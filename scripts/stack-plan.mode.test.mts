import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import {
  buildStack,
  editPlan,
  isPickOf,
  makeRepo,
  placeAbove,
  planPath,
  type Repo,
  type Run,
} from './stack-plan.fixture.mts';

const output = (run: Run) => `${run.stdout}\n${run.stderr}`;
const subjects = (repo: Repo, range: string) =>
  repo.git('log', '--format=%s', range).trim();

const mode = (repo: Repo, ...args: string[]) => {
  const run = repo.stackPlan('mode', ...args);
  assert.equal(run.status, 0, output(run));
  return output(run);
};

const run = (repo: Repo, command: string) => {
  const result = repo.stackPlan(command, '-b', 'main');
  assert.equal(result.status, 0, output(result));
  return result;
};

/** `p1` holds two commits on separate files, `p2` one, and `wip notes` waits on wip. */
const twoInP1 = (t: TestContext) => {
  const repo = makeRepo(t);
  repo.commit('initial', { 'README.md': 'readme\n' });
  repo.git('checkout', '-q', '-b', 'wip');
  const first = repo.commit('add one', { 'one.txt': 'one\n' });
  const second = repo.commit('add uno', { 'uno.txt': 'uno\n' });
  repo.git('branch', 'p1');
  repo.commit('add two', { 'two.txt': 'two\n' });
  repo.git('branch', 'p2');
  repo.commit('wip notes', { 'notes.txt': 'notes\n' });
  return { repo, first, second };
};

test('mode is short until set, and mode short switches full back', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
  ]);

  assert.match(mode(repo), /short {2}export lists only the commits waiting/);
  assert.match(mode(repo, 'full'), /full {2}export lists every commit/);
  assert.match(mode(repo), /^full/m);
  assert.match(mode(repo, 'short'), /^short/m);
  assert.throws(() => repo.git('config', '--get', 'stackplan.mode'));
});

test("full mode's export lists every commit since the base above its branch's update-ref, and marks the file", (t) => {
  const { repo, first, second } = twoInP1(t);
  mode(repo, 'full');

  run(repo, 'export');

  const lines = readFileSync(planPath(repo), 'utf8').split('\n');
  assert.ok(lines.includes('# mode: full'));
  const p1At = lines.indexOf('update-ref refs/heads/p1');
  assert.equal(lines[p1At - 2], `pick ${first.slice(0, 10)} add one`);
  assert.equal(lines[p1At - 1], `pick ${second.slice(0, 10)} add uno`);
});

test('save refuses a plan exported in the other mode, and names export as the remedy', (t) => {
  const { repo } = twoInP1(t);
  run(repo, 'export');
  mode(repo, 'full');

  const result = repo.stackPlan('save', '-b', 'main');

  assert.equal(result.status, 1, output(result));
  assert.match(
    output(result),
    /the plan was exported in short mode, and the mode is now full; export again/,
  );
});

test("apply in full mode follows the file's order of picks within a branch", (t) => {
  const { repo, first, second } = twoInP1(t);
  mode(repo, 'full');
  editPlan(repo, (lines) =>
    placeAbove(lines, lines.find(isPickOf(second))!, isPickOf(first)),
  );

  run(repo, 'apply');

  assert.equal(subjects(repo, 'main..p1'), 'add one\nadd uno');
});

test('apply in full mode folds a commit listed as fixup into the pick above it', (t) => {
  const { repo, second } = twoInP1(t);
  mode(repo, 'full');
  editPlan(repo, (lines) =>
    lines.map((line) =>
      isPickOf(second)(line) ? line.replace(/^pick/, 'fixup') : line,
    ),
  );

  run(repo, 'apply');

  assert.equal(subjects(repo, 'main..p1'), 'add one');
  assert.equal(repo.git('show', 'p1:uno.txt'), 'uno\n');
});
