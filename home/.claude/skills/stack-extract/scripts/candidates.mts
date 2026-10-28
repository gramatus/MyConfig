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
  untested: string[];
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

// --upto keeps the branches above the cut out of the chains, so their needs cannot join branches below it.
const fullReport: ExtractableReport = JSON.parse(
  execFileSync(
    'node',
    [
      STACK_PLAN_SCRIPT,
      'extractable',
      '--json',
      '--upto',
      lastReady,
      ...extractableArgs,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  ),
);
// A chain left with only __ members has no candidate in it.
const chains = fullReport.chains.filter(({ members }) =>
  members.some((member) => !member.marked),
);
const { untested: notReady, ...rest } = fullReport;
const report = { ...rest, lastReady, chains, notReady };
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
