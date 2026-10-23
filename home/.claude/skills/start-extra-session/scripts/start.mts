#!/usr/bin/env node
// Starts, lists or resumes remote-control Claude Code sessions on a folder under /repos, detached in tmux.
// Usage: start.mts <folder> [list [count] | resume <session-id>]; ../SKILL.md says how the skill relays the result.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const REPOS_ROOT = '/repos';
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const FOLDER_NAME = /^[A-Za-z0-9._-]+$/;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRUSTED_GITHUB_OWNERS = ['torgst', 'gramatus', 'helse-sorost'];
const DEFAULT_LIST_COUNT = 5;
const TITLE_MAX_LENGTH = 70;
const STARTUP_WAIT_MS = 8000;
const PENDING_PROMPT = /trust[^\n]*\?|enable remote control\?/i;
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

const sessionsDir = (path: string) =>
  join(CLAUDE_PROJECTS_DIR, path.replace(/[^A-Za-z0-9]/g, '-'));

const sessionsNewestFirst = (path: string) => {
  const dir = sessionsDir(path);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => ({
      id: file.slice(0, -'.jsonl'.length),
      file: join(dir, file),
      changedMs: statSync(join(dir, file)).mtimeMs,
    }))
    .sort((a, b) => b.changedMs - a.changedMs);
};

type SessionEntry = {
  type?: string;
  customTitle?: string;
  aiTitle?: string;
  isMeta?: boolean;
  message?: { content?: string | { type?: string; text?: string }[] };
};

const promptText = (entry: SessionEntry) => {
  const content = entry.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : content?.find((block) => block.type === 'text')?.text;
  return text && !text.startsWith('<') ? text : undefined;
};

/** A /rename title wins over Claude's generated one, and the first prompt stands in when neither exists. */
const sessionTitle = (file: string) => {
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let firstPrompt: string | undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue;
    }
    if (entry.type === 'custom-title') customTitle = entry.customTitle;
    else if (entry.type === 'ai-title') aiTitle = entry.aiTitle;
    else if (entry.type === 'user' && !entry.isMeta && !firstPrompt)
      firstPrompt = promptText(entry);
  }
  const title = (customTitle ?? aiTitle ?? firstPrompt ?? '(no title)')
    .replace(/\s+/g, ' ')
    .trim();
  return title.length > TITLE_MAX_LENGTH
    ? `${title.slice(0, TITLE_MAX_LENGTH - 1)}…`
    : title;
};

const listSessions = (path: string, countArg: string | undefined) => {
  const count = countArg === undefined ? DEFAULT_LIST_COUNT : Number(countArg);
  if (!Number.isInteger(count) || count < 1)
    fail(`"${countArg}" is not a positive whole number`);
  const sessions = sessionsNewestFirst(path).slice(0, count);
  if (sessions.length === 0) fail(`no sessions recorded for ${path}`);
  sessions.forEach((session, index) => {
    const changed = new Date(session.changedMs)
      .toLocaleString('sv-SE')
      .slice(0, 16);
    console.log(`${index + 1}. ${changed}  ${sessionTitle(session.file)}`);
    console.log(`   ${session.id}`);
  });
};

const startInTmux = (
  path: string,
  name: string,
  session: string,
  claudeArgs: string[],
) => {
  const owner = githubOwner(path);
  if (!owner || !TRUSTED_GITHUB_OWNERS.includes(owner))
    console.log(
      `⚠ origin is ${owner ? `owned by ${owner}` : 'not on GitHub'}, not ${TRUSTED_GITHUB_OWNERS.join(' or ')}`,
    );

  if (tmux('has-session', '-t', `=${session}`).status === 0)
    fail(
      `tmux session ${session} is already running: tmux attach -t ${session}`,
    );

  const started = tmux(
    'new-session',
    '-d',
    '-s',
    session,
    '-c',
    path,
    'claude',
    ...claudeArgs,
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
    url
      ? `  ${url}`
      : '  no session URL on screen yet: look for it in the Claude app, or run tmux attach to check remote control is on',
  );
  console.log(`  stop it with: tmux kill-session -t ${session}`);
};

const [name, mode, modeArg] = process.argv.slice(2);
if (!name)
  fail('usage: start.mts <folder> [list [count] | resume <session-id>]');
const path = resolveFolder(name);
// tmux turns "." in a session name into "_", so the name it prints matches the one used here.
const tmuxName = `cc-${name.replaceAll('.', '_')}`;

if (mode === undefined) startInTmux(path, name, tmuxName, []);
else if (mode === 'list') listSessions(path, modeArg);
else if (mode === 'resume') {
  const id = modeArg ?? fail('resume needs a session id: run list first');
  if (
    !SESSION_ID.test(id) ||
    !existsSync(join(sessionsDir(path), `${id}.jsonl`))
  )
    fail(`${id} is not a session recorded for ${path}: run list first`);
  startInTmux(path, name, `${tmuxName}-${id.slice(0, 8)}`, ['--resume', id]);
} else fail(`unknown mode "${mode}": use list or resume`);
