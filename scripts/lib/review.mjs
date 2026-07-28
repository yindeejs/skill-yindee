// Diff-first review bundle: spec + rules + bounded diff + failure evidence.
// Deliberately does NOT read the repository — a review reads the change.
import path from 'node:path';
import { unifiedDiff, diffStat } from './gitx.mjs';
import { readJson, readText, statSafe } from './fsx.mjs';
import { resultsPath } from './verify.mjs';
import { isGenerated, areasOf } from './areas.mjs';
import { uniq } from './util.mjs';

function splitDiffByFile(diff) {
  const out = [];
  let cur = null;
  for (const line of String(diff || '').split(/\r?\n/)) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { file: m[2], lines: [line] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) out.push(cur);
  return out;
}

const BINARY_RE = /\.(png|jpe?g|gif|webp|ico|svgz|woff2?|ttf|eot|pdf|zip|gz|tar|mp4|mp3|wasm|onnx|bin|so|dll|dylib|exe|class|jar)$/i;

/**
 * `git diff` cannot see untracked files, so a brand-new migration or route
 * would silently miss review. Synthesise an added-file block from disk instead.
 */
function untrackedBlocks(root, files, maxPerFile) {
  const out = [];
  for (const f of files) {
    if (f.status !== '??' && f.status !== 'A') continue;
    if (BINARY_RE.test(f.path)) {
      out.push({ file: f.path, lines: [`diff --git a/${f.path} b/${f.path}`, 'new binary file (content not shown)'] });
      continue;
    }
    const st = statSafe(path.join(root, f.path));
    if (!st || !st.isFile()) continue;
    const text = readText(path.join(root, f.path));
    if (text === null || text.includes('\0')) continue;
    const body = text.replace(/\s*$/, '').split(/\r?\n/);
    const shown = body.slice(0, maxPerFile);
    out.push({
      file: f.path,
      lines: [
        `diff --git a/${f.path} b/${f.path}`,
        'new file (untracked)',
        `--- /dev/null`,
        `+++ b/${f.path}`,
        `@@ -0,0 +1,${body.length} @@`,
        ...shown.map((l) => '+' + l),
        ...(body.length > shown.length ? [`... (${body.length - shown.length} more lines in ${f.path})`] : []),
      ],
    });
  }
  return out;
}

const CHECKLISTS = {
  security: [
    'every new route/handler enforces authn AND authz (not just authn)',
    'no secret, token or key added to source, logs or error messages',
    'user input validated server-side; no string-built SQL/commands',
    'authorization checks are server-side, not only in the UI',
  ],
  database: [
    'migration is reversible, or the irreversibility is deliberate and stated',
    'migration is safe on a populated table (locks, defaults, backfill, nullability)',
    'schema change matches the model/type change in the same diff',
    'new query paths have indexes; no N+1 introduced',
  ],
  backend: [
    'errors are handled and typed — no swallowed failures',
    'public API/response shape changes are backward compatible or versioned',
    'no blocking work on the request path that belongs in a job',
  ],
  frontend: [
    'loading, empty and error states exist for new async UI',
    'interactive elements are keyboard reachable and labelled',
    'no server-only secret reaches client bundles',
  ],
  infra: [
    'CI/workflow change does not weaken or skip existing checks',
    'no credentials in workflow/compose/terraform files',
  ],
  test: ['tests assert behaviour, not implementation detail', 'no test weakened or skipped to make CI pass'],
};

export function buildReview(root, map, impact, opts = {}) {
  const maxTotal = opts.maxLines ?? 700;
  const maxPerFile = opts.maxPerFile ?? 140;
  const includeGenerated = !!opts.includeGenerated;

  const raw = unifiedDiff(root, { base: impact.base, context: opts.context ?? 3 });
  const parts = splitDiffByFile(raw);
  const tracked = new Set(parts.map((p) => p.file));
  parts.push(...untrackedBlocks(root, impact.files, maxPerFile).filter((b) => !tracked.has(b.file)));

  const omitted = [];
  const kept = [];
  let total = 0;
  for (const p of parts) {
    if (!includeGenerated && isGenerated(p.file)) {
      omitted.push(`${p.file} (generated)`);
      continue;
    }
    if (total >= maxTotal) {
      omitted.push(`${p.file} (budget)`);
      continue;
    }
    let text = p.lines;
    if (text.length > maxPerFile) {
      text = [...text.slice(0, maxPerFile), `... (${p.lines.length - maxPerFile} more lines in ${p.file})`];
    }
    total += text.length;
    kept.push({ file: p.file, text: text.join('\n') });
  }

  const verify = readJson(resultsPath(root));
  const failures = (verify?.results || []).filter((r) => r.status === 'fail' || r.status === 'timeout');

  const checks = uniq(impact.areas.flatMap((a) => CHECKLISTS[a] || []));
  return { stat: diffStat(root, impact.base), kept, omitted, failures, checks, verify };
}

export function renderReview(review, impact, map, skillRoot) {
  const out = [];
  out.push(`review ${impact.tier.toUpperCase()} change · depth:${impact.reviewDepth} · ${impact.files.length} file(s)` + (impact.base ? ` vs ${impact.base}` : ''));
  if (impact.rules.length) {
    out.push('rules  apply: ' + impact.rules.map((r) => `${skillRoot}/rules/${r}.md`).join(', '));
  }
  if (map.docs.agentInstructions.length) out.push('project ' + map.docs.agentInstructions.join(', ') + ' also apply');

  const byArea = {};
  for (const f of impact.files) {
    const a = areasOf(f.path)[0];
    (byArea[a] ||= []).push(f.path);
  }
  out.push('scope');
  for (const [a, files] of Object.entries(byArea)) {
    out.push(`  ${a}: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` (+${files.length - 8})` : ''}`);
  }
  if (review.stat) {
    out.push('stat');
    out.push(review.stat.split(/\r?\n/).map((l) => '  ' + l).join('\n'));
  }

  if (review.failures.length) {
    out.push('');
    out.push('FAILING EVIDENCE (from last verify — review these first)');
    for (const f of review.failures) {
      out.push(`  ${f.id}: ${f.cmd}`);
      out.push(String(f.excerpt || '').split(/\r?\n/).slice(0, 20).map((l) => '    ' + l).join('\n'));
    }
  }

  if (review.checks.length) {
    out.push('');
    out.push('CHECKLIST (path-scoped)');
    for (const c of review.checks) out.push('  - ' + c);
  }

  out.push('');
  out.push('DIFF');
  if (!review.kept.length) out.push('  (no textual diff — nothing committed or working tree clean)');
  for (const k of review.kept) {
    out.push(k.text);
  }
  if (review.omitted.length) {
    out.push('');
    out.push(`omitted ${review.omitted.length}: ${review.omitted.slice(0, 10).join(', ')}${review.omitted.length > 10 ? ' …' : ''}`);
    out.push('        (re-run with --include-generated or --max-lines N to see them)');
  }
  return out.join('\n');
}
