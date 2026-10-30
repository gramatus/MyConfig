#!/usr/bin/env node
// Moves commits waiting on the current branch into stack branches, and reorders or adds those branches.
// Usage: stack-plan export|save|preview|apply|continue|prepare|verify|cut|sync|extract|extractable|mark|needs|mode [-b <ref>] [-n] [-f]; run without arguments for details.

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
const STOP_NOTES_REF = 'refs/notes/stackplan-stop';
const UNTAGGED_MARKER =
  '# ---- untagged: move each line above the update-ref of its branch ----';
const EXPORTED_AT_PREFIX = '# exported-at: ';
const PRE_REBASE_PREFIX = '# pre-rebase: ';
const MODE_PREFIX = '# mode: ';
const FOLDED_PREFIX = '# folded: ';
const CUT_PREFIX = '# cut: ';
const SYNC_PREFIX = '# sync: ';
const FROM_COPY_PREFIX = '# from-copy: ';
const STOPS_PREFIX = '# stops: ';
const ADOPTED_PREFIX = '# adopted: ';
const MOVED_MARKER = '>>> [moved]';
const ADOPTED_MARKER = '>>> [adopted]';
const STOP_MARKER = '>>> [break]';
const LOCAL_MARKER = '>>> [local]';
const COPY_MARKER = '>>> [copy]';
const MOVED_BRANCH_MARKER = '>>> [moved branch]';
const NEW_BRANCH_MARKER = '>>> [new branch]';
const PRS_STOP_MARKER = '# --- PRs stop here ---';
const OTHER_STACKS_STOP_MARKER = '# --- Other stacks stop here ---';
const MIRROR_STATUS_PREFIX = '# mirror: ';
const ORIGIN_STATUS_PREFIX = '# origin: ';
const BASE_STATUS_PREFIX = '# base: ';
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
  '  continue (c) git rebase --continue after a stop or a conflict, then verify once the rebase is done',
  '  prepare     record the pre-rebase tip before a rebase run by hand',
  '  verify (v)   compare the stack with the pre-rebase tip',
  '  cut <branch> check that dropping the branches up to <branch> and rebasing the rest onto the base loses no work;',
  '               --apply then does it, and -f does it despite a finding',
  '  cut <__branch>...  the same for only the named __ branches, wherever they sit, once their copies have merged',
  '  cut --merged the same for every __ branch that has landed, found through gh or the content',
  '  sync         check putting each stack branch on its origin copy, with what origin lacks replayed on top',
  '               and merged branches cut, landed __ branches included; --apply then does it, and -f does it',
  '               despite a finding;',
  '               it fetches and prunes origin first, unless --no-fetch',
  '  extract      check copying each __ branch onto the branch named without the prefix, off the stack;',
  '               --apply then moves those branches, and -f moves the clean ones despite a finding;',
  '               --rebase also rebuilds each copy that sits on an older base on its current tip',
  "  extract --from-copy <__branch>...  check rewriting each named __ branch to take its copy's commits instead;",
  '               --apply then rebases the stack, and -f does it despite a finding',
  '  extractable  list the branches above the PRs that could become __ branches, as far as the text shows;',
  "               --json prints each chain with every member's start and replay commits;",
  '               --upto <branch> tests only the branches up to and including <branch>',
  '  mark <branch>...  rename each to its __ name, carrying its notes and the saved order along, and export the plan',
  '               with them as one block above the PRs; a PR branch at the bottom stays put and keeps its tip as the',
  '               copy; -n only shows what it would do',
  '  unmark <__branch>...  undo mark: delete each extracted copy once it matches its source, rename the source back,',
  '               move it to just above the __ block and export the plan; a copy with a PR at the tip hands the PR',
  '               back and stays put; -f deletes a copy that differs from its source; -n only shows what it would do',
  '  needs <branch> <needed>...  record that the branch needs the others below it, which extractable and extract',
  '               then chain it with; --clear forgets what it recorded, and naming no others shows it',
  '  mode [full|short]  show or set what export lists: full is every commit, short only the waiting ones',
].join('\n');

const EXPANSIONS: Record<string, string[]> = {
  e: ['export'],
  s: ['save'],
  a: ['apply'],
  c: ['continue'],
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
  continue: ['--base'],
  prepare: [],
  verify: ['--base', '--dry-run'],
  cut: ['--base', '--apply', '--anyway', '--merged'],
  sync: ['--base', '--apply', '--anyway', '--no-fetch'],
  extract: ['--base', '--apply', '--anyway', '--from-copy', '--rebase'],
  extractable: ['--base', '--json', '--upto'],
  mark: ['--base', '--dry-run'],
  unmark: ['--base', '--dry-run', '--anyway'],
  needs: ['--base', '--clear'],
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
const cutTargets: string[] = [];
const branchesToMark: string[] = [];
const needsArgs: string[] = [];
const fromCopyTargets: string[] = [];
// Commands starting with _ are git's callbacks during a rebase, with arguments of their own.
if (!command.startsWith('_')) {
  const allowed =
    ALLOWED_FLAGS[command] ??
    usageError(given ? `unknown command "${given}"` : undefined);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--base' && allowed.includes('--base')) i++;
    else if (rest[i] === '--upto' && allowed.includes('--upto')) {
      if (!rest[i + 1] || rest[i + 1].startsWith('-'))
        usageError('--upto needs the last branch to test');
      i++;
    } else if (command === 'cut' && !rest[i].startsWith('-'))
      cutTargets.push(rest[i]);
    else if (
      (command === 'mark' || command === 'unmark') &&
      !rest[i].startsWith('-')
    )
      branchesToMark.push(rest[i]);
    else if (command === 'needs' && !rest[i].startsWith('-'))
      needsArgs.push(rest[i]);
    else if (command === 'extract' && !rest[i].startsWith('-'))
      fromCopyTargets.push(rest[i]);
    else if (!allowed.includes(rest[i]))
      usageError(`${rest[i]} does not apply to ${given}`);
  }
  if (command === 'mode' && rest.length > 1)
    usageError('mode takes one of full or short');
  const cutMerged = command === 'cut' && rest.includes('--merged');
  if (cutMerged && cutTargets.length)
    usageError('cut --merged picks the branches itself; name none');
  if (command === 'cut' && !cutMerged && !cutTargets.length)
    usageError('cut needs the branch to cut at, or --merged');
  if (
    cutTargets.length > 1 &&
    !cutTargets.every((name) => name.startsWith(EXTRACT_SOURCE_PREFIX))
  )
    usageError(
      `cut takes one branch to cut at, or one or more ${EXTRACT_SOURCE_PREFIX} branches`,
    );
  if (command === 'mark' && !branchesToMark.length)
    usageError('mark needs the branches to mark');
  if (command === 'unmark' && !branchesToMark.length)
    usageError('unmark needs the __ branches to unmark');
  if (command === 'needs' && !needsArgs.length)
    usageError('needs takes the branch whose needs to record or show');
  const fromCopy = command === 'extract' && rest.includes('--from-copy');
  if (fromCopy && !fromCopyTargets.length)
    usageError('--from-copy needs the __ branches to take from their copies');
  if (!fromCopy && fromCopyTargets.length)
    usageError('extract takes branch names only with --from-copy');
  if (fromCopy && rest.includes('--rebase'))
    usageError('--rebase does not apply to --from-copy');
}

const optionValue = (name: string) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const base = optionValue('--base') ?? 'origin/main';
const upto = optionValue('--upto');
const dryRun = rest.includes('--dry-run');
const asJson = rest.includes('--json');
const rebaseCopies = rest.includes('--rebase');

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
// Where the stack leaves the base, so a rebase of the bottom branch keeps the stack off newer base commits.
const forkOf = (wip: string) => git('merge-base', base, wip).trim();
const forkLabel = (fork: string) =>
  `${cyan(base)} at ${yellow(fork.slice(0, 10))}, where the stack leaves it`;
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

const readConfigAll = (key: string) => {
  try {
    return words(git('config', '--get-all', key));
  } catch {
    return [];
  }
};

const fullMode = () => readConfig(MODE_KEY) === 'full';

// git branch -m moves branch.<name>.* along, so a declaration follows mark's rename.
const needsKey = (branch: string) => `branch.${branch}.stackNeeds`;
const unprefixed = (branch: string) =>
  isExtractSource(branch) ? extractedNameOf(branch) : branch;
const stackBranchNamed = (name: string, branches: string[]) =>
  branches.find((branch) => unprefixed(branch) === unprefixed(name));
// A declared need no longer in the stack has landed, so it needs nothing more.
const declaredNeeds = (branch: string, branches: string[]) =>
  readConfigAll(needsKey(branch)).flatMap(
    (need) => stackBranchNamed(need, branches) ?? [],
  );

// A stop at a branch's end lives in the branch's config, so git branch -m carries it along like a need.
const stopKey = (branch: string) => `branch.${branch}.stackStop`;
type Stops = { branches: Map<string, string>; commits: Map<string, string> };
const readBranchStops = (branches: string[]) =>
  new Map(
    branches.flatMap((branch) => {
      const message = readConfig(stopKey(branch));
      return message ? [[branch, message] as const] : [];
    }),
  );

// A stop after a commit is a note, which notes.rewriteRef carries across a rebase like the placement note.
const readCommitStops = (line: Commit[]) => {
  const stops = new Map<string, string>();
  const inLine = new Set(line.map((commit) => commit.sha));
  let listing: string;
  try {
    listing = git('notes', `--ref=${STOP_NOTES_REF}`, 'list');
  } catch {
    return stops;
  }
  for (const row of listing.split('\n')) {
    const sha = words(row)[1];
    if (sha && inLine.has(sha))
      stops.set(
        sha,
        git('notes', `--ref=${STOP_NOTES_REF}`, 'show', sha).trim(),
      );
  }
  return stops;
};

// A commit picked in from outside the stack, as a rebase todo may pick any commit; git branch -m carries it along.
const adoptKey = (branch: string) => `branch.${branch}.stackAdopt`;
const outsideCommit = (sha: string): Commit => ({
  sha,
  subject: gitQuiet('show', '-s', '--format=%s', sha).trim(),
  branches: [],
  note: '',
});
// Each branch's adopted commits in plan order; one that no longer resolves is left out and named in missing.
const readAdoptions = (branches: string[]) => {
  const adopted = new Map<string, Commit[]>();
  const missing: string[] = [];
  for (const branch of branches) {
    const shas = readConfigAll(adoptKey(branch));
    const found = shas.filter((sha) =>
      gitSucceeds('cat-file', '-e', `${sha}^{commit}`),
    );
    missing.push(...shas.filter((sha) => !found.includes(sha)));
    if (found.length) adopted.set(branch, found.map(outsideCommit));
  }
  return { adopted, missing };
};

// The stops the last apply put in its todo, as <key>~<HEAD at the stop>~<HEAD on continue>; a key is b:<branch> or c:<sha>.
type StopRecord = { key: string; before?: string; after?: string };
const readStopRecords = (): StopRecord[] =>
  words(readHeader(STOPS_PREFIX) ?? '').map((token) => {
    const [key, before, after] = token.split('~');
    return { key, before, after };
  });
const writeStopRecords = (records: StopRecord[]) =>
  writeHeader(
    STOPS_PREFIX,
    records
      .map(({ key, before, after }) =>
        [key, before, after].filter(Boolean).join('~'),
      )
      .join(' '),
  );

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
  dropHeader(FROM_COPY_PREFIX);
  dropHeader(STOPS_PREFIX);
  dropHeader(ADOPTED_PREFIX);
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
  const fields = records.map((record) => record.split('\x1f'));
  const refsOf = (refs: string) =>
    refs ? refs.split(', ').map((ref) => ref.replace(/^HEAD -> /, '')) : [];
  const sourceAt = new Map(
    fields.flatMap(([, , refs], i) =>
      refsOf(refs)
        .filter(isExtractSource)
        .map((source) => [source, i] as const),
    ),
  );
  const line: Commit[] = fields.map(([sha, subject, refs, note], i) => {
    // A copy kept at its source's tip stays at or below it, off the stack.
    const isCopy = (branch: string) =>
      i <= (sourceAt.get(`${EXTRACT_SOURCE_PREFIX}${branch}`) ?? -1);
    const stack = refsOf(refs)
      .filter((branch) => branch !== wip && !isCopy(branch))
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
    branchOf: new Map(
      [...own].flatMap(([branch, commits]) =>
        commits.map((commit) => [commit.sha, branch] as const),
      ),
    ),
  };
};

// A note on a commit in a stack branch names where it moves; one naming its own branch has done its job.
const movesOut = (
  commit: Commit,
  from: string | undefined,
  order: string[],
  wip: string,
) =>
  from !== undefined &&
  commit.note !== '' &&
  commit.note !== from &&
  (commit.note === wip || order.includes(commit.note));

// The note save leaves on a commit placed in target; a stack commit placed in its own branch needs none.
const noteFor = (target: string | undefined, from: string | undefined) =>
  target === undefined || target === from ? '' : target;

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
  const diff = gitQuiet('diff', from, to, '--', ...(path ? [path] : []));
  if (!diff) return '';
  return execFileSync('git', ['patch-id', '--stable'], {
    input: diff,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  }).split(' ')[0];
};

const fileList = (output: string) => output.split('\n').filter(Boolean);

// What was done at each stop the rebase got past: the commits made there, the files they change, and any commit amended.
const stopWork = (records: StopRecord[]) => {
  const commits: string[] = [];
  const files = new Set<string>();
  const amendedSubjects = new Set<string>();
  for (const { before, after } of records) {
    if (!before || !after || before === after) continue;
    commits.push(...fileList(gitQuiet('rev-list', `${before}..${after}`)));
    for (const file of fileList(gitQuiet('diff', '--name-only', before, after)))
      files.add(file);
    if (!isAncestor(before, after))
      amendedSubjects.add(gitQuiet('log', '-1', '--format=%s', before).trim());
  }
  return { commits, files, amendedSubjects };
};

// Whether from..to and onFrom..onTo make the same change; false when some file ends differently, 'unclear' when only files in baseChanged do.
const sameNetChange = (
  label: string,
  from: string,
  to: string,
  onFrom: string,
  onTo: string,
  onName: string,
  baseChanged?: Set<string>,
): boolean | 'unclear' => {
  if (patchId(from, to) === patchId(onFrom, onTo)) {
    good(`the net change of ${label} is the same on ${onName}`);
    return true;
  }
  const files = new Set([
    ...fileList(gitQuiet('diff', '--name-only', from, to, '--')),
    ...fileList(gitQuiet('diff', '--name-only', onFrom, onTo, '--')),
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
  // The base changed these too, so they may end differently with nothing lost.
  const unclear = missing.filter((file) => baseChanged?.has(file));
  const lost = missing.filter((file) => !unclear.includes(file));
  if (unclear.length) {
    attention(
      `${onName} changed these too, so whether ${label} kept its change needs a look by hand:`,
    );
    for (const file of unclear)
      console.log(
        `    git diff ${tipOf(to).slice(0, 10)} ${tipOf(onTo).slice(0, 10)} -- ${file}`,
      );
  }
  if (!lost.length) return 'unclear';
  bad(
    `the net change of ${label} differs on ${onName}, and these files end differently:`,
  );
  for (const file of lost) console.log(`    ${file}`);
  return false;
};

const rebaseInProgress = () =>
  existsSync(
    gitQuiet(
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'rebase-merge',
    ).trim(),
  );

// Git exits 0 when it pauses at an edit or break, and non-zero when it refuses to start, so the rebase state decides.
const exitUnlessRebaseFinished = (
  status: number | null,
  refused = 'the rebase did not start',
) => {
  const inProgress = rebaseInProgress();
  if (status !== 0 && !inProgress) {
    bad(`${refused}; see the message above`);
    process.exit(status ?? 1);
  }
  if (status !== 0) {
    attention('the rebase stopped. Resolve it, then: stack-plan continue');
    process.exit(status ?? 1);
  }
  if (inProgress) {
    attention(
      'the rebase paused. When done: stack-plan continue, which verifies once the rebase is done',
    );
    process.exit(0);
  }
};

// Git runs no stack-plan once a rebase has paused, so this brings back the verify apply would have run.
const continueRebase = () => {
  if (!rebaseInProgress()) throw new Error('no rebase is in progress');
  heading('Continue');
  const result = spawnSync('git', ['rebase', '--continue'], {
    stdio: 'inherit',
  });
  exitUnlessRebaseFinished(result.status, 'git rebase --continue failed');
  verifyRebase();
};

// The three todo lines of a stop: git prints the message from the first, pauses at the break, and runs the last on continue.
const stopLines = (key: string) => {
  const self = `node ${shellQuote(realpathSync(process.argv[1]))}`;
  return [
    `exec ${self} _stop ${shellQuote(key)}`,
    'break',
    `exec ${self} _resume ${shellQuote(key)}`,
  ];
};

const stopMessage = (key: string) =>
  key.startsWith('b:')
    ? readConfig(stopKey(key.slice(2)))
    : gitSucceeds('notes', `--ref=${STOP_NOTES_REF}`, 'show', key.slice(2))
      ? git('notes', `--ref=${STOP_NOTES_REF}`, 'show', key.slice(2)).trim()
      : '';

const recordStopHead = (key: string, when: 'before' | 'after') => {
  const head = tipOf('HEAD');
  writeStopRecords(
    readStopRecords().map((record) =>
      record.key !== key
        ? record
        : when === 'before'
          ? { key, before: head }
          : { ...record, after: head },
    ),
  );
};

// Runs from git's todo, with HEAD detached at the commit the stop follows.
const stopHere = (key: string) => {
  recordStopHead(key, 'before');
  heading('Stop');
  const message = stopMessage(key) || '(no message)';
  if (key.startsWith('b:')) {
    attention(`end of ${cyan(key.slice(2))}: ${message}`);
    console.log(`Commits you make now land in ${cyan(key.slice(2))}.`);
  } else {
    const subject = git('log', '-1', '--format=%s', key.slice(2)).trim();
    attention(`after ${yellow(key.slice(2, 12))} ${subject}: ${message}`);
    console.log(
      'Commits you make now come after it, and git commit --amend changes it.',
    );
  }
  console.log('When done: stack-plan continue');
};

// Per branch, since a squash merge leaves only a branch's end state in the base.
const checkContained = (branch: string, below: string) => {
  const merged = mergeTree(below, base, branch);
  if (!merged.ok) {
    attention(
      `${cyan(branch)}  can't tell: ${base} changed these again since, so compare by hand`,
    );
    for (const file of merged.files) console.log(`    ${file}`);
    return 'unclear';
  }
  if (merged.tree === treeOf(base)) {
    good(`${cyan(branch)}  contained in ${base}`);
    return 'contained';
  }
  bad(`${cyan(branch)}  would be lost: ${base} lacks its changes to`);
  for (const file of fileList(
    gitQuiet('diff', '--name-only', base, merged.tree),
  ))
    console.log(`    ${file}`);
  return 'lost';
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

  subheading(`Below the cut: already in ${base}?`);
  const below = branches.slice(0, branches.indexOf(at) + 1);
  const fork = git('merge-base', base, wip).trim();
  for (const [index, branch] of below.entries()) {
    const verdict = checkContained(
      branch,
      index === 0 ? fork : tipOf(below[index - 1]),
    );
    if (verdict === 'lost') lost++;
    if (verdict === 'unclear') unclear++;
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

// Drops __ branches whose copies have landed, from wherever they sit, and rebases the rest onto the base without them.
const dropExtractSources = (
  names: string[],
  apply: boolean,
  rerun = `cut ${names.join(' ')}`,
  leftOut: string[] = [],
) => {
  const wip = currentBranch();
  const { branches, pending, own } = readStack(wip);
  const unknown = names.filter((name) => !branches.includes(name));
  if (unknown.length)
    throw new Error(
      `${unknown.join(', ')} not a stack branch below ${wip}; the stack is: ${branches.join(' ')}`,
    );
  const dropping = branches.filter((branch) => names.includes(branch));
  const fork = forkOf(wip);
  heading(`Drop ${dropping.join(', ')}, onto ${base}`);
  let lost = 0;
  let unclear = 0;

  // Only __ branches are never pushed, so only they may be rewritten by moving them onto the base.
  subheading(`Below: only ${EXTRACT_SOURCE_PREFIX} branches?`);
  const pushable = branches
    .slice(0, branches.indexOf(dropping[0]))
    .filter((branch) => !isExtractSource(branch));
  for (const branch of pushable)
    bad(
      `${cyan(branch)}  sits below, and moving it onto ${base} would rewrite it; cut it first`,
    );
  if (pushable.length) lost++;
  else
    good(
      `only ${EXTRACT_SOURCE_PREFIX} branches sit below, so no branch with a PR is rewritten`,
    );

  subheading(`Already in ${base}?`);
  // GitHub's word settles it where later merges changed the same lines again, which the content check cannot see past.
  const merged = pullRequests('merged');
  if (!merged)
    attention('could not list merged PRs with gh, so only the content decides');
  for (const branch of dropping) {
    const pull = mergedCopyPull(branch, merged, own.get(branch) ?? []);
    if (pull && !pull.inBase) {
      unclear++;
      attention(`${cyan(branch)}  ${notFetched(pull)}`);
      continue;
    }
    if (pull && !pull.landed)
      attention(`${cyan(branch)}  ${notAllMerged(pull)}`);
    if (pull?.landed) {
      good(
        `${cyan(branch)}  ${extractedNameOf(branch)} merged on GitHub as #${pull.number}`,
      );
      continue;
    }
    const below = branches[branches.indexOf(branch) - 1];
    const verdict = checkContained(branch, below ? tipOf(below) : fork);
    if (verdict === 'lost') lost++;
    if (verdict === 'unclear') unclear++;
  }

  subheading(`The rest: rebased onto ${base}`);
  const kept = branches.filter((branch) => !dropping.includes(branch));
  const { todo, sequence, pick } = newTodo();
  for (const branch of kept) {
    for (const commit of own.get(branch) ?? []) pick(commit);
    todo.push(`update-ref refs/heads/${branch}`, '');
  }
  for (const commit of pending) pick(commit);
  const simulation = simulateRebase(sequence, tipOf(base), wip);
  const conflicted = simulation.conflicts.length > 0;
  if (conflicted) {
    unclear++;
    reportConflicts(simulation, tipOf(base), '', landingBranches(todo, wip));
  } else {
    good(`all ${simulation.picks} picks apply cleanly in memory`);
    const sameNet = sameNetChange(
      'the stack',
      fork,
      wip,
      tipOf(base),
      simulation.tip,
      base,
      new Set(fileList(gitQuiet('diff', '--name-only', fork, base))),
    );
    const sameTip = sameTipOutsideOrigin(
      fork,
      wip,
      tipOf(base),
      simulation.tip,
      `${base} moved since the stack left it`,
    );
    if (!sameNet || !sameTip) lost++;
    else if (sameNet === 'unclear') unclear++;
  }

  subheading('Conclusion');
  const target = dropping.join(' ');
  if (lost) bad(`dropping ${target} would lose work; see above`);
  else if (conflicted)
    attention(
      `the replay conflicts, so whether the stack keeps its changes is unchecked; resolve the conflicts above by hand, and verify checks it after`,
    );
  else if (unclear)
    attention(`no loss found, but some of it needs a look by hand; see above`);
  else good(`dropping ${target} and rebasing onto ${base} loses no work`);
  for (const line of leftOut) attention(line);
  if (!apply) {
    if (!lost && !unclear) console.log(`To do it: stack-plan ${rerun} --apply`);
    if (lost || unclear) process.exit(1);
    return;
  }
  if ((lost || unclear) && !rest.includes('--anyway')) {
    console.log(
      `\nNothing rewritten. To drop anyway: stack-plan ${rerun} --apply -f`,
    );
    process.exit(1);
  }

  ensurePlanFile(wip);
  recordPreRebase(tipOf(wip), []);
  // verify reads it as a cut whose old range starts at the fork.
  writeHeader(CUT_PREFIX, [fork, tipOf(base), ...dropping].join(' '));
  const drops = dropping.flatMap((branch) =>
    (own.get(branch) ?? []).map(
      (commit) => `drop ${commit.sha} ${commit.subject}`,
    ),
  );
  runRebase(
    [`# in ${base} through the extracted copies`, ...drops, '', ...todo],
    ['rebase', '-i', '--update-refs', '--empty=drop', '--onto', base, fork],
  );
};

// Finds the __ branches that have landed in the base, through gh or the content, and lists the ones it leaves out.
const landedSources = (
  branches: string[],
  own: Map<string, Commit[]>,
  fork: string,
) => {
  const picked: string[] = [];
  const leftOut: string[] = [];
  const sources = branches.filter(isExtractSource);
  if (!sources.length) return { picked, leftOut };
  const merged = pullRequests('merged');
  if (!merged)
    attention('could not list merged PRs with gh, so only the content decides');
  for (const source of sources) {
    const pull = mergedCopyPull(source, merged, own.get(source) ?? []);
    if (pull && !pull.inBase) {
      leftOut.push(`${cyan(source)}  left out: ${notFetched(pull)}`);
      attention(leftOut.at(-1)!);
      continue;
    }
    if (pull?.landed) {
      picked.push(source);
      good(`${cyan(source)}  #${pull.number} merged on GitHub`);
      continue;
    }
    const below = branches[branches.indexOf(source) - 1];
    const landed = mergeTree(below ? tipOf(below) : fork, base, source);
    if (landed.ok && landed.tree === treeOf(base)) {
      picked.push(source);
      good(`${cyan(source)}  contained in ${base}`);
    } else if (pull) {
      leftOut.push(`${cyan(source)}  left out: ${notAllMerged(pull)}`);
      attention(leftOut.at(-1)!);
    } else if (!landed.ok) {
      leftOut.push(
        `${cyan(source)}  left out: can't tell, so compare by hand; to drop it anyway: stack-plan cut ${source}`,
      );
      attention(leftOut.at(-1)!);
    }
  }
  return { picked, leftOut };
};

// Picks every __ branch that has landed, then drops them as cut <__branch>... would.
const dropMergedSources = (apply: boolean) => {
  const wip = currentBranch();
  const { branches, own } = readStack(wip);
  heading(`Landed ${EXTRACT_SOURCE_PREFIX} branches`);
  const { picked, leftOut } = landedSources(branches, own, forkOf(wip));
  if (!picked.length) {
    good(`no ${EXTRACT_SOURCE_PREFIX} branch has landed; nothing to drop`);
    return;
  }
  dropExtractSources(picked, apply, 'cut --merged', leftOut);
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

const upstreamGone = (branch: string) =>
  git(
    'for-each-ref',
    '--format=%(upstream:track)',
    `refs/heads/${branch}`,
  ).trim() === '[gone]';

const countOf = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

// A sync may change a file at the tip only where origin's stack differs from the local one, a drop only where the base moved.
const sameTipOutsideOrigin = (
  oldTop: string,
  oldTip: string,
  newTop: string,
  newTip: string,
  where = "origin's stack differs from yours",
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
      `the tip tree is unchanged, except ${countOf(changed.length, 'file')} where ${where}`,
    );
    return true;
  }
  bad(`the tip tree changes in files other than where ${where}:`);
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
  // With nothing on origin, only the pushed branches origin deleted have merged; a branch never pushed has no upstream.
  const mergedAndDeleted = branches.findIndex(
    (branch) => isExtractSource(branch) || !upstreamGone(branch),
  );
  const lowestOnOrigin = highestRemote
    ? branches.indexOf(branchesOnOrigin[lowestInOriginStack])
    : mergedAndDeleted < 0
      ? branches.length
      : mergedAndDeleted;
  const cut: string[] = [];
  let unclearCuts = 0;
  for (const branch of branches.slice(0, lowestOnOrigin)) {
    if (highestRemote && isAncestor(tipOf(branch), highestRemote)) {
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
  // With no origin stack left, the rest moves onto the base, as after a cut.
  const onBase = !adopted.length;
  const topBranch = adopted.at(-1);
  const topRemote = topBranch && remoteOfBranch.get(topBranch)!;
  const onto = onBase
    ? tipOf(base)
    : git('merge-base', base, remoteOfBranch.get(adopted[0])!).trim();
  let below = { name: base, sha: onto };
  for (const remote of adopted.map((branch) => remoteOfBranch.get(branch)!)) {
    if (!isAncestor(below.sha, remote))
      throw new Error(
        `${remote} does not sit on ${below.name}; origin's stack is not one line`,
      );
    below = { name: remote, sha: remote };
  }
  if (
    topRemote &&
    git('rev-list', '--merges', `${onto}..${topRemote}`).trim()
  ) {
    throw new Error(
      `origin's stack holds merge commits, which the rebase cannot replay; sync by hand`,
    );
  }

  subheading(`Landed ${EXTRACT_SOURCE_PREFIX} branches`);
  const landed = landedSources(branches, own, fork);
  // Dropping a source whose change origin's base lacks would take that change out of the tip.
  const droppedSources = landed.picked.filter((source) => {
    if (!kept.includes(source)) return false;
    if (onBase) return true;
    const belowSource = branches[branches.indexOf(source) - 1];
    const inOnto = mergeTree(
      belowSource ? tipOf(belowSource) : fork,
      onto,
      source,
    );
    if (inOnto.ok && inOnto.tree === treeOf(onto)) return true;
    attention(
      `${cyan(source)}  landed, but origin's stack sits on an older ${base}, so it stays until that moves`,
    );
    return false;
  });
  if (!landed.picked.length && !landed.leftOut.length)
    good(`no ${EXTRACT_SOURCE_PREFIX} branch has landed`);
  // With nothing on origin, a newer base is still worth moving onto.
  const baseMoved = onBase && onto !== fork;
  if (onBase && !baseMoved && !cut.length && !droppedSources.length)
    throw new Error(
      `no stack branch is on origin, none has merged, and the stack already sits on ${base}; nothing to sync`,
    );

  const originRange = topRemote ? `${onto}..${topRemote}` : undefined;
  const originCommits = originRange ? commitsIn(originRange) : [];
  const originShas = new Set(originCommits.map((commit) => commit.sha));
  const originShaById = new Map(
    originRange
      ? [...patchIdsIn(originRange)].map(([sha, id]) => [id, sha])
      : [],
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
    if (droppedSources.includes(branch)) {
      dropped.push(...(own.get(branch) ?? []));
      console.log(`${cyan(branch)}  dropped, landed in ${base}`);
      continue;
    }
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

  if (!onBase) {
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
  }

  if (!baseMoved && !cut.length && !dropped.length && !newFromOrigin) {
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
    if (topBranch) {
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
    } else {
      // The checks cut runs, since the whole stack moves onto the base.
      const sameNet = sameNetChange(
        'the stack',
        fork,
        wip,
        onto,
        simulation.tip,
        base,
        new Set(fileList(gitQuiet('diff', '--name-only', fork, onto))),
      );
      const sameTip = sameTipOutsideOrigin(
        fork,
        wip,
        onto,
        simulation.tip,
        `${base} moved since the stack left it`,
      );
      if (!sameNet || !sameTip || sameNet === 'unclear') findings++;
    }
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
  const cutAndDropped = [...cut, ...droppedSources];
  // With no origin stack, verify reads it as a cut whose old range starts at the fork.
  if (topBranch && topRemote)
    writeHeader(
      SYNC_PREFIX,
      [
        onto,
        fork,
        tipOf(topBranch),
        tipOf(topRemote),
        topBranch,
        ...cutAndDropped,
      ].join(' '),
    );
  else writeHeader(CUT_PREFIX, [fork, onto, ...cutAndDropped].join(' '));
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
  const extractedIdOfSha = patchIdsIn(`${extractedFork}..${extracted}`);
  const extractedIds = new Set(extractedIdOfSha.values());
  const missing = sourceCommits.filter((commit) => {
    const id = sourceIdOfSha.get(commit.sha);
    return id !== undefined && !extractedIds.has(id);
  });
  const extra = [...extractedIdOfSha]
    .filter(([, id]) => !sourceIds.has(id))
    .map(([sha]) => sha);
  return { missing, extraCount: extra.length, extra };
};

// A subject pairs only where it is unique among the copy's extra commits and among the missing source commits.
const sourceVersionsByCopySha = (copyShas: string[], missing: Commit[]) => {
  const copyCommits = copyShas.map(subjectOf);
  const countsBySubject = (subjects: string[]) => {
    const counts = new Map<string, number>();
    for (const subject of subjects)
      counts.set(subject, (counts.get(subject) ?? 0) + 1);
    return counts;
  };
  const copyCounts = countsBySubject(copyCommits.map((c) => c.subject));
  const sourceCounts = countsBySubject(missing.map((c) => c.subject));
  return new Map(
    copyCommits.flatMap(({ sha, subject }) => {
      const sourceVersion = missing.find((c) => c.subject === subject);
      const unique =
        copyCounts.get(subject) === 1 && sourceCounts.get(subject) === 1;
      return sourceVersion && unique ? [[sha, sourceVersion] as const] : [];
    }),
  );
};

// Commits the base holds are lower copies that landed; only the rest is work to bring into the source.
const splitExtras = (extra: string[], missing: Commit[], pair: boolean) => {
  const unlanded = [...extra].reverse().filter((sha) => {
    const merged = mergeTree(`${sha}^`, base, sha);
    return !merged.ok || merged.tree !== treeOf(base);
  });
  const held = extra.length - unlanded.length;
  const sourceVersionOf =
    !held && pair
      ? sourceVersionsByCopySha(unlanded, missing)
      : new Map<string, Commit>();
  const unpaired = unlanded.filter((sha) => !sourceVersionOf.has(sha));
  return { held, unpaired, sourceVersionOf };
};

type OriginCommands = {
  gone: string;
  newWork: (remote: string, fastForward: boolean) => string;
};

/** How a branch differs from its origin copy, and the command that brings them together; undefined where they match or origin has none. */
const originState = (branch: string, commands: OriginCommands) => {
  if (upstreamGone(branch))
    return {
      parts: ['its origin branch is gone'],
      command: commands.gone,
      first: true,
    };
  const remote = remoteOf(branch);
  if (!remote) return undefined;
  const [onlyLocal, onlyOrigin] = git(
    'rev-list',
    '--left-right',
    '--count',
    `${branch}...${remote}`,
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  if (!onlyLocal && !onlyOrigin) return undefined;
  const parts = [
    ...(onlyLocal ? [`${countOf(onlyLocal, 'commit')} not on ${remote}`] : []),
    ...(onlyOrigin
      ? [`${countOf(onlyOrigin, 'commit')} only on ${remote}`]
      : []),
  ];
  // Origin commits matching a local one by patch-id were only rewritten here, by a rebase.
  const localIds = onlyOrigin
    ? new Set(patchIdsIn(`${remote}..${branch}`).values())
    : new Set<string>();
  const newWork =
    onlyOrigin > 0 &&
    [...patchIdsIn(`${branch}..${remote}`).values()].some(
      (id) => !localIds.has(id),
    );
  const command = newWork
    ? commands.newWork(remote, !onlyLocal)
    : onlyOrigin
      ? `git push --force-with-lease origin ${branch}`
      : `git push origin ${branch}`;
  return { parts, command, first: newWork };
};

// The reflog finds where a lower copy stood before an amend or rebase rewrote it; the merge-base then falls one rewrite short.
const forkPointOf = (below: string, extracted: string) => {
  const mergeBase = git('merge-base', below, extracted).trim();
  try {
    const forkPoint = git(
      'merge-base',
      '--fork-point',
      below,
      extracted,
    ).trim();
    return forkPoint && isAncestor(mergeBase, forkPoint)
      ? forkPoint
      : mergeBase;
  } catch {
    return mergeBase;
  }
};

// Where an extracted branch's own commits start: the latest point it shares with the base or a lower extracted copy.
const extractedForkOf = (extracted: string, extractedBelow: string[]) => {
  let fork = git('merge-base', base, extracted).trim();
  let on: string | undefined;
  for (const below of extractedBelow.filter(branchExists)) {
    const forkOnBelow = forkPointOf(below, extracted);
    if (forkOnBelow !== fork && isAncestor(fork, forkOnBelow)) {
      fork = forkOnBelow;
      on = below;
    }
  }
  return { fork, on };
};

// Where a copy's own commits start when they sit on commits the base holds, as when a lower copy in its chain landed.
const landedForkOf = (
  extracted: string,
  fork: string,
  sourceCommits: Commit[],
) => {
  if (!sourceCommits.length) return undefined;
  const sourceIds = new Set(
    patchIdsIn(
      `${sourceCommits[0].sha}^..${sourceCommits.at(-1)!.sha}`,
    ).values(),
  );
  const idOfSha = patchIdsIn(`${fork}..${extracted}`);
  const line = commitsIn(`${fork}..${extracted}`);
  let start = line.length;
  while (start > 0 && sourceIds.has(idOfSha.get(line[start - 1].sha) ?? ''))
    start--;
  if (start === 0 || start === line.length) return undefined;
  const landedTip = line[start - 1].sha;
  const merged = mergeTree(fork, base, landedTip);
  return merged.ok && merged.tree === treeOf(base) ? landedTip : undefined;
};

// Where a copy's own commits start when the lower copy it sat on is deleted: past the run matching that copy's source.
const chainForkOf = (
  extracted: string,
  fork: string,
  sourcesBelow: string[],
) => {
  const idOfSha = patchIdsIn(`${fork}..${extracted}`);
  const line = commitsIn(`${fork}..${extracted}`);
  const runLength = (ids: Set<string>) => {
    let end = 0;
    while (end < line.length && ids.has(idOfSha.get(line[end].sha) ?? ''))
      end++;
    return end;
  };
  let found: { end: number; on: string } | undefined;
  for (const source of sourcesBelow) {
    const copy = extractedNameOf(source);
    if (branchExists(copy)) continue;
    const end = runLength(new Set(patchIdsIn(`${base}..${source}`).values()));
    if (end > (found?.end ?? 0) && end < line.length) found = { end, on: copy };
  }
  if (!found) return undefined;
  const chainTip = line[found.end - 1].sha;
  // A run the base already holds is landedForkOf's case.
  const merged = mergeTree(fork, base, chainTip);
  if (merged.ok && merged.tree === treeOf(base)) return undefined;
  return { fork: chainTip, on: found.on };
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
): {
  group: string[];
  directNeeds: string[];
  declared: string[];
  blocker?: string;
  barred?: string[];
} => {
  const { branches, own } = stack;
  const declared = declaredNeeds(branch, branches);
  // A declared need brings its own declared needs along, since a text conflict would not show those either.
  let group = [branch];
  for (let i = 0; i < group.length; i++) {
    const needs = declaredNeeds(group[i], branches);
    const above = needs.filter(
      (need) => branches.indexOf(need) > branches.indexOf(group[i]),
    );
    if (above.length)
      return {
        group: [branch],
        directNeeds: [],
        declared,
        blocker: `${group[i]} declares it needs ${above.join(', ')}, which sits above it`,
      };
    const barred = needs.filter((need) => !mayJoin(need));
    if (barred.length)
      return {
        group: [branch],
        directNeeds: [],
        declared,
        blocker: `needs ${barred.join(', ')} (declared)`,
        barred,
      };
    group.push(...needs.filter((need) => !group.includes(need)));
  }
  const directNeeds = [...declared];
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
        declared,
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
        declared,
        blocker: `conflicts with ${base} itself (${files})`,
      };
    const barred = needs.filter((need) => !mayJoin(need));
    if (barred.length)
      return {
        group,
        directNeeds,
        declared,
        blocker: `needs ${barred.join(', ')} (${files})`,
        barred,
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
  // commit-tree ignores commit.gpgSign, and -S fails without a signing key.
  return execFileSync(
    'git',
    ['commit-tree', '-S', tree, '-p', parent, '-F', '-'],
    {
      input: `${message.trimEnd()}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
      },
    },
  ).trim();
};

type ExtractReplay =
  { ok: true; tip: string } | { ok: false; commit: Commit; files: string[] };

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

/** Returns the comment line export writes above a __ branch: the state of its extracted copy, and the command that brings it back in sync. */
const mirrorStatus = (
  source: string,
  sourcesBelow: string[],
  sourceCommits: Commit[],
  pulls?: Map<string, PullRequest>,
) => {
  const extracted = extractedNameOf(source);
  if (!branchExists(extracted)) {
    const pull = pulls?.get(extracted);
    const atTip = pull ? ` · PR #${pull.number}, goes back at the tip` : '';
    return `${MIRROR_STATUS_PREFIX}${extracted} · not extracted${atTip} → stack-plan extract`;
  }
  const found = extractedForkOf(extracted, sourcesBelow.map(extractedNameOf));
  const { on } = found;
  let { fork } = found;
  let { missing, extraCount, extra } = compareWithExtracted(
    sourceCommits,
    extracted,
    fork,
  );
  const landedTip =
    on === undefined && extraCount
      ? landedForkOf(extracted, fork, sourceCommits)
      : undefined;
  if (landedTip) {
    fork = landedTip;
    ({ missing, extraCount, extra } = compareWithExtracted(
      sourceCommits,
      extracted,
      fork,
    ));
  }
  const chained =
    on === undefined && extraCount && !landedTip
      ? chainForkOf(extracted, fork, sourcesBelow)
      : undefined;
  if (chained) {
    fork = chained.fork;
    ({ missing, extraCount, extra } = compareWithExtracted(
      sourceCommits,
      extracted,
      fork,
    ));
  }
  const { held, unpaired } = splitExtras(extra, missing, true);
  const pull = pulls?.get(extracted);
  const onOldCopy = on !== undefined && tipOf(on) !== fork;
  const onOldBase =
    on === undefined && !landedTip && !chained && fork !== tipOf(base);
  const stale =
    landedTip !== undefined || chained !== undefined || onOldCopy || onOldBase;
  const origin = originState(extracted, {
    gone: 'stack-plan cut --merged',
    newWork: (remote, fastForward) =>
      fastForward
        ? `git branch -f ${extracted} ${remote}`
        : `compare by hand: git range-diff ${remote}...${extracted}`,
  });
  const parts = [
    extracted,
    ...(pulls ? [pull ? `PR #${pull.number}` : 'no PR'] : []),
    ...(landedTip ? [`on landed commits`] : []),
    ...(chained ? [`on a missing ${chained.on}`] : []),
    ...(onOldCopy ? [`on an old ${on}`] : []),
    ...(onOldBase ? [`on an old ${base}`] : []),
    missing.length
      ? `${countOf(missing.length, 'commit')} behind`
      : stale
        ? 'own commits up to date'
        : 'up to date',
    ...(extraCount
      ? [`${countOf(extraCount, 'commit')} only on ${extracted}`]
      : []),
    ...(origin?.parts ?? []),
  ];
  // Origin's new work comes into the copy first, the copy's into the source next, and a push goes last.
  const command = origin?.first
    ? origin.command
    : unpaired.length && !held
      ? `stack-plan extract --from-copy ${source}`
      : missing.length || extraCount || landedTip || chained || onOldCopy
        ? 'stack-plan extract'
        : onOldBase
          ? 'stack-plan extract --rebase'
          : origin?.command;
  return `${MIRROR_STATUS_PREFIX}${parts.join(' · ')}${command ? ` → ${command}` : ''}`;
};

// Copies each __ branch's commits onto the branch named without the prefix, off the stack; --apply moves those refs.
const extractBranches = (apply: boolean, landedOnly = false) => {
  const wip = currentBranch();
  const stack = readStack(wip);
  const { branches, own } = stack;
  const sources = branches.filter(isExtractSource);
  heading(
    landedOnly
      ? 'Rebuild extracted copies on landed commits'
      : `Extract onto ${base}`,
  );
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
  const merged = pullRequests('merged');
  const open = openPullRequests();
  if (!open)
    attention(
      'could not list PRs with gh, so a missing copy with a PR is replayed rather than put back at its tip',
    );
  const moves: { extracted: string; tip: string; oldTip: string }[] = [];
  const backAtTip: string[] = [];
  const rebuilt: string[] = [];
  const leftForExtract: string[] = [];
  const forcePushes: string[] = [];
  const plannedTip = new Map<string, string>();
  let findings = 0;
  const takeable: string[] = [];
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
  // A branch in a chain goes on the copy of the one below it there, so each copy holds all it needs.
  const targetOf = (source: string) => {
    const chain = chains.find((members) => members.includes(source)) ?? [];
    const chainedOn = chain[chain.indexOf(source) - 1];
    const onto = chainedOn ? extractedNameOf(chainedOn) : base;
    return { onto, start: chainedOn ? plannedTip.get(onto) : tipOf(base) };
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
    const below = branches[branches.indexOf(source) - 1];
    const landed = mergeTree(below ? tipOf(below) : forkOf(wip), base, source);
    const found = mergedCopyPull(source, merged, commits);
    const pull = found?.landed ? found : undefined;
    if (found && !found.inBase) attention(`${label}  ${notFetched(found)}`);
    else if (found && !found.landed)
      attention(`${label}  ${notAllMerged(found)}`);
    if (pull || (landed.ok && landed.tree === treeOf(base))) {
      if (branchExists(extracted)) plannedTip.set(extracted, tipOf(extracted));
      const how = pull
        ? `#${pull.number} merged on GitHub`
        : `already in ${base}`;
      attention(
        `${label}  ${how}; to drop it from the stack: stack-plan cut ${source}`,
      );
      return;
    }
    if (branchExists(extracted)) {
      const oldTip = tipOf(extracted);
      plannedTip.set(extracted, oldTip);
      const forkFound = extractedForkOf(
        extracted,
        sources.slice(0, i).map(extractedNameOf),
      );
      let { on, fork } = forkFound;
      let { missing, extraCount, extra } = compareWithExtracted(
        commits,
        extracted,
        fork,
      );
      const landedTip =
        on === undefined && extraCount
          ? landedForkOf(extracted, fork, commits)
          : undefined;
      if (landedTip) {
        fork = landedTip;
        ({ missing, extraCount, extra } = compareWithExtracted(
          commits,
          extracted,
          fork,
        ));
      }
      const chained =
        on === undefined && extraCount && !landedTip
          ? chainForkOf(extracted, fork, sources.slice(0, i))
          : undefined;
      if (chained) {
        // The missing copy is made earlier in this run, and this one is rebuilt on it.
        if (!plannedTip.has(chained.on)) {
          findings++;
          bad(
            `${label}  sits on ${chained.on}, which is missing and could not be made; see above`,
          );
          return;
        }
        ({ fork, on } = chained);
        ({ missing, extraCount, extra } = compareWithExtracted(
          commits,
          extracted,
          fork,
        ));
      }
      let sourceVersionOf = new Map<string, Commit>();
      if (extraCount) {
        const split = splitExtras(extra, missing, true);
        const { held, unpaired } = split;
        sourceVersionOf = split.sourceVersionOf;
        if (held || unpaired.length) {
          findings++;
          const alsoHeld = held ? `; ${held} more ${base} already holds` : '';
          if (unpaired.length) {
            if (!held) takeable.push(source);
            attention(
              `${label}  has ${countOf(unpaired.length, 'commit')} neither ${source} nor ${base} holds${alsoHeld}; bring them into ${source} first:`,
            );
            for (const sha of unpaired) console.log(commitLine(subjectOf(sha)));
          } else
            attention(
              `${label}  sits on ${countOf(held, 'commit')} ${base} already holds, mixed in with its own; compare by hand`,
            );
          return;
        }
        // verify applies without a check first, so replacing commits waits for extract.
        if (landedOnly) {
          attention(
            `${label}  has ${countOf(sourceVersionOf.size, 'commit')} that ${source} holds another version of; to compare and replace them: stack-plan extract`,
          );
          for (const [copySha, sourceVersion] of sourceVersionOf)
            console.log(
              `  ${yellow(copySha.slice(0, 10))} → ${commitLine(sourceVersion).trimStart()}`,
            );
          leftForExtract.push(extracted);
          return;
        }
        const replacing = new Set(sourceVersionOf.values());
        missing = missing.filter((commit) => !replacing.has(commit));
      }
      // A copy whose lower copy moved is rebuilt on it, which rewrites the copy's history.
      const onTip = on === undefined ? undefined : plannedTip.get(on);
      const movedOn = onTip !== undefined && onTip !== fork ? on : undefined;
      if (landedOnly && !landedTip && !movedOn) return;
      const onOldBase =
        rebaseCopies && on === undefined && !landedTip && fork !== tipOf(base);
      const replaces = sourceVersionOf.size > 0;
      const rebuildsOnBase = landedTip !== undefined || onOldBase;
      if (!missing.length && !rebuildsOnBase && !movedOn && !replaces) {
        good(`${label}  up to date`);
        return;
      }
      let rebuildOn = movedOn;
      let start = onTip;
      if (rebuildsOnBase) {
        const blocker = blockerOf.get(source);
        if (blocker) {
          findings++;
          const sitsOn = landedTip ? 'landed commits' : `an older ${base}`;
          bad(`${label}  sits on ${sitsOn}, but ${blocker}`);
          return;
        }
        ({ onto: rebuildOn, start } = targetOf(source));
        if (!start) {
          findings++;
          bad(
            `${label}  goes on ${rebuildOn}, which could not be made; see above`,
          );
          return;
        }
      }
      const rebuildStart = rebuildOn ? start : replaces ? fork : undefined;
      const ownCommits = () =>
        commitsIn(`${fork}..${extracted}`).map(
          (commit) => sourceVersionOf.get(commit.sha) ?? commit,
        );
      const replay = rebuildStart
        ? replayOnto([...ownCommits(), ...missing], rebuildStart)
        : replayOnto(missing, oldTip);
      if (!replay.ok)
        return reportConflict(label, rebuildOn ?? extracted, replay);
      // A rebuild in place that ends on the copy's own files changes only SHAs, and a force push would rerun CI for nothing.
      if (!rebuildOn && rebuildStart && treeOf(replay.tip) === treeOf(oldTip)) {
        good(
          `${label}  up to date; ${countOf(sourceVersionOf.size, 'commit')} ${sourceVersionOf.size === 1 ? 'differs' : 'differ'} from ${source}'s version only in context`,
        );
        return;
      }
      const added = missing.length
        ? `+${countOf(missing.length, 'commit')}`
        : '';
      if (rebuildStart) {
        const where = rebuildOn ? ` on ${rebuildOn}` : '';
        const off = landedTip ? ', off landed commits' : '';
        const replaced = replaces
          ? `, ${countOf(sourceVersionOf.size, 'commit')} replaced by ${source}'s version`
          : '';
        const pushed = remoteOf(extracted) !== undefined;
        good(
          `${label}  rebuilt${where}${off}${replaced}${added ? `, ${added}` : ''}${pushed ? '; needs a force push' : ''}`,
        );
        for (const [copySha, sourceVersion] of sourceVersionOf)
          console.log(
            `  ${yellow(copySha.slice(0, 10))} → ${commitLine(sourceVersion).trimStart()}`,
          );
        rebuilt.push(extracted);
        if (pushed) forcePushes.push(extracted);
      } else good(`${label}  ${added}`);
      moves.push({ extracted, tip: replay.tip, oldTip });
      plannedTip.set(extracted, replay.tip);
      return;
    }
    if (landedOnly) return;
    // A copy with an open PR goes back at its source's tip, as mark made it, since a replay would give the PR new SHAs.
    const openPull = open?.get(extracted);
    if (openPull) {
      const belowCopy =
        below && isExtractSource(below) ? extractedNameOf(below) : '';
      if (below && plannedTip.get(belowCopy) !== tipOf(below)) {
        findings++;
        bad(
          `${label}  has PR #${openPull.number}, but ${below} has no copy at its tip to sit on; make it by hand`,
        );
        return;
      }
      good(
        `${label}  new at ${source}'s tip, so PR #${openPull.number} keeps its commits`,
      );
      moves.push({ extracted, tip: tipOf(source), oldTip: '' });
      plannedTip.set(extracted, tipOf(source));
      backAtTip.push(extracted);
      return;
    }
    const blocker = blockerOf.get(source);
    if (blocker) {
      findings++;
      bad(`${label}  ${blocker}`);
      return;
    }
    const { onto, start } = targetOf(source);
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
  else if (moves.length)
    good(
      `${branchCount} to create or move forward${rebuilt.length ? `, ${rebuilt.length} of them rebuilt` : ''}`,
    );
  else if (!landedOnly) good('every extracted branch is up to date');
  else if (!leftForExtract.length)
    good('no extracted copy sits on landed commits');
  if (leftForExtract.length)
    attention(`left for stack-plan extract: ${leftForExtract.join(', ')}`);
  const applyCommand = `stack-plan extract --apply${rebaseCopies ? ' --rebase' : ''}`;
  const takeFirst = takeable.length
    ? `First: stack-plan extract --from-copy ${takeable.join(' ')}, then run extract again`
    : undefined;
  // verify goes on to tidy after this, so a finding must not end the process there.
  if (!apply) {
    if (takeFirst) console.log(takeFirst);
    else if (moves.length)
      console.log(`To do it: ${applyCommand}${findings ? ' -f' : ''}`);
    if (findings && !landedOnly) process.exit(1);
    return;
  }
  if (findings && !rest.includes('--anyway')) {
    console.log(
      `\nNo branch moved. ${takeFirst ?? `To move the clean ones anyway: ${applyCommand} -f`}`,
    );
    if (!landedOnly) process.exit(1);
    return;
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
  // The PR's branch tracks origin again, as mark leaves it.
  for (const extracted of backAtTip) {
    const remote = `origin/${extracted}`;
    if (
      gitSucceeds('show-ref', '--verify', '--quiet', `refs/remotes/${remote}`)
    )
      git('branch', `--set-upstream-to=${remote}`, extracted);
  }
  if (forcePushes.length)
    attention(
      `rebuilt, so a plain push is refused: git push --force-with-lease origin ${forcePushes.join(' ')}`,
    );
};

type TakenBranch = {
  name: string;
  oldTip: string;
  copyFork?: string;
  copyTip?: string;
};
type TakenRecord = { start: string; branches: TakenBranch[] };

// ':' cannot appear in a ref name, so it separates a branch from its SHAs.
const takenRecordLine = ({ start, branches }: TakenRecord) =>
  [
    start,
    ...branches.map(({ name, oldTip, copyFork, copyTip }) =>
      [name, oldTip, ...(copyFork && copyTip ? [copyFork, copyTip] : [])].join(
        ':',
      ),
    ),
  ].join(' ');

const parseTakenRecord = (line: string): TakenRecord => {
  const [start, ...entries] = words(line);
  return {
    start,
    branches: entries.map((entry) => {
      const [name, oldTip, copyFork, copyTip] = entry.split(':');
      return { name, oldTip, copyFork, copyTip };
    }),
  };
};

const filesOfCommit = (sha: string) =>
  fileList(
    gitQuiet('diff-tree', '-r', '--root', '--no-commit-id', '--name-only', sha),
  );

/** Checks that each taken branch ends with its copy's net change, and every other branch and wip with its old one. */
const sameAsCopiesAndBefore = (
  taken: TakenRecord,
  newTipOf: (branch: string) => string,
  oldWipTip: string,
  newWipTip: string,
  wip: string,
) => {
  const results: (boolean | 'unclear')[] = [];
  const takenFiles = new Set<string>();
  let oldBelow = taken.start;
  let newBelow = taken.start;
  let top: { oldTip: string; newTip: string } | undefined;
  for (const { name, oldTip, copyFork, copyTip } of taken.branches) {
    const newTip = newTipOf(name);
    if (copyFork && copyTip) {
      // Commits the copy lacks stay in the branch, so the files they touch may end differently.
      const copyIds = new Set(patchIdsIn(`${copyFork}..${copyTip}`).values());
      const keptFiles = new Set(
        [...patchIdsIn(`${newBelow}..${newTip}`)]
          .filter(([, id]) => !copyIds.has(id))
          .flatMap(([sha]) => filesOfCommit(sha)),
      );
      results.push(
        sameNetChange(
          extractedNameOf(name),
          copyFork,
          copyTip,
          newBelow,
          newTip,
          name,
          keptFiles,
        ),
      );
      for (const file of fileList(
        gitQuiet('diff', '--name-only', oldTip, newTip),
      ))
        takenFiles.add(file);
      top = { oldTip, newTip };
    } else
      results.push(
        sameNetChange(
          name,
          oldBelow,
          oldTip,
          newBelow,
          newTip,
          'the rebased stack',
          takenFiles,
        ),
      );
    oldBelow = oldTip;
    newBelow = newTip;
  }
  results.push(
    sameNetChange(
      `${wip}'s own commits`,
      oldBelow,
      oldWipTip,
      newBelow,
      newWipTip,
      'the rebased stack',
      takenFiles,
    ),
  );
  if (top)
    results.push(
      sameTipOutsideOrigin(
        top.oldTip,
        oldWipTip,
        top.newTip,
        newWipTip,
        'a taken copy differs from its source',
      ),
    );
  if (results.includes(false)) return false;
  return results.includes('unclear') ? 'unclear' : true;
};

// What a __ branch becomes when its copy wins: paired commits swapped for the copy's, the copy's own on top.
const takenFromCopy = (
  source: string,
  commits: Commit[],
  sourcesBelow: string[],
) => {
  const copy = extractedNameOf(source);
  const found = extractedForkOf(copy, sourcesBelow.map(extractedNameOf));
  const chained =
    found.on === undefined
      ? chainForkOf(copy, found.fork, sourcesBelow)
      : undefined;
  const fork = chained?.fork ?? found.fork;
  const { missing, extra } = compareWithExtracted(commits, copy, fork);
  const landed = extra.filter((sha) => {
    const merged = mergeTree(`${sha}^`, base, sha);
    return merged.ok && merged.tree === treeOf(base);
  });
  const unlanded = extra.filter((sha) => !landed.includes(sha));
  const sourceVersionOf = sourceVersionsByCopySha(unlanded, missing);
  const copyCommits = commitsIn(`${fork}..${copy}`);
  const copyVersionOf = new Map(
    [...sourceVersionOf].map(([copySha, sourceVersion]) => [
      sourceVersion.sha,
      copyCommits.find((commit) => commit.sha === copySha)!,
    ]),
  );
  return {
    copy,
    fork,
    copyTip: tipOf(copy),
    landed,
    copyVersionOf,
    added: copyCommits.filter(
      (commit) =>
        unlanded.includes(commit.sha) && !sourceVersionOf.has(commit.sha),
    ),
    kept: missing.filter((commit) => !copyVersionOf.has(commit.sha)),
  };
};

// Rewrites each named __ branch to take its extracted copy's commits, and replays everything above it unchanged.
const takeFromCopies = (names: string[], apply: boolean) => {
  const wip = currentBranch();
  const { branches, pending, own } = readStack(wip);
  const unknown = names.filter(
    (name) => !isExtractSource(name) || !branches.includes(name),
  );
  if (unknown.length)
    throw new Error(
      `${unknown.join(', ')} not a ${EXTRACT_SOURCE_PREFIX} branch below ${wip}; the stack is: ${branches.join(' ')}`,
    );
  const noCopy = names.filter((name) => !branchExists(extractedNameOf(name)));
  if (noCopy.length)
    throw new Error(
      `${noCopy.join(', ')} has no extracted copy to take from; run stack-plan extract --apply first`,
    );
  const lowest = branches.findIndex((branch) => names.includes(branch));
  const below = branches[lowest - 1];
  const start = below ? tipOf(below) : forkOf(wip);
  const sources = branches.filter(isExtractSource);
  heading(`Take ${names.join(', ')} from the extracted copies`);
  let findings = 0;
  let takenCount = 0;

  subheading('Branches');
  const { todo, sequence, pick } = newTodo();
  const dropped: Commit[] = [];
  const adopted: string[] = [];
  const record: TakenRecord = { start, branches: [] };
  const picksUpTo = new Map<string, number>();
  const pickFromCopy = (commit: Commit) => {
    pick(commit, `${COPY_MARKER} `);
    adopted.push(commit.sha);
  };
  for (const branch of branches.slice(lowest)) {
    const commits = own.get(branch) ?? [];
    if (!names.includes(branch)) {
      for (const commit of commits) pick(commit);
      todo.push(`update-ref refs/heads/${branch}`, '');
      picksUpTo.set(branch, sequence.length);
      record.branches.push({ name: branch, oldTip: tipOf(branch) });
      continue;
    }
    const taken = takenFromCopy(
      branch,
      commits,
      sources.slice(0, sources.indexOf(branch)),
    );
    const label = `${cyan(branch)} ← ${cyan(taken.copy)}`;
    if (taken.landed.length) {
      findings++;
      attention(
        `${label}  ${taken.copy} sits on ${countOf(taken.landed.length, 'commit')} ${base} already holds; run stack-plan extract first`,
      );
    }
    for (const commit of commits) {
      const copyVersion = taken.copyVersionOf.get(commit.sha);
      if (!copyVersion) {
        pick(commit);
        continue;
      }
      dropped.push(commit);
      pickFromCopy(copyVersion);
    }
    for (const commit of taken.added) pickFromCopy(commit);
    todo.push(`update-ref refs/heads/${branch}`, '');
    picksUpTo.set(branch, sequence.length);
    record.branches.push({
      name: branch,
      oldTip: tipOf(branch),
      copyFork: taken.fork,
      copyTip: taken.copyTip,
    });
    takenCount += taken.copyVersionOf.size + taken.added.length;
    if (!taken.copyVersionOf.size && !taken.added.length)
      good(`${label}  already holds every commit of ${taken.copy}`);
    else {
      console.log(
        `${label}  ${taken.copyVersionOf.size} replaced by ${taken.copy}'s version · ${taken.added.length} new from ${taken.copy}`,
      );
      for (const [sourceSha, copyVersion] of taken.copyVersionOf)
        console.log(
          `  ${yellow(sourceSha.slice(0, 10))} → ${commitLine(copyVersion).trimStart()}`,
        );
      for (const commit of taken.added)
        console.log(`  ${yellow('new')}${commitLine(commit)}`);
    }
    if (taken.kept.length) {
      attention(
        `${label}  keeps ${countOf(taken.kept.length, 'commit')} ${taken.copy} lacks; stack-plan extract adds them to it afterwards:`,
      );
      for (const commit of taken.kept) console.log(commitLine(commit));
    }
  }
  for (const commit of pending) pick(commit);

  if (!takenCount) {
    console.log('');
    good('every named branch already holds its copy; nothing to take');
    return;
  }

  subheading('Preview');
  const simulation = simulateRebase(sequence, start, wip);
  if (simulation.conflicts.length) {
    findings++;
    reportConflicts(simulation, start, '', landingBranches(todo, wip));
  } else {
    good(`all ${simulation.picks} picks apply cleanly in memory`);
    const newTipOf = (branch: string) => {
      const count = picksUpTo.get(branch) ?? 0;
      return count ? simulation.tipAfterPick[count - 1] : start;
    };
    const same = sameAsCopiesAndBefore(
      record,
      newTipOf,
      tipOf(wip),
      simulation.tip,
      wip,
    );
    if (same !== true) findings++;
  }

  subheading('Conclusion');
  if (findings) attention('some of it needs a look by hand; see above');
  else
    good(
      `${countOf(takenCount, 'commit')} taken from the extracted copies, and the rest of the stack replays unchanged`,
    );
  const rerun = `extract --from-copy ${names.join(' ')}`;
  if (!apply) {
    if (findings) process.exit(1);
    console.log(`To do it: stack-plan ${rerun} --apply`);
    return;
  }
  if (findings && !rest.includes('--anyway')) {
    console.log(
      `\nNothing rewritten. To take them anyway: stack-plan ${rerun} --apply -f`,
    );
    process.exit(1);
  }

  ensurePlanFile(wip);
  recordPreRebase(tipOf(wip), []);
  writeHeader(FROM_COPY_PREFIX, takenRecordLine(record));
  const drops = dropped.map((commit) => `drop ${commit.sha} ${commit.subject}`);
  runRebase(
    [
      ...(drops.length
        ? ["# replaced by the extracted copy's version", ...drops, '']
        : []),
      ...todo,
    ],
    ['rebase', '-i', '--update-refs', start],
    adopted,
  );
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
      ...commitsOf(group.filter(movable)),
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

  // A branch may stack on a __ branch, whose extracted copy then becomes its base, but never on a branch with a PR.
  const mayJoin = (branch: string) =>
    movable(branch) || isExtractSource(branch);
  const uptoBranch = upto && stackBranchNamed(upto, branches);
  if (upto && !uptoBranch) throw new Error(`${upto} is not a stack branch`);
  // Needs point only downwards, so leaving out the branches above --upto keeps their needs from joining chains below it.
  const belowUpto = (branch: string) =>
    !uptoBranch || branches.indexOf(branch) <= branches.indexOf(uptoBranch);
  const tested = branches.filter(movable).filter(belowUpto);
  const untested = branches.filter(movable).filter((name) => !belowUpto(name));
  const needsOf = new Map<string, string[]>();
  const directNeedsOf = new Map<string, string[]>();
  const declaredOf = new Map<string, string[]>();
  const blockerOf = new Map<string, string>();
  // mark takes PR branches only from the bottom up, so the hint names every one up to the highest needed.
  const markHint = (barred: string[]) => {
    const top = Math.max(...barred.map((name) => branches.indexOf(name)));
    const toMark = branches
      .slice(0, top + 1)
      .filter((name) => !isExtractSource(name));
    return `; to stack on ${barred.length === 1 ? 'it' : 'them'}: stack-plan mark ${toMark.join(' ')}`;
  };
  for (const branch of tested.filter((name) => own.get(name)?.length)) {
    const { group, directNeeds, declared, blocker, barred } = standaloneGroup(
      stack,
      wip,
      branch,
      mayJoin,
    );
    if (blocker)
      blockerOf.set(branch, `${blocker}${barred ? markHint(barred) : ''}`);
    else {
      needsOf.set(branch, group);
      directNeedsOf.set(branch, directNeeds);
      declaredOf.set(branch, declared);
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
  // The __ chains as extract works them out, so a candidate that joins one goes on its top, as extract puts it.
  const extractGroups = branches
    .filter((name) => isExtractSource(name) && own.get(name)?.length)
    .map((name) => standaloneGroup(stack, wip, name, isExtractSource))
    .filter(({ blocker }) => !blocker)
    .map(({ group }) => group);
  const chainReports = mergeGroups(
    [...extractGroups, ...needsOf.values()],
    branches,
  )
    .filter((chain) => chain.some(movable))
    .map((chain) => {
      const tips = replayTipsOf(chain);
      return {
        moveConflict: moveConflict(chain) ?? null,
        members: chain.map((name, at) => ({
          name,
          marked: isExtractSource(name),
          needs: directNeedsOf.get(name) ?? [],
          declared: declaredOf.get(name) ?? [],
          start: tips.size ? (tips.get(chain[at - 1]) ?? baseSha) : null,
          replay: tips.get(name) ?? null,
        })),
      };
    });
  const extractable = new Set(
    chainReports
      .filter((report) => !report.moveConflict)
      .flatMap((report) =>
        report.members
          .filter((member) => !member.marked)
          .map((member) => member.name),
      ),
  );

  if (asJson) {
    const blocked = [...blockerOf].map(([name, reason]) => ({ name, reason }));
    const report = { base, baseSha, wip, prsListed: Boolean(pulls) };
    console.log(
      JSON.stringify(
        { ...report, chains: chainReports, blocked, untested },
        null,
        2,
      ),
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
      if (member.marked) {
        console.log(`    ${member.name}  marked already`);
        continue;
      }
      const needsText = member.needs.length
        ? `needs ${member.needs
            .map((need) =>
              member.declared.includes(need) ? `${need} (declared)` : need,
            )
            .join(', ')}`
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
  if (untested.length)
    console.log(
      `not tested, above ${uptoBranch}: ${untested.map(cyan).join(', ')}`,
    );

  subheading('Conclusion');
  if (!extractable.size) {
    attention('no branch can leave the stack as it stands');
    return;
  }
  good(
    `${extractable.size} branch${extractable.size === 1 ? '' : 'es'} can leave the stack as far as the text shows; nothing checked that they build`,
  );
  const toMark = branches.filter((name) => extractable.has(name));
  console.log(`To mark them: stack-plan mark ${toMark.join(' ')}`);
};

// Renames each branch to its __ name, carries its notes and the saved order along, and exports the plan with the __ block in place.
const markBranches = (names: string[]) => {
  const wip = currentBranch();
  const { branches, line } = readStack(wip);
  const pulls = openPullRequests();
  heading(`Mark${dryRun ? ' (dry run)' : ''}`);
  if (!pulls)
    attention(
      'could not list PRs with gh, so a branch with a PR is not caught',
    );
  const sourceOf = new Map(
    names.map((name) => [name, `${EXTRACT_SOURCE_PREFIX}${name}`]),
  );
  // A PR branch keeps its tip as its copy, so the PR goes on unchanged; that copy holds only its own commits on a copy below.
  const keepsTip = (name: string): boolean => {
    const below = branches[branches.indexOf(name) - 1];
    if (!below) return true;
    if (names.includes(below))
      return Boolean(pulls?.has(below)) && keepsTip(below);
    const copy = isExtractSource(below) ? extractedNameOf(below) : '';
    return Boolean(copy) && branchExists(copy) && tipOf(copy) === tipOf(below);
  };
  const problems = names.flatMap((name) => {
    const pull = pulls?.get(name);
    if (!branches.includes(name)) return [`${name} is not a stack branch`];
    if (isExtractSource(name)) return [`${name} is an extract source already`];
    if (pull && !keepsTip(name))
      return [
        `${name} has PR #${pull.number} and sits on a branch whose copy would not be its base; mark the PR branches below it too`,
      ];
    if (branchExists(sourceOf.get(name)!))
      return [`${sourceOf.get(name)} exists already`];
    return [];
  });
  if (problems.length) throw new Error(problems.join('; '));

  const renamed = (branch: string) => sourceOf.get(branch) ?? branch;
  const order = desiredOrder(branches);
  const anchorAt = order.findLastIndex(
    (branch) => isExtractSource(branch) || pulls?.has(branch),
  );
  // A PR branch stays where it is, so its commits keep the SHAs its copy shares.
  const moves = (branch: string) => sourceOf.has(branch) && !pulls?.has(branch);
  // Stack order inside the block keeps each chain's members in their order.
  const markedOrder = [
    ...order.slice(0, anchorAt + 1).filter((branch) => !moves(branch)),
    ...order.filter(moves),
    ...order.slice(anchorAt + 1).filter((branch) => !moves(branch)),
  ].map(renamed);
  const notesToMove = line.filter((commit) => sourceOf.has(commit.note));
  const keptPulls = names.filter((name) => pulls?.has(name));
  const upstreamOf = new Map(
    keptPulls.map((name) => [
      name,
      git(
        'for-each-ref',
        '--format=%(upstream:short)',
        `refs/heads/${name}`,
      ).trim(),
    ]),
  );

  for (const [name, source] of sourceOf)
    console.log(`${cyan(name)} → ${cyan(source)}`);
  for (const name of keptPulls)
    console.log(
      `${cyan(name)}  stays at ${yellow(tipOf(name).slice(0, 10))} as the copy, so PR #${pulls!.get(name)!.number} goes on unchanged`,
    );
  if (notesToMove.length)
    console.log(
      `placed in them: ${countOf(notesToMove.length, 'commit')}, whose notes follow the rename`,
    );
  printOrderChanges(branches.map(renamed), markedOrder);
  if (dryRun) {
    console.log(`To do it: stack-plan mark ${names.join(' ')}`);
    return;
  }

  const done: string[] = [];
  try {
    for (const [name, source] of sourceOf) {
      git('branch', '-m', name, source);
      done.push(name);
    }
  } catch (error) {
    const undo = done.map((name) => `git branch -m ${renamed(name)} ${name}`);
    throw new Error(
      `${(error as Error).message}${undo.length ? `\nTo undo the renames so far: ${undo.join('; ')}` : ''}`,
    );
  }
  // git branch -m took the upstream to the __ name, but the PR's branch is the copy.
  for (const name of keptPulls) {
    const source = sourceOf.get(name)!;
    git('branch', name, source);
    const upstream = upstreamOf.get(name);
    if (upstream) {
      git('branch', `--set-upstream-to=${upstream}`, name);
      git('branch', '--unset-upstream', source);
    }
  }
  for (const commit of notesToMove)
    git(
      'notes',
      `--ref=${NOTES_REF}`,
      'add',
      '-f',
      '-m',
      renamed(commit.note),
      commit.sha,
    );
  git('config', ORDER_KEY, markedOrder.join(' '));
  const waiting = words(readConfig(NEW_KEY));
  if (waiting.length) git('config', NEW_KEY, waiting.map(renamed).join(' '));
  good(`${names.length} branch${names.length === 1 ? '' : 'es'} renamed`);
  exportPlan();
  console.log(
    'Next: stack-plan preview, then stack-plan apply and stack-plan verify',
  );
};

// Undoes mark: deletes each extracted copy that holds the same commits as its source, renames the source back, and moves it above the __ block.
const unmarkBranches = (names: string[]) => {
  const wip = currentBranch();
  const { branches, line, own } = readStack(wip);
  const pulls = openPullRequests();
  heading(`Unmark${dryRun ? ' (dry run)' : ''}`);
  if (!pulls)
    throw new Error(
      'could not list PRs with gh, so an extracted copy with a PR is not caught',
    );
  const sources = branches.filter(isExtractSource);
  const nameOf = new Map(names.map((name) => [name, extractedNameOf(name)]));
  const toDelete: string[] = [];
  // A copy at its source's tip, as mark keeps for a PR branch, hands its PR back to the renamed source.
  const handsBack = new Map<string, string>();
  const forced = new Map<string, string>();
  const problems = names.flatMap((name) => {
    if (!branches.includes(name)) return [`${name} is not a stack branch`];
    if (!isExtractSource(name)) return [`${name} is not an extract source`];
    const extracted = nameOf.get(name)!;
    if (branches.includes(extracted))
      return [`${extracted} is a stack branch too`];
    if (!branchExists(extracted)) return [];
    const pull = pulls.get(extracted);
    if (pull && tipOf(extracted) !== tipOf(name))
      return [
        `${extracted} has PR #${pull.number} and is not at ${name}'s tip; close the PR first`,
      ];
    if (pull)
      handsBack.set(
        name,
        git(
          'for-each-ref',
          '--format=%(upstream:short)',
          `refs/heads/${extracted}`,
        ).trim(),
      );
    const at = sources.indexOf(name);
    const commits = own.get(name) ?? [];
    const { fork, on } = extractedForkOf(
      extracted,
      sources.slice(0, at).map(extractedNameOf),
    );
    let compared = compareWithExtracted(commits, extracted, fork);
    const landedTip =
      on === undefined && compared.extraCount
        ? landedForkOf(extracted, fork, commits)
        : undefined;
    if (landedTip)
      compared = compareWithExtracted(commits, extracted, landedTip);
    const chained =
      on === undefined && compared.extraCount && !landedTip
        ? chainForkOf(extracted, fork, sources.slice(0, at))
        : undefined;
    if (chained)
      compared = compareWithExtracted(commits, extracted, chained.fork);
    const found: string[] = [];
    if (compared.missing.length || compared.extraCount) {
      const counts = `${countOf(compared.missing.length, 'commit')} missing from it, ${countOf(compared.extraCount, 'commit')} only on it`;
      if (rest.includes('--anyway')) forced.set(extracted, counts);
      else
        found.push(
          `${extracted} does not hold the same commits as ${name}: ${counts}; to delete it anyway: -f`,
        );
    }
    // A copy chained on this one would lose its base with it.
    for (const above of sources.slice(at + 1).filter((s) => !nameOf.has(s))) {
      const aboveCopy = extractedNameOf(above);
      if (!branchExists(aboveCopy)) continue;
      if (extractedForkOf(aboveCopy, [extracted]).on === extracted)
        found.push(`${aboveCopy} sits on ${extracted}; unmark ${above} too`);
    }
    if (!found.length) toDelete.push(extracted);
    return found;
  });
  if (problems.length) throw new Error(problems.join('; '));

  const renamed = (branch: string) => nameOf.get(branch) ?? branch;
  // A branch that takes its PR back stays where it is, as mark left it.
  const moves = (branch: string) =>
    nameOf.has(branch) && !handsBack.has(branch);
  const order = desiredOrder(branches).filter((branch) => !moves(branch));
  const anchorAt = order.findLastIndex(
    (branch) =>
      (isExtractSource(branch) && !nameOf.has(branch)) ||
      handsBack.has(branch) ||
      pulls.has(branch),
  );
  const unmarkedOrder = [
    ...order.slice(0, anchorAt + 1),
    ...branches.filter(moves),
    ...order.slice(anchorAt + 1),
  ].map(renamed);
  const notesToMove = line.filter((commit) => nameOf.has(commit.note));

  for (const extracted of toDelete) {
    const remote = remoteOf(extracted);
    const pull = pulls.get(extracted);
    const stays = pull
      ? `; PR #${pull.number} goes on with ${EXTRACT_SOURCE_PREFIX}${extracted} renamed back`
      : remote
        ? `; ${remote} stays`
        : '';
    const counts = forced.get(extracted);
    const why = counts
      ? ` despite ${counts}; to restore it: git branch ${extracted} ${tipOf(extracted)}`
      : ', it holds the same commits as its source';
    console.log(
      `${cyan(extracted)}  ${dryRun ? 'would be deleted' : 'deleted'}${why}${stays}`,
    );
  }
  for (const [name, plain] of nameOf)
    console.log(`${cyan(name)} → ${cyan(plain)}`);
  if (notesToMove.length)
    console.log(
      `placed in them: ${countOf(notesToMove.length, 'commit')}, whose notes follow the rename`,
    );
  printOrderChanges(branches.map(renamed), unmarkedOrder);
  if (dryRun) {
    console.log(
      `To do it: stack-plan unmark ${names.join(' ')}${forced.size ? ' -f' : ''}`,
    );
    return;
  }

  for (const extracted of toDelete) git('branch', '-D', extracted);
  const done: string[] = [];
  try {
    for (const [name, plain] of nameOf) {
      git('branch', '-m', name, plain);
      done.push(name);
    }
  } catch (error) {
    const undo = done.map((name) => `git branch -m ${renamed(name)} ${name}`);
    throw new Error(
      `${(error as Error).message}${undo.length ? `\nTo undo the renames so far: ${undo.join('; ')}` : ''}`,
    );
  }
  for (const [name, upstream] of handsBack)
    if (upstream) git('branch', `--set-upstream-to=${upstream}`, renamed(name));
  for (const commit of notesToMove)
    git(
      'notes',
      `--ref=${NOTES_REF}`,
      'add',
      '-f',
      '-m',
      renamed(commit.note),
      commit.sha,
    );
  git('config', ORDER_KEY, unmarkedOrder.join(' '));
  const waiting = words(readConfig(NEW_KEY));
  if (waiting.length) git('config', NEW_KEY, waiting.map(renamed).join(' '));
  good(`${names.length} branch${names.length === 1 ? '' : 'es'} renamed`);
  exportPlan();
  console.log(
    'Next: stack-plan preview, then stack-plan apply and stack-plan verify',
  );
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

type PullRequest = {
  number: number;
  base: string;
  mergedAt: string;
  mergeCommit: string;
  head: string;
};

/** Pull requests in a state keyed by head branch, the newest per branch, or undefined when gh cannot list them. */
const pullRequests = (
  state: 'open' | 'merged',
): Map<string, PullRequest> | undefined => {
  let origin: string;
  try {
    origin = git('remote', 'get-url', 'origin').trim();
  } catch {
    return undefined;
  }
  const slug = origin.replace(/\.git$/, '').replace(/^.*github\.com[:/]/, '');
  const fields = [
    '--json',
    'number,headRefName,headRefOid,baseRefName,mergedAt,mergeCommit',
  ];
  const result = spawnSync(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      slug,
      '--state',
      state,
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
    headRefOid: string;
    baseRefName: string;
    mergedAt: string;
    mergeCommit: { oid: string } | null;
  }[];
  const pulls = new Map<string, PullRequest>();
  for (const row of rows)
    if (!pulls.has(row.headRefName))
      pulls.set(row.headRefName, {
        number: row.number,
        base: row.baseRefName,
        mergedAt: row.mergedAt,
        mergeCommit: row.mergeCommit?.oid ?? '',
        head: row.headRefOid,
      });
  return pulls;
};
const openPullRequests = () => pullRequests('open');

/** The merged PR of a __ branch's copy, when it merged after the copy was made; review fixes and rebases change the head SHA. */
const mergedCopyPull = (
  source: string,
  merged: Map<string, PullRequest> | undefined,
  sourceCommits: Commit[],
) => {
  const extracted = extractedNameOf(source);
  const pull = merged?.get(extracted);
  if (!pull || !branchExists(extracted)) return undefined;
  const madeAt = Math.min(
    ...fileList(gitQuiet('log', '--format=%ct', `${base}..${extracted}`)).map(
      Number,
    ),
  );
  if (Date.parse(pull.mergedAt) / 1000 <= madeAt) return undefined;
  // A merge the local base lacks is not landed for a rebase onto that base.
  const inBase =
    Boolean(pull.mergeCommit) && isAncestor(pull.mergeCommit, base);
  // A commit added to the source after the PR's last push merged nowhere, so GitHub's word does not cover it.
  const lacking = commitsMissingFromPull(pull, sourceCommits);
  return { ...pull, inBase, lacking, landed: inBase && lacking?.length === 0 };
};

const hasCommit = (sha: string) =>
  gitSucceeds('cat-file', '-e', `${sha}^{commit}`);

// The source commits a merged PR's head lacks by patch-id, or undefined when its head cannot be read even after a fetch.
const commitsMissingFromPull = (pull: PullRequest, sourceCommits: Commit[]) => {
  if (!sourceCommits.length) return [];
  if (!pull.head) return undefined;
  if (!hasCommit(pull.head))
    gitSucceeds('fetch', '--quiet', 'origin', `refs/pull/${pull.number}/head`);
  if (!hasCommit(pull.head)) return undefined;
  const pullIds = new Set(
    patchIdsIn(
      `${git('merge-base', base, pull.head).trim()}..${pull.head}`,
    ).values(),
  );
  const sourceIdOfSha = patchIdsIn(
    `${sourceCommits[0].sha}^..${sourceCommits.at(-1)!.sha}`,
  );
  return sourceCommits.filter((commit) => {
    const id = sourceIdOfSha.get(commit.sha);
    return id !== undefined && !pullIds.has(id);
  });
};

const notFetched = (pull: { number: number }) =>
  `#${pull.number} merged on GitHub, but ${base} lacks its merge commit; git fetch, then run again`;

// Why GitHub's merge does not settle a source; the content check decides instead.
const notAllMerged = (pull: {
  number: number;
  head: string;
  lacking?: Commit[];
}) =>
  pull.lacking
    ? `#${pull.number} merged without ${countOf(pull.lacking.length, 'commit')} of it:\n${pull.lacking.map(commitLine).join('\n')}`
    : `#${pull.number} merged, but its head ${pull.head.slice(0, 10)} could not be fetched to check it held every commit`;

const exportPlan = () => {
  const wip = currentBranch();
  const full = fullMode();
  const { line, branches: current, pending, own, branchOf } = readStack(wip);
  const { folding, unmatched, foldsInto } = foldsBySubject(line);
  // An order saved but not yet rebased is exported as planned, like the notes are.
  const branches = desiredOrder(current);
  const sections = new Map<string, Commit[]>(
    [...branches, wip].map((branch) => [branch, []]),
  );
  const untagged: Commit[] = [];
  const strayNotes: Commit[] = [];
  const waiting = pending.filter((commit) => !folding.has(commit.sha));
  const leaving = new Set(
    line
      .filter(
        (commit) =>
          !folding.has(commit.sha) &&
          movesOut(commit, branchOf.get(commit.sha), branches, wip),
      )
      .map((commit) => commit.sha),
  );
  for (const commit of line)
    if (leaving.has(commit.sha)) sections.get(commit.note)!.push(commit);
  // Short mode lists no fold, since the subject decides it; the comment only shows where it goes.
  const foldLines = (target: Commit) =>
    foldsInto(target).map((commit) => {
      const verb = todoVerb(folding.get(commit.sha)!.verb);
      const listed = `${verb} ${commit.sha.slice(0, 10)} ${commit.subject}`;
      return full
        ? listed
        : `# fold ${listed} → into ${target.sha.slice(0, 10)}`;
    });
  const branchStops = readBranchStops([...branches, wip]);
  const commitStops = readCommitStops(line);
  const { adopted, missing: adoptedMissing } = readAdoptions([
    ...branches,
    wip,
  ]);
  const adoptedLines = (branch: string) =>
    (adopted.get(branch) ?? []).map((commit) =>
      pickLine(commit, `${ADOPTED_MARKER} `),
    );
  const stopLine = (message?: string) =>
    message ? [`${STOP_MARKER} stop ${message}`] : [];
  const linesOf = (commits: Commit[], marker = '') =>
    commits
      .filter((commit) => !folding.has(commit.sha))
      .flatMap((commit) => [
        pickLine(commit, marker),
        ...foldLines(commit),
        ...stopLine(commitStops.get(commit.sha)),
      ]);
  // Short mode lists no commit that stays put, so a stop after one shows as a comment, and save leaves it as it is.
  const stopComment = (commit: Commit) =>
    commitStops.has(commit.sha)
      ? [
          `# stop after ${commit.sha.slice(0, 10)} ${commit.subject}: ${commitStops.get(commit.sha)}`,
        ]
      : [];
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
  const lastStops = existsSync(planPath())
    ? readHeader(STOPS_PREFIX)
    : undefined;
  const lastAdopted = existsSync(planPath())
    ? readHeader(ADOPTED_PREFIX)
    : undefined;
  const baseAhead = Number(
    git('rev-list', '--count', `${forkOf(wip)}..${base}`).trim(),
  );
  // sync keeps a stack that has a branch on origin on origin's base, so it moves only an unpushed one onto the tip.
  const unpushed = !current.some((branch) => remoteOf(branch));
  const out = [
    `# stack-plan for ${wip} on ${base}, exported ${new Date().toISOString()}`,
    `${EXPORTED_AT_PREFIX}${tipOf(wip)}`,
    ...(lastPreRebase ? [`${PRE_REBASE_PREFIX}${lastPreRebase}`] : []),
    ...(lastFolded ? [`${FOLDED_PREFIX}${lastFolded}`] : []),
    ...(lastStops ? [`${STOPS_PREFIX}${lastStops}`] : []),
    ...(lastAdopted ? [`${ADOPTED_PREFIX}${lastAdopted}`] : []),
    ...(full ? [`${MODE_PREFIX}full`] : []),
    '# A pick belongs to the first update-ref below it. Picks between the last update-ref and',
    `# the untagged marker stay on ${wip}. Move picks, reorder update-refs or add one for a`,
    '# new branch, then run: stack-plan preview, then stack-plan apply',
    `# ${MOVED_MARKER}, ${ADOPTED_MARKER}, ${STOP_MARKER} and the branch markers show what was saved at export; save ignores them.`,
    '# A pick of a commit from outside the stack adopts it: apply cherry-picks it into that branch.',
    '# stop <message> pauses the next apply there and prints the message: right above an',
    '# update-ref or the untagged marker at the end of that branch, else after the pick above it.',
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
    `# A line ending in → <command> is out of sync; the command's check shows what it would do.`,
    ...(baseAhead
      ? [
          `${BASE_STATUS_PREFIX}${base} has ${countOf(baseAhead, 'commit')} the stack lacks${unpushed ? ' → stack-plan sync' : ", and sync keeps the stack on origin's base"}`,
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

  const originStatus = (branch: string) => {
    if (!branchExists(branch)) return undefined;
    const origin = originState(branch, {
      gone: 'stack-plan sync',
      newWork: () => 'stack-plan sync',
    });
    return origin
      ? `${ORIGIN_STATUS_PREFIX}${origin.parts.join(' · ')} → ${origin.command}`
      : undefined;
  };

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
      : originStatus(branch);
    const ownCommits = (own.get(branch) ?? []).filter(
      (commit) => !leaving.has(commit.sha),
    );
    const inBranch = full
      ? linesOf(ownCommits)
      : ownCommits.flatMap((commit) => [
          ...foldLines(commit),
          ...stopComment(commit),
        ]);
    const moving = linesOf(sections.get(branch)!, `${MOVED_MARKER} `);
    if (pulls && i === stopAt) out.push(PRS_STOP_MARKER);
    out.push(
      ...(marker ? [marker] : []),
      ...(status ? [status] : []),
      ...inBranch,
      ...moving,
      ...adoptedLines(branch),
      ...stopLine(branchStops.get(branch)),
      `update-ref refs/heads/${branch}\n`,
      ...(branch === sources.at(-1) ? [OTHER_STACKS_STOP_MARKER] : []),
    );
  });
  if (pulls && stopAt === branches.length) out.push(PRS_STOP_MARKER);
  const staying = sections.get(wip)!;
  out.push(
    ...linesOf(
      staying.filter((commit) => leaving.has(commit.sha)),
      `${MOVED_MARKER} `,
    ),
    ...linesOf(staying.filter((commit) => !leaving.has(commit.sha))),
    ...adoptedLines(wip),
    ...stopLine(branchStops.get(wip)),
    UNTAGGED_MARKER,
    ...linesOf(untagged).filter((listed) => !listed.startsWith(STOP_MARKER)),
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
  const leavingCount = leaving.size
    ? ` · ${leaving.size} moving out of their branch`
    : '';
  const adoptedTotal = [...adopted.values()].flat().length;
  const adoptedCount = adoptedTotal ? ` · ${adoptedTotal} adopted` : '';
  console.log(
    `${waiting.length} waiting · ${waiting.length - untagged.length} placed${inBranches}${leavingCount}${adoptedCount}${folded} · ${branches.length} stack branches`,
  );
  for (const sha of adoptedMissing)
    attention(
      `adopted commit ${yellow(sha.slice(0, 10))} no longer exists, so the file leaves it out; save then forgets it`,
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
  const { line: history, branches, pending, branchOf } = readStack(wip);
  const { folding } = foldsBySubject(history);
  const historyShas = new Set(history.map((commit) => commit.sha));
  const full = readHeader(MODE_PREFIX) === 'full';
  const order = desiredOrder(branches);
  // Short mode may list any commit, but must keep the waiting ones and those export showed moving.
  const listable = full
    ? history
    : history.filter((commit) => !folding.has(commit.sha));
  const required = full
    ? history
    : listable.filter(
        (commit) =>
          !branchOf.has(commit.sha) ||
          movesOut(commit, branchOf.get(commit.sha), order, wip),
      );
  const errors: string[] = [];
  const targets = new Map<string, string | undefined>();
  const listed = new Set<string>();
  const updateRefs: string[] = [];
  const steps: Step[] = [];
  const folded = new Set<string>();
  let held: string[] = [];
  let pastMarker = false;
  const branchStops = new Map<string, string>();
  const commitStops = new Map<string, string>();
  // The line after a stop places it: an update-ref or the marker makes it that branch's end, a pick the end of the pick above it.
  let heldStop: { message: string; where: string; after?: Commit } | undefined;
  let lastPick: Commit | undefined;
  const adoptions = new Map<string, Commit[]>();
  let heldAdopted: Commit[] = [];
  const placeAdopted = (branch: string) => {
    if (heldAdopted.length)
      adoptions.set(branch, [...(adoptions.get(branch) ?? []), ...heldAdopted]);
    heldAdopted = [];
  };
  let stackIds: Map<string, string> | undefined;
  // A rebase todo may pick any commit, so one from outside the stack is cherry-picked in, unless git could not pick it.
  const adoptionProblem = (sha: string) => {
    if (isAncestor(sha, base)) return `is already in ${base}`;
    const parents = words(gitQuiet('rev-list', '--parents', '-n', '1', sha));
    if (parents.length === 1) return 'is a root commit';
    if (parents.length > 2) return 'is a merge commit';
    stackIds ??= patchIdsIn(`${base}..${wip}`);
    const id = patchIdsIn(`${sha}^..${sha}`).get(sha);
    const twin = id && [...stackIds].find(([, other]) => other === id)?.[0];
    if (twin)
      return `makes the same change as ${twin.slice(0, 10)} in the stack`;
    return undefined;
  };

  readFileSync(planPath(), 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const trimmed = raw.trim();
      const line = trimmed.startsWith(STOP_MARKER)
        ? trimmed.slice(STOP_MARKER.length).trim()
        : trimmed;
      const where = `line ${index + 1}`;
      if (line === UNTAGGED_MARKER) {
        for (const sha of held) targets.set(sha, wip);
        held = [];
        placeAdopted(wip);
        pastMarker = true;
        if (heldStop) branchStops.set(wip, heldStop.message);
        heldStop = undefined;
        return;
      }
      if (!line || line.startsWith('#')) return;
      const fields = line.split(/\s+/);
      const amends = /^(?:fixup|f)$/.test(fields[0]) && fields[1] === '-C';
      const [verb, arg = ''] = amends ? [fields[0], fields[2]] : fields;
      if (verb === 'stop') {
        const message = line.slice(verb.length).trim();
        if (pastMarker) errors.push(`${where}: stop below the untagged marker`);
        else if (!message)
          errors.push(
            `${where}: stop needs a message, such as: stop run yarn install`,
          );
        // Two stops in one place are one pause, as export writes a commit's stop and its branch's back to back.
        else if (heldStop) heldStop.message += `; ${message}`;
        else heldStop = { message, where, after: lastPick };
        return;
      }
      if (heldStop && verb !== 'update-ref') {
        // The stop note would sit on the outside commit, which the rebase replaces with a copy outside base..wip.
        if (heldStop.after && !historyShas.has(heldStop.after.sha))
          errors.push(
            `${heldStop.where}: a stop after an adopted commit is not supported; move it right above the update-ref`,
          );
        else if (heldStop.after)
          commitStops.set(heldStop.after.sha, heldStop.message);
        else
          errors.push(
            `${heldStop.where}: a stop needs a pick above it in its branch, or an update-ref right below it`,
          );
        heldStop = undefined;
      }
      if (verb === 'update-ref') {
        if (pastMarker)
          errors.push(`${where}: update-ref below the untagged marker`);
        const branch = arg.replace(/^refs\/heads\//, '');
        updateRefs.push(branch);
        steps.push({ updateRef: branch });
        for (const sha of held) targets.set(sha, branch);
        held = [];
        placeAdopted(branch);
        if (heldStop) branchStops.set(branch, heldStop.message);
        heldStop = undefined;
        lastPick = undefined;
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
        const scope = `in ${base}..${wip}`;
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
        } else if (!commit) {
          const outside =
            /^[0-9a-f]{4,40}$/.test(arg) &&
            gitSucceeds('rev-parse', '--verify', '--quiet', `${arg}^{commit}`)
              ? tipOf(`${arg}^{commit}`)
              : undefined;
          const problem =
            outside && !historyShas.has(outside)
              ? adoptionProblem(outside)
              : undefined;
          if (!outside || historyShas.has(outside))
            errors.push(`${where}: ${arg} is not ${scope}; export again`);
          else if (kind !== 'pick')
            errors.push(
              `${where}: ${arg} is outside the stack, which only pick can adopt`,
            );
          else if (pastMarker)
            errors.push(
              `${where}: ${arg} is outside the stack, so it cannot be untagged; delete the line to drop it`,
            );
          else if (problem)
            errors.push(`${where}: ${arg} cannot be adopted: it ${problem}`);
          else if (listed.has(outside))
            errors.push(`${where}: ${arg} is listed twice`);
          else {
            const adopted = outsideCommit(outside);
            listed.add(outside);
            steps.push({ pick: adopted, verb: 'pick' });
            lastPick = adopted;
            heldAdopted.push(adopted);
          }
        } else if (listed.has(commit.sha))
          errors.push(`${where}: ${arg} is listed twice`);
        else {
          listed.add(commit.sha);
          steps.push({ pick: commit, verb: kind });
          if (kind === 'pick') lastPick = commit;
          if (kind !== 'pick') folded.add(commit.sha);
          if (pastMarker) targets.set(commit.sha, undefined);
          else held.push(commit.sha);
        }
      } else
        errors.push(
          `${where}: expected pick, fixup, fixup -C, squash, stop or update-ref, got "${verb}"`,
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
    for (const commit of required) {
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

  const noteOf = (commit: Commit) =>
    noteFor(targets.get(commit.sha), branchOf.get(commit.sha));
  const toTag = history.filter(
    (commit) =>
      (listed.has(commit.sha) || folding.has(commit.sha)) &&
      noteOf(commit) !== commit.note,
  );
  const tagged = toTag.filter((commit) => noteOf(commit));
  const untagged = toTag.filter((commit) => !noteOf(commit));
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
        noteOf(commit),
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

  // The file holds every branch's stop, but only the listed commits'; a commit stop on any other commit stays as it is.
  const storedBranchStops = readBranchStops([...updateRefs, wip]);
  const storedCommitStops = readCommitStops(history);
  let stopsChanged = 0;
  for (const branch of [...updateRefs, wip]) {
    const wanted = branchStops.get(branch) ?? '';
    if (wanted === (storedBranchStops.get(branch) ?? '')) continue;
    stopsChanged++;
    console.log(
      `${yellow(wanted ? 'stop' : 'unstop')}  end of ${cyan(branch)}${wanted ? `: ${wanted}` : ''}`,
    );
    if (dryRun) continue;
    if (wanted) git('config', stopKey(branch), wanted);
    else git('config', '--unset', stopKey(branch));
  }
  for (const commit of history.filter((candidate) =>
    listed.has(candidate.sha),
  )) {
    const wanted = commitStops.get(commit.sha) ?? '';
    if (wanted === (storedCommitStops.get(commit.sha) ?? '')) continue;
    stopsChanged++;
    console.log(
      `${yellow(wanted ? 'stop' : 'unstop')}  after${commitLine(commit)}${wanted ? `: ${wanted}` : ''}`,
    );
    if (dryRun) continue;
    if (wanted)
      git(
        'notes',
        `--ref=${STOP_NOTES_REF}`,
        'add',
        '-f',
        '-m',
        wanted,
        commit.sha,
      );
    else git('notes', `--ref=${STOP_NOTES_REF}`, 'remove', commit.sha);
  }
  if (stopsChanged)
    good(`${stopsChanged} stops ${dryRun ? 'would change' : 'changed'}`);

  let adoptionsChanged = 0;
  for (const branch of [...updateRefs, wip]) {
    const wanted = (adoptions.get(branch) ?? []).map((commit) => commit.sha);
    const stored = readConfigAll(adoptKey(branch));
    if (wanted.join(' ') === stored.join(' ')) continue;
    adoptionsChanged++;
    for (const commit of adoptions.get(branch) ?? [])
      if (!stored.includes(commit.sha))
        console.log(
          `${yellow('adopt')}  into ${cyan(branch)}${commitLine(commit)}`,
        );
    for (const sha of stored.filter((sha) => !wanted.includes(sha)))
      console.log(
        `${yellow('unadopt')}  from ${cyan(branch)}  ${yellow(sha.slice(0, 10))}`,
      );
    if (dryRun) continue;
    if (stored.length) git('config', '--unset-all', adoptKey(branch));
    for (const sha of wanted) git('config', '--add', adoptKey(branch), sha);
  }
  if (adoptionsChanged)
    good(
      `adopted commits ${dryRun ? 'would change' : 'changed'} in ${adoptionsChanged} branch${adoptionsChanged === 1 ? '' : 'es'}`,
    );

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
  return {
    targets,
    order: updateRefs,
    steps: full ? steps : undefined,
    stops: { branches: branchStops, commits: commitStops, listed },
    adopted: adoptions,
  };
};

type Planned = ReturnType<typeof savePlan>;

// A dry-run save writes no stops, so the plan's stand in for the stored ones wherever the file lists them.
const stopsFor = (
  line: Commit[],
  branches: string[],
  planned?: Planned,
): Stops => {
  const commits = readCommitStops(line);
  if (!planned) return { branches: readBranchStops(branches), commits };
  for (const sha of planned.stops.listed) {
    const message = planned.stops.commits.get(sha);
    if (message) commits.set(sha, message);
    else commits.delete(sha);
  }
  return { branches: planned.stops.branches, commits };
};

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
  const takenLine = readHeader(FROM_COPY_PREFIX);
  const taken = takenLine ? parseTakenRecord(takenLine) : undefined;
  const baseMoved = Boolean(cutTip || syncOnto);
  const oldFrom = syncFork ?? cutTip ?? taken?.start ?? base;
  const newFrom = syncOnto ?? newBase ?? taken?.start ?? base;
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
  const treeMayChange = baseMoved || Boolean(taken);
  const atStops = stopWork(readStopRecords());
  const adoptedShas = words(readHeader(ADOPTED_PREFIX) ?? '');
  const adoptedFiles = new Set(
    adoptedShas.flatMap((sha) =>
      fileList(
        gitQuiet('diff-tree', '-r', '--no-commit-id', '--name-only', sha),
      ),
    ),
  );
  // Work done at a stop or brought in by an adopted commit changes the tree on purpose, so only other files count.
  const expected = new Set([...atStops.files, ...adoptedFiles]);
  const differing =
    treeMayChange || !expected.size
      ? []
      : fileList(gitQuiet('diff', '--name-only', recorded, wip));
  const explainedByStops =
    differing.length > 0 && differing.every((file) => expected.has(file));
  const stat =
    treeMayChange || explainedByStops ? '' : gitQuiet(...statArgs).trimEnd();
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
  // sync and a drop checked each cut branch whole, since a squash merge holds no single commit of it.
  const onSyncCutBranch = (sha: string) =>
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
  if (taken) {
    const copyIds = new Set(
      taken.branches.flatMap(({ copyFork, copyTip }) =>
        copyFork && copyTip
          ? [...patchIdsIn(`${copyFork}..${copyTip}`).values()]
          : [],
      ),
    );
    const patchIdOf = (sha: string) =>
      patchIdsIn(`${sha}^..${sha}`).values().next().value ?? '';
    const fromCopy = entries.filter(
      (entry) =>
        ['!', '>'].includes(entry.kind) && copyIds.has(patchIdOf(entry.newSha)),
    );
    for (const entry of fromCopy) entry.kind = 'copy';
    // A source commit whose copy version range-diff did not pair with it was replaced, not lost.
    const copySubjects = new Set(fromCopy.map((entry) => entry.subject));
    for (const entry of entries)
      if (entry.kind === '<' && copySubjects.has(entry.subject))
        entry.kind = 'copy';
  }

  for (const entry of entries) {
    const madeAtStop =
      ['!', '>'].includes(entry.kind) &&
      atStops.commits.some((sha) => sha.startsWith(entry.newSha));
    const amendedAtStop =
      entry.kind === '<' && atStops.amendedSubjects.has(entry.subject);
    if (madeAtStop || amendedAtStop) entry.kind = 'stop';
  }
  // A conflict resolved while picking it changes the patch-id, so the subject pairs it too.
  if (adoptedShas.length) {
    const adoptedIds = new Set(
      adoptedShas.flatMap((sha) => [...patchIdsIn(`${sha}^..${sha}`).values()]),
    );
    const adoptedSubjects = new Set(
      adoptedShas.map((sha) => outsideCommit(sha).subject),
    );
    for (const entry of entries.filter((candidate) => candidate.kind === '>')) {
      const id = patchIdsIn(`${entry.newSha}^..${entry.newSha}`)
        .values()
        .next().value;
      if ((id && adoptedIds.has(id)) || adoptedSubjects.has(entry.subject))
        entry.kind = 'adopted';
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
  const copyCount = count('copy')
    ? ` · ${count('copy')} from the extracted copies`
    : '';
  const stopCount = count('stop') ? ` · ${count('stop')} made at stops` : '';
  const adoptedCount = count('adopted') ? ` · ${count('adopted')} adopted` : '';
  const summary = `range-diff  ${count('=')} unchanged · ${count('context')} context only · ${count('!')} changed · ${count('<')} dropped · ${count('>')} added${foldedCount}${landedCount}${originCount}${copyCount}${stopCount}${adoptedCount}`;
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
  const copyEntries = entries.filter((entry) => entry.kind === 'copy');
  if (copyEntries.length) {
    console.log(
      `\nTaken from the extracted copies, or replaced by their version:`,
    );
    for (const entry of copyEntries) console.log(entry.lines[0]);
  }
  const stopEntries = entries.filter((entry) => entry.kind === 'stop');
  if (stopEntries.length) {
    console.log(
      `\nMade or amended at a stop, so expected; the tree check below allows only the files they change:`,
    );
    for (const entry of stopEntries) console.log(entry.lines[0]);
  }
  const adoptedEntries = entries.filter((entry) => entry.kind === 'adopted');
  if (adoptedEntries.length) {
    console.log(
      `\nAdopted from outside the stack, so expected; the tree check below allows only the files they change:`,
    );
    for (const entry of adoptedEntries) console.log(entry.lines[0]);
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
  const treeOk = taken
    ? sameAsCopiesAndBefore(taken, tipOf, recorded, tipOf(wip), wip) === true
    : syncOnto
      ? syncedOk()
      : cutTip
        ? sameNetChange(
            `${cutTip.slice(0, 10)}..${recorded.slice(0, 10)}`,
            cutTip,
            recorded,
            newBase,
            wip,
            newBase.slice(0, 10),
            new Set(fileList(gitQuiet('diff', '--name-only', cutTip, newBase))),
          ) &&
          sameTipOutsideOrigin(
            cutTip,
            recorded,
            newBase,
            wip,
            `${newBase.slice(0, 10)} moved since the stack left it`,
          )
        : !stat;
  if (!treeMayChange) traceGit(statArgs);
  if (stat) {
    bad(`tree differs from the pre-rebase tip ${short}`);
    console.log(stat);
    console.log(`To put the pre-rebase tree back as uncommitted changes:`);
    console.log(
      `  git restore --source=${recorded.slice(0, 10)} --staged --worktree :/`,
    );
  }
  if (treeOk && !droppedOrAdded.length) tidyAfterRebase(wip, cutBranches);
  if (explainedByStops) {
    const by = [
      ...(atStops.files.size ? ['at stops'] : []),
      ...(adoptedFiles.size ? ['by adopted commits'] : []),
    ].join(' or ');
    good(
      `tree matches the pre-rebase tip ${short}, apart from files changed ${by}: ${differing.join(', ')}`,
    );
  } else if (!stat && !treeMayChange)
    good(`tree matches the pre-rebase tip ${short}`);
};

// A stop is one-shot: once the rebase got past it, it goes, along with the copies of its note the rebase made.
const clearReachedStops = () => {
  let cleared = 0;
  for (const { key, before, after } of readStopRecords()) {
    if (!before || !after) continue;
    const name = key.slice(2);
    if (key.startsWith('b:')) {
      if (!readConfig(stopKey(name))) continue;
      if (!dryRun) git('config', '--unset', stopKey(name));
    } else {
      const holders = [...new Set([before, after])].filter((sha) =>
        gitSucceeds('notes', `--ref=${STOP_NOTES_REF}`, 'show', sha),
      );
      if (!holders.length) continue;
      if (!dryRun)
        git('notes', `--ref=${STOP_NOTES_REF}`, 'remove', ...holders);
    }
    cleared++;
  }
  if (cleared)
    good(
      `${cleared} stops ${dryRun ? 'would be cleared' : 'cleared'}, each one passed in this rebase`,
    );
};

// An adoption is one-shot like a stop: once its commit is picked in, the branch holds a copy and the key goes.
const clearAdoptions = () => {
  const done = words(readHeader(ADOPTED_PREFIX) ?? '');
  if (!done.length) return;
  let listing = '';
  try {
    listing = git('config', '--get-regexp', '^branch\\..*\\.stackadopt$');
  } catch {
    return;
  }
  let cleared = 0;
  for (const row of fileList(listing)) {
    const [key, sha] = words(row);
    if (!done.includes(sha)) continue;
    if (!dryRun) git('config', '--unset-all', '--fixed-value', key, sha);
    cleared++;
  }
  if (cleared)
    good(
      `${countOf(cleared, 'adoption')} ${dryRun ? 'would be cleared' : 'cleared'}, each one picked in by this rebase`,
    );
};

// Runs once verify has passed, so the plan's bookkeeping catches up with what the rebase did.
const tidyAfterRebase = (wip: string, cutBranches: string[]) => {
  clearReachedStops();
  clearAdoptions();
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
  const copies = cutBranches
    .filter(isExtractSource)
    .map(extractedNameOf)
    .filter(branchExists);
  if (cutBranches.some(isExtractSource)) extractBranches(!dryRun, true);
  const leftOver = [...cutBranches.filter(branchExists), ...copies];
  if (leftOver.length)
    console.log(
      `The cut branches${copies.length ? ' and their extracted copies' : ''} are still there. To delete them:\n  git branch -D ${leftOver.join(' ')}`,
    );

  const waitingToCreate = words(readConfig(NEW_KEY));
  if (waitingToCreate.length && waitingToCreate.every(branchExists)) {
    if (!dryRun) git('config', '--unset', NEW_KEY);
    good(
      `new branches ${dryRun ? 'would be marked' : 'marked'} created: ${waitingToCreate.join(', ')}`,
    );
  }

  // A note on a commit now in the branch it names has done its job; the pre-rebase commits keep their copies.
  const { line, branches, branchOf } = readStack(wip);
  const stackOrder = desiredOrder(branches);
  const landed = line.filter(
    (commit) =>
      commit.note &&
      branchOf.has(commit.sha) &&
      !movesOut(commit, branchOf.get(commit.sha), stackOrder, wip),
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
  kind:
    | '='
    | '!'
    | '<'
    | '>'
    | 'context'
    | 'folded'
    | 'landed'
    | 'origin'
    | 'copy'
    | 'stop'
    | 'adopted';
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

type Rebase = {
  todo: string[];
  sequence: Replay[];
  rebaseBase: string;
  stops: string[];
  adopted: string[];
};

const printAdoptions = (order: string[], adopted: Map<string, Commit[]>) => {
  for (const branch of order) {
    const commits = adopted.get(branch) ?? [];
    if (commits.length) console.log(`${yellow('adopt')}  ${cyan(branch)}`);
    for (const commit of commits) console.log(commitLine(commit));
  }
};

const newTodo = () => {
  const todo: string[] = [];
  const sequence: Replay[] = [];
  const stops: string[] = [];
  const pick = (commit: Commit, marker = '', verb: Verb = 'pick') => {
    todo.push(`${todoVerb(verb)} ${commit.sha} ${marker}${commit.subject}`);
    sequence.push({ commit, fold: verb !== 'pick' });
  };
  const stop = (key: string) => {
    todo.push(...stopLines(key));
    stops.push(key);
  };
  return { todo, sequence, pick, stops, stop };
};

const printStops = (stops: Stops, keys: string[], line: Commit[]) => {
  for (const key of keys) {
    const name = key.slice(2);
    if (key.startsWith('b:'))
      console.log(
        `${yellow('stop')}  end of ${cyan(name)}: ${stops.branches.get(name)}`,
      );
    else
      console.log(
        `${yellow('stop')}  after${commitLine(line.find((commit) => commit.sha === name)!)}: ${stops.commits.get(name)}`,
      );
  }
};

const branchMarker = (branch: string, branches: string[], order: string[]) => {
  const below = order[order.indexOf(branch) - 1] ?? base;
  if (!branches.includes(branch))
    return `# ${NEW_BRANCH_MARKER} ${branch}, above ${below}`;
  if (movedBranches(branches, order).includes(branch))
    return `# ${MOVED_BRANCH_MARKER} ${branch}, now above ${below}`;
};

// Short mode: each branch keeps its own commits as a block, and commits with a note join the branch it names.
const shortRebase = (wip: string, planned?: Planned): Rebase | undefined => {
  const { line, branches, pending, own, branchOf } = readStack(wip);
  const { folding, unmatched, foldsInto } = foldsBySubject(line);
  // A dry-run save writes no notes or config, so its plan stands in for them.
  for (const commit of line)
    if (planned?.targets.has(commit.sha))
      commit.note = noteFor(
        planned.targets.get(commit.sha),
        branchOf.get(commit.sha),
      );
  const order = planned?.order ?? desiredOrder(branches);
  const adopted = planned?.adopted ?? readAdoptions([...order, wip]).adopted;
  // A folding commit goes with its target, whatever its note says.
  const leaving = line.filter(
    (commit) =>
      !folding.has(commit.sha) &&
      movesOut(commit, branchOf.get(commit.sha), order, wip),
  );
  const moves = [
    ...leaving.filter((commit) => commit.note !== wip),
    ...pending.filter(
      (commit) =>
        !folding.has(commit.sha) &&
        commit.note !== wip &&
        order.includes(commit.note),
    ),
  ];
  const toWip = leaving.filter((commit) => commit.note === wip);
  const moved = new Set([...moves, ...toWip].map((commit) => commit.sha));
  const foldsLandIn = [...folding.values()].map(({ into }) =>
    moved.has(into.sha) ? into.note : (branchOf.get(into.sha) ?? wip),
  );
  const stops = stopsFor(line, [...order, wip], planned);
  // A stop needs its branch in the todo, so it counts as a change to that branch.
  const stopsLandIn = [
    ...stops.branches.keys(),
    ...[...stops.commits.keys()].flatMap((sha) => {
      const commit = line.find((candidate) => candidate.sha === sha);
      if (!commit || folding.has(sha)) return [];
      return moved.has(sha) ? [commit.note] : [branchOf.get(sha) ?? wip];
    }),
  ];
  const changes = (branch: string) =>
    moves.some((commit) => commit.note === branch) ||
    leaving.some((commit) => branchOf.get(commit.sha) === branch) ||
    foldsLandIn.includes(branch) ||
    stopsLandIn.includes(branch) ||
    adopted.has(branch);
  let first = 0;
  while (
    first < order.length &&
    order[first] === branches[first] &&
    !changes(order[first])
  )
    first++;
  warnUnmatched(unmatched);
  if (
    first === order.length &&
    !foldsLandIn.includes(wip) &&
    !stopsLandIn.includes(wip) &&
    !adopted.has(wip)
  ) {
    good(
      `no tagged commits waiting on ${wip} and no change to the stack order; nothing to move`,
    );
    return;
  }
  // Everything below the first changed branch stays as it is.
  const rebaseBase = first === 0 ? forkOf(wip) : order[first - 1];
  printByBranch([...order, wip], (commit) => commit.note, [...moves, ...toWip]);
  printAdoptions([...order, wip], adopted);
  for (const [sha, { into }] of folding)
    printFold(
      line.find((commit) => commit.sha === sha)!,
      into,
    );
  printOrderChanges(branches, order);
  console.log(
    `${bold('base')}  ${first === 0 ? forkLabel(rebaseBase) : cyan(rebaseBase)}`,
  );

  const { todo, sequence, pick, stops: stopKeys, stop } = newTodo();
  const pickWithFolds = (commit: Commit, marker = '') => {
    pick(commit, marker);
    for (const fold of foldsInto(commit))
      pick(fold, '', folding.get(fold.sha)!.verb);
    if (stops.commits.has(commit.sha)) stop(`c:${commit.sha}`);
  };
  const unfolded = (commits: Commit[]) =>
    commits.filter((commit) => !folding.has(commit.sha));
  for (const branch of order.slice(first)) {
    const marker = branchMarker(branch, branches, order);
    if (marker) todo.push(marker);
    for (const commit of unfolded(own.get(branch) ?? []).filter(
      (commit) => !moved.has(commit.sha),
    ))
      pickWithFolds(commit);
    for (const commit of moves.filter((move) => move.note === branch))
      pickWithFolds(commit, `${MOVED_MARKER} `);
    for (const commit of adopted.get(branch) ?? [])
      pick(commit, `${ADOPTED_MARKER} `);
    if (stops.branches.has(branch)) stop(`b:${branch}`);
    todo.push(`update-ref refs/heads/${branch}`, '');
  }
  for (const commit of toWip) pickWithFolds(commit, `${MOVED_MARKER} `);
  for (const commit of unfolded(pending).filter(
    (commit) => !moved.has(commit.sha),
  ))
    pickWithFolds(commit);
  for (const commit of adopted.get(wip) ?? [])
    pick(commit, `${ADOPTED_MARKER} `);
  if (stops.branches.has(wip)) stop(`b:${wip}`);
  printStops(stops, stopKeys, line);
  const adoptedShas = [...adopted.values()].flat().map((commit) => commit.sha);
  return { todo, sequence, rebaseBase, stops: stopKeys, adopted: adoptedShas };
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
  // A stop sits in the todo after a pick, so the rebase starts at the last pick before it at the latest.
  const stops = stopsFor(line, [...planned.order, wip], planned);
  const isPickOf = (step: Step, sha?: string) =>
    'pick' in step && step.verb === 'pick' && (!sha || step.pick.sha === sha);
  const stopAt = [
    ...[...stops.branches.keys()].map((branch) =>
      branch === wip
        ? steps.length
        : steps.findIndex(
            (step) => 'updateRef' in step && step.updateRef === branch,
          ),
    ),
    ...[...stops.commits.keys()].map((sha) =>
      steps.findIndex((step) => isPickOf(step, sha)),
    ),
  ].filter((at) => at >= 0);
  for (const at of stopAt)
    kept = Math.min(
      kept,
      Math.max(
        0,
        steps.slice(0, at + 1).findLastIndex((step) => isPickOf(step)),
      ),
    );
  // A fold needs the commit it folds into inside the todo, so the rebase starts below that commit.
  while (kept > 0 && folds(steps[kept])) kept--;
  if (kept === steps.length && kept === current.length) {
    good('the plan matches the stack as it is; nothing to move');
    return;
  }
  const lastKept = steps.slice(0, kept).findLast((step) => 'pick' in step);
  const lastCommit = lastKept && 'pick' in lastKept ? lastKept.pick : undefined;
  const rebaseBase = lastCommit?.sha ?? forkOf(wip);

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
  printAdoptions([...order, wip], planned.adopted);
  const adoptedShas = [...planned.adopted.values()]
    .flat()
    .map((commit) => commit.sha);
  for (const [sha, target] of foldedInto)
    printFold(
      line.find((commit) => commit.sha === sha)!,
      target,
    );
  warnUnmatched(foldsBySubject(line).unmatched);
  printOrderChanges(branches, order);
  console.log(
    `${bold('base')}  ${lastCommit ? commitLine(lastCommit).trim() : forkLabel(rebaseBase)}`,
  );

  const { todo, sequence, pick, stops: stopKeys, stop } = newTodo();
  // A commit's stop waits for its folds, so it goes in before the next pick or update-ref.
  let stopAfter: string | undefined;
  const placeStop = () => {
    if (stopAfter) stop(`c:${stopAfter}`);
    stopAfter = undefined;
  };
  let sectionStart = 0;
  for (const step of steps.slice(kept)) {
    if ('pick' in step) {
      if (step.verb === 'pick') placeStop();
      const movesBranch =
        step.verb === 'pick' && was(step.pick) !== goes(step.pick);
      const marker = adoptedShas.includes(step.pick.sha)
        ? `${ADOPTED_MARKER} `
        : movesBranch
          ? `${MOVED_MARKER} `
          : '';
      pick(step.pick, marker, step.verb);
      if (step.verb === 'pick' && stops.commits.has(step.pick.sha))
        stopAfter = step.pick.sha;
      continue;
    }
    placeStop();
    if (stops.branches.has(step.updateRef)) stop(`b:${step.updateRef}`);
    const marker = branchMarker(step.updateRef, branches, order);
    if (marker) todo.splice(sectionStart, 0, marker);
    todo.push(`update-ref refs/heads/${step.updateRef}`, '');
    sectionStart = todo.length;
  }
  placeStop();
  if (stops.branches.has(wip)) stop(`b:${wip}`);
  printStops(stops, stopKeys, line);
  return { todo, sequence, rebaseBase, stops: stopKeys, adopted: adoptedShas };
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
    // An adopted commit brings its change in, so only a plain reorder should end on wip's tree.
    if (!simulation.sameTree && !rebase.adopted.length)
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
  if (rebase.stops.length)
    writeStopRecords(rebase.stops.map((key) => ({ key })));
  if (rebase.adopted.length)
    writeHeader(ADOPTED_PREFIX, rebase.adopted.join(' '));
  runRebase(
    todo,
    ['rebase', '-i', '--update-refs', rebaseBase],
    rebase.adopted,
  );
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

// Records, shows or forgets the branches a stack branch needs beyond what a text conflict shows.
const declareNeeds = ([name, ...needed]: string[]) => {
  const { branches } = readStack(currentBranch());
  const branch = stackBranchNamed(name, branches);
  if (!branch) throw new Error(`${name} is not a stack branch`);
  const problems = needed.flatMap((need) => {
    const found = stackBranchNamed(need, branches);
    if (!found) return [`${need} is not a stack branch`];
    if (found === branch) return [`${need} is the branch itself`];
    if (branches.indexOf(found) > branches.indexOf(branch))
      return [`${need} sits above ${branch}`];
    return [];
  });
  if (problems.length) throw new Error(problems.join('; '));
  const key = needsKey(branch);
  if (rest.includes('--clear') && readConfigAll(key).length)
    git('config', '--unset-all', key);
  const stored = readConfigAll(key);
  for (const need of needed.map(unprefixed))
    if (!stored.includes(need)) git('config', '--add', key, need);
  heading(`Needs of ${branch}`);
  const declared = declaredNeeds(branch, branches);
  if (!declared.length) console.log('none declared');
  for (const need of declared) console.log(cyan(need));
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
  } else if (command === 'continue') continueRebase();
  else if (command === 'verify') verifyRebase();
  else if (command === 'mode') setMode();
  else if (command === 'prepare') prepareRebase();
  else if (command === 'cut' && rest.includes('--merged'))
    dropMergedSources(rest.includes('--apply'));
  else if (command === 'cut' && cutTargets.every(isExtractSource))
    dropExtractSources(cutTargets, rest.includes('--apply'));
  else if (command === 'cut') cutStack(cutTargets[0], rest.includes('--apply'));
  else if (command === 'sync') syncStack(rest.includes('--apply'));
  else if (command === 'extract' && rest.includes('--from-copy'))
    takeFromCopies(fromCopyTargets, rest.includes('--apply'));
  else if (command === 'extract') extractBranches(rest.includes('--apply'));
  else if (command === 'extractable') extractableBranches();
  else if (command === 'mark') markBranches(branchesToMark);
  else if (command === 'unmark') unmarkBranches(branchesToMark);
  else if (command === 'needs') declareNeeds(needsArgs);
  else if (command === '_todo') editTodo(args[0]);
  else if (command === '_stop') stopHere(args[0]);
  else if (command === '_resume') recordStopHead(args[0], 'after');
} catch (error) {
  console.error(redErr(`✗ ${(error as Error).message}`));
  process.exit(1);
}
