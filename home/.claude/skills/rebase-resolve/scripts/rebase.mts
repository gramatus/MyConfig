#!/usr/bin/env node
// Drives a stack-plan rebase for the rebase-resolve skill: one subcommand per step the agent may take.
// Usage: rebase.mts preview|start|status|continue|abort|verify [args]; ../SKILL.md says when to run each.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFLICT_MARKER = /^(<{7} |>{7} |\|{7} |={7}$)/m;

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const readGit = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

/** Runs a program with its output on the terminal, echoing it first, and returns its exit status. */
const run = (program: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  console.error(`$ ${[program, ...args].join(' ')}`);
  return (
    spawnSync(program, args, {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    }).status ?? 1
  );
};

const lines = (text: string) =>
  text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));

/** Paths from a `-z` read, which git leaves unquoted however `core.quotePath` is set. */
const readPaths = (...args: string[]) =>
  readGit(...args, '-z')
    .split('\0')
    .filter(Boolean);

const rebaseDir = () => {
  const gitDir = readGit('rev-parse', '--absolute-git-dir').trim();
  return ['rebase-merge', 'rebase-apply']
    .map((name) => join(gitDir, name))
    .find(existsSync);
};

const requireRebase = () => rebaseDir() ?? fail('no rebase is in progress');

const unmergedPaths = () => readPaths('diff', '--name-only', '--diff-filter=U');

const hasMarkers = (path: string) =>
  existsSync(path) && CONFLICT_MARKER.test(readFileSync(path, 'utf8'));

const readIfPresent = (path: string) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

/** Stage 2 is this position and stage 3 the commit being picked; a modify/delete lacks one of them and has no markers. */
const unmergedNote = (path: string) => {
  const stages = lines(readGit('ls-files', '-u', '--', path)).map(
    (line) => line.split(/\s+/)[2],
  );
  if (!stages.includes('2'))
    return '  (modify/delete: absent at this position, so the tree holds the picked version whole; recheck feasibility)';
  if (!stages.includes('3'))
    return '  (modify/delete: the commit deletes a file changed at this position)';
  if (hasMarkers(path)) return '';
  return '  (no markers: read git diff before continue, rerere may have replayed it)';
};

const status = () => {
  const dir = requireRebase();
  const done = lines(readIfPresent(join(dir, 'done')));
  const todo = lines(readIfPresent(join(dir, 'git-rebase-todo')));
  console.log(
    `pre-rebase tip: ${readIfPresent(join(dir, 'orig-head')).trim()}`,
  );
  console.log(`stopped at:     ${done.at(-1) ?? '(nothing picked yet)'}`);
  // A stop from the plan is a break right after stack-plan's _stop line, which printed the user's message.
  const userStop = /\s_stop\s+'?([^']+)'?$/.exec(done.at(-2) ?? '')?.[1];
  if (done.at(-1) === 'break' && userStop)
    console.log(
      `user stop:      ${userStop}, planned for the user; hand over with its message, never continue past it`,
    );
  console.log(
    `next:           ${todo[0] ?? '(nothing left)'}  (${todo.length} commands left)`,
  );
  for (const path of unmergedPaths())
    console.log(`unmerged:       ${path}${unmergedNote(path)}`);
};

const passThrough = (command: string) => (args: string[]) =>
  process.exit(run('stack-plan', [command, ...args]));

const start = (args: string[]) => {
  if (rebaseDir()) fail('a rebase is already in progress; run status');
  // stack-plan opens git's sequence editor to review the todo; `true` accepts it unread.
  const exitStatus = run('stack-plan', ['apply', '-f', ...args], {
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_EDITOR: 'true',
  });
  if (rebaseDir()) return status();
  if (exitStatus !== 0)
    fail('stack-plan apply failed before the rebase started');
};

const continueRebase = (args: string[]) => {
  requireRebase();
  const messageFlag = args.indexOf('--message-file');
  const messageFile =
    messageFlag < 0
      ? undefined
      : (args[messageFlag + 1] ?? fail('--message-file needs a path'));
  const namedPaths = args.filter(
    (_, index) =>
      messageFlag < 0 || (index !== messageFlag && index !== messageFlag + 1),
  );
  const paths = [...new Set([...unmergedPaths(), ...namedPaths])];

  const marked = paths.filter(hasMarkers);
  if (marked.length) fail(`conflict markers remain in ${marked.join(', ')}`);
  const leftBehind = readPaths('diff', '--name-only').filter(
    (path) => !paths.includes(path),
  );
  if (leftBehind.length)
    fail(
      `unstaged changes outside the named paths: ${leftBehind.join(', ')}; name them to stage them`,
    );

  if (paths.length && run('git', ['add', '-A', '--', ...paths]) !== 0)
    fail('git add failed');
  if (messageFile && run('git', ['commit', '-F', messageFile]) !== 0)
    fail('git commit failed');
  const exitStatus = run('git', ['rebase', '--continue'], {
    GIT_EDITOR: 'true',
  });
  if (rebaseDir()) return status();
  if (exitStatus !== 0) fail('git rebase --continue failed');
  process.exit(run('stack-plan', ['verify']));
};

const abort = () => {
  requireRebase();
  process.exit(run('git', ['rebase', '--abort']));
};

const COMMANDS: Record<string, (args: string[]) => void> = {
  preview: passThrough('preview'),
  start,
  status,
  continue: continueRebase,
  abort,
  verify: passThrough('verify'),
};

const [command = '', ...args] = process.argv.slice(2);
const handler =
  COMMANDS[command] ??
  fail(`usage: rebase.mts ${Object.keys(COMMANDS).join('|')} [args]`);
try {
  process.chdir(readGit('rev-parse', '--show-toplevel').trim());
  handler(args);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
