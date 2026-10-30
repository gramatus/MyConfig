// Throwaway git repositories for stack-plan's tests, sealed off from the user's own git setup.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./stack-plan.mts', import.meta.url));

export type Run = { status: number | null; stdout: string; stderr: string };

export type Repo = {
  dir: string;
  git: (...args: string[]) => string;
  /** Commits `files` on HEAD and returns the new commit's SHA. */
  commit: (subject: string, files: Record<string, string>) => string;
  stackPlan: (...args: string[]) => Run;
};

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
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    NO_COLOR: '1',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
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
  return { dir, git, commit, stackPlan };
};
