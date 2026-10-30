import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  buildStack,
  makeRepo,
  type Repo,
  type Run,
} from './stack-plan.fixture.mts';

const output = (run: Run) => `${run.stdout}\n${run.stderr}`;

const needs = (repo: Repo, ...args: string[]) => {
  const run = repo.stackPlan('needs', ...args, '-b', 'main');
  assert.equal(run.status, 0, output(run));
  return output(run);
};

/** Three branches that each add a file of their own, so nothing conflicts and every need has to be declared. */
const threeBranches = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'add two', files: { 'two.txt': 'two\n' } },
    { branch: 'p3', subject: 'add three', files: { 'three.txt': 'three\n' } },
  ]);
  return repo;
};

test('needs records a need no conflict shows, and naming no others shows what is recorded', (t) => {
  const repo = threeBranches(t);
  needs(repo, 'p3', 'p1');

  const shown = needs(repo, 'p3');

  assert.match(shown, /Needs of p3 ─+\np1$/m);
  assert.equal(
    repo.git('config', '--get-all', 'branch.p3.stackNeeds').trim(),
    'p1',
  );
});

test('needs --clear forgets what was recorded before adding', (t) => {
  const repo = threeBranches(t);
  needs(repo, 'p3', 'p1');

  const cleared = needs(repo, 'p3', '--clear');
  const replaced = needs(repo, 'p3', 'p2', '--clear');

  assert.match(cleared, /none declared/);
  assert.equal(
    repo.git('config', '--get-all', 'branch.p3.stackNeeds').trim(),
    'p2',
  );
  assert.doesNotMatch(replaced, /p1/);
});

test('needs refuses a need that sits above the branch, because needs point only downwards', (t) => {
  const repo = threeBranches(t);

  const run = repo.stackPlan('needs', 'p1', 'p3', '-b', 'main');

  assert.equal(run.status, 1, output(run));
  assert.match(output(run), /p3 sits above p1/);
});

test('needs refuses a branch that is not in the stack', (t) => {
  const repo = threeBranches(t);

  const run = repo.stackPlan('needs', 'p3', 'nope', '-b', 'main');

  assert.equal(run.status, 1, output(run));
  assert.match(output(run), /nope is not a stack branch/);
});

test('extractable chains a branch with the one it declares it needs, and marks that need declared', (t) => {
  const repo = threeBranches(t);
  needs(repo, 'p3', 'p1');

  const run = repo.stackPlan('extractable', '-b', 'main');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /p1 → p3/);
  assert.match(output(run), /p3 {2}needs p1 \(declared\)/);
});

test("a declared need follows mark's rename of the needed branch, matched without its prefix", (t) => {
  const repo = threeBranches(t);
  needs(repo, 'p3', 'p1');
  const mark = repo.stackPlan('mark', 'p1', '-b', 'main');
  assert.equal(mark.status, 0, output(mark));

  const shown = needs(repo, 'p3');

  assert.match(shown, /Needs of p3 ─+\n__p1$/m);
});
