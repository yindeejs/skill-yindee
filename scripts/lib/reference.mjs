// Reference repositories: a second repo read for comparison, never edited.
//
// The point is not to load another repo into the session. It is to run the same
// deterministic candidate selection over there, keep the few files that pair up
// with what the task already selected here, and hand over that short list.
//
// Reference maps are cached inside the *main* repo (`.claude/yindee/refs/`) so
// a reference checkout — which may be read-only, or simply not ours — is never
// written to.
import path from 'node:path';
import { readJson, writeJsonAtomic, exists, findRepoRoot, fingerprint } from './fsx.mjs';
import { buildMap, MAP_VERSION, harnessFingerprint } from './map.mjs';
import { fileCandidates, scoreAreas, scorePackages } from './candidates.mjs';
import { applyBudget, budgetFor, DEFAULT_REFERENCE_BUDGET } from './budget.mjs';
import { sha1, toPosix, uniq, columns, tokenize } from './util.mjs';

export const refsDir = (root) => path.join(root, '.claude', 'yindee', 'refs');
export const refCachePath = (root, refRoot) =>
  path.join(refsDir(root), `${sha1(toPosix(path.resolve(refRoot))).slice(0, 12)}.json`);

/** Resolve a `--reference` spec against the cwd first, then the main repo. */
export function resolveReference(mainRoot, spec, cwd = process.cwd()) {
  const raw = String(spec || '').trim();
  if (!raw) return { spec: raw, available: false, reason: 'empty reference path' };
  const tried = uniq([path.resolve(cwd, raw), path.resolve(mainRoot, raw), path.resolve(raw)]);
  const found = tried.find((p) => exists(p));
  if (!found) {
    return { spec: raw, available: false, reason: `path not found (tried ${tried.map(toPosix).join(', ')})` };
  }
  const root = findRepoRoot(found);
  if (toPosix(path.resolve(root)) === toPosix(path.resolve(mainRoot))) {
    return { spec: raw, available: false, reason: 'reference resolves to the main repository' };
  }
  return { spec: raw, available: true, root, path: toPosix(root), name: path.basename(root) };
}

/**
 * Map a reference repo, caching the result in the main repo. Same invalidation
 * rule as the local map: manifest fingerprint plus harness fingerprint.
 */
export function loadReferenceMap(mainRoot, refRoot, { force = false } = {}) {
  const file = refCachePath(mainRoot, refRoot);
  if (!force) {
    const cached = readJson(file);
    // Same invalidation rule as the local map, harness fingerprint included —
    // otherwise improving detection would leave every reference map stale.
    if (
      cached?.map?.mapVersion === MAP_VERSION &&
      cached.map.harness === harnessFingerprint() &&
      cached.map.manifestFiles
    ) {
      const fp = fingerprint(refRoot, cached.map.manifestFiles);
      if (fp === cached.map.fingerprint) return { map: cached.map, cached: true };
    }
  }
  const map = buildMap(refRoot);
  try {
    writeJsonAtomic(file, { root: toPosix(refRoot), map });
  } catch {
    /* read-only main checkout: still usable in memory */
  }
  return { map, cached: false };
}

/** `Button.stories.tsx` -> `button`. The join key for pairing two repos. */
const stem = (rel) =>
  String(rel)
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * One reference repo, queried for this task.
 * Never throws: an unavailable reference degrades to a note, because the main
 * repo's context is still perfectly usable without it.
 */
export function queryReference(mainRoot, spec, task, mainCtx, opts = {}) {
  const resolved = resolveReference(mainRoot, spec, opts.cwd);
  if (!resolved.available) return { ...resolved, files: [], pairs: [], referenceOnly: [] };

  let map;
  let cached;
  try {
    ({ map, cached } = loadReferenceMap(mainRoot, resolved.root, { force: !!opts.force }));
  } catch (err) {
    return { ...resolved, available: false, reason: `could not map reference: ${err?.message || err}`, files: [], pairs: [], referenceOnly: [] };
  }

  const tokens = mainCtx?.tokens?.length ? mainCtx.tokens : tokenize(task);
  const areas = mainCtx?.areas?.length ? mainCtx.areas : scoreAreas(tokens);
  const pkgs = scorePackages(map, tokens, areas);
  const limits = budgetFor(map.config || {}, opts.limits || {}, DEFAULT_REFERENCE_BUDGET);
  const candidates = fileCandidates(resolved.root, map, pkgs, tokens, areas, limits.maxCandidates);
  const budget = applyBudget(resolved.root, candidates, limits, { batch: opts.batch });

  // Pair by file stem against what the main repo already selected. This is the
  // comparison context: "their X, our X" — no whole-repo diffing involved.
  const mine = new Map();
  for (const f of mainCtx?.files || []) {
    const k = stem(f.file);
    if (!mine.has(k)) mine.set(k, f.file);
  }
  const pairs = [];
  const referenceOnly = [];
  for (const f of budget.selected) {
    const target = mine.get(stem(f.file));
    if (target) pairs.push({ reference: f.file, target });
    else referenceOnly.push(f.file);
  }

  return {
    ...resolved,
    cached,
    map: {
      root: map.root,
      stacks: map.stacks,
      packageManager: map.packageManager,
      packages: map.packages.length,
    },
    packages: pkgs.map((p) => p.pkg.name),
    files: budget.selected,
    budget,
    pairs,
    referenceOnly,
  };
}

export function queryReferences(mainRoot, specs, task, mainCtx, opts = {}) {
  return (specs || []).map((s) => queryReference(mainRoot, s, task, mainCtx, opts));
}

export function renderReferences(refs) {
  const out = [];
  for (const r of refs) {
    if (!r.available) {
      out.push(`ref    ${r.spec}  UNAVAILABLE — ${r.reason}`);
      out.push('       continuing with this repository only');
      continue;
    }
    out.push(
      `ref    ${r.name}  ${r.path}` +
        `  [${r.map.stacks.join('+')}, ${r.map.packages} pkg]  ${r.cached ? 'cached' : 'mapped'}`,
    );
    if (r.pairs.length) {
      out.push('       compare (reference -> here):');
      out.push(columns(r.pairs.map((p) => ['         ' + p.reference, '->', p.target])));
    }
    if (r.referenceOnly.length) {
      out.push('       reference-only: ' + r.referenceOnly.slice(0, 6).join(', ') +
        (r.referenceOnly.length > 6 ? ` … +${r.referenceOnly.length - 6}` : ''));
    }
    if (!r.pairs.length && !r.referenceOnly.length) out.push('       no candidate matched this task in the reference');
  }
  return out.join('\n');
}
