#!/usr/bin/env node
// Moves commits waiting on the current branch into stack branches, and reorders or adds those branches.
// Usage: stack-plan export|go|preview|apply|rebase|verify [-b <ref>] [-n] [-f]; run without arguments for details.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const NOTES_REF = 'refs/notes/target';
const UNTAGGED_MARKER = '# ---- untagged: move each line above the update-ref of its branch ----';
const EXPORTED_AT_PREFIX = '# exported-at: ';
const PRE_REBASE_PREFIX = '# pre-rebase: ';
const MOVED_MARKER = '>>> [moved]';
const MOVED_BRANCH_MARKER = '>>> [moved branch]';
const NEW_BRANCH_MARKER = '>>> [new branch]';
const ORDER_KEY = 'stackplan.order';
const NEW_KEY = 'stackplan.new';

// Colour only a terminal, and never when NO_COLOR is set (https://no-color.org).
const colourOn = (stream: NodeJS.WriteStream) => !process.env.NO_COLOR && stream.isTTY === true;
const style =
  (code: string, stream: NodeJS.WriteStream = process.stdout) =>
  (text: string) =>
    colourOn(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;
const stripColour = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
const bold = style('1');
const cyan = style('36');
const yellow = style('33');
const green = style('32');
const red = style('31');
const dimErr = style('2', process.stderr);
const redErr = style('31', process.stderr);

const heading = (title: string) => console.log(`\n${bold(`── ${title} ${'─'.repeat(Math.max(3, 46 - title.length))}`)}`);
const subheading = (title: string) => console.log(`\n${bold(`────── ${title} ${'─'.repeat(Math.max(3, 42 - title.length))}`)}`);
const good = (text: string) => console.log(`${green('✓')} ${text}`);
const attention = (text: string) => console.log(`${yellow('!')} ${text}`);
const bad = (text: string) => console.log(`${red('✗')} ${text}`);
const commitLine = (commit: { sha: string; subject: string }) => `  ${yellow(commit.sha.slice(0, 10))}  ${commit.subject}`;

const shellQuote = (arg: string) => (/^[\w@%+=:,./^-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

const traceGit = (args: string[]) => console.error(dimErr(`$ git ${args.map(shellQuote).join(' ')}`));

const git = (...args: string[]) => {
  traceGit(args);
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
};

const USAGE = [
  'Usage: stack-plan <command> [-b|--base <ref>] [-n|--dry-run] [-f|--anyway]',
  '  export (e)   write the plan file',
  '  go           apply, then rebase',
  '  preview      apply and rebase as a dry run',
  '  apply (a)    write notes from the plan; --rebase also rebases',
  '  rebase (r)   rebase the stack; -f runs it despite a predicted conflict',
  '  verify (v)   compare the stack with the pre-rebase tip',
].join('\n');

const EXPANSIONS: Record<string, string[]> = {
  e: ['export'],
  a: ['apply'],
  r: ['rebase'],
  v: ['verify'],
  go: ['apply', '--rebase'],
  preview: ['apply', '--rebase', '--dry-run'],
};
const FLAG_ALIASES: Record<string, string> = { '-b': '--base', '-n': '--dry-run', '-f': '--anyway' };
const ALLOWED_FLAGS: Record<string, string[]> = {
  export: ['--base'],
  apply: ['--base', '--dry-run', '--rebase', '--anyway'],
  rebase: ['--base', '--dry-run', '--anyway'],
  verify: ['--base', '--dry-run'],
};

const [given = '', ...args] = process.argv.slice(2);
const [command, ...implied] = EXPANSIONS[given] ?? [given];
const rest = [...implied, ...args.map((arg) => FLAG_ALIASES[arg] ?? arg)];

const usageError = (message?: string): never => {
  if (message) console.error(redErr(`✗ ${message}`));
  console.error(USAGE);
  process.exit(2);
};
if (command !== '_todo') {
  const allowed = ALLOWED_FLAGS[command] ?? usageError(given ? `unknown command "${given}"` : undefined);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--base') i++;
    else if (!allowed.includes(rest[i])) usageError(`${rest[i]} does not apply to ${given}`);
  }
}

const optionValue = (name: string) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const base = optionValue('--base') ?? 'origin/main';
const dryRun = rest.includes('--dry-run');

type Commit = { sha: string; subject: string; branches: string[]; note: string };

let root: string | undefined;
const repoRoot = () => (root ??= git('rev-parse', '--show-toplevel').trim());
const planPath = () => join(repoRoot(), '.agent-context/active-work-context/stackplan.txt');
const currentBranch = () => git('symbolic-ref', '--short', 'HEAD').trim();
const tipOf = (ref: string) => git('rev-parse', ref).trim();

const gitSucceeds = (...args: string[]) => {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
};
const isAncestor = (ancestor: string, descendant: string) => gitSucceeds('merge-base', '--is-ancestor', ancestor, descendant);
const branchExists = (branch: string) => gitSucceeds('show-ref', '--verify', '--quiet', `refs/heads/${branch}`);

const words = (value: string) => value.split(/\s+/).filter(Boolean);
const readConfig = (key: string) => {
  try {
    return git('config', '--get', key).trim();
  } catch {
    return '';
  }
};

// The order apply saved, while it still covers the stack; a missing branch counts only while it waits to be created.
const desiredOrder = (current: string[]) => {
  const waiting = words(readConfig(NEW_KEY));
  const stored = words(readConfig(ORDER_KEY)).filter((branch) => current.includes(branch) || waiting.includes(branch));
  return current.every((branch) => stored.includes(branch)) ? stored : current;
};

// The fewest branches that count as moved: those outside the longest run that keeps its relative order.
const movedBranches = (current: string[], order: string[]) => {
  const existing = order.filter((branch) => current.includes(branch));
  const positions = existing.map((branch) => current.indexOf(branch));
  const run = positions.map(() => 1);
  const previous = positions.map(() => -1);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < i; j++) {
      if (positions[j] < positions[i] && run[j] + 1 > run[i]) {
        run[i] = run[j] + 1;
        previous[i] = j;
      }
    }
  }
  const kept = new Set<string>();
  for (let i = run.indexOf(Math.max(0, ...run)); i >= 0; i = previous[i]) kept.add(existing[i]);
  return existing.filter((branch) => !kept.has(branch));
};

const readHeader = (prefix: string) =>
  readFileSync(planPath(), 'utf8')
    .split('\n')
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();

const requireHeader = (prefix: string, remedy: string) => {
  const value = readHeader(prefix);
  if (!value) throw new Error(`No "${prefix.trim()}" line in the plan; ${remedy}`);
  return value;
};

const writeHeader = (prefix: string, sha: string) => {
  const lines = readFileSync(planPath(), 'utf8').split('\n');
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) lines[index] = `${prefix}${sha}`;
  else lines.splice(1, 0, `${prefix}${sha}`);
  writeFileSync(planPath(), lines.join('\n'));
};

// Newest first, one line per rebase, so the SHA to go back to is at the top.
const logPreRebase = (sha: string) => {
  const path = join(dirname(planPath()), 'stackplan-rebases.log');
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${two(now.getFullYear() % 100)}${two(now.getMonth() + 1)}${two(now.getDate())} ${two(now.getHours())}${two(now.getMinutes())}`;
  const earlier = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, `[${stamp}] ${sha}\n${earlier}`);
};

// Stack branches bottom to top, each one's own commits, and the commits above the topmost one that still wait to move.
const readStack = (wip: string) => {
  const stored = words(readConfig(ORDER_KEY));
  // Branches sharing a commit have no order in git, so the saved order decides.
  const rank = (branch: string) => (stored.includes(branch) ? stored.indexOf(branch) : stored.length);
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
    const stack = branches.filter((branch) => branch !== wip).sort((a, b) => rank(a) - rank(b));
    return { sha, subject, branches: stack, note: note?.trim() ?? '' };
  });
  const topIndex = line.findLastIndex((commit) => commit.branches.length > 0);
  const own = new Map<string, Commit[]>();
  let segment: Commit[] = [];
  for (const commit of line.slice(0, topIndex + 1)) {
    segment.push(commit);
    for (const branch of commit.branches) {
      own.set(branch, segment);
      segment = [];
    }
  }
  return { line, branches: line.flatMap((commit) => commit.branches), pending: line.slice(topIndex + 1), own };
};

const printOrderChanges = (current: string[], order: string[]) => {
  const below = (branch: string) => order[order.indexOf(branch) - 1] ?? base;
  for (const branch of order.filter((name) => !current.includes(name))) console.log(`${cyan(branch)}  new, above ${below(branch)}`);
  for (const branch of movedBranches(current, order)) console.log(`${cyan(branch)}  moves above ${below(branch)}`);
};

// For loops of hundreds of calls, where echoing each one would bury the output.
const gitQuiet = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

type Simulation =
  | { ok: true; picks: number; sameTree: boolean }
  | { ok: false; picks: number; at: number; commit: Commit; files: string[] };

// Replays the planned picks in memory: objects are written, no ref moves, and the worktree is untouched.
const simulateRebase = (sequence: Commit[], start: string, wip: string): Simulation => {
  console.error(dimErr(`$ git merge-tree --write-tree --name-only --merge-base=<pick>^ <state> <pick>    (per pick)`));
  console.error(dimErr(`$ git commit-tree <tree> -p <state> -m 'stack-plan preview' --no-gpg-sign  (per pick)`));
  let state = start;
  for (const [index, commit] of sequence.entries()) {
    let merged: string;
    try {
      merged = gitQuiet('merge-tree', '--write-tree', '--name-only', `--merge-base=${commit.sha}^`, state, commit.sha);
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      if (failure.status !== 1) throw error;
      const listed = (failure.stdout ?? '').split('\n').slice(1);
      const files = [...new Set(listed.slice(0, Math.max(0, listed.indexOf(''))))];
      return { ok: false, picks: sequence.length, at: index, commit, files };
    }
    const tree = merged.split('\n')[0];
    state = gitQuiet('commit-tree', tree, '-p', state, '-m', 'stack-plan preview', '--no-gpg-sign').trim();
  }
  const treeOf = (ref: string) => gitQuiet('rev-parse', `${ref}^{tree}`).trim();
  return { ok: true, picks: sequence.length, sameTree: treeOf(state) === treeOf(wip) };
};

// Prints commits under their branch, in stack order.
const printByBranch = (order: string[], branchOf: (commit: Commit) => string, commits: Commit[], label = cyan) => {
  for (const branch of order) {
    const group = commits.filter((commit) => branchOf(commit) === branch);
    if (!group.length) continue;
    console.log(label(branch));
    for (const commit of group) console.log(commitLine(commit));
  }
};

const pickLine = (commit: Commit) => `pick ${commit.sha.slice(0, 10)} ${commit.subject}`;

const exportPlan = () => {
  const wip = currentBranch();
  const { branches: current, pending } = readStack(wip);
  // An order applied but not yet rebased is exported as planned, like the notes are.
  const branches = desiredOrder(current);
  const sections = new Map<string, Commit[]>([...branches, wip].map((branch) => [branch, []]));
  const untagged: Commit[] = [];
  const strayNotes: Commit[] = [];
  for (const commit of pending) {
    const section = sections.get(commit.note);
    if (section) section.push(commit);
    else {
      if (commit.note) strayNotes.push(commit);
      untagged.push(commit);
    }
  }

  // The pre-rebase tip belongs to the last rebase, not to this export, so it carries over.
  const lastPreRebase = existsSync(planPath()) ? readHeader(PRE_REBASE_PREFIX) : undefined;
  const out = [
    `# stack-plan for ${wip} on ${base}, exported ${new Date().toISOString()}`,
    `${EXPORTED_AT_PREFIX}${tipOf(wip)}`,
    ...(lastPreRebase ? [`${PRE_REBASE_PREFIX}${lastPreRebase}`] : []),
    '# A pick belongs to the first update-ref below it. Picks between the last update-ref and',
    `# the untagged marker stay on ${wip}. Move picks, reorder update-refs or add one for a`,
    '# new branch, then run: stack-plan apply',
    '',
  ];
  for (const branch of branches) {
    out.push(...sections.get(branch)!.map(pickLine), `update-ref refs/heads/${branch}\n`);
  }
  out.push(...sections.get(wip)!.map(pickLine), UNTAGGED_MARKER, ...untagged.map(pickLine), '');

  const path = planPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, out.join('\n'));

  heading('Export');
  console.log(`${bold('wrote')}  ${path}`);
  console.log(`${pending.length} waiting · ${pending.length - untagged.length} placed · ${branches.length} stack branches`);
  if (untagged.length) attention(`${untagged.length} untagged, below the marker`);
  else good('every waiting commit is placed');
  for (const commit of strayNotes) attention(`note "${commit.note}" names no stack branch:\n${commitLine(commit)}`);
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
  const created = updateRefs.filter((branch) => !branches.includes(branch));
  const recorded = requireHeader(EXPORTED_AT_PREFIX, 'export again');
  const current = tipOf(wip);
  // Commits added on top since export are fine; a rewritten wip means the file's SHAs are gone.
  const addedSinceExport = new Set<string>();
  const rewritten = recorded !== current && !isAncestor(recorded, current);
  if (rewritten) {
    // Every SHA in the file is gone, so per-line errors would only repeat this one.
    errors.splice(0, errors.length, `${wip} was rewritten since export (was ${recorded.slice(0, 10)}); export again`);
  } else {
    for (const sha of git('rev-list', '--first-parent', `${recorded}..${current}`).split('\n')) {
      if (sha) addedSinceExport.add(sha);
    }
    for (const branch of branches) {
      if (!updateRefs.includes(branch)) errors.push(`update-ref ${branch} is missing; every stack branch keeps its line`);
    }
    for (const branch of new Set(updateRefs)) {
      if (updateRefs.indexOf(branch) !== updateRefs.lastIndexOf(branch)) errors.push(`update-ref ${branch} is listed twice`);
    }
    for (const branch of created) {
      if (!gitSucceeds('check-ref-format', '--branch', branch)) errors.push(`${branch} is not a valid branch name`);
      else if (branchExists(branch)) errors.push(`${branch} already exists outside the stack`);
    }
    const lowest = updateRefs[0];
    if (created.includes(lowest) && ![...targets.values()].includes(lowest)) {
      errors.push(`${lowest} is new and empty at the bottom of the stack, where git cannot tell it from ${base}`);
    }
    for (const commit of pending) {
      if (!listed.has(commit.sha) && !addedSinceExport.has(commit.sha)) {
        errors.push(`${commit.sha.slice(0, 10)} is missing from the plan: ${commit.subject}`);
      }
    }
  }

  heading(dryRun ? 'Apply (dry run)' : 'Apply');
  if (errors.length) {
    bad('no notes written');
    for (const error of errors) console.log(`  ${error}`);
    process.exit(1);
  }

  const toTag = pending.filter((commit) => listed.has(commit.sha) && (targets.get(commit.sha) ?? '') !== commit.note);
  const tagged = toTag.filter((commit) => targets.get(commit.sha));
  const untagged = toTag.filter((commit) => !targets.get(commit.sha));
  printByBranch([...updateRefs, wip], (commit) => targets.get(commit.sha) ?? '', tagged, (branch) =>
    cyan(branch === wip ? `${branch} (stays)` : branch),
  );
  if (untagged.length) {
    console.log(yellow('untag'));
    for (const commit of untagged) console.log(commitLine(commit));
  }
  if (!dryRun) {
    for (const commit of tagged) git('notes', `--ref=${NOTES_REF}`, 'add', '-f', '-m', targets.get(commit.sha)!, commit.sha);
    for (const commit of untagged) git('notes', `--ref=${NOTES_REF}`, 'remove', commit.sha);
  }
  if (toTag.length) good(`${toTag.length} notes ${dryRun ? 'would change' : 'changed'}`);
  else good('notes already match the plan');

  printOrderChanges(branches, updateRefs);
  if (updateRefs.join(' ') !== readConfig(ORDER_KEY) || created.join(' ') !== readConfig(NEW_KEY)) {
    if (!dryRun) {
      git('config', ORDER_KEY, updateRefs.join(' '));
      if (created.length) git('config', NEW_KEY, created.join(' '));
      else if (readConfig(NEW_KEY)) git('config', '--unset', NEW_KEY);
    }
    good(`stack order ${dryRun ? 'would be saved' : 'saved'} in git config ${ORDER_KEY}`);
  }

  const unplaced = pending.filter((commit) => addedSinceExport.has(commit.sha) && !listed.has(commit.sha));
  if (unplaced.length) {
    attention('left untagged, committed after export:');
    for (const commit of unplaced) console.log(commitLine(commit));
  }
  if (current !== recorded) {
    if (!dryRun) writeHeader(EXPORTED_AT_PREFIX, current);
    console.log(`${dryRun ? 'would move' : 'moved'} the plan's exported-at to ${yellow(current.slice(0, 10))}`);
  }
  return { targets, order: updateRefs };
};

type Planned = ReturnType<typeof applyPlan>;

// A pure reorder keeps the tip's tree and every patch, so any difference here is worth reading.
const verifyRebase = () => {
  const wip = currentBranch();
  const recorded = requireHeader(PRE_REBASE_PREFIX, 'stack-plan rebase records one when it starts');
  const short = yellow(recorded.slice(0, 10));
  heading('Verify');

  // Both run before anything prints, so the details come first and the verdict ends the output.
  const rangeArgs = ['range-diff', colourOn(process.stdout) ? '--color=always' : '--no-color', `${base}..${recorded}`, `${base}..${wip}`];
  const statArgs = ['diff', '--stat', recorded, wip];
  const entries = splitRangeDiff(gitQuiet(...rangeArgs));
  const stat = gitQuiet(...statArgs).trimEnd();

  const worthReading = entries.filter((entry) => ['!', '<', '>'].includes(entry.kind));
  if (worthReading.length) {
    subheading('Range diff changes');
    console.log(worthReading.map((entry) => entry.lines.join('\n').trimEnd()).join('\n\n'));
  }

  subheading('Conclusion');
  traceGit(rangeArgs);
  const count = (kind: Entry['kind']) => entries.filter((entry) => entry.kind === kind).length;
  const summary = `range-diff  ${count('=')} unchanged · ${count('context')} context only · ${count('!')} changed · ${count('<')} dropped · ${count('>')} added`;
  if (count('<') || count('>')) bad(`${summary}; read the entries above`);
  else if (count('!')) attention(`${summary}; read the changed entries above`);
  else good(summary);
  const contextOnly = entries.filter((entry) => entry.kind === 'context');
  if (contextOnly.length) {
    console.log(`\nOnly the surrounding lines moved, the change itself is the same:`);
    for (const entry of contextOnly) console.log(entry.lines[0]);
  }
  const changed = entries.filter((entry) => entry.kind === '!');
  if (changed.length) {
    console.log(
      `\nThe change itself differs, full entries above. With a matching tree, part of a change moved between these` +
        `\ncommits: the end result is the same, but each commit on its own may now read differently or not build:`,
    );
    for (const entry of changed) console.log(entry.lines[0]);
  }
  const droppedOrAdded = entries.filter((entry) => entry.kind === '<' || entry.kind === '>');
  if (droppedOrAdded.length) {
    console.log(`\nDropped (<) or added (>), full entries above:`);
    for (const entry of droppedOrAdded) console.log(entry.lines[0]);
  }

  console.log('');
  traceGit(statArgs);
  if (stat) {
    bad(`tree differs from the pre-rebase tip ${short}`);
    console.log(stat);
    console.log(`To put the pre-rebase tree back as uncommitted changes:`);
    console.log(`  git restore --source=${recorded.slice(0, 10)} --staged --worktree :/`);
  } else good(`tree matches the pre-rebase tip ${short}`);
  if (stat || droppedOrAdded.length) return;

  const waitingToCreate = words(readConfig(NEW_KEY));
  if (waitingToCreate.length && waitingToCreate.every(branchExists)) {
    if (!dryRun) git('config', '--unset', NEW_KEY);
    good(`new branches ${dryRun ? 'would be marked' : 'marked'} created: ${waitingToCreate.join(', ')}`);
  }

  // A note on a commit no longer waiting on wip has done its job; the pre-rebase commits keep their copies.
  const { line, pending } = readStack(wip);
  const waiting = new Set(pending.map((commit) => commit.sha));
  const landed = line.filter((commit) => commit.note && !waiting.has(commit.sha));
  if (!landed.length) return;
  if (!dryRun) git('notes', `--ref=${NOTES_REF}`, 'remove', ...landed.map((commit) => commit.sha));
  good(`${landed.length} notes ${dryRun ? 'would be removed' : 'removed'} from commits now in their branch`);
};

type Entry = { kind: '=' | '!' | '<' | '>' | 'context'; lines: string[] };

// Header lines look like "12:  abc1234 = 14:  def5678 subject"; = means the patch is unchanged.
const RANGE_DIFF_HEADER = /^\s*(?:\d+|-):\s+\S+\s+([=!<>])\s+(?:\d+|-):\s+\S+/;

// Splits range-diff output per commit, and marks a ! entry "context" when only its context lines differ.
const splitRangeDiff = (output: string) => {
  const entries: Entry[] = [];
  for (const line of output.split('\n')) {
    const marker = RANGE_DIFF_HEADER.exec(stripColour(line))?.[1];
    if (marker) entries.push({ kind: marker as Entry['kind'], lines: [line] });
    else entries.at(-1)?.lines.push(line);
  }
  for (const entry of entries) {
    if (entry.kind === '!' && onlyContextDiffers(entry.lines.slice(1).map(stripColour))) entry.kind = 'context';
  }
  return entries;
};

// Body lines are indented four spaces, then the outer marker (old vs new patch), then the patch's own marker.
const onlyContextDiffers = (body: string[]) => {
  let inMessage = false;
  for (const line of body) {
    const outer = line[4];
    const inner = line[5];
    if (outer === '@' && line[5] === '@') {
      inMessage = line.slice(4).startsWith('@@ Commit message');
      continue;
    }
    if (line.slice(6).startsWith('## ')) inMessage = false;
    if (outer !== '+' && outer !== '-') continue;
    if (inMessage || inner === '+' || inner === '-') return false;
  }
  return true;
};

const rebaseStack = (planned?: Planned) => {
  const wip = currentBranch();
  const { branches, pending, own } = readStack(wip);
  // A dry-run apply writes no notes or config, so its plan stands in for them.
  for (const commit of pending) if (planned?.targets.has(commit.sha)) commit.note = planned.targets.get(commit.sha) ?? '';
  const order = planned?.order ?? desiredOrder(branches);
  const moves = pending.filter((commit) => commit.note !== wip && order.includes(commit.note));
  const receives = (branch: string) => moves.some((commit) => commit.note === branch);
  let first = 0;
  while (first < order.length && order[first] === branches[first] && !receives(order[first])) first++;
  heading(dryRun ? 'Plan (dry run)' : 'Plan');
  if (first === order.length) {
    good(`no tagged commits waiting on ${wip} and no change to the stack order; nothing to move`);
    return;
  }
  // Everything below the first changed branch stays as it is.
  const rebaseBase = first === 0 ? base : order[first - 1];
  printByBranch(order, (commit) => commit.note, moves);
  printOrderChanges(branches, order);
  console.log(`${bold('base')}  ${cyan(rebaseBase)}`);

  const moved = new Set(moves.map((commit) => commit.sha));
  const relocated = new Set(movedBranches(branches, order));
  const todo: string[] = [];
  const sequence: Commit[] = [];
  const pick = (commit: Commit, marker = '') => {
    todo.push(`pick ${commit.sha} ${marker}${commit.subject}`);
    sequence.push(commit);
  };
  for (const [index, branch] of order.entries()) {
    if (index < first) continue;
    const below = order[index - 1] ?? base;
    if (!branches.includes(branch)) todo.push(`# ${NEW_BRANCH_MARKER} ${branch}, above ${below}`);
    else if (relocated.has(branch)) todo.push(`# ${MOVED_BRANCH_MARKER} ${branch}, now above ${below}`);
    for (const commit of own.get(branch) ?? []) pick(commit);
    for (const commit of moves.filter((move) => move.note === branch)) pick(commit, `${MOVED_MARKER} `);
    todo.push(`update-ref refs/heads/${branch}`, '');
  }
  for (const commit of pending.filter((commit) => !moved.has(commit.sha))) pick(commit);

  heading('Preview');
  const started = Date.now();
  const simulation = simulateRebase(sequence, tipOf(rebaseBase), wip);
  const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  if (simulation.ok) {
    good(`all ${simulation.picks} picks apply cleanly in memory (${took})`);
    if (!simulation.sameTree) attention('the simulated result ends on a different tree than wip; verify will show where');
  } else {
    bad(`pick ${simulation.at + 1} of ${simulation.picks} would conflict (${took}):`);
    console.log(commitLine(simulation.commit));
    for (const file of simulation.files) console.log(`    ${file}`);
    console.log('rerere may already hold a resolution for it; the preview cannot tell.');
  }
  if (dryRun) return;
  if (!simulation.ok && !rest.includes('--anyway')) {
    console.log('\nNothing rewritten. Change the plan (export, edit, apply), or resolve it by hand:');
    console.log('  stack-plan rebase -f');
    process.exit(1);
  }
  if (!existsSync(planPath())) throw new Error('No stackplan.txt to record the pre-rebase tip in; run stack-plan export first');

  const preRebase = tipOf(wip);
  writeHeader(PRE_REBASE_PREFIX, preRebase);
  logPreRebase(preRebase);
  const todoPath = join(git('rev-parse', '--absolute-git-dir').trim(), 'stack-plan-todo');
  writeFileSync(todoPath, todo.join('\n'));
  const reviewEditor = git('var', 'GIT_SEQUENCE_EDITOR').trim();
  const editor = `node ${shellQuote(realpathSync(process.argv[1]))} _todo`;
  const args = ['rebase', '-i', '--update-refs', rebaseBase];
  heading('Rebase');
  console.error(dimErr(`$ GIT_SEQUENCE_EDITOR=${shellQuote(editor)} git ${args.join(' ')}`));
  const result = spawnSync('git', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      GIT_SEQUENCE_EDITOR: editor,
      STACK_PLAN_EDITOR: reviewEditor,
      STACK_PLAN_TODO: todoPath,
    },
  });
  if (result.status !== 0) {
    attention('the rebase stopped. Resolve it and run `git rebase --continue`, then: stack-plan verify');
    process.exit(result.status ?? 1);
  }
  verifyRebase();
};

const picksIn = (todo: string) =>
  todo.split('\n').flatMap((line) => /^(?:pick|p)\s+([0-9a-f]+)/.exec(line)?.[1] ?? []);

// Runs as git's sequence editor: swaps git's todo for the planned one when both hold the same picks, then opens the user's editor.
const editTodo = (todoPath: string) => {
  // Git reads only the command and hash of a pick, so the rest of a planned line is free for a marker.
  const planned = readFileSync(process.env.STACK_PLAN_TODO ?? '', 'utf8');
  const plannedShas = picksIn(planned);
  const original = readFileSync(todoPath, 'utf8');
  const gitShas = picksIn(original);
  const problems = gitShas
    .filter((abbrev) => !plannedShas.some((sha) => sha.startsWith(abbrev)))
    .map((abbrev) => `${abbrev} is in git's todo but not in the plan`);
  if (gitShas.length !== plannedShas.length) problems.push(`git's todo has ${gitShas.length} picks, the plan ${plannedShas.length}`);
  if (problems.length) {
    console.error(redErr(`✗ stack-plan: ${problems.join('; ')}. Rebase not started.`));
    process.exit(1);
  }
  const help = original.split('\n').filter((line) => line.startsWith('#'));
  writeFileSync(todoPath, [planned, ...help].join('\n'));

  const review = process.env.STACK_PLAN_EDITOR;
  if (review) {
    const result = spawnSync('sh', ['-c', `${review} "$1"`, 'sh', todoPath], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
};

try {
  if (command === 'export') exportPlan();
  else if (command === 'apply') {
    const planned = applyPlan();
    if (rest.includes('--rebase')) rebaseStack(dryRun ? planned : undefined);
  }
  else if (command === 'rebase') rebaseStack();
  else if (command === 'verify') verifyRebase();
  else if (command === '_todo') editTodo(args[0]);
} catch (error) {
  console.error(redErr(`✗ ${(error as Error).message}`));
  process.exit(1);
}
