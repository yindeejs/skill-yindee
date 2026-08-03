// Repository Intelligence: a deterministic, incrementally-updated file index.
//
// Answers *what* and *where*, derived from git and project metadata — never
// from prose. The map caches project structure; this caches the layer under it,
// the file universe, which `context` previously re-walked on every call.
//
// Two properties make it safe to have on by default:
//
//   1. It changes where the file list comes from, never how candidates are
//      scored. `fileCandidates` keeps its weights, its threshold and its sort.
//   2. Every failure path falls back to the live walk. No index, stale index,
//      lock held, no git, corrupt file, thrown error — `context` still works.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, readText, statSafe, exists, listDir, withLock } from './fsx.mjs';
import { harnessFingerprint } from './map.mjs';
import { areasOf, isGenerated, primaryArea } from './areas.mjs';
import { capture } from './sh.mjs';
import { sha1, toPosix } from './util.mjs';

export const INDEX_VERSION = 1;

/** Above this many changed paths, a full rebuild beats patching entry by entry. */
export const REBUILD_THRESHOLD = 500;

export const indexDir = (root) => path.join(root, '.claude', 'yindee', 'index');
export const metaPath = (root) => path.join(indexDir(root), 'meta.json');
export const filesPath = (root) => path.join(indexDir(root), 'files.json');
export const lockPath = (root) => path.join(indexDir(root), '.lock');

/** Counts what the index actually touched, so tests can assert "zero reads". */
export const intelStats = { reads: 0, builds: 0, patches: 0, hits: 0 };

const git = (root, args) => capture(`git ${args}`, { cwd: root, timeout: 60_000 });

// ------------------------------------------------------------------ facts ---

const LANG_BY_EXT = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  py: 'py', go: 'go', rs: 'rs', rb: 'rb', java: 'java', kt: 'kt', swift: 'swift',
  php: 'php', cs: 'cs', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  sql: 'sql', sh: 'sh', md: 'md', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
};

const langOf = (rel) => LANG_BY_EXT[rel.split('.').pop()?.toLowerCase()] || null;

/**
 * Line-level extraction of imports and top-level declarations.
 *
 * This is NOT a parser and is never described as one. Node ships no AST for
 * these languages and the harness has no dependencies, so the honest trade is a
 * per-language regex table: cheap, deterministic, and wrong at the edges.
 *
 * Known blind spots, by design: dynamic `import()`, re-exports through barrel
 * files, macro- or decorator-generated symbols, and anything built by string
 * concatenation. Everything downstream therefore treats a miss as "no extra
 * candidate", never as "no such symbol" — `git grep` remains the fallback.
 */
const EXTRACT = {
  js: {
    import: [/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/, /^\s*(?:const|let|var)\s+.*=\s*require\(\s*['"]([^'"]+)['"]/],
    symbol: [/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/, /^\s*export\s+\{([^}]+)\}/],
  },
  ts: {
    import: [/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/],
    symbol: [
      /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/,
      /^\s*export\s+\{([^}]+)\}/,
    ],
  },
  py: {
    import: [/^\s*from\s+([.\w]+)\s+import\s/, /^\s*import\s+([.\w]+)/],
    symbol: [/^(?:async\s+)?def\s+(\w+)/, /^class\s+(\w+)/],
  },
  go: {
    import: [/^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"\s*$/],
    symbol: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)/, /^(?:var|const)\s+(\w+)/],
  },
  rs: {
    import: [/^\s*use\s+([\w:]+)/],
    symbol: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, /^\s*(?:pub\s+)?(?:struct|enum|trait|type)\s+(\w+)/],
  },
  rb: { import: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/], symbol: [/^\s*def\s+(\w+)/, /^\s*class\s+(\w+)/, /^\s*module\s+(\w+)/] },
  java: { import: [/^\s*import\s+([\w.]+)/], symbol: [/^\s*public\s+(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/] },
  cs: { import: [/^\s*using\s+([\w.]+)/], symbol: [/^\s*public\s+(?:static\s+|sealed\s+|abstract\s+)?(?:class|interface|enum|record|struct)\s+(\w+)/] },
  php: { import: [/^\s*(?:use|require|include)[^'";]*['"]?([\w\\/.]+)/], symbol: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/, /^\s*function\s+(\w+)/] },
};

/** Only bother reading files we can actually extract from, and only if small. */
const MAX_EXTRACT_BYTES = 512 * 1024;

function extract(root, rel, lang, size) {
  const rules = EXTRACT[lang];
  if (!rules || size > MAX_EXTRACT_BYTES) return null;
  const text = readText(path.join(root, rel));
  if (text === null) return null;
  const imports = new Set();
  const symbols = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 400) continue; // minified or generated
    for (const re of rules.import) {
      const m = line.match(re);
      if (m?.[1]) {
        imports.add(m[1].trim());
        break;
      }
    }
    for (const re of rules.symbol) {
      const m = line.match(re);
      if (!m?.[1]) continue;
      // `export { a, b as c }` — take the exported names.
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^\w+$/.test(name)) symbols.add(name);
      }
      break;
    }
  }
  return { imports: [...imports].sort(), symbols: [...symbols].sort() };
}

/**
 * Everything the candidate ranker needs to know about one file, computed from
 * its path plus one stat. Deliberately no content: the entry must stay small
 * enough that a 50k-file repo is a few megabytes.
 */
function entryFor(root, rel) {
  const st = statSafe(path.join(root, rel));
  if (!st || !st.isFile()) return null;
  intelStats.reads++;
  const lang = langOf(rel);
  const source = !isGenerated(rel) && areasOf(rel).length > 0;
  const e = { size: st.size, area: primaryArea(rel), source, lang };
  if (source) {
    const x = extract(root, rel, lang, st.size);
    // Empty lists are omitted so the store stays small and the bytes stay stable.
    if (x?.imports.length) e.imports = x.imports;
    if (x?.symbols.length) e.symbols = x.symbols;
  }
  return e;
}

// ------------------------------------------------------------------- git ---

// Every git call is a process spawn, which on Windows costs tens of
// milliseconds. Provider detection and `load` both need this answer, and it
// cannot change mid-process, so it is asked once.
const gitRepoCache = new Map();
const isGitRepo = (root) => {
  if (!gitRepoCache.has(root)) gitRepoCache.set(root, git(root, 'rev-parse --is-inside-work-tree') === 'true');
  return gitRepoCache.get(root);
};
const headOf = (root) => git(root, 'rev-parse HEAD') || null;

/** Tracked files at HEAD. No depth cap and no entry cap — that is the point. */
function trackedFiles(root) {
  const out = capture('git ls-files -z', { cwd: root, timeout: 120_000 });
  if (out === null) return [];
  return out.split('\0').map((s) => s.trim()).filter(Boolean).map(toPosix);
}

/** Our own generated state must never count as a repo change. */
const SELF = '.claude/yindee/';

/**
 * Paths that differ from HEAD right now, including untracked ones. Short in
 * practice, which is what keeps the warm path cheap.
 *
 * Uses `capture` rather than `lines`: porcelain output is `XY <path>`, and
 * `lines` trims, which would shift every path by the leading status column.
 */
function dirtyFiles(root) {
  const out = capture('git status --porcelain --untracked-files=all', { cwd: root, timeout: 60_000 });
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3))
    // Renames read `old -> new`; the new path is the one that exists.
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
    .map((p) => toPosix(p.trim().replace(/^"|"$/g, '')))
    // Writing the index changes the working tree. Counting that as a change
    // would invalidate the index on every single run.
    .filter((p) => p && !p.startsWith(SELF));
}

function changedBetween(root, from, to) {
  if (!from || !to || from === to) return [];
  const out = capture(`git diff --name-only ${from} ${to}`, { cwd: root, timeout: 120_000 });
  if (out === null) return null; // unknown commit (shallow clone, rebased away)
  return out.split(/\r?\n/).map((s) => toPosix(s.trim())).filter(Boolean);
}

// ------------------------------------------------------------------ build ---

function fullBuild(root) {
  intelStats.builds++;
  const files = {};
  for (const rel of trackedFiles(root).filter((r) => !r.startsWith(SELF))) {
    const e = entryFor(root, rel);
    if (e) files[rel] = e;
  }
  // Untracked-but-present files are real files a task can touch.
  for (const rel of dirtyFiles(root)) {
    if (files[rel]) continue;
    const e = entryFor(root, rel);
    if (e) files[rel] = e;
  }
  return files;
}

function patch(root, files, changed) {
  intelStats.patches++;
  const next = { ...files };
  for (const rel of changed) {
    const e = entryFor(root, rel);
    if (e) next[rel] = e;
    else delete next[rel]; // deleted or no longer a file
  }
  return next;
}

/** Sorted keys, so the same input always serialises to the same bytes. */
const canonical = (files) =>
  Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));

// ------------------------------------------------------------------- load ---

/**
 * Is a usable index possible here at all? Cheap enough to call from provider
 * detection: one `git rev-parse`, no build.
 */
export function available(root) {
  try {
    return isGitRepo(root);
  } catch {
    return false;
  }
}

/**
 * Load the index, updating it incrementally when git says something moved.
 *
 * Returns `{ ok, reason, files, status }`. `ok: false` is not an error — it is
 * the caller's cue to use the live walk, and every caller must handle it.
 */
export function load(root, { write = true } = {}) {
  try {
    return loadInner(root, write);
  } catch (err) {
    return { ok: false, reason: `error: ${err?.message || err}`, files: null, status: 'error' };
  }
}

function loadInner(root, write) {
  if (!isGitRepo(root)) {
    return { ok: false, reason: 'not a git repository', files: null, status: 'unavailable' };
  }
  const head = headOf(root);
  if (!head) {
    return { ok: false, reason: 'no commits yet', files: null, status: 'unavailable' };
  }

  const harness = harnessFingerprint();
  const meta = readJson(metaPath(root));
  const files = meta ? readJson(filesPath(root)) : null;
  const dirty = dirtyFiles(root);
  const dirtyFp = sha1(dirty.slice().sort().join('|'));

  const usable =
    meta && files && meta.indexVersion === INDEX_VERSION && meta.harness === harness && meta.head;

  if (usable && meta.head === head && meta.dirtyFp === dirtyFp) {
    intelStats.hits++;
    return { ok: true, reason: 'hit', files, status: 'hit', meta };
  }

  // Work out the smallest correct update. `meta.dirty` must be folded in:
  // a file that was dirty last run and is clean now still needs re-reading,
  // otherwise its stale entry survives forever.
  let changed = null;
  if (usable) {
    const sinceHead = changedBetween(root, meta.head, head);
    if (sinceHead !== null) changed = [...new Set([...sinceHead, ...(meta.dirty || []), ...dirty])];
  }

  const build = () => {
    const next =
      changed && changed.length <= REBUILD_THRESHOLD ? patch(root, files, changed) : fullBuild(root);
    return canonical(next);
  };

  // Losing the lock is not a failure — the loser just does the work itself and
  // skips the write, so N concurrent sessions never queue behind each other.
  if (!write) return { ok: true, reason: 'computed', files: build(), status: 'computed' };

  const res = withLock(lockPath(root), () => {
    const next = build();
    writeJsonAtomic(filesPath(root), next);
    writeJsonAtomic(metaPath(root), {
      indexVersion: INDEX_VERSION,
      harness,
      head,
      dirty,
      dirtyFp,
      builtAt: new Date().toISOString(),
      counts: { files: Object.keys(next).length },
    });
    return next;
  });

  if (res.ran) {
    return {
      ok: true,
      reason: changed ? `patched ${changed.length}` : 'built',
      files: res.value,
      status: changed ? 'patched' : 'built',
    };
  }
  // Another process is building. Compute in memory for this call rather than
  // waiting: the answer is identical, only the write is skipped.
  return { ok: true, reason: 'lock held — computed in memory', files: build(), status: 'computed' };
}

// ------------------------------------------------------------------ query ---

/**
 * Repo-relative paths under `scope` (`''` = whole repo), in stable order.
 * This is what replaces `collectFiles` in the candidate ranker.
 */
export function list(files, scope = '') {
  const prefix = scope && scope !== '.' ? (scope.endsWith('/') ? scope : scope + '/') : '';
  if (!prefix) return Object.keys(files);
  return Object.keys(files).filter((f) => f.startsWith(prefix));
}

/**
 * Files declaring a symbol whose name contains `token` (case-insensitive).
 *
 * Deliberately additive: a hit is a good candidate, a miss means nothing. The
 * caller keeps `git grep` so that the extractor's blind spots cost recall in
 * the index, never in the answer.
 */
export function lookup(files, token) {
  const t = String(token).toLowerCase();
  if (t.length < 3) return [];
  const hits = [];
  for (const [rel, e] of Object.entries(files)) {
    if (!e.symbols) continue;
    if (e.symbols.some((s) => s.toLowerCase().includes(t))) hits.push(rel);
  }
  return hits;
}

/**
 * Files that import any of `changed` — the file-level edge set `impact` cannot
 * get from manifests, which only describe package-to-package edges.
 *
 * Specifiers are matched on the module basename (`./areas.mjs`, `../lib/areas`
 * and `@pkg/areas` all reduce to `areas`), because resolving them properly
 * would mean reimplementing four module resolvers. That makes this a
 * *superset*: it can name a file that imports a different module of the same
 * name. Callers must present it as "may be affected", never as a fact.
 */
export function fileDependents(files, changed) {
  const stems = new Set(
    changed
      .map((p) => p.split('/').pop().replace(/\.[^.]+$/, ''))
      .filter((s) => s && s.length >= 3 && s !== 'index'),
  );
  if (!stems.size) return [];
  const changedSet = new Set(changed);
  const hits = [];
  for (const [rel, e] of Object.entries(files)) {
    if (!e.imports || changedSet.has(rel)) continue;
    const imported = e.imports.some((spec) => {
      const stem = spec.split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
      return stems.has(stem);
    });
    if (imported) hits.push(rel);
  }
  return hits.sort();
}

/** Human/agent digest for `Y intel`. */
export function renderIntel(root, res) {
  const out = [];
  if (!res.ok) {
    out.push(`intel  unavailable (${res.reason}) — context falls back to the live scan`);
    return out.join('\n');
  }
  const n = Object.keys(res.files).length;
  const meta = readJson(metaPath(root));
  const bytes = statSafe(filesPath(root))?.size ?? 0;
  out.push(`intel  ${res.status} · ${n} file(s) indexed`);
  if (meta) {
    out.push(`head   ${String(meta.head).slice(0, 12)}  built ${meta.builtAt}`);
    if (meta.dirty?.length) out.push(`dirty  ${meta.dirty.length} uncommitted path(s) tracked`);
  }
  out.push(`store  ${toPosix(path.relative(root, indexDir(root)))}  ${(bytes / 1024).toFixed(1)} KB`);
  return out.join('\n');
}

/** `Y intel rebuild` — drop the store so the next load builds from scratch. */
export function clear(root) {
  const dir = indexDir(root);
  if (!exists(dir)) return { removed: [] };
  const removed = [];
  for (const e of listDir(dir)) {
    if (!e.isFile()) continue;
    try {
      fs.unlinkSync(path.join(dir, e.name));
      removed.push(e.name);
    } catch {
      /* held open elsewhere — the next build overwrites it anyway */
    }
  }
  return { removed };
}
