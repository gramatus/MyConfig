#!/usr/bin/env node
// Moves commits waiting on the current branch into stack branches, and reorders or adds those branches.
// Usage: stack-plan export|save|preview|apply|prepare|verify|cut|mode [-b <ref>] [-n] [-f]; run without arguments for details.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const NOTES_REF = 'refs/notes/target';
const UNTAGGED_MARKER = '# ---- untagged: move each line above the update-ref of its branch ----';
const EXPORTED_AT_PREFIX = '# exported-at: ';
const PRE_REBASE_PREFIX = '# pre-rebase: ';
const MODE_PREFIX = '# mode: ';
const FOLDED_PREFIX = '# folded: ';
const CUT_PREFIX = '# cut: ';
const MOVED_MARKER = '>>> [moved]';
const MOVED_BRANCH_MARKER = '>>> [moved branch]';
const NEW_BRANCH_MARKER = '>>> [new branch]';
const ORDER_KEY = 'stackplan.order';
const NEW_KEY = 'stackplan.new';
const MODE_KEY = 'stackplan.mode';

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
  'Usage: stack-plan <command> [-b|--base <ref>] [-n|--dry-run] [-f|--anyway] [--apply]',
  '  export (e)   write the plan file',
  '  save (s)     write notes from the plan',
  '  preview      save, then preview the rebase; -n also leaves the notes unwritten',
  '  apply (a)    save, then rebase the stack; -f runs it despite a predicted conflict',
  '  prepare      record the pre-rebase tip before a rebase run by hand',
  '  verify (v)   compare the stack with the pre-rebase tip',
  '  cut <branch> check that dropping the branches up to <branch> and rebasing the rest onto the base loses no work;',
  '               --apply then does it, and -f does it despite a finding',
  '  mode [full|short]  show or set what export lists: full is every commit, short only the waiting ones',
].join('\n');

const EXPANSIONS: Record<string, string[]> = {
  e: ['export'],
  s: ['save'],
  a: ['apply'],
  v: ['verify'],
};
const FLAG_ALIASES: Record<string, string> = { '-b': '--base', '-n': '--dry-run', '-f': '--anyway' };
const ALLOWED_FLAGS: Record<string, string[]> = {
  export: ['--base'],
  save: ['--base', '--dry-run'],
  preview: ['--base', '--dry-run'],
  apply: ['--base', '--anyway'],
  prepare: [],
  verify: ['--base', '--dry-run'],
  cut: ['--base', '--apply', '--anyway'],
  mode: ['full', 'short'],
};

const [given = '', ...args] = process.argv.slice(2);
const [command, ...implied] = EXPANSIONS[given] ?? [given];
const rest = [...implied, ...args.map((arg) => FLAG_ALIASES[arg] ?? arg)];

const usageError = (message?: string): never => {
  if (message) console.error(redErr(`✗ ${message}`));
  console.error(USAGE);
  process.exit(2);
};
let cutAt: string | undefined;
if (command !== '_todo') {
  const allowed = ALLOWED_FLAGS[command] ?? usageError(given ? `unknown command "${given}"` : undefined);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--base' && allowed.includes('--base')) i++;
    else if (command === 'cut' && !cutAt && !rest[i].startsWith('-')) cutAt = rest[i];
    else if (!allowed.includes(rest[i])) usageError(`${rest[i]} does not apply to ${given}`);
  }
  if (command === 'mode' && rest.length > 1) usageError('mode takes one of full or short');
  if (command === 'cut' && !cutAt) usageError('cut needs the branch to cut at');
}

const optionValue = (name: string) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const base = optionValue('--base') ?? 'origin/main';
const dryRun = rest.includes('--dry-run');

type Commit = { sha: string; subject: string; branches: string[]; note: string };
type Verb = 'pick' | 'fixup' | 'squash';
type Step = { pick: Commit; verb: Verb } | { updateRef: string };
type Replay = { commit: Commit; fold: boolean };
const VERBS: Record<string, Verb> = { pick: 'pick', p: 'pick', fixup: 'fixup', f: 'fixup', squash: 'squash', s: 'squash' };
const folds = (step?: Step) => step !== undefined && 'pick' in step && step.verb !== 'pick';

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

const fullMode = () => readConfig(MODE_KEY) === 'full';

// The order save stored, while it still covers the stack; a missing branch counts only while it waits to be created.
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

const dropHeader = (prefix: string) => {
  const lines = readFileSync(planPath(), 'utf8').split('\n');
  writeFileSync(planPath(), lines.filter((line) => !line.startsWith(prefix)).join('\n'));
};

// Sets the tip verify compares against, and replaces the folds and cut of any earlier rebase with this one's.
const recordPreRebase = (sha: string, folded: string[]) => {
  writeHeader(PRE_REBASE_PREFIX, sha);
  if (folded.length) writeHeader(FOLDED_PREFIX, folded.join(' '));
  else dropHeader(FOLDED_PREFIX);
  dropHeader(CUT_PREFIX);
  logPreRebase(sha);
};

const ensurePlanFile = (wip: string) => {
  if (existsSync(planPath())) return;
  mkdirSync(dirname(planPath()), { recursive: true });
  writeFileSync(planPath(), `# stack-plan for ${wip}, holding the pre-rebase tip for verify\n`);
};

// For a rebase run by hand, so verify has a tip to compare against afterwards.
const prepareRebase = () => {
  const wip = currentBranch();
  ensurePlanFile(wip);
  const sha = tipOf(wip);
  recordPreRebase(sha, []);
  heading('Prepare');
  good(`recorded ${yellow(sha.slice(0, 10))} as the pre-rebase tip of ${cyan(wip)}`);
  console.log('Rebase by hand, then run: stack-plan verify');
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

const treeOf = (ref: string) => gitQuiet('rev-parse', `${ref}^{tree}`).trim();

type Merge = { ok: true; tree: string } | { ok: false; files: string[]; tree: string; messages: string[] };

// A three-way merge in memory: the tree it would produce, or the conflicted files, the tree with markers, and git's messages.
const mergeTree = (mergeBase: string, ours: string, theirs: string): Merge => {
  try {
    const merged = gitQuiet('merge-tree', '--write-tree', '--name-only', `--merge-base=${mergeBase}`, ours, theirs);
    return { ok: true, tree: merged.split('\n')[0] };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (failure.status !== 1) throw error;
    const [tree, ...listed] = (failure.stdout ?? '').split('\n');
    const end = Math.max(0, listed.indexOf(''));
    return { ok: false, files: [...new Set(listed.slice(0, end))], tree, messages: listed.slice(end + 1) };
  }
};

type Conflict = { picks: number; at: number; commit: Commit; files: string[]; tree: string; messages: string[]; before: Commit[] };
type Simulation = ({ ok: true; picks: number; sameTree: boolean; tip: string }) | ({ ok: false } & Conflict);

// Replays the planned picks in memory: objects are written, no ref moves, and the worktree is untouched.
const simulateRebase = (sequence: Replay[], start: string, wip: string): Simulation => {
  console.error(dimErr(`$ git merge-tree --write-tree --name-only --merge-base=<pick>^ <state> <pick>    (per pick)`));
  console.error(dimErr(`$ git commit-tree <tree> -p <state> -m 'stack-plan preview' --no-gpg-sign  (per pick)`));
  console.error(dimErr(`  (a fixup or squash commits onto <state>'s parent instead, replacing <state>)`));
  let state = start;
  let parent = start;
  for (const [index, { commit, fold }] of sequence.entries()) {
    const merged = mergeTree(`${commit.sha}^`, state, commit.sha);
    if (!merged.ok) {
      const before = sequence.slice(0, index).map((replay) => replay.commit);
      const { files, tree, messages } = merged;
      return { ok: false, picks: sequence.length, at: index, commit, files, tree, messages, before };
    }
    if (!fold) parent = state;
    state = gitQuiet('commit-tree', merged.tree, '-p', parent, '-m', 'stack-plan preview', '--no-gpg-sign').trim();
  }
  return { ok: true, picks: sequence.length, sameTree: treeOf(state) === treeOf(wip), tip: state };
};

const MARKER_OPEN = /^<{7}(?: |$)/;
const MARKER_SPLIT = /^(?:={7}|\|{7})(?: |$)/;
const MARKER_CLOSE = /^>{7}(?: |$)/;

// Counts the marked regions the merge left in a file, and the lines inside them across both sides.
const conflictSize = (tree: string, file: string) => {
  let regions = 0;
  let lines = 0;
  let inside = false;
  const text = gitSucceeds('cat-file', '-e', `${tree}:${file}`) ? gitQuiet('cat-file', '-p', `${tree}:${file}`) : '';
  for (const line of text.split('\n')) {
    if (MARKER_OPEN.test(line)) {
      regions++;
      inside = true;
    } else if (MARKER_CLOSE.test(line)) inside = false;
    else if (inside && !MARKER_SPLIT.test(line)) lines++;
  }
  return { regions, lines };
};

const changesAny = (sha: string, files: string[]) =>
  fileList(gitQuiet('diff-tree', '-r', '--root', '--no-commit-id', '--name-only', sha)).some((file) => files.includes(file));

const subjectOf = (sha: string) => ({ sha, subject: gitQuiet('show', '-s', '--format=%s', sha).trim() });

// Sizes each conflicted file, and names the commits on those files that the pick now sits above, or no longer does.
const explainConflict = (conflict: Conflict, start: string) => {
  const { commit, files, tree, messages, before } = conflict;
  for (const file of files) {
    const message = messages.find((line) => line.startsWith('CONFLICT') && line.includes(file)) ?? '';
    const kind = /^CONFLICT \(([^)]+)\)/.exec(message)?.[1] ?? 'conflict';
    const { regions, lines } = conflictSize(tree, file);
    const size = regions ? `${regions} region${regions === 1 ? '' : 's'}, ${lines} lines` : 'no text markers';
    console.log(`    ${file}  ${size}  (${kind})`);
  }
  const wasBelow = new Set(fileList(gitQuiet('rev-list', `${start}..${commit.sha}^`)));
  const isBelow = new Set(before.map((below) => below.sha));
  // From the base side: commits the pick now sits on that it did not before, as after a cut or a moved branch.
  const fromBase = fileList(gitQuiet('log', '--format=%H', '--max-count=6', `${commit.sha}..${start}`, '--', ...files));
  const nowBelow = [...before.filter((below) => !wasBelow.has(below.sha) && changesAny(below.sha, files)), ...fromBase.map(subjectOf)];
  const noLongerBelow = [...wasBelow].filter((sha) => !isBelow.has(sha) && changesAny(sha, files)).map(subjectOf);
  if (nowBelow.length) {
    console.log('  now below it, and changing the same files:');
    for (const culprit of nowBelow.slice(0, 6)) console.log(`  ${commitLine(culprit)}`);
    if (fromBase.length > 5 || nowBelow.length > 6) console.log('    and more');
  }
  if (noLongerBelow.length) {
    console.log('  no longer below it, and changing the same files:');
    for (const culprit of noLongerBelow) console.log(`  ${commitLine(culprit)}`);
  }
  if (!nowBelow.length && !noLongerBelow.length) console.log('  no commit that moved relative to it changes those files');
};

// Whitespace and line numbers do not count, so the same change on a moved base gets the same id.
const patchId = (from: string, to: string, path?: string) => {
  const diff = gitQuiet('diff', from, to, ...(path ? ['--', path] : []));
  if (!diff) return '';
  return execFileSync('git', ['patch-id', '--stable'], { input: diff, encoding: 'utf8', maxBuffer: 1 << 28 }).split(' ')[0];
};

const fileList = (output: string) => output.split('\n').filter(Boolean);

// Whether from..to and onFrom..onTo make the same change; false when some file ends differently.
const sameNetChange = (label: string, from: string, to: string, onFrom: string, onTo: string, onName: string) => {
  if (patchId(from, to) === patchId(onFrom, onTo)) {
    good(`the net change of ${label} is the same on ${onName}`);
    return true;
  }
  const files = new Set([...fileList(gitQuiet('diff', '--name-only', from, to)), ...fileList(gitQuiet('diff', '--name-only', onFrom, onTo))]);
  const differing = [...files].filter((file) => patchId(from, to, file) !== patchId(onFrom, onTo, file));
  // A file that ends the same lost nothing: the new base already had that part of the change.
  const blob = (ref: string, file: string) => (gitSucceeds('cat-file', '-e', `${ref}:${file}`) ? tipOf(`${ref}:${file}`) : '');
  const landed = differing.filter((file) => blob(onTo, file) === blob(to, file));
  const missing = differing.filter((file) => !landed.includes(file));
  if (landed.length) {
    attention(`part of ${label} is already in ${onName}, so these files end the same:`);
    for (const file of landed) console.log(`    ${file}`);
  }
  if (!missing.length) {
    good(`the rest of the net change of ${label} is the same on ${onName}`);
    return true;
  }
  bad(`the net change of ${label} differs on ${onName}, and these files end differently:`);
  for (const file of missing) console.log(`    ${file}`);
  return false;
};

// Checks whether cutting the stack at a branch and rebasing the rest onto the base would lose work; --apply then does it.
const cutStack = (at: string, apply: boolean) => {
  const wip = currentBranch();
  const { line, branches } = readStack(wip);
  if (!branches.includes(at)) throw new Error(`${at} is not a stack branch below ${wip}; the stack is: ${branches.join(' ')}`);
  heading(`Cut at ${at}, onto ${base}`);
  let lost = 0;
  let unclear = 0;

  // Per branch, since a squash merge leaves only a branch's end state in the base.
  subheading(`Below the cut: already in ${base}?`);
  const below = branches.slice(0, branches.indexOf(at) + 1);
  const fork = git('merge-base', base, wip).trim();
  for (const [index, branch] of below.entries()) {
    const merged = mergeTree(index === 0 ? fork : tipOf(below[index - 1]), base, branch);
    if (!merged.ok) {
      unclear++;
      attention(`${cyan(branch)}  can't tell: ${base} changed these again since, so compare by hand`);
      for (const file of merged.files) console.log(`    ${file}`);
    } else if (merged.tree === treeOf(base)) good(`${cyan(branch)}  contained in ${base}`);
    else {
      lost++;
      bad(`${cyan(branch)}  would be lost: ${base} lacks its changes to`);
      for (const file of fileList(gitQuiet('diff', '--name-only', base, merged.tree))) console.log(`    ${file}`);
    }
  }

  subheading(`Above the cut: rebased onto ${base}`);
  const above = line.slice(line.findIndex((commit) => commit.branches.includes(at)) + 1);
  if (!above.length) good('no commits above the cut');
  else {
    const simulation = simulateRebase(above.map((commit) => ({ commit, fold: false })), tipOf(base), wip);
    if (!simulation.ok) {
      unclear++;
      bad(`pick ${simulation.at + 1} of ${simulation.picks} would conflict:`);
      console.log(commitLine(simulation.commit));
      explainConflict(simulation, tipOf(base));
    } else {
      good(`all ${simulation.picks} picks apply cleanly in memory`);
      if (!sameNetChange(`${at}..${wip}`, at, wip, tipOf(base), simulation.tip, base)) lost++;
    }
  }

  subheading('Conclusion');
  if (lost) bad(`cutting at ${at} would lose work; see the files above`);
  else if (unclear) attention(`no loss found, but some of it needs a look by hand; see above`);
  else good(`cutting at ${at} and rebasing onto ${base} loses no work`);
  if (!apply) {
    if (!lost && !unclear) console.log(`To do it: stack-plan cut ${at} --apply`);
    if (lost || unclear) process.exit(1);
    return;
  }
  if ((lost || unclear) && !rest.includes('--anyway')) {
    console.log(`\nNothing rewritten. To cut anyway: stack-plan cut ${at} --apply -f`);
    process.exit(1);
  }

  const cutTip = tipOf(at);
  ensurePlanFile(wip);
  recordPreRebase(tipOf(wip), []);
  writeHeader(CUT_PREFIX, [cutTip, tipOf(base), ...below].join(' '));
  // A commit the base already holds becomes empty, and the check above already counted it as landed.
  const args = ['rebase', '-i', '--update-refs', '--empty=drop', '--onto', base, cutTip];
  heading('Rebase');
  traceGit(args);
  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    attention('the rebase stopped. Resolve it and run `git rebase --continue`, then: stack-plan verify');
    process.exit(result.status ?? 1);
  }
  verifyRebase();
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

const pickLine = (commit: Commit, marker = '') => `pick ${commit.sha.slice(0, 10)} ${marker}${commit.subject}`;

const exportPlan = () => {
  const wip = currentBranch();
  const full = fullMode();
  const { line, branches: current, pending, own } = readStack(wip);
  // An order saved but not yet rebased is exported as planned, like the notes are.
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
  const lastFolded = existsSync(planPath()) ? readHeader(FOLDED_PREFIX) : undefined;
  const out = [
    `# stack-plan for ${wip} on ${base}, exported ${new Date().toISOString()}`,
    `${EXPORTED_AT_PREFIX}${tipOf(wip)}`,
    ...(lastPreRebase ? [`${PRE_REBASE_PREFIX}${lastPreRebase}`] : []),
    ...(lastFolded ? [`${FOLDED_PREFIX}${lastFolded}`] : []),
    ...(full ? [`${MODE_PREFIX}full`] : []),
    '# A pick belongs to the first update-ref below it. Picks between the last update-ref and',
    `# the untagged marker stay on ${wip}. Move picks, reorder update-refs or add one for a`,
    '# new branch, then run: stack-plan preview, then stack-plan apply',
    `# ${MOVED_MARKER} and the branch markers show what was saved at export; save ignores them.`,
    ...(full
      ? [
          `# Full mode: every commit since ${base} is listed, and the rebase follows this order.`,
          '# fixup or squash in place of pick folds that commit into the pick above it.',
        ]
      : []),
    '',
  ];
  // Marked as apply's todo marks them, so the file shows what the notes and saved order would move.
  for (const branch of branches) {
    const marker = branchMarker(branch, current, branches);
    const inBranch = full ? (own.get(branch) ?? []) : [];
    const moving = sections.get(branch)!.map((commit) => pickLine(commit, `${MOVED_MARKER} `));
    out.push(...(marker ? [marker] : []), ...inBranch.map((commit) => pickLine(commit)), ...moving, `update-ref refs/heads/${branch}\n`);
  }
  out.push(...sections.get(wip)!.map((commit) => pickLine(commit)), UNTAGGED_MARKER, ...untagged.map((commit) => pickLine(commit)), '');

  const path = planPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, out.join('\n'));

  heading(full ? 'Export (full)' : 'Export');
  console.log(`${bold('wrote')}  ${path}`);
  const inBranches = full ? ` · ${line.length - pending.length} in branches` : '';
  console.log(`${pending.length} waiting · ${pending.length - untagged.length} placed${inBranches} · ${branches.length} stack branches`);
  if (untagged.length) attention(`${untagged.length} untagged, below the marker`);
  else good('every waiting commit is placed');
  for (const commit of strayNotes) attention(`note "${commit.note}" names no stack branch:\n${commitLine(commit)}`);
};

const savePlan = () => {
  const wip = currentBranch();
  const { line: history, branches, pending } = readStack(wip);
  const full = readHeader(MODE_PREFIX) === 'full';
  const listable = full ? history : pending;
  const errors: string[] = [];
  const targets = new Map<string, string | undefined>();
  const listed = new Set<string>();
  const updateRefs: string[] = [];
  const steps: Step[] = [];
  const folded = new Set<string>();
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
        steps.push({ updateRef: branch });
        for (const sha of held) targets.set(sha, branch);
        held = [];
      } else if (Object.hasOwn(VERBS, verb)) {
        const kind = VERBS[verb];
        const commit = listable.find((candidate) => candidate.sha.startsWith(arg));
        const scope = full ? `in ${base}..${wip}` : `waiting on ${wip}`;
        if (kind !== 'pick' && !full) errors.push(`${where}: ${kind} needs full mode (stack-plan mode full)`);
        // Folding across an update-ref would leave the branch on the commit before the fold.
        else if (kind !== 'pick' && !(steps.at(-1) && 'pick' in steps.at(-1)!)) {
          errors.push(`${where}: ${kind} must follow a pick in the same branch`);
        } else if (!commit) errors.push(`${where}: ${arg} is not ${scope}; export again`);
        else if (listed.has(commit.sha)) errors.push(`${where}: ${arg} is listed twice`);
        else {
          listed.add(commit.sha);
          steps.push({ pick: commit, verb: kind });
          if (kind !== 'pick') folded.add(commit.sha);
          if (pastMarker) targets.set(commit.sha, undefined);
          else held.push(commit.sha);
        }
      } else errors.push(`${where}: expected pick, fixup, squash or update-ref, got "${verb}"`);
    });

  if (!pastMarker) errors.push('the untagged marker line is missing');
  // A folded commit stops existing, so its note goes rather than piling onto the commit it folds into.
  for (const sha of folded) targets.set(sha, undefined);
  if (full !== fullMode()) {
    errors.push(`the plan was exported in ${full ? 'full' : 'short'} mode, and the mode is now ${full ? 'short' : 'full'}; export again`);
  }
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
    for (const commit of listable) {
      if (!listed.has(commit.sha) && !addedSinceExport.has(commit.sha)) {
        errors.push(`${commit.sha.slice(0, 10)} is missing from the plan: ${commit.subject}`);
      }
    }
  }

  heading(dryRun ? 'Save (dry run)' : 'Save');
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
  steps.push(...unplaced.map((pick) => ({ pick, verb: 'pick' as const })));
  return { targets, order: updateRefs, steps: full ? steps : undefined };
};

type Planned = ReturnType<typeof savePlan>;

// A pure reorder keeps the tip's tree and every patch, so any difference here is worth reading.
const verifyRebase = () => {
  const wip = currentBranch();
  const recorded = requireHeader(PRE_REBASE_PREFIX, 'stack-plan apply records one when it rebases');
  const short = yellow(recorded.slice(0, 10));
  heading('Verify');

  // After a cut, the old range starts at the cut tip and the new one at the base the rest moved onto.
  const [cutTip, newBase, ...cutBranches] = words(readHeader(CUT_PREFIX) ?? '');
  const oldFrom = cutTip ?? base;
  const newFrom = newBase ?? base;

  // Both run before anything prints, so the details come first and the verdict ends the output.
  const rangeArgs = ['range-diff', colourOn(process.stdout) ? '--color=always' : '--no-color', `${oldFrom}..${recorded}`, `${newFrom}..${wip}`];
  const statArgs = ['diff', '--stat', recorded, wip];
  const entries = splitRangeDiff(gitQuiet(...rangeArgs));
  const stat = cutTip ? '' : gitQuiet(...statArgs).trimEnd();
  // range-diff pairs a fold's commits unpredictably, so every entry from a planned fold is set apart instead.
  const foldGroups = words(readHeader(FOLDED_PREFIX) ?? '').map((pair) => pair.split('>'));
  const foldShas = foldGroups.flat();
  const foldSubjects = new Set(foldGroups.map(([, target]) => gitQuiet('log', '-1', '--format=%s', target).trim()));
  for (const entry of entries) {
    const fromOld = entry.oldSha && foldShas.some((sha) => sha.startsWith(entry.oldSha!));
    const asNew = entry.kind === '>' && foldSubjects.has(entry.subject);
    if (entry.kind !== '=' && (fromOld || asNew)) entry.kind = 'folded';
  }
  // After a cut, a commit is dropped when the new base already holds its change, which loses nothing.
  if (cutTip) {
    for (const entry of entries.filter((candidate) => candidate.kind === '<')) {
      const merged = mergeTree(`${entry.oldSha}^`, newBase, entry.oldSha);
      if (merged.ok && merged.tree === treeOf(newBase)) entry.kind = 'landed';
    }
  }

  const worthReading = entries.filter((entry) => ['!', '<', '>'].includes(entry.kind));
  if (worthReading.length) {
    subheading('Range diff changes');
    console.log(worthReading.map((entry) => entry.lines.join('\n').trimEnd()).join('\n\n'));
  }

  subheading('Conclusion');
  traceGit(rangeArgs);
  const count = (kind: Entry['kind']) => entries.filter((entry) => entry.kind === kind).length;
  const foldedCount = count('folded') ? ` · ${count('folded')} from folds` : '';
  const landedCount = count('landed') ? ` · ${count('landed')} already in the base` : '';
  const summary = `range-diff  ${count('=')} unchanged · ${count('context')} context only · ${count('!')} changed · ${count('<')} dropped · ${count('>')} added${foldedCount}${landedCount}`;
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
  const foldedEntries = entries.filter((entry) => entry.kind === 'folded');
  if (foldedEntries.length) {
    console.log(`\nFrom a planned fixup or squash, so expected; the tree check below still covers them:`);
    for (const entry of foldedEntries) console.log(entry.lines[0]);
  }
  const landedEntries = entries.filter((entry) => entry.kind === 'landed');
  if (landedEntries.length) {
    console.log(`\nDropped because the new base already holds the change, so nothing is lost:`);
    for (const entry of landedEntries) console.log(entry.lines[0]);
  }
  const droppedOrAdded = entries.filter((entry) => entry.kind === '<' || entry.kind === '>');
  if (droppedOrAdded.length) {
    console.log(`\nDropped (<) or added (>), full entries above:`);
    for (const entry of droppedOrAdded) console.log(entry.lines[0]);
  }

  console.log('');
  // A cut moves the rest onto a base that has changed, so the tree cannot match; the net change still must.
  const treeOk = cutTip
    ? sameNetChange(`${cutTip.slice(0, 10)}..${recorded.slice(0, 10)}`, cutTip, recorded, newBase, wip, newBase.slice(0, 10))
    : !stat;
  if (!cutTip) traceGit(statArgs);
  if (stat) {
    bad(`tree differs from the pre-rebase tip ${short}`);
    console.log(stat);
    console.log(`To put the pre-rebase tree back as uncommitted changes:`);
    console.log(`  git restore --source=${recorded.slice(0, 10)} --staged --worktree :/`);
  } else if (!cutTip) good(`tree matches the pre-rebase tip ${short}`);
  if (!treeOk || droppedOrAdded.length) return;

  const order = words(readConfig(ORDER_KEY));
  if (cutBranches.some((branch) => order.includes(branch))) {
    if (!dryRun) git('config', ORDER_KEY, order.filter((branch) => !cutBranches.includes(branch)).join(' '));
    good(`cut branches ${dryRun ? 'would be removed' : 'removed'} from ${ORDER_KEY}: ${cutBranches.join(', ')}`);
  }
  const leftOver = cutBranches.filter(branchExists);
  if (leftOver.length) console.log(`The cut branches are still there. To delete them:\n  git branch -D ${leftOver.join(' ')}`);

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

type Entry = { kind: '=' | '!' | '<' | '>' | 'context' | 'folded' | 'landed'; oldSha: string; subject: string; lines: string[] };

// Header lines look like "12:  abc1234 = 14:  def5678 subject"; = means the patch is unchanged.
const RANGE_DIFF_HEADER = /^\s*(?:\d+|-):\s+(\S+)\s+([=!<>])\s+(?:\d+|-):\s+\S+\s*(.*)$/;

// Splits range-diff output per commit, and marks a ! entry "context" when only its context lines differ.
const splitRangeDiff = (output: string) => {
  const entries: Entry[] = [];
  for (const line of output.split('\n')) {
    const [, oldSha, marker, subject] = RANGE_DIFF_HEADER.exec(stripColour(line)) ?? [];
    if (marker) entries.push({ kind: marker as Entry['kind'], oldSha, subject, lines: [line] });
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

type Rebase = { todo: string[]; sequence: Replay[]; rebaseBase: string };

const newTodo = () => {
  const todo: string[] = [];
  const sequence: Replay[] = [];
  const pick = (commit: Commit, marker = '', verb: Verb = 'pick') => {
    todo.push(`${verb} ${commit.sha} ${marker}${commit.subject}`);
    sequence.push({ commit, fold: verb !== 'pick' });
  };
  return { todo, sequence, pick };
};

const branchMarker = (branch: string, branches: string[], order: string[]) => {
  const below = order[order.indexOf(branch) - 1] ?? base;
  if (!branches.includes(branch)) return `# ${NEW_BRANCH_MARKER} ${branch}, above ${below}`;
  if (movedBranches(branches, order).includes(branch)) return `# ${MOVED_BRANCH_MARKER} ${branch}, now above ${below}`;
};

// Short mode: each branch keeps its own commits as a block, and waiting commits join the branch their note names.
const shortRebase = (wip: string, planned?: Planned): Rebase | undefined => {
  const { branches, pending, own } = readStack(wip);
  // A dry-run save writes no notes or config, so its plan stands in for them.
  for (const commit of pending) if (planned?.targets.has(commit.sha)) commit.note = planned.targets.get(commit.sha) ?? '';
  const order = planned?.order ?? desiredOrder(branches);
  const moves = pending.filter((commit) => commit.note !== wip && order.includes(commit.note));
  const receives = (branch: string) => moves.some((commit) => commit.note === branch);
  let first = 0;
  while (first < order.length && order[first] === branches[first] && !receives(order[first])) first++;
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
  const { todo, sequence, pick } = newTodo();
  for (const branch of order.slice(first)) {
    const marker = branchMarker(branch, branches, order);
    if (marker) todo.push(marker);
    for (const commit of own.get(branch) ?? []) pick(commit);
    for (const commit of moves.filter((move) => move.note === branch)) pick(commit, `${MOVED_MARKER} `);
    todo.push(`update-ref refs/heads/${branch}`, '');
  }
  for (const commit of pending.filter((commit) => !moved.has(commit.sha))) pick(commit);
  return { todo, sequence, rebaseBase };
};

// Full mode: the plan's own steps are the todo, from the last commit where they still match history.
const fullRebase = (wip: string, steps: Step[], planned: Planned): Rebase | undefined => {
  const { line, branches, own } = readStack(wip);
  const current: Step[] = line.flatMap((commit) => [
    { pick: commit, verb: 'pick' as const },
    ...commit.branches.map((updateRef) => ({ updateRef })),
  ]);
  const same = (a: Step, b?: Step) =>
    b !== undefined &&
    ('pick' in a ? 'pick' in b && a.verb === 'pick' && a.pick.sha === b.pick.sha : 'updateRef' in b && a.updateRef === b.updateRef);
  let kept = 0;
  while (kept < steps.length && same(steps[kept], current[kept])) kept++;
  // A fold needs the commit it folds into inside the todo, so the rebase starts below that commit.
  while (kept > 0 && folds(steps[kept])) kept--;
  if (kept === steps.length && kept === current.length) {
    good('the plan matches the stack as it is; nothing to move');
    return;
  }
  const lastKept = steps.slice(0, kept).findLast((step) => 'pick' in step);
  const lastCommit = lastKept && 'pick' in lastKept ? lastKept.pick : undefined;
  const rebaseBase = lastCommit?.sha ?? base;

  const branchOf = new Map([...own].flatMap(([branch, commits]) => commits.map((commit) => [commit.sha, branch] as const)));
  const was = (commit: Commit) => branchOf.get(commit.sha) ?? wip;
  const goes = (commit: Commit) => planned.targets.get(commit.sha) ?? wip;
  const foldedInto = new Map<string, Commit>();
  let into: Commit | undefined;
  for (const step of steps) {
    if (!('pick' in step)) continue;
    if (step.verb === 'pick') into = step.pick;
    else foldedInto.set(step.pick.sha, into!);
  }
  const order = planned.order;
  const moved = line.filter((commit) => !foldedInto.has(commit.sha) && was(commit) !== goes(commit));
  printByBranch([...order, wip], goes, moved);
  for (const [sha, target] of foldedInto) {
    console.log(`${yellow('fold')}${commitLine(line.find((commit) => commit.sha === sha)!)}\n  into${commitLine(target)}`);
  }
  printOrderChanges(branches, order);
  console.log(`${bold('base')}  ${lastCommit ? commitLine(lastCommit).trim() : cyan(base)}`);

  const { todo, sequence, pick } = newTodo();
  let sectionStart = 0;
  for (const step of steps.slice(kept)) {
    if ('pick' in step) {
      const movesBranch = step.verb === 'pick' && was(step.pick) !== goes(step.pick);
      pick(step.pick, movesBranch ? `${MOVED_MARKER} ` : '', step.verb);
      continue;
    }
    const marker = branchMarker(step.updateRef, branches, order);
    if (marker) todo.splice(sectionStart, 0, marker);
    todo.push(`update-ref refs/heads/${step.updateRef}`, '');
    sectionStart = todo.length;
  }
  return { todo, sequence, rebaseBase };
};

const applyStack = (planned?: Planned, preview = dryRun) => {
  const wip = currentBranch();
  heading(preview ? 'Plan (dry run)' : 'Plan');
  const rebase = planned?.steps ? fullRebase(wip, planned.steps, planned) : shortRebase(wip, planned);
  if (!rebase) return;
  const { todo, sequence, rebaseBase } = rebase;

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
    explainConflict(simulation, tipOf(rebaseBase));
    console.log('rerere may already hold a resolution for it; the preview cannot tell.');
  }
  if (preview) return;
  if (!simulation.ok && !rest.includes('--anyway')) {
    console.log('\nNothing rewritten. Change the plan (export, edit, apply), or resolve it by hand:');
    console.log('  stack-plan apply -f');
    process.exit(1);
  }
  if (!existsSync(planPath())) throw new Error('No stackplan.txt to record the pre-rebase tip in; run stack-plan export first');

  // Each fold as <folded>><target>; range-diff may report either one as dropped, so verify accepts both.
  const folded: string[] = [];
  sequence.forEach(({ commit, fold }, index) => {
    if (fold) folded.push(`${commit.sha}>${sequence.findLast((replay, at) => at < index && !replay.fold)!.commit.sha}`);
  });
  recordPreRebase(tipOf(wip), folded);
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
  todo.split('\n').flatMap((line) => /^(?:pick|p|fixup|f|squash|s)\s+([0-9a-f]+)/.exec(line)?.[1] ?? []);

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

const setMode = () => {
  const [wanted] = rest;
  if (wanted === 'full') git('config', MODE_KEY, 'full');
  else if (wanted === 'short' && readConfig(MODE_KEY)) git('config', '--unset', MODE_KEY);
  heading('Mode');
  const full = fullMode();
  console.log(`${bold(full ? 'full' : 'short')}  export lists ${full ? 'every commit since the base' : 'only the commits waiting to move'}`);
  if (wanted) console.log('Run stack-plan export to write the plan in this mode.');
};

try {
  if (command === 'export') exportPlan();
  else if (command === 'save' || command === 'preview' || command === 'apply') {
    const planned = savePlan();
    // Full mode always passes the plan, because notes cannot hold the order within a branch.
    if (command === 'preview') applyStack(dryRun || planned.steps ? planned : undefined, true);
    else if (command === 'apply') applyStack(planned.steps ? planned : undefined);
  }
  else if (command === 'verify') verifyRebase();
  else if (command === 'mode') setMode();
  else if (command === 'prepare') prepareRebase();
  else if (command === 'cut') cutStack(cutAt!, rest.includes('--apply'));
  else if (command === '_todo') editTodo(args[0]);
} catch (error) {
  console.error(redErr(`✗ ${(error as Error).message}`));
  process.exit(1);
}
