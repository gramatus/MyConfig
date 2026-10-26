#!/usr/bin/env node
// Saves each extract candidate up to the last ready branch, with its own change, for the stack-extract skill to read.
// Usage: candidates.mts <last-ready-branch> [--base <ref>]; ../SKILL.md says when to run it.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type Member = {
  name: string;
  marked: boolean;
  needs: string[];
  start: string | null;
  replay: string | null;
};
type ExtractableReport = {
  base: string;
  baseSha: string;
  chains: { moveConflict: string | null; members: Member[] }[];
  blocked: { name: string; reason: string }[];
};

const STACK_PLAN_SCRIPT = join(homedir(), 'scripts', 'stack-plan.mts');

const readGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

const mainCheckout = dirname(
  readGit(
    process.cwd(),
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ).trim(),
);
const resultsPath = join(
  mainCheckout,
  '.agent-context',
  '.tmp',
  'stack-extract-results',
);

const fileNameOf = (branch: string) => branch.replaceAll('/', '-');

const [lastReady, ...extractableArgs] = process.argv.slice(2);
if (!lastReady || lastReady.startsWith('-')) {
  console.error('Usage: candidates.mts <last-ready-branch> [--base <ref>]');
  process.exit(2);
}
readGit(mainCheckout, 'rev-parse', '--verify', `refs/heads/${lastReady}`);
// Every branch below the last ready one in the stack is an ancestor of it.
const isReady = (branch: string) => {
  try {
    readGit(mainCheckout, 'merge-base', '--is-ancestor', branch, lastReady);
    return true;
  } catch {
    return false;
  }
};

const fullReport: ExtractableReport = JSON.parse(
  execFileSync(
    'node',
    [STACK_PLAN_SCRIPT, 'extractable', '--json', ...extractableArgs],
    {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  ),
);
// A chain runs in stack order, so cutting it at the first unready member keeps the members that need nothing above the cut.
const notReady: string[] = [];
const chains = fullReport.chains.flatMap((chain) => {
  const cutAt = chain.members.findIndex((member) => !isReady(member.name));
  const members = cutAt < 0 ? chain.members : chain.members.slice(0, cutAt);
  if (cutAt >= 0)
    notReady.push(...chain.members.slice(cutAt).map((member) => member.name));
  // A chain left with only __ members has no candidate in it.
  return members.some((member) => !member.marked)
    ? [{ ...chain, members }]
    : [];
});
const blocked = fullReport.blocked.filter(({ name }) => isReady(name));
notReady.push(
  ...fullReport.blocked
    .filter(({ name }) => !isReady(name))
    .map(({ name }) => name),
);
const report = { ...fullReport, lastReady, chains, blocked, notReady };
mkdirSync(resultsPath, { recursive: true });
writeFileSync(
  join(resultsPath, 'candidates.json'),
  JSON.stringify(report, null, 2),
);

for (const { moveConflict, members } of report.chains) {
  const names = members.map((member) => member.name).join(' → ');
  if (moveConflict) {
    console.log(`! ${names}: not a candidate, ${moveConflict}`);
    continue;
  }
  for (const { name, marked, start, replay } of members) {
    if (marked) {
      console.log(`--- ${name}  marked already`);
      continue;
    }
    if (!start || !replay) {
      console.log(`! ${name}: its chain conflicts on ${report.base} as one`);
      continue;
    }
    const diffPath = join(resultsPath, `${fileNameOf(name)}.diff`);
    writeFileSync(diffPath, readGit(mainCheckout, 'diff', start, replay));
    console.log(`=== ${name}  ${start.slice(0, 10)}..${replay.slice(0, 10)}`);
    console.log(`diff:   ${diffPath}`);
    console.log(readGit(mainCheckout, 'diff', '--stat=200', start, replay));
  }
}
for (const { name, reason } of report.blocked) {
  console.log(`✗ ${name}: cannot leave, ${reason}`);
}
if (notReady.length)
  console.log(`not ready, above ${lastReady}: ${notReady.join(', ')}`);
console.log(`saved:  ${join(resultsPath, 'candidates.json')}`);
