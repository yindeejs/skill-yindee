#!/usr/bin/env node
// Benchmark: "modernise this UI library using that reference design system,
// preserving the public API" — the task that produced three broad Explore
// agents in the field.
//
// It measures two things and never mixes them up:
//
//   sweep    what a whole-repository exploration has to read: every source file
//            in BOTH repos, counted and sized on disk. This is a property of the
//            repositories, measured here — it is NOT an observed agent run and
//            it is NOT a token count.
//   yindee   what the harness actually routed: real CLI invocations under a real
//            telemetry session, reported from `benchmark stop`.
//
// Claude token usage is deliberately NOT inherited from the session that runs
// this script: the child processes get an empty CLAUDE_CODE_SESSION_ID, so the
// report says `unavailable` rather than billing this benchmark for tokens that
// belong to the surrounding conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeComponentLibrary, makeReferenceDesignSystem, hasGit } from '../tests/fixtures/two-repo.mjs';
import { collectFiles } from '../scripts/lib/fsx.mjs';
import { isGenerated, NON_CODE_AREAS, primaryArea } from '../scripts/lib/areas.mjs';
import { columns, fmtBytes, fmtDuration, fmtCount, pctDelta } from '../scripts/lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'scripts', 'yindee.mjs');
const JSON_OUT = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');

const TASK = 'modernize this UI library using the reference design system while preserving all public APIs';

const log = (s = '') => {
  if (!JSON_OUT) process.stdout.write(s + '\n');
};

const ratio = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a');

/** Run the real CLI, with no inherited Claude session. */
function cli(root, args) {
  return execFileSync(process.execPath, [CLI, ...args, '--repo', root], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' },
  });
}
const cliJson = (root, args) => JSON.parse(cli(root, [...args, '--json']));

/**
 * The bound a whole-repository sweep has to pay: every non-generated source
 * file in a repo, with its size on disk.
 */
function sweepCost(root) {
  let files = 0;
  let bytes = 0;
  for (const rel of collectFiles(root, '', { maxDepth: 8, limit: 20_000 })) {
    if (isGenerated(rel) || rel.startsWith('.git/')) continue;
    const area = primaryArea(rel);
    if (NON_CODE_AREAS.has(area)) continue;
    let st;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      continue;
    }
    files++;
    bytes += st.size;
  }
  return { files, bytes };
}

// ------------------------------------------------------------------- run ---

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yindee-bench-'));
const LIB = path.join(TMP, 'kairo-ui');
const REF = path.join(TMP, 'nongmuek-ref');

try {
  makeComponentLibrary(LIB);
  makeReferenceDesignSystem(REF);

  const sweep = {
    main: sweepCost(LIB),
    reference: sweepCost(REF),
  };
  sweep.total = {
    files: sweep.main.files + sweep.reference.files,
    bytes: sweep.main.bytes + sweep.reference.bytes,
  };

  // --- the routed run, under a real telemetry session -----------------------
  cli(LIB, ['benchmark', 'start', '--label', 'two-repo modernization', '--restart']);

  const init = cliJson(LIB, ['init']);
  const initAgain = cliJson(LIB, ['init']);

  const ctx = cliJson(LIB, ['context', TASK, '--reference', REF]);

  // Every phase the policy produced, routed the way the router says to route it.
  // Phases are *work*, not discovery: each is a separate pass, so they are
  // measured per lookup and deduped into a union — never summed against a
  // one-shot repository sweep.
  const union = new Map();
  const noteSelection = (repo, files) => {
    for (const f of files || []) union.set(`${repo}:${f.file}`, f.bytes || 0);
  };
  noteSelection('main', ctx.files);
  for (const r of ctx.references) noteSelection(r.name || 'ref', r.files);

  const phases = [];
  for (const phase of ctx.exploration.decomposition) {
    const p = cliJson(LIB, ['context', TASK, '--paths', phase.paths.join(',')]);
    noteSelection('main', p.files);
    phases.push({
      title: phase.title,
      paths: phase.paths,
      candidates: p.budget.candidates,
      selected: p.files.length,
      bytes: p.budget.bytes,
      batches: p.budget.batches,
      exploration: p.exploration.level,
    });
  }

  cliJson(LIB, ['impact']);
  cliJson(LIB, ['verify', '--dry-run']);

  const run = cliJson(LIB, ['benchmark', 'stop']);

  // --- discovery: the one comparison that is apples-to-apples ---------------
  // A broad sweep is a discovery act; so is the first `context` call. Comparing
  // those two answers the question this benchmark exists to ask.
  const discovery = {
    files: ctx.files.length + ctx.references.reduce((n, r) => n + (r.files?.length || 0), 0),
    bytes: ctx.budget.bytes + ctx.references.reduce((n, r) => n + (r.budget?.bytes || 0), 0),
  };
  const distinctBytes = [...union.values()].reduce((a, b) => a + b, 0);
  const perLookup = [{ title: 'discovery', bytes: discovery.bytes }, ...phases];
  const peak = perLookup.reduce((m, p) => Math.max(m, p.bytes), 0);

  const result = {
    task: TASK,
    git: hasGit,
    sweep,
    discovery,
    routed: {
      distinctFiles: union.size,
      distinctBytes,
      peakLookupBytes: peak,
      lookups: perLookup.length,
      candidatesRanked: ctx.budget.candidates,
      explorationLevel: ctx.exploration.level,
      broadPermitted: ctx.exploration.allowBroad,
      maxAgents: ctx.exploration.maxAgents,
      parallelExploration: ctx.exploration.parallel,
      phases: phases.length,
      referenceRepos: ctx.references.filter((r) => r.available).length,
      referencePairs: ctx.references.reduce((n, r) => n + (r.pairs?.length || 0), 0),
    },
    phaseDetail: phases,
    init: {
      firstRunStatus: init.status,
      secondRunStatus: initAgain.status,
      secondRunRebuiltMap: initAgain.mapCached === false,
    },
    telemetry: run,
    avoided: {
      files: sweep.total.files - discovery.files,
      bytes: sweep.total.bytes - discovery.bytes,
      bytesPct: pctDelta(sweep.total.bytes, discovery.bytes),
      peakPct: pctDelta(sweep.total.bytes, peak),
    },
  };

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    log('Yindee Benchmark — two-repo modernization');
    log('─'.repeat(46));
    log(`task   ${TASK}`);
    log(`repos  kairo-ui (${sweep.main.files} source files) + nongmuek-ref (${sweep.reference.files} source files)`);
    log(hasGit ? '' : 'note   git unavailable — content grep was skipped, selection is filename-only');

    log('');
    log('Discovery — a whole-repo sweep versus the one lookup that replaces it');
    log(columns([
      ['  whole-repository sweep', `${sweep.total.files} files · ${fmtBytes(sweep.total.bytes)}  (both repos, measured on disk)`],
      ['  yindee discovery lookup', `${discovery.files} files · ${fmtBytes(discovery.bytes)}  (main + reference, one call)`],
      ['  not read at discovery', `${result.avoided.files} files · ${fmtBytes(result.avoided.bytes)}  (discovery reads ${ratio(discovery.bytes, sweep.total.bytes)} of sweep bytes)`],
      ['  candidates ranked', String(result.routed.candidatesRanked)],
    ], 1));

    log('');
    log('Execution — phases are separate passes, so they are measured per lookup');
    log(columns([
      ['  lookups', String(result.routed.lookups)],
      ['  peak single lookup', `${fmtBytes(peak)}  (${ratio(peak, sweep.total.bytes)} of sweep bytes — the real context pressure)`],
      ['  distinct files across all passes', `${union.size} · ${fmtBytes(distinctBytes)}`],
    ], 1));

    log('');
    log('Exploration policy');
    log(columns([
      ['  level', result.routed.explorationLevel],
      ['  broad permitted', String(result.routed.broadPermitted)],
      ['  agents allowed', `${result.routed.maxAgents} (parallel: ${result.routed.parallelExploration})`],
      ['  phases produced', String(result.routed.phases)],
      ['  reference repos', `${result.routed.referenceRepos} (${result.routed.referencePairs} paired file(s))`],
    ], 1));

    if (phases.length) {
      log('');
      log('Phases');
      log(columns(phases.map((p, i) => [
        `  ${i + 1}. ${p.title}`,
        `${p.selected}/${p.candidates} files`,
        fmtBytes(p.bytes),
        p.batches > 1 ? `${p.batches} batches` : 'one batch',
        `explore:${p.exploration}`,
      ]), 1));
    }

    log('');
    log('Initialization');
    log(columns([
      ['  first run', result.init.firstRunStatus],
      ['  second run', `${result.init.secondRunStatus} (map rebuilt: ${result.init.secondRunRebuiltMap})`],
      ['  map rebuilds avoided', String(run.map.rebuildsAvoided)],
    ], 1));

    log('');
    log('Measured run (from yindee benchmark)');
    const t = run.claudeTokenUsage || {};
    const ag = run.agents || {};
    log(columns([
      ['  duration', fmtDuration(run.wallClockDurationMs)],
      ['  yindee commands', String(run.commands.total)],
      ['  yindee output', fmtBytes(run.output.totalBytes)],
      ['  est. yindee tokens', `~${fmtCount(run.context.estimatedYindeeContextTokens?.value ?? 0)} (estimate — yindee output, not Claude usage)`],
      ['  shell commands', String(run.shell.count)],
      ['  verify runs', `${run.verify.runs} (dry run — the fixture declares tools it does not ship)`],
      ['  broad exploration recommended', String(run.exploration?.broadRecommended ?? 0)],
      ['  subagents observed', ag.status === 'ok' ? String(ag.spawned) : `unavailable — ${ag.reason}`],
      ['  claude tokens', t.status === 'ok' ? String(t.totalTokens) : `unavailable — ${t.reason}`],
    ], 1));

    log('');
    log('The sweep figure is what a whole-repository exploration would have to read, measured on');
    log('disk. It is not an observed agent run and not a token count. Claude token usage is');
    log('reported as unavailable here on purpose: the child processes run without a session id.');
    log('');
    log('This fixture is deliberately small, so the absolute savings are small. What it');
    log('demonstrates is shape, not magnitude: discovery is one bounded lookup instead of a');
    log('sweep, the peak lookup is capped by the budget rather than by repository size, and a');
    log('broad two-repo task yields phases rather than permission to explore.');
    if (KEEP) log(`\nfixture kept at ${TMP}`);
  }
} finally {
  if (!KEEP) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* windows file locks */
    }
  }
}
