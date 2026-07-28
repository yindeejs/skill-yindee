// Project initialization. Everything here is read from manifests, config files
// and git — never from source, and never by asking a model to look around.
//
// `init` is the same work `map` already does, made explicit and given a memory:
// a small state file recording that this repo has been fingerprinted, so a
// second run costs one stat sweep and prints three lines.
import path from 'node:path';
import { readJson, writeJson, exists, ensureLocalExclude } from './fsx.mjs';
import { loadMap, mapPath } from './map.mjs';
import { state as gitState } from './gitx.mjs';
import { sha1, columns, uniq, toPosix } from './util.mjs';

export const INIT_VERSION = 1;
export const initPath = (root) => path.join(root, '.claude', 'yindee', 'init.json');

export const readInit = (root) => readJson(initPath(root));

/** What has to move before the project intelligence is stale. */
export const initFingerprint = (map) => sha1(`${INIT_VERSION}|${map.harness}|${map.fingerprint}`);

const CI_LABELS = {
  'github-actions': 'GitHub Actions', gitlab: 'GitLab CI', circleci: 'CircleCI',
  jenkins: 'Jenkins', azure: 'Azure Pipelines', travis: 'Travis CI', drone: 'Drone',
};

/** Compact, deterministic project summary. Facts only — no prose about the code. */
export function summarize(root, map) {
  const git = map.git || {};
  const live = gitState(root);
  const stack = uniq([
    ...(map.typescript ? ['TypeScript'] : []),
    ...(map.frameworks || []),
    ...map.stacks.filter((s) => s !== 'unknown'),
  ]).slice(0, 4);

  const areas = uniq(map.packages.flatMap((p) => p.areas || []));
  return {
    project: map.root,
    stack,
    packageManager: map.packageManager,
    workspace: !!map.monorepo?.isMonorepo,
    workspaceTool: map.monorepo?.tool || null,
    packages: map.packages.length,
    apps: map.packages.filter((p) => p.kind === 'app').length,
    areas,
    commands: Object.fromEntries(
      ['fmtCheck', 'lint', 'typecheck', 'test', 'build'].filter((k) => map.commands[k]).map((k) => [k, map.commands[k]]),
    ),
    ci: map.ci?.provider ? { provider: CI_LABELS[map.ci.provider] || map.ci.provider, files: map.ci.files } : null,
    git: {
      isRepo: !!git.isRepo,
      branch: git.branch || null,
      base: git.base || null,
      remote: git.remote || null,
      dirty: !!live.dirty,
    },
    docs: uniq([...(map.docs?.agentInstructions || []), ...(map.docs?.architecture || [])]),
    configPresent: !!map.configPresent,
  };
}

/**
 * Bring the project intelligence up to date, writing state only when something
 * actually moved. Called explicitly by `init` and implicitly by every command
 * that loads the map, which is what makes initialization automatic.
 *
 * Returns `status`:
 *   valid      already initialized, fingerprint unchanged — nothing rebuilt
 *   created    first initialization of this repo
 *   updated    the repo moved; intelligence refreshed to match
 *   refreshed  a deterministic refresh was forced
 */
export function ensureInitialized(root, map, { refresh = false } = {}) {
  const prior = readInit(root);
  const fp = initFingerprint(map);
  const known = prior && prior.initVersion === INIT_VERSION && prior.fingerprint === fp;

  const status = refresh ? 'refreshed' : known ? 'valid' : prior ? 'updated' : 'created';
  if (status === 'valid') return { status, state: prior, wrote: false, fingerprint: fp };

  const now = new Date().toISOString();
  const state = {
    initVersion: INIT_VERSION,
    fingerprint: fp,
    root: toPosix(root),
    initializedAt: prior?.initializedAt || now,
    updatedAt: now,
    runs: (prior?.runs || 0) + 1,
    mapVersion: map.mapVersion,
    harness: map.harness,
  };
  let wrote = false;
  try {
    writeJson(initPath(root), state);
    ensureLocalExclude(root);
    wrote = true;
  } catch {
    /* read-only checkout: init is still valid in memory for this process */
  }
  return { status, state, wrote, fingerprint: fp };
}

/**
 * The explicit `yindee init`. Idempotent: an unchanged repo neither rebuilds the
 * map nor rewrites the state file.
 */
export function initProject(root, { refresh = false } = {}) {
  const before = readInit(root);
  const { map, cached } = loadMap(root, { force: refresh });
  const ensured = ensureInitialized(root, map, { refresh });
  return {
    status: ensured.status,
    firstRun: !before,
    mapCached: cached,
    fingerprint: ensured.fingerprint,
    mapFile: toPosix(path.relative(root, mapPath(root))),
    stateFile: toPosix(path.relative(root, initPath(root))),
    persisted: ensured.wrote,
    summary: summarize(root, map),
    map,
  };
}

const yn = (b) => (b ? 'yes' : 'no');

export function renderInit(res) {
  const s = res.summary;
  if (res.status === 'valid') {
    return [
      'Project already initialized.',
      `Map cache ${res.mapCached ? 'valid' : 'rebuilt'}.`,
      res.mapCached ? 'No rebuild required.' : 'Map was rebuilt; fingerprint unchanged.',
      '',
      `${s.project}  ${s.stack.join(' / ') || 'unknown stack'}  ·  ${s.packages} package(s)  ·  fingerprint ${res.fingerprint.slice(0, 8)}`,
    ].join('\n');
  }

  const rows = [
    ['Project', s.project],
    ['Stack', s.stack.join(' / ') || 'unknown'],
    ['Package mgr', s.packageManager],
    ['Workspace', yn(s.workspace) + (s.workspaceTool ? ` (${s.workspaceTool})` : '')],
    ['Packages', String(s.packages) + (s.apps ? ` (${s.apps} app)` : '')],
    ['CI', s.ci ? s.ci.provider : 'none detected'],
  ];
  if (s.git.isRepo) rows.push(['Git', `${s.git.branch || 'detached'}${s.git.dirty ? ' (dirty)' : ''}${s.git.remote ? ` · ${s.git.remote}` : ''}`]);
  const cmds = Object.entries(s.commands);
  if (cmds.length) rows.push(['Commands', cmds.map(([k]) => k).join(', ')]);
  if (s.areas.length) rows.push(['Areas', s.areas.join(', ')]);
  if (s.docs.length) rows.push(['Project rules', s.docs.join(', ')]);

  const out = ['Yindee Init', '─'.repeat(24), columns(rows, 3), ''];
  out.push(
    columns(
      [
        ['Map', res.mapCached ? 'cached' : 'built'],
        ['Fingerprint', res.fingerprint.slice(0, 8)],
        ['Cache', res.status === 'created' ? 'created' : res.status === 'refreshed' ? 'refreshed' : 'updated'],
      ],
      3,
    ),
  );
  out.push('');
  out.push('Context sent to LLM: minimal (no source files were read)');
  out.push('');
  out.push('Ready for tasks.');
  if (!res.persisted) out.push('note   state could not be written — this repo is read-only; init will re-run next time');
  return out.join('\n');
}

/** True when this repo has never been initialized. Used by `doctor`/`status`. */
export const isInitialized = (root) => !!readInit(root) && exists(mapPath(root));
