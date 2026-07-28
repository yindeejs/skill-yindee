// Context budget. Yindee decides how much source a session is allowed to open
// *before* it opens it: candidates are ranked, then packed into batches that fit
// a byte and file ceiling. Over-budget work is split and deferred, never dumped.
//
// The byte figure is the on-disk size of the files Yindee selected — the cost
// the session is about to pay by reading them. It is a measurement of those
// files, not of anyone's context window, and the token figure derived from it
// carries an `estimate` label everywhere it travels.
import path from 'node:path';
import { statSafe } from './fsx.mjs';
import { estimateContextTokens } from './tokens.mjs';

/**
 * Deliberately small. A task that genuinely needs more than this is a task that
 * should have been decomposed — see `explore.decompose`.
 */
export const DEFAULT_BUDGET = {
  maxFiles: 12,
  maxBytes: 96_000,
  /** Hard ceiling on how many candidates are ranked at all. */
  maxCandidates: 200,
};

/** Reference repos get a smaller share: they are read for comparison, not edited. */
export const DEFAULT_REFERENCE_BUDGET = { maxFiles: 6, maxBytes: 48_000, maxCandidates: 200 };

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Resolve limits from defaults <- per-repo config <- explicit flags.
 * Repos override via `.claude/yindee.json`:
 *   { "context": { "maxFiles": 20, "maxBytes": 150000 } }
 */
export function budgetFor(config = {}, overrides = {}, base = DEFAULT_BUDGET) {
  const fromConfig = config.context || {};
  return {
    maxFiles: num(overrides.maxFiles ?? fromConfig.maxFiles, base.maxFiles),
    maxBytes: num(overrides.maxBytes ?? fromConfig.maxBytes, base.maxBytes),
    maxCandidates: num(overrides.maxCandidates ?? fromConfig.maxCandidates, base.maxCandidates),
  };
}

const sizeOf = (root, rel) => {
  const st = statSafe(path.join(root, rel));
  return st && st.isFile() ? st.size : 0;
};

/**
 * Greedy pack of ranked candidates into budget-sized batches.
 *
 * Rank order is preserved — the packer never reorders to fit a smaller file in,
 * because the ranking is the whole point. A single file larger than the byte
 * ceiling still gets a batch of its own: refusing to deliver it would make the
 * budget a way to lose information rather than to order it.
 */
export function applyBudget(root, candidates, limits, { batch = 1 } = {}) {
  const sized = candidates.slice(0, limits.maxCandidates).map((c) => ({ ...c, bytes: sizeOf(root, c.file) }));

  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const c of sized) {
    const wouldExceed = cur.length >= limits.maxFiles || (cur.length > 0 && curBytes + c.bytes > limits.maxBytes);
    if (wouldExceed) {
      batches.push({ files: cur, bytes: curBytes });
      cur = [];
      curBytes = 0;
    }
    cur.push(c);
    curBytes += c.bytes;
  }
  if (cur.length) batches.push({ files: cur, bytes: curBytes });
  if (!batches.length) batches.push({ files: [], bytes: 0 });

  const index = Math.min(Math.max(1, num(batch, 1)), batches.length) - 1;
  const chosen = batches[index];
  const deferred = batches.filter((_, i) => i !== index).flatMap((b) => b.files);
  const truncated = Math.max(0, candidates.length - sized.length);

  return {
    limits,
    candidates: candidates.length,
    ranked: sized.length,
    truncated,
    selected: chosen.files,
    deferred,
    bytes: chosen.bytes,
    totalCandidateBytes: sized.reduce((n, c) => n + c.bytes, 0),
    estimatedTokens: estimateContextTokens(chosen.bytes),
    batch: index + 1,
    batches: batches.length,
    withinBudget: batches.length === 1 && !truncated,
    reason:
      batches.length === 1 && !truncated
        ? 'all candidates fit the budget'
        : chosen.files.length >= limits.maxFiles
          ? `file ceiling (${limits.maxFiles})`
          : `byte ceiling (${limits.maxBytes} B)`,
  };
}

export const fmtBudget = (b) =>
  `${b.selected.length}/${b.candidates} file(s) · ${b.bytes} B · ~${b.estimatedTokens.value} tok (estimate)` +
  (b.withinBudget ? ' · within budget' : ` · batch ${b.batch}/${b.batches}, ${b.deferred.length} deferred (${b.reason})`);
