#!/usr/bin/env node
// Inventory of running Claude Code sessions: which window owns each, what it costs in
// memory, how long since it last did anything, and what it was last asked to do.
//
// Sessions outlive their VS Code tab, so a machine accumulates processes nobody is
// using. This finds them; killing is left to you.
//
// Usage: claude-ps [--idle MINUTES]   (default 60)

import { closeSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const IDLE_THRESHOLD_MIN = Number(process.argv[process.argv.indexOf('--idle') + 1]) || 60;

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- process facts

// comm can contain spaces and parentheses, so fields are read after the final ')'.
// The first field there is #3, so field N sits at index N-3.
const statFields = (pid: number) => {
  const stat = read(`/proc/${pid}/stat`) ?? '';
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
};

const bootMs = Number(/btime (\d+)/.exec(read('/proc/stat') ?? '')?.[1] ?? 0) * 1000;
const startedAt = (pid: number) => bootMs + (Number(statFields(pid)[19]) / 100) * 1000;

// ---------------------------------------------------------------- transcripts

// The parts of a transcript record this tool reads. Every field is optional because a
// given line may be a summary, a tool result or a user turn, and only some of those
// carry any particular field.
type ContentBlock = { type?: string; text?: string };
type TranscriptRecord = {
  type?: string;
  isMeta?: boolean;
  timestamp?: string;
  summary?: string;
  gitBranch?: string;
  message?: { content?: string | ContentBlock[] };
};

// When a session started, taken from the first record it wrote. File ctime is no use:
// it moves on every append, so the busiest transcripts would look like the newest.
// The opening records of a resumed or compacted session are summaries carrying no
// timestamp, so take the first record that has one rather than only the first line.
const firstRecordMs = (path: string) => {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytes).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const ts = (JSON.parse(line) as TranscriptRecord).timestamp;
        if (ts) return Date.parse(ts);
      } catch {
        break; // truncated final line in the buffer
      }
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

// The last thing a human typed, which is what actually identifies a session on sight.
// Read from the end: the tail of a transcript is mostly tool traffic, so allow a
// generous window before giving up.
const lastPrompt = (path: string) => {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const window = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(window);
    readSync(fd, buf, 0, window, size - window);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec: TranscriptRecord;
      try {
        rec = JSON.parse(lines[i]) as TranscriptRecord;
      } catch {
        continue;
      }
      if (rec.type !== 'user' || rec.isMeta) continue;
      const content = rec.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : content
              ?.filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join(' ');
      // Tool results arrive as user records too; they have no text part.
      if (!text) continue;
      // A real prompt usually arrives wrapped in harness blocks — an opened-file notice,
      // a system reminder. Strip those and keep what the human typed, rather than
      // discarding the whole record for starting with a '<'.
      const cleaned = text
        .replace(/<([a-z_-]+)>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleaned || cleaned.startsWith('Caveat:')) continue;
      return cleaned;
    }
  } catch {
    // unreadable
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return '';
};

// Counted in chunks rather than by reading the file in: transcripts reach tens of MB,
// and this tool exists to be run on a machine that is already short on memory.
const countRecords = (path: string) => {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    let total = 0;
    let bytes;
    while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytes; i++) if (buf[i] === 0x0a) total++;
    }
    return total;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const gitBranch = (path: string) => {
  const head = read(path) ?? '';
  const line = head.split('\n').find((l) => l.includes('"gitBranch"'));
  try {
    return (JSON.parse(line ?? '') as TranscriptRecord).gitBranch || '';
  } catch {
    return '';
  }
};

// A compacted or resumed session opens with a summary record. It is the best label
// available for a session whose every user record turned out to be harness scaffolding.
const headSummary = (path: string) => {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytes).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const summary = (JSON.parse(line) as TranscriptRecord).summary;
        if (typeof summary === 'string' && summary) return summary.replace(/\s+/g, ' ').trim();
      } catch {
        break;
      }
    }
  } catch {
    // unreadable
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return '';
};

// Claude encodes a cwd into a project directory name by replacing every non-alphanumeric
// run with '-', so /repos/admin becomes -repos-admin.
type TranscriptFile = { path: string; birthMs: number; mtimeMs: number };

const projectRoot = `${homedir()}/.claude/projects`;
const transcriptCache = new Map<string, TranscriptFile[]>();

const transcriptsFor = (cwd: string): TranscriptFile[] => {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const cached = transcriptCache.get(key);
  if (cached) return cached;
  let files: TranscriptFile[] = [];
  try {
    files = readdirSync(`${projectRoot}/${key}`)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const path = `${projectRoot}/${key}/${f}`;
        return { path, birthMs: firstRecordMs(path), mtimeMs: statSync(path).mtimeMs };
      })
      .filter((f) => f.birthMs > 0);
  } catch {
    // no transcripts recorded for this cwd
  }
  transcriptCache.set(key, files);
  return files;
};

// ---------------------------------------------------------------- collect

type Session = {
  pid: number;
  ppid: number;
  rssMb: number;
  swapMb: number;
  oom: number;
  oomAdj: number;
  startMs: number;
  ageMin: number;
  cwd: string;
  kind: 'session' | 'helper';
  transcript: string;
  // Stays undefined when no transcript could be matched, which is a real outcome rather
  // than a failure — see the MAX_SKEW_MS note below.
  idleMin: number | undefined;
  inferred: boolean;
  records: number;
  branch: string;
  prompt: string;
  summary: string;
};

const sessions: Session[] = [];

for (const entry of readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  const pid = Number(entry);

  const cmdline = read(`/proc/${pid}/cmdline`);
  if (!cmdline) continue;
  const args = cmdline.split('\0').filter(Boolean);
  if (!args[0]?.endsWith('/claude')) continue;

  const status = read(`/proc/${pid}/status`) ?? '';
  const field = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(status)?.[1] ?? 0);

  let cwd = '?';
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // exited mid-scan, or not ours
  }

  const session: Session = {
    pid,
    ppid: field('PPid'),
    rssMb: Math.round(field('VmRSS') / 1024),
    swapMb: Math.round(field('VmSwap') / 1024),
    oom: Number(read(`/proc/${pid}/oom_score`) ?? 0),
    oomAdj: Number(read(`/proc/${pid}/oom_score_adj`) ?? 0),
    startMs: startedAt(pid),
    ageMin: Math.round((Date.now() - startedAt(pid)) / 60000),
    cwd,
    kind: args.includes('--claude-in-chrome-mcp') ? 'helper' : 'session',
    // Filled in once a transcript is matched, below.
    transcript: '',
    idleMin: undefined,
    inferred: false,
    records: 0,
    branch: '',
    prompt: '',
    summary: '',
  };

  // Best case: the process still holds its transcript open.
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let target;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (target.includes('/.claude/projects/') && target.endsWith('.jsonl')) session.transcript = target;
    }
  } catch {
    // no fd access
  }

  // Next best: --resume=<id> names the transcript outright.
  if (!session.transcript) {
    const resume = args.find((a) => a.startsWith('--resume='))?.slice('--resume='.length);
    if (resume) {
      for (const project of readdirSync(projectRoot)) {
        const candidate = `${projectRoot}/${project}/${resume}.jsonl`;
        try {
          statSync(candidate);
          session.transcript = candidate;
          break;
        } catch {
          // not this project
        }
      }
    }
  }

  sessions.push(session);
}

// Everything else is matched on start time: a fresh session writes its first record
// moments after the process appears. Done globally, smallest gap first, because
// matching each process in turn lets an early one take a file that fits a later one
// better. Beyond the cap the pairing says nothing — a session started minutes ago
// cannot own a transcript opened hours earlier — and leaving it unmatched is the
// honest result. Resumed sessions land there: their first record predates the process.
const MAX_SKEW_MS = 10 * 60_000;
const claimed = new Set(sessions.map((s) => s.transcript).filter(Boolean));

// Walking up from this script finds the session running it, so it never lands in a
// kill list you are about to paste.
let self: Session | undefined;
for (let pid = process.pid; pid > 1; ) {
  const match = sessions.find((s) => s.pid === pid);
  if (match) {
    self = match;
    break;
  }
  const ppid = Number(/PPid:\s+(\d+)/.exec(read(`/proc/${pid}/status`) ?? '')?.[1] ?? 0);
  if (!ppid || ppid === pid) break;
  pid = ppid;
}

// Claim this session's transcript before anything else competes for it. A resumed
// session's first record predates its process, so start-time matching would skip it and
// hand the file to whichever process started nearest to it. This one is writing right
// now, which makes the freshest unclaimed transcript in its directory certainly its own.
if (self && !self.transcript) {
  const newest = transcriptsFor(self.cwd)
    .filter((f) => !claimed.has(f.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (newest) {
    self.transcript = newest.path;
    self.inferred = true;
    claimed.add(newest.path);
  }
}

const pairs: { s: Session; path: string; delta: number }[] = [];

for (const s of sessions) {
  if (s.transcript || s.kind === 'helper') continue;
  for (const file of transcriptsFor(s.cwd)) {
    if (claimed.has(file.path)) continue;
    const delta = Math.abs(file.birthMs - s.startMs);
    if (delta <= MAX_SKEW_MS) pairs.push({ s, path: file.path, delta });
  }
}

pairs.sort((a, b) => a.delta - b.delta);
for (const p of pairs) {
  if (p.s.transcript || claimed.has(p.path)) continue;
  p.s.transcript = p.path;
  p.s.inferred = true;
  claimed.add(p.path);
}

for (const s of sessions) {
  if (!s.transcript) continue;
  s.idleMin = Math.round((Date.now() - statSync(s.transcript).mtimeMs) / 60000);
  s.records = countRecords(s.transcript);
  s.branch = gitBranch(s.transcript);
  s.prompt = lastPrompt(s.transcript);
  s.summary = s.prompt ? '' : headSummary(s.transcript);
}

// ---------------------------------------------------------------- report

// The mem/swap line below is also what `memstat` prints on its own. The two compute it
// separately on purpose — memstat has to stay a standalone awk one-liner, and the
// percentages here feed the earlyoom check as numbers, not just as text. Change the
// wording in one and change it in the other.
const meminfo = read('/proc/meminfo') ?? '';
const mem = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(meminfo)?.[1] ?? 0);
const memPct = (mem('MemAvailable') * 100) / mem('MemTotal');
const swapPct = mem('SwapTotal') ? (mem('SwapFree') * 100) / mem('SwapTotal') : 0;

const totalRss = sessions.reduce((n, s) => n + s.rssMb, 0);
const totalSwap = sessions.reduce((n, s) => n + s.swapMb, 0);
const real = sessions.filter((s) => s.kind === 'session');

console.log(
  `${real.length} sessions + ${sessions.length - real.length} helpers — ${totalRss} MB resident, ${totalSwap} MB swapped`,
);
console.log(
  `mem avail: ${Math.round(mem('MemAvailable') / 1024)} of ${Math.round(mem('MemTotal') / 1024)} MiB (${memPct.toFixed(1)}%), ` +
    `swap free: ${Math.round(mem('SwapFree') / 1024)} of ${Math.round(mem('SwapTotal') / 1024)} MiB (${swapPct.toFixed(1)}%)`,
);

// earlyoom acts only when BOTH are under their threshold, so report it that way.
const earlyoom = readdirSync('/proc')
  .filter((d) => /^\d+$/.test(d))
  .map((d) => read(`/proc/${d}/cmdline`))
  .find((c) => c?.includes('earlyoom'));
if (earlyoom) {
  const a = earlyoom.split('\0').filter(Boolean);
  const opt = (flag: string) => a[a.indexOf(flag) + 1] ?? '?';
  const memLow = memPct < Number(opt('-m'));
  const swapLow = swapPct < Number(opt('-s'));
  const state = memLow && swapLow ? 'FIRING' : memLow || swapLow ? 'one of two thresholds crossed' : 'idle';
  console.log(`earlyoom: mem<${opt('-m')}% and swap<${opt('-s')}% -> ${state}`);
}

const pad = (v: string | number, n: number) => String(v).padEnd(n);
const order = { session: 0, helper: 1 };
sessions.sort((a, b) => order[a.kind] - order[b.kind] || (b.idleMin ?? -1) - (a.idleMin ?? -1));

console.log(
  `\n${pad('PID', 8)}${pad('RSS', 7)}${pad('SWAP', 7)}${pad('OOM', 5)}${pad('AGE', 7)}${pad('IDLE', 7)}${pad('RECS', 6)}${pad('WHERE', 30)}LAST PROMPT`,
);

for (const s of sessions) {
  const where = s.kind === 'helper' ? '(chrome helper)' : `${s.cwd.split('/').pop()}${s.branch ? `@${s.branch}` : ''}`;
  const mins = (v: number | undefined) => (v === undefined ? '-' : v >= 60 ? `${Math.floor(v / 60)}h${v % 60}m` : `${v}m`);
  let label = s.prompt
    ? s.prompt.slice(0, 60)
    : s.summary
      ? `» ${s.summary.slice(0, 58)}`
      : s.transcript
        ? '(no prompt found)'
        : '(transcript not matched)';
  if (s.kind === 'helper') label = '';
  if (s.inferred) label = `~ ${label}`;
  if (s === self) label = `** THIS SESSION ** ${label}`;

  console.log(
    pad(s.pid, 8) +
      pad(`${s.rssMb}M`, 7) +
      pad(s.swapMb ? `${s.swapMb}M` : '-', 7) +
      pad(s.oom + (s.oomAdj ? `${s.oomAdj > 0 ? '+' : ''}${s.oomAdj}` : ''), 5) +
      pad(mins(s.ageMin), 7) +
      pad(mins(s.idleMin), 7) +
      pad(s.records || '-', 6) +
      pad(where.slice(0, 29), 30) +
      label,
  );
}

// A '~' prefix marks a start-time guess rather than a fact the process stated.
if (sessions.some((s) => s.inferred)) {
  console.log(`\n~ = transcript inferred from start time; identity may be swapped with another session started nearby.`);
}

const stale = sessions.filter((s) => s !== self && s.kind === 'session' && (s.idleMin ?? 0) >= IDLE_THRESHOLD_MIN);
if (stale.length) {
  const freed = stale.reduce((n, s) => n + s.rssMb, 0);
  console.log(`\nIdle over ${IDLE_THRESHOLD_MIN}m — ${stale.length} sessions holding ${freed} MB:`);
  console.log(`  kill ${stale.map((s) => s.pid).join(' ')}`);
}
