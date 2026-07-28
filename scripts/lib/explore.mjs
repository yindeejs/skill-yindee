// Exploration policy. Decides how much *searching* a task is allowed to buy,
// given what Yindee already answered deterministically.
//
// The rule this file exists to enforce: task breadth does not justify repository
// breadth. A big task is decomposed into areas that each get their own cheap,
// scoped lookup — it is never answered by pointing a broad agent at the repo.
import { collectFiles } from './fsx.mjs';
import { uniq, columns } from './util.mjs';
import { NON_CODE_AREAS, primaryArea, isGenerated } from './areas.mjs';

/**
 * none      Yindee named the files; open them and start working.
 * targeted  one path-scoped search inside a scope Yindee already narrowed.
 * semantic  one search for meaning that filenames and grep cannot express.
 * broad     repository-wide discovery. Never recommended — it is what this
 *           policy exists to prevent, and it requires a written justification.
 */
export const LEVELS = ['none', 'targeted', 'semantic', 'broad'];

export const BROAD_REQUIREMENT =
  'Broad exploration requires a written reason of the form: ' +
  '"Yindee deterministic retrieval insufficient because …". Task size is not such a reason.';

/** Meaning-shaped asks: what filenames and a literal grep cannot answer. */
const SEMANTIC_HINTS = [
  'why', 'how does', 'how is', 'understand', 'investigate', 'root cause', 'trace',
  'unused', 'dead code', 'duplicate', 'duplicated', 'inconsistent', 'convention',
  'pattern', 'anywhere', 'everywhere', 'all usages', 'callers', 'who calls',
];

/** Size-shaped asks. These raise decomposition, never exploration. */
const BREADTH_HINTS = [
  'entire', 'whole', 'all of', 'every ', 'across the', 'codebase', 'repository-wide',
  'modernize', 'modernise', 'migrate', 'migration of', 'overhaul', 'rewrite', 'redesign',
  'revamp', 'refresh the', 'standardize', 'standardise', 'unify', 'harmonize', 'harmonise',
  'audit', 'sweep', 'library', 'design system', 'refactor all',
];

const hits = (task, list) => list.filter((h) => task.includes(h));

/** Dependency depth: 0 for a package with no internal deps. Leaves come first. */
function depthOf(map, name, seen = new Set()) {
  if (seen.has(name)) return 0;
  seen.add(name);
  const pkg = map.packages.find((p) => p.name === name);
  if (!pkg || !pkg.deps?.length) return 0;
  return 1 + Math.max(...pkg.deps.map((d) => depthOf(map, d, seen)));
}

/**
 * The matched packages plus everything they depend on, internally.
 *
 * Keyword scoring finds the packages a task *names*; a broad task also owns the
 * foundations underneath them. "Modernise the component library" has to include
 * the token package the components import, even though nothing in the wording
 * points at it — otherwise phase 1 rebuilds on top of the old foundation.
 */
function closureOf(map, seeds) {
  const byName = new Map(map.packages.map((p) => [p.name, p]));
  const out = new Map(seeds.map((p) => [p.name, p]));
  const queue = [...seeds];
  while (queue.length) {
    for (const dep of queue.shift().deps || []) {
      const pkg = byName.get(dep);
      if (!pkg || out.has(dep)) continue;
      out.set(dep, pkg);
      queue.push(pkg);
    }
  }
  return [...out.values()];
}

/**
 * Break a broad task into ordered areas, each small enough for one cheap
 * `context` lookup.
 *
 * Ordering is deterministic and generic — foundations before surface:
 *   · several packages -> dependency depth ascending (a package everything
 *     depends on is phase 1; the app that consumes them is last)
 *   · one package -> its source directories, shallowest and smallest first
 * Nothing here knows what a design token or a form component is; the shape of
 * the repo decides the order.
 */
export function decompose(root, map, ctx, { maxPhases = 8 } = {}) {
  const seeds = ctx.packages.map((p) => p.pkg);
  // An explicit `--paths` is already a decomposition decision; widening it to
  // the dependency closure would undo the caller's scoping.
  const scope = seeds.length ? (ctx.explicitScope ? seeds : closureOf(map, seeds)) : map.packages;
  const task = ctx.task;

  let groups;
  if (scope.length > 1) {
    groups = scope
      .map((p) => ({ title: p.name, paths: [p.path], sort: [depthOf(map, p.name), p.files || 0, p.name] }))
      .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || String(a.sort[2]).localeCompare(String(b.sort[2])));
  } else {
    const pkg = scope[0];
    if (!pkg) return [];
    const base = pkg.path === '.' ? '' : pkg.path;
    const byDir = new Map();
    for (const f of collectFiles(root, base, { maxDepth: 4, limit: 2000 })) {
      // Generated output and the vendored harness are not areas of the project.
      if (isGenerated(f)) continue;
      const area = primaryArea(f);
      if (NON_CODE_AREAS.has(area) || area === 'config') continue;
      const rel = base ? f.slice(base.length + 1) : f;
      const parts = rel.split('/');
      // Group one level below a conventional source root, so `src/components`
      // and `src/theme` are separate phases while `src` alone is not one phase.
      const depth = ['src', 'lib', 'app', 'source'].includes(parts[0]) ? 2 : 1;
      const dir = parts.slice(0, Math.min(depth, Math.max(1, parts.length - 1))).join('/');
      const key = base ? `${base}/${dir}` : dir;
      const cur = byDir.get(key) || { files: 0, depth: dir.split('/').length };
      cur.files++;
      byDir.set(key, cur);
    }
    groups = [...byDir.entries()]
      .map(([dir, v]) => ({ title: dir, paths: [dir], sort: [v.depth, v.files, dir] }))
      .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || String(a.sort[2]).localeCompare(String(b.sort[2])));
  }

  if (groups.length < 2) return [];

  const head = groups.slice(0, maxPhases - 1);
  const tail = groups.slice(maxPhases - 1);
  const phases = head.map((g, i) => ({
    n: i + 1,
    title: g.title,
    paths: g.paths,
    command: `yindee context "${task}" --paths ${g.paths.join(',')}`,
  }));
  if (tail.length) {
    const paths = tail.flatMap((g) => g.paths);
    phases.push({
      n: phases.length + 1,
      title: `remaining (${tail.length})`,
      paths,
      command: `yindee context "${task}" --paths ${paths.slice(0, 6).join(',')}`,
    });
  }
  return phases;
}

/**
 * What kind of searching this task is allowed to buy.
 *
 * Reads only what Yindee already computed — the context result and the map — so
 * the answer costs nothing beyond the lookup that produced them.
 */
export function assessExploration(root, map, ctx, opts = {}) {
  const task = String(ctx.task || '').toLowerCase();
  const semanticHits = hits(task, SEMANTIC_HINTS);
  const breadthHits = hits(task, BREADTH_HINTS);
  const scoped = ctx.packages.map((p) => p.pkg.path).filter(Boolean);
  const named = ctx.files.length;
  const broadByScope = ctx.packages.length >= 3;
  const breadth = breadthHits.length || broadByScope ? 'broad' : 'narrow';

  const reasons = [];
  let level = 'none';

  if (named > 0) {
    reasons.push(`yindee named ${named} file(s) deterministically`);
  } else if (ctx.packages.length) {
    level = 'targeted';
    reasons.push(`no file matched, but scope is known: ${scoped.join(', ') || 'repo root'}`);
  } else {
    level = map.git?.isRepo ? 'targeted' : 'semantic';
    reasons.push(
      map.git?.isRepo
        ? 'no package or file matched — search the mapped source roots, path-scoped'
        : 'no package or file matched and content grep is unavailable (not a git repo)',
    );
  }

  if (semanticHits.length && level !== 'semantic') {
    level = level === 'none' ? 'targeted' : 'semantic';
    reasons.push(`task asks for meaning, not names (${semanticHits.slice(0, 2).join(', ')})`);
  }

  if (breadth === 'broad') {
    reasons.push(
      breadthHits.length
        ? `broad task (${breadthHits.slice(0, 2).join(', ')}) — decomposed, not explored`
        : `${ctx.packages.length} packages in scope — decomposed, not explored`,
    );
  }

  const decomposition = breadth === 'broad' && !opts.skipDecomposition ? decompose(root, map, ctx, opts) : [];
  // A decomposed task never needs a wider search: each phase re-scopes itself.
  if (decomposition.length && level === 'semantic') level = 'targeted';

  const scope = scoped.length ? scoped : uniq(map.packages.map((p) => p.path));
  return {
    level,
    breadth,
    reasons,
    scope,
    maxAgents: level === 'none' ? 0 : 1,
    parallel: false,
    allowBroad: false,
    requirement: BROAD_REQUIREMENT,
    decomposition,
    // What an agent, if one is spawned at all, must be constrained to.
    agentBrief:
      level === 'none'
        ? null
        : `one ${level} search, path-scoped to ${scope.slice(0, 6).join(', ') || 'the mapped source roots'}; ` +
          'do not re-derive repository structure — it is in `yindee map`.',
  };
}

export function renderExploration(policy) {
  const out = [];
  out.push(`explore ${policy.level.toUpperCase()}  (${policy.reasons.join('; ')})`);
  if (policy.level === 'none') {
    out.push('        no agent needed — open the files above');
  } else {
    out.push(`        ${policy.maxAgents} agent max, sequential, scoped: ${policy.scope.slice(0, 6).join(', ') || '(repo root)'}`);
  }
  // Stated whenever the temptation exists: any search at all, or a task whose
  // size invites one.
  if (policy.level !== 'none' || policy.breadth === 'broad') {
    out.push(`        broad exploration NOT permitted. ${policy.requirement}`);
  }
  if (policy.decomposition.length) {
    out.push(`phases  broad task -> ${policy.decomposition.length} area(s); do one per pass, verify between:`);
    out.push(columns(policy.decomposition.map((p) => [`  ${p.n}.`, p.title, p.paths.slice(0, 3).join(',')])));
  }
  return out.join('\n');
}
