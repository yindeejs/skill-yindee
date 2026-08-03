// Builds and caches the project map. Generation is deterministic and cached
// behind a manifest fingerprint, so repeat sessions never re-discover the repo.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect } from './detect.mjs';
import { state as gitState } from './gitx.mjs';
import { areasOf } from './areas.mjs';
import { collectFiles, exists, readJson, writeJson, fingerprint, ensureLocalExclude } from './fsx.mjs';
import { columns, uniq, sha1 } from './util.mjs';

export const MAP_VERSION = 2;
export const mapPath = (root) => path.join(root, '.claude', 'yindee', 'map.json');

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fingerprint of the harness itself. Without it, improving detection logic
 * would leave every already-cached map stale forever.
 */
let harnessFp = null;
export function harnessFingerprint() {
  if (harnessFp === null) {
    const files = ['detect.mjs', 'map.mjs', 'areas.mjs', 'toml.mjs', 'impact.mjs'];
    harnessFp = sha1(`v${MAP_VERSION}|` + fingerprint(LIB_DIR, files));
  }
  return harnessFp;
}

function packageAreas(root, pkg) {
  const files = collectFiles(root, pkg.path === '.' ? '' : pkg.path, { maxDepth: 5, limit: 600 });
  const counts = new Map();
  for (const f of files) {
    for (const a of areasOf(f)) counts.set(a, (counts.get(a) || 0) + 1);
  }
  const ranked = [...counts.entries()]
    .filter(([a]) => !['docs', 'config', 'other'].includes(a))
    .sort((a, b) => b[1] - a[1])
    .map(([a]) => a);
  const primary = pkg.hint === 'frontend' ? uniq(['frontend', ...ranked]) : ranked;
  return { areas: primary.slice(0, 3), fileCount: files.length };
}

const ENTRY_CANDIDATES = [
  'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/main.ts', 'src/main.tsx', 'src/main.js',
  'src/main.rs', 'src/lib.rs', 'main.go', 'cmd/main.go', 'src/app.ts', 'app/page.tsx',
  'src/App.tsx', '__init__.py', 'src/__init__.py', 'main.py', 'app.py', 'index.js', 'mod.ts',
];

function entryFor(root, pkg) {
  const base = pkg.path === '.' ? root : path.join(root, pkg.path);
  const hit = ENTRY_CANDIDATES.find((c) => exists(path.join(base, c)));
  if (!hit) return null;
  return pkg.path === '.' ? hit : `${pkg.path}/${hit}`;
}

export function buildMap(root) {
  const d = detect(root);
  const git = gitState(root);
  const packages = d.packages.map((p) => {
    const { areas, fileCount } = packageAreas(root, p);
    return {
      name: p.name,
      path: p.path,
      stack: p.stack,
      kind: p.kind,
      manifest: p.manifest,
      areas,
      files: fileCount,
      deps: p.deps,
      dependents: p.dependents,
      tests: p.tests,
      entry: entryFor(root, p),
      ...(p.typescript ? { typescript: true } : {}),
      ...(p.scripts && Object.keys(p.scripts).length ? { scripts: Object.keys(p.scripts) } : {}),
    };
  });

  return {
    mapVersion: MAP_VERSION,
    harness: harnessFingerprint(),
    root: path.basename(root),
    fingerprint: fingerprint(root, d.manifestFiles),
    manifestFiles: d.manifestFiles,
    stacks: d.stacks,
    // Declared, not inferred: `init` reports these and never guesses beyond them.
    frameworks: d.frameworks,
    typescript: d.typescript,
    packageManager: d.packageManager,
    monorepo: d.monorepo,
    packages,
    commands: d.commands,
    affected: d.affected,
    ci: d.ci,
    docs: d.docs,
    git: {
      isRepo: git.isRepo,
      branch: git.branch ?? null,
      base: git.base ?? null,
      remote: git.remote?.slug ?? null,
      host: git.remote?.host ?? null,
    },
    // The overrides travel with the map: `impact` classifies areas and
    // sensitivity from it, and it only ever sees the map. Dropping this here is
    // what made `areas`/`sensitive` in .claude/yindee.json silently inert.
    config: d.config,
    configPresent: Object.keys(d.config).length > 0,
  };
}

/**
 * Load the cached map, rebuilding only when the manifest fingerprint moved.
 * Returns { map, cached }.
 */
export function loadMap(root, { force = false, write = true } = {}) {
  const file = mapPath(root);
  if (!force) {
    const cached = readJson(file);
    if (cached && cached.mapVersion === MAP_VERSION && cached.harness === harnessFingerprint() && cached.manifestFiles) {
      const fp = fingerprint(root, cached.manifestFiles);
      if (fp === cached.fingerprint) return { map: cached, cached: true };
    }
  }
  const map = buildMap(root);
  if (write) {
    try {
      writeJson(file, map);
      ensureLocalExclude(root);
    } catch {
      /* read-only checkout: still usable in memory */
    }
  }
  return { map, cached: false };
}

const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

/** Compact human/LLM digest — this is what agents read, not the JSON. */
export function renderMap(map, { verbose = false, quiet = false } = {}) {
  const cap = verbose ? 500 : quiet ? 12 : 40;
  const out = [];
  const g = map.git;
  out.push(
    `repo   ${map.root}` +
      (g.isRepo ? `  git:${g.branch}${g.base && g.base !== g.branch ? ` (base ${g.base})` : ''}` : '  (no git)') +
      (g.remote ? `  ${g.host}:${g.remote}` : ''),
  );
  out.push(
    `stack  ${map.stacks.join('+')}${map.typescript ? '+ts' : ''} | pm ${map.packageManager}` +
      (map.frameworks?.length ? ` | ${map.frameworks.join(',')}` : '') +
      (map.monorepo.tool ? ` | ${map.monorepo.tool}` : '') +
      ` | ${map.packages.length} package${map.packages.length === 1 ? '' : 's'}`,
  );

  if (map.packages.length) {
    out.push('pkgs');
    const rows = map.packages
      .slice(0, cap)
      .map((p) => [
        '  ' + short(p.name, 28),
        p.path,
        p.kind,
        (p.areas || []).join(',') || '-',
        // Dependency edges are what `context`/`impact` consume; a human reading
        // the map rarely needs them, so quiet drops the column.
        quiet || !p.deps.length ? '' : '-> ' + p.deps.slice(0, 4).join(',') + (p.deps.length > 4 ? ',…' : ''),
      ]);
    out.push(columns(rows));
    if (map.packages.length > cap) out.push(`  … ${map.packages.length - cap} more (--verbose)`);
  }

  const cmdKeys = ['fmtCheck', 'lint', 'typecheck', 'test', 'build'];
  const cmds = cmdKeys.filter((k) => map.commands[k]).map((k) => `${k}: ${map.commands[k]}`);
  if (cmds.length) out.push('cmds   ' + cmds.join('\n       '));
  // Per-package forms only mean something in a workspace.
  const scoped = map.monorepo.isMonorepo ? ['lintPkg', 'typecheckPkg', 'testPkg'].filter((k) => map.commands[k]) : [];
  if (scoped.length) out.push('scoped ' + scoped.map((k) => `${k}: ${map.commands[k]}`).join('\n       '));
  if (map.affected) out.push('affect ' + Object.entries(map.affected).map(([k, v]) => `${k}: ${v}`).join('\n       '));

  if (map.ci.provider) {
    out.push(`ci     ${map.ci.provider}: ${map.ci.files.map((f) => f.split('/').pop()).join(', ')}` + (map.ci.jobs.length ? ` [${map.ci.jobs.join(', ')}]` : ''));
  }

  const docs = [];
  if (map.docs.agentInstructions.length) docs.push(...map.docs.agentInstructions);
  if (map.docs.architecture.length) docs.push(...map.docs.architecture);
  if (map.docs.readme) docs.push(map.docs.readme);
  if (map.docs.docsDir) docs.push(`${map.docs.docsDir}/ (${map.docs.docFiles.length})`);
  if (docs.length) out.push('docs   ' + docs.join(' '));

  return out.join('\n');
}
