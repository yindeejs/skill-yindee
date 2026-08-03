// Telemetry + benchmark self-tests. Zero dependencies — `node --test`.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as tel from '../scripts/lib/telemetry.mjs';
import { renderReport, compareRuns, renderCompare } from '../scripts/lib/benchmark.mjs';
import {
  readTranscriptUsage,
  readTokenUsage,
  estimateContextTokens,
  findTranscript,
  configDir,
} from '../scripts/lib/tokens.mjs';
import { fmtDuration, fmtBytes, fmtCount, pctDelta } from '../scripts/lib/util.mjs';
import { shellStats, run } from '../scripts/lib/sh.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'yindee.mjs');

let TMP;
const w = (root, rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'pipe' });
} catch {
  hasGit = false;
}

/** A repo with real commands, so `verify` has something to actually run. */
function makeFixtureRepo(root) {
  w(root, 'package.json', {
    name: 'bench-fixture',
    private: true,
    scripts: { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
  });
  w(root, 'src/index.js', 'export const a = 1;\n');
  w(root, 'src/auth/login.js', 'export const login = () => {};\n');
  w(root, 'tests/a.test.js', 'export const t = 1;\n');
  w(root, 'README.md', '# fixture\n');
  if (hasGit) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@e.st');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  }
}

// Telemetry and benchmark are opt-in modules, so this suite opts in. What is
// under test is their behavior, not their gate — the gate is covered in
// tests/registry.test.mjs.
const cli = (root, args, env = {}) =>
  execFileSync(process.execPath, [CLI, ...args, '--repo', root], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, YINDEE_MODULES: 'benchmark,telemetry', ...env },
  });

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yindee-tel-'));
});
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* windows file locks */
  }
});

let seq = 0;
const freshRoot = (name) => {
  const root = path.join(TMP, `${name}-${seq++}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
};

// ------------------------------------------------------------------ timing ---

describe('timer', () => {
  test('is monotonic and never negative', () => {
    const t = tel.timer();
    assert.ok(t.ms() >= 0);
    // Busy-wait rather than sleep: the assertion is about the clock advancing,
    // not about the test being slow.
    const until = Date.now() + 25;
    while (Date.now() < until) {
      /* spin */
    }
    const a = t.ms();
    const b = t.ms();
    assert.ok(a >= 20, `expected >= 20ms, got ${a}`);
    assert.ok(b >= a, 'a monotonic timer must never go backwards');
  });

  test('measures elapsed time rather than reporting a fixed value', () => {
    const short = tel.timer();
    const shortMs = short.ms();
    const long = tel.timer();
    const until = Date.now() + 40;
    while (Date.now() < until) {
      /* spin */
    }
    assert.ok(long.ms() > shortMs, 'a longer wall-clock span must measure larger');
  });

  test('shell execution is counted and timed by the runtime', () => {
    const before = { count: shellStats.count, ms: shellStats.ms };
    run(process.platform === 'win32' ? 'cd .' : 'true', { timeout: 10_000 });
    assert.equal(shellStats.count, before.count + 1);
    assert.ok(shellStats.ms >= before.ms);
  });

  test('duration formatting matches the report shape', () => {
    assert.equal(fmtDuration(842), '842ms');
    assert.equal(fmtDuration(18 * 60_000 + 37_000), '18m 37s');
    assert.equal(fmtDuration(3600_000 + 4 * 60_000 + 12_000), '1h 04m 12s');
    assert.equal(fmtDuration(-5), '0ms');
    assert.equal(fmtBytes(18_842), '18.4 KB');
    assert.equal(fmtCount(4712), '4.7K');
    assert.equal(pctDelta(0, 0), 0);
    assert.equal(pctDelta(0, 5), null, 'a percentage from zero is not a number we may invent');
    assert.equal(pctDelta(100, 50), -50);
  });
});

// --------------------------------------------------------------- lifecycle ---

describe('session lifecycle', () => {
  test('start -> status -> stop produces a persisted run', () => {
    const root = freshRoot('life');
    assert.equal(tel.readSession(root), null);

    const started = tel.startSession(root, { label: 'demo' });
    assert.equal(started.created, true);
    assert.equal(started.session.label, 'demo');
    assert.ok(fs.existsSync(tel.sessionFile(root)));

    tel.record(root, { cmd: 'map', ms: 5, outputBytes: 100, mapCached: false });
    const live = tel.statusOf(root);
    assert.equal(live.active, true);
    assert.equal(live.summary.status, 'running');
    assert.equal(live.summary.commands.total, 1);

    const stopped = tel.stopSession(root);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.summary.status, 'completed');
    assert.ok(stopped.summary.finishedAt);
    assert.ok(stopped.summary.wallClockDurationMs >= 0);
    assert.ok(fs.existsSync(tel.runFile(root, stopped.summary.id)));
    assert.equal(tel.readSession(root), null, 'stop must clear the open session');
    assert.equal(tel.statusOf(root).active, false);
  });

  test('start is idempotent and only replaces on --restart', () => {
    const root = freshRoot('idem');
    const first = tel.startSession(root, {});
    const again = tel.startSession(root, {});
    assert.equal(again.created, false);
    assert.equal(again.session.id, first.session.id);
    const forced = tel.startSession(root, { restart: true });
    assert.equal(forced.created, true);
    assert.notEqual(forced.session.id, first.session.id);
  });

  test('stopping with no session is reported, not thrown', () => {
    const root = freshRoot('nostop');
    const res = tel.stopSession(root);
    assert.equal(res.stopped, false);
    assert.match(res.reason, /no benchmark session/);
  });

  test('recording without a session writes nothing', () => {
    const root = freshRoot('quiet');
    assert.equal(tel.record(root, { cmd: 'map', ms: 1 }), false);
    assert.equal(fs.existsSync(tel.eventsFile(root)), false);
  });
});

describe('interrupted sessions', () => {
  test('an unfinished session still reports a duration and is marked running', () => {
    const root = freshRoot('interrupted');
    tel.startSession(root, {});
    tel.record(root, { cmd: 'context', ms: 12, outputBytes: 400, files: ['a.ts'] });
    // Process dies here — nothing calls stop.
    const st = tel.statusOf(root);
    assert.equal(st.summary.status, 'running');
    assert.equal(st.summary.finishedAt !== null, true);
    assert.ok(st.summary.wallClockDurationMs >= 0);
    assert.equal(st.summary.context.runs, 1);

    // A later stop closes it without losing the events recorded before the crash.
    const stopped = tel.stopSession(root);
    assert.equal(stopped.summary.context.runs, 1);
    assert.equal(stopped.summary.status, 'completed');
  });

  test('a half-written event line is skipped, not fatal', () => {
    const root = freshRoot('torn');
    tel.startSession(root, {});
    tel.record(root, { cmd: 'map', ms: 1, outputBytes: 10, mapCached: true });
    fs.appendFileSync(tel.eventsFile(root), '{"cmd":"verify","ms":3,"fail');
    tel.record(root, { cmd: 'impact', ms: 2, outputBytes: 20 });

    const { events, skipped } = tel.readEvents(root);
    assert.equal(events.length, 2, 'both intact events survive a torn line');
    assert.equal(skipped, 1);
    const st = tel.statusOf(root);
    assert.equal(st.summary.events.skipped, 1);
  });

  test('a corrupt session.json is recoverable rather than wedging the harness', () => {
    const root = freshRoot('corrupt');
    tel.startSession(root, {});
    fs.writeFileSync(tel.sessionFile(root), '{ not json at all');
    const s = tel.readSession(root);
    assert.equal(s.corrupt, true);
    assert.equal(tel.statusOf(root).active, false);

    const res = tel.stopSession(root);
    assert.equal(res.stopped, false);
    assert.equal(res.recovered, true);
    assert.equal(tel.readSession(root), null, 'recovery clears the bad state');
    // And the harness is usable again immediately.
    assert.equal(tel.startSession(root, {}).created, true);
  });

  test('a corrupt stored run is reported as corrupt, not parsed as zeroes', () => {
    const root = freshRoot('badrun');
    tel.startSession(root, {});
    const { summary } = tel.stopSession(root);
    fs.writeFileSync(tel.runFile(root, summary.id), '}}}not json');
    const loaded = tel.loadRun(root, summary.id);
    assert.equal(loaded.corrupt, true);
  });
});

// ---------------------------------------------------------------- counting ---

describe('counters', () => {
  const events = [
    { cmd: 'map', ms: 10, outputBytes: 100, mapCached: false },
    { cmd: 'map', ms: 2, outputBytes: 100, mapCached: true },
    { cmd: 'context', ms: 30, outputBytes: 1024, mapCached: true, files: ['a.ts', 'b.ts'] },
    { cmd: 'context', ms: 25, outputBytes: 512, mapCached: true, files: ['b.ts', 'c.ts'] },
    { cmd: 'impact', ms: 20, outputBytes: 200, mapCached: true, files: ['a.ts'] },
    { cmd: 'verify', ms: 900, outputBytes: 300, mapCached: true, steps: 3, stepsRun: 3, failures: 2, verifyMs: 850, shellCount: 3, shellMs: 850 },
    { cmd: 'verify', ms: 700, outputBytes: 150, mapCached: true, steps: 3, stepsRun: 3, failures: 1, verifyMs: 690, shellCount: 3, shellMs: 690 },
    { cmd: 'verify', ms: 600, outputBytes: 90, mapCached: true, steps: 3, stepsRun: 3, failures: 0, verifyMs: 590, shellCount: 3, shellMs: 590 },
    { cmd: 'review', ms: 40, outputBytes: 4096, mapCached: true },
  ];
  const session = { id: 'r1', startedAt: '2026-07-28T09:12:04.000Z', startedAtEpochMs: 1000, label: null };
  const sum = () => tel.aggregate(session, events, { now: 1000 + 18 * 60_000 + 37_000 });

  test('counts each yindee command', () => {
    const s = sum();
    assert.equal(s.commands.total, 9);
    assert.equal(s.commands.byName.verify, 3);
    assert.equal(s.commands.byName.context, 2);
    assert.equal(s.map.runs, 2);
    assert.equal(s.impact.runs, 1);
    assert.equal(s.review.runs, 1);
  });

  test('counts map cache hits and misses separately', () => {
    const s = sum();
    assert.equal(s.map.cacheMisses, 1);
    assert.equal(s.map.cacheHits, 8);
    assert.equal(s.map.cacheHits + s.map.cacheMisses, 9);
  });

  test('counts context bytes and de-duplicates suggested files', () => {
    const s = sum();
    assert.equal(s.context.bytes, 1536);
    assert.equal(s.context.filesSuggested, 3, 'a file suggested twice is still one file');
    assert.equal(s.impact.filesAffected, 1);
  });

  test('context tokens are an explicitly labelled estimate over Yindee output', () => {
    const s = sum();
    assert.equal(s.context.estimatedYindeeContextTokens.label, 'estimate');
    assert.equal(s.context.estimatedYindeeContextTokens.method, 'contextCharacters/4');
    assert.equal(s.context.estimatedYindeeContextTokens.value, 384);
    assert.equal(estimateContextTokens(4000).value, 1000);
  });

  test('verification retries and failures are counted, not inferred', () => {
    const s = sum();
    assert.equal(s.verify.runs, 3);
    assert.equal(s.verify.retries, 2, 'retries are verify runs after the first');
    assert.equal(s.verify.failures, 3);
    assert.equal(s.verify.stepsRun, 9);
    assert.equal(s.verify.executionMs, 2130);
  });

  test('shell commands and shell time come from the runtime counters', () => {
    const s = sum();
    assert.equal(s.shell.count, 9);
    assert.equal(s.shell.ms, 2130);
  });

  test('output bytes are tracked per command and in total', () => {
    const s = sum();
    assert.equal(s.output.totalBytes, 6572);
    assert.equal(s.output.byCommand.review, 4096);
    assert.equal(s.output.byCommand.context, 1536);
  });

  test('wall clock duration comes from timestamps, never from the event log', () => {
    const s = sum();
    assert.equal(s.wallClockDurationMs, 18 * 60_000 + 37_000);
    assert.equal(fmtDuration(s.wallClockDurationMs), '18m 37s');
  });

  test('a zero/empty session aggregates to zeroes, not to nulls or NaN', () => {
    const s = tel.aggregate({ id: 'empty', startedAt: '2026-07-28T09:00:00.000Z', startedAtEpochMs: 0 }, [], { now: 0 });
    assert.equal(s.commands.total, 0);
    assert.equal(s.wallClockDurationMs, 0);
    assert.equal(s.context.bytes, 0);
    assert.equal(s.context.estimatedYindeeContextTokens.value, 0);
    assert.equal(s.verify.retries, 0);
    assert.equal(s.map.cacheHits, 0);
    assert.equal(s.shell.count, 0);
    for (const v of [s.commands.total, s.context.bytes, s.shell.ms, s.verify.failures]) {
      assert.ok(Number.isFinite(v), 'every counter must be a finite number');
    }
    assert.ok(renderReport(s).includes('Yindee Benchmark'));
  });
});

// ------------------------------------------------------------------ tokens ---

describe('claude token usage', () => {
  const transcript = (root, lines) => {
    const p = path.join(root, 'session.jsonl');
    fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    return p;
  };
  const rec = (requestId, ts, usage) => ({
    type: 'assistant',
    requestId,
    timestamp: ts,
    message: { model: 'claude-opus-5', usage },
  });
  const usage = (i, o, r, c) => ({
    input_tokens: i,
    output_tokens: o,
    cache_read_input_tokens: r,
    cache_creation_input_tokens: c,
  });

  test('sums real usage and de-duplicates streamed writes of one request', () => {
    const root = freshRoot('tok');
    const p = transcript(root, [
      rec('req_a', '2026-07-28T09:13:00.000Z', usage(10, 20, 300, 40)),
      rec('req_a', '2026-07-28T09:13:01.000Z', usage(10, 20, 300, 40)), // same request, written twice
      rec('req_b', '2026-07-28T09:14:00.000Z', usage(1, 2, 3, 4)),
    ]);
    const u = readTranscriptUsage(p);
    assert.equal(u.status, 'ok');
    assert.equal(u.requests, 2, 'a streamed request must be counted once');
    assert.equal(u.inputTokens, 11);
    assert.equal(u.outputTokens, 22);
    assert.equal(u.cacheReadTokens, 303);
    assert.equal(u.cacheCreationTokens, 44);
    assert.equal(u.totalTokens, 380);
    assert.equal(u.source, 'claude-code-session-transcript');
  });

  test('windows usage to the telemetry session', () => {
    const root = freshRoot('tokwin');
    const p = transcript(root, [
      rec('before', '2026-07-28T08:00:00.000Z', usage(999, 999, 999, 999)),
      rec('during', '2026-07-28T09:30:00.000Z', usage(5, 6, 7, 8)),
      rec('after', '2026-07-28T11:00:00.000Z', usage(777, 777, 777, 777)),
    ]);
    const u = readTranscriptUsage(p, { from: '2026-07-28T09:00:00.000Z', to: '2026-07-28T10:00:00.000Z' });
    assert.equal(u.requests, 1);
    assert.equal(u.totalTokens, 26);
  });

  test('malformed transcript lines are skipped, real ones still counted', () => {
    const root = freshRoot('tokbad');
    const p = transcript(root, [
      '{ this is not json',
      rec('ok', '2026-07-28T09:30:00.000Z', usage(1, 1, 1, 1)),
      '',
    ]);
    const u = readTranscriptUsage(p);
    assert.equal(u.status, 'ok');
    assert.equal(u.malformedLines, 1);
    assert.equal(u.totalTokens, 4);
  });

  test('no transcript means unavailable — never zero and never an estimate', () => {
    const root = freshRoot('tokmissing');
    const u = readTokenUsage({ sessionId: 'nope', env: { CLAUDE_CONFIG_DIR: root } });
    assert.equal(u.status, 'unavailable');
    assert.ok(u.reason);
    assert.equal(u.inputTokens, undefined, 'unavailable usage must not carry fabricated numbers');
    assert.equal(u.totalTokens, undefined);
  });

  test('no claude session at all is unavailable with a stated reason', () => {
    const root = freshRoot('tokno');
    const u = readTokenUsage({ env: { CLAUDE_CONFIG_DIR: root } });
    assert.equal(u.status, 'unavailable');
    assert.match(u.reason, /Claude Code session/);
  });

  test('a transcript with no usage records is unavailable, not zero', () => {
    const root = freshRoot('tokempty');
    const p = transcript(root, [{ type: 'user', message: { content: 'hi' } }]);
    const u = readTranscriptUsage(p);
    assert.equal(u.status, 'unavailable');
    assert.equal(u.totalTokens, undefined);
  });

  test('the transcript is found by session id under the config dir', () => {
    const root = freshRoot('tokfind');
    const dir = path.join(root, 'projects', 'some--slug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-123.jsonl'), '');
    assert.equal(findTranscript('sess-123', { CLAUDE_CONFIG_DIR: root }), path.join(dir, 'sess-123.jsonl'));
    assert.equal(findTranscript('missing', { CLAUDE_CONFIG_DIR: root }), null);
    assert.equal(configDir({ CLAUDE_CONFIG_DIR: root }), path.resolve(root));
  });

  test('the report prints "unavailable" rather than substituting a guess', () => {
    const s = tel.aggregate(
      { id: 'u', startedAt: '2026-07-28T09:00:00.000Z', startedAtEpochMs: 0 },
      [{ cmd: 'context', ms: 5, outputBytes: 40_000 }],
      { now: 60_000, claudeTokenUsage: { status: 'unavailable', reason: 'no transcript' } },
    );
    const text = renderReport(s);
    assert.match(text, /Input tokens\s+unavailable/);
    assert.match(text, /Output tokens\s+unavailable/);
    assert.match(text, /Cache tokens\s+unavailable/);
    // The estimate exists but is never presented as Claude's usage.
    assert.match(text, /estimate only/);
    assert.ok(!/Input tokens\s+~?\d/.test(text), 'an estimate must never fill an unavailable token field');
  });

  test('real usage is rendered with its source', () => {
    const s = tel.aggregate(
      { id: 'ok', startedAt: '2026-07-28T09:00:00.000Z', startedAtEpochMs: 0 },
      [],
      {
        now: 1000,
        claudeTokenUsage: {
          status: 'ok',
          source: 'claude-code-session-transcript',
          requests: 4,
          inputTokens: 11,
          outputTokens: 22,
          cacheReadTokens: 33,
          cacheCreationTokens: 44,
          totalTokens: 110,
        },
      },
    );
    const text = renderReport(s);
    assert.match(text, /Input tokens\s+11/);
    assert.match(text, /Total tokens\s+110/);
    assert.match(text, /claude-code-session-transcript \(4 requests\)/);
  });
});

// ----------------------------------------------------------------- compare ---

describe('compare', () => {
  const mk = (over = {}) =>
    tel.aggregate(
      { id: over.id || 'x', startedAt: '2026-07-28T09:00:00.000Z', startedAtEpochMs: 0, label: over.label ?? null },
      over.events || [],
      { now: over.now ?? 60_000, claudeTokenUsage: over.tokens, changes: over.changes },
    );

  const tokensOk = (n) => ({
    status: 'ok',
    source: 'claude-code-session-transcript',
    requests: 1,
    inputTokens: n,
    outputTokens: n,
    cacheReadTokens: n,
    cacheCreationTokens: n,
    totalTokens: n * 4,
  });

  test('reports duration and context deltas as percentages', () => {
    const a = mk({ id: 'a', now: 100_000, events: [{ cmd: 'context', outputBytes: 1000, ms: 1, files: ['a'] }] });
    const b = mk({ id: 'b', now: 50_000, events: [{ cmd: 'context', outputBytes: 500, ms: 1, files: ['a', 'b'] }] });
    const c = compareRuns(a, b);
    assert.equal(c.duration.percent, -50);
    assert.equal(c.yindeeContextBytes.percent, -50);
    assert.equal(c.estimatedYindeeContextTokens.label, 'estimate');
    assert.equal(c.filesSuggested.absolute, 1);
  });

  test('reports verification deltas', () => {
    const v = (failures) => ({ cmd: 'verify', ms: 1, outputBytes: 0, failures, stepsRun: 1, shellCount: 1, shellMs: 10 });
    const a = mk({ id: 'a', events: [v(2), v(1)] });
    const b = mk({ id: 'b', events: [v(0)] });
    const c = compareRuns(a, b);
    assert.equal(c.verification.runs.from, 2);
    assert.equal(c.verification.runs.to, 1);
    assert.equal(c.verification.retries.from, 1);
    assert.equal(c.verification.retries.to, 0);
    assert.equal(c.verification.failures.absolute, -3);
  });

  test('token deltas exist only when BOTH runs measured actual usage', () => {
    const withTokens = mk({ id: 'a', tokens: tokensOk(100) });
    const without = mk({ id: 'b', tokens: { status: 'unavailable', reason: 'no transcript' } });

    const mixed = compareRuns(withTokens, without);
    assert.equal(mixed.claudeTokenUsage.status, 'unavailable');
    assert.equal(mixed.claudeTokenUsage.inputTokens, undefined);
    assert.match(mixed.claudeTokenUsage.reason, /b/);

    const neither = compareRuns(without, without);
    assert.equal(neither.claudeTokenUsage.status, 'unavailable');

    const both = compareRuns(withTokens, mk({ id: 'c', tokens: tokensOk(50) }));
    assert.equal(both.claudeTokenUsage.status, 'ok');
    assert.equal(both.claudeTokenUsage.totalTokens.percent, -50);
    assert.equal(both.claudeTokenUsage.inputTokens.absolute, -50);
  });

  test('an estimate is never compared against actual Claude usage', () => {
    const a = mk({ id: 'a', tokens: tokensOk(100), events: [{ cmd: 'context', outputBytes: 4000, ms: 1 }] });
    const b = mk({ id: 'b', tokens: { status: 'unavailable', reason: 'x' } });
    const text = renderCompare(compareRuns(a, b));
    assert.match(text, /Claude usage[\s\S]*unavailable/);
    assert.match(text, /never compared against actual Claude usage/);
    assert.match(text, /estimate vs estimate/);
  });

  test('change deltas need both runs to have measured changes', () => {
    const ok = (n) => ({ status: 'ok', filesChanged: n, linesAdded: n * 10, linesDeleted: n });
    const both = compareRuns(mk({ id: 'a', changes: ok(10) }), mk({ id: 'b', changes: ok(5) }));
    assert.equal(both.changes.status, 'ok');
    assert.equal(both.changes.filesChanged.percent, -50);
    const one = compareRuns(mk({ id: 'a', changes: ok(10) }), mk({ id: 'b' }));
    assert.equal(one.changes.status, 'unavailable');
  });
});

// -------------------------------------------------------------- persistence ---

describe('persistence', () => {
  test('runs persist under the generated cache directory only', () => {
    const root = freshRoot('persist');
    tel.startSession(root, { label: 'kept' });
    tel.record(root, { cmd: 'map', ms: 1, outputBytes: 5, mapCached: true });
    const { summary } = tel.stopSession(root);

    const file = tel.runFile(root, summary.id);
    assert.ok(fs.existsSync(file));
    assert.ok(file.replace(/\\/g, '/').includes('.claude/yindee/telemetry/runs/'));
    const reread = tel.loadRun(root, summary.id);
    assert.equal(reread.id, summary.id);
    assert.equal(reread.label, 'kept');
    assert.equal(reread.commands.total, 1);
    assert.equal(reread.schema, tel.SCHEMA_VERSION);

    // Nothing outside .claude/ was created.
    assert.deepEqual(
      fs.readdirSync(root).filter((n) => n !== '.claude'),
      [],
      'telemetry must not create files anywhere else in the repo',
    );
  });

  test('resolves latest and unambiguous id prefixes', () => {
    const root = freshRoot('resolve');
    tel.startSession(root, {});
    const first = tel.stopSession(root).summary.id;
    tel.startSession(root, {});
    const second = tel.stopSession(root).summary.id;
    const ids = tel.listRuns(root);
    assert.equal(ids.length, 2);
    assert.equal(tel.resolveRun(root, 'latest'), ids[0]);
    assert.equal(tel.resolveRun(root, first), first);
    assert.equal(tel.resolveRun(root, second.slice(0, 20)), second);
    assert.equal(tel.resolveRun(root, 'nope'), null);
  });

  test('history is bounded and prunable', () => {
    const root = freshRoot('prune');
    const ids = [];
    for (let i = 0; i < 5; i++) {
      tel.startSession(root, { restart: true });
      ids.push(tel.stopSession(root).summary.id);
    }
    assert.equal(tel.listRuns(root).length, 5);
    const res = tel.pruneRuns(root, 2);
    assert.equal(res.kept, 2);
    assert.equal(res.removed.length, 3);
    assert.equal(tel.listRuns(root).length, 2);
    // Newest survive.
    assert.ok(tel.listRuns(root).includes(ids[4]));
  });

  test('stop prunes to the default bound', () => {
    const root = freshRoot('bound');
    for (let i = 0; i < tel.DEFAULT_KEEP + 3; i++) {
      tel.startSession(root, { restart: true });
      tel.stopSession(root);
    }
    assert.equal(tel.listRuns(root).length, tel.DEFAULT_KEEP);
  });
});

// ---------------------------------------------------------------- git-aware ---

describe('change measurement', { skip: !hasGit ? 'git not available' : false }, () => {
  test('files changed and lines added/deleted come from git', () => {
    const root = freshRoot('changes');
    makeFixtureRepo(root);
    tel.startSession(root, {});
    fs.appendFileSync(path.join(root, 'src/index.js'), 'export const b = 2;\nexport const c = 3;\n');
    w(root, 'src/new.js', 'a\nb\nc\n');
    const ch = tel.measureChanges(root, tel.readSession(root));
    assert.equal(ch.status, 'ok');
    assert.equal(ch.filesChanged, 2, 'a modified file and an untracked new file');
    assert.equal(ch.linesAdded, 5);
    assert.equal(ch.linesDeleted, 0);
  });

  test('work already in the tree at start is not billed to the session', () => {
    const root = freshRoot('dirtystart');
    makeFixtureRepo(root);
    // Somebody's earlier, uncommitted work.
    fs.appendFileSync(path.join(root, 'src/index.js'), 'export const old1 = 1;\nexport const old2 = 2;\n');
    w(root, 'src/preexisting.js', 'x\ny\n');

    tel.startSession(root, {});
    const session = tel.readSession(root);
    assert.ok(Object.keys(session.baseline).length >= 2, 'the dirty tree must be snapshotted at start');

    // Only this line belongs to the session.
    fs.appendFileSync(path.join(root, 'src/auth/login.js'), 'export const mine = 1;\n');
    const ch = tel.measureChanges(root, session);
    assert.equal(ch.status, 'ok');
    assert.equal(ch.filesChanged, 1, 'only the file this session touched');
    assert.equal(ch.linesAdded, 1);
    assert.equal(ch.dirtyAtStart, 2);
  });

  test('a clean start attributes everything to the session', () => {
    const root = freshRoot('cleanstart');
    makeFixtureRepo(root);
    tel.startSession(root, {});
    assert.deepEqual(tel.readSession(root).baseline, {});
    fs.appendFileSync(path.join(root, 'src/index.js'), 'a\nb\n');
    const ch = tel.measureChanges(root, tel.readSession(root));
    assert.equal(ch.filesChanged, 1);
    assert.equal(ch.linesAdded, 2);
  });

  test('telemetry never counts its own generated state as work', () => {
    const root = freshRoot('selfclean');
    makeFixtureRepo(root);
    tel.startSession(root, {});
    tel.record(root, { cmd: 'map', ms: 1, outputBytes: 10, mapCached: false });
    const ch = tel.measureChanges(root, tel.readSession(root));
    assert.equal(ch.status, 'ok');
    assert.equal(ch.filesChanged, 0);
    assert.equal(ch.linesAdded, 0);
  });

  test('generated state does not pollute git status', () => {
    const root = freshRoot('gitstatus');
    makeFixtureRepo(root);
    tel.startSession(root, {});
    tel.record(root, { cmd: 'map', ms: 1, outputBytes: 10 });
    tel.stopSession(root);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(status.trim(), '', `git status must stay clean, got:\n${status}`);
  });

  test('changes are unavailable outside a git repo, never guessed', () => {
    const root = freshRoot('nogit');
    tel.startSession(root, {});
    const { summary } = tel.stopSession(root);
    assert.equal(summary.changes.status, 'unavailable');
    assert.equal(summary.changes.filesChanged, undefined);
    assert.match(renderReport(summary), /Files changed\s+unavailable/);
  });
});

// ----------------------------------------------------------------- the CLI ---

describe('benchmark CLI', { skip: !hasGit ? 'git not available' : false }, () => {
  test('start/status/stop and JSON output round-trip through the CLI', () => {
    const root = freshRoot('cli');
    makeFixtureRepo(root);

    assert.match(cli(root, ['benchmark', 'status']), /no session running/);

    const started = cli(root, ['benchmark', 'start', '--label', 'smoke']);
    assert.match(started, /benchmark started/);
    assert.match(cli(root, ['benchmark', 'start']), /already running/);

    cli(root, ['map']);
    cli(root, ['map']);
    cli(root, ['context', 'refresh the login token']);
    cli(root, ['impact']);
    assert.match(cli(root, ['benchmark', 'status']), /running for/);

    const json = JSON.parse(cli(root, ['benchmark', 'stop', '--json']));
    assert.equal(json.schema, tel.SCHEMA_VERSION);
    assert.equal(json.status, 'completed');
    assert.equal(json.label, 'smoke');
    assert.equal(json.commands.total, 4, 'benchmark subcommands must not count as workload');
    assert.equal(json.map.runs, 2);
    assert.equal(json.context.runs, 1);
    assert.equal(json.impact.runs, 1);
    assert.ok(json.map.cacheHits >= 1, 'the second map run must be a cache hit');
    assert.ok(json.context.bytes > 0);
    assert.ok(json.shell.count > 0, 'git calls are real subprocesses and must be counted');
    assert.ok(json.wallClockDurationMs >= 0);
    assert.equal(json.context.estimatedYindeeContextTokens.label, 'estimate');
    assert.ok(['ok', 'unavailable'].includes(json.claudeTokenUsage.status));
  });

  test('report and compare are available as JSON', () => {
    const root = freshRoot('clicmp');
    makeFixtureRepo(root);
    cli(root, ['benchmark', 'start', '--label', 'a']);
    cli(root, ['map']);
    const a = JSON.parse(cli(root, ['benchmark', 'stop', '--json'])).id;
    cli(root, ['benchmark', 'start', '--label', 'b']);
    cli(root, ['map']);
    cli(root, ['context', 'auth']);
    const b = JSON.parse(cli(root, ['benchmark', 'stop', '--json'])).id;

    const report = cli(root, ['benchmark', 'report', a]);
    assert.match(report, /Yindee Benchmark — a/);
    assert.match(report, /Duration/);
    assert.match(report, /Claude usage/);

    const reportJson = JSON.parse(cli(root, ['benchmark', 'report', a, '--json']));
    assert.equal(reportJson.id, a);

    const cmp = JSON.parse(cli(root, ['benchmark', 'compare', a, b, '--json']));
    assert.equal(cmp.a.id, a);
    assert.equal(cmp.b.id, b);
    assert.equal(cmp.commands.from, 1);
    assert.equal(cmp.commands.to, 2);
    assert.ok('percent' in cmp.duration);

    assert.match(cli(root, ['benchmark', 'list']), new RegExp(a));
  });

  test('a bad run reference exits non-zero instead of inventing a report', () => {
    const root = freshRoot('clibad');
    makeFixtureRepo(root);
    let failed = false;
    try {
      cli(root, ['benchmark', 'report', 'no-such-run']);
    } catch (e) {
      failed = true;
      assert.match(String(e.stdout), /no run matches/);
    }
    assert.ok(failed, 'reporting a missing run must fail loudly');
  });

  test('ordinary commands cost nothing extra when no session is open', () => {
    const root = freshRoot('nooverhead');
    makeFixtureRepo(root);
    const before = cli(root, ['map']);
    cli(root, ['benchmark', 'start']);
    const during = cli(root, ['map']);
    cli(root, ['benchmark', 'stop']);
    assert.equal(before.replace(/rebuilt|hit/g, ''), during.replace(/rebuilt|hit/g, ''),
      'telemetry must not change what a command prints');
    assert.ok(!fs.existsSync(tel.eventsFile(root)), 'stop clears the event log');
  });

  test('verify runs, retries and failures are captured end to end', () => {
    const root = freshRoot('cliverify');
    makeFixtureRepo(root);
    cli(root, ['benchmark', 'start']);
    fs.appendFileSync(path.join(root, 'src/index.js'), '\nexport const b = 2;\n');
    // Two runs: the harness should see one retry.
    for (let i = 0; i < 2; i++) {
      try {
        cli(root, ['verify']);
      } catch {
        /* a failing plan is still a measured run */
      }
    }
    const json = JSON.parse(cli(root, ['benchmark', 'stop', '--json']));
    assert.equal(json.verify.runs, 2);
    assert.equal(json.verify.retries, 1);
    assert.ok(json.verify.stepsRun >= 2, 'each run executes the planned steps');
    assert.equal(json.changes.status, 'ok');
    assert.equal(json.changes.filesChanged, 1);
    assert.equal(json.changes.linesAdded, 2);
  });
});

// --------------------------------------------------------- deferred usage ---

describe('deferred token usage', () => {
  test('report upgrades unavailable usage once the runtime has flushed it', () => {
    const root = freshRoot('deferred');
    const projects = path.join(root, 'cfg', 'projects', 'slug');
    fs.mkdirSync(projects, { recursive: true });
    const transcript = path.join(projects, 'sess-x.jsonl');
    fs.writeFileSync(transcript, '');

    tel.startSession(root, {});
    const { summary } = tel.stopSession(root);
    // The turn had not ended, so nothing was written yet.
    assert.equal(summary.claudeTokenUsage.status, 'unavailable');
    assert.ok(summary.tokenWindow, 'the window must be kept so usage can be resolved later');

    // Point the stored run at the transcript, then let the runtime flush a turn.
    const stored = { ...tel.loadRun(root, summary.id) };
    stored.tokenWindow = { ...stored.tokenWindow, transcript, from: null, to: null };
    fs.writeFileSync(tel.runFile(root, summary.id), JSON.stringify(stored));
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_1',
        timestamp: new Date().toISOString(),
        message: { usage: { input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 9, cache_creation_input_tokens: 10 } },
      }) + '\n',
    );

    const { run, refreshed } = tel.refreshTokenUsage(root, tel.loadRun(root, summary.id));
    assert.equal(refreshed, true);
    assert.equal(run.claudeTokenUsage.status, 'ok');
    assert.equal(run.claudeTokenUsage.totalTokens, 34);
    // And it is persisted, not just returned.
    assert.equal(tel.loadRun(root, summary.id).claudeTokenUsage.totalTokens, 34);
  });

  test('a measured usage is never overwritten by a later read', () => {
    const root = freshRoot('nooverwrite');
    tel.startSession(root, {});
    const { summary } = tel.stopSession(root);
    const withUsage = { ...tel.loadRun(root, summary.id), claudeTokenUsage: { status: 'ok', totalTokens: 42 } };
    fs.writeFileSync(tel.runFile(root, summary.id), JSON.stringify(withUsage));
    const { refreshed, run } = tel.refreshTokenUsage(root, tel.loadRun(root, summary.id));
    assert.equal(refreshed, false);
    assert.equal(run.claudeTokenUsage.totalTokens, 42);
  });

  test('a run with no window stays unavailable rather than guessing', () => {
    const root = freshRoot('nowindow');
    const { refreshed } = tel.refreshTokenUsage(root, { id: 'x', claudeTokenUsage: { status: 'unavailable' } });
    assert.equal(refreshed, false);
  });
});
