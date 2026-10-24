#!/usr/bin/env node
// Lists changed files and writes markdown cards of diffs and files, for the peek skill to send to the phone.
// Usage: peek.mts overview [target] | diff|words|edit <path> [target] | file <path>; target is a commit or <a>..<b>, the working tree when absent.
// ../SKILL.md says what each view is for and how the agent replays an edit.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

const CARD_DIR = join('.agent-context', '.tmp', 'peek');
const PROSE_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'txt']);
const CODE_WORD_REGEX = '[A-Za-z0-9_]+|[^[:space:]]';
const REMOVED_COLOUR = '#cf222e';
const ADDED_COLOUR = '#116329';
const HUNK_HEADER_COLOUR = '#6e7781';
const WORD_VIEW_MIN_IN_PLACE_SHARE = 0.5;
const EDIT_VIEW_MAX_CHANGED_LINES = 40;
const EDIT_REGION_MERGE_GAP = 20;
const EDIT_REGION_CONTEXT = 2;
// The app's renderer refuses \textasciitilde, \textasciicircum, \textbackslash and \char.
const LATEX_SYMBOL_COMMANDS: Record<string, string> = {
  '\\': '\\backslash',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '%': '\\%',
  '&': '\\&',
  '#': '\\#',
  _: '\\_',
  '^': '\\hat{\\ }',
  '~': '\\sim',
};
const FENCE_LANGUAGES: Record<string, string> = {
  mts: 'ts',
  cts: 'ts',
  mjs: 'js',
  cjs: 'js',
  yml: 'yaml',
  zsh: 'sh',
  bash: 'sh',
};

type Target =
  | { kind: 'worktree' }
  | { kind: 'commit'; rev: string }
  | { kind: 'range'; from: string; to: string };

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

const repoRoot = () => git('rev-parse', '--show-toplevel').trim();

const verifyCommit = (rev: string) => {
  const found = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`],
    { encoding: 'utf8' },
  );
  if (found.status !== 0) fail(`"${rev}" is not a commit`);
  return rev;
};

const parseTarget = (arg: string | undefined): Target => {
  if (arg === undefined) return { kind: 'worktree' };
  const [from, to, ...rest] = arg.split('..');
  if (to === undefined) return { kind: 'commit', rev: verifyCommit(arg) };
  if (rest.length > 0 || to.startsWith('.'))
    fail(`"${arg}" is not a range of the form <a>..<b>`);
  return { kind: 'range', from: verifyCommit(from), to: verifyCommit(to) };
};

const targetLabel = (target: Target) => {
  if (target.kind === 'worktree') return 'uncommitted changes against HEAD';
  if (target.kind === 'range') return `${target.from}..${target.to}`;
  return git('log', '-1', '--format=%h %s', target.rev).trim();
};

const diffArgs = (target: Target) => {
  if (target.kind === 'worktree') return ['diff', 'HEAD'];
  if (target.kind === 'range') return ['diff', target.from, target.to];
  return ['show', '--format=', target.rev];
};

const untrackedFiles = () =>
  git('ls-files', '--others', '--exclude-standard', '--full-name', '-z')
    .split('\0')
    .filter(Boolean);

const overview = (target: Target) => {
  const args = [...diffArgs(target), '--no-renames'];
  const statuses = new Map(
    git(...args, '--name-status', '-z')
      .split('\0')
      .filter(Boolean)
      .reduce<[string, string][]>((pairs, field, index, fields) => {
        if (index % 2 === 0) pairs.push([fields[index + 1], field]);
        return pairs;
      }, []),
  );
  const rows = git(...args, '--numstat', '-z')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [added, removed, path] = record.split('\t');
      return { path, status: statuses.get(path) ?? 'M', added, removed };
    });
  if (target.kind === 'worktree')
    for (const path of untrackedFiles()) {
      const lines = readFileSync(join(repoRoot(), path), 'utf8').split(
        '\n',
      ).length;
      rows.push({ path, status: '?', added: String(lines), removed: '0' });
    }
  console.log(targetLabel(target));
  if (rows.length === 0) return console.log('no changes');
  rows.forEach((row, index) => {
    const binary = row.added === '-';
    const size = binary ? 'binary' : `+${row.added} -${row.removed}`;
    const view =
      binary || row.status !== 'M'
        ? 'diff'
        : defaultView(
            row.path,
            target,
            Number(row.added) + Number(row.removed),
          );
    console.log(`${index + 1}. ${row.status} ${row.path}  ${size}  ${view}`);
  });
};

type Segment = { kind: 'kept' | 'removed' | 'added'; text: string };
type WordHunk = { header: string; lines: Segment[][] };

const SEGMENT_KINDS: Record<string, Segment['kind']> = {
  ' ': 'kept',
  '-': 'removed',
  '+': 'added',
};

const isProse = (path: string) => PROSE_EXTENSIONS.has(extname(path).slice(1));

const wordDiff = (inRoot: string, target: Target): WordHunk[] => {
  const raw = git(
    '-C',
    repoRoot(),
    ...diffArgs(target),
    '--word-diff=porcelain',
    ...(isProse(inRoot) ? [] : [`--word-diff-regex=${CODE_WORD_REGEX}`]),
    '--',
    inRoot,
  );
  const hunks: WordHunk[] = [];
  let line: Segment[] = [];
  for (const record of raw.split('\n')) {
    const header = /^@@[^@]*@@/.exec(record)?.[0];
    if (header) {
      hunks.push({ header, lines: [] });
      line = [];
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk) {
      continue;
    }
    if (record === '~') {
      hunk.lines.push(line);
      line = [];
      continue;
    }
    const kind = SEGMENT_KINDS[record[0]];
    if (kind) {
      line.push({ kind, text: record.slice(1) });
    }
  }
  return hunks;
};

const isChangedLine = (line: Segment[]) =>
  line.length === 0 || line.some((segment) => segment.kind !== 'kept');

const isEditedInPlace = (line: Segment[]) =>
  isChangedLine(line) &&
  line.some((segment) => segment.kind === 'kept' && segment.text.trim());

const defaultView = (inRoot: string, target: Target, changedLines: number) => {
  const changed = wordDiff(inRoot, target)
    .flatMap((hunk) => hunk.lines)
    .filter(isChangedLine);
  const inPlace = changed.filter(isEditedInPlace).length;
  const measurement = `${inPlace}/${changed.length} lines edited in place`;
  if (
    isProse(inRoot) ||
    inPlace >= changed.length * WORD_VIEW_MIN_IN_PLACE_SHARE
  ) {
    return `words (${measurement})`;
  }
  if (changedLines > EDIT_VIEW_MAX_CHANGED_LINES) {
    return `diff (${measurement}, ${changedLines} lines changed)`;
  }
  return `edit (${measurement})`;
};

const fenceFor = (text: string) => {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  return '`'.repeat(Math.max(3, longest + 1));
};

const writeCard = (name: string, markdown: string) => {
  const dir = join(repoRoot(), CARD_DIR);
  mkdirSync(dir, { recursive: true });
  const card = join(dir, `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.md`);
  writeFileSync(card, markdown);
  console.log(card);
};

const relativeToRoot = (path: string) => {
  const root = repoRoot();
  const inRoot = relative(root, resolve(path));
  if (inRoot.startsWith('..')) fail(`${path} is outside ${root}`);
  return inRoot;
};

const diffCard = (path: string, target: Target) => {
  const inRoot = relativeToRoot(path);
  const untracked =
    target.kind === 'worktree' && untrackedFiles().includes(inRoot);
  const raw = untracked
    ? spawnSync('git', ['diff', '--no-index', '--', '/dev/null', inRoot], {
        encoding: 'utf8',
        cwd: repoRoot(),
      }).stdout
    : git('-C', repoRoot(), ...diffArgs(target), '--', inRoot);
  if (!raw.trim()) fail(`${inRoot} has no changes in ${targetLabel(target)}`);
  const hunks = raw.slice(Math.max(0, raw.indexOf('\n@@') + 1));
  const body = hunks.startsWith('@@') ? hunks : raw;
  const fence = fenceFor(body);
  writeCard(
    `diff-${inRoot}`,
    `# ${basename(inRoot)}\n\n\`${inRoot}\`, ${targetLabel(target)}${untracked ? ', new untracked file' : ''}\n\n${fence}diff\n${body.trimEnd()}\n${fence}\n`,
  );
};

// A braced symbol is set as a plain character, without the maths spacing around operators.
const escapeLatex = (text: string) =>
  text
    .replaceAll('\t', '    ')
    .replace(/[^\p{L}\p{N}]/gu, (character) =>
      character === ' '
        ? '\\ '
        : `{${LATEX_SYMBOL_COMMANDS[character] ?? character}}`,
    );

const latexSegment = ({ kind }: Segment, latexText: string) => {
  if (kind === 'removed') {
    return `{\\color{${REMOVED_COLOUR}}\\cancel{\\text{${latexText}}}}`;
  }
  if (kind === 'added') {
    return `{\\color{${ADDED_COLOUR}}\\text{${latexText}}}`;
  }
  return `\\text{${latexText}}`;
};

const codeLatexText = (text: string) => `\\texttt{${escapeLatex(text)}}`;

const codeWordsMarkdown = (hunks: WordHunk[]) => {
  const rows = hunks.flatMap((hunk) => [
    `{\\color{${HUNK_HEADER_COLOUR}}\\text{${codeLatexText(hunk.header)}}}`,
    ...hunk.lines.map(
      (line) =>
        line
          .map((segment) => latexSegment(segment, codeLatexText(segment.text)))
          .join('') || '\\text{}',
    ),
  ]);
  return `$$\n\\begin{array}{l}\n${rows.join(' \\\\\n')}\n\\end{array}\n$$`;
};

const proseLatexText = (text: string) => {
  const parts = text.split('`');
  if (parts.length % 2 === 0) {
    return escapeLatex(text);
  }
  return parts
    .map((part, index) =>
      index % 2 === 1 ? `\\texttt{${escapeLatex(part)}}` : escapeLatex(part),
    )
    .join('');
};

// - Pipes stay outside the maths so a changed table row is still a table row.
// - One formula per word, because the app never wraps a line inside a formula.
const proseChangeMarkdown = (segment: Segment) =>
  segment.text
    .split('|')
    .map((cell) => {
      const [, lead = '', words = '', trail = ''] =
        /^(\s*)(.*?)(\s*)$/.exec(cell) ?? [];
      if (!words) {
        return cell;
      }
      const formulas = (words.match(/(?:`[^`]*`|\S)+/g) ?? []).map(
        (word) => `$${latexSegment(segment, proseLatexText(word))}$`,
      );
      return `${lead}${formulas.join(' ')}${trail}`;
    })
    .join('|');

const proseLineMarkdown = (line: Segment[]) =>
  line
    .map((segment) =>
      segment.kind === 'kept'
        ? segment.text.replaceAll('$', '\\$')
        : proseChangeMarkdown(segment),
    )
    .reduce((markdown, part) => {
      const endsInMath = markdown.endsWith('$') && !markdown.endsWith('\\$');
      // The app leaves `**` or `_` as literal text when a formula touches it.
      const formulaTouchesMarker =
        (endsInMath && /^[$*_]/.test(part)) ||
        (/[*_]$/.test(markdown) && part.startsWith('$'));
      return formulaTouchesMarker ? `${markdown} ${part}` : markdown + part;
    }, '');

const proseWordsMarkdown = (hunks: WordHunk[]) =>
  hunks
    .map(
      (hunk) =>
        `\`${hunk.header}\`\n\n${hunk.lines.map(proseLineMarkdown).join('\n')}`,
    )
    .join('\n\n---\n\n');

const wordsCard = (path: string, target: Target) => {
  const inRoot = relativeToRoot(path);
  if (target.kind === 'worktree' && untrackedFiles().includes(inRoot)) {
    fail(`${inRoot} is a new untracked file: use diff`);
  }
  const hunks = wordDiff(inRoot, target);
  if (hunks.length === 0) {
    fail(`${inRoot} has no changes in ${targetLabel(target)}`);
  }
  const body = isProse(inRoot)
    ? proseWordsMarkdown(hunks)
    : codeWordsMarkdown(hunks);
  writeCard(
    `words-${inRoot}`,
    `# ${basename(inRoot)}\n\n\`${inRoot}\`, ${targetLabel(target)}\n\n${body}\n`,
  );
};

type LineRange = { from: number; to: number };
type EditRegion = { old: LineRange; new: LineRange };

const revisionsOf = (target: Target) => {
  if (target.kind === 'worktree') {
    return { old: 'HEAD', new: undefined };
  }
  if (target.kind === 'range') {
    return { old: target.from, new: target.to };
  }
  return { old: `${target.rev}^`, new: target.rev };
};

const fileLinesAt = (revision: string | undefined, inRoot: string) => {
  const text =
    revision === undefined
      ? readFileSync(join(repoRoot(), inRoot), 'utf8')
      : git('show', `${revision}:${inRoot}`);
  return text.replace(/\n$/, '').split('\n');
};

const hunkRange = (start: string, count: string | undefined): LineRange => {
  const lines = count === undefined ? 1 : Number(count);
  const from = lines === 0 ? Number(start) : Number(start) - 1;
  return { from, to: from + lines };
};

const changedRegions = (inRoot: string, target: Target): EditRegion[] => {
  const raw = git('-C', repoRoot(), ...diffArgs(target), '-U0', '--', inRoot);
  const hunks = [
    ...raw.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm),
  ].map(([, oldStart, oldCount, newStart, newCount]) => ({
    old: hunkRange(oldStart, oldCount),
    new: hunkRange(newStart, newCount),
  }));
  return hunks.reduce<EditRegion[]>((regions, hunk) => {
    const last = regions.at(-1);
    if (last && hunk.old.from - last.old.to < EDIT_REGION_MERGE_GAP) {
      last.old.to = hunk.old.to;
      last.new.to = hunk.new.to;
    } else {
      regions.push(hunk);
    }
    return regions;
  }, []);
};

const occurrences = (text: string, search: string) =>
  text.split(search).length - 1;

const editReplay = (path: string, target: Target) => {
  const inRoot = relativeToRoot(path);
  if (target.kind === 'worktree' && untrackedFiles().includes(inRoot)) {
    fail(`${inRoot} is a new untracked file: use diff`);
  }
  const regions = changedRegions(inRoot, target);
  if (regions.length === 0) {
    fail(`${inRoot} has no changes in ${targetLabel(target)}`);
  }
  const revisions = revisionsOf(target);
  const oldLines = fileLinesAt(revisions.old, inRoot);
  const newLines = fileLinesAt(revisions.new, inRoot);

  const replayFile = join(repoRoot(), CARD_DIR, 'edit', basename(inRoot));
  mkdirSync(join(repoRoot(), CARD_DIR, 'edit'), { recursive: true });
  writeFileSync(replayFile, `${oldLines.join('\n')}\n`);
  console.log(replayFile);

  let replayed = `${oldLines.join('\n')}\n`;
  regions.forEach((region, index) => {
    const lowerBound = regions[index - 1]?.old.to ?? 0;
    const upperBound = regions[index + 1]?.old.from ?? oldLines.length;
    let from = Math.max(lowerBound, region.old.from - EDIT_REGION_CONTEXT);
    let to = Math.min(upperBound, region.old.to + EDIT_REGION_CONTEXT);
    const oldText = () => oldLines.slice(from, to).join('\n');
    while (
      occurrences(replayed, oldText()) !== 1 &&
      (from > lowerBound || to < upperBound)
    ) {
      from = Math.max(lowerBound, from - 1);
      to = Math.min(upperBound, to + 1);
    }
    if (occurrences(replayed, oldText()) !== 1) {
      fail(`region ${index + 1} is not unique in ${inRoot}: use diff`);
    }
    const newText = newLines
      .slice(
        from + region.new.from - region.old.from,
        to + region.new.to - region.old.to,
      )
      .join('\n');
    replayed = replayed.replace(oldText(), () => newText);
    console.log(
      `\nregion ${index + 1} of ${regions.length}, old lines ${from + 1}-${to}`,
    );
    console.log(`<<<<<<< old\n${oldText()}\n=======\n${newText}\n>>>>>>> new`);
  });
};

const fileCard = (path: string) => {
  const inRoot = relativeToRoot(path);
  if (!existsSync(path)) fail(`${path} does not exist`);
  if (extname(path) === '.md') return console.log(resolve(path));
  const text = readFileSync(path, 'utf8');
  const extension = extname(path).slice(1);
  const fence = fenceFor(text);
  writeCard(
    `file-${inRoot}`,
    `# ${basename(inRoot)}\n\n\`${inRoot}\`\n\n${fence}${FENCE_LANGUAGES[extension] ?? extension}\n${text.trimEnd()}\n${fence}\n`,
  );
};

const [command, first, second] = process.argv.slice(2);
if (command === 'overview') overview(parseTarget(first));
else if (command === 'diff')
  diffCard(first ?? fail('diff needs a path'), parseTarget(second));
else if (command === 'words')
  wordsCard(first ?? fail('words needs a path'), parseTarget(second));
else if (command === 'edit')
  editReplay(first ?? fail('edit needs a path'), parseTarget(second));
else if (command === 'file') fileCard(first ?? fail('file needs a path'));
else
  fail(
    'usage: peek.mts overview [target] | diff|words|edit <path> [target] | file <path>',
  );
