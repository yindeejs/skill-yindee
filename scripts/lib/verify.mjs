// Runs a verification plan and reports evidence, not scrollback.
import path from 'node:path';
import { run, have } from './sh.mjs';
import { writeJson, exists } from './fsx.mjs';
import { errorExcerpt, fmtMs, columns } from './util.mjs';

export const resultsPath = (root) => path.join(root, '.claude', 'yindee', 'last-verify.json');

/** First executable token of a shell command, for a cheap availability probe. */
function binaryOf(cmd) {
  const first = cmd.trim().split(/\s+/)[0];
  if (first.startsWith('./') || first.startsWith('.\\')) return null; // repo-local script
  return first;
}

function available(root, cmd) {
  const bin = binaryOf(cmd);
  if (!bin) {
    const rel = cmd.trim().split(/\s+/)[0].replace(/^\.[\\/]/, '');
    return exists(path.join(root, rel)) || exists(path.join(root, rel + '.bat'));
  }
  return have(bin);
}

export function runPlan(root, steps, opts = {}) {
  const { bail = false, timeout, maxLines = 40, onStep } = opts;
  const results = [];
  let failed = false;

  for (const step of steps) {
    if (failed && bail) {
      results.push({ ...step, status: 'skip', reason: 'earlier failure (--bail)', ms: 0 });
      continue;
    }
    if (!available(root, step.cmd)) {
      results.push({ ...step, status: 'skip', reason: `${binaryOf(step.cmd)} not found on PATH`, ms: 0 });
      continue;
    }
    onStep?.(step);
    const r = run(step.cmd, { cwd: root, timeout: timeout ?? 15 * 60 * 1000 });
    const status = r.timedOut ? 'timeout' : r.ok ? 'ok' : 'fail';
    if (status !== 'ok') failed = true;
    results.push({
      ...step,
      status,
      code: r.code,
      ms: r.ms,
      excerpt: status === 'ok' ? '' : errorExcerpt(r.out, maxLines),
    });
  }
  return results;
}

export function saveResults(root, payload) {
  try {
    writeJson(resultsPath(root), payload);
  } catch {
    /* read-only checkout */
  }
}

export function renderResults(results, { tier, totalMs } = {}) {
  const out = [];
  const rows = results.map((r) => [
    r.status === 'ok' ? '  ok  ' : r.status === 'fail' ? '  FAIL' : r.status === 'timeout' ? '  TIME' : '  skip',
    r.id,
    r.status === 'skip' ? `(${r.reason})` : fmtMs(r.ms),
    r.status === 'ok' ? '' : r.cmd,
  ]);
  out.push(columns(rows));

  for (const r of results) {
    if (r.status === 'ok' || r.status === 'skip' || !r.excerpt) continue;
    out.push('');
    out.push(`--- ${r.id} (${r.status}, exit ${r.code}) ---`);
    out.push(r.excerpt);
  }

  const counts = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  const summary =
    `${counts.ok || 0} ok, ${counts.fail || 0} failed` +
    (counts.timeout ? `, ${counts.timeout} timed out` : '') +
    (counts.skip ? `, ${counts.skip} skipped` : '') +
    (totalMs ? `  (${fmtMs(totalMs)})` : '');
  out.push('');
  out.push(`verify ${tier ? `[${tier}] ` : ''}${summary}`);
  const bad = results.filter((r) => r.status === 'fail' || r.status === 'timeout');
  if (bad.length) out.push(`next   fix ${bad.map((r) => r.id).join(', ')} then re-run verify`);
  return out.join('\n');
}
