#!/usr/bin/env node
// Saves each extract candidate's own change for the stack-extract skill to read.
// Usage: candidates.mts [--base <ref>]; ../SKILL.md says when to run it.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type Member = {
  name: string;
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

const reportJson = execFileSync(
  'node',
  [STACK_PLAN_SCRIPT, 'extractable', '--json', ...process.argv.slice(2)],
  {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
const report: ExtractableReport = JSON.parse(reportJson);
mkdirSync(resultsPath, { recursive: true });
writeFileSync(join(resultsPath, 'candidates.json'), reportJson);

for (const { moveConflict, members } of report.chains) {
  const names = members.map((member) => member.name).join(' → ');
  if (moveConflict) {
    console.log(`! ${names}: not a candidate, ${moveConflict}`);
    continue;
  }
  for (const { name, start, replay } of members) {
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
console.log(`saved:  ${join(resultsPath, 'candidates.json')}`);
