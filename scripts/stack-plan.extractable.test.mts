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

type Report = {
  chains: {
    moveConflict: string | null;
    members: { name: string; needs: string[]; replay: string | null }[];
  }[];
  blocked: { name: string; reason: string }[];
  untested: string[];
};

const report = (repo: Repo, ...flags: string[]): Report => {
  const run = repo.stackPlan('extractable', '--json', '-b', 'main', ...flags);
  assert.equal(run.status, 0, output(run));
  return JSON.parse(run.stdout) as Report;
};

const chainNames = (result: Report) =>
  result.chains.map((chain) => chain.members.map((member) => member.name));

/** `p1` adds one.txt, `p2` adds two.txt, and `p3` edits one.txt, so p3 cannot replay on main without p1. */
const needyStack = (t: TestContext) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'add one', files: { 'one.txt': 'one\n' } },
    { branch: 'p2', subject: 'add two', files: { 'two.txt': 'two\n' } },
    { branch: 'p3', subject: 'edit one', files: { 'one.txt': 'one\nthree\n' } },
  ]);
  return repo;
};

test('extractable lists a branch that replays on main alone, and chains a branch with the one below it that its conflict needs', (t) => {
  const repo = needyStack(t);

  const result = report(repo);

  assert.deepEqual(chainNames(result), [['p1', 'p3'], ['p2']]);
  assert.deepEqual(result.chains[0].members[1].needs, ['p1']);
  assert.ok(result.chains.every((chain) => chain.moveConflict === null));
  assert.deepEqual(result.blocked, []);
});

test("extractable's replay commit for a branch holds its change on main, for checking that it builds there", (t) => {
  const repo = needyStack(t);

  const replay = report(repo).chains[1].members[0].replay!;

  assert.equal(tip(repo, `${replay}^`), tip(repo, 'main'));
  assert.equal(repo.git('show', `${replay}:two.txt`), 'two\n');
  assert.throws(() => repo.git('show', `${replay}:one.txt`));
});

test('extractable ends with the mark line for every candidate, and changes nothing', (t) => {
  const repo = needyStack(t);
  const wipTip = tip(repo, 'wip');

  const run = repo.stackPlan('extractable', '-b', 'main');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /To mark them: stack-plan mark p1 p2 p3/);
  assert.equal(tip(repo, 'wip'), wipTip);
});

test('extractable blocks a branch that conflicts with main itself, since no branch below can help it', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: 'p1', subject: 'edit readme', files: { 'README.md': 'p1\n' } },
  ]);
  landOnMain(repo, 'edit readme on main', { 'README.md': 'main\n' });

  const result = report(repo);

  assert.deepEqual(result.blocked, [
    { name: 'p1', reason: 'conflicts with main itself (README.md)' },
  ]);
});

test('extractable blocks a branch that needs a PR branch below it, and names the mark line that would let it stack there', (t) => {
  const repo = needyStack(t);
  repo.addOrigin();
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

  const result = report(repo);

  assert.deepEqual(result.blocked, [
    {
      name: 'p3',
      reason: 'needs p1 (one.txt); to stack on it: stack-plan mark p1',
    },
  ]);
  assert.deepEqual(chainNames(result), [['p2']]);
});

test('extractable --upto tests only the branches up to the one named, and lists the rest as untested', (t) => {
  const repo = needyStack(t);

  const result = report(repo, '--upto', 'p2');

  assert.deepEqual(chainNames(result), [['p1'], ['p2']]);
  assert.deepEqual(result.untested, ['p3']);
});

test('extractable counts a __ branch as already marked, and chains a branch that needs it onto it', (t) => {
  const repo = makeRepo(t);
  buildStack(repo, [
    { branch: '__a', subject: 'add a', files: { 'a.txt': 'a\n' } },
    { branch: 'p1', subject: 'edit a', files: { 'a.txt': 'a\np1\n' } },
  ]);

  const run = repo.stackPlan('extractable', '-b', 'main');

  assert.equal(run.status, 0, output(run));
  assert.match(output(run), /__a {2}marked already/);
  assert.match(output(run), /To mark them: stack-plan mark p1$/m);
});
