// Benchmark presentation. Rendering only — every number arrives already
// measured. `unavailable` is a first-class value here: it is printed as
// `unavailable`, never softened into a guess and never back-filled from
// something adjacent (elapsed time, byte counts, Yindee's own estimate).
import { columns, fmtDuration, fmtBytes, fmtCount, pctDelta } from './util.mjs';

const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toTimeString().slice(0, 8);
};

const UNAVAILABLE = 'unavailable';

/** A section header plus its rows, dropped entirely when it has no rows. */
function section(out, title, rows) {
  if (!rows.length) return;
  out.push('');
  out.push(title);
  out.push(columns(rows.map(([k, v]) => [k, v]), 1));
}

export function renderReport(run) {
  const out = [];
  const title = run.label ? `Yindee Benchmark — ${run.label}` : 'Yindee Benchmark';
  out.push(title);
  out.push('─'.repeat(28));

  const head = [
    ['Duration', fmtDuration(run.wallClockDurationMs) + (run.status === 'running' ? ' (in progress)' : '')],
    ['Started', clock(run.startedAt)],
    ['Finished', run.status === 'running' ? '— (session open)' : clock(run.finishedAt)],
  ];
  if (run.status && run.status !== 'completed') head.push(['Status', run.status]);
  head.push(['Run', run.id]);
  out.push(columns(head.map(([k, v]) => [k, v]), 1));

  const est = run.context.estimatedYindeeContextTokens || {};
  section(out, 'Context', [
    ['Yindee context', fmtBytes(run.context.bytes)],
    ['Estimated tokens', `~${fmtCount(est.value ?? 0)} (estimate only — Yindee output, not Claude usage)`],
    ['Files suggested', String(run.context.filesSuggested)],
    ['Files affected', String(run.impact.filesAffected)],
  ]);

  section(out, 'Routing', [
    ['Yindee commands', String(run.commands.total)],
    ['Map runs', String(run.map.runs)],
    ['Cache hits', String(run.map.cacheHits)],
    ['Cache misses', String(run.map.cacheMisses)],
    ['Context runs', String(run.context.runs)],
    ['Impact runs', String(run.impact.runs)],
    ['Review runs', String(run.review.runs)],
  ]);

  section(out, 'Verification', [
    ['Verify runs', String(run.verify.runs)],
    ['Retries', String(run.verify.retries)],
    ['Failures found', String(run.verify.failures)],
    ['Shell commands', String(run.shell.count)],
    ['Shell time', fmtDuration(run.shell.ms)],
  ]);

  const ch = run.changes || {};
  section(
    out,
    'Changes',
    ch.status === 'ok'
      ? [
          ['Files changed', String(ch.filesChanged)],
          ['Lines added', String(ch.linesAdded)],
          ['Lines deleted', String(ch.linesDeleted)],
        ]
      : [
          ['Files changed', UNAVAILABLE],
          ['Lines added', UNAVAILABLE],
          ['Lines deleted', UNAVAILABLE],
          ['Reason', ch.reason || 'not measured'],
        ],
  );

  const t = run.claudeTokenUsage || {};
  section(
    out,
    'Claude usage',
    t.status === 'ok'
      ? [
          ['Input tokens', String(t.inputTokens)],
          ['Output tokens', String(t.outputTokens)],
          ['Cache read tokens', String(t.cacheReadTokens)],
          ['Cache write tokens', String(t.cacheCreationTokens)],
          ['Total tokens', String(t.totalTokens)],
          ['Source', `${t.source} (${t.requests} request${t.requests === 1 ? '' : 's'})`],
        ]
      : [
          ['Input tokens', UNAVAILABLE],
          ['Output tokens', UNAVAILABLE],
          ['Cache tokens', UNAVAILABLE],
          ['Reason', t.reason || 'no runtime telemetry source'],
        ],
  );

  if (run.events?.skipped) {
    out.push('');
    out.push(`note   ${run.events.skipped} unreadable event line(s) were skipped (recovered)`);
  }
  return out.join('\n');
}

// ----------------------------------------------------------------- compare ---

const delta = (a, b) => {
  const pct = pctDelta(a, b);
  const abs = (Number(b) || 0) - (Number(a) || 0);
  return { from: Number(a) || 0, to: Number(b) || 0, absolute: abs, percent: pct };
};

const fmtDelta = (d, format = String) =>
  `${format(d.from)} -> ${format(d.to)}  ` +
  (d.percent === null
    ? '(n/a from zero)'
    : `${d.percent > 0 ? '+' : ''}${d.percent.toFixed(1)}%`);

/**
 * Compare two runs. Token deltas exist only when BOTH runs carry real usage —
 * an estimate is never compared against a measurement, and a measurement is
 * never compared against a missing value.
 */
export function compareRuns(a, b) {
  const cmp = {
    schema: 1,
    a: { id: a.id, label: a.label ?? null, startedAt: a.startedAt },
    b: { id: b.id, label: b.label ?? null, startedAt: b.startedAt },
    duration: delta(a.wallClockDurationMs, b.wallClockDurationMs),
    yindeeContextBytes: delta(a.context.bytes, b.context.bytes),
    // Labelled as an estimate on both sides, and only ever compared like-for-like.
    estimatedYindeeContextTokens: {
      label: 'estimate',
      ...delta(a.context.estimatedYindeeContextTokens?.value, b.context.estimatedYindeeContextTokens?.value),
    },
    filesSuggested: delta(a.context.filesSuggested, b.context.filesSuggested),
    filesAffected: delta(a.impact.filesAffected, b.impact.filesAffected),
    commands: delta(a.commands.total, b.commands.total),
    verification: {
      runs: delta(a.verify.runs, b.verify.runs),
      retries: delta(a.verify.retries, b.verify.retries),
      failures: delta(a.verify.failures, b.verify.failures),
      shellCommands: delta(a.shell.count, b.shell.count),
      shellMs: delta(a.shell.ms, b.shell.ms),
    },
  };

  if (a.changes?.status === 'ok' && b.changes?.status === 'ok') {
    cmp.changes = {
      status: 'ok',
      filesChanged: delta(a.changes.filesChanged, b.changes.filesChanged),
      linesAdded: delta(a.changes.linesAdded, b.changes.linesAdded),
      linesDeleted: delta(a.changes.linesDeleted, b.changes.linesDeleted),
    };
  } else {
    cmp.changes = { status: 'unavailable', reason: 'change measurement missing for at least one run' };
  }

  const ta = a.claudeTokenUsage || {};
  const tb = b.claudeTokenUsage || {};
  if (ta.status === 'ok' && tb.status === 'ok') {
    cmp.claudeTokenUsage = {
      status: 'ok',
      inputTokens: delta(ta.inputTokens, tb.inputTokens),
      outputTokens: delta(ta.outputTokens, tb.outputTokens),
      cacheReadTokens: delta(ta.cacheReadTokens, tb.cacheReadTokens),
      cacheCreationTokens: delta(ta.cacheCreationTokens, tb.cacheCreationTokens),
      totalTokens: delta(ta.totalTokens, tb.totalTokens),
    };
  } else {
    cmp.claudeTokenUsage = {
      status: 'unavailable',
      reason: `actual token usage missing for ${ta.status === 'ok' ? cmp.b.id : cmp.a.id}` +
        (ta.status !== 'ok' && tb.status !== 'ok' ? ' and the other run' : ''),
    };
  }
  return cmp;
}

export function renderCompare(cmp) {
  const out = [];
  out.push(`Yindee Benchmark — compare`);
  out.push('─'.repeat(28));
  out.push(columns([
    ['A', `${cmp.a.id}${cmp.a.label ? `  ${cmp.a.label}` : ''}`],
    ['B', `${cmp.b.id}${cmp.b.label ? `  ${cmp.b.label}` : ''}`],
  ], 1));

  out.push('');
  out.push('Duration');
  out.push(columns([['  wall clock', fmtDelta(cmp.duration, fmtDuration)]], 1));

  out.push('');
  out.push('Context');
  out.push(columns([
    ['  yindee context', fmtDelta(cmp.yindeeContextBytes, fmtBytes)],
    ['  est. tokens', fmtDelta(cmp.estimatedYindeeContextTokens, fmtCount) + '  (estimate vs estimate)'],
    ['  files suggested', fmtDelta(cmp.filesSuggested)],
    ['  files affected', fmtDelta(cmp.filesAffected)],
    ['  yindee commands', fmtDelta(cmp.commands)],
  ], 1));

  out.push('');
  out.push('Verification');
  out.push(columns([
    ['  verify runs', fmtDelta(cmp.verification.runs)],
    ['  retries', fmtDelta(cmp.verification.retries)],
    ['  failures', fmtDelta(cmp.verification.failures)],
    ['  shell commands', fmtDelta(cmp.verification.shellCommands)],
    ['  shell time', fmtDelta(cmp.verification.shellMs, fmtDuration)],
  ], 1));

  out.push('');
  out.push('Changes');
  if (cmp.changes.status === 'ok') {
    out.push(columns([
      ['  files changed', fmtDelta(cmp.changes.filesChanged)],
      ['  lines added', fmtDelta(cmp.changes.linesAdded)],
      ['  lines deleted', fmtDelta(cmp.changes.linesDeleted)],
    ], 1));
  } else {
    out.push(`  ${UNAVAILABLE} — ${cmp.changes.reason}`);
  }

  out.push('');
  out.push('Claude usage');
  if (cmp.claudeTokenUsage.status === 'ok') {
    out.push(columns([
      ['  input tokens', fmtDelta(cmp.claudeTokenUsage.inputTokens, fmtCount)],
      ['  output tokens', fmtDelta(cmp.claudeTokenUsage.outputTokens, fmtCount)],
      ['  cache read', fmtDelta(cmp.claudeTokenUsage.cacheReadTokens, fmtCount)],
      ['  cache write', fmtDelta(cmp.claudeTokenUsage.cacheCreationTokens, fmtCount)],
      ['  total tokens', fmtDelta(cmp.claudeTokenUsage.totalTokens, fmtCount)],
    ], 1));
  } else {
    out.push(`  ${UNAVAILABLE} — ${cmp.claudeTokenUsage.reason}`);
    out.push('  (Yindee context estimates are never compared against actual Claude usage)');
  }
  return out.join('\n');
}
