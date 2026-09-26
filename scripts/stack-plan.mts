#!/usr/bin/env node
// Tags each commit waiting on the current branch with its stack branch, as notes on refs/notes/target.
// Usage: stack-plan export|apply|verify [--base <ref>] [--dry-run]

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const NOTES_REF = 'refs/notes/target';
const UNTAGGED_MARKER = '# ---- untagged: move each line above the update-ref of its branch ----';
const PRE_REBASE_PREFIX = '# pre-rebase: ';

const shellQuote = (arg: string) => (/^[\w@%+=:,./^-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

const git = (...args: string[]) => {
  console.error(`$ git ${args.map(shellQuote).join(' ')}`);
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
};

const [command, ...rest] = process.argv.slice(2);
const optionValue = (name: string) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const base = optionValue('--base') ?? 'origin/main';
const dryRun = rest.includes('--dry-run');

type Commit = { sha: string; subject: string; branches: string[]; note: string };

const repoRoot = () => git('rev-parse', '--show-toplevel').trim();
const planPath = () => join(repoRoot(), '.agent-context/active-work-context/stackplan.txt');
const currentBranch = () => git('symbolic-ref', '--short', 'HEAD').trim();
const tipOf = (ref: string) => git('rev-parse', ref).trim();

const isAncestor = (ancestor: string, descendant: string) => {
  try {
    git('merge-base', '--is-ancestor', ancestor, descendant);
    return true;
  } catch {
    return false;
  }
};

const recordTip = (sha: string) => {
  const lines = readFileSync(planPath(), 'utf8').split('\n');
  const updated = lines.map((line) => (line.startsWith(PRE_REBASE_PREFIX) ? `${PRE_REBASE_PREFIX}${sha}` : line));
  writeFileSync(planPath(), updated.join('\n'));
};

const recordedTip = () => {
  const header = readFileSync(planPath(), 'utf8')
    .split('\n')
    .find((line) => line.startsWith(PRE_REBASE_PREFIX));
  if (!header) throw new Error(`No "${PRE_REBASE_PREFIX.trim()}" line in the plan; export again`);
  return header.slice(PRE_REBASE_PREFIX.length).trim();
};

// Stack branches bottom to top, and the commits above the topmost one that still wait to move.
const readStack = (wip: string) => {
  const records = git(
    'log',
    '--reverse',
    '--first-parent',
    `--notes=${NOTES_REF}`,
    '--decorate-refs=refs/heads/',
    '--format=%H%x1f%s%x1f%D%x1f%N%x1e',
    `${base}..${wip}`,
  )
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean);
  const line: Commit[] = records.map((record) => {
    const [sha, subject, refs, note] = record.split('\x1f');
    const branches = refs ? refs.split(', ').map((ref) => ref.replace(/^HEAD -> /, '')) : [];
    return { sha, subject, branches: branches.filter((branch) => branch !== wip), note: note?.trim() ?? '' };
  });
  const topIndex = line.findLastIndex((commit) => commit.branches.length > 0);
  return { branches: line.flatMap((commit) => commit.branches), pending: line.slice(topIndex + 1) };
};

const pickLine = (commit: Commit) => `pick ${commit.sha.slice(0, 10)} ${commit.subject}`;

const exportPlan = () => {
  const wip = currentBranch();
  const { branches, pending } = readStack(wip);
  const sections = new Map<string, Commit[]>([...branches, wip].map((branch) => [branch, []]));
  const untagged: Commit[] = [];
  for (const commit of pending) {
    const section = sections.get(commit.note);
    if (section) section.push(commit);
    else {
      if (commit.note) console.error(`note "${commit.note}" on ${commit.sha.slice(0, 10)} names no stack branch`);
      untagged.push(commit);
    }
  }

  const out = [
    `# stack-plan for ${wip} on ${base}, exported ${new Date().toISOString()}`,
    `${PRE_REBASE_PREFIX}${tipOf(wip)}`,
    '# A pick belongs to the first update-ref below it. Picks between the last update-ref and',
    `# the untagged marker stay on ${wip}. Move pick lines only, then run: stack-plan apply`,
    '',
  ];
  for (const branch of branches) {
    out.push(...sections.get(branch)!.map(pickLine), `update-ref refs/heads/${branch}`);
  }
  out.push(...sections.get(wip)!.map(pickLine), UNTAGGED_MARKER, ...untagged.map(pickLine), '');

  const path = planPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, out.join('\n'));
  console.log(`Wrote ${path}: ${pending.length} commits, ${untagged.length} untagged, ${branches.length} stack branches`);
};

const applyPlan = () => {
  const wip = currentBranch();
  const { branches, pending } = readStack(wip);
  const errors: string[] = [];
  const targets = new Map<string, string | undefined>();
  const listed = new Set<string>();
  const updateRefs: string[] = [];
  let held: string[] = [];
  let pastMarker = false;

  readFileSync(planPath(), 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim();
      const where = `line ${index + 1}`;
      if (line === UNTAGGED_MARKER) {
        for (const sha of held) targets.set(sha, wip);
        held = [];
        pastMarker = true;
        return;
      }
      if (!line || line.startsWith('#')) return;
      const [verb, arg = ''] = line.split(/\s+/);
      if (verb === 'update-ref') {
        if (pastMarker) errors.push(`${where}: update-ref below the untagged marker`);
        const branch = arg.replace(/^refs\/heads\//, '');
        updateRefs.push(branch);
        for (const sha of held) targets.set(sha, branch);
        held = [];
      } else if (verb === 'pick' || verb === 'p') {
        const commit = pending.find((candidate) => candidate.sha.startsWith(arg));
        if (!commit) errors.push(`${where}: ${arg} is not waiting on ${wip}; export again`);
        else if (listed.has(commit.sha)) errors.push(`${where}: ${arg} is listed twice`);
        else {
          listed.add(commit.sha);
          if (pastMarker) targets.set(commit.sha, undefined);
          else held.push(commit.sha);
        }
      } else errors.push(`${where}: expected pick or update-ref, got "${verb}"`);
    });

  if (!pastMarker) errors.push('the untagged marker line is missing');
  const recorded = recordedTip();
  const current = tipOf(wip);
  // Commits added on top since export are fine; a rewritten wip means the file's SHAs are gone.
  const addedSinceExport = new Set<string>();
  if (recorded !== current) {
    if (isAncestor(recorded, current)) {
      for (const sha of git('rev-list', '--first-parent', `${recorded}..${current}`).split('\n')) {
        if (sha) addedSinceExport.add(sha);
      }
    } else errors.push(`${wip} was rewritten since export (was ${recorded.slice(0, 10)}); export again`);
  }
  if (updateRefs.join('\n') !== branches.join('\n')) {
    errors.push('the update-ref lines no longer match the stack; export again');
  }
  for (const commit of pending) {
    if (!listed.has(commit.sha) && !addedSinceExport.has(commit.sha)) {
      errors.push(`${commit.sha.slice(0, 10)} is missing from the plan: ${commit.subject}`);
    }
  }
  if (errors.length) {
    console.error(`No notes written.\n${errors.join('\n')}`);
    process.exit(1);
  }

  let changed = 0;
  for (const commit of pending) {
    if (!listed.has(commit.sha)) continue;
    const want = targets.get(commit.sha);
    if ((want ?? '') === commit.note) continue;
    changed++;
    const label = `${commit.sha.slice(0, 10)} ${commit.subject}`;
    if (want) {
      console.log(`${dryRun ? 'would tag' : 'tag'} ${want.padEnd(40)} ${label}`);
      if (!dryRun) git('notes', `--ref=${NOTES_REF}`, 'add', '-f', '-m', want, commit.sha);
    } else {
      console.log(`${dryRun ? 'would untag' : 'untag'} ${label}`);
      if (!dryRun) git('notes', `--ref=${NOTES_REF}`, 'remove', commit.sha);
    }
  }
  console.log(changed ? `${changed} notes ${dryRun ? 'would change' : 'changed'}` : 'Notes already match the plan');

  const unplaced = pending.filter((commit) => addedSinceExport.has(commit.sha) && !listed.has(commit.sha));
  if (unplaced.length) {
    console.log(`Left untagged, committed after export:`);
    for (const commit of unplaced) console.log(`  ${commit.sha.slice(0, 10)} ${commit.subject}`);
  }
  if (current !== recorded) {
    if (!dryRun) recordTip(current);
    console.log(`${dryRun ? 'Would record' : 'Recorded'} ${current.slice(0, 10)} as the pre-rebase tip`);
  }
};

// A pure reorder keeps the tip's tree and every patch, so any difference here is worth reading.
const verifyRebase = () => {
  const wip = currentBranch();
  const recorded = recordedTip();
  const short = recorded.slice(0, 10);

  const stat = git('diff', '--stat', recorded, wip).trimEnd();
  if (stat) {
    console.log(`Tree differs from the pre-rebase tip ${short}:\n${stat}`);
    console.log(`To put the pre-rebase tree back as uncommitted changes:\n  git restore --source=${short} --staged --worktree :/`);
  } else console.log(`Tree matches the pre-rebase tip ${short}.`);

  // Header lines look like "12:  abc1234 = 14:  def5678 subject"; = means the patch is unchanged.
  const header = /^\s*(?:\d+|-):\s+\S+\s+([=!<>])\s+(?:\d+|-):\s+\S+/;
  const counts: Record<string, number> = { '=': 0, '!': 0, '<': 0, '>': 0 };
  const shown: string[] = [];
  let showing = false;
  for (const line of git('range-diff', '--no-color', `${base}..${recorded}`, `${base}..${wip}`).split('\n')) {
    const match = header.exec(line);
    if (match) {
      counts[match[1]]++;
      showing = match[1] !== '=';
    }
    if (showing) shown.push(line);
  }
  console.log(`\nrange-diff: ${counts['=']} unchanged, ${counts['!']} changed, ${counts['<']} dropped, ${counts['>']} added`);
  if (shown.length) console.log(shown.join('\n'));
};

try {
  if (command === 'export') exportPlan();
  else if (command === 'apply') applyPlan();
  else if (command === 'verify') verifyRebase();
  else {
    console.error('Usage: stack-plan export|apply|verify [--base <ref>] [--dry-run]');
    process.exit(2);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
