// Task -> minimum context plan. Answers "which packages, which rules, which
// files do I open" deterministically, so a session never scans the repo to
// find its bearings.
import path from 'node:path';
import { collectFiles, exists } from './fsx.mjs';
import { lines } from './sh.mjs';
import { tokenize, uniq, columns, matchAny } from './util.mjs';
import { DEFAULT_AREAS, rulesFor } from './areas.mjs';

const AREA_KEYWORDS = {
  frontend: ['ui', 'component', 'components', 'page', 'pages', 'screen', 'style', 'styles', 'css', 'button', 'form', 'layout', 'design', 'react', 'vue', 'svelte', 'frontend', 'client', 'web', 'view', 'modal', 'theme', 'responsive', 'render', 'accessibility', 'a11y', 'tailwind'],
  backend: ['api', 'endpoint', 'endpoints', 'route', 'routes', 'handler', 'handlers', 'controller', 'service', 'services', 'server', 'backend', 'rest', 'graphql', 'grpc', 'job', 'jobs', 'worker', 'queue', 'cron', 'request', 'response', 'payload', 'webhook', 'rpc'],
  database: ['db', 'database', 'schema', 'migration', 'migrations', 'migrate', 'table', 'query', 'queries', 'sql', 'model', 'models', 'entity', 'repository', 'seed', 'orm', 'prisma', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongo', 'redis', 'transaction', 'column'],
  security: ['auth', 'authentication', 'authorization', 'login', 'logout', 'signin', 'signup', 'permission', 'permissions', 'role', 'roles', 'rbac', 'token', 'jwt', 'session', 'password', 'secret', 'credential', 'encrypt', 'encryption', 'csrf', 'xss', 'cors', 'security', 'oauth', 'saml', 'tenant', 'audit'],
  infra: ['docker', 'deploy', 'deployment', 'pipeline', 'workflow', 'kubernetes', 'k8s', 'terraform', 'helm', 'release', 'infra', 'observability', 'metrics', 'logging', 'tracing'],
  test: ['test', 'tests', 'spec', 'e2e', 'coverage', 'fixture', 'mock', 'flaky', 'snapshot'],
};

function scoreAreas(tokens) {
  const scores = {};
  for (const [area, words] of Object.entries(AREA_KEYWORDS)) {
    const hits = tokens.filter((t) => words.includes(t));
    if (hits.length) scores[area] = hits.length;
  }
  return Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([a]) => a);
}

const segs = (s) => uniq(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

function scorePackages(map, tokens, areas) {
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

function fileCandidates(root, map, pkgs, tokens, areas, limit) {
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
    for (const f of collectFiles(root, r, { maxDepth: 6, limit: 3000 })) {
      if (/\.(png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip|lock|snap)$/i.test(f)) continue;
      const fileSegs = segs(f.split('/').slice(-2).join('/'));
      let n = 0;
      for (const t of tokens) if (fileSegs.includes(t)) n += 5;
      if (n) bump(f, n, 'name');
      if (n === 0 && areas.length && matchAny(f, areas.flatMap((a) => DEFAULT_AREAS[a] || []))) bump(f, 1, 'area');
    }
  }

  // 2. Content grep, only when the repo is a git repo (fast + index-aware).
  if (map.git.isRepo) {
    for (const [f, n] of grepCandidates(root, tokens, scopePaths)) bump(f, n, 'content');
  }

  // 3. Entry points of matched packages are always worth a look.
  for (const { pkg } of pkgs) if (pkg.entry) bump(pkg.entry, 4, 'entry');

  return [...scored.entries()]
    .map(([file, v]) => ({ file, score: v.score, tags: [...v.tags].join('+') }))
    .filter((e) => e.score >= 4)
    .sort((a, b) => b.score - a.score || a.file.length - b.file.length)
    .slice(0, limit);
}

/** Per-package agent instructions Claude Code will not have auto-loaded. */
function localInstructions(root, pkgs) {
  const out = [];
  for (const { pkg } of pkgs) {
    for (const n of ['CLAUDE.md', 'AGENTS.md']) {
      const rel = pkg.path === '.' ? n : `${pkg.path}/${n}`;
      if (exists(path.join(root, rel))) out.push(rel);
    }
  }
  return uniq(out);
}

export function computeContext(root, map, task, opts = {}) {
  const tokens = tokenize(task);
  const explicitPaths = opts.paths || [];
  let areas = scoreAreas(tokens);

  let pkgs = scorePackages(map, tokens, areas);
  if (explicitPaths.length) {
    const set = new Set(explicitPaths);
    const matched = map.packages.filter((p) =>
      [...set].some((s) => s === p.path || s.startsWith(p.path + '/') || p.path.startsWith(s)),
    );
    if (matched.length) pkgs = matched.map((p) => ({ pkg: p, score: 99, why: ['explicit path'] }));
  }
  if (!pkgs.length && map.packages.length === 1) pkgs = [{ pkg: map.packages[0], score: 1, why: ['only package'] }];

  if (!areas.length) areas = uniq(pkgs.flatMap((p) => p.pkg.areas || []));

  const files = fileCandidates(root, map, pkgs, tokens, areas, opts.limit ?? 12);
  const rules = rulesFor(areas);

  return { task, tokens, areas, packages: pkgs, files, rules, localInstructions: localInstructions(root, pkgs) };
}

export function renderContext(ctx, map, skillRoot, opts = {}) {
  const out = [];
  out.push(`task   ${ctx.task}`);
  if (ctx.tokens.length) out.push(`tokens ${ctx.tokens.slice(0, 10).join(' ')}`);
  out.push(
    `scope  pkgs: ${ctx.packages.length ? ctx.packages.map((p) => p.pkg.name).join(', ') : '(whole repo — narrow the task)'}` +
      `  |  areas: ${ctx.areas.join(', ') || 'unclassified'}`,
  );

  if (ctx.rules.length) {
    out.push('rules  ' + ctx.rules.map((r) => `${skillRoot}/rules/${r}.md`).join('\n       '));
  }

  const docs = [];
  if (map.docs.agentInstructions.length) docs.push(...map.docs.agentInstructions.map((d) => `${d} (project rules)`));
  docs.push(...ctx.localInstructions.map((d) => `${d} (package rules)`));
  if (ctx.areas.length && map.docs.architecture.length && ctx.tokens.some((t) => ['architecture', 'design', 'refactor', 'structure', 'migrate'].includes(t))) {
    docs.push(...map.docs.architecture);
  }
  if (docs.length) out.push('docs   ' + uniq(docs).join('\n       '));

  if (ctx.files.length) {
    out.push('files  open these first:');
    out.push(columns(ctx.files.map((f) => ['  ' + f.file, `(${f.tags})`])));
  } else {
    out.push('files  no confident match — run: yindee context "<more specific task>" or pass --paths');
  }

  const c = map.commands || {};
  const p = ctx.packages[0]?.pkg;
  const testCmd = p && c.testPkg ? c.testPkg.replace('{pkg}', p.name).replace('{path}', p.path) : c.test;
  if (testCmd) out.push(`cmds   test: ${testCmd}`);
  if (!opts.quiet) out.push('next   implement, then: yindee impact  ->  yindee verify');
  return out.join('\n');
}
