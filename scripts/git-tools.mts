#!/usr/bin/env node
// Small git helpers for working in a stack of branches.
// Usage: git-tools branch-of|stack|tips|sync-check [-b <ref>]; run without arguments for details.

import { execFileSync } from 'node:child_process';

// Colour only a terminal, and never when NO_COLOR is set (https://no-color.org).
const colourOn = (stream: NodeJS.WriteStream) => !process.env.NO_COLOR && stream.isTTY === true;
const style =
  (code: string, stream: NodeJS.WriteStream = process.stdout) =>
  (text: string) =>
    colourOn(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = style('1');
const cyan = style('36');
const yellow = style('33');
const green = style('32');
const dimErr = style('2', process.stderr);
const redErr = style('31', process.stderr);

const heading = (title: string) => console.log(`\n${bold(`── ${title} ${'─'.repeat(Math.max(3, 46 - title.length))}`)}`);
const red = style('31');
const good = (text: string) => console.log(`${green('✓')} ${text}`);
const attention = (text: string) => console.log(`${yellow('!')} ${text}`);
const bad = (text: string) => console.log(`${red('✗')} ${text}`);
const commitLine = (commit: { sha: string; subject: string }) => `  ${yellow(commit.sha.slice(0, 10))}  ${commit.subject}`;

const shellQuote = (arg: string) => (/^[\w@%+=:,./^-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

const git = (...args: string[]) => {
  if (!UNTRACED_COMMANDS.includes(command)) console.error(dimErr(`$ git ${args.map(shellQuote).join(' ')}`));
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
};

const USAGE = [
  'Usage: git-tools <command> [-b|--base <ref>]',
  '  branch-of (bo) <subject>  find the branch holding each commit in <base>..HEAD whose subject',
  '                            contains <subject>, ignoring case; the words need no quotes',
  '  stack (s)                 list the branches in <base>..HEAD along the first parent, bottom to top',
  '  tips (t)                  show the commit at each branch tip or other ref in <base>..HEAD, newest first',
  '  sync-check (sc)           compare each stack branch with its upstream, or origin/<branch>,',
  '                            as of the last fetch',
  '  -b, --base <ref>          where the search starts, default origin/main',
].join('\n');

const EXPANSIONS: Record<string, string> = { bo: 'branch-of', s: 'stack', t: 'tips', sc: 'sync-check' };
const FLAG_ALIASES: Record<string, string> = { '-b': '--base' };
const ALLOWED_FLAGS: Record<string, string[]> = {
  'branch-of': ['--base'],
  stack: ['--base'],
  tips: ['--base'],
  'sync-check': ['--base'],
};
const TAKES_POSITIONAL = ['branch-of'];
const UNTRACED_COMMANDS = ['sync-check'];

const [given = '', ...args] = process.argv.slice(2);
const command = EXPANSIONS[given] ?? given;

const usageError = (message?: string): never => {
  if (message) console.error(redErr(`✗ ${message}`));
  console.error(USAGE);
  process.exit(2);
};
if (given === '-h' || given === '--help') {
  console.log(USAGE);
  process.exit(0);
}
const allowed = ALLOWED_FLAGS[command] ?? usageError(given ? `unknown command "${given}"` : undefined);
let base = 'origin/main';
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = FLAG_ALIASES[args[i]] ?? args[i];
  if (arg === '--base' && allowed.includes('--base')) base = args[++i] ?? usageError('--base needs a ref');
  else if (arg.startsWith('-') || !TAKES_POSITIONAL.includes(command)) usageError(`${args[i]} does not apply to ${given}`);
  else positional.push(arg);
}

const records = (output: string) =>
  output
    .split('\n')
    .filter(Boolean)
    .map((record) => record.split('\x1f'));

// The branch closest above the commit, or several where they share its tip.
const lowestBranchesContaining = (sha: string) => {
  const candidates = git('for-each-ref', `--contains=${sha}`, '--format=%(refname:short)', 'refs/heads/')
    .split('\n')
    .filter(Boolean);
  const distance = new Map(candidates.map((branch) => [branch, Number(git('rev-list', '--count', `${sha}..${branch}`))]));
  const closest = Math.min(...distance.values());
  return candidates.filter((branch) => distance.get(branch) === closest);
};

const branchOf = (query: string) => {
  const wanted = query.toLowerCase();
  const matches = records(git('log', '--format=%H%x1f%s', `${base}..HEAD`))
    .map(([sha, subject]) => ({ sha, subject }))
    .filter((commit) => commit.subject.toLowerCase().includes(wanted));
  heading(`Branch of "${query}"`);
  if (!matches.length) throw new Error(`no commit in ${base}..HEAD has a subject containing "${query}"`);
  for (const commit of matches) {
    console.log(commitLine(commit));
    const branches = lowestBranchesContaining(commit.sha);
    console.log(`    ${branches.length ? branches.map(cyan).join(', ') : 'on no branch'}`);
  }
  good(`${matches.length} matching commit${matches.length === 1 ? '' : 's'}`);
};

// Bottom to top, one entry per commit that has branches on it.
const stackLevels = () =>
  git('log', '--first-parent', '--simplify-by-decoration', '--decorate-refs=refs/heads/', '--reverse', '--format=%D', `${base}..HEAD`)
    .split('\n')
    .filter(Boolean)
    .map((refs) => refs.replace(/^HEAD -> /, '').split(', '));

const listStack = () => {
  const levels = stackLevels();
  heading(`Stack on ${base}, bottom to top`);
  for (const [index, branches] of levels.entries()) {
    console.log(`  ${String(index + 1).padStart(2)}  ${cyan(branches.join(', '))}`);
  }
  good(`${levels.length} level${levels.length === 1 ? '' : 's'}`);
};

const refExists = (ref: string) => {
  try {
    git('rev-parse', '--verify', '--quiet', ref);
    return true;
  } catch {
    return false;
  }
};

const checkSync = () => {
  const branches = stackLevels().flat();
  const upstreams = records(git('for-each-ref', '--format=%(refname:short)%x1f%(upstream:short)', 'refs/heads/'));
  const upstreamOf = new Map(upstreams.map(([branch, upstream]) => [branch, upstream]));
  heading(`Stack on ${base} against origin, bottom to top`);
  let outOfSync = 0;
  for (const branch of branches) {
    const remote = upstreamOf.get(branch) || `origin/${branch}`;
    const name = `${cyan(branch)}  ${remote}`;
    if (!refExists(remote)) {
      outOfSync++;
      attention(`${name}  not on the remote`);
      continue;
    }
    const [ahead, behind] = git('rev-list', '--left-right', '--count', `${branch}...${remote}`).trim().split(/\s+/).map(Number);
    if (!ahead && !behind) good(`${name}  in sync`);
    else if (ahead && behind) bad(`${name}  diverged: ${ahead} ahead, ${behind} behind; a rebased branch needs a force push`);
    else if (ahead) attention(`${name}  ${ahead} ahead; push`);
    else attention(`${name}  ${behind} behind; pull`);
    if (ahead || behind) outOfSync++;
  }
  if (!outOfSync) {
    good(`all ${branches.length} branches in sync with the remote`);
    return;
  }
  bad(`${outOfSync} of ${branches.length} branches out of sync with the remote`);
  process.exit(1);
};

const listTips = () => {
  const tips = records(git('log', '--simplify-by-decoration', '--format=%H%x1f%s%x1f%D', `${base}..HEAD`));
  heading(`Tips in ${base}..HEAD, newest first`);
  for (const [sha, subject, refs] of tips) console.log(`${commitLine({ sha, subject })}  ${cyan(`(${refs})`)}`);
  good(`${tips.length} tip${tips.length === 1 ? '' : 's'}`);
};

try {
  if (command === 'branch-of') {
    if (!positional.length) usageError('branch-of needs part of a commit subject');
    branchOf(positional.join(' '));
  } else if (command === 'stack') listStack();
  else if (command === 'tips') listTips();
  else if (command === 'sync-check') checkSync();
} catch (error) {
  console.error(redErr(`✗ ${(error as Error).message}`));
  process.exit(1);
}
