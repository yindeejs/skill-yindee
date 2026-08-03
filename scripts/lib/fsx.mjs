// Bounded filesystem access. Every walk here is capped by depth and entry count
// so no command can accidentally traverse a whole monorepo.
import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './util.mjs';

export const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'jspm_packages',
  'target', 'dist', 'build', 'out', 'output', '.output', 'bin', 'obj',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.docusaurus', '.vercel', '.netlify',
  '.turbo', '.nx', '.gradle', '.mvn', '.cache', '.parcel-cache', '.rollup.cache',
  'coverage', 'htmlcov', '.nyc_output', 'vendor', 'Pods', 'DerivedData',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', 'site-packages', '.eggs', '.terraform', '.serverless',
  '.yarn', '.pnpm-store', '.pnpm', '.idea', '.vs', 'tmp', 'temp', '.tmp',
]);

export const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

export function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function readJson(p) {
  const t = readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

export function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Same, but a concurrent reader can never see a half-written file: the content
 * lands in a per-process temp file and is then renamed onto the target. Rename
 * is an atomic replace on POSIX and on Windows (MoveFileEx), so a reader gets
 * either the old bytes or the new ones.
 */
export function writeJsonAtomic(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

export const STALE_LOCK_MS = 60_000;

/**
 * Advisory lock around a rebuild. `wx` is O_EXCL, so acquiring is atomic on
 * every platform Node supports.
 *
 * Never blocks: a caller that loses the race gets `{ ran: false }` and is
 * expected to fall back to whatever it did before the cache existed. That is
 * what keeps N concurrent sessions correct without a queue — the loser does the
 * work itself rather than waiting for the winner.
 *
 * A lock older than STALE_LOCK_MS is treated as abandoned, so a killed process
 * cannot wedge a repository. Two builders racing after a stale break is
 * harmless: both write atomically and produce the same bytes for the same input.
 */
export function withLock(lockFile, fn, { staleMs = STALE_LOCK_MS } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd = null;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch {
    const st = statSafe(lockFile);
    if (!st || Date.now() - st.mtimeMs < staleMs) return { ran: false, reason: 'locked' };
    try {
      fs.unlinkSync(lockFile);
      fd = fs.openSync(lockFile, 'wx');
    } catch {
      return { ran: false, reason: 'locked' };
    }
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    fd = null;
    return { ran: true, value: fn() };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* someone broke it as stale */
    }
  }
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Depth- and count-bounded directory walk.
 * `onFile` receives repo-relative posix paths; return `false` from `enterDir`
 * to prune a subtree.
 */
export function walk(root, opts = {}) {
  const { maxDepth = 4, maxEntries = 20000, enterDir, onFile, includeDirs = false } = opts;
  let count = 0;
  const stack = [{ dir: root, depth: 0, rel: '' }];
  while (stack.length) {
    const { dir, depth, rel } = stack.pop();
    for (const entry of listDir(dir)) {
      if (count >= maxEntries) return count;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && !['.github', '.claude', '.gitlab', '.circleci'].includes(entry.name)) {
          continue;
        }
        if (includeDirs) onFile?.(relPath, true);
        if (depth + 1 > maxDepth) continue;
        if (enterDir && enterDir(relPath) === false) continue;
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1, rel: relPath });
      } else if (entry.isFile()) {
        count++;
        onFile?.(relPath, false);
      }
    }
  }
  return count;
}

/** Collect repo-relative file paths under `sub`, bounded. */
export function collectFiles(root, sub, opts = {}) {
  const base = sub ? path.join(root, sub) : root;
  if (!exists(base)) return [];
  const files = [];
  const limit = opts.limit ?? 4000;
  walk(base, {
    maxDepth: opts.maxDepth ?? 6,
    maxEntries: limit,
    onFile: (rel, isDir) => {
      if (isDir) return;
      files.push(sub ? `${toPosix(sub)}/${rel}` : rel);
    },
  });
  return files;
}

/** Walk upward from `start` looking for a repo root marker. */
export function findRepoRoot(start) {
  let dir = path.resolve(start);
  const markers = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'pom.xml', 'mix.exs'];
  let fallback = null;
  for (;;) {
    if (exists(path.join(dir, '.git'))) return dir;
    if (!fallback && markers.some((m) => exists(path.join(dir, m)))) fallback = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback || path.resolve(start);
}

/** Cheap change fingerprint: size+mtime of a known file set. */
export function fingerprint(root, relPaths) {
  const parts = [];
  for (const rel of [...relPaths].sort()) {
    const st = statSafe(path.join(root, rel));
    parts.push(st ? `${rel}:${st.size}:${Math.round(st.mtimeMs)}` : `${rel}:absent`);
  }
  return parts.join('|');
}

/**
 * Keep generated artefacts out of everyone's `git status` without touching a
 * tracked file. `.git/info/exclude` is local-only, so nothing here ever lands
 * in a teammate's checkout.
 */
export function ensureLocalExclude(root) {
  const excludeFile = path.join(root, '.git', 'info', 'exclude');
  try {
    if (!exists(path.join(root, '.git'))) return;
    const dir = path.dirname(excludeFile);
    if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
    const cur = readText(excludeFile) || '';
    if (cur.includes('.claude/yindee/')) return;
    fs.writeFileSync(excludeFile, cur.replace(/\s*$/, '\n') + '# yindee generated artefacts\n.claude/yindee/\n');
  } catch {
    /* worktrees, permissions, submodules — never fatal */
  }
}

export function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of listDir(src)) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}
