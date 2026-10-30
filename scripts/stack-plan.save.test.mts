import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import {
  buildStack,
  editPlan,
  isPickOf,
  makeRepo,
  pickAbove,
  placeAbove,
  planPath,
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
const isMarker = (line: string) => line.startsWith('# ---- untagged');

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

const saved = (repo: Repo, ...flags: string[]) => {
  const run = repo.stackPlan('save', '-b', 'main', ...flags);
  assert.equal(run.status, 0, output(run));
  return run;
};

/** Places `waiting` above p2, applies `edit` on top, and checks save refuses the file with `problem` and writes no note. */
const refused = (
  repo: Repo,
  waiting: string,
  edit: (lines: string[]) => string[],
  problem: RegExp,
) => {
  editPlan(repo, (lines) => edit(pickAbove(waiting, 'p2')(lines)));

  const run = repo.stackPlan('save', '-b', 'main');

  assert.equal(run.status, 1, output(run));
  assert.match(output(run), /no notes written/);
  assert.match(output(run), problem);
  assert.equal(noteOn(repo, waiting), '');
};

const insertAbove =
  (line: string, target: (line: string) => boolean) => (lines: string[]) => {
    const at = lines.findIndex(target);
    return [...lines.slice(0, at), line, ...lines.slice(at)];
  };

test('save writes a note naming the branch a waiting commit is placed above', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));

  const run = saved(repo);

  assert.equal(noteOn(repo, waiting), 'p1');
  assert.match(output(run), /1 notes changed/);
});

test('save -n lists the note under its branch and writes none', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));

  const run = saved(repo, '-n');

  assert.match(
    output(run),
    new RegExp(`^p1\\n {2}${waiting.slice(0, 10)} {2}more one$`, 'm'),
  );
  assert.match(output(run), /1 notes would change/);
  assert.equal(noteOn(repo, waiting), '');
});

test('save removes the note from a placed commit moved back below the untagged marker', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));
  saved(repo);
  editPlan(repo, (lines) => {
    const pick = lines.find(isPickOf(waiting))!;
    return [...lines.filter((line) => line !== pick), pick];
  });

  const run = saved(repo);

  assert.equal(noteOn(repo, waiting), '');
  assert.match(output(run), /untag/);
});

test('save leaves a commit made after export untagged, names it, and moves exported-at to the new tip', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));
  const later = repo.commit('later', { 'later.txt': 'later\n' });

  const run = saved(repo);

  assert.equal(noteOn(repo, waiting), 'p1');
  assert.equal(noteOn(repo, later), '');
  assert.match(output(run), /left untagged, committed after export:\n.*later/);
  assert.match(
    readFileSync(planPath(repo), 'utf8'),
    new RegExp(`^# exported-at: ${later}$`, 'm'),
  );
});

test('save refuses a plan exported before wip was rewritten, and names export as the remedy', (t) => {
  const { repo, waiting } = waitingCommit(t);
  editPlan(repo, pickAbove(waiting, 'p1'));
  repo.git('commit', '-q', '--amend', '-m', 'more one, reworded');

  const run = repo.stackPlan('save', '-b', 'main');

  assert.equal(run.status, 1, output(run));
  assert.match(
    output(run),
    /wip was rewritten since export \(was \w+\); export again/,
  );
});

test('save refuses a plan whose update-ref line for a stack branch is gone, and writes no note for the placements in it', (t) => {
  const { repo, waiting } = waitingCommit(t);
  refused(
    repo,
    waiting,
    (lines) => lines.filter((line) => line !== 'update-ref refs/heads/p1'),
    /update-ref p1 is missing; every stack branch keeps its line/,
  );
});

test('save refuses a plan listing a stack branch twice', (t) => {
  const { repo, waiting } = waitingCommit(t);
  refused(
    repo,
    waiting,
    insertAbove('update-ref refs/heads/p1', isMarker),
    /update-ref p1 is listed twice/,
  );
});

test('save refuses a new empty branch at the bottom of the stack, because git cannot tell it from the base', (t) => {
  const { repo, waiting } = waitingCommit(t);
  refused(
    repo,
    waiting,
    (lines) =>
      placeAbove(
        lines,
        'update-ref refs/heads/p0',
        (line) => line === 'update-ref refs/heads/p1',
      ),
    /p0 is new and empty at the bottom of the stack/,
  );
});

test('save refuses a stop below the untagged marker', (t) => {
  const { repo, waiting } = waitingCommit(t);
  refused(
    repo,
    waiting,
    (lines) => [...lines, 'stop run yarn install'],
    /stop below the untagged marker/,
  );
});

test('save refuses a stop with no message', (t) => {
  const { repo, waiting } = waitingCommit(t);
  refused(
    repo,
    waiting,
    insertAbove('stop', (line) => line === 'update-ref refs/heads/p1'),
    /stop needs a message/,
  );
});

test('save refuses to adopt a commit main already holds', (t) => {
  const { repo, waiting } = waitingCommit(t);
  const onMain = tip(repo, 'main');
  refused(
    repo,
    waiting,
    pickAbove(onMain, 'p1'),
    /cannot be adopted: it is already in main/,
  );
});

test('save refuses to adopt an outside commit that makes the same change as a stack commit', (t) => {
  const { repo, waiting } = waitingCommit(t);
  repo.git('checkout', '-q', '--detach', 'main');
  const twin = repo.commit('add one elsewhere', { 'one.txt': 'one\n' });
  repo.git('checkout', '-q', 'wip');
  refused(
    repo,
    waiting,
    pickAbove(twin, 'p1'),
    new RegExp(
      `cannot be adopted: it makes the same change as ${tip(repo, 'p1').slice(0, 10)} in the stack`,
    ),
  );
});

test('save refuses fixup in short mode, because only full mode folds by the plan', (t) => {
  const { repo, waiting } = waitingCommit(t);
  const notes = tip(repo, 'wip~1');
  refused(
    repo,
    waiting,
    (lines) =>
      lines.map((line) =>
        isPickOf(notes)(line) ? line.replace(/^pick/, 'fixup') : line,
      ),
    /fixup needs full mode/,
  );
});
