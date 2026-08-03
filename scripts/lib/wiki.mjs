// Knowledge Wiki: human-authored project knowledge — ADRs, design documents,
// conventions, glossaries, research notes.
//
// It answers *why*. It must never answer *what* or *where*: those come from
// Repository Intelligence and from git, which cannot lie. A wiki document is a
// claim by a person at a point in time, and this module treats it as exactly
// that.
//
// The boundary is structural, not advisory:
//   - nothing here is ever imported by impact.mjs or verify.mjs, so a document
//     cannot change a risk tier or a verification plan;
//   - entries never enter fileCandidates, so a document cannot displace source
//     from the context budget;
//   - only headings are stored, never body text, so having a wiki costs a few
//     pointer lines rather than a document dump.
//
// Yindee never writes to the wiki. Authoring stays human — that is what makes
// it worth reading.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, readText, exists, statSafe, listDir, collectFiles, withLock } from './fsx.mjs';
import { harnessFingerprint } from './map.mjs';
import { capture } from './sh.mjs';
import { uniq, toPosix } from './util.mjs';
// `segs` is the same tokenizer the file ranker uses, so a title matches a task
// the same way a path does. Reused rather than reimplemented.
import { segs } from './candidates.mjs';

export const WIKI_VERSION = 1;

export const wikiDir = (root) => path.join(root, '.claude', 'yindee', 'knowledge');
export const wikiIndexPath = (root) => path.join(wikiDir(root), 'index.json');
export const wikiLockPath = (root) => path.join(wikiDir(root), '.lock');

/** Where knowledge conventionally lives when a repo has not said otherwise. */
export const DEFAULT_DIRS = ['docs/adr', 'docs/decisions', 'docs/design', 'docs/rfc', 'docs'];
export const DEFAULT_FILES = ['ARCHITECTURE.md', 'DESIGN.md', 'ADR.md', 'GLOSSARY.md', 'CONVENTIONS.md'];

const MAX_DOCS = 400;
const MAX_DOC_BYTES = 256 * 1024;

/** Path shape -> what kind of knowledge this is. Deterministic, no model. */
function kindOf(rel) {
  const p = rel.toLowerCase();
  if (/(^|\/)(adr|decisions?|rfc)(\/|$)/.test(p) || /\badr[-_]?\d/.test(p)) return 'adr';
  if (p.includes('glossary')) return 'glossary';
  if (p.includes('convention') || p.includes('style') || p.includes('guideline')) return 'convention';
  if (p.includes('architecture') || p.includes('design')) return 'design';
  return 'note';
}

/** Configured paths win; otherwise the conventional ones that actually exist. */
function sources(root, config = {}) {
  const configured = Array.isArray(config?.knowledge?.paths) ? config.knowledge.paths : null;
  const out = [];
  for (const rel of configured || DEFAULT_DIRS) {
    if (exists(path.join(root, rel))) out.push(...collectFiles(root, rel, { maxDepth: 4, limit: MAX_DOCS }));
  }
  if (!configured) {
    for (const rel of DEFAULT_FILES) if (exists(path.join(root, rel))) out.push(rel);
  }
  return uniq(out.filter((f) => /\.(md|mdx|rst)$/i.test(f)))
    .map(toPosix)
    .sort()
    .slice(0, MAX_DOCS);
}

/** Anything path-shaped the document points at, so staleness is checkable. */
const REF_RE = /(?:`([^`\n]+?)`|\]\(([^)\s]+)\))/g;

function parseDoc(root, rel) {
  const abs = path.join(root, rel);
  const st = statSafe(abs);
  if (!st || st.size > MAX_DOC_BYTES) return null;
  const text = readText(abs);
  if (text === null) return null;

  let title = null;
  const headings = [];
  const refs = new Set();
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (h) {
      if (h[1].length === 1 && !title) title = h[2];
      else if (h[1].length > 1) headings.push(h[2]);
    }
    for (const m of line.matchAll(REF_RE)) {
      const cand = (m[1] || m[2] || '').trim();
      // Only things that look like repo paths — not prose in backticks, not URLs.
      if (/^[\w./-]+\.[a-z0-9]{1,5}$/i.test(cand) && !/^https?:/.test(cand)) refs.add(toPosix(cand));
    }
  }
  return {
    path: rel,
    title: title || rel.split('/').pop().replace(/\.[^.]+$/, ''),
    kind: kindOf(rel),
    headings: headings.slice(0, 20),
    refs: [...refs].slice(0, 30),
    // Git-derived, so it is identical in every clone. mtime is not.
    updatedAt: capture(`git log -1 --format=%cI -- "${rel}"`, { cwd: root, timeout: 20_000 }) || null,
  };
}

/**
 * A document is suspect when it points at a path that no longer exists.
 * Deliberately not time-based: "older than 90 days" would flag a correct
 * decision record and pass a wrong one written yesterday.
 */
function markStale(root, doc) {
  const missing = doc.refs.filter((r) => !exists(path.join(root, r)));
  return missing.length ? { ...doc, staleRefs: missing.slice(0, 5) } : doc;
}

/** Is there any knowledge to read here at all? Cheap: existence checks only. */
export function available(root, config = {}) {
  try {
    const configured = Array.isArray(config?.knowledge?.paths) ? config.knowledge.paths : null;
    for (const rel of configured || DEFAULT_DIRS) if (exists(path.join(root, rel))) return true;
    if (!configured) for (const rel of DEFAULT_FILES) if (exists(path.join(root, rel))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Load the knowledge index, rebuilding when HEAD or the harness moved.
 *
 * `ok: false` means "no wiki here" — a normal, silent state, not an error.
 */
export function load(root, { config = {}, write = true } = {}) {
  try {
    return loadInner(root, config, write);
  } catch (err) {
    return { ok: false, reason: `error: ${err?.message || err}`, docs: [] };
  }
}

function loadInner(root, config, write) {
  const files = sources(root, config);
  if (!files.length) return { ok: false, reason: 'no knowledge sources found', docs: [] };

  const harness = harnessFingerprint();
  const head = capture('git rev-parse HEAD', { cwd: root, timeout: 20_000 }) || 'no-git';
  const cached = readJson(wikiIndexPath(root));
  const fingerprint = files.join('|');

  if (
    cached &&
    cached.wikiVersion === WIKI_VERSION &&
    cached.harness === harness &&
    cached.head === head &&
    cached.fingerprint === fingerprint
  ) {
    return { ok: true, reason: 'hit', docs: cached.docs, status: 'hit' };
  }

  const build = () =>
    files
      .map((rel) => parseDoc(root, rel))
      .filter(Boolean)
      .map((d) => markStale(root, d));

  if (!write) return { ok: true, reason: 'computed', docs: build(), status: 'computed' };

  const res = withLock(wikiLockPath(root), () => {
    const docs = build();
    writeJsonAtomic(wikiIndexPath(root), {
      wikiVersion: WIKI_VERSION,
      harness,
      head,
      fingerprint,
      builtAt: new Date().toISOString(),
      docs,
    });
    return docs;
  });

  return res.ran
    ? { ok: true, reason: 'built', docs: res.value, status: 'built' }
    : { ok: true, reason: 'lock held — computed in memory', docs: build(), status: 'computed' };
}

/**
 * The few documents most likely to explain this task, best first.
 *
 * Reuses `segs` so matching behaves like the rest of the harness. Scoring is
 * intentionally crude: this decides which five pointers to print, not which
 * files to open, so precision here is worth far less than keeping it cheap.
 */
export function match(docs, tokens, cap = 5) {
  if (!tokens.length) return [];
  const scored = docs.map((d) => {
    const titleSegs = segs(d.title);
    const headSegs = new Set(d.headings.flatMap(segs));
    const pathSegs = segs(d.path);
    let score = 0;
    for (const t of tokens) {
      if (titleSegs.includes(t)) score += 5;
      else if (headSegs.has(t)) score += 3;
      else if (pathSegs.includes(t)) score += 2;
    }
    // An ADR exists to record a decision; prefer it over a loose note at a tie.
    if (score && d.kind === 'adr') score += 1;
    return { doc: d, score };
  });
  return scored
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score || a.doc.path.length - b.doc.path.length)
    .slice(0, cap)
    .map((s) => s.doc);
}

/** The `why` block for `context`. Pointers only — never document content. */
export function renderWhy(docs) {
  if (!docs.length) return '';
  const rows = docs.map((d) => [
    '  ' + d.path,
    d.kind,
    d.updatedAt ? d.updatedAt.slice(0, 10) : '',
    d.staleRefs?.length ? `stale? refs ${d.staleRefs[0]} missing` : '',
  ]);
  const width = Math.max(...rows.map((r) => r[0].length));
  return (
    'why    explains intent, not behavior — code wins on conflict:\n' +
    rows.map((r) => `${r[0].padEnd(width)}  ${r[1]}${r[2] ? ' · ' + r[2] : ''}${r[3] ? '  ' + r[3] : ''}`).join('\n')
  );
}

/** Digest for `Y wiki`. */
export function renderWiki(root, res) {
  if (!res.ok) return `wiki   none (${res.reason}) — yindee runs exactly as it does without one`;
  const byKind = {};
  for (const d of res.docs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  const stale = res.docs.filter((d) => d.staleRefs?.length);
  const out = [
    `wiki   ${res.status} · ${res.docs.length} document(s) indexed (headings only, never content)`,
    `kinds  ${Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join('  ')}`,
  ];
  if (stale.length) {
    out.push(`stale? ${stale.length} document(s) reference paths that no longer exist:`);
    for (const d of stale.slice(0, 5)) out.push(`         ${d.path} -> ${d.staleRefs.join(', ')}`);
  }
  out.push(`store  ${toPosix(path.relative(root, wikiDir(root)))}`);
  return out.join('\n');
}

/** Drop the store so the next load rebuilds. */
export function clear(root) {
  const dir = wikiDir(root);
  if (!exists(dir)) return { removed: [] };
  const removed = [];
  for (const e of listDir(dir)) {
    if (!e.isFile()) continue;
    try {
      fs.unlinkSync(path.join(dir, e.name));
      removed.push(e.name);
    } catch {
      /* the next build overwrites it anyway */
    }
  }
  return { removed };
}
