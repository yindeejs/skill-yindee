// Task -> ranked file candidates. Shared by `context` (the repo being worked
// on) and `reference` (a repo being compared against), so a reference lookup is
// scored by exactly the same deterministic rules as a local one.
import { collectFiles } from './fsx.mjs';
import { list as intelList } from './intel.mjs';
import { lines } from './sh.mjs';
import { uniq, matchAny } from './util.mjs';
import { DEFAULT_AREAS, NON_CODE_AREAS, primaryArea, isGenerated } from './areas.mjs';

export const AREA_KEYWORDS = {
  frontend: ['ui', 'component', 'components', 'page', 'pages', 'screen', 'style', 'styles', 'css', 'button', 'form', 'layout', 'design', 'react', 'vue', 'svelte', 'frontend', 'client', 'web', 'view', 'modal', 'theme', 'responsive', 'render', 'accessibility', 'a11y', 'tailwind'],
  backend: ['api', 'endpoint', 'endpoints', 'route', 'routes', 'handler', 'handlers', 'controller', 'service', 'services', 'server', 'backend', 'rest', 'graphql', 'grpc', 'job', 'jobs', 'worker', 'queue', 'cron', 'request', 'response', 'payload', 'webhook', 'rpc'],
  database: ['db', 'database', 'schema', 'migration', 'migrations', 'migrate', 'table', 'query', 'queries', 'sql', 'model', 'models', 'entity', 'repository', 'seed', 'orm', 'prisma', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongo', 'redis', 'transaction', 'column'],
  security: ['auth', 'authentication', 'authorization', 'login', 'logout', 'signin', 'signup', 'permission', 'permissions', 'role', 'roles', 'rbac', 'token', 'jwt', 'session', 'password', 'secret', 'credential', 'encrypt', 'encryption', 'csrf', 'xss', 'cors', 'security', 'oauth', 'saml', 'tenant', 'audit'],
  infra: ['docker', 'deploy', 'deployment', 'pipeline', 'workflow', 'kubernetes', 'k8s', 'terraform', 'helm', 'release', 'infra', 'observability', 'metrics', 'logging', 'tracing'],
  test: ['test', 'tests', 'spec', 'e2e', 'coverage', 'fixture', 'mock', 'flaky', 'snapshot'],
};

export function scoreAreas(tokens) {
  const scores = {};
  for (const [area, words] of Object.entries(AREA_KEYWORDS)) {
    const hits = tokens.filter((t) => words.includes(t));
    if (hits.length) scores[area] = hits.length;
  }
  return Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([a]) => a);
}

export const segs = (s) => uniq(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

export function scorePackages(map, tokens, areas) {
  const scored = map.packages.map((p) => {
    const nameSegs = segs(p.name);
    const pathSegs = segs(p.path);
    let score = 0;
    const why = [];
    for (const t of tokens) {
      if (nameSegs.includes(t)) {
        score += 6;
        why.push(`name:${t}`);
      } else if (pathSegs.includes(t)) {
        score += 4;
        why.push(`path:${t}`);
      } else if (p.name.toLowerCase().includes(t) || p.path.toLowerCase().includes(t)) {
        score += 2;
        why.push(`~${t}`);
      }
    }
    for (const a of areas) if ((p.areas || []).includes(a)) score += 3;
    return { pkg: p, score, why: uniq(why) };
  });
  const max = Math.max(0, ...scored.map((s) => s.score));
  if (max === 0) return [];
  return scored.filter((s) => s.score >= Math.max(3, max * 0.5)).sort((a, b) => b.score - a.score);
}

/**
 * Content grep for the most distinctive tokens. Longer tokens first — they are
 * rarer, so they buy more signal per grep. Scoped to matched packages and
 * capped, so this stays cheap even on a large repo.
 */
function grepCandidates(root, tokens, scopePaths) {
  const out = new Map();
  const scope = scopePaths.length ? ' -- ' + scopePaths.map((p) => `"${p}"`).join(' ') : '';
  const ranked = [...tokens].filter((t) => t.length >= 4 && /^[a-z0-9]+$/.test(t)).sort((a, b) => b.length - a.length);
  for (const tok of ranked.slice(0, 5)) {
    const found = lines(`git grep -l -I -i -F -e "${tok}"${scope}`, { cwd: root, timeout: 20_000 }).slice(0, 25);
    for (const f of found) out.set(f, (out.get(f) || 0) + 3);
  }
  return out;
}

/** A file that is neither generated nor prose: something a change could touch. */
const isSource = (rel) => !isGenerated(rel) && !NON_CODE_AREAS.has(primaryArea(rel)) && primaryArea(rel) !== 'config';

/**
 * Every file worth considering, best first. The caller decides how many of them
 * a session may actually open — ranking and budgeting are separate jobs, so
 * `context` can report "12 of 34 candidates" instead of silently truncating.
 *
 * `fill` adds the source files of the scoped packages at a low score. It exists
 * because keyword matching answers "which files does this task name", not
 * "which files are in the area I was told to work on" — and a lookup that
 * returns one entry point is a lookup a model will go exploring around. With a
 * scope already established, the budget should decide how much comes back, not
 * the keyword threshold.
 *
 * `index` is the Repository Intelligence file index, when one is available. It
 * replaces the *source of the file list* and nothing else: every weight, the
 * `score >= 4` threshold and the sort below are identical either way. The walk
 * it displaces was capped at depth 6 and 3000 entries, so on a large repo the
 * index does not just avoid work — it sees files the walk could not reach.
 */
export function fileCandidates(root, map, pkgs, tokens, areas, cap = 200, { fill = false, index = null } = {}) {
  const scopePaths = pkgs.length ? pkgs.map((p) => p.pkg.path).filter((p) => p !== '.') : [];
  const scored = new Map();

  const bump = (file, n, tag) => {
    const cur = scored.get(file) || { score: 0, tags: new Set() };
    cur.score += n;
    cur.tags.add(tag);
    scored.set(file, cur);
  };

  // 1. Filename / path token match inside scoped source trees.
  const roots = scopePaths.length ? scopePaths : [''];
  for (const r of roots) {
    const files = index ? intelList(index, r) : collectFiles(root, r, { maxDepth: 6, limit: 3000 });
    for (const f of files) {
      if (/\.(png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip|lock|snap)$/i.test(f)) continue;
      const fileSegs = segs(f.split('/').slice(-2).join('/'));
      let n = 0;
      for (const t of tokens) if (fileSegs.includes(t)) n += 5;
      if (n) bump(f, n, 'name');
      if (n === 0 && areas.length && matchAny(f, areas.flatMap((a) => DEFAULT_AREAS[a] || []))) bump(f, 1, 'area');
      // Only inside a scope someone chose — never across an unscoped repo.
      if (fill && scopePaths.length && isSource(f)) bump(f, 4, 'scope');
    }
  }

  // 2. Content grep, only when the repo is a git repo (fast + index-aware).
  //
  // The index stores declared symbols, and it is tempting to score them here.
  // Deliberately not done: that would make candidate output differ with and
  // without the index, and "the index never changes the scoring" is exactly
  // what makes it safe to have on by default. Symbols and imports are consumed
  // by `impact`, which opts into them explicitly.
  if (map.git?.isRepo) {
    for (const [f, n] of grepCandidates(root, tokens, scopePaths)) bump(f, n, 'content');
  }

  // 3. Entry points of matched packages are always worth a look.
  for (const { pkg } of pkgs) if (pkg.entry) bump(pkg.entry, 4, 'entry');

  return [...scored.entries()]
    .map(([file, v]) => ({ file, score: v.score, tags: [...v.tags].join('+') }))
    .filter((e) => e.score >= 4)
    .sort((a, b) => b.score - a.score || a.file.length - b.file.length)
    .slice(0, cap);
}
