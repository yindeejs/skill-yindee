// Task -> minimum context plan. Answers "which packages, which rules, which
// files do I open" deterministically, so a session never scans the repo to
// find its bearings.
//
// Three things travel with the answer, and each exists to stop a broad search:
// a budget (how much may be opened), an exploration policy (whether searching
// is warranted at all), and reference-repo candidates (a second repo compared
// without loading it).
import path from 'node:path';
import { exists } from './fsx.mjs';
import { uniq, columns, tokenize } from './util.mjs';
import { rulesFor } from './areas.mjs';
import { scoreAreas, scorePackages, fileCandidates } from './candidates.mjs';
import { applyBudget, budgetFor, fmtBudget } from './budget.mjs';
import { assessExploration, renderExploration } from './explore.mjs';
import { queryReferences, renderReferences } from './reference.mjs';
import { match as matchWiki, renderWhy } from './wiki.mjs';

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

  // Repository Intelligence, when the module is on and a usable index exists.
  // `index: null` is the ordinary case, not an error: the ranker then walks the
  // filesystem exactly as it always has.
  const intel = opts.intel ?? null;
  const index = intel?.ok ? intel.files : null;

  // Knowledge Wiki: a separate, capped pointer list. It is computed from its
  // own source and joined to the result at the end — it never touches the
  // candidate ranker, the budget, or the risk tier.
  const why = opts.wiki?.ok ? matchWiki(opts.wiki.docs, tokens) : [];

  // `--limit` predates the budget and still means "at most this many files".
  const limits = budgetFor(map.config || {}, { maxFiles: opts.limit, maxBytes: opts.maxBytes });
  let candidates = fileCandidates(root, map, pkgs, tokens, areas, limits.maxCandidates, { index });
  // A thin answer inside a known scope is what sends a session exploring. When
  // the scope was chosen deliberately, or keywords found almost nothing in one,
  // offer the scope's own source and let the budget do the cutting.
  if (pkgs.length && (explicitPaths.length > 0 || candidates.length < 3)) {
    candidates = fileCandidates(root, map, pkgs, tokens, areas, limits.maxCandidates, { fill: true, index });
  }
  const budget = applyBudget(root, candidates, limits, { batch: opts.batch });

  const ctx = {
    task,
    tokens,
    areas,
    packages: pkgs,
    explicitScope: explicitPaths.length > 0,
    candidates,
    files: budget.selected,
    budget,
    rules: rulesFor(areas),
    localInstructions: localInstructions(root, pkgs),
    // A sibling of `files`, never merged into it. Filtered against the selected
    // files rather than the other way round: the ranker has always been able to
    // surface a markdown file on its own merits, and suppressing that would
    // change file selection. Dropping the duplicate pointer does not.
    why: why.filter((d) => !budget.selected.some((f) => f.file === d.path)),
  };

  // Explicit path scoping is itself a decomposition step, so a phased task does
  // not get re-decomposed on every phase.
  ctx.exploration = assessExploration(root, map, ctx, { skipDecomposition: explicitPaths.length > 0 });

  ctx.references = opts.references?.length
    ? queryReferences(root, opts.references, task, ctx, { cwd: opts.cwd, batch: opts.batch })
    : [];

  return ctx;
}

export function renderContext(ctx, map, skillRoot, opts = {}) {
  // Quiet keeps only what the reader must act on: scope, rules, docs, files,
  // budget, explore. The task echo and the tokenizer's view are debug output.
  const quiet = !!opts.quiet;
  const out = [];
  if (!quiet) {
    out.push(`task   ${ctx.task}`);
    if (ctx.tokens.length) out.push(`tokens ${ctx.tokens.slice(0, 10).join(' ')}`);
  }
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

  out.push('budget ' + fmtBudget(ctx.budget));
  if (!ctx.budget.withinBudget && ctx.budget.deferred.length) {
    out.push(`       next batch: yindee context "${ctx.task}" --batch ${Math.min(ctx.budget.batch + 1, ctx.budget.batches)}`);
  }

  // Human-authored intent, kept visually and structurally apart from `files`:
  // these are never candidates, never budgeted, and never authoritative.
  if (ctx.why?.length) out.push(renderWhy(ctx.why));

  if (ctx.references?.length) out.push(renderReferences(ctx.references));
  if (ctx.exploration) out.push(renderExploration(ctx.exploration));

  if (!quiet) {
    const c = map.commands || {};
    const p = ctx.packages[0]?.pkg;
    const testCmd = p && c.testPkg ? c.testPkg.replace('{pkg}', p.name).replace('{path}', p.path) : c.test;
    if (testCmd) out.push(`cmds   test: ${testCmd}`);
    out.push('next   implement, then: yindee impact  ->  yindee verify');
  }
  return out.join('\n');
}
