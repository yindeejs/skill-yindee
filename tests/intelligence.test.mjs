// Project intelligence self-tests: init, automatic init, the context budget,
// reference repositories and the exploration policy.
//
// The fixture is the failure this file exists to prevent: a component library
// (repo A) to be modernised against a reference design system (repo B). The
// assertions are about what Yindee *recommends* — a broad task must come back
// decomposed, never as permission to go and read both repositories.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildMap, loadMap } from '../scripts/lib/map.mjs';
import { initProject, ensureInitialized, readInit, initFingerprint, isInitialized } from '../scripts/lib/init.mjs';
import { computeContext } from '../scripts/lib/context.mjs';
import { applyBudget, budgetFor, DEFAULT_BUDGET } from '../scripts/lib/budget.mjs';
import { assessExploration, decompose, LEVELS } from '../scripts/lib/explore.mjs';
import { resolveReference, loadReferenceMap, queryReference } from '../scripts/lib/reference.mjs';
import { aggregate } from '../scripts/lib/telemetry.mjs';
import { readAgentActivity } from '../scripts/lib/tokens.mjs';
import { renderReport } from '../scripts/lib/benchmark.mjs';
import { makeComponentLibrary, makeReferenceDesignSystem, write as w, hasGit } from './fixtures/two-repo.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'yindee.mjs');

let TMP;

const cli = (root, args) =>
  execFileSync(process.execPath, [CLI, ...args, '--repo', root], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '' },
  });

// ------------------------------------------------------------- fixtures ---

let LIB;
let REF;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yindee-intel-'));
  LIB = path.join(TMP, 'kairo-ui');
  REF = path.join(TMP, 'nongmuek-ref');
  makeComponentLibrary(LIB);
  makeReferenceDesignSystem(REF);
});
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* windows file locks */
  }
});

let seq = 0;
/** An isolated copy of the library fixture, for tests that mutate it. */
function freshLib() {
  const root = path.join(TMP, `lib-${seq++}`);
  makeComponentLibrary(root);
  return root;
}

// ----------------------------------------------------------------- init ---

describe('init', () => {
  test('first run detects the project without reading any source', () => {
    const root = freshLib();
    const res = initProject(root);
    assert.equal(res.status, 'created');
    assert.equal(res.firstRun, true);
    const s = res.summary;
    assert.equal(s.project, path.basename(root));
    assert.equal(s.packageManager, 'pnpm');
    assert.equal(s.workspace, true);
    assert.equal(s.packages, 3);
    assert.ok(s.stack.includes('TypeScript'), `stack was ${s.stack.join('/')}`);
    assert.ok(s.stack.includes('React'), `stack was ${s.stack.join('/')}`);
    assert.equal(s.ci.provider, 'GitHub Actions');
    assert.ok(s.commands.lint && s.commands.test);
    assert.ok(fs.existsSync(path.join(root, '.claude', 'yindee', 'init.json')));
  });

  test('a repeated run on an unchanged repo rebuilds nothing', () => {
    const root = freshLib();
    initProject(root);
    const before = fs.readFileSync(path.join(root, '.claude', 'yindee', 'init.json'), 'utf8');
    const again = initProject(root);
    assert.equal(again.status, 'valid');
    assert.equal(again.mapCached, true);
    assert.equal(again.persisted, false);
    assert.equal(fs.readFileSync(path.join(root, '.claude', 'yindee', 'init.json'), 'utf8'), before);
  });

  test('--refresh rebuilds deterministically and yields the same fingerprint', () => {
    const root = freshLib();
    const first = initProject(root);
    const refreshed = initProject(root, { refresh: true });
    assert.equal(refreshed.status, 'refreshed');
    assert.equal(refreshed.mapCached, false);
    assert.equal(refreshed.fingerprint, first.fingerprint);
    assert.deepEqual(refreshed.summary, first.summary);
  });

  test('a moved manifest invalidates the fingerprint and updates the state', () => {
    const root = freshLib();
    const first = initProject(root);
    w(root, 'packages/extra/package.json', { name: '@kairo/extra', main: 'src/index.ts' });
    w(root, 'packages/extra/src/index.ts', 'export const x = 1;\n');
    const after = initProject(root);
    assert.equal(after.status, 'updated');
    assert.notEqual(after.fingerprint, first.fingerprint);
    assert.equal(after.summary.packages, 4);
    assert.equal(readInit(root).runs, 2);
  });

  test('ensureInitialized is what every command calls, and only writes when something moved', () => {
    const root = freshLib();
    const { map } = loadMap(root);
    const created = ensureInitialized(root, map);
    assert.equal(created.status, 'created');
    assert.equal(created.wrote, true);
    const valid = ensureInitialized(root, map);
    assert.equal(valid.status, 'valid');
    assert.equal(valid.wrote, false);
    assert.equal(valid.fingerprint, initFingerprint(map));
  });

  test('the CLI initializes automatically — a task never has to run init first', () => {
    const root = freshLib();
    assert.equal(isInitialized(root), false);
    cli(root, ['context', 'update the Button component']);
    assert.equal(isInitialized(root), true);
    assert.equal(readInit(root).initVersion, 1);
  });

  test('--json carries the summary and omits the full map', () => {
    const root = freshLib();
    const out = JSON.parse(cli(root, ['init', '--json']));
    assert.equal(out.status, 'created');
    assert.equal(out.map, undefined);
    assert.equal(out.summary.packageManager, 'pnpm');
    assert.equal(typeof out.fingerprint, 'string');
  });

  test('the idempotent run says so in three lines', () => {
    const root = freshLib();
    cli(root, ['init']);
    const out = cli(root, ['init']);
    assert.match(out, /Project already initialized\./);
    assert.match(out, /Map cache valid\./);
    assert.match(out, /No rebuild required\./);
  });
});

// --------------------------------------------------------------- budget ---

describe('context budget', () => {
  const cand = (n, score) => ({ file: `f${n}.ts`, score, tags: 'name' });

  test('everything under the ceiling is one batch', () => {
    const root = freshLib();
    const files = ['packages/tokens/src/tokens.ts', 'packages/tokens/src/theme.ts'].map((f, i) => ({
      file: f, score: 10 - i, tags: 'name',
    }));
    const b = applyBudget(root, files, DEFAULT_BUDGET);
    assert.equal(b.selected.length, 2);
    assert.equal(b.withinBudget, true);
    assert.equal(b.batches, 1);
    assert.ok(b.bytes > 0);
    assert.equal(b.estimatedTokens.label, 'estimate');
  });

  test('an oversized candidate set is split and ranked, never truncated silently', () => {
    const root = freshLib();
    const files = Array.from({ length: 10 }, (_, i) => cand(i, 100 - i));
    for (let i = 0; i < 10; i++) w(root, `f${i}.ts`, 'x'.repeat(1000));
    const b = applyBudget(root, files, { maxFiles: 12, maxBytes: 3000, maxCandidates: 200 });
    assert.equal(b.withinBudget, false);
    assert.equal(b.batches, 4);
    assert.equal(b.selected.length, 3);
    assert.equal(b.deferred.length, 7);
    assert.equal(b.selected.length + b.deferred.length, 10);
    // Rank order survives the split: the best candidates are in batch 1.
    assert.deepEqual(b.selected.map((f) => f.file), ['f0.ts', 'f1.ts', 'f2.ts']);
    assert.match(b.reason, /byte ceiling/);
  });

  test('a later batch returns the next-ranked slice', () => {
    const root = freshLib();
    const files = Array.from({ length: 10 }, (_, i) => cand(i, 100 - i));
    for (let i = 0; i < 10; i++) w(root, `f${i}.ts`, 'x'.repeat(1000));
    const b = applyBudget(root, files, { maxFiles: 12, maxBytes: 3000, maxCandidates: 200 }, { batch: 2 });
    assert.equal(b.batch, 2);
    assert.deepEqual(b.selected.map((f) => f.file), ['f3.ts', 'f4.ts', 'f5.ts']);
  });

  test('the file ceiling binds even when the files are tiny', () => {
    const root = freshLib();
    const files = Array.from({ length: 8 }, (_, i) => cand(i, 100 - i));
    for (let i = 0; i < 8; i++) w(root, `f${i}.ts`, 'x');
    const b = applyBudget(root, files, { maxFiles: 3, maxBytes: 999_999, maxCandidates: 200 });
    assert.equal(b.selected.length, 3);
    assert.match(b.reason, /file ceiling/);
  });

  test('a single file larger than the ceiling is still delivered, alone', () => {
    const root = freshLib();
    w(root, 'huge.ts', 'x'.repeat(5000));
    const b = applyBudget(root, [cand('huge', 10)].map(() => ({ file: 'huge.ts', score: 10, tags: 'name' })), {
      maxFiles: 12, maxBytes: 1000, maxCandidates: 200,
    });
    assert.equal(b.selected.length, 1);
    assert.equal(b.bytes, 5000);
  });

  test('repo config overrides the defaults, flags override the config', () => {
    assert.equal(budgetFor({}).maxFiles, DEFAULT_BUDGET.maxFiles);
    assert.equal(budgetFor({ context: { maxFiles: 40 } }).maxFiles, 40);
    assert.equal(budgetFor({ context: { maxFiles: 40 } }, { maxFiles: 5 }).maxFiles, 5);
    // Nonsense values fall back rather than producing an empty selection.
    assert.equal(budgetFor({ context: { maxFiles: 0 } }).maxFiles, DEFAULT_BUDGET.maxFiles);
    assert.equal(budgetFor({}, { maxBytes: undefined }).maxBytes, DEFAULT_BUDGET.maxBytes);
  });

  test('context reports candidates and selection separately', () => {
    const root = freshLib();
    const map = buildMap(root);
    const ctx = computeContext(root, map, 'restyle the Button component', { limit: 2 });
    assert.ok(ctx.budget.candidates >= ctx.files.length);
    assert.ok(ctx.files.length <= 2);
    assert.equal(ctx.budget.selected.length, ctx.files.length);
  });

  test('the CLI exposes the budget and its next batch', () => {
    const root = freshLib();
    const out = cli(root, ['context', 'modernize every component', '--paths', 'packages/ui', '--max-bytes', '300']);
    assert.match(out, /^budget .*batch 1\/\d+/m);
    assert.match(out, /--batch 2/);
    const second = JSON.parse(
      cli(root, ['context', 'modernize every component', '--paths', 'packages/ui', '--max-bytes', '300', '--batch', '2', '--json']),
    );
    assert.equal(second.budget.batch, 2);
  });
});

// ------------------------------------------------------------- selection ---

describe('scope fill', () => {
  test('an explicitly scoped lookup offers the scope source, not just its entry point', () => {
    const root = freshLib();
    const map = buildMap(root);
    // Nothing in this wording names a file in the tokens package.
    const ctx = computeContext(root, map, 'modernize the design foundations', { paths: ['packages/tokens'] });
    const names = ctx.files.map((f) => path.basename(f.file)).sort();
    assert.ok(names.includes('tokens.ts'), `got ${names.join(', ')}`);
    assert.ok(names.includes('theme.ts'), `got ${names.join(', ')}`);
    assert.ok(ctx.files.some((f) => f.tags.includes('scope')));
  });

  test('fill never fires without a scope, so an unscoped repo is not dumped', () => {
    const root = freshLib();
    const map = buildMap(root);
    const ctx = computeContext(root, map, 'zzzznomatch qqqqnothing');
    assert.equal(ctx.packages.length, 0);
    assert.equal(ctx.files.length, 0);
    assert.notEqual(ctx.exploration.level, 'none');
  });

  test('keyword and content matches still outrank filler', () => {
    const root = freshLib();
    const map = buildMap(root);
    const ctx = computeContext(root, map, 'update the Button component', { paths: ['packages/ui'] });
    const rank = (needle) => ctx.files.findIndex((f) => f.file.includes(needle));
    assert.ok(rank('Button.tsx') >= 0, 'the named component was not selected');
    // A file the task names must beat a same-scope file it does not.
    for (const other of ['Checkbox', 'Tooltip']) {
      const r = rank(other);
      assert.ok(r === -1 || rank('Button.tsx') < r, `${other} outranked Button`);
    }
  });
});

// ---------------------------------------------------------- exploration ---

describe('exploration policy', () => {
  const ctxFor = (root, task, opts) => {
    const map = buildMap(root);
    return { map, ctx: computeContext(root, map, task, opts) };
  };

  test('never invents a level outside the vocabulary', () => {
    const { map, ctx } = ctxFor(LIB, 'restyle the Button component');
    assert.ok(LEVELS.includes(assessExploration(LIB, map, ctx).level));
  });

  test('a trivial, deterministically answerable task needs no exploration at all', () => {
    const { ctx } = ctxFor(LIB, 'restyle the Button component');
    assert.ok(ctx.files.length > 0, 'expected yindee to name files');
    assert.equal(ctx.exploration.level, 'none');
    assert.equal(ctx.exploration.maxAgents, 0);
    assert.equal(ctx.exploration.agentBrief, null);
  });

  test('a discoverable task never reaches broad, whatever the wording', () => {
    for (const task of [
      'add a Toast variant',
      'update the tokens package spacing scale',
      'fix the Modal component',
    ]) {
      const { ctx } = ctxFor(LIB, task);
      assert.notEqual(ctx.exploration.level, 'broad', `task "${task}" escalated`);
      assert.equal(ctx.exploration.allowBroad, false);
    }
  });

  test('a semantic ask may buy one scoped agent, never a parallel fleet', () => {
    const { ctx } = ctxFor(LIB, 'why is the Modal focus trap inconsistent with the rest');
    assert.ok(['targeted', 'semantic'].includes(ctx.exploration.level), `level was ${ctx.exploration.level}`);
    assert.equal(ctx.exploration.maxAgents, 1);
    assert.equal(ctx.exploration.parallel, false);
    assert.ok(ctx.exploration.scope.length > 0);
    assert.match(ctx.exploration.agentBrief, /path-scoped/);
  });

  test('a broad task is decomposed instead of widening the search', () => {
    const { ctx } = ctxFor(LIB, 'modernize the entire component library while preserving the public API');
    assert.equal(ctx.exploration.breadth, 'broad');
    assert.notEqual(ctx.exploration.level, 'broad');
    assert.equal(ctx.exploration.allowBroad, false);
    assert.ok(ctx.exploration.decomposition.length >= 2, 'expected phases');
    // Foundations first: the package nothing depends on leads.
    assert.equal(ctx.exploration.decomposition[0].title, '@kairo/tokens');
    for (const phase of ctx.exploration.decomposition) {
      assert.ok(phase.paths.length > 0);
      assert.match(phase.command, /--paths /);
    }
  });

  test('phases are ordered by dependency depth, foundations before consumers', () => {
    const map = buildMap(LIB);
    const ctx = computeContext(LIB, map, 'modernize every component in the library');
    const titles = decompose(LIB, map, ctx).map((p) => p.title);
    assert.equal(titles[0], '@kairo/tokens');
    assert.ok(titles.indexOf('@kairo/ui') < titles.indexOf('@kairo/docs'));
  });

  test('a single package decomposes into its source areas, not into one phase', () => {
    const map = buildMap(LIB);
    const ctx = computeContext(LIB, map, 'modernize the whole ui surface', { paths: ['packages/ui'] });
    const phases = decompose(LIB, map, ctx);
    assert.ok(phases.length >= 3, `expected several areas, got ${phases.map((p) => p.title).join(',')}`);
    assert.ok(phases.every((p) => p.paths[0].startsWith('packages/ui')));
    assert.ok(!phases.some((p) => p.paths[0].includes('.claude')), 'generated paths leaked into phases');
  });

  test('an already-phased lookup is not decomposed again', () => {
    const { ctx } = ctxFor(LIB, 'modernize the entire library', { paths: ['packages/tokens'] });
    assert.deepEqual(ctx.exploration.decomposition, []);
  });

  test('the broad requirement is stated, not merely implied', () => {
    const { ctx } = ctxFor(LIB, 'why does the entire library render twice');
    assert.match(ctx.exploration.requirement, /deterministic retrieval insufficient because/);
  });
});

// ------------------------------------------------------------ reference ---

describe('reference repositories', () => {
  test('a relative path resolves against the main repo', () => {
    const r = resolveReference(LIB, '../nongmuek-ref');
    assert.equal(r.available, true);
    assert.equal(path.resolve(r.root), path.resolve(REF));
  });

  test('a missing reference degrades to a note and never throws', () => {
    const r = resolveReference(LIB, '../does-not-exist');
    assert.equal(r.available, false);
    assert.match(r.reason, /path not found/);
  });

  test('the main repo is not a valid reference for itself', () => {
    assert.equal(resolveReference(LIB, LIB).available, false);
  });

  test('the reference map is cached inside the main repo, never written to the reference', () => {
    const root = freshLib();
    const before = fs.readdirSync(REF).sort();
    const first = loadReferenceMap(root, REF);
    assert.equal(first.cached, false);
    const second = loadReferenceMap(root, REF);
    assert.equal(second.cached, true);
    assert.ok(fs.existsSync(path.join(root, '.claude', 'yindee', 'refs')));
    assert.deepEqual(fs.readdirSync(REF).sort(), before, 'the reference checkout was modified');
  });

  test('a reference map cached by an older harness is rebuilt, not trusted', () => {
    const root = freshLib();
    loadReferenceMap(root, REF);
    const dir = path.join(root, '.claude', 'yindee', 'refs');
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
    stale.map.harness = 'harness-from-a-previous-version';
    fs.writeFileSync(file, JSON.stringify(stale));
    assert.equal(loadReferenceMap(root, REF).cached, false);
    assert.equal(loadReferenceMap(root, REF).cached, true);
  });

  test('candidates pair up with the main repo instead of importing the whole reference', () => {
    const root = freshLib();
    const map = buildMap(root);
    const ctx = computeContext(root, map, 'align the design tokens and theme with the reference', {
      references: [REF],
    });
    const ref = ctx.references[0];
    assert.equal(ref.available, true);
    assert.ok(ref.files.length > 0);
    assert.ok(ref.files.length <= 6, 'reference budget was not applied');
    const paired = ref.pairs.map((p) => path.basename(p.reference));
    assert.ok(paired.includes('tokens.ts') || paired.includes('theme.ts'), `pairs were ${JSON.stringify(ref.pairs)}`);
    for (const p of ref.pairs) assert.ok(ctx.files.some((f) => f.file === p.target));
  });

  test('a reference-only file is reported as such, not silently dropped', () => {
    const root = freshLib();
    const map = buildMap(root);
    const ctx = computeContext(root, map, 'adopt the reference typography scale', { references: [REF] });
    const ref = ctx.references[0];
    assert.ok(ref.pairs.length + ref.referenceOnly.length === ref.files.length);
  });

  test('an unavailable reference leaves the main context fully usable', () => {
    const root = freshLib();
    const map = buildMap(root);
    const ctx = computeContext(root, map, 'restyle the Button component', { references: ['../nope'] });
    assert.equal(ctx.references[0].available, false);
    assert.ok(ctx.files.length > 0, 'main context was damaged by a missing reference');
  });

  test('queryReference is safe on a directory that is not a project', () => {
    const empty = path.join(TMP, 'not-a-project');
    fs.mkdirSync(empty, { recursive: true });
    const r = queryReference(freshLib(), empty, 'anything', { tokens: ['anything'], areas: [], files: [] });
    assert.equal(typeof r.available, 'boolean');
    assert.ok(Array.isArray(r.files));
  });

  test('the CLI renders both repos in one bounded block', () => {
    const root = freshLib();
    const out = cli(root, ['context', 'align tokens with the reference design system', '--reference', REF]);
    assert.match(out, /^ref\s+nongmuek-ref/m);
    assert.match(out, /^explore /m);
    assert.match(out, /^budget /m);
  });
});

// ------------------------------------------------------------ telemetry ---

describe('telemetry for the new intelligence', () => {
  const session = { id: 'r1', startedAt: '2026-01-01T00:00:00.000Z', startedAtEpochMs: 0, status: 'completed' };

  test('init, budget, reference and exploration counters are folded in', () => {
    const events = [
      { cmd: 'init', outputBytes: 100, initStatus: 'created' },
      { cmd: 'context', outputBytes: 400, mapCached: true, initStatus: 'valid', candidates: 30, selected: 8, selectedBytes: 4096, budgetHit: true, exploration: 'none', references: 1, referencePaths: ['/ref'], phases: 0 },
      { cmd: 'context', outputBytes: 300, mapCached: true, initStatus: 'valid', candidates: 12, selected: 4, selectedBytes: 2048, budgetHit: false, exploration: 'targeted', references: 1, referencePaths: ['/ref'], referencesUnavailable: 1, phases: 5 },
      { cmd: 'impact', outputBytes: 200, mapCached: true, initStatus: 'updated' },
    ];
    const s = aggregate(session, events, { now: 1000 });
    assert.equal(s.init.runs, 1);
    assert.equal(s.init.created, 1);
    assert.equal(s.init.cacheHits, 2);
    assert.equal(s.init.updates, 1);
    assert.equal(s.map.rebuildsAvoided, 3);
    assert.equal(s.context.candidates, 42);
    assert.equal(s.context.filesSelected, 12);
    assert.equal(s.context.selectedBytes, 6144);
    assert.equal(s.context.budgetHits, 1);
    assert.equal(s.reference.queries, 2);
    assert.equal(s.reference.repos, 1);
    assert.equal(s.reference.unavailable, 1);
    assert.deepEqual(s.exploration.byLevel, { none: 1, targeted: 1 });
    assert.equal(s.exploration.broadRecommended, 0);
    assert.equal(s.exploration.decompositions, 1);
    assert.equal(s.exploration.phases, 5);
  });

  test('a run with no events reports zeroes, not absent sections', () => {
    const s = aggregate(session, [], { now: 1000 });
    assert.equal(s.init.runs, 0);
    assert.equal(s.context.candidates, 0);
    assert.equal(s.exploration.recommendations, 0);
    assert.equal(s.agents.status, 'unavailable');
    const text = renderReport(s);
    assert.match(text, /Initialization/);
    assert.match(text, /Exploration/);
    assert.match(text, /Subagents observed/);
    assert.match(text, /unavailable/);
  });

  test('subagent activity is measured from the transcript, or honestly unavailable', () => {
    const dir = path.join(TMP, 'cfg', 'projects', 'p');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', message: { content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'Explore' } }] } }),
        JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', message: { content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'fast-worker' } }] } }),
        JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', isSidechain: true, requestId: 'r1', message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
        JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', isSidechain: true, requestId: 'r1', message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
        'not json',
      ].join('\n') + '\n',
    );
    const a = readAgentActivity({ transcript: file });
    assert.equal(a.status, 'ok');
    assert.equal(a.spawned, 2);
    assert.equal(a.exploration, 1);
    assert.deepEqual(a.byType, { Explore: 1, 'fast-worker': 1 });
    // De-duplicated by requestId, exactly like token usage.
    assert.equal(a.sidechain.status, 'ok');
    assert.equal(a.sidechain.requests, 1);
    assert.equal(a.sidechain.totalTokens, 120);
  });

  test('zero subagents in a readable transcript is a measurement, not a gap', () => {
    const file = path.join(TMP, 'quiet.jsonl');
    fs.writeFileSync(file, JSON.stringify({ message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    const a = readAgentActivity({ transcript: file });
    assert.equal(a.status, 'ok');
    assert.equal(a.spawned, 0);
    assert.equal(a.exploration, 0);
    assert.equal(a.sidechain.status, 'unavailable');
  });

  test('no transcript is unavailable, never zero', () => {
    const a = readAgentActivity({ sessionId: null, transcript: '/nope', env: {} });
    assert.equal(a.status, 'unavailable');
    assert.match(a.reason, /not running inside a Claude Code session/);
  });

  test('the window bounds what is counted', () => {
    const file = path.join(TMP, 'windowed.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'Explore' } }] } }),
        JSON.stringify({ timestamp: '2026-06-01T00:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'Explore' } }] } }),
      ].join('\n') + '\n',
    );
    assert.equal(readAgentActivity({ transcript: file, from: '2026-03-01T00:00:00.000Z' }).spawned, 1);
  });
});

// ---------------------------------------------------- end-to-end routing ---

describe('the stress test: a broad two-repo task', { skip: !hasGit ? 'git not available' : false }, () => {
  test('comes back decomposed and budgeted, with no broad exploration recommended', () => {
    const root = freshLib();
    const out = cli(root, [
      'context',
      'modernize this UI library using the reference design system while preserving all public APIs',
      '--reference',
      REF,
    ]);
    // Yindee answered the discovery questions itself...
    assert.match(out, /^scope\s+pkgs:/m);
    assert.match(out, /^ref\s+nongmuek-ref/m);
    // ...capped what may be opened...
    assert.match(out, /^budget /m);
    // ...refused to authorise a broad sweep...
    assert.doesNotMatch(out, /^explore BROAD/m);
    assert.match(out, /broad exploration NOT permitted/);
    // ...and turned the size of the task into phases instead.
    assert.match(out, /^phases\s+broad task -> \d+ area\(s\)/m);
  });

  test('the same task through the JSON surface exposes the policy as data', () => {
    const root = freshLib();
    const out = JSON.parse(
      cli(root, ['context', 'modernize the entire library preserving public API', '--reference', REF, '--json']),
    );
    assert.equal(out.exploration.allowBroad, false);
    assert.equal(out.exploration.breadth, 'broad');
    assert.notEqual(out.exploration.level, 'broad');
    assert.ok(out.exploration.decomposition.length >= 2);
    assert.ok(out.budget.limits.maxFiles > 0);
    assert.equal(out.references.length, 1);
  });
});
