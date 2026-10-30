// Throwaway git repositories for stack-plan's tests, sealed off from the user's own git setup.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./stack-plan.mts', import.meta.url));

export type Run = { status: number | null; stdout: string; stderr: string };

/** A row of `gh pr list --json`, with the fields stack-plan asks for. */
export type PullRequestRow = {
  number: number;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergedAt: string;
  mergeCommit: { oid: string } | null;
};

export type Repo = {
  dir: string;
  git: (...args: string[]) => string;
  /** Commits `files` on HEAD and returns the new commit's SHA. */
  commit: (subject: string, files: Record<string, string>) => string;
  stackPlan: (...args: string[]) => Run;
  /** Adds a bare repository as origin, which makes stack-plan ask gh for PRs. */
  addOrigin: () => void;
  /** What the gh stub lists for `gh pr list --state <state>`; a state never set lists none. */
  setPullRequests: (state: 'open' | 'merged', rows: PullRequestRow[]) => void;
};

const GH_STUB = `#!/bin/sh
state=
while [ $# -gt 0 ]; do
  if [ "$1" = --state ]; then state=$2; fi
  shift
done
cat "$GH_STUB_DIR/$state.json" 2>/dev/null || echo '[]'
`;

export const makeRepo = (t: TestContext): Repo => {
  const root = mkdtempSync(join(tmpdir(), 'stack-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const dir = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(dir);
  const key = join(home, 'signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  // The settings install.sh makes global, plus a signing key, since extract signs every commit it writes.
  writeFileSync(
    join(home, '.gitconfig'),
    [
      '[user]',
      '  name = Test',
      '  email = test@example.com',
      `  signingkey = ${key}`,
      '[gpg]',
      '  format = ssh',
      '[init]',
      '  defaultBranch = main',
      '[notes]',
      '  rewriteRef = refs/notes/target',
      '[rebase]',
      '  updateRefs = true',
      '  missingCommitsCheck = error',
      '',
    ].join('\n'),
  );
  const bin = join(root, 'bin');
  const pulls = join(root, 'pulls');
  mkdirSync(bin);
  mkdirSync(pulls);
  writeFileSync(join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GH_STUB_DIR: pulls,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    NO_COLOR: '1',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  git('init', '-q');
  writeFileSync(join(dir, '.git/info/exclude'), '.agent-context/\n');
  const commit = (subject: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD').trim();
  };
  const stackPlan = (...args: string[]) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const addOrigin = () => {
    const origin = join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin], { env });
    git('remote', 'add', 'origin', origin);
  };
  const setPullRequests = (state: 'open' | 'merged', rows: PullRequestRow[]) =>
    writeFileSync(join(pulls, `${state}.json`), JSON.stringify(rows));
  return { dir, git, commit, stackPlan, addOrigin, setPullRequests };
};

export type Layer = {
  branch: string;
  subject: string;
  files: Record<string, string>;
};

/** Commits `initial` on main, then one commit per layer on wip, bottom first, each with its branch, and a wip commit on top. */
export const buildStack = (repo: Repo, layers: Layer[]) => {
  repo.commit('initial', { 'README.md': 'readme\n' });
  repo.git('checkout', '-q', '-b', 'wip');
  for (const { branch, subject, files } of layers) {
    repo.commit(subject, files);
    repo.git('branch', branch);
  }
  repo.commit('wip notes', { 'notes.txt': 'notes\n' });
};

/** Adds a commit on top of `branch`, then replays the one-commit layers `above` it and wip's commit onto it. */
export const addToLayer = (
  repo: Repo,
  branch: string,
  above: string[],
  subject: string,
  files: Record<string, string>,
) => {
  const replayed = [...above, 'wip'].map((ref) =>
    repo.git('rev-parse', ref).trim(),
  );
  repo.git('checkout', '-q', '--detach', branch);
  repo.commit(subject, files);
  repo.git('branch', '-f', branch, 'HEAD');
  replayed.forEach((sha, i) => {
    repo.git('cherry-pick', sha);
    if (i < above.length) repo.git('branch', '-f', above[i], 'HEAD');
  });
  repo.git('checkout', '-q', '-B', 'wip');
};

/** Commits on main, as a squash merge of a PR would, and goes back to wip. */
export const landOnMain = (
  repo: Repo,
  subject: string,
  files: Record<string, string>,
) => {
  repo.git('checkout', '-q', 'main');
  repo.commit(subject, files);
  repo.git('checkout', '-q', 'wip');
};

export const planPath = (repo: Repo) =>
  join(repo.dir, '.agent-context/active-work-context/stackplan.txt');

/** Exports the plan, then rewrites its lines with `edit`, as a person editing stackplan.txt would. */
export const editPlan = (repo: Repo, edit: (lines: string[]) => string[]) => {
  const exported = repo.stackPlan('export', '-b', 'main');
  assert.equal(exported.status, 0, `${exported.stdout}\n${exported.stderr}`);
  const lines = readFileSync(planPath(repo), 'utf8').split('\n');
  writeFileSync(planPath(repo), edit(lines).join('\n'));
};

export const isPickOf = (sha: string) => (line: string) =>
  line.startsWith(`pick ${sha.slice(0, 7)}`);

/** Puts `line` right above the line `target` matches, taking it out of where it was if it was there. */
export const placeAbove = (
  lines: string[],
  line: string,
  target: (line: string) => boolean,
) => {
  const rest = lines.filter((candidate) => candidate !== line);
  rest.splice(rest.findIndex(target), 0, line);
  return rest;
};

export const pickAbove = (sha: string, branch: string) => (lines: string[]) =>
  placeAbove(
    lines,
    lines.find(isPickOf(sha)) ?? `pick ${sha}`,
    (line) => line === `update-ref refs/heads/${branch}`,
  );
