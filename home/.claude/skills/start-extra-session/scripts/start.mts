#!/usr/bin/env node
// Starts a remote-control Claude Code session on a folder under /repos, detached in tmux.
// Usage: start.mts <folder>; ../SKILL.md says how the skill relays the result.

import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const REPOS_ROOT = '/repos';
const FOLDER_NAME = /^[A-Za-z0-9._-]+$/;
const TRUSTED_GITHUB_OWNERS = ['torgst', 'gramatus', 'helse-sorost'];
const STARTUP_WAIT_MS = 8000;
const PENDING_PROMPT = /trust|enable remote control/i;
const SESSION_URL = /https:\/\/claude\.ai\/code\/\S+/;

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const tmux = (...args: string[]) =>
  spawnSync('tmux', args, { encoding: 'utf8' });

const resolveFolder = (name: string) => {
  if (!FOLDER_NAME.test(name) || name === '.' || name === '..')
    fail(`"${name}" is not a plain folder name`);
  let path = '';
  try {
    path = realpathSync(`${REPOS_ROOT}/${name}`);
  } catch {
    fail(`${REPOS_ROOT}/${name} does not exist`);
  }
  if (dirname(path) !== REPOS_ROOT || !statSync(path).isDirectory())
    fail(`${REPOS_ROOT}/${name} resolves to ${path}, outside ${REPOS_ROOT}`);
  return path;
};

const githubOwner = (path: string) => {
  try {
    const url = execFileSync(
      'git',
      ['-C', path, 'remote', 'get-url', 'origin'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return /github\.com[:/]([^/]+)\//.exec(url)?.[1];
  } catch {
    return undefined;
  }
};

const name = process.argv[2] ?? fail('usage: start.mts <folder under /repos>');
const path = resolveFolder(name);

const owner = githubOwner(path);
if (!owner || !TRUSTED_GITHUB_OWNERS.includes(owner))
  console.log(
    `⚠ origin is ${owner ? `owned by ${owner}` : 'not on GitHub'}, not ${TRUSTED_GITHUB_OWNERS.join(' or ')}`,
  );

// tmux turns "." in a session name into "_", so do it here and print the name it will use.
const session = `cc-${name.replaceAll('.', '_')}`;
if (tmux('has-session', '-t', `=${session}`).status === 0)
  fail(`tmux session ${session} is already running: tmux attach -t ${session}`);

const started = tmux(
  'new-session',
  '-d',
  '-s',
  session,
  '-c',
  path,
  'claude',
  '--remote-control',
  name,
  '--permission-mode',
  'default',
);
if (started.status !== 0)
  fail(`tmux could not start: ${started.stderr.trim()}`);

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STARTUP_WAIT_MS);

if (tmux('has-session', '-t', `=${session}`).status !== 0)
  fail(
    `claude exited within ${STARTUP_WAIT_MS / 1000}s; run it in a terminal in ${path} to see why`,
  );

const screen = tmux('capture-pane', '-p', '-t', `=${session}:`).stdout;
if (PENDING_PROMPT.test(screen))
  fail(
    `claude is waiting on a prompt only a terminal can answer: tmux attach -t ${session}\n${screen.trim()}`,
  );

console.log(`✓ ${name} is running in tmux session ${session}`);
const url = SESSION_URL.exec(screen)?.[0];
console.log(
  url ? `  ${url}` : '  open it from the session list in the Claude app',
);
console.log(`  stop it with: tmux kill-session -t ${session}`);
