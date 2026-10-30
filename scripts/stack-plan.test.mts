import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { makeRepo, type Repo, type Run } from './stack-plan.fixture.mts';

const output = (run: Run) => `${run.stdout}\n${run.stderr}`;

/** Two standalone `__` branches with extracted copies, after `__a`'s commit was rewritten under the same subject. */
const copyOlderThanSource = (t: TestContext): Repo => {
  const repo = makeRepo(t);
  repo.commit('initial', { 'README.md': 'readme\n' });
  repo.git('checkout', '-q', '-b', 'wip');
  repo.commit('add b', { 'b.txt': 'b\n' });
  repo.git('branch', '__b');
  repo.commit('add a', { 'a.txt': 'first version\n' });
  repo.git('branch', '__a');
  const wipCommit = repo.commit('wip notes', { 'notes.txt': 'notes\n' });
  const extract = repo.stackPlan('extract', '--apply', '-b', 'main');
  assert.equal(extract.status, 0, output(extract));

  repo.git('checkout', '-q', '--detach', '__b');
  repo.commit('add a', { 'a.txt': 'second version\n' });
  repo.git('branch', '-f', '__a', 'HEAD');
  repo.git('cherry-pick', wipCommit);
  repo.git('checkout', '-q', '-B', 'wip');
  return repo;
};

/** Lands `__b`'s change on main as a squash merge would, then cuts `__b` from the stack. */
const landAndCutB = (repo: Repo) => {
  repo.git('checkout', '-q', 'main');
  repo.commit('add b (#1)', { 'b.txt': 'b\n' });
  repo.git('checkout', '-q', 'wip');
  return repo.stackPlan('cut', '__b', '--apply', '-b', 'main');
};

test('the rebuild after a cut leaves a copy older than its source for extract, listing the pair rather than calling it foreign', (t) => {
  const repo = copyOlderThanSource(t);
  const copyTip = repo.git('rev-parse', 'a');

  const cut = landAndCutB(repo);

  assert.match(
    output(cut),
    /__a → a {2}has 1 commit that __a holds another version of; to compare and replace them: stack-plan extract/,
  );
  assert.match(output(cut), /left for stack-plan extract: a/);
  assert.doesNotMatch(output(cut), /neither __a nor main holds/);
  assert.doesNotMatch(output(cut), /--from-copy/);
  assert.equal(repo.git('rev-parse', 'a'), copyTip);
});

test("extract replaces a copy's commit with the source's rewritten version when their subjects pair", (t) => {
  const repo = copyOlderThanSource(t);

  const extract = repo.stackPlan('extract', '--apply', '-b', 'main');

  assert.equal(extract.status, 0, output(extract));
  assert.match(output(extract), /1 commit replaced by __a's version/);
  assert.equal(repo.git('show', 'a:a.txt'), 'second version\n');
});

test('the rebuild after a cut still reports a review fix on the copy as missing from the source, even when its other commit pairs', (t) => {
  const repo = copyOlderThanSource(t);
  repo.git('checkout', '-q', 'a');
  repo.commit('address review', { 'review.txt': 'fix\n' });
  repo.git('checkout', '-q', 'wip');
  const copyTip = repo.git('rev-parse', 'a');

  const cut = landAndCutB(repo);

  assert.match(output(cut), /has 1 commit neither __a nor main holds/);
  assert.match(output(cut), /stack-plan extract --from-copy __a/);
  assert.equal(repo.git('rev-parse', 'a'), copyTip);
});
