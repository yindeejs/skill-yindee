#!/usr/bin/env node
// yindee — token-efficient development harness.
// One CLI, no dependencies. Every command answers a question that would
// otherwise cost an LLM a repository scan.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, asList, toPosix, columns, fmtMs, fmtDuration } from './lib/util.mjs';
import { findRepoRoot, exists, readJson } from './lib/fsx.mjs';
import { loadMap, renderMap, mapPath } from './lib/map.mjs';
import { initProject, renderInit, ensureInitialized, isInitialized } from './lib/init.mjs';
import { computeImpact, renderImpact } from './lib/impact.mjs';
import { runPlan, renderResults, saveResults, resultsPath } from './lib/verify.mjs';
import { computeContext, renderContext } from './lib/context.mjs';
import { buildReview, renderReview } from './lib/review.mjs';
import { install } from './lib/install.mjs';
import * as git from './lib/gitx.mjs';
import { have, shellStats } from './lib/sh.mjs';
import * as tel from './lib/telemetry.mjs';
import { readTokenUsage } from './lib/tokens.mjs';
import { renderReport, compareRuns, renderCompare } from './lib/benchmark.mjs';
import { resolveModules, renderModules, setModule, MODULES } from './lib/registry.mjs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional[0] || 'help';
const ROOT = findRepoRoot(path.resolve(flags.repo ? String(flags.repo) : process.cwd()));
const JSON_OUT = !!flags.json;

// Which behaviors are on for this invocation. Resolved once: Core asks the
// registry, it never hardcodes a module's presence.
const mods = resolveModules(ROOT, flags);
const on = (name) => mods.enabled.has(name);
const VERBOSE = mods.level === 'verbose';
const QUIET = !VERBOSE;

// Telemetry measures what this process actually emitted, so the byte count is
// the real thing rather than a guess at it.
let outputBytes = 0;
const say = (s) => {
  const text = s.replace(/\s*$/, '') + '\n';
  outputBytes += Buffer.byteLength(text, 'utf8');
  process.stdout.write(text);
};
const emit = (obj, text) => (JSON_OUT ? say(JSON.stringify(obj, null, 2)) : say(text));

/** Facts this invocation contributes to an open benchmark session. */
const measured = {};

const HELP = `yindee — token-efficient development harness

  init                      detect stack, packages, commands, CI; build + cache the map
  map                       project layout, packages, commands, CI (cached)
  context "<task>"          which packages / rules / files this task needs
  impact                    changed files -> affected packages -> risk tier -> verify plan
  verify                    run that plan; reports failures only
  review                    bounded diff + path-scoped checklist + failure evidence
  status                    branch, base, PR, CI, pending work
  modules                   which behaviors are on, and who provides them
  install                   vendor the harness into a repo (.claude/skills/yindee)
  doctor                    environment + self-check
  benchmark <sub>           measured telemetry (module: benchmark)

options
  --repo <dir>              repo to operate on (default: cwd, walked up to the root)
  --json                    machine-readable output
  --verbose                 full output; do not truncate lists
  --module x --no-module x  turn a module on/off for this invocation
  modules  list|enable <m>|disable <m>
  init     --refresh
  map      --force
  context  --paths a,b --limit N --max-bytes N --batch N --reference <dir>[,<dir>]
  impact   --base <ref> --mode auto|worktree|staged|branch --tier docs|standard|broad|critical --paths a,b
  verify   --dry-run --bail --only lint,test --tier T --base <ref> --ci --timeout <ms>
  review   --base <ref> --max-lines N --max-per-file N --include-generated --context N
  benchmark start --label "<name>" --restart · report [<run>] · compare <a> <b> · prune --keep N

flow
  benchmark start -> context -> implement -> impact -> verify -> review -> benchmark stop
  (init runs itself on first use — you only run it explicitly to inspect or refresh)`;

const BENCH_HELP = `yindee benchmark — measured, never estimated

  start [--label "<name>"] [--restart]   open a session (idempotent)
  status                                 live counters for the open session
  stop                                   close it and persist the run
  report [<run-id>|latest] [--json]      render a run (defaults to the open session)
  compare <run-a> <run-b> [--json]       deltas; token deltas only when both runs measured them
  list                                   run ids in the bounded history
  prune [--keep N]                       drop everything older than the newest N (default ${tel.DEFAULT_KEEP})`;

/**
 * Load the map and, in the same breath, make sure the project is initialized.
 * Initialization is a side effect of the map load every command already does,
 * which is what lets a user run `/yindee <task>` without ever having run `init`.
 */
function getMap(force = false) {
  const { map, cached } = loadMap(ROOT, { force });
  measured.mapCached = cached;
  const init = ensureInitialized(ROOT, map, { refresh: force });
  measured.initStatus = init.status;
  return { map, cached };
}

function main() {
  switch (cmd) {
    case 'init': {
      const res = initProject(ROOT, { refresh: !!flags.refresh || !!flags.force });
      measured.initStatus = res.status;
      measured.mapCached = res.mapCached;
      if (JSON_OUT) {
        const { map, ...rest } = res;
        return say(JSON.stringify(rest, null, 2));
      }
      return say(renderInit(res));
    }

    case 'map': {
      const { map, cached } = getMap(!!flags.force);
      if (JSON_OUT) return say(JSON.stringify(map, null, 2));
      say(renderMap(map, { verbose: VERBOSE, quiet: QUIET }));
      if (VERBOSE) say(`cache  ${cached ? 'hit' : 'rebuilt'} -> ${toPosix(path.relative(ROOT, mapPath(ROOT)))}`);
      return;
    }

    case 'context': {
      const task = positional.slice(1).join(' ') || String(flags.task || '');
      if (!task && !flags.paths) {
        say('usage: yindee context "<task description>" [--paths a,b]');
        process.exitCode = 2;
        return;
      }
      const { map } = getMap();
      const ctx = computeContext(ROOT, map, task, {
        paths: asList(flags.paths),
        limit: flags.limit ? Number(flags.limit) : undefined,
        maxBytes: flags['max-bytes'] ? Number(flags['max-bytes']) : undefined,
        batch: flags.batch ? Number(flags.batch) : undefined,
        references: asList(flags.reference),
        cwd: process.cwd(),
      });
      measured.files = ctx.files.map((f) => f.file);
      measured.candidates = ctx.budget.candidates;
      measured.selected = ctx.budget.selected.length;
      measured.selectedBytes = ctx.budget.bytes;
      measured.budgetHit = !ctx.budget.withinBudget;
      measured.exploration = ctx.exploration.level;
      measured.phases = ctx.exploration.decomposition.length;
      measured.references = ctx.references.length;
      measured.referencesUnavailable = ctx.references.filter((r) => !r.available).length;
      measured.referencePaths = ctx.references.filter((r) => r.available).map((r) => r.path);
      return emit(
        ctx,
        renderContext(ctx, map, toPosix(path.relative(ROOT, SKILL_ROOT) || SKILL_ROOT), {
          quiet: QUIET || !!flags.quiet,
          verbose: VERBOSE,
        }),
      );
    }

    case 'impact': {
      const { map } = getMap();
      const impact = computeImpact(ROOT, map, {
        base: flags.base ? String(flags.base) : null,
        mode: flags.mode ? String(flags.mode) : 'auto',
        tier: flags.tier ? String(flags.tier) : null,
        paths: asList(flags.paths),
        includeGenerated: !!flags['include-generated'],
      });
      measured.files = impact.files.map((f) => f.path);
      measured.tier = impact.tier;
      return emit(impact, renderImpact(impact, { verbose: VERBOSE, quiet: QUIET }));
    }

    case 'verify': {
      const { map } = getMap();
      const impact = computeImpact(ROOT, map, {
        base: flags.base ? String(flags.base) : null,
        mode: flags.mode ? String(flags.mode) : 'auto',
        tier: flags.tier ? String(flags.tier) : null,
        paths: asList(flags.paths),
      });

      let steps = impact.steps;
      if (flags.ci) {
        steps = (map.ci.commands || []).map((c, i) => ({ id: `ci:${i + 1}`, cmd: c, why: 'declared in CI' }));
        if (!steps.length) {
          return emit({ steps: [] }, `verify --ci: no runnable commands found in ${map.ci.provider || 'CI config'}` +
            (map.ci.files.length ? ` (${map.ci.files.join(', ')})` : ' — no CI detected'));
        }
      }
      const only = asList(flags.only);
      if (only.length) steps = steps.filter((s) => only.some((o) => s.id.includes(o)));

      if (!steps.length) {
        return emit(
          { ...impact, results: [] },
          `${renderImpact(impact, { verbose: VERBOSE, quiet: QUIET })}\n\nverify [${impact.tier}] nothing to run`,
        );
      }
      if (flags['dry-run']) {
        return emit({ tier: impact.tier, steps }, `verify [${impact.tier}] dry run:\n` + columns(steps.map((s) => ['  ' + s.id, s.cmd])));
      }

      const clock = tel.timer();
      const results = runPlan(ROOT, steps, {
        bail: !!flags.bail,
        timeout: flags.timeout ? Number(flags.timeout) : undefined,
        maxLines: flags['max-lines'] ? Number(flags['max-lines']) : 40,
        onStep: (s) => !JSON_OUT && process.stderr.write(`  .. ${s.id}\n`),
      });
      const totalMs = clock.ms();
      measured.tier = impact.tier;
      measured.steps = steps.length;
      measured.stepsRun = results.filter((r) => r.status !== 'skip').length;
      measured.failures = results.filter((r) => r.status === 'fail' || r.status === 'timeout').length;
      measured.verifyMs = totalMs;
      saveResults(ROOT, { tier: impact.tier, base: impact.base, files: impact.files.map((f) => f.path), results, totalMs });
      if (results.some((r) => r.status === 'fail' || r.status === 'timeout')) process.exitCode = 1;
      return emit({ tier: impact.tier, results, totalMs }, renderResults(results, { tier: impact.tier, totalMs }));
    }

    case 'review': {
      const { map } = getMap();
      const impact = computeImpact(ROOT, map, {
        base: flags.base ? String(flags.base) : null,
        mode: flags.mode ? String(flags.mode) : 'auto',
        tier: flags.tier ? String(flags.tier) : null,
      });
      const review = buildReview(ROOT, map, impact, {
        maxLines: flags['max-lines'] ? Number(flags['max-lines']) : undefined,
        maxPerFile: flags['max-per-file'] ? Number(flags['max-per-file']) : undefined,
        includeGenerated: !!flags['include-generated'],
        context: flags.context ? Number(flags.context) : undefined,
      });
      return emit(
        { impact, review },
        renderReview(review, impact, map, toPosix(path.relative(ROOT, SKILL_ROOT) || SKILL_ROOT)),
      );
    }

    case 'status': {
      const { map } = getMap();
      const st = git.state(ROOT);
      if (!st.isRepo) return emit({ isRepo: false }, `status not a git repository (${ROOT})`);
      const gh = flags['no-gh'] ? { available: false } : git.ghContext(ROOT, st.branch);
      const impact = computeImpact(ROOT, map, {});
      const out = [];
      out.push(
        `branch ${st.branch}${st.base && st.base !== st.branch ? ` (base ${st.base})` : ''}` +
          (st.aheadBehind ? `  ahead ${st.aheadBehind.ahead}/behind ${st.aheadBehind.behind} of ${st.aheadBehind.upstream}` : '  no upstream') +
          (st.worktrees > 1 ? `  · ${st.worktrees} worktrees` : ''),
      );
      out.push(`work   ${impact.files.length} changed file(s) · tier ${impact.tier}${st.dirty ? ' · dirty' : ''}`);
      if (gh.pr) {
        const c = gh.pr.checks;
        out.push(
          `pr     #${gh.pr.number} ${gh.pr.draft ? '(draft) ' : ''}${gh.pr.title}` +
            (c.total ? `  checks ${c.total - c.failing - c.pending}/${c.total} ok${c.failing ? `, ${c.failing} FAILING` : ''}${c.pending ? `, ${c.pending} pending` : ''}` : ''),
        );
      } else if (gh.authed) {
        out.push('pr     none open for this branch');
      }
      if (gh.issue) {
        out.push(`issue  #${gh.issue.number} [${gh.issue.state}] ${gh.issue.title}` + (gh.issue.milestone ? `  milestone: ${gh.issue.milestone}` : ''));
      }
      if (!gh.available) out.push('gh     not installed — GitHub state unavailable');
      else if (!gh.authed) out.push('gh     not authenticated (`gh auth login`)');
      const last = readJson(resultsPath(ROOT));
      if (last) {
        const bad = (last.results || []).filter((r) => r.status !== 'ok' && r.status !== 'skip');
        out.push(`verify last run [${last.tier}] ${bad.length ? `${bad.length} failing: ${bad.map((r) => r.id).join(', ')}` : 'all green'} (${fmtMs(last.totalMs || 0)})`);
      }
      return emit({ git: st, gh, impact: { tier: impact.tier, files: impact.files.length } }, out.join('\n'));
    }

    case 'install': {
      const target = path.resolve(String(flags.target || ROOT));
      const res = install(SKILL_ROOT, target, { dryRun: !!flags['dry-run'], force: !!flags.force });
      return emit(res, `install ${flags['dry-run'] ? '(dry run) ' : ''}-> ${target}\n` + res.actions.map((a) => '  ' + a).join('\n'));
    }

    case 'doctor': {
      const { map, cached } = getMap();
      const rows = [];
      rows.push(['node', process.version, 'ok']);
      rows.push(['repo root', toPosix(ROOT), exists(path.join(ROOT, '.git')) ? 'git' : 'no git']);
      rows.push(['stacks', map.stacks.join('+') || 'none detected', map.stacks.length ? 'ok' : 'CHECK']);
      rows.push(['packages', String(map.packages.length), map.packages.length ? 'ok' : 'CHECK']);
      rows.push(['map cache', toPosix(path.relative(ROOT, mapPath(ROOT))), cached ? 'hit' : 'rebuilt']);
      rows.push(['initialized', isInitialized(ROOT) ? 'yes' : 'no', measured.initStatus || 'unknown']);
      rows.push(['frameworks', map.frameworks?.join(', ') || '(none declared)', map.typescript ? 'typescript' : '-']);
      for (const key of ['fmtCheck', 'lint', 'typecheck', 'test', 'build']) {
        const c = map.commands[key];
        rows.push([`cmd ${key}`, c || '(none detected)', c ? (have(c.trim().split(/\s+/)[0]) ? 'ok' : 'tool missing') : '-']);
      }
      rows.push(['ci', map.ci.provider || '(none)', map.ci.files.length ? `${map.ci.files.length} file(s)` : '-']);
      rows.push(['gh cli', have('gh') ? 'installed' : 'missing', have('gh') ? 'ok' : 'optional']);
      rows.push([
        'modules on',
        [...mods.enabled].join(' ') || '(none)',
        `level ${mods.level}`,
      ]);
      for (const r of mods.resolved.filter((x) => x.enabled && x.active.type === 'skill')) {
        rows.push([`  ${r.module}`, `${r.active.id} (skill)`, r.active.invocable === false ? 'defer only' : 'ok']);
      }
      if (on('benchmark')) {
        const bench = tel.statusOf(ROOT);
        rows.push([
          'benchmark',
          bench.active ? `running ${bench.session.id}` : bench.corrupt ? 'corrupt session state' : 'no session',
          `${tel.listRuns(ROOT).length} stored run(s)`,
        ]);
        // Whether ACTUAL Claude token usage is reachable here — the answer decides
        // between a measured number and an honest `unavailable`.
        const usage = readTokenUsage({});
        rows.push([
          'claude tokens',
          usage.status === 'ok' ? usage.source : 'unavailable',
          usage.status === 'ok' ? `ok (${usage.requests} request(s) in transcript)` : usage.reason,
        ]);
      }
      const missing = ['frontend', 'backend', 'database', 'security'].filter(
        (r) => !exists(path.join(SKILL_ROOT, 'rules', `${r}.md`)),
      );
      rows.push(['rules', missing.length ? `missing: ${missing.join(', ')}` : 'frontend backend database security', missing.length ? 'CHECK' : 'ok']);
      return emit({ map, rows }, columns(rows));
    }

    case 'modules': {
      const sub = positional[1] || 'list';
      if (sub === 'enable' || sub === 'disable') {
        const name = positional[2];
        if (!name) {
          say(`usage: yindee modules ${sub} <${Object.keys(MODULES).join('|')}>`);
          process.exitCode = 2;
          return;
        }
        const res = setModule(ROOT, name, sub === 'enable');
        // Re-resolve so the table reflects the write we just made.
        const next = resolveModules(ROOT, flags);
        return emit(
          { ...res, ...next, source: Object.fromEntries(next.source) },
          `modules ${name} ${sub}d in ${toPosix(path.relative(ROOT, res.file))}` +
            (res.also.length ? ` (also enabled: ${res.also.join(', ')})` : '') +
            '\n\n' +
            renderModules(next, { verbose: VERBOSE }),
        );
      }
      if (sub !== 'list') {
        say(`usage: yindee modules [list|enable <m>|disable <m>]`);
        process.exitCode = 2;
        return;
      }
      return emit({ ...mods, enabled: [...mods.enabled], source: Object.fromEntries(mods.source) },
        renderModules(mods, { verbose: VERBOSE }));
    }

    case 'benchmark':
      // The module gate, not a removal: every subcommand still exists behind it.
      if (!on('benchmark')) {
        return emit(
          { module: 'benchmark', enabled: false },
          'benchmark disabled — enable: yindee modules enable benchmark  (or YINDEE_MODULES=benchmark)',
        );
      }
      return benchmark(positional[1] || 'status');

    default:
      say(HELP);
      if (cmd !== 'help' && cmd !== '--help') process.exitCode = 2;
  }
}

function benchmark(sub) {
  switch (sub) {
    case 'start': {
      const res = tel.startSession(ROOT, {
        label: flags.label ? String(flags.label) : null,
        restart: !!flags.restart || !!flags.force,
      });
      const s = res.session;
      return emit(res, res.created
        ? `benchmark started ${s.id}${s.label ? ` (${s.label})` : ''} at ${s.startedAt}` +
            (s.claudeSessionId ? `\n  claude session ${s.claudeSessionId}` : '\n  no claude session id — token usage will be unavailable') +
            (s.gitCommit ? `\n  base commit    ${s.gitCommit.slice(0, 12)}` : '\n  not a git repo — change counts will be unavailable')
        : `benchmark already running ${s.id} (since ${s.startedAt}) — use --restart to replace it`);
    }

    case 'status': {
      const st = tel.statusOf(ROOT, { tokens: !!flags.tokens });
      if (st.corrupt) return emit(st, `benchmark session state is corrupt (${st.file}) — run: yindee benchmark stop`);
      if (!st.active) {
        const ids = tel.listRuns(ROOT);
        return emit({ active: false, runs: ids }, `benchmark no session running` +
          (ids.length ? `\n  ${ids.length} stored run(s), latest ${ids[0]}` : '\n  no stored runs'));
      }
      const sm = st.summary;
      return emit(st, `benchmark ${sm.id} running for ${fmtDuration(sm.wallClockDurationMs)}` +
        `\n  ${sm.commands.total} yindee command(s) · ${sm.verify.runs} verify run(s) · ${sm.shell.count} shell command(s)` +
        `\n  context ${sm.context.bytes} B · ${sm.context.filesSuggested} file(s) suggested`);
    }

    case 'stop': {
      const res = tel.stopSession(ROOT, { keep: flags.keep ? Number(flags.keep) : undefined });
      if (!res.stopped) return emit(res, `benchmark ${res.reason}`);
      return emit(res.summary, renderReport(res.summary));
    }

    case 'report': {
      const ref = positional[2] || (flags.run ? String(flags.run) : null);
      if (!ref) {
        const st = tel.statusOf(ROOT, { tokens: true });
        if (st.active) return emit(st.summary, renderReport(st.summary));
      }
      let run = tel.loadRun(ROOT, ref);
      if (run && !run.corrupt) run = tel.refreshTokenUsage(ROOT, run).run;
      if (!run) {
        process.exitCode = 2;
        return emit({ error: 'no such run' }, `benchmark no run matches "${ref || 'latest'}" (yindee benchmark list)`);
      }
      if (run.corrupt) {
        process.exitCode = 1;
        return emit({ error: 'corrupt run', id: run.id }, `benchmark run ${run.id} is unreadable — its file is corrupt`);
      }
      return emit(run, renderReport(run));
    }

    case 'compare': {
      const [refA, refB] = [positional[2], positional[3]];
      if (!refA || !refB) {
        process.exitCode = 2;
        return emit({ error: 'two runs required' }, 'usage: yindee benchmark compare <run-a> <run-b>');
      }
      const a = tel.loadRun(ROOT, refA);
      const b = tel.loadRun(ROOT, refB);
      const bad = [!a || a.corrupt ? refA : null, !b || b.corrupt ? refB : null].filter(Boolean);
      if (bad.length) {
        process.exitCode = 2;
        return emit({ error: 'unreadable run(s)', refs: bad }, `benchmark cannot read run(s): ${bad.join(', ')}`);
      }
      const cmp = compareRuns(a, b);
      return emit(cmp, renderCompare(cmp));
    }

    case 'list': {
      const ids = tel.listRuns(ROOT);
      if (JSON_OUT) return say(JSON.stringify({ runs: ids }, null, 2));
      if (!ids.length) return say('benchmark no stored runs');
      const rows = ids.map((id) => {
        const r = tel.loadRun(ROOT, id);
        if (!r || r.corrupt) return ['  ' + id, '(corrupt)', '', ''];
        return ['  ' + id, fmtDuration(r.wallClockDurationMs), `${r.commands.total} cmd`, r.label || ''];
      });
      return say(columns(rows));
    }

    case 'prune': {
      const res = tel.pruneRuns(ROOT, flags.keep !== undefined ? Number(flags.keep) : tel.DEFAULT_KEEP);
      return emit(res, `benchmark kept ${res.kept} run(s), removed ${res.removed.length}` +
        (res.removed.length ? `: ${res.removed.join(', ')}` : ''));
    }

    default:
      say(BENCH_HELP);
      process.exitCode = 2;
  }
}

const invocation = tel.timer();
try {
  main();
} catch (err) {
  say(`yindee: ${err?.message || err}`);
  if (process.env.YINDEE_DEBUG) say(String(err?.stack || ''));
  process.exitCode = 1;
} finally {
  // `benchmark` is the instrument, not the workload — measuring it would count
  // reading the meter as work. Everything else contributes exactly one event,
  // and only when the telemetry module is on.
  if (on('telemetry') && cmd !== 'benchmark' && cmd !== 'modules' && cmd !== 'help' && cmd !== '--help') {
    tel.record(ROOT, {
      cmd,
      ms: invocation.ms(),
      outputBytes,
      shellCount: shellStats.count,
      shellMs: shellStats.ms,
      exitCode: process.exitCode || 0,
      json: JSON_OUT,
      ...measured,
    });
  }
}
