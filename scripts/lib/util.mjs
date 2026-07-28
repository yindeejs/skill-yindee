// Small shared helpers. No dependencies — Node >= 18 only.
import { createHash } from 'node:crypto';

export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

export const toPosix = (p) => String(p).replace(/\\/g, '/');

export const uniq = (a) => [...new Set(a)];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Glob -> RegExp. Supports `*`, `**`, `?`, `{a,b}`, and leading `!` is the
 * caller's business. Paths are always matched in posix form.
 */
export function globToRegex(glob) {
  const g = toPosix(glob);
  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:[^/]*(?:/|$))*';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (c === '{') {
      const end = g.indexOf('}', i);
      if (end !== -1) {
        re += '(?:' + g.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
        i = end + 1;
        continue;
      }
    }
    re += escapeRe(c);
    i += 1;
  }
  return new RegExp('^' + re + '$');
}

const globCache = new Map();
export function matchGlob(path, glob) {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegex(glob);
    globCache.set(glob, re);
  }
  return re.test(toPosix(path));
}

export const matchAny = (path, globs) => (globs || []).some((g) => matchGlob(path, g));

/** Keep the last `max` lines of `text`. */
export function tailLines(text, max) {
  const lines = String(text).replace(/\s+$/, '').split(/\r?\n/);
  if (lines.length <= max) return lines.join('\n');
  return `... (${lines.length - max} lines trimmed)\n` + lines.slice(-max).join('\n');
}

// Headlines name *which* thing failed; details say why. Headlines win the
// budget, because a truncated detail is still actionable and a missing
// headline is not.
const HEADLINE_RE = /(^\s*not ok\b|^\s*FAIL\b|^\s*✕|^\s*×|\bAssertionError\b|\bpanicked at\b|^\s*error(\[[A-Z]\d+\])?:|^\s*ERROR\b|^.+\.[a-z]+:\d+:\d+[ :]|\bTS\d{4}\b)/;
const DETAIL_RE =
  /\b(error|failed|failure|panic|assert|expected|actual|cannot|unable|refus|denied|E\d{3,4}|FAIL)\b/i;

/**
 * Pull the interesting lines out of a tool's output so we ship evidence, not
 * scrollback. Falls back to the tail when nothing matches.
 */
export function errorExcerpt(text, maxLines = 40) {
  const raw = String(text || '').replace(/\s+$/, '');
  if (!raw) return '';
  const lines = raw.split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join('\n');

  const picked = new Set();
  for (let i = 0; i < lines.length && picked.size < maxLines; i++) {
    if (HEADLINE_RE.test(lines[i])) picked.add(i);
  }
  for (let i = 0; i < lines.length && picked.size < maxLines; i++) {
    if (!picked.has(i) && DETAIL_RE.test(lines[i])) picked.add(i);
  }
  if (picked.size >= 3) {
    const idx = [...picked].sort((a, b) => a - b);
    const out = [];
    let prev = -1;
    for (const i of idx) {
      if (prev !== -1 && i - prev > 1) out.push(`  … (${i - prev - 1} lines)`);
      out.push(lines[i]);
      prev = i;
    }
    const extra = lines.length - idx.length;
    return out.join('\n') + `\n... (${extra} other lines omitted)`;
  }
  return tailLines(raw, maxLines);
}

export function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Human duration for report tables: `18m 37s`, `1h 04m 12s`, `842ms`. */
export function fmtDuration(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 1000) return `${n}ms`;
  const s = Math.floor(n / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact token counts: `4712` -> `4.7K`, `1234567` -> `1.2M`. */
export function fmtCount(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 1000) return String(v);
  if (Math.abs(v) < 1_000_000) return `${(v / 1000).toFixed(1)}K`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/** Signed percentage change from `a` to `b`, or null when `a` is 0. */
export function pctDelta(a, b) {
  const from = Number(a) || 0;
  const to = Number(b) || 0;
  if (from === 0) return to === 0 ? 0 : null;
  return ((to - from) / Math.abs(from)) * 100;
}

/** Left-pad a column set into compact aligned rows. */
export function columns(rows, gap = 2) {
  if (!rows.length) return '';
  const widths = [];
  for (const r of rows) {
    r.forEach((cell, i) => {
      const len = String(cell ?? '').length;
      if (!widths[i] || widths[i] < len) widths[i] = len;
    });
  }
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? String(cell ?? '') : String(cell ?? '').padEnd(widths[i])))
        .join(' '.repeat(gap))
        .replace(/\s+$/, ''),
    )
    .join('\n');
}

/** Parse `--key=value`, `--key value`, `--flag`, and positionals. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export const asList = (v) =>
  v === undefined || v === true || v === null
    ? []
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/** Tokens used for deterministic task <-> path scoring. */
const STOP = new Set(
  ('the a an and or of to for in on with add fix make update change support new implement create ' +
    'remove delete refactor improve build use using into from that this it is are be we i please ' +
    'need want should must can code file files feature bug issue task work them their our').split(' '),
);
export function tokenize(text) {
  return uniq(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}
