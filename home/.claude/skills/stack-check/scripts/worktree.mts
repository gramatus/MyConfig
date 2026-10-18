#!/usr/bin/env node
// Manages the scratch worktree the stack-check skill runs CI checks in.
// Usage: worktree.mts open|branches|goto <branch>|close; ../SKILL.md says when to run each.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const LOCKFILE_NAMES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const readGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Runs git with its output on the terminal, echoing the command first. */
const runGit = (cwd: string, ...args: string[]) => {
  console.error(`$ git ${args.join(' ')}`);
  execFileSync('git', args, { cwd, stdio: 'inherit' });
};

const lines = (text: string) => text.split('\n').filter(Boolean);

const readIfPresent = (path: string) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const isSymlink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const mainCheckout = dirname(
  readGit(
    process.cwd(),
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ).trim(),
);
const worktreePath = join(
  mainCheckout,
  '.agent-context',
  '.tmp',
  'stack-check',
);

/** Returns the main checkout's node_modules directories, relative to it. */
const mainNodeModulesDirs = () =>
  lines(
    readGit(
      mainCheckout,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ),
  )
    .map((path) => path.replace(/\/$/, ''))
    .filter((path) => basename(path) === 'node_modules');

const requireWorktree = () => {
  if (!existsSync(worktreePath)) {
    fail('no stack-check worktree; run open first');
  }
};

const openPullRequestsByBranch = (): Map<string, number> => {
  try {
    const listed = JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--state',
          'open',
          '--limit',
          '200',
          '--json',
          'number,headRefName',
        ],
        { cwd: mainCheckout, encoding: 'utf8' },
      ),
    ) as { number: number; headRefName: string }[];
    return new Map(listed.map((pr) => [pr.headRefName, pr.number]));
  } catch {
    console.error('! gh could not list pull requests, so none are marked');
    return new Map();
  }
};

const stackOrder = () => {
  try {
    return readGit(mainCheckout, 'config', '--get', 'stackplan.order')
      .trim()
      .split(/\s+/);
  } catch {
    return fail('no stackplan.order in git config; save a stack-plan first');
  }
};

const branches = () => {
  const pullRequests = openPullRequestsByBranch();
  console.log('stack, bottom first:');
  for (const branch of stackOrder()) {
    const pullRequest = pullRequests.get(branch);
    console.log(
      pullRequest ? `  ${branch}  PR #${pullRequest}` : `  ${branch}`,
    );
  }
};

const open = () => {
  if (existsSync(worktreePath)) {
    fail(`${worktreePath} exists; run close first`);
  }
  runGit(mainCheckout, 'worktree', 'add', '--detach', worktreePath, 'HEAD');
  for (const dir of mainNodeModulesDirs()) {
    const linkPath = join(worktreePath, dir);
    if (!existsSync(dirname(linkPath))) {
      console.log(`skipped:  ${dir} (its folder is not tracked at HEAD)`);
      continue;
    }
    symlinkSync(join(mainCheckout, dir), linkPath, 'dir');
    console.log(`linked:   ${dir}`);
  }
  console.log(`worktree: ${worktreePath}`);
  branches();
};

const goto = ([branch]: string[]) => {
  const target = branch ?? fail('usage: worktree.mts goto <branch>');
  requireWorktree();
  const changedByChecks = readGit(
    worktreePath,
    'status',
    '--porcelain',
    '--untracked-files=no',
  ).trim();
  if (changedByChecks) {
    console.log(
      `discarding tracked files the last checks changed:\n${changedByChecks}`,
    );
  }
  // -x removes ignored build output too, and the exclude spares the node_modules links.
  runGit(
    worktreePath,
    'clean',
    '-d',
    '--force',
    '-x',
    '--exclude=node_modules',
  );
  runGit(worktreePath, 'checkout', '--force', '--detach', target);
  console.log(
    `at:       ${readGit(worktreePath, 'log', '-1', '--format=%h %s').trim()}`,
  );
  for (const dir of mainNodeModulesDirs()) {
    for (const name of LOCKFILE_NAMES) {
      const lockfile = join(dirname(dir), name);
      if (
        readIfPresent(join(mainCheckout, lockfile)) !==
        readIfPresent(join(worktreePath, lockfile))
      ) {
        console.log(
          `! ${lockfile} differs from the main checkout's, so the linked ${dir} may not match this branch`,
        );
      }
    }
  }
};

// The links go first, so a forced remove can never reach the main checkout's installs.
const close = () => {
  requireWorktree();
  for (const dir of mainNodeModulesDirs()) {
    const linkPath = join(worktreePath, dir);
    if (isSymlink(linkPath)) {
      unlinkSync(linkPath);
    }
  }
  runGit(mainCheckout, 'worktree', 'remove', '--force', worktreePath);
};

const COMMANDS: Record<string, (args: string[]) => void> = {
  open,
  branches,
  goto,
  close,
};

const [command = '', ...args] = process.argv.slice(2);
const handler =
  COMMANDS[command] ??
  fail(`usage: worktree.mts ${Object.keys(COMMANDS).join('|')} [args]`);
try {
  handler(args);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
