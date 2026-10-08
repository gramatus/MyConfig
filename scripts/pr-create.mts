#!/usr/bin/env node
// Pushes a stack branch, opens its PR from the /pr-summary files and appends it to the GitHub stack below it.
// Usage: pr-create <branch> <base>

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [branch, base] = process.argv.slice(2);
if (!branch || !base) {
  console.error('Usage: pr-create <branch> <base>');
  process.exit(2);
}

const fail = (message: string): never => {
  console.error(`\n✗ ABORTED: ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: string[], input?: string) => {
  console.error(`$ ${command} ${args.join(' ')}`);
  try {
    return execFileSync(command, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return fail(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
};

type PullRequestStack = { number: number; size: number; position: number } | null;
type PullRequest = { number: number; base: { ref: string }; stack?: PullRequestStack };

const repoRoot = run('git', ['rev-parse', '--show-toplevel']);
const repoSlug = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
const defaultBranch = run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);

const openPullRequestNumber = (head: string) => {
  const numbers = run('gh', ['pr', 'list', '--head', head, '--state', 'open', '--json', 'number', '--jq', '.[].number']);
  return numbers ? Number(numbers.split('\n')[0]) : undefined;
};

const existingNumber = openPullRequestNumber(branch);
if (existingNumber) fail(`${branch} already has an open PR, #${existingNumber}.`);

let stackCall: { path: string; pullRequests: number[] } | undefined;
if (base !== defaultBranch) {
  const belowNumber = openPullRequestNumber(base) ?? fail(`${base} has no open PR, so there is no stack to add ${branch} to.`);
  const below: PullRequest = JSON.parse(run('gh', ['api', `repos/${repoSlug}/pulls/${belowNumber}`]));
  if (below.stack) {
    if (below.stack.position !== below.stack.size) {
      fail(`#${belowNumber} (${base}) is PR ${below.stack.position} of ${below.stack.size} in stack #${below.stack.number}, not its tip.`);
    }
    stackCall = { path: `repos/${repoSlug}/stacks/${below.stack.number}/add`, pullRequests: [] };
  } else if (below.base.ref === defaultBranch) {
    stackCall = { path: `repos/${repoSlug}/stacks`, pullRequests: [belowNumber] };
  } else {
    fail(`#${belowNumber} (${base}) is in no stack and targets ${below.base.ref}, so ${branch} cannot start a new one.`);
  }
}

const summaryDir = join(repoRoot, '.agent-context', 'localhistory');
const branchSlug = branch.replaceAll('/', '-');
const firstExisting = (...names: string[]) => names.map((name) => join(summaryDir, name)).find((path) => existsSync(path));
const blurbPath =
  firstExisting(`PR-SUMMARY-SIMPLE-NO-${branchSlug}.md`, `PR-SUMMARY-SIMPLE-${branchSlug}.md`) ??
  fail(`no PR-SUMMARY-SIMPLE-${branchSlug}.md in ${summaryDir}; run /pr-summary first.`);
const reviewerPath = firstExisting(`PR-SUMMARY-NO-${branchSlug}.md`, `PR-SUMMARY-${branchSlug}.md`);

const [titleLine, ...bodyLines] = readFileSync(blurbPath, 'utf8').trimStart().split('\n');
if (!titleLine.startsWith('# ')) fail(`${blurbPath} does not start with a "# " title line.`);
const title = titleLine.slice(2).trim();
const body = bodyLines.join('\n').trim();

const push = spawnSync('git', ['push', '-u', 'origin', branch, '--force'], { stdio: 'inherit' });
if (push.status !== 0) fail(`git push of ${branch} failed.`);

const url = run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', '-'], body);
const createdNumber = Number(url.split('/').pop());
console.log(`✓ Created #${createdNumber}: ${url}`);

if (stackCall) {
  const pullRequests = [...stackCall.pullRequests, createdNumber];
  const stackNumber = run('gh', ['api', '--method', 'POST', stackCall.path, '--input', '-', '--jq', '.number'], JSON.stringify({ pull_requests: pullRequests }));
  console.log(`✓ #${createdNumber} is the tip of stack #${stackNumber}`);
}

if (reviewerPath) {
  run('gh', ['pr', 'comment', String(createdNumber), '--body-file', reviewerPath]);
  console.log(`✓ Posted ${reviewerPath} as the first comment`);
}
