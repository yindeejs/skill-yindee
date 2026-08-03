// Session telemetry. Every number in here is measured by a process — a clock,
// a byte count, a git numstat, a runtime-written transcript. Nothing is
// estimated by a model, and the one derived figure (Yindee's own context
// tokens) carries an `estimate` label everywhere it travels.
//
// Storage layout, all under the already-git-excluded `.claude/yindee/`:
//
//   telemetry/session.json    the open session (absent = no session)
//   telemetry/session.jsonl   append-only event log for that session
//   telemetry/runs/<id>.json  finalised run summaries (bounded history)
//
// Events are appended, never rewritten: a killed process loses at most the
// event it was mid-write on, and a torn or corrupt line is skipped rather than
// failing the read.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readJson, writeJsonAtomic, readText, exists, listDir, ensureLocalExclude } from './fsx.mjs';
import { sha1, uniq, toPosix } from './util.mjs';
import { capture } from './sh.mjs';
import { readTokenUsage, readAgentActivity, estimateContextTokens, sessionIdOf, findTranscript } from './tokens.mjs';

export const SCHEMA_VERSION = 1;
export const DEFAULT_KEEP = 20;

export const telemetryDir = (root) => path.join(root, '.claude', 'yindee', 'telemetry');
export const sessionFile = (root) => path.join(telemetryDir(root), 'session.json');
export const eventsFile = (root) => path.join(telemetryDir(root), 'session.jsonl');
export const runsDir = (root) => path.join(telemetryDir(root), 'runs');
export const runFile = (root, id) => path.join(runsDir(root), `${id}.json`);

let idSeq = 0;
/**
 * Id: `20260728-094501123-3f9a`. Milliseconds are in the stamp on purpose —
 * ids are sorted as strings to order the history, so second resolution would
 * let two runs from the same second sort by their hash instead of by time.
 */
function newId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}${p(now.getUTCMilliseconds(), 3)}`;
  return `${stamp}-${sha1(`${now.getTime()}:${process.pid}:${idSeq++}`).slice(0, 4)}`;
}

// ------------------------------------------------------------------ session ---

/**
 * The open session, or null. A corrupt or half-written `session.json` is
 * reported as `{ corrupt: true }` rather than throwing, so a bad file can never
 * wedge the harness — `start --restart` and `stop` both clear it.
 */
export function readSession(root) {
  const file = sessionFile(root);
  if (!exists(file)) return null;
  const parsed = readJson(file);
  if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.startedAt) {
    return { corrupt: true, file };
  }
  return parsed;
}

export function startSession(root, opts = {}) {
  const existing = readSession(root);
  if (existing && !existing.corrupt && !opts.restart) {
    return { session: existing, created: false, reason: 'a session is already running' };
  }
  const now = new Date();
  const gitCommit = capture('git rev-parse HEAD', { cwd: root, timeout: 10_000 });
  const session = {
    schema: SCHEMA_VERSION,
    id: newId(now),
    label: opts.label ? String(opts.label) : null,
    startedAt: now.toISOString(),
    startedAtEpochMs: now.getTime(),
    root: toPosix(root),
    // Captured now, because the environment that started the task is the one
    // whose transcript holds its token usage.
    claudeSessionId: sessionIdOf() || null,
    transcript: findTranscript(sessionIdOf()) || null,
    gitCommit: gitCommit || null,
    // What was already uncommitted before the task began. Subtracted at stop so
    // a dirty starting tree is not billed to this session.
    baseline: gitCommit ? fileDeltas(root, gitCommit) || {} : {},
    status: 'running',
  };
  fs.mkdirSync(telemetryDir(root), { recursive: true });
  fs.writeFileSync(eventsFile(root), '');
  writeJsonAtomic(sessionFile(root), session);
  ensureLocalExclude(root);
  return { session, created: true, replaced: !!existing };
}

// ------------------------------------------------------------------- events ---

/**
 * Append one measured event. No open session means no work and no file writes,
 * which is what keeps telemetry off the cost of an ordinary Yindee command.
 */
export function record(root, event) {
  try {
    if (!exists(sessionFile(root))) return false;
    const file = eventsFile(root);
    // A process killed mid-write leaves a line without its newline. Appending
    // straight onto it would fuse the torn record to the next one and lose two
    // events instead of one, so heal the tail first.
    const heal = endsWithNewline(file) ? '' : '\n';
    fs.appendFileSync(file, heal + JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n');
    return true;
  } catch {
    return false; // read-only checkout, races, full disk — telemetry is never fatal
  }
}

function endsWithNewline(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return true;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch {
    return true; // no file yet, or unreadable — appendFileSync will create it
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Parse the event log, skipping anything unreadable and counting the damage. */
export function readEvents(root) {
  const text = readText(eventsFile(root));
  if (text === null) return { events: [], skipped: 0 };
  const events = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object' && ev.cmd) events.push(ev);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { events, skipped };
}

// -------------------------------------------------------------------- timer ---

/**
 * Monotonic stopwatch. `performance.now()` cannot go backwards when the system
 * clock is adjusted, so an elapsed measurement is never negative and never
 * jumps — unlike a `Date.now()` difference.
 */
export function timer() {
  const started = performance.now();
  return {
    ms: () => Math.max(0, Math.round(performance.now() - started)),
  };
}

// ------------------------------------------------------------------ changes ---

const OURS = /^\.claude\/yindee\//;

/**
 * Per-file `{ added, deleted, binary }` for everything differing from `commit`,
 * including untracked files, which `git diff` cannot see and which count whole.
 * Our own generated state is excluded so telemetry never counts itself as work.
 * Returns null when git could not answer.
 */
export function fileDeltas(root, commit) {
  const numstat = capture(`git diff --numstat ${commit}`, { cwd: root, timeout: 30_000 });
  if (numstat === null) return null;
  const out = {};
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    const file = toPosix(rest.join('\t'));
    if (OURS.test(file)) continue;
    out[file] =
      add === '-' || del === '-'
        ? { added: 0, deleted: 0, binary: true }
        : { added: Number(add) || 0, deleted: Number(del) || 0, binary: false };
  }
  for (const rel of (capture('git ls-files --others --exclude-standard', { cwd: root, timeout: 30_000 }) || '')
    .split(/\r?\n/)
    .map((s) => toPosix(s.trim()))
    .filter(Boolean)) {
    if (OURS.test(rel) || out[rel]) continue;
    const text = readText(path.join(root, rel));
    if (text === null || text.includes('\0')) {
      out[rel] = { added: 0, deleted: 0, binary: true };
      continue;
    }
    const body = text.replace(/\n$/, '');
    out[rel] = { added: body === '' ? 0 : body.split('\n').length, deleted: 0, binary: false };
  }
  return out;
}

/**
 * What the session changed — not what the working tree happens to contain.
 *
 * A task often starts on a dirty tree, so diffing against the base commit alone
 * would bill this session for work that was already there. The baseline taken
 * at `start` is subtracted, leaving only files this session actually moved.
 */
export function measureChanges(root, session) {
  if (!session?.gitCommit) {
    return { status: 'unavailable', reason: 'not a git repository at session start' };
  }
  const now = fileDeltas(root, session.gitCommit);
  if (now === null) {
    return { status: 'unavailable', reason: `git diff against ${session.gitCommit} failed` };
  }
  const baseline = session.baseline || {};
  let filesChanged = 0;
  let linesAdded = 0;
  let linesDeleted = 0;
  let binaryFiles = 0;
  for (const file of uniq([...Object.keys(now), ...Object.keys(baseline)])) {
    const a = baseline[file] || { added: 0, deleted: 0, binary: false };
    const b = now[file] || { added: 0, deleted: 0, binary: false };
    if (a.added === b.added && a.deleted === b.deleted && a.binary === b.binary) continue;
    filesChanged++;
    if (b.binary || a.binary) {
      binaryFiles++;
      continue;
    }
    linesAdded += b.added - a.added;
    linesDeleted += b.deleted - a.deleted;
  }
  return {
    status: 'ok',
    since: session.gitCommit,
    dirtyAtStart: Object.keys(baseline).length,
    filesChanged,
    linesAdded,
    linesDeleted,
    binaryFiles,
  };
}

// ---------------------------------------------------------------- aggregate ---

const add = (obj, key, n = 1) => (obj[key] = (obj[key] || 0) + n);

/**
 * Fold a session plus its event log into a run summary. Pure over its inputs
 * apart from `now`, which the caller supplies so an interrupted session can be
 * reported without being closed.
 */
export function aggregate(session, events, extra = {}) {
  const { skippedEvents = 0, changes = null, claudeTokenUsage = null, now = Date.now(), status } = extra;
  const tokenWindow = extra.tokenWindow ?? null;
  const agents = extra.agents ?? null;

  const byCommand = {};
  const outputByCommand = {};
  const suggested = [];
  const affected = [];
  let contextBytes = 0;
  let outputBytes = 0;
  let mapRuns = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let contextRuns = 0;
  let impactRuns = 0;
  let verifyRuns = 0;
  let reviewRuns = 0;
  let verifySteps = 0;
  let verifyFailures = 0;
  let verifyShellCommands = 0;
  let verifyShellMs = 0;
  let shellCount = 0;
  let shellMs = 0;
  let commandMs = 0;
  // init / budget / exploration / reference counters
  let initRuns = 0;
  let initCreated = 0;
  let initValid = 0;
  let initRefreshed = 0;
  let initUpdated = 0;
  let candidates = 0;
  let selected = 0;
  let selectedBytes = 0;
  let budgetHits = 0;
  let refQueries = 0;
  let refUnavailable = 0;
  const refRepos = [];
  const explorationByLevel = {};
  let decompositions = 0;
  let phases = 0;

  for (const ev of events) {
    add(byCommand, ev.cmd);
    const bytes = Number(ev.outputBytes) || 0;
    outputBytes += bytes;
    add(outputByCommand, ev.cmd, bytes);
    commandMs += Number(ev.ms) || 0;
    shellCount += Number(ev.shellCount) || 0;
    shellMs += Number(ev.shellMs) || 0;

    switch (ev.cmd) {
      case 'map':
        mapRuns++;
        break;
      case 'init':
        initRuns++;
        break;
      case 'context':
        contextRuns++;
        contextBytes += bytes;
        if (Array.isArray(ev.files)) suggested.push(...ev.files);
        candidates += Number(ev.candidates) || 0;
        selected += Number(ev.selected) || 0;
        selectedBytes += Number(ev.selectedBytes) || 0;
        if (ev.budgetHit === true) budgetHits++;
        refQueries += Number(ev.references) || 0;
        refUnavailable += Number(ev.referencesUnavailable) || 0;
        if (Array.isArray(ev.referencePaths)) refRepos.push(...ev.referencePaths);
        if (ev.exploration) add(explorationByLevel, String(ev.exploration));
        if (Number(ev.phases) > 0) {
          decompositions++;
          phases += Number(ev.phases);
        }
        break;
      case 'impact':
        impactRuns++;
        if (Array.isArray(ev.files)) affected.push(...ev.files);
        break;
      case 'verify':
        verifyRuns++;
        verifySteps += Number(ev.steps) || 0;
        verifyFailures += Number(ev.failures) || 0;
        verifyShellCommands += Number(ev.stepsRun) || 0;
        verifyShellMs += Number(ev.verifyMs) || 0;
        break;
      case 'review':
        reviewRuns++;
        break;
      default:
        break;
    }
    // A cached map is a cache hit wherever the map was loaded from — `context`,
    // `impact` and `verify` all load it, and all of them pay or save that cost.
    if (ev.mapCached === true) cacheHits++;
    else if (ev.mapCached === false) cacheMisses++;

    // Init status rides on every command that loaded the map, which is what
    // makes automatic initialization measurable rather than merely claimed.
    switch (ev.initStatus) {
      case 'valid': initValid++; break;
      case 'created': initCreated++; break;
      case 'refreshed': initRefreshed++; break;
      case 'updated': initUpdated++; break;
      default: break;
    }
  }

  const startedAtEpochMs = session.startedAtEpochMs ?? Date.parse(session.startedAt);
  const finishedAtEpochMs = session.finishedAtEpochMs ?? now;
  const wallClockDurationMs = Math.max(0, finishedAtEpochMs - startedAtEpochMs);

  return {
    schema: SCHEMA_VERSION,
    id: session.id,
    label: session.label ?? null,
    status: status || session.status || 'running',
    startedAt: session.startedAt,
    finishedAt: session.finishedAt ?? new Date(finishedAtEpochMs).toISOString(),
    wallClockDurationMs,
    commands: { total: events.length, totalMs: commandMs, byName: byCommand },
    // `rebuildsAvoided` is the same event as a cache hit, named for what it
    // bought: a map load that did not re-walk the repository.
    map: { runs: mapRuns, cacheHits, cacheMisses, rebuildsAvoided: cacheHits },
    init: {
      runs: initRuns,
      created: initCreated,
      cacheHits: initValid,
      refreshes: initRefreshed,
      updates: initUpdated,
      automatic: Math.max(0, initCreated + initUpdated - initRuns),
    },
    context: {
      runs: contextRuns,
      bytes: contextBytes,
      estimatedYindeeContextTokens: estimateContextTokens(contextBytes),
      filesSuggested: uniq(suggested).length,
      candidates,
      filesSelected: selected,
      selectedBytes,
      budgetHits,
    },
    reference: { queries: refQueries, repos: uniq(refRepos).length, unavailable: refUnavailable },
    exploration: {
      byLevel: explorationByLevel,
      recommendations: Object.values(explorationByLevel).reduce((a, b) => a + b, 0),
      broadRecommended: explorationByLevel.broad || 0,
      decompositions,
      phases,
    },
    agents: agents || { status: 'unavailable', reason: 'not measured' },
    impact: { runs: impactRuns, filesAffected: uniq(affected).length },
    verify: {
      runs: verifyRuns,
      retries: Math.max(0, verifyRuns - 1),
      stepsPlanned: verifySteps,
      stepsRun: verifyShellCommands,
      failures: verifyFailures,
      executionMs: verifyShellMs,
    },
    review: { runs: reviewRuns },
    shell: { count: shellCount, ms: shellMs },
    output: { totalBytes: outputBytes, byCommand: outputByCommand },
    changes: changes || { status: 'unavailable', reason: 'not measured' },
    claudeTokenUsage: claudeTokenUsage || { status: 'unavailable', reason: 'not measured' },
    // Kept so a later `report` can re-read usage the runtime had not yet
    // flushed when the run was closed. It is a pointer, not a number.
    ...(tokenWindow ? { tokenWindow } : {}),
    events: { recorded: events.length, skipped: skippedEvents },
  };
}

// --------------------------------------------------------------- lifecycle ---

/** Read the live session without closing it. Duration is measured to `now`. */
export function statusOf(root, { tokens = false } = {}) {
  const session = readSession(root);
  if (!session) return { active: false };
  if (session.corrupt) return { active: false, corrupt: true, file: session.file };
  const { events, skipped } = readEvents(root);
  const window = {
    sessionId: session.claudeSessionId,
    transcript: session.transcript,
    from: session.startedAt,
  };
  const claudeTokenUsage = tokens ? readTokenUsage(window) : null;
  return {
    active: true,
    session,
    summary: aggregate(session, events, {
      skippedEvents: skipped,
      claudeTokenUsage,
      agents: readAgentActivity(window),
      status: 'running',
    }),
  };
}

/**
 * Close the session and persist the run. An `abandon` stop still writes a
 * summary — an interrupted benchmark is data, not a reason to lose the log.
 */
export function stopSession(root, opts = {}) {
  const session = readSession(root);
  if (!session) return { stopped: false, reason: 'no benchmark session is running' };
  if (session.corrupt) {
    try {
      fs.rmSync(sessionFile(root), { force: true });
      fs.rmSync(eventsFile(root), { force: true });
    } catch {
      /* best effort */
    }
    return { stopped: false, recovered: true, reason: 'session state was corrupt; it has been cleared' };
  }

  const now = new Date();
  const { events, skipped } = readEvents(root);
  const closed = {
    ...session,
    finishedAt: now.toISOString(),
    finishedAtEpochMs: now.getTime(),
    status: opts.status || 'completed',
  };
  const tokenWindow = {
    sessionId: session.claudeSessionId ?? null,
    transcript: session.transcript ?? null,
    from: session.startedAt,
    to: now.toISOString(),
  };
  const summary = aggregate(closed, events, {
    skippedEvents: skipped,
    changes: measureChanges(root, session),
    claudeTokenUsage: readTokenUsage(tokenWindow),
    agents: readAgentActivity(tokenWindow),
    tokenWindow,
    status: closed.status,
  });

  try {
    fs.mkdirSync(runsDir(root), { recursive: true });
    writeJsonAtomic(runFile(root, summary.id), summary);
    fs.rmSync(sessionFile(root), { force: true });
    fs.rmSync(eventsFile(root), { force: true });
  } catch {
    /* read-only checkout: the summary is still returned to the caller */
  }
  pruneRuns(root, opts.keep ?? DEFAULT_KEEP);
  return { stopped: true, summary };
}

// -------------------------------------------------------------------- runs ---

export function listRuns(root) {
  const dir = runsDir(root);
  if (!exists(dir)) return [];
  return listDir(dir)
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

/** Resolve `latest`, an exact id, or an unambiguous id prefix. */
export function resolveRun(root, ref) {
  const ids = listRuns(root);
  if (!ids.length) return null;
  if (!ref || ref === 'latest' || ref === 'last') return ids[0];
  if (ids.includes(ref)) return ref;
  const hits = ids.filter((id) => id.startsWith(ref));
  return hits.length === 1 ? hits[0] : null;
}

export function loadRun(root, ref) {
  const id = resolveRun(root, ref);
  if (!id) return null;
  const data = readJson(runFile(root, id));
  if (!data || !data.id) return { id, corrupt: true };
  return data;
}

/**
 * Re-read actual token usage for an already-closed run.
 *
 * Claude Code appends a turn's usage to the transcript when the turn ends, so a
 * run stopped mid-turn legitimately sees nothing yet. Reporting it later can
 * therefore find real data where `stop` found none. This only ever upgrades
 * `unavailable` to a measurement — it never overwrites one measurement with
 * another, and never invents one.
 */
export function refreshTokenUsage(root, run) {
  if (!run?.tokenWindow) return { run, refreshed: false };
  const wantUsage = run.claudeTokenUsage?.status !== 'ok';
  const wantAgents = run.agents?.status !== 'ok';
  if (!wantUsage && !wantAgents) return { run, refreshed: false };

  const usage = wantUsage ? readTokenUsage(run.tokenWindow) : null;
  const agents = wantAgents ? readAgentActivity(run.tokenWindow) : null;
  if (usage?.status !== 'ok' && agents?.status !== 'ok') return { run, refreshed: false };

  const updated = {
    ...run,
    ...(usage?.status === 'ok' ? { claudeTokenUsage: usage } : {}),
    ...(agents?.status === 'ok' ? { agents } : {}),
  };
  try {
    writeJsonAtomic(runFile(root, run.id), updated);
  } catch {
    /* read-only checkout: the caller still gets the fresher numbers */
  }
  return { run: updated, refreshed: true };
}

/** Bounded history: keep the newest `keep` runs, delete the rest. */
export function pruneRuns(root, keep = DEFAULT_KEEP) {
  const ids = listRuns(root);
  const removed = ids.slice(Math.max(0, keep));
  for (const id of removed) {
    try {
      fs.rmSync(runFile(root, id), { force: true });
    } catch {
      /* best effort */
    }
  }
  return { kept: ids.length - removed.length, removed };
}
