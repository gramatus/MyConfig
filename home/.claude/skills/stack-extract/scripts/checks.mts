#!/usr/bin/env node
// Runs npm scripts at the base and at each candidate's replay commit, and sorts each failure.
// Usage: checks.mts <script>...; run candidates.mts and worktree.mts open first, per ../SKILL.md.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

type Member = { name: string; replay: string | null };
type ExtractableReport = {
  baseSha: string;
  chains: { moveConflict: string | null; members: Member[] }[];
};
type CheckedRef = { name: string; ref: string; below?: string };

const WORKTREE_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'worktree.mts',
);
const BASELINE_NAME = 'baseline';

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

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
const worktreePath = join(
  mainCheckout,
  '.agent-context',
  '.tmp',
  'stack-extract',
);
const resultsPath = join(
  mainCheckout,
  '.agent-context',
  '.tmp',
  'stack-extract-results',
);
const checksPath = join(resultsPath, 'checks');

const fileNameOf = (branch: string) => branch.replaceAll('/', '-');

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

// npm's own failure lines and tsc's totals repeat in every failing run, so they say nothing.
const isErrorLine = (line: string) =>
  /\berror\b/i.test(line) &&
  !/^npm (error|ERR!)/.test(line) &&
  !/^Found \d+ errors?\b/.test(line);

const errorLinesOf = (output: string) =>
  stripAnsi(output).split('\n').filter(isErrorLine);

// Line and column shift between commits, so the comparison leaves them out.
const withoutPosition = (line: string) =>
  line.replace(/\(\d+,\d+\)|:\d+:\d+/g, '').trim();

const MISSING_MODULE =
  /^(?<file>[^\s(:]+)(?:\(\d+,\d+\)|:\d+:\d+).*Cannot find module '(?<spec>[^']+)'/;

const packageNameOf = (spec: string) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');

const isIgnoredByGit = (path: string) =>
  spawnSync('git', ['check-ignore', '--quiet', path], { cwd: mainCheckout })
    .status === 0;

const hasLinkedPackage = (fromFile: string, packageName: string) => {
  for (let dir = dirname(fromFile); ; dir = dirname(dir)) {
    if (existsSync(join(worktreePath, dir, 'node_modules', packageName))) {
      return true;
    }
    if (dir === '.' || dir === dirname(dir)) {
      return false;
    }
  }
};

/** Returns the setup gap behind a missing-module error line, if it has one. */
const setupGapOf = (line: string) => {
  const match = MISSING_MODULE.exec(line)?.groups;
  if (!match) {
    return undefined;
  }
  const { file, spec } = match;
  if (spec.startsWith('.')) {
    const path = normalize(join(dirname(file), spec));
    return isIgnoredByGit(path)
      ? { file, gap: `${path} is ignored by git, so the worktree lacks it` }
      : undefined;
  }
  const packageName = packageNameOf(spec);
  return hasLinkedPackage(file, packageName)
    ? undefined
    : { file, gap: `${packageName} is missing from the linked node_modules` };
};

const fileOf = (line: string) =>
  /^(?<file>[^\s(:]+)(?:\(\d+,\d+\)|:\d+:\d+)/.exec(line)?.groups?.file;

/** Sorts one check's result as a pass, inherited from below, a setup gap or a failure of its own. */
const verdictOf = (
  status: number | null,
  output: string,
  inheritedErrors: Set<string>,
) => {
  if (/Missing script:/.test(output)) {
    return { verdict: 'absent', detail: 'the script does not exist here' };
  }
  if (status === 0) {
    return { verdict: 'pass', detail: '' };
  }
  const errors = errorLinesOf(output);
  const newErrors = errors.filter(
    (line) => !inheritedErrors.has(withoutPosition(line)),
  );
  if (!errors.length) {
    return { verdict: 'fails', detail: `exit ${status}, no error line found` };
  }
  if (!newErrors.length) {
    return { verdict: 'inherited', detail: withoutPosition(errors[0]) };
  }
  const gaps = newErrors.flatMap((line) => setupGapOf(line) ?? []);
  const gapFiles = new Set(gaps.map(({ file }) => file));
  const unexplained = newErrors.filter((line) => {
    const file = fileOf(line);
    return !file || !gapFiles.has(file);
  });
  if (!unexplained.length) {
    return {
      verdict: 'setup gap',
      detail: gaps.map(({ gap }) => gap).join('; '),
    };
  }
  return { verdict: 'fails', detail: unexplained[0].trim() };
};

const scripts = process.argv.slice(2);
if (!scripts.length) {
  fail('usage: checks.mts <script>...');
}
const candidatesPath = join(resultsPath, 'candidates.json');
if (!existsSync(candidatesPath)) {
  fail(`no ${candidatesPath}; run candidates.mts first`);
}
const report: ExtractableReport = JSON.parse(
  readFileSync(candidatesPath, 'utf8'),
);

const checkedRefs: CheckedRef[] = [
  { name: BASELINE_NAME, ref: report.baseSha },
  ...report.chains
    .filter((chain) => !chain.moveConflict)
    .flatMap(({ members }) =>
      members.flatMap(({ name, replay }, at) =>
        replay
          ? [
              {
                name,
                ref: replay,
                below: members[at - 1]?.name ?? BASELINE_NAME,
              },
            ]
          : [],
      ),
    ),
];

mkdirSync(checksPath, { recursive: true });
const errorsAt = new Map<string, Set<string>>();
const refsByLockfileWarning = new Map<string, string[]>();
const summary: string[] = [];
const record = (line: string) => {
  console.log(line);
  summary.push(line);
  writeFileSync(join(checksPath, 'summary.txt'), `${summary.join('\n')}\n`);
};

for (const { name, ref, below } of checkedRefs) {
  const moved = run('node', [WORKTREE_SCRIPT, 'goto', ref]);
  writeFileSync(join(checksPath, `${fileNameOf(name)}.goto.txt`), moved.output);
  if (moved.status !== 0) {
    record(`${name}  goto failed, see ${fileNameOf(name)}.goto.txt`);
    continue;
  }
  for (const warning of moved.output.split('\n')) {
    if (warning.startsWith('! ')) {
      refsByLockfileWarning.set(warning, [
        ...(refsByLockfileWarning.get(warning) ?? []),
        name,
      ]);
    }
  }
  const errorsHere = new Set<string>();
  for (const script of scripts) {
    const result = run('npm', ['--prefix', worktreePath, 'run', script]);
    const outputName = `${fileNameOf(name)}.${script.replaceAll(':', '-')}.txt`;
    writeFileSync(join(checksPath, outputName), result.output);
    for (const line of errorLinesOf(result.output)) {
      errorsHere.add(withoutPosition(line));
    }
    const inheritedErrors = new Set([
      ...(errorsAt.get(BASELINE_NAME) ?? []),
      ...(below ? (errorsAt.get(below) ?? []) : []),
    ]);
    const { verdict, detail } = verdictOf(
      result.status,
      result.output,
      inheritedErrors,
    );
    record(`${name}  ${script}  ${verdict}${detail ? `  ${detail}` : ''}`);
  }
  errorsAt.set(name, errorsHere);
}
for (const [warning, names] of refsByLockfileWarning) {
  const where =
    names.length === checkedRefs.length
      ? 'at every commit checked'
      : `at ${names.join(', ')}`;
  record(`${warning}, ${where}`);
}
console.log(`outputs: ${checksPath}`);
