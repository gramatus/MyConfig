#!/usr/bin/env node
// Moves commits waiting on the current branch into stack branches, and reorders or adds those branches.
// Usage: stack-plan export|save|preview|apply|prepare|verify|cut|sync|extract|extractable|mode [-b <ref>] [-n] [-f]; run without arguments for details.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const NOTES_REF = 'refs/notes/target';
const UNTAGGED_MARKER =
  '# ---- untagged: move each line above the update-ref of its branch ----';
const EXPORTED_AT_PREFIX = '# exported-at: ';
const PRE_REBASE_PREFIX = '# pre-rebase: ';
const MODE_PREFIX = '# mode: ';
const FOLDED_PREFIX = '# folded: ';
const CUT_PREFIX = '# cut: ';
const SYNC_PREFIX = '# sync: ';
const MOVED_MARKER = '>>> [moved]';
const LOCAL_MARKER = '>>> [local]';
const MOVED_BRANCH_MARKER = '>>> [moved branch]';
const NEW_BRANCH_MARKER = '>>> [new branch]';
const PRS_STOP_MARKER = '# --- PRs stop here ---';
const OTHER_STACKS_STOP_MARKER = '# --- Other stacks stop here ---';
const MIRROR_STATUS_PREFIX = '# mirror: ';
const EXTRACT_SOURCE_PREFIX = '__';
const ORDER_KEY = 'stackplan.order';
const NEW_KEY = 'stackplan.new';
const MODE_KEY = 'stackplan.mode';

// Colour only a terminal, and never when NO_COLOR is set (https://no-color.org).
const colourOn = (stream: NodeJS.WriteStream) =>
  !process.env.NO_COLOR && stream.isTTY === true;
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

const heading = (title: string) =>
  console.log(
    `\n${bold(`── ${title} ${'─'.repeat(Math.max(3, 46 - title.length))}`)}`,
  );
const subheading = (title: string) =>
  console.log(
    `\n${bold(`────── ${title} ${'─'.repeat(Math.max(3, 42 - title.length))}`)}`,
  );
const good = (text: string) => console.log(`${green('✓')} ${text}`);
const attention = (text: string) => console.log(`${yellow('!')} ${text}`);
const bad = (text: string) => console.log(`${red('✗')} ${text}`);
const commitLine = (commit: { sha: string; subject: string }) =>
  `  ${yellow(commit.sha.slice(0, 10))}  ${commit.subject}`;

const shellQuote = (arg: string) =>
  /^[\w@%+=:,./^-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

const traceGit = (args: string[]) => {
  if (verbose) console.error(dimErr(`$ git ${args.map(shellQuote).join(' ')}`));
};

const git = (...args: string[]) => {
  traceGit(args);
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(
      `git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`,
    );
  }
};

const USAGE = [
  'Usage: stack-plan <command> [-b|--base <ref>] [-n|--dry-run] [-f|--anyway] [--apply] [--verbose]',
  '  --verbose echoes each git command it runs to stderr',
  '  export (e)   write the plan file',
  '  save (s)     write notes from the plan',
  '  preview      save, then preview the rebase; -n also leaves the notes unwritten',
  '  apply (a)    save, then rebase the stack; -f runs it despite a predicted conflict',
  '  prepare      record the pre-rebase tip before a rebase run by hand',
  '  verify (v)   compare the stack with the pre-rebase tip',
  '  cut <branch> check that dropping the branches up to <branch> and rebasing the rest onto the base loses no work;',
  '               --apply then does it, and -f does it despite a finding',
  '  sync         check putting each stack branch on its origin copy, with what origin lacks replayed on top',
  '               and merged branches cut; --apply then does it, and -f does it despite a finding;',
  '               it fetches and prunes origin first, unless --no-fetch',
  '  extract      check copying each __ branch onto the branch named without the prefix, off the stack;',
  '               --apply then moves those branches, and -f moves the clean ones despite a finding',
  '  extractable  list the branches above the PRs that could become __ branches, as far as the text shows;',
  "               --json prints each chain with every member's start and replay commits",
  '  mode [full|short]  show or set what export lists: full is every commit, short only the waiting ones',
].join('\n');

const EXPANSIONS: Record<string, string[]> = {
  e: ['export'],
  s: ['save'],
  a: ['apply'],
  v: ['verify'],
};
const FLAG_ALIASES: Record<string, string> = {
  '-b': '--base',
  '-n': '--dry-run',
  '-f': '--anyway',
};
const ALLOWED_FLAGS: Record<string, string[]> = {
  export: ['--base'],
  save: ['--base', '--dry-run'],
  preview: ['--base', '--dry-run'],
  apply: ['--base', '--anyway'],
  prepare: [],
  verify: ['--base', '--dry-run'],
  cut: ['--base', '--apply', '--anyway'],
  sync: ['--base', '--apply', '--anyway', '--no-fetch'],
  extract: ['--base', '--apply', '--anyway'],
  extractable: ['--base', '--json'],
  mode: ['full', 'short'],
};

const [given = '', ...args] = process.argv.slice(2);
const [command, ...implied] = EXPANSIONS[given] ?? [given];
const verbose = args.includes('--verbose');
const rest = [
  ...implied,
  ...args
    .filter((arg) => arg !== '--verbose')
    .map((arg) => FLAG_ALIASES[arg] ?? arg),
];

const usageError = (message?: string): never => {
  if (message) console.error(redErr(`✗ ${message}`));
  console.error(USAGE);
  process.exit(2);
};
let cutAt: string | undefined;
if (command !== '_todo') {
  const allowed =
    ALLOWED_FLAGS[command] ??
    usageError(given ? `unknown command "${given}"` : undefined);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--base' && allowed.includes('--base')) i++;
    else if (command === 'cut' && !cutAt && !rest[i].startsWith('-'))
      cutAt = rest[i];
    else if (!allowed.includes(rest[i]))
      usageError(`${rest[i]} does not apply to ${given}`);
  }
  if (command === 'mode' && rest.length > 1)
    usageError('mode takes one of full or short');
  if (command === 'cut' && !cutAt) usageError('cut needs the branch to cut at');
}

const optionValue = (name: string) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const base = optionValue('--base') ?? 'origin/main';
const dryRun = rest.includes('--dry-run');
const asJson = rest.includes('--json');

type Commit = {
  sha: string;
  subject: string;
  branches: string[];
  note: string;
};
type Verb = 'pick' | 'fixup' | 'squash' | 'amend';
type Step = { pick: Commit; verb: Verb } | { updateRef: string };
type Replay = { commit: Commit; fold: boolean };
const VERBS: Record<string, Verb> = {
  pick: 'pick',
  p: 'pick',
  fixup: 'fixup',
  f: 'fixup',
  squash: 'squash',
  s: 'squash',
};
const todoVerb = (verb: Verb) => (verb === 'amend' ? 'fixup -C' : verb);
const folds = (step?: Step) =>
  step !== undefined && 'pick' in step && step.verb !== 'pick';

const FOLD_PREFIXES: [string, Verb][] = [
  ['fixup!', 'fixup'],
  ['squash!', 'squash'],
  ['amend!', 'amend'],
];
type Fold = { verb: Verb; into: Commit };

// As git rebase --autosquash: the outer prefix gives the verb, and the subject under every prefix names an earlier commit.
const foldsBySubject = (line: Commit[]) => {
  const folding = new Map<string, Fold>();
  const unmatched: Commit[] = [];
  const prefixOf = (text: string) =>
    FOLD_PREFIXES.find(([prefix]) => text.startsWith(prefix));
  line.forEach((commit, index) => {
    const outer = prefixOf(commit.subject);
    if (!outer) return;
    let named = commit.subject;
    let found: typeof outer | undefined = outer;
    while (found) {
      named = named.slice(found[0].length).trimStart();
      found = prefixOf(named);
    }
    const earlier = line.slice(0, index);
    const target = !named
      ? undefined
      : (earlier.find(
          (candidate) =>
            !folding.has(candidate.sha) && candidate.subject === named,
        ) ??
        (/^[0-9a-f]{4,40}$/.test(named)
          ? earlier.find((candidate) => candidate.sha.startsWith(named))
          : undefined) ??
        earlier.find((candidate) => candidate.subject.startsWith(named)));
    if (target)
      folding.set(commit.sha, {
        verb: outer[1],
        into: folding.get(target.sha)?.into ?? target,
      });
    else unmatched.push(commit);
  });
  const foldsInto = (target: Commit) =>
    line.filter((commit) => folding.get(commit.sha)?.into.sha === target.sha);
  return { folding, unmatched, foldsInto };
};

const printFold = (commit: Commit, into: Commit) =>
  console.log(
    `${yellow('fold')}${commitLine(commit)}\n  into${commitLine(into)}`,
  );

const warnUnmatched = (unmatched: Commit[]) => {
  for (const commit of unmatched)
    attention(
      `the subject asks for a fold, but no earlier commit since ${base} matches it, so it stays a commit:\n${commitLine(commit)}`,
    );
};

let root: string | undefined;
const repoRoot = () => (root ??= git('rev-parse', '--show-toplevel').trim());
const planPath = () =>
  join(repoRoot(), '.agent-context/active-work-context/stackplan.txt');
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
const isAncestor = (ancestor: string, descendant: string) =>
  gitSucceeds('merge-base', '--is-ancestor', ancestor, descendant);
const branchExists = (branch: string) =>
  gitSucceeds('show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
const isExtractSource = (branch: string) =>
  branch.startsWith(EXTRACT_SOURCE_PREFIX);
const extractedNameOf = (source: string) =>
  source.slice(EXTRACT_SOURCE_PREFIX.length);

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
  const stored = words(readConfig(ORDER_KEY)).filter(
    (branch) => current.includes(branch) || waiting.includes(branch),
  );
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
  for (let i = run.indexOf(Math.max(0, ...run)); i >= 0; i = previous[i])
    kept.add(existing[i]);
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
  if (!value)
    throw new Error(`No "${prefix.trim()}" line in the plan; ${remedy}`);
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
  writeFileSync(
    planPath(),
    lines.filter((line) => !line.startsWith(prefix)).join('\n'),
  );
};

// Sets the tip verify compares against, and replaces the folds and cut of any earlier rebase with this one's.
const recordPreRebase = (sha: string, folded: string[]) => {
  writeHeader(PRE_REBASE_PREFIX, sha);
  if (folded.length) writeHeader(FOLDED_PREFIX, folded.join(' '));
  else dropHeader(FOLDED_PREFIX);
  dropHeader(CUT_PREFIX);
  dropHeader(SYNC_PREFIX);
  logPreRebase(sha);
};

const ensurePlanFile = (wip: string) => {
  if (existsSync(planPath())) return;
  mkdirSync(dirname(planPath()), { recursive: true });
  writeFileSync(
    planPath(),
    `# stack-plan for ${wip}, holding the pre-rebase tip for verify\n`,
  );
};

// For a rebase run by hand, so verify has a tip to compare against afterwards.
const prepareRebase = () => {
  const wip = currentBranch();
  ensurePlanFile(wip);
  const sha = tipOf(wip);
  recordPreRebase(sha, []);
  heading('Prepare');
  good(
    `recorded ${yellow(sha.slice(0, 10))} as the pre-rebase tip of ${cyan(wip)}`,
  );
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
  const rank = (branch: string) =>
    stored.includes(branch) ? stored.indexOf(branch) : stored.length;
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
    const branches = refs
      ? refs.split(', ').map((ref) => ref.replace(/^HEAD -> /, ''))
      : [];
    const stack = branches
      .filter((branch) => branch !== wip)
      .sort((a, b) => rank(a) - rank(b));
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
  return {
    line,
    branches: line.flatMap((commit) => commit.branches),
    pending: line.slice(topIndex + 1),
    own,
  };
};

const printOrderChanges = (current: string[], order: string[]) => {
  const below = (branch: string) => order[order.indexOf(branch) - 1] ?? base;
  for (const branch of order.filter((name) => !current.includes(name)))
    console.log(`${cyan(branch)}  new, above ${below(branch)}`);
  for (const branch of movedBranches(current, order))
    console.log(`${cyan(branch)}  moves above ${below(branch)}`);
};

// For loops of hundreds of calls, where echoing each one would bury the output.
const gitQuiet = (...args: string[]) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const treeOf = (ref: string) => gitQuiet('rev-parse', `${ref}^{tree}`).trim();

const fileExistsIn = (ref: string, file: string) => {
  try {
    gitQuiet('cat-file', '-e', `${ref}:${file}`);
    return true;
  } catch {
    return false;
  }
};

type Merge =
  | { ok: true; tree: string }
  | { ok: false; files: string[]; tree: string; messages: string[] };

// A three-way merge in memory: the tree it would produce, or the conflicted files, the tree with markers, and git's messages.
const mergeTree = (
  mergeBase: string,
  ours: string,
  theirs: string,
  options: string[] = [],
): Merge => {
  try {
    const merged = gitQuiet(
      'merge-tree',
      '--write-tree',
      '--name-only',
      ...options,
      `--merge-base=${mergeBase}`,
      ours,
      theirs,
    );
    return { ok: true, tree: merged.split('\n')[0] };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (failure.status !== 1) throw error;
    const [tree, ...listed] = (failure.stdout ?? '').split('\n');
    const end = Math.max(0, listed.indexOf(''));
    return {
      ok: false,
      files: [...new Set(listed.slice(0, end))],
      tree,
      messages: listed.slice(end + 1),
    };
  }
};

type Conflict = {
  at: number;
  commit: Commit;
  files: string[];
  tree: string;
  messages: string[];
  before: Commit[];
  // An earlier conflict in the same files had its resolution assumed, so this one may only follow from that guess.
  assumed: boolean;
  takenWhole: string[];
};
type Simulation = {
  picks: number;
  conflicts: Conflict[];
  sameTree: boolean;
  tip: string;
  tipAfterPick: string[];
};

// Writes a tree from another, with each file replaced by its version in a commit, or removed where the commit has none.
const replaceFiles = (tree: string, commit: string, files: string[]) => {
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(
      git('rev-parse', '--absolute-git-dir').trim(),
      'stack-plan-preview-index',
    ),
  };
  const run = (...args: string[]) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  run('read-tree', tree);
  for (const file of files) {
    const [mode, , blob] = gitQuiet('ls-tree', commit, '--', file).split(/\s+/);
    if (blob)
      run('update-index', '--add', '--cacheinfo', `${mode},${blob},${file}`);
    else run('update-index', '--force-remove', '--', file);
  }
  return run('write-tree').trim();
};

// Replays the planned picks in memory, resolving each conflict to the pick's side so later ones are found too.
const simulateRebase = (
  sequence: Replay[],
  start: string,
  wip: string,
): Simulation => {
  if (verbose) {
    console.error(
      dimErr(
        `$ git merge-tree --write-tree --name-only --merge-base=<pick>^ <state> <pick>    (per pick)`,
      ),
    );
    console.error(
      dimErr(
        `$ git commit-tree <tree> -p <state> -m 'stack-plan preview' --no-gpg-sign  (per pick)`,
      ),
    );
    console.error(
      dimErr(
        `  (a fixup or squash commits onto <state>'s parent instead, replacing <state>)`,
      ),
    );
    console.error(
      dimErr(
        `  (on a conflict: merge-tree -X theirs, then the pick's own version of any file still conflicted)`,
      ),
    );
  }
  const conflicts: Conflict[] = [];
  const tipAfterPick: string[] = [];
  let state = start;
  let parent = start;
  for (const [index, { commit, fold }] of sequence.entries()) {
    let merged = mergeTree(`${commit.sha}^`, state, commit.sha);
    if (!merged.ok) {
      const before = sequence.slice(0, index).map((replay) => replay.commit);
      const { files, tree, messages } = merged;
      const assumed = conflicts.some((earlier) =>
        earlier.files.some((file) => files.includes(file)),
      );
      const conflict: Conflict = {
        at: index,
        commit,
        files,
        tree,
        messages,
        before,
        assumed,
        takenWhole: [],
      };
      conflicts.push(conflict);
      merged = mergeTree(`${commit.sha}^`, state, commit.sha, ['-X', 'theirs']);
      if (!merged.ok) {
        conflict.takenWhole = merged.files;
        merged = {
          ok: true,
          tree: replaceFiles(merged.tree, commit.sha, merged.files),
        };
      }
    }
    if (!fold) parent = state;
    state = gitQuiet(
      'commit-tree',
      merged.tree,
      '-p',
      parent,
      '-m',
      'stack-plan preview',
      '--no-gpg-sign',
    ).trim();
    tipAfterPick.push(state);
  }
  return {
    picks: sequence.length,
    conflicts,
    sameTree: treeOf(state) === treeOf(wip),
    tip: state,
    tipAfterPick,
  };
};

const MARKER_OPEN = /^<{7}(?: |$)/;
const MARKER_SPLIT = /^(?:={7}|\|{7})(?: |$)/;
const MARKER_CLOSE = /^>{7}(?: |$)/;

// Counts the marked regions the merge left in a file, and the lines inside them across both sides.
const conflictSize = (tree: string, file: string) => {
  let regions = 0;
  let lines = 0;
  let inside = false;
  const text = fileExistsIn(tree, file)
    ? gitQuiet('cat-file', '-p', `${tree}:${file}`)
    : '';
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
  fileList(
    gitQuiet('diff-tree', '-r', '--root', '--no-commit-id', '--name-only', sha),
  ).some((file) => files.includes(file));

const subjectOf = (sha: string) => ({
  sha,
  subject: gitQuiet('show', '-s', '--format=%s', sha).trim(),
});

const oneLine = (commit: { sha: string; subject: string }) =>
  commitLine(commit).trim();

// Sizes each conflicted file, and names the commits on those files that the pick now comes after, or no longer does.
const explainConflict = (
  conflict: Conflict,
  start: string,
  landing?: Landing,
  alreadyNamed: string[] = [],
) => {
  const { commit, files, tree, messages, before } = conflict;
  const sizes = files.map((file) => {
    const message =
      messages.find(
        (line) => line.startsWith('CONFLICT') && line.includes(file),
      ) ?? '';
    const kind = /^CONFLICT \(([^)]+)\)/.exec(message)?.[1] ?? 'content';
    const { regions, lines } = conflictSize(tree, file);
    const size = regions
      ? `${regions} region${regions === 1 ? '' : 's'}, ${lines} lines`
      : 'no text markers';
    return `${file}  ${size}${kind === 'content' ? '' : `  (${kind})`}`;
  });
  const wasBelow = new Set(
    fileList(gitQuiet('rev-list', `${start}..${commit.sha}^`)),
  );
  const isBelow = new Set(before.map((below) => below.sha));
  const unnamed = (culprit: { sha: string }) =>
    !alreadyNamed.includes(culprit.sha);
  // From the base side: commits the pick now sits on that it did not before, as after a cut or a moved branch.
  const fromBase = fileList(
    gitQuiet(
      'log',
      '--format=%H',
      '--max-count=6',
      `${commit.sha}..${start}`,
      '--',
      ...files,
    ),
  );
  const nowAfter = [
    ...before.filter(
      (below) => !wasBelow.has(below.sha) && changesAny(below.sha, files),
    ),
    ...fromBase.map(subjectOf),
  ];
  const nowBefore = [...wasBelow]
    .filter((sha) => !isBelow.has(sha) && changesAny(sha, files))
    .map(subjectOf);
  const fromBaseShas = new Set(fromBase);
  const where = (culprit: { sha: string }) => {
    const branch = fromBaseShas.has(culprit.sha)
      ? 'base'
      : landing?.landsOn.get(culprit.sha);
    return branch ? `  → ${cyan(branch)}` : '';
  };
  const causes = [
    ...nowAfter
      .filter(unnamed)
      .slice(0, 6)
      .map((culprit) => `now after  ${oneLine(culprit)}${where(culprit)}`),
    ...(fromBase.length > 5 || nowAfter.length > 6
      ? ['now after  more commits on those files']
      : []),
    ...nowBefore
      .filter(unnamed)
      .map((culprit) => `now before ${oneLine(culprit)}${where(culprit)}`),
  ];
  if (!nowAfter.length && !nowBefore.length)
    causes.push('no commit that moved relative to it changes those files');
  return { sizes, causes, nowBefore };
};

type Landing = { landsOn: Map<string, string>; order: string[] };

// A pick lands on the first update-ref after it in the todo, or on wip when none follows.
const landingBranches = (todo: string[], wip: string): Landing => {
  const landsOn = new Map<string, string>();
  const order = [wip];
  for (const line of [...todo].reverse()) {
    const ref = /^update-ref refs\/heads\/(.+)$/.exec(line)?.[1];
    if (ref) order.unshift(ref);
    else {
      const sha = /^(?:pick|fixup|squash)\s+(?:-C\s+)?([0-9a-f]+)/.exec(
        line,
      )?.[1];
      if (sha) landsOn.set(sha, order[0]);
    }
  }
  return { landsOn, order };
};

// The lowest branch the pick can land on and still come after every commit it now jumps ahead of.
const orderKeepingBranch = (
  landing: Landing,
  pick: string,
  jumpedAhead: { sha: string }[],
) => {
  const positions = jumpedAhead.map((culprit) =>
    landing.order.indexOf(landing.landsOn.get(culprit.sha) ?? ''),
  );
  const highest = Math.max(-1, ...positions);
  if (
    highest < 0 ||
    highest <= landing.order.indexOf(landing.landsOn.get(pick) ?? '')
  )
    return;
  const branch = cyan(landing.order[highest]);
  return highest === landing.order.length - 1
    ? `land it on ${branch}`
    : `land it on ${branch} or a branch above it`;
};

const reportConflicts = (
  simulation: Simulation,
  start: string,
  took = '',
  landing?: Landing,
) => {
  const { conflicts, picks } = simulation;
  // A conflict in files an earlier one shares goes under it, since it may only follow from the guessed resolution.
  const groups: Conflict[][] = [];
  for (const conflict of conflicts) {
    const shares = (earlier: Conflict) =>
      earlier.files.some((file) => conflict.files.includes(file));
    const cause = conflict.assumed
      ? groups.findLast((group) => group.some(shares))
      : undefined;
    if (cause) cause.push(conflict);
    else groups.push([conflict]);
  }
  for (const group of groups) {
    const [first, ...followOns] = group;
    const branch = landing?.landsOn.get(first.commit.sha);
    console.log(
      `\n${oneLine(first.commit)}${branch ? `  → ${cyan(branch)}` : ''}`,
    );
    const { sizes, causes, nowBefore } = explainConflict(first, start, landing);
    for (const cause of causes) console.log(`  ${cause}`);
    console.log('  conflicting in:');
    for (const size of sizes) console.log(`    ${size}`);
    const keepOrder =
      landing && orderKeepingBranch(landing, first.commit.sha, nowBefore);
    for (const [index, conflict] of followOns.entries()) {
      const named = group
        .slice(0, index + 1)
        .map((earlier) => earlier.commit.sha);
      const followOn = explainConflict(conflict, start, landing, named);
      if (index === 0)
        console.log(
          '  then, after a guessed resolution of that, also conflicting:',
        );
      console.log(`    ${oneLine(conflict.commit)}`);
      for (const line of [...followOn.sizes, ...followOn.causes])
        console.log(`      ${line}`);
    }
    for (const conflict of group.filter((member) => member.takenWhole.length)) {
      console.log(
        `  assumed for what follows: ${conflict.commit.sha.slice(0, 10)}'s own version of ${conflict.takenWhole.join(', ')}`,
      );
    }
    if (keepOrder) console.log(`  to keep the old order: ${keepOrder}`);
  }
  console.log(
    '\nrerere may already hold resolutions for these; the preview cannot tell.',
  );
  bad(
    `${groups.length} conflict${groups.length === 1 ? '' : 's'}, in ${conflicts.length} of ${picks} picks${took}`,
  );
};

// Whitespace and line numbers do not count, so the same change on a moved base gets the same id.
const patchId = (from: string, to: string, path?: string) => {
  const diff = gitQuiet('diff', from, to, ...(path ? ['--', path] : []));
  if (!diff) return '';
  return execFileSync('git', ['patch-id', '--stable'], {
    input: diff,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  }).split(' ')[0];
};

const fileList = (output: string) => output.split('\n').filter(Boolean);

// Whether from..to and onFrom..onTo make the same change; false when some file ends differently.
const sameNetChange = (
  label: string,
  from: string,
  to: string,
  onFrom: string,
  onTo: string,
  onName: string,
) => {
  if (patchId(from, to) === patchId(onFrom, onTo)) {
    good(`the net change of ${label} is the same on ${onName}`);
    return true;
  }
  const files = new Set([
    ...fileList(gitQuiet('diff', '--name-only', from, to)),
    ...fileList(gitQuiet('diff', '--name-only', onFrom, onTo)),
  ]);
  const differing = [...files].filter(
    (file) => patchId(from, to, file) !== patchId(onFrom, onTo, file),
  );
  // A file that ends the same lost nothing: the new base already had that part of the change.
  const blob = (ref: string, file: string) =>
    fileExistsIn(ref, file)
      ? gitQuiet('rev-parse', `${ref}:${file}`).trim()
      : '';
  const landed = differing.filter(
    (file) => blob(onTo, file) === blob(to, file),
  );
  const missing = differing.filter((file) => !landed.includes(file));
  if (landed.length) {
    attention(
      `part of ${label} is already in ${onName}, so these files end the same:`,
    );
    for (const file of landed) console.log(`    ${file}`);
  }
  if (!missing.length) {
    good(`the rest of the net change of ${label} is the same on ${onName}`);
    return true;
  }
  bad(
    `the net change of ${label} differs on ${onName}, and these files end differently:`,
  );
  for (const file of missing) console.log(`    ${file}`);
  return false;
};

// Git exits 0 when it pauses at an edit or break, and non-zero when it refuses to start, so the rebase state decides.
const exitUnlessRebaseFinished = (status: number | null) => {
  const inProgress = existsSync(
    gitQuiet(
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'rebase-merge',
    ).trim(),
  );
  if (status !== 0 && !inProgress) {
    bad('the rebase did not start; see the message above');
    process.exit(status ?? 1);
  }
  if (status !== 0) {
    attention(
      'the rebase stopped. Resolve it and run `git rebase --continue`, then: stack-plan verify',
    );
    process.exit(status ?? 1);
  }
  if (inProgress) {
    attention(
      'the rebase paused for an edit. When done: `git rebase --continue`, then: stack-plan verify',
    );
    process.exit(0);
  }
};

// Checks whether cutting the stack at a branch and rebasing the rest onto the base would lose work; --apply then does it.
const cutStack = (at: string, apply: boolean) => {
  const wip = currentBranch();
  const { line, branches } = readStack(wip);
  if (!branches.includes(at))
    throw new Error(
      `${at} is not a stack branch below ${wip}; the stack is: ${branches.join(' ')}`,
    );
  heading(`Cut at ${at}, onto ${base}`);
  let lost = 0;
  let unclear = 0;

  // Per branch, since a squash merge leaves only a branch's end state in the base.
  subheading(`Below the cut: already in ${base}?`);
  const below = branches.slice(0, branches.indexOf(at) + 1);
  const fork = git('merge-base', base, wip).trim();
  for (const [index, branch] of below.entries()) {
    const merged = mergeTree(
      index === 0 ? fork : tipOf(below[index - 1]),
      base,
      branch,
    );
    if (!merged.ok) {
      unclear++;
      attention(
        `${cyan(branch)}  can't tell: ${base} changed these again since, so compare by hand`,
      );
      for (const file of merged.files) console.log(`    ${file}`);
    } else if (merged.tree === treeOf(base))
      good(`${cyan(branch)}  contained in ${base}`);
    else {
      lost++;
      bad(`${cyan(branch)}  would be lost: ${base} lacks its changes to`);
      for (const file of fileList(
        gitQuiet('diff', '--name-only', base, merged.tree),
      ))
        console.log(`    ${file}`);
    }
  }

  subheading(`Above the cut: rebased onto ${base}`);
  const above = line.slice(
    line.findIndex((commit) => commit.branches.includes(at)) + 1,
  );
  if (!above.length) good('no commits above the cut');
  else {
    const simulation = simulateRebase(
      above.map((commit) => ({ commit, fold: false })),
      tipOf(base),
      wip,
    );
    if (simulation.conflicts.length) {
      unclear++;
      reportConflicts(simulation, tipOf(base));
    } else {
      good(`all ${simulation.picks} picks apply cleanly in memory`);
      if (
        !sameNetChange(
          `${at}..${wip}`,
          at,
          wip,
          tipOf(base),
          simulation.tip,
          base,
        )
      )
        lost++;
    }
  }

  subheading('Conclusion');
  if (lost) bad(`cutting at ${at} would lose work; see the files above`);
  else if (unclear)
    attention(`no loss found, but some of it needs a look by hand; see above`);
  else good(`cutting at ${at} and rebasing onto ${base} loses no work`);
  if (!apply) {
    if (!lost && !unclear)
      console.log(`To do it: stack-plan cut ${at} --apply`);
    if (lost || unclear) process.exit(1);
    return;
  }
  if ((lost || unclear) && !rest.includes('--anyway')) {
    console.log(
      `\nNothing rewritten. To cut anyway: stack-plan cut ${at} --apply -f`,
    );
    process.exit(1);
  }

  const cutTip = tipOf(at);
  ensurePlanFile(wip);
  recordPreRebase(tipOf(wip), []);
  writeHeader(CUT_PREFIX, [cutTip, tipOf(base), ...below].join(' '));
  // A commit the base already holds becomes empty, and the check above already counted it as landed.
  const args = [
    'rebase',
    '-i',
    '--update-refs',
    '--empty=drop',
    '--onto',
    base,
    cutTip,
  ];
  heading('Rebase');
  traceGit(args);
  exitUnlessRebaseFinished(spawnSync('git', args, { stdio: 'inherit' }).status);
  verifyRebase();
};

const commitsIn = (range: string): Commit[] =>
  fileList(
    gitQuiet('log', '--reverse', '--first-parent', '--format=%H%x1f%s', range),
  ).map((record) => {
    const [sha, subject] = record.split('\x1f');
    return { sha, subject, branches: [], note: '' };
  });

const messageAndAuthorOf = (sha: string) =>
  gitQuiet('show', '-s', '--format=%an%x00%ae%x00%B', sha);

// Merges and empty commits get no patch-id.
const patchIdsIn = (range: string) => {
  const log = gitQuiet(
    'log',
    '-p',
    '--no-merges',
    '--no-color',
    '--no-ext-diff',
    '--format=commit %H',
    range,
  );
  const idOfSha = new Map<string, string>();
  if (!log.trim()) return idOfSha;
  const output = execFileSync('git', ['patch-id', '--stable'], {
    input: log,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  for (const [id, sha] of fileList(output).map((entry) => entry.split(' ')))
    idOfSha.set(sha, id);
  return idOfSha;
};

const remoteOf = (branch: string) => {
  const upstream = git(
    'for-each-ref',
    '--format=%(upstream:short)',
    `refs/heads/${branch}`,
  ).trim();
  const remote = upstream || `origin/${branch}`;
  return gitSucceeds('rev-parse', '--verify', '--quiet', `${remote}^{commit}`)
    ? remote
    : undefined;
};

const countOf = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

// A sync may change a file at the tip only where origin's stack differs from the local one.
const sameTipOutsideOrigin = (
  oldTop: string,
  oldTip: string,
  newTop: string,
  newTip: string,
) => {
  const originDiffers = new Set(
    fileList(gitQuiet('diff', '--name-only', oldTop, newTop)),
  );
  const changed = fileList(gitQuiet('diff', '--name-only', oldTip, newTip));
  const unexpected = changed.filter((file) => !originDiffers.has(file));
  if (!changed.length) {
    good('the tip tree is identical to the old one');
    return true;
  }
  if (!unexpected.length) {
    good(
      `the tip tree is unchanged, except ${countOf(changed.length, 'file')} where origin's stack differs from yours`,
    );
    return true;
  }
  bad(`the tip tree changes outside origin's changes, in:`);
  for (const file of unexpected) console.log(`    ${file}`);
  return false;
};

// Puts each stack branch on its origin copy, replays what origin lacks on top, and cuts branches merged into the base.
const syncStack = (apply: boolean) => {
  if (!rest.includes('--no-fetch')) {
    const fetchArgs = ['fetch', '--prune', 'origin'];
    traceGit(fetchArgs);
    if (spawnSync('git', fetchArgs, { stdio: 'inherit' }).status !== 0)
      throw new Error(
        'git fetch failed; run again with --no-fetch to use the refs as they are',
      );
  }
  const wip = currentBranch();
  const { branches, pending, own } = readStack(wip);
  const fork = git('merge-base', base, wip).trim();
  const remoteOfBranch = new Map(
    branches.flatMap((branch) => {
      const remote = remoteOf(branch);
      return remote ? [[branch, remote] as const] : [];
    }),
  );
  const highestRemote = branches
    .map((branch) => remoteOfBranch.get(branch))
    .findLast(Boolean);
  if (!highestRemote)
    throw new Error('no stack branch is on origin; nothing to sync with');
  heading(`Sync with origin, onto ${base}`);
  let findings = 0;

  subheading(`Below origin's stack`);
  // Origin's stack is the run of origin branches, from the top down, each sitting on the one below; it has moved past the rest.
  const branchesOnOrigin = branches.filter((branch) =>
    remoteOfBranch.has(branch),
  );
  const remoteAt = (index: number) =>
    remoteOfBranch.get(branchesOnOrigin[index])!;
  let lowestInOriginStack = branchesOnOrigin.length - 1;
  while (
    lowestInOriginStack > 0 &&
    isAncestor(remoteAt(lowestInOriginStack - 1), remoteAt(lowestInOriginStack))
  )
    lowestInOriginStack--;
  const lowestOnOrigin = branches.indexOf(
    branchesOnOrigin[lowestInOriginStack],
  );
  const cut: string[] = [];
  let unclearCuts = 0;
  for (const branch of branches.slice(0, lowestOnOrigin)) {
    if (isAncestor(tipOf(branch), highestRemote)) {
      attention(
        `${cyan(branch)}  not on origin, but origin's stack still sits on it, so it stays`,
      );
      break;
    }
    const merged = mergeTree(
      cut.length ? tipOf(cut.at(-1)!) : fork,
      base,
      branch,
    );
    cut.push(branch);
    const leftOnOrigin = remoteOfBranch.has(branch)
      ? ` (${remoteOfBranch.get(branch)} is left behind)`
      : '';
    if (merged.ok && merged.tree === treeOf(base)) {
      good(`${cyan(branch)}  cut, contained in ${base}${leftOnOrigin}`);
      continue;
    }
    unclearCuts++;
    const files = merged.ok
      ? fileList(gitQuiet('diff', '--name-only', base, merged.tree))
      : merged.files;
    const why = merged.ok
      ? `${base} lacks part of it`
      : `${base} changed these again since`;
    attention(
      `${cyan(branch)}  cut${leftOnOrigin}, but ${why}; compare by hand:`,
    );
    for (const file of files) console.log(`    ${file}`);
  }
  if (!cut.length) good(`no branch below origin's stack to cut`);

  const kept = branches.slice(cut.length);
  const adopted = kept.filter((branch) => remoteOfBranch.has(branch));
  if (!adopted.length)
    throw new Error(
      'no stack branch above the cut is on origin; nothing to sync with',
    );
  const topBranch = adopted.at(-1)!;
  const topRemote = remoteOfBranch.get(topBranch)!;
  const onto = git('merge-base', base, remoteOfBranch.get(adopted[0])!).trim();
  let below = { name: base, sha: onto };
  for (const remote of adopted.map((branch) => remoteOfBranch.get(branch)!)) {
    if (!isAncestor(below.sha, remote))
      throw new Error(
        `${remote} does not sit on ${below.name}; origin's stack is not one line`,
      );
    below = { name: remote, sha: remote };
  }
  if (git('rev-list', '--merges', `${onto}..${topRemote}`).trim()) {
    throw new Error(
      `origin's stack holds merge commits, which the rebase cannot replay; sync by hand`,
    );
  }

  const originCommits = commitsIn(`${onto}..${topRemote}`);
  const originShas = new Set(originCommits.map((commit) => commit.sha));
  const originShaById = new Map(
    [...patchIdsIn(`${onto}..${topRemote}`)].map(([sha, id]) => [id, sha]),
  );
  const localCommits = commitsIn(`${fork}..${wip}`);
  const localShas = new Set(localCommits.map((commit) => commit.sha));
  const localIdOfSha = patchIdsIn(`${fork}..${wip}`);
  const localIds = new Set(localIdOfSha.values());
  const originIdOfSha = new Map(
    [...originShaById].map(([id, sha]) => [sha, id]),
  );
  const newToLocal = (commit: Commit) =>
    !localShas.has(commit.sha) &&
    !localIds.has(originIdOfSha.get(commit.sha) ?? '');
  const originCopyOf = (commit: Commit) =>
    originShas.has(commit.sha)
      ? undefined
      : originShaById.get(localIdOfSha.get(commit.sha) ?? '');
  const notOnOrigin = (commit: Commit) =>
    !originShas.has(commit.sha) && !originCopyOf(commit);

  subheading('Branches');
  const { todo, sequence, pick } = newTodo();
  const dropped: Commit[] = cut.flatMap((branch) => own.get(branch) ?? []);
  let belowRemote = onto;
  let newFromOrigin = 0;
  let picksUpToTop = 0;
  for (const branch of kept) {
    const remote = remoteOfBranch.get(branch);
    const fromOrigin = remote ? commitsIn(`${belowRemote}..${remote}`) : [];
    const local = own.get(branch) ?? [];
    const replaced = local.filter((commit) => originCopyOf(commit));
    const carried = local.filter(notOnOrigin);
    for (const commit of fromOrigin) pick(commit);
    for (const commit of carried) pick(commit, `${LOCAL_MARKER} `);
    todo.push(`update-ref refs/heads/${branch}`, '');
    if (branch === topBranch) picksUpToTop = sequence.length;
    dropped.push(...replaced);
    if (remote) belowRemote = remote;

    const newCount = fromOrigin.filter(newToLocal).length;
    newFromOrigin += fromOrigin.filter(
      (commit) => !localShas.has(commit.sha),
    ).length;
    if (!remote)
      attention(
        `${cyan(branch)}  not on origin: ${countOf(carried.length, 'commit')} replayed`,
      );
    else if (!newCount && !replaced.length && !carried.length)
      good(`${cyan(branch)}  in sync with ${remote}`);
    else {
      const parts = [
        `${newCount} new from origin`,
        `${replaced.length} replaced by origin's copy`,
        `${carried.length} kept local`,
      ];
      console.log(`${cyan(branch)}  ${remote}  ${parts.join(' · ')}`);
      for (const commit of carried)
        console.log(`  ${yellow('local')}${commitLine(commit)}`);
    }
    const reworded = replaced.filter(
      (commit) =>
        messageAndAuthorOf(commit.sha) !==
        messageAndAuthorOf(originCopyOf(commit)!),
    );
    if (reworded.length) {
      findings++;
      attention(
        `${countOf(reworded.length, 'commit')} reworded locally; syncing drops that, so push instead`,
      );
    } else if (replaced.length) {
      good(
        `${countOf(replaced.length, 'commit')} only rebased locally; syncing is safe`,
      );
    }
  }
  const pendingReplaced = pending.filter((commit) => originCopyOf(commit));
  const pendingKept = pending.filter(notOnOrigin);
  for (const commit of pendingKept) pick(commit);
  dropped.push(...pendingReplaced);
  const replacedNote = pendingReplaced.length
    ? `, ${pendingReplaced.length} replaced by origin's copy`
    : '';
  console.log(
    `${cyan(wip)}  ${countOf(pendingKept.length, 'commit')} replayed${replacedNote}; its own origin copy is left alone`,
  );

  subheading(`Origin against ${base}`);
  if (onto !== fork && isAncestor(onto, fork)) {
    const lost = commitsIn(`${onto}..${fork}`);
    console.log(
      `syncing moves the stack back onto origin's base, taking ${countOf(lost.length, 'commit')} of ${base} out from under it:`,
    );
    for (const commit of lost) console.log(commitLine(commit));
  }
  // Branches above the lowest conflicting one carry its conflict, so only that one is listed.
  let mergesCleanly = true;
  for (const remote of adopted.map((branch) => remoteOfBranch.get(branch)!)) {
    const merged = mergeTree(onto, base, remote);
    if (merged.ok) continue;
    attention(
      `${remote} conflicts with ${base}, and syncing keeps that; rebase onto ${base} and push to fix it:`,
    );
    for (const file of merged.files) console.log(`    ${file}`);
    mergesCleanly = false;
    break;
  }
  if (mergesCleanly)
    good(`origin's stack merges into ${base} without conflicts`);

  if (!cut.length && !dropped.length && !newFromOrigin) {
    console.log('');
    good('the stack is already in line with origin; nothing to sync');
    return;
  }

  subheading('Preview');
  const simulation = simulateRebase(sequence, onto, wip);
  if (simulation.conflicts.length) {
    findings++;
    reportConflicts(simulation, onto, '', landingBranches(todo, wip));
  } else {
    good(`all ${simulation.picks} picks apply cleanly in memory`);
    const newTop = picksUpToTop
      ? simulation.tipAfterPick[picksUpToTop - 1]
      : onto;
    const sameAboveTop = sameNetChange(
      `${topBranch}..${wip}`,
      topBranch,
      wip,
      newTop,
      simulation.tip,
      topBranch,
    );
    const sameTip = sameTipOutsideOrigin(
      tipOf(topBranch),
      wip,
      newTop,
      simulation.tip,
    );
    if (!sameAboveTop || !sameTip) findings++;
    if (unclearCuts && treeOf(simulation.tip) === treeOf(wip)) {
      good(`so the cut branches lose nothing, whatever their checks above say`);
      unclearCuts = 0;
    }
  }
  findings += unclearCuts;

  subheading('Conclusion');
  if (findings) attention('some of it needs a look by hand; see above');
  else
    good(
      `every local commit is on origin or replayed on top, and ${countOf(dropped.length, 'commit')} give way to origin's copy or the base`,
    );
  if (!apply) {
    if (findings) process.exit(1);
    console.log('To do it: stack-plan sync --apply');
    return;
  }
  if (findings && !rest.includes('--anyway')) {
    console.log(
      '\nNothing rewritten. To sync anyway: stack-plan sync --apply -f',
    );
    process.exit(1);
  }

  ensurePlanFile(wip);
  recordPreRebase(tipOf(wip), []);
  writeHeader(
    SYNC_PREFIX,
    [onto, fork, tipOf(topBranch), tipOf(topRemote), topBranch, ...cut].join(
      ' ',
    ),
  );
  const drops = dropped.map((commit) => `drop ${commit.sha} ${commit.subject}`);
  const syncTodo = [
    ...(drops.length
      ? ['# on origin under another SHA, or merged into the base', ...drops, '']
      : []),
    ...todo,
  ];
  // Rebasing from the fork makes git's todo exactly the local commits, so the plan accounts for each one.
  runRebase(
    syncTodo,
    ['rebase', '-i', '--update-refs', '--empty=drop', '--onto', onto, fork],
    [...originShas],
  );
};

// Matches by patch-id; a commit with none, such as an empty one, counts as already there.
const compareWithExtracted = (
  sourceCommits: Commit[],
  extracted: string,
  extractedFork: string,
) => {
  const sourceIdOfSha = sourceCommits.length
    ? patchIdsIn(`${sourceCommits[0].sha}^..${sourceCommits.at(-1)!.sha}`)
    : new Map<string, string>();
  const sourceIds = new Set(sourceIdOfSha.values());
  const extractedIds = new Set(
    patchIdsIn(`${extractedFork}..${extracted}`).values(),
  );
  const missing = sourceCommits.filter((commit) => {
    const id = sourceIdOfSha.get(commit.sha);
    return id !== undefined && !extractedIds.has(id);
  });
  const extraCount = [...extractedIds].filter(
    (id) => !sourceIds.has(id),
  ).length;
  return { missing, extraCount };
};

// Where an extracted branch's own commits start: the latest point it shares with the base or a lower extracted copy.
const extractedForkOf = (extracted: string, extractedBelow: string[]) => {
  let fork = git('merge-base', base, extracted).trim();
  for (const below of extractedBelow.filter(branchExists)) {
    const forkOnBelow = git('merge-base', below, extracted).trim();
    if (forkOnBelow !== fork && isAncestor(fork, forkOnBelow))
      fork = forkOnBelow;
  }
  return fork;
};

const replaysOf = (commits: Commit[]): Replay[] =>
  commits.map((commit) => ({ commit, fold: false }));

type Stack = ReturnType<typeof readStack>;

const commitsOfBranches = (stack: Stack, group: string[]) =>
  stack.branches
    .filter((branch) => group.includes(branch))
    .flatMap((branch) => stack.own.get(branch) ?? []);

// Grows the group by the branches each conflict needs, until it applies onto the base or needs one that may not join.
const standaloneGroup = (
  stack: Stack,
  wip: string,
  branch: string,
  mayJoin: (branch: string) => boolean,
): { group: string[]; directNeeds: string[]; blocker?: string } => {
  const { branches, own } = stack;
  let group = [branch];
  const directNeeds: string[] = [];
  for (;;) {
    const [conflict] = simulateRebase(
      replaysOf(commitsOfBranches(stack, group)),
      tipOf(base),
      wip,
    ).conflicts;
    if (!conflict)
      return {
        group: branches.filter((b) => group.includes(b)),
        directNeeds: branches.filter((b) => directNeeds.includes(b)),
      };
    const files = conflict.files.join(', ');
    const conflictAt = branches.findIndex((b) =>
      (own.get(b) ?? []).some((commit) => commit.sha === conflict.commit.sha),
    );
    const needs = branches
      .slice(0, conflictAt)
      .filter(
        (below) =>
          !group.includes(below) &&
          (own.get(below) ?? []).some((commit) =>
            changesAny(commit.sha, conflict.files),
          ),
      );
    if (!needs.length)
      return {
        group,
        directNeeds,
        blocker: `conflicts with ${base} itself (${files})`,
      };
    const barred = needs.filter((need) => !mayJoin(need));
    if (barred.length)
      return {
        group,
        directNeeds,
        blocker: `needs ${barred.join(', ')} (${files})`,
      };
    if (branches[conflictAt] === branch) directNeeds.push(...needs);
    group = [...group, ...needs];
  }
};

// Merges groups that share a branch, each in stack order, lowest group first.
const mergeGroups = (groups: string[][], branches: string[]) => {
  let merged: string[][] = [];
  for (const group of groups) {
    const overlapping = merged.filter((other) =>
      other.some((branch) => group.includes(branch)),
    );
    const union = new Set([...group, ...overlapping.flat()]);
    merged = [
      ...merged.filter((other) => !overlapping.includes(other)),
      branches.filter((branch) => union.has(branch)),
    ];
  }
  return merged.sort((a, b) => branches.indexOf(a[0]) - branches.indexOf(b[0]));
};

const copyCommit = (sha: string, tree: string, parent: string) => {
  const [name, email, date, message] = gitQuiet(
    'show',
    '-s',
    '--format=%an%x00%ae%x00%aI%x00%B',
    sha,
  ).split('\0');
  return execFileSync('git', ['commit-tree', tree, '-p', parent, '-F', '-'], {
    input: `${message.trimEnd()}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
    },
  }).trim();
};

type ExtractReplay =
  | { ok: true; tip: string }
  | { ok: false; commit: Commit; files: string[] };

// Writes real commits, and stops at the first conflict rather than guessing past it.
const replayOnto = (commits: Commit[], start: string): ExtractReplay => {
  let tip = start;
  for (const commit of commits) {
    const merged = mergeTree(`${commit.sha}^`, tip, commit.sha);
    if (!merged.ok) return { ok: false, commit, files: merged.files };
    tip = copyCommit(commit.sha, merged.tree, tip);
  }
  return { ok: true, tip };
};

/** Returns the comment line export writes above a __ branch, giving the state of its extracted copy. */
const mirrorStatus = (
  source: string,
  sourcesBelow: string[],
  sourceCommits: Commit[],
  pulls?: Map<string, PullRequest>,
) => {
  const extracted = extractedNameOf(source);
  if (!branchExists(extracted))
    return `${MIRROR_STATUS_PREFIX}${extracted} · not extracted`;
  const { missing, extraCount } = compareWithExtracted(
    sourceCommits,
    extracted,
    extractedForkOf(extracted, sourcesBelow.map(extractedNameOf)),
  );
  const pull = pulls?.get(extracted);
  const parts = [
    extracted,
    ...(pulls ? [pull ? `PR #${pull.number}` : 'no PR'] : []),
    missing.length
      ? `${countOf(missing.length, 'commit')} behind`
      : 'up to date',
    ...(extraCount
      ? [`${countOf(extraCount, 'commit')} only on ${extracted}`]
      : []),
  ];
  return `${MIRROR_STATUS_PREFIX}${parts.join(' · ')}`;
};

// Copies each __ branch's commits onto the branch named without the prefix, off the stack; --apply moves those refs.
const extractBranches = (apply: boolean) => {
  const wip = currentBranch();
  const stack = readStack(wip);
  const { branches, own } = stack;
  const sources = branches.filter(isExtractSource);
  heading(`Extract onto ${base}`);
  if (!sources.length) {
    good(`no ${EXTRACT_SOURCE_PREFIX} branch in the stack; nothing to extract`);
    return;
  }
  const blockerOf = new Map<string, string>();
  const groups: string[][] = [];
  for (const source of sources.filter((name) => own.get(name)?.length)) {
    const { group, blocker } = standaloneGroup(
      stack,
      wip,
      source,
      isExtractSource,
    );
    if (blocker) blockerOf.set(source, blocker);
    else groups.push(group);
  }
  const chains = mergeGroups(groups, branches);
  const moves: { extracted: string; tip: string; oldTip: string }[] = [];
  const plannedTip = new Map<string, string>();
  let findings = 0;
  const reportConflict = (
    label: string,
    onto: string,
    replay: ExtractReplay,
  ) => {
    if (replay.ok) return;
    findings++;
    bad(`${label}  conflicts on ${onto}, at`);
    console.log(commitLine(replay.commit));
    for (const file of replay.files) console.log(`    ${file}`);
  };

  subheading('Branches');
  sources.forEach((source, i) => {
    const extracted = extractedNameOf(source);
    const commits = own.get(source) ?? [];
    const label = `${cyan(source)} → ${cyan(extracted)}`;
    if (branches.includes(extracted)) {
      findings++;
      bad(`${label}  ${extracted} is a stack branch too; rename one of them`);
      return;
    }
    if (!commits.length) {
      attention(`${label}  no commits of its own; nothing to extract`);
      return;
    }
    if (branchExists(extracted)) {
      const oldTip = tipOf(extracted);
      plannedTip.set(extracted, oldTip);
      const { missing, extraCount } = compareWithExtracted(
        commits,
        extracted,
        extractedForkOf(extracted, sources.slice(0, i).map(extractedNameOf)),
      );
      if (extraCount) {
        findings++;
        attention(
          `${label}  has ${countOf(extraCount, 'commit')} ${source} lacks, such as a review fix; bring them into ${source} first`,
        );
        return;
      }
      if (!missing.length) {
        good(`${label}  up to date`);
        return;
      }
      const replay = replayOnto(missing, oldTip);
      if (!replay.ok) return reportConflict(label, extracted, replay);
      good(`${label}  +${countOf(missing.length, 'commit')}`);
      moves.push({ extracted, tip: replay.tip, oldTip });
      plannedTip.set(extracted, replay.tip);
      return;
    }
    const blocker = blockerOf.get(source);
    if (blocker) {
      findings++;
      bad(`${label}  ${blocker}`);
      return;
    }
    // A branch in a chain goes on the copy of the one below it there, so each copy holds all it needs.
    const chain = chains.find((members) => members.includes(source)) ?? [];
    const chainedOn = chain[chain.indexOf(source) - 1];
    const onto = chainedOn ? extractedNameOf(chainedOn) : base;
    const start = chainedOn ? plannedTip.get(onto) : tipOf(base);
    if (!start) {
      findings++;
      bad(`${label}  goes on ${onto}, which could not be made; see above`);
      return;
    }
    const replay = replayOnto(commits, start);
    if (!replay.ok) return reportConflict(label, onto, replay);
    good(`${label}  new on ${onto}`);
    moves.push({ extracted, tip: replay.tip, oldTip: '' });
    plannedTip.set(extracted, replay.tip);
  });

  subheading('Conclusion');
  const branchCount = `${moves.length} branch${moves.length === 1 ? '' : 'es'}`;
  if (findings) attention('some of it needs a look by hand; see above');
  else if (moves.length) good(`${branchCount} to create or move forward`);
  else good('every extracted branch is up to date');
  if (!apply) {
    if (moves.length)
      console.log(
        `To do it: stack-plan extract --apply${findings ? ' -f' : ''}`,
      );
    if (findings) process.exit(1);
    return;
  }
  if (findings && !rest.includes('--anyway')) {
    console.log(
      '\nNo branch moved. To move the clean ones anyway: stack-plan extract --apply -f',
    );
    process.exit(1);
  }
  // An empty old value makes update-ref refuse a branch created since the check, and a SHA one moved since.
  for (const move of moves) {
    git(
      'update-ref',
      '-m',
      'stack-plan extract',
      `refs/heads/${move.extracted}`,
      move.tip,
      move.oldTip,
    );
    good(`${cyan(move.extracted)}  now at ${yellow(move.tip.slice(0, 10))}`);
  }
};

// Tries each branch above the PRs and the __ block onto the base alone, and moved down to just above them.
const extractableBranches = () => {
  const wip = currentBranch();
  const stack = readStack(wip);
  const { branches, own, pending } = stack;
  const pulls = openPullRequests();
  if (!asJson) heading(`Extractable onto ${base}`);
  if (!pulls && !asJson)
    attention(
      `could not list PRs with gh, so only the ${EXTRACT_SOURCE_PREFIX} block holds branches back`,
    );
  const anchorAt = branches.findLastIndex(
    (branch) => isExtractSource(branch) || pulls?.has(branch),
  );
  const movable = (branch: string) => branches.indexOf(branch) > anchorAt;
  const branchOfSha = new Map(
    branches.flatMap((branch) =>
      (own.get(branch) ?? []).map((commit) => [commit.sha, branch] as const),
    ),
  );
  const commitsOf = (group: string[]) => commitsOfBranches(stack, group);

  const moveConflict = (group: string[]) => {
    const start =
      anchorAt >= 0
        ? tipOf(branches[anchorAt])
        : git('merge-base', base, wip).trim();
    const stayingAbove = branches
      .slice(anchorAt + 1)
      .filter((branch) => !group.includes(branch));
    const sequence = [
      ...commitsOf(group),
      ...commitsOf(stayingAbove),
      ...pending,
    ];
    const [conflict] = simulateRebase(
      replaysOf(sequence),
      start,
      wip,
    ).conflicts;
    if (!conflict) return;
    const where = branchOfSha.get(conflict.commit.sha) ?? wip;
    return `${where} conflicts after the move (${conflict.files.join(', ')})`;
  };

  const tested = branches.filter(movable);
  const needsOf = new Map<string, string[]>();
  const directNeedsOf = new Map<string, string[]>();
  const blockerOf = new Map<string, string>();
  for (const branch of tested.filter((name) => own.get(name)?.length)) {
    const { group, directNeeds, blocker } = standaloneGroup(
      stack,
      wip,
      branch,
      movable,
    );
    if (blocker) blockerOf.set(branch, blocker);
    else {
      needsOf.set(branch, group);
      directNeedsOf.set(branch, directNeeds);
    }
  }
  for (const branch of tested.filter((name) => !own.get(name)?.length))
    blockerOf.set(branch, 'no commits of its own');
  const baseSha = tipOf(base);
  // The commit each member's replay onto the base ends at, for checking that it builds there.
  const replayTipsOf = (chain: string[]) => {
    const commits = commitsOf(chain);
    const replay = simulateRebase(replaysOf(commits), baseSha, wip);
    const tips = new Map<string, string>();
    if (replay.conflicts.length) return tips;
    for (const branch of chain) {
      const last = own.get(branch)?.at(-1);
      if (last) tips.set(branch, replay.tipAfterPick[commits.indexOf(last)]);
    }
    return tips;
  };
  const chainReports = mergeGroups([...needsOf.values()], branches).map(
    (chain) => {
      const tips = replayTipsOf(chain);
      return {
        moveConflict: moveConflict(chain) ?? null,
        members: chain.map((name, at) => ({
          name,
          needs: directNeedsOf.get(name) ?? [],
          start: tips.size ? (tips.get(chain[at - 1]) ?? baseSha) : null,
          replay: tips.get(name) ?? null,
        })),
      };
    },
  );
  const extractable = new Set(
    chainReports
      .filter((report) => !report.moveConflict)
      .flatMap((report) => report.members.map((member) => member.name)),
  );

  if (asJson) {
    const blocked = [...blockerOf].map(([name, reason]) => ({ name, reason }));
    const report = { base, baseSha, wip, prsListed: Boolean(pulls) };
    console.log(
      JSON.stringify({ ...report, chains: chainReports, blocked }, null, 2),
    );
    return;
  }

  type ChainReport = (typeof chainReports)[number];
  const reportChain = ({ moveConflict, members }: ChainReport) => {
    const replaysTo = (replay: string | null) =>
      replay ? ` · replays to ${yellow(replay.slice(0, 10))}` : '';
    const name = members.map((member) => cyan(member.name)).join(' → ');
    const singleTip = members.length === 1 ? replaysTo(members[0].replay) : '';
    if (moveConflict) attention(`${name}  but ${moveConflict}${singleTip}`);
    else good(`${name}  moves down cleanly${singleTip}`);
    if (!members[0].replay)
      attention(`  the chain conflicts on ${base} when replayed as one`);
    if (members.length === 1) return;
    for (const member of members) {
      const needsText = member.needs.length
        ? `needs ${member.needs.join(', ')}`
        : 'stands alone';
      console.log(
        `    ${member.name}  ${needsText}${replaysTo(member.replay)}`,
      );
    }
  };

  subheading(`Stand alone on ${base}`);
  const singles = chainReports.filter((report) => report.members.length === 1);
  if (!singles.length) console.log('none');
  for (const report of singles) reportChain(report);

  subheading('Chains, each extracted as one stack in this order');
  const stacked = chainReports.filter((report) => report.members.length > 1);
  if (!stacked.length) console.log('none');
  for (const report of stacked) reportChain(report);

  subheading('Cannot leave');
  if (!blockerOf.size) console.log('none');
  for (const [branch, blocker] of blockerOf) {
    if (own.get(branch)?.length) bad(`${cyan(branch)}  ${blocker}`);
    else attention(`${cyan(branch)}  ${blocker}`);
  }

  subheading('Conclusion');
  if (!extractable.size) {
    attention('no branch can leave the stack as it stands');
    return;
  }
  good(
    `${extractable.size} branch${extractable.size === 1 ? '' : 'es'} can leave the stack as far as the text shows; nothing checked that they build`,
  );
  console.log(
    `To mark them, rename each, move its update-ref line into the ${EXTRACT_SOURCE_PREFIX} block with each chain in its order, and apply:`,
  );
  for (const branch of branches.filter((name) => extractable.has(name)))
    console.log(`  git branch -m ${branch} ${EXTRACT_SOURCE_PREFIX}${branch}`);
};

// Prints commits under their branch, in stack order.
const printByBranch = (
  order: string[],
  branchOf: (commit: Commit) => string,
  commits: Commit[],
  label = cyan,
) => {
  for (const branch of order) {
    const group = commits.filter((commit) => branchOf(commit) === branch);
    if (!group.length) continue;
    console.log(label(branch));
    for (const commit of group) console.log(commitLine(commit));
  }
};

const pickLine = (commit: Commit, marker = '') =>
  `pick ${commit.sha.slice(0, 10)} ${marker}${commit.subject}`;

type PullRequest = { number: number; base: string };

/** Open pull requests keyed by head branch, or undefined when gh cannot list them. */
const openPullRequests = (): Map<string, PullRequest> | undefined => {
  let origin: string;
  try {
    origin = git('remote', 'get-url', 'origin').trim();
  } catch {
    return undefined;
  }
  const slug = origin.replace(/\.git$/, '').replace(/^.*github\.com[:/]/, '');
  const fields = ['--json', 'number,headRefName,baseRefName'];
  const result = spawnSync(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      slug,
      '--state',
      'open',
      '--limit',
      '500',
      ...fields,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return undefined;
  const rows = JSON.parse(result.stdout) as {
    number: number;
    headRefName: string;
    baseRefName: string;
  }[];
  return new Map(
    rows.map((row) => [
      row.headRefName,
      { number: row.number, base: row.baseRefName },
    ]),
  );
};

const exportPlan = () => {
  const wip = currentBranch();
  const full = fullMode();
  const { line, branches: current, pending, own } = readStack(wip);
  const { folding, unmatched, foldsInto } = foldsBySubject(line);
  // An order saved but not yet rebased is exported as planned, like the notes are.
  const branches = desiredOrder(current);
  const sections = new Map<string, Commit[]>(
    [...branches, wip].map((branch) => [branch, []]),
  );
  const untagged: Commit[] = [];
  const strayNotes: Commit[] = [];
  const waiting = pending.filter((commit) => !folding.has(commit.sha));
  // Short mode lists no fold, since the subject decides it; the comment only shows where it goes.
  const foldLines = (target: Commit) =>
    foldsInto(target).map((commit) => {
      const verb = todoVerb(folding.get(commit.sha)!.verb);
      const listed = `${verb} ${commit.sha.slice(0, 10)} ${commit.subject}`;
      return full
        ? listed
        : `# fold ${listed} → into ${target.sha.slice(0, 10)}`;
    });
  const linesOf = (commits: Commit[], marker = '') =>
    commits
      .filter((commit) => !folding.has(commit.sha))
      .flatMap((commit) => [pickLine(commit, marker), ...foldLines(commit)]);
  for (const commit of waiting) {
    const section = sections.get(commit.note);
    if (section) section.push(commit);
    else {
      if (commit.note) strayNotes.push(commit);
      untagged.push(commit);
    }
  }

  // The pre-rebase tip belongs to the last rebase, not to this export, so it carries over.
  const lastPreRebase = existsSync(planPath())
    ? readHeader(PRE_REBASE_PREFIX)
    : undefined;
  const lastFolded = existsSync(planPath())
    ? readHeader(FOLDED_PREFIX)
    : undefined;
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
          '# fixup, squash or fixup -C in place of pick folds that commit into the pick above it.',
        ]
      : []),
    ...(folding.size
      ? [
          '# A fixup!, squash! or amend! commit folds into the commit its subject names, after that',
          `# commit, wherever it goes${full ? '' : '; its # fold line shows where, and save ignores it'}.`,
        ]
      : []),
    '',
  ];
  const pulls = openPullRequests();
  const prWarnings: string[] = [];
  let stopAt = branches.length;
  branches.forEach((branch, i) => {
    const pull = pulls?.get(branch);
    if (!pull) {
      stopAt = Math.min(stopAt, i);
      return;
    }
    const sourceBelow = branches.slice(0, i).find(isExtractSource);
    if (sourceBelow)
      prWarnings.push(
        `#${pull.number} (${branch}) sits above ${sourceBelow}, so pushing it carries that branch's commits`,
      );
    else if (stopAt < i)
      prWarnings.push(
        `#${pull.number} (${branch}) sits above a branch with no PR`,
      );
    const below = i ? branches[i - 1] : base.replace(/^origin\//, '');
    if (pull.base !== below)
      prWarnings.push(
        `#${pull.number} (${branch}) targets ${pull.base}, not ${below}`,
      );
  });

  const sources = branches.filter(isExtractSource);
  const firstSourceAt = branches.findIndex(isExtractSource);
  const sourcesSplit = branches
    .slice(firstSourceAt, firstSourceAt + sources.length)
    .some((branch) => !isExtractSource(branch));

  // Marked as apply's todo marks them, so the file shows what the notes and saved order would move.
  branches.forEach((branch, i) => {
    const marker = branchMarker(branch, current, branches);
    const status = isExtractSource(branch)
      ? mirrorStatus(
          branch,
          sources.slice(0, sources.indexOf(branch)),
          own.get(branch) ?? [],
          pulls,
        )
      : undefined;
    const ownCommits = own.get(branch) ?? [];
    const inBranch = full
      ? linesOf(ownCommits)
      : ownCommits.flatMap((commit) => foldLines(commit));
    const moving = linesOf(sections.get(branch)!, `${MOVED_MARKER} `);
    if (pulls && i === stopAt) out.push(PRS_STOP_MARKER);
    out.push(
      ...(marker ? [marker] : []),
      ...(status ? [status] : []),
      ...inBranch,
      ...moving,
      `update-ref refs/heads/${branch}\n`,
      ...(branch === sources.at(-1) ? [OTHER_STACKS_STOP_MARKER] : []),
    );
  });
  if (pulls && stopAt === branches.length) out.push(PRS_STOP_MARKER);
  out.push(
    ...linesOf(sections.get(wip)!),
    UNTAGGED_MARKER,
    ...linesOf(untagged),
    '',
  );

  const path = planPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, out.join('\n'));

  heading(full ? 'Export (full)' : 'Export');
  console.log(`${bold('wrote')}  ${path}`);
  const inBranches = full
    ? ` · ${line.length - pending.length} in branches`
    : '';
  const folded = folding.size ? ` · ${folding.size} fold by subject` : '';
  console.log(
    `${waiting.length} waiting · ${waiting.length - untagged.length} placed${inBranches}${folded} · ${branches.length} stack branches`,
  );
  warnUnmatched(unmatched);
  if (untagged.length)
    attention(`${untagged.length} untagged, below the marker`);
  else good('every waiting commit is placed');
  for (const commit of strayNotes)
    attention(
      `note "${commit.note}" names no stack branch:\n${commitLine(commit)}`,
    );
  if (!pulls) attention('could not list PRs with gh; no PR marker in the file');
  for (const warning of prWarnings) attention(warning);
  if (sourcesSplit)
    attention(
      `the ${EXTRACT_SOURCE_PREFIX} branches are not one block; the other-stacks marker follows the last one`,
    );
};

const savePlan = () => {
  const wip = currentBranch();
  const { line: history, branches, pending } = readStack(wip);
  const { folding } = foldsBySubject(history);
  const full = readHeader(MODE_PREFIX) === 'full';
  const listable = full
    ? history
    : pending.filter((commit) => !folding.has(commit.sha));
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
      const fields = line.split(/\s+/);
      const amends = /^(?:fixup|f)$/.test(fields[0]) && fields[1] === '-C';
      const [verb, arg = ''] = amends ? [fields[0], fields[2]] : fields;
      if (verb === 'update-ref') {
        if (pastMarker)
          errors.push(`${where}: update-ref below the untagged marker`);
        const branch = arg.replace(/^refs\/heads\//, '');
        updateRefs.push(branch);
        steps.push({ updateRef: branch });
        for (const sha of held) targets.set(sha, branch);
        held = [];
      } else if (Object.hasOwn(VERBS, verb)) {
        const kind = amends ? 'amend' : VERBS[verb];
        const commit = listable.find((candidate) =>
          candidate.sha.startsWith(arg),
        );
        const foldBySubject = arg
          ? history.find(
              (candidate) =>
                candidate.sha.startsWith(arg) && folding.has(candidate.sha),
            )
          : undefined;
        const scope = full ? `in ${base}..${wip}` : `waiting on ${wip}`;
        if (kind !== 'pick' && !full)
          errors.push(
            `${where}: ${todoVerb(kind)} needs full mode (stack-plan mode full)`,
          );
        // Folding across an update-ref would leave the branch on the commit before the fold.
        else if (
          kind !== 'pick' &&
          !(steps.at(-1) && 'pick' in steps.at(-1)!)
        ) {
          errors.push(
            `${where}: ${todoVerb(kind)} must follow a pick in the same branch`,
          );
        } else if (kind === 'pick' && foldBySubject) {
          const { verb: folds, into } = folding.get(foldBySubject.sha)!;
          errors.push(
            `${where}: ${arg} folds into ${into.sha.slice(0, 10)} by its subject, so it cannot be a pick; ${full ? `make it ${todoVerb(folds)}` : 'leave it out, or export again'}`,
          );
        } else if (!commit)
          errors.push(`${where}: ${arg} is not ${scope}; export again`);
        else if (listed.has(commit.sha))
          errors.push(`${where}: ${arg} is listed twice`);
        else {
          listed.add(commit.sha);
          steps.push({ pick: commit, verb: kind });
          if (kind !== 'pick') folded.add(commit.sha);
          if (pastMarker) targets.set(commit.sha, undefined);
          else held.push(commit.sha);
        }
      } else
        errors.push(
          `${where}: expected pick, fixup, fixup -C, squash or update-ref, got "${verb}"`,
        );
    });

  if (!pastMarker) errors.push('the untagged marker line is missing');
  // A folded commit stops existing, so its note goes rather than piling onto the commit it folds into.
  for (const sha of [...folded, ...folding.keys()]) targets.set(sha, undefined);
  if (full !== fullMode()) {
    errors.push(
      `the plan was exported in ${full ? 'full' : 'short'} mode, and the mode is now ${full ? 'short' : 'full'}; export again`,
    );
  }
  const created = updateRefs.filter((branch) => !branches.includes(branch));
  const recorded = requireHeader(EXPORTED_AT_PREFIX, 'export again');
  const current = tipOf(wip);
  // Commits added on top since export are fine; a rewritten wip means the file's SHAs are gone.
  const addedSinceExport = new Set<string>();
  const rewritten = recorded !== current && !isAncestor(recorded, current);
  if (rewritten) {
    // Every SHA in the file is gone, so per-line errors would only repeat this one.
    errors.splice(
      0,
      errors.length,
      `${wip} was rewritten since export (was ${recorded.slice(0, 10)}); export again`,
    );
  } else {
    for (const sha of git(
      'rev-list',
      '--first-parent',
      `${recorded}..${current}`,
    ).split('\n')) {
      if (sha) addedSinceExport.add(sha);
    }
    for (const branch of branches) {
      if (!updateRefs.includes(branch))
        errors.push(
          `update-ref ${branch} is missing; every stack branch keeps its line`,
        );
    }
    for (const branch of new Set(updateRefs)) {
      if (updateRefs.indexOf(branch) !== updateRefs.lastIndexOf(branch))
        errors.push(`update-ref ${branch} is listed twice`);
    }
    for (const branch of created) {
      if (!gitSucceeds('check-ref-format', '--branch', branch))
        errors.push(`${branch} is not a valid branch name`);
      else if (branchExists(branch))
        errors.push(`${branch} already exists outside the stack`);
    }
    const lowest = updateRefs[0];
    if (created.includes(lowest) && ![...targets.values()].includes(lowest)) {
      errors.push(
        `${lowest} is new and empty at the bottom of the stack, where git cannot tell it from ${base}`,
      );
    }
    for (const commit of listable) {
      if (!listed.has(commit.sha) && !addedSinceExport.has(commit.sha)) {
        errors.push(
          `${commit.sha.slice(0, 10)} is missing from the plan: ${commit.subject}`,
        );
      }
    }
  }

  heading(dryRun ? 'Save (dry run)' : 'Save');
  if (errors.length) {
    bad('no notes written');
    for (const error of errors) console.log(`  ${error}`);
    process.exit(1);
  }

  const toTag = pending.filter(
    (commit) =>
      (listed.has(commit.sha) || folding.has(commit.sha)) &&
      (targets.get(commit.sha) ?? '') !== commit.note,
  );
  const tagged = toTag.filter((commit) => targets.get(commit.sha));
  const untagged = toTag.filter((commit) => !targets.get(commit.sha));
  printByBranch(
    [...updateRefs, wip],
    (commit) => targets.get(commit.sha) ?? '',
    tagged,
    (branch) => cyan(branch === wip ? `${branch} (stays)` : branch),
  );
  if (untagged.length) {
    console.log(yellow('untag'));
    for (const commit of untagged) console.log(commitLine(commit));
  }
  if (!dryRun) {
    for (const commit of tagged)
      git(
        'notes',
        `--ref=${NOTES_REF}`,
        'add',
        '-f',
        '-m',
        targets.get(commit.sha)!,
        commit.sha,
      );
    for (const commit of untagged)
      git('notes', `--ref=${NOTES_REF}`, 'remove', commit.sha);
  }
  if (toTag.length)
    good(`${toTag.length} notes ${dryRun ? 'would change' : 'changed'}`);
  else good('notes already match the plan');

  printOrderChanges(branches, updateRefs);
  if (
    updateRefs.join(' ') !== readConfig(ORDER_KEY) ||
    created.join(' ') !== readConfig(NEW_KEY)
  ) {
    if (!dryRun) {
      git('config', ORDER_KEY, updateRefs.join(' '));
      if (created.length) git('config', NEW_KEY, created.join(' '));
      else if (readConfig(NEW_KEY)) git('config', '--unset', NEW_KEY);
    }
    good(
      `stack order ${dryRun ? 'would be saved' : 'saved'} in git config ${ORDER_KEY}`,
    );
  }

  const unplaced = pending.filter(
    (commit) => addedSinceExport.has(commit.sha) && !listed.has(commit.sha),
  );
  const leftUntagged = unplaced.filter((commit) => !folding.has(commit.sha));
  if (leftUntagged.length) {
    attention('left untagged, committed after export:');
    for (const commit of leftUntagged) console.log(commitLine(commit));
  }
  if (current !== recorded) {
    if (!dryRun) writeHeader(EXPORTED_AT_PREFIX, current);
    console.log(
      `${dryRun ? 'would move' : 'moved'} the plan's exported-at to ${yellow(current.slice(0, 10))}`,
    );
  }
  for (const pick of unplaced) {
    const fold = folding.get(pick.sha);
    if (!fold) {
      steps.push({ pick, verb: 'pick' });
      continue;
    }
    let at = steps.findIndex(
      (step) => 'pick' in step && step.pick.sha === fold.into.sha,
    );
    while (folds(steps[at + 1])) at++;
    steps.splice(at + 1, 0, { pick, verb: fold.verb });
  }
  return { targets, order: updateRefs, steps: full ? steps : undefined };
};

type Planned = ReturnType<typeof savePlan>;

// A pure reorder keeps the tip's tree and every patch, so any difference here is worth reading.
const verifyRebase = () => {
  const wip = currentBranch();
  const recorded = requireHeader(
    PRE_REBASE_PREFIX,
    'stack-plan apply records one when it rebases',
  );
  const short = yellow(recorded.slice(0, 10));
  heading('Verify');

  // After a cut, the old range starts at the cut tip and the new one at the base the rest moved onto.
  const [cutTip, newBase, ...branchesCutByCut] = words(
    readHeader(CUT_PREFIX) ?? '',
  );
  const [
    syncOnto,
    syncFork,
    syncOldTop,
    syncOrigin,
    syncTop,
    ...branchesCutBySync
  ] = words(readHeader(SYNC_PREFIX) ?? '');
  const baseMoved = Boolean(cutTip || syncOnto);
  const oldFrom = syncFork ?? cutTip ?? base;
  const newFrom = syncOnto ?? newBase ?? base;
  const cutBranches = syncOnto ? branchesCutBySync : branchesCutByCut;

  // Both run before anything prints, so the details come first and the verdict ends the output.
  const rangeArgs = [
    'range-diff',
    colourOn(process.stdout) ? '--color=always' : '--no-color',
    `${oldFrom}..${recorded}`,
    `${newFrom}..${wip}`,
  ];
  const statArgs = ['diff', '--stat', recorded, wip];
  const entries = splitRangeDiff(gitQuiet(...rangeArgs));
  const stat = baseMoved ? '' : gitQuiet(...statArgs).trimEnd();
  // range-diff pairs a fold's commits unpredictably, so every entry from a planned fold is set apart instead.
  const foldGroups = words(readHeader(FOLDED_PREFIX) ?? '').map((pair) =>
    pair.split('>'),
  );
  const foldShas = foldGroups.flat();
  const foldSubjects = new Set(
    foldGroups.flatMap(([folded, target]) => {
      const subject = gitQuiet('log', '-1', '--format=%s', target).trim();
      // fixup -C keeps an amend! commit's message without its first line.
      const [first, ...body] = gitQuiet('log', '-1', '--format=%B', folded)
        .trim()
        .split('\n');
      const amended = first.startsWith('amend!')
        ? body.find((line) => line.trim())?.trim()
        : undefined;
      return amended ? [subject, amended] : [subject];
    }),
  );
  for (const entry of entries) {
    const fromOld =
      entry.oldSha && foldShas.some((sha) => sha.startsWith(entry.oldSha!));
    const asNew = entry.kind === '>' && foldSubjects.has(entry.subject);
    if (entry.kind !== '=' && (fromOld || asNew)) entry.kind = 'folded';
  }
  // After a cut, a commit is dropped when the new base already holds its change, which loses nothing.
  // After a sync, origin's copy holds the change of a commit it replaced.
  const holdsDroppedChanges = syncOrigin ?? newBase;
  // sync checked each cut branch whole, since a squash merge holds no single commit of it.
  const onSyncCutBranch = (sha: string) =>
    syncOnto !== undefined &&
    cutBranches.some((branch) => isAncestor(sha, branch));
  if (baseMoved) {
    for (const entry of entries.filter((candidate) => candidate.kind === '<')) {
      if (onSyncCutBranch(entry.oldSha)) {
        entry.kind = 'landed';
        continue;
      }
      const merged = mergeTree(
        `${entry.oldSha}^`,
        holdsDroppedChanges,
        entry.oldSha,
      );
      if (merged.ok && merged.tree === treeOf(holdsDroppedChanges))
        entry.kind = 'landed';
    }
  }
  if (syncOrigin) {
    for (const entry of entries.filter((candidate) => candidate.kind === '>')) {
      if (isAncestor(entry.newSha, syncOrigin)) entry.kind = 'origin';
    }
  }

  const worthReading = entries.filter((entry) =>
    ['!', '<', '>'].includes(entry.kind),
  );
  if (worthReading.length) {
    subheading('Range diff changes');
    console.log(
      worthReading
        .map((entry) => entry.lines.join('\n').trimEnd())
        .join('\n\n'),
    );
  }

  subheading('Conclusion');
  traceGit(rangeArgs);
  const count = (kind: Entry['kind']) =>
    entries.filter((entry) => entry.kind === kind).length;
  const foldedCount = count('folded') ? ` · ${count('folded')} from folds` : '';
  const landedCount = count('landed')
    ? ` · ${count('landed')} already in the base`
    : '';
  const originCount = count('origin')
    ? ` · ${count('origin')} from origin`
    : '';
  const summary = `range-diff  ${count('=')} unchanged · ${count('context')} context only · ${count('!')} changed · ${count('<')} dropped · ${count('>')} added${foldedCount}${landedCount}${originCount}`;
  if (count('<') || count('>')) bad(`${summary}; read the entries above`);
  else if (count('!')) attention(`${summary}; read the changed entries above`);
  else good(summary);
  const contextOnly = entries.filter((entry) => entry.kind === 'context');
  if (contextOnly.length) {
    console.log(
      `\nOnly the surrounding lines moved, the change itself is the same:`,
    );
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
    console.log(
      `\nFrom a planned fixup or squash, so expected; the tree check below still covers them:`,
    );
    for (const entry of foldedEntries) console.log(entry.lines[0]);
  }
  const landedEntries = entries.filter((entry) => entry.kind === 'landed');
  if (landedEntries.length) {
    console.log(
      `\nDropped because the new base or origin already holds the change, so nothing is lost:`,
    );
    for (const entry of landedEntries) console.log(entry.lines[0]);
  }
  const originEntries = entries.filter((entry) => entry.kind === 'origin');
  if (originEntries.length) {
    console.log(`\nTaken from origin, which you did not have locally:`);
    for (const entry of originEntries) console.log(entry.lines[0]);
  }
  const droppedOrAdded = entries.filter(
    (entry) => entry.kind === '<' || entry.kind === '>',
  );
  if (droppedOrAdded.length) {
    console.log(`\nDropped (<) or added (>), full entries above:`);
    for (const entry of droppedOrAdded) console.log(entry.lines[0]);
  }

  console.log('');
  // A cut or sync moves the rest onto a base that has changed, so the tree cannot match; the net change above it still must.
  const syncedOk = () => {
    const sameAboveTop = sameNetChange(
      `${syncOldTop.slice(0, 10)}..${recorded.slice(0, 10)}`,
      syncOldTop,
      recorded,
      tipOf(syncTop),
      wip,
      syncTop,
    );
    return (
      sameTipOutsideOrigin(syncOldTop, recorded, tipOf(syncTop), wip) &&
      sameAboveTop
    );
  };
  const treeOk = syncOnto
    ? syncedOk()
    : cutTip
      ? sameNetChange(
          `${cutTip.slice(0, 10)}..${recorded.slice(0, 10)}`,
          cutTip,
          recorded,
          newBase,
          wip,
          newBase.slice(0, 10),
        )
      : !stat;
  if (!baseMoved) traceGit(statArgs);
  if (stat) {
    bad(`tree differs from the pre-rebase tip ${short}`);
    console.log(stat);
    console.log(`To put the pre-rebase tree back as uncommitted changes:`);
    console.log(
      `  git restore --source=${recorded.slice(0, 10)} --staged --worktree :/`,
    );
  }
  if (treeOk && !droppedOrAdded.length) tidyAfterRebase(wip, cutBranches);
  if (!stat && !baseMoved) good(`tree matches the pre-rebase tip ${short}`);
};

// Runs once verify has passed, so the plan's bookkeeping catches up with what the rebase did.
const tidyAfterRebase = (wip: string, cutBranches: string[]) => {
  const order = words(readConfig(ORDER_KEY));
  if (cutBranches.some((branch) => order.includes(branch))) {
    if (!dryRun)
      git(
        'config',
        ORDER_KEY,
        order.filter((branch) => !cutBranches.includes(branch)).join(' '),
      );
    good(
      `cut branches ${dryRun ? 'would be removed' : 'removed'} from ${ORDER_KEY}: ${cutBranches.join(', ')}`,
    );
  }
  const leftOver = cutBranches.filter(branchExists);
  if (leftOver.length)
    console.log(
      `The cut branches are still there. To delete them:\n  git branch -D ${leftOver.join(' ')}`,
    );

  const waitingToCreate = words(readConfig(NEW_KEY));
  if (waitingToCreate.length && waitingToCreate.every(branchExists)) {
    if (!dryRun) git('config', '--unset', NEW_KEY);
    good(
      `new branches ${dryRun ? 'would be marked' : 'marked'} created: ${waitingToCreate.join(', ')}`,
    );
  }

  // A note on a commit no longer waiting on wip has done its job; the pre-rebase commits keep their copies.
  const { line, pending } = readStack(wip);
  const waiting = new Set(pending.map((commit) => commit.sha));
  const landed = line.filter(
    (commit) => commit.note && !waiting.has(commit.sha),
  );
  if (!landed.length) return;
  if (!dryRun)
    git(
      'notes',
      `--ref=${NOTES_REF}`,
      'remove',
      ...landed.map((commit) => commit.sha),
    );
  good(
    `${landed.length} notes ${dryRun ? 'would be removed' : 'removed'} from commits now in their branch`,
  );
};

type Entry = {
  kind: '=' | '!' | '<' | '>' | 'context' | 'folded' | 'landed' | 'origin';
  oldSha: string;
  newSha: string;
  subject: string;
  lines: string[];
};

// Header lines look like "12:  abc1234 = 14:  def5678 subject"; = means the patch is unchanged.
const RANGE_DIFF_HEADER =
  /^\s*(?:\d+|-):\s+(\S+)\s+([=!<>])\s+(?:\d+|-):\s+(\S+)\s*(.*)$/;

// Splits range-diff output per commit, and marks a ! entry "context" when only its context lines differ.
const splitRangeDiff = (output: string) => {
  const entries: Entry[] = [];
  for (const line of output.split('\n')) {
    const [, oldSha, marker, newSha, subject] =
      RANGE_DIFF_HEADER.exec(stripColour(line)) ?? [];
    if (marker)
      entries.push({
        kind: marker as Entry['kind'],
        oldSha,
        newSha,
        subject,
        lines: [line],
      });
    else entries.at(-1)?.lines.push(line);
  }
  for (const entry of entries) {
    if (
      entry.kind === '!' &&
      onlyContextDiffers(entry.lines.slice(1).map(stripColour))
    )
      entry.kind = 'context';
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
    todo.push(`${todoVerb(verb)} ${commit.sha} ${marker}${commit.subject}`);
    sequence.push({ commit, fold: verb !== 'pick' });
  };
  return { todo, sequence, pick };
};

const branchMarker = (branch: string, branches: string[], order: string[]) => {
  const below = order[order.indexOf(branch) - 1] ?? base;
  if (!branches.includes(branch))
    return `# ${NEW_BRANCH_MARKER} ${branch}, above ${below}`;
  if (movedBranches(branches, order).includes(branch))
    return `# ${MOVED_BRANCH_MARKER} ${branch}, now above ${below}`;
};

// Short mode: each branch keeps its own commits as a block, and waiting commits join the branch their note names.
const shortRebase = (wip: string, planned?: Planned): Rebase | undefined => {
  const { line, branches, pending, own } = readStack(wip);
  const { folding, unmatched, foldsInto } = foldsBySubject(line);
  // A dry-run save writes no notes or config, so its plan stands in for them.
  for (const commit of pending)
    if (planned?.targets.has(commit.sha))
      commit.note = planned.targets.get(commit.sha) ?? '';
  const order = planned?.order ?? desiredOrder(branches);
  // A folding commit goes with its target, whatever its note says.
  const moves = pending.filter(
    (commit) =>
      !folding.has(commit.sha) &&
      commit.note !== wip &&
      order.includes(commit.note),
  );
  const moved = new Set(moves.map((commit) => commit.sha));
  const branchOf = new Map(
    [...own].flatMap(([branch, commits]) =>
      commits.map((commit) => [commit.sha, branch] as const),
    ),
  );
  const foldsLandIn = [...folding.values()].map(({ into }) =>
    moved.has(into.sha) ? into.note : (branchOf.get(into.sha) ?? wip),
  );
  const receives = (branch: string) =>
    moves.some((commit) => commit.note === branch) ||
    foldsLandIn.includes(branch);
  let first = 0;
  while (
    first < order.length &&
    order[first] === branches[first] &&
    !receives(order[first])
  )
    first++;
  warnUnmatched(unmatched);
  if (first === order.length && !foldsLandIn.includes(wip)) {
    good(
      `no tagged commits waiting on ${wip} and no change to the stack order; nothing to move`,
    );
    return;
  }
  // Everything below the first changed branch stays as it is.
  const rebaseBase = first === 0 ? base : order[first - 1];
  printByBranch(order, (commit) => commit.note, moves);
  for (const [sha, { into }] of folding)
    printFold(line.find((commit) => commit.sha === sha)!, into);
  printOrderChanges(branches, order);
  console.log(`${bold('base')}  ${cyan(rebaseBase)}`);

  const { todo, sequence, pick } = newTodo();
  const pickWithFolds = (commit: Commit, marker = '') => {
    pick(commit, marker);
    for (const fold of foldsInto(commit))
      pick(fold, '', folding.get(fold.sha)!.verb);
  };
  const unfolded = (commits: Commit[]) =>
    commits.filter((commit) => !folding.has(commit.sha));
  for (const branch of order.slice(first)) {
    const marker = branchMarker(branch, branches, order);
    if (marker) todo.push(marker);
    for (const commit of unfolded(own.get(branch) ?? [])) pickWithFolds(commit);
    for (const commit of moves.filter((move) => move.note === branch))
      pickWithFolds(commit, `${MOVED_MARKER} `);
    todo.push(`update-ref refs/heads/${branch}`, '');
  }
  for (const commit of unfolded(pending).filter(
    (commit) => !moved.has(commit.sha),
  ))
    pickWithFolds(commit);
  return { todo, sequence, rebaseBase };
};

// Full mode: the plan's own steps are the todo, from the last commit where they still match history.
const fullRebase = (
  wip: string,
  steps: Step[],
  planned: Planned,
): Rebase | undefined => {
  const { line, branches, own } = readStack(wip);
  const current: Step[] = line.flatMap((commit) => [
    { pick: commit, verb: 'pick' as const },
    ...commit.branches.map((updateRef) => ({ updateRef })),
  ]);
  const same = (a: Step, b?: Step) =>
    b !== undefined &&
    ('pick' in a
      ? 'pick' in b && a.verb === 'pick' && a.pick.sha === b.pick.sha
      : 'updateRef' in b && a.updateRef === b.updateRef);
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

  const branchOf = new Map(
    [...own].flatMap(([branch, commits]) =>
      commits.map((commit) => [commit.sha, branch] as const),
    ),
  );
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
  const moved = line.filter(
    (commit) => !foldedInto.has(commit.sha) && was(commit) !== goes(commit),
  );
  printByBranch([...order, wip], goes, moved);
  for (const [sha, target] of foldedInto)
    printFold(line.find((commit) => commit.sha === sha)!, target);
  warnUnmatched(foldsBySubject(line).unmatched);
  printOrderChanges(branches, order);
  console.log(
    `${bold('base')}  ${lastCommit ? commitLine(lastCommit).trim() : cyan(base)}`,
  );

  const { todo, sequence, pick } = newTodo();
  let sectionStart = 0;
  for (const step of steps.slice(kept)) {
    if ('pick' in step) {
      const movesBranch =
        step.verb === 'pick' && was(step.pick) !== goes(step.pick);
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
  const rebase = planned?.steps
    ? fullRebase(wip, planned.steps, planned)
    : shortRebase(wip, planned);
  if (!rebase) return;
  const { todo, sequence, rebaseBase } = rebase;

  heading('Preview');
  const started = Date.now();
  const simulation = simulateRebase(sequence, tipOf(rebaseBase), wip);
  const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const conflicted = simulation.conflicts.length > 0;
  if (!conflicted) {
    if (!simulation.sameTree)
      attention(
        'the simulated result ends on a different tree than wip; verify will show where',
      );
    good(`all ${simulation.picks} picks apply cleanly in memory (${took})`);
  } else {
    reportConflicts(
      simulation,
      tipOf(rebaseBase),
      ` (${took})`,
      landingBranches(todo, wip),
    );
  }
  if (preview) return;
  if (conflicted && !rest.includes('--anyway')) {
    console.log(
      '\nNothing rewritten. Change the plan (export, edit, apply), or resolve it by hand:',
    );
    console.log('  stack-plan apply -f');
    process.exit(1);
  }
  if (!existsSync(planPath()))
    throw new Error(
      'No stackplan.txt to record the pre-rebase tip in; run stack-plan export first',
    );

  // Each fold as <folded>><target>; range-diff may report either one as dropped, so verify accepts both.
  const folded: string[] = [];
  sequence.forEach(({ commit, fold }, index) => {
    if (fold)
      folded.push(
        `${commit.sha}>${sequence.findLast((replay, at) => at < index && !replay.fold)!.commit.sha}`,
      );
  });
  recordPreRebase(tipOf(wip), folded);
  runRebase(todo, ['rebase', '-i', '--update-refs', rebaseBase]);
};

/** Runs the rebase with the planned todo in place of git's, then verifies; `adopted` may be picked though git's todo lacks them. */
const runRebase = (todo: string[], args: string[], adopted: string[] = []) => {
  const todoPath = join(
    git('rev-parse', '--absolute-git-dir').trim(),
    'stack-plan-todo',
  );
  writeFileSync(todoPath, todo.join('\n'));
  const reviewEditor = git('var', 'GIT_SEQUENCE_EDITOR').trim();
  const editor = `node ${shellQuote(realpathSync(process.argv[1]))} _todo`;
  heading('Rebase');
  if (verbose)
    console.error(
      dimErr(
        `$ GIT_SEQUENCE_EDITOR=${shellQuote(editor)} git ${args.join(' ')}`,
      ),
    );
  const result = spawnSync('git', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      GIT_SEQUENCE_EDITOR: editor,
      STACK_PLAN_EDITOR: reviewEditor,
      STACK_PLAN_TODO: todoPath,
      STACK_PLAN_ADOPTED: adopted.join(' '),
    },
  });
  exitUnlessRebaseFinished(result.status);
  verifyRebase();
};

const picksIn = (todo: string) =>
  todo
    .split('\n')
    .flatMap(
      (line) =>
        /^(?:pick|p|fixup|f|squash|s)\s+(?:-C\s+)?([0-9a-f]+)/.exec(
          line,
        )?.[1] ?? [],
    );
const dropsIn = (todo: string) =>
  todo
    .split('\n')
    .flatMap((line) => /^(?:drop|d)\s+([0-9a-f]+)/.exec(line)?.[1] ?? []);

// Runs as git's sequence editor: swaps git's todo for the planned one when both hold the same picks, then opens the user's editor.
const editTodo = (todoPath: string) => {
  // Git reads only the command and hash of a pick, so the rest of a planned line is free for a marker.
  const planned = readFileSync(process.env.STACK_PLAN_TODO ?? '', 'utf8');
  const plannedShas = picksIn(planned);
  const accountedShas = [...plannedShas, ...dropsIn(planned)];
  const adopted = words(process.env.STACK_PLAN_ADOPTED ?? '');
  const original = readFileSync(todoPath, 'utf8');
  const gitShas = picksIn(original);
  const inGitTodo = (sha: string) =>
    gitShas.some((abbrev) => sha.startsWith(abbrev));
  const problems = gitShas
    .filter((abbrev) => !accountedShas.some((sha) => sha.startsWith(abbrev)))
    .map((abbrev) => `${abbrev} is in git's todo but not in the plan`);
  const unexpected = plannedShas.filter(
    (sha) => !inGitTodo(sha) && !adopted.includes(sha),
  );
  problems.push(
    ...unexpected.map(
      (sha) => `${sha.slice(0, 10)} is in the plan but not in git's todo`,
    ),
  );
  const expected = accountedShas.filter(inGitTodo).length;
  if (gitShas.length !== expected)
    problems.push(
      `git's todo has ${gitShas.length} picks, the plan accounts for ${expected}`,
    );
  if (problems.length) {
    console.error(
      redErr(`✗ stack-plan: ${problems.join('; ')}. Rebase not started.`),
    );
    process.exit(1);
  }
  const help = original.split('\n').filter((line) => line.startsWith('#'));
  writeFileSync(todoPath, [planned, ...help].join('\n'));

  const review = process.env.STACK_PLAN_EDITOR;
  if (review) {
    const result = spawnSync('sh', ['-c', `${review} "$1"`, 'sh', todoPath], {
      stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }
};

const setMode = () => {
  const [wanted] = rest;
  if (wanted === 'full') git('config', MODE_KEY, 'full');
  else if (wanted === 'short' && readConfig(MODE_KEY))
    git('config', '--unset', MODE_KEY);
  heading('Mode');
  const full = fullMode();
  console.log(
    `${bold(full ? 'full' : 'short')}  export lists ${full ? 'every commit since the base' : 'only the commits waiting to move'}`,
  );
  if (wanted)
    console.log('Run stack-plan export to write the plan in this mode.');
};

try {
  if (command === 'export') exportPlan();
  else if (command === 'save' || command === 'preview' || command === 'apply') {
    const planned = savePlan();
    // Full mode always passes the plan, because notes cannot hold the order within a branch.
    if (command === 'preview')
      applyStack(dryRun || planned.steps ? planned : undefined, true);
    else if (command === 'apply')
      applyStack(planned.steps ? planned : undefined);
  } else if (command === 'verify') verifyRebase();
  else if (command === 'mode') setMode();
  else if (command === 'prepare') prepareRebase();
  else if (command === 'cut') cutStack(cutAt!, rest.includes('--apply'));
  else if (command === 'sync') syncStack(rest.includes('--apply'));
  else if (command === 'extract') extractBranches(rest.includes('--apply'));
  else if (command === 'extractable') extractableBranches();
  else if (command === '_todo') editTodo(args[0]);
} catch (error) {
  console.error(redErr(`✗ ${(error as Error).message}`));
  process.exit(1);
}
