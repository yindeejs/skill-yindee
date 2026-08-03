// Change-impact detection: git diff -> packages -> dependents -> risk tier ->
// concrete verification plan. Pure computation over the map and git; no LLM.
import { changedFiles } from './gitx.mjs';
import { areasOf, isSensitive, isGenerated, isLockfile, rulesFor, NON_CODE_AREAS } from './areas.mjs';
import { fileDependents } from './intel.mjs';
import { columns, uniq } from './util.mjs';

export const TIERS = ['docs', 'standard', 'broad', 'critical'];

/** Longest-prefix match of a file onto a workspace package. */
export function packageOf(map, file) {
  let best = null;
  for (const p of map.packages) {
    if (p.path === '.') {
      if (!best) best = p;
      continue;
    }
    if (file === p.path || file.startsWith(p.path + '/')) {
      if (!best || best.path === '.' || p.path.length > best.path.length) best = p;
    }
  }
  return best;
}

/** Transitive closure over `dependents`: everything that can break. */
function withDependents(map, names) {
  const byName = new Map(map.packages.map((p) => [p.name, p]));
  const seen = new Set(names);
  const queue = [...names];
  while (queue.length) {
    const cur = byName.get(queue.shift());
    for (const d of cur?.dependents || []) {
      if (!seen.has(d)) {
        seen.add(d);
        queue.push(d);
      }
    }
  }
  return [...seen];
}

function classify(map, files, config) {
  const areas = uniq(files.flatMap((f) => areasOf(f.path, config)));
  const sensitive = files.filter((f) => isSensitive(f.path, config)).map((f) => f.path);
  const manifests = files.filter((f) => map.manifestFiles.includes(f.path) || isLockfile(f.path)).map((f) => f.path);
  const codeFiles = files.filter((f) => !areasOf(f.path, config).every((a) => NON_CODE_AREAS.has(a)));

  const reasons = [];
  let tier = 'standard';

  if (!files.length) {
    tier = 'docs';
    reasons.push('no changes detected');
  } else if (!codeFiles.length) {
    tier = 'docs';
    reasons.push('documentation only');
  } else if (sensitive.length) {
    tier = 'critical';
    reasons.push(`sensitive paths: ${uniq(sensitive.slice(0, 4)).join(', ')}${sensitive.length > 4 ? ` (+${sensitive.length - 4})` : ''}`);
  }
  return { areas, sensitive, manifests, codeFiles, tier, reasons };
}

/** Substitute {pkg}/{path}/{base} placeholders in a command template. */
const fill = (tpl, vars) => tpl.replace(/\{(pkg|path|base)\}/g, (_, k) => vars[k] ?? '');

function planFor(map, tier, pkgs, base) {
  const c = map.commands || {};
  const steps = [];
  const push = (id, cmd, why) => {
    if (cmd && !steps.some((s) => s.cmd === cmd)) steps.push({ id, cmd, why });
  };

  if (tier === 'docs') return steps;

  const scoped = tier === 'standard' && pkgs.length && pkgs.length <= 3 && map.monorepo.isMonorepo;

  if (tier === 'critical' && c.fmtCheck) push('fmt', c.fmtCheck, 'sensitive change');

  if (scoped) {
    for (const p of pkgs) {
      const vars = { pkg: p.name, path: p.path, base };
      if (c.lintPkg) push(`lint:${p.name}`, fill(c.lintPkg, vars), `lint ${p.name}`);
      if (c.typecheckPkg) push(`typecheck:${p.name}`, fill(c.typecheckPkg, vars), `typecheck ${p.name}`);
      else if (c.typecheck && !c.typecheckPkg) push('typecheck', c.typecheck, 'no per-package typecheck available');
      if (c.testPkg) push(`test:${p.name}`, fill(c.testPkg, vars), `tests for ${p.name}`);
    }
    if (!steps.length) {
      if (c.lint) push('lint', c.lint, 'no scoped command available');
      if (c.typecheck) push('typecheck', c.typecheck, 'no scoped command available');
      if (c.test) push('test', c.test, 'no scoped command available');
    }
    return steps;
  }

  if (tier === 'standard' && !map.monorepo.isMonorepo) {
    // Single-package repo: the repo-wide commands already are the targeted
    // scope. Workspace-filtered forms would name a workspace that isn't there.
    if (c.lint) push('lint', c.lint, 'lint');
    if (c.typecheck) push('typecheck', c.typecheck, 'typecheck');
    if (c.test) push('test', c.test, 'tests');
    return steps;
  }

  // broad / critical -> workspace-wide, preferring the build system's own
  // affected-graph when it has one.
  if (tier === 'broad' && map.affected && base) {
    for (const key of ['lint', 'typecheck', 'test', 'build']) {
      if (map.affected[key]) push(key, fill(map.affected[key], { base }), `affected ${key}`);
    }
    if (steps.length) return steps;
  }

  if (c.lint) push('lint', c.lint, 'workspace lint');
  if (c.typecheck) push('typecheck', c.typecheck, 'workspace typecheck');
  if (c.test) push('test', c.test, 'workspace tests');
  if (tier === 'critical' && c.build) push('build', c.build, 'full build');
  return steps;
}

export function computeImpact(root, map, opts = {}) {
  const config = map.config || opts.config || {};
  const changed = changedFiles(root, { mode: opts.mode || 'auto', base: opts.base || null });
  const base = opts.base || changed.base || map.git.base || null;

  const files = (opts.paths?.length ? opts.paths.map((p) => ({ path: p, status: 'M' })) : changed.files).filter(
    (f) => opts.includeGenerated || !isGenerated(f.path) || isLockfile(f.path),
  );

  const cls = classify(map, files, config);

  // Which packages the change lands in, then everything downstream of them.
  const direct = uniq(files.map((f) => packageOf(map, f.path)).filter(Boolean).map((p) => p.name));
  const affectedNames = withDependents(map, direct);
  const byName = new Map(map.packages.map((p) => [p.name, p]));
  const directPkgs = direct.map((n) => byName.get(n)).filter(Boolean);
  const affectedPkgs = affectedNames.map((n) => byName.get(n)).filter(Boolean);

  let tier = cls.tier;
  const reasons = [...cls.reasons];
  if (tier === 'standard') {
    const crossLayer = cls.areas.includes('frontend') && cls.areas.includes('backend');
    const shared = directPkgs.some((p) => (p.dependents || []).length >= 2);
    if (affectedPkgs.length >= 3) {
      tier = 'broad';
      reasons.push(`${affectedPkgs.length} packages affected`);
    } else if (shared) {
      tier = 'broad';
      reasons.push('shared package with 2+ dependents');
    } else if (crossLayer) {
      tier = 'broad';
      reasons.push('cross-layer change (frontend + backend)');
    } else if (cls.manifests.length) {
      tier = 'broad';
      reasons.push(`dependency/manifest change: ${cls.manifests.slice(0, 3).join(', ')}`);
    } else {
      reasons.push(`${directPkgs.length || 1} package, ${cls.codeFiles.length} code file(s)`);
    }
  }
  if (opts.tier && TIERS.includes(opts.tier)) {
    reasons.push(`tier forced to ${opts.tier} (was ${tier})`);
    tier = opts.tier;
  }

  const verifyPkgs = tier === 'standard' ? directPkgs : affectedPkgs;
  const steps = planFor(map, tier, verifyPkgs, base);

  return {
    base,
    sources: changed.sources,
    files,
    areas: cls.areas,
    sensitive: cls.sensitive,
    manifests: cls.manifests,
    tier,
    reasons,
    packages: { direct, affected: affectedNames },
    // Additive only. It informs what to look at; it never feeds the tier or the
    // verify plan, both of which are decided above from paths and packages.
    fileDependents: opts.intel?.ok ? fileDependents(opts.intel.files, files.map((f) => f.path)) : [],
    rules: rulesFor(cls.areas),
    steps,
    reviewDepth: tier === 'critical' ? 'deep' : tier === 'broad' ? 'standard' : 'light',
  };
}

export function renderImpact(impact, { verbose = false, quiet = false } = {}) {
  const out = [];
  out.push(
    `tier   ${impact.tier.toUpperCase()}  (${impact.reasons.join('; ') || 'no reason recorded'})` +
      `  review:${impact.reviewDepth}`,
  );
  out.push(
    `change ${impact.files.length} file(s)` +
      (impact.base ? ` vs ${impact.base}` : '') +
      (impact.sources.length ? ` [${impact.sources.join(' + ')}]` : ' [clean tree]'),
  );
  if (impact.areas.length) out.push(`areas  ${impact.areas.join(', ')}`);
  if (impact.packages.direct.length) {
    const extra = impact.packages.affected.filter((n) => !impact.packages.direct.includes(n));
    out.push(`pkgs   ${impact.packages.direct.join(', ')}` + (extra.length ? `  +dependents: ${extra.join(', ')}` : ''));
  }
  if (impact.sensitive.length) out.push(`!!     sensitive: ${uniq(impact.sensitive).slice(0, 8).join(', ')}`);
  if (impact.fileDependents?.length) {
    const show = verbose ? impact.fileDependents : impact.fileDependents.slice(0, quiet ? 6 : 12);
    out.push(
      `imports ${impact.fileDependents.length} file(s) may import what changed (name match, not resolution):`,
    );
    out.push(columns(show.map((f) => ['  ' + f])));
    if (impact.fileDependents.length > show.length) {
      out.push(`  … ${impact.fileDependents.length - show.length} more (--verbose)`);
    }
  }

  const show = verbose ? impact.files : impact.files.slice(0, quiet ? 10 : 25);
  if (show.length) {
    out.push('files');
    out.push(columns(show.map((f) => ['  ' + f.status, f.path, areasOf(f.path).slice(0, 2).join(',')])));
    if (impact.files.length > show.length) out.push(`  … ${impact.files.length - show.length} more (--verbose)`);
  }

  if (impact.rules.length) out.push(`rules  ${impact.rules.join(', ')}`);
  out.push('verify');
  if (!impact.steps.length) out.push('  (nothing to run at this tier)');
  else out.push(columns(impact.steps.map((s) => ['  ' + s.id, s.cmd])));
  return out.join('\n');
}
