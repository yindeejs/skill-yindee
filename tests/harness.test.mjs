// Harness self-tests. Zero dependencies — `node --test`.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseToml } from '../scripts/lib/toml.mjs';
import { globToRegex, matchGlob, tokenize, errorExcerpt, columns } from '../scripts/lib/util.mjs';
import { areasOf, isSensitive, rulesFor, isGenerated, NON_CODE_AREAS } from '../scripts/lib/areas.mjs';
import { detect } from '../scripts/lib/detect.mjs';
import { buildMap, loadMap } from '../scripts/lib/map.mjs';
import { computeImpact, packageOf } from '../scripts/lib/impact.mjs';
import { computeContext } from '../scripts/lib/context.mjs';
import { buildReview } from '../scripts/lib/review.mjs';

// Import-smoke: every module must parse and resolve its imports.
import * as sh from '../scripts/lib/sh.mjs';
import * as fsx from '../scripts/lib/fsx.mjs';
import * as gitx from '../scripts/lib/gitx.mjs';
import * as verifyLib from '../scripts/lib/verify.mjs';
import * as installLib from '../scripts/lib/install.mjs';

// --------------------------------------------------------------- fixtures ---

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

function makeNodeMonorepo(root) {
  w(root, 'package.json', {
    name: 'demo', private: true, packageManager: 'pnpm@10.0.0',
    scripts: { lint: 'turbo run lint', typecheck: 'turbo run typecheck', test: 'turbo run test', build: 'turbo run build', 'format:check': 'prettier --check .' },
  });
  w(root, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  w(root, 'turbo.json', { tasks: { build: {}, test: {}, lint: {}, typecheck: {} } });
  w(root, 'tsconfig.json', { compilerOptions: { strict: true } });
  w(root, 'README.md', '# demo\n');
  w(root, 'CLAUDE.md', '# demo\nHouse rules.\n');
  w(root, '.github/workflows/ci.yml', 'name: CI\non: [push]\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run lint\n      - run: pnpm run test\n');

  w(root, 'packages/types/package.json', { name: '@demo/types', main: 'src/index.ts', scripts: { lint: 'eslint .', test: 'vitest run' } });
  w(root, 'packages/types/src/index.ts', 'export type User = { id: string };\n');

  w(root, 'packages/db/package.json', { name: '@demo/db', main: 'src/index.ts', dependencies: { '@demo/types': 'workspace:*' }, scripts: { lint: 'eslint .', test: 'vitest run' } });
  w(root, 'packages/db/src/index.ts', "import type { User } from '@demo/types';\nexport const q = (): User | null => null;\n");
  w(root, 'packages/db/prisma/schema.prisma', 'model User { id String @id }\n');
  w(root, 'packages/db/prisma/migrations/20240101_init/migration.sql', 'CREATE TABLE "User" ("id" TEXT);\n');

  w(root, 'packages/ui/package.json', { name: '@demo/ui', main: 'src/index.tsx', dependencies: { '@demo/types': 'workspace:*' }, scripts: { lint: 'eslint .', test: 'vitest run' } });
  w(root, 'packages/ui/src/index.tsx', 'export const Button = () => null;\n');

  w(root, 'apps/web/package.json', { name: '@demo/web', dependencies: { '@demo/ui': 'workspace:*' }, scripts: { dev: 'next dev', build: 'next build', lint: 'next lint', test: 'vitest run' } });
  w(root, 'apps/web/src/app/page.tsx', 'export default function Page() { return null; }\n');

  w(root, 'apps/api/package.json', { name: '@demo/api', dependencies: { '@demo/db': 'workspace:*' }, scripts: { dev: 'tsx src/index.ts', lint: 'eslint .', test: 'vitest run' } });
  w(root, 'apps/api/src/index.ts', 'export const app = {};\n');
  w(root, 'apps/api/src/middleware/requireAuth.ts', 'export const requireAuth = () => {};\n');

  if (hasGit) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@e.st');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  }
}

function makeCargoWorkspace(root) {
  w(root, 'Cargo.toml', '[workspace]\nresolver = "2"\nmembers = ["crates/*", "apps/*"]\n\n[workspace.dependencies]\nserde = { version = "1", features = ["derive"] }\n');
  w(root, 'rustfmt.toml', 'edition = "2021"\n');
  w(root, 'crates/core/Cargo.toml', '[package]\nname = "demo-core"\nversion = "0.1.0"\n\n[dependencies]\nserde = { workspace = true }\n');
  w(root, 'crates/core/src/lib.rs', 'pub fn hello() {}\n');
  w(root, 'apps/server/Cargo.toml', '[package]\nname = "demo-server"\nversion = "0.1.0"\n\n[dependencies]\ndemo-core = { path = "../../crates/core" }\n');
  w(root, 'apps/server/src/main.rs', 'fn main() {}\n');
  if (hasGit) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@e.st');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  }
}

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yindee-test-'));
  makeNodeMonorepo(path.join(TMP, 'node'));
  makeCargoWorkspace(path.join(TMP, 'cargo'));
});
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* windows file locks */
  }
});

// -------------------------------------------------------------------- toml ---

describe('toml', () => {
  test('parses tables, arrays, inline tables and comments', () => {
    const t = parseToml(`# top comment
[workspace]
resolver = "2"
members = [
  "crates/*",   # globs
  "apps/*",
]

[package]
name = "demo"
edition = "2021"
publish = false

[dependencies]
serde = { version = "1", features = ["derive"] }
tokio = "1"
`);
    assert.equal(t.workspace.resolver, '2');
    assert.deepEqual(t.workspace.members, ['crates/*', 'apps/*']);
    assert.equal(t.package.name, 'demo');
    assert.equal(t.package.publish, false);
    assert.equal(t.dependencies.serde.version, '1');
    assert.deepEqual(t.dependencies.serde.features, ['derive']);
    assert.equal(t.dependencies.tokio, '1');
  });

  test('does not treat # inside strings as a comment', () => {
    const t = parseToml('[a]\nurl = "http://x/#frag"\n');
    assert.equal(t.a.url, 'http://x/#frag');
  });

  test('handles dotted keys and array-of-tables', () => {
    const t = parseToml('[[bin]]\nname = "a"\n[[bin]]\nname = "b"\n[tool.ruff]\nline-length = 100\n');
    assert.equal(t.bin.length, 2);
    assert.equal(t.bin[1].name, 'b');
    assert.equal(t.tool.ruff['line-length'], 100);
  });
});

// -------------------------------------------------------------------- glob ---

describe('glob', () => {
  test('** spans directories, * does not', () => {
    assert.ok(matchGlob('a/b/c/file.ts', '**/file.ts'));
    assert.ok(matchGlob('file.ts', '**/file.ts'), '**/ must also match zero directories');
    assert.ok(!matchGlob('a/b.ts', '*.ts'));
    assert.ok(matchGlob('b.ts', '*.ts'));
  });
  test('brace alternation', () => {
    assert.ok(matchGlob('src/a.tsx', '**/*.{ts,tsx}'));
    assert.ok(!matchGlob('src/a.css', '**/*.{ts,tsx}'));
  });
  test('is anchored', () => {
    assert.ok(!globToRegex('a/b').test('x/a/b'));
  });
});

// ------------------------------------------------------------------- areas ---

describe('areas', () => {
  test('classifies the layers', () => {
    assert.equal(areasOf('packages/db/prisma/migrations/1_init/migration.sql')[0], 'database');
    assert.equal(areasOf('apps/api/src/middleware/requireAuth.ts')[0], 'security');
    assert.equal(areasOf('apps/web/src/components/Button.tsx')[0], 'frontend');
    assert.equal(areasOf('apps/api/src/routes/users.ts')[0], 'backend');
    assert.equal(areasOf('.github/workflows/ci.yml')[0], 'infra');
    assert.equal(areasOf('README.md')[0], 'docs');
  });

  test('plain source files are code, never "other"', () => {
    // Regression: a shared type edit used to classify as "other" and skip verification.
    assert.deepEqual(areasOf('packages/types/src/index.ts'), ['code']);
    assert.ok(!areasOf('packages/types/src/index.ts').every((a) => NON_CODE_AREAS.has(a)));
  });

  test('nested manifests are config, not uncategorised', () => {
    assert.equal(areasOf('crates/core/Cargo.toml')[0], 'config');
    assert.equal(areasOf('packages/db/package.json')[0], 'config');
  });

  test('ML weights under models/ are not a database signal', () => {
    // Regression: `**/models/**` matched ONNX weight files.
    assert.ok(!areasOf('models/yolov8n.onnx').includes('database'));
    assert.ok(areasOf('src/models/user.ts').includes('database'));
  });

  test('test files stay tests even when they live in a layer', () => {
    assert.equal(areasOf('apps/api/tests/auth.test.ts')[0], 'test');
  });

  test('sensitivity covers auth, migrations, CI and lockfiles', () => {
    for (const p of [
      'apps/api/src/auth/login.ts',
      'db/migrations/001.sql',
      '.github/workflows/ci.yml',
      'pnpm-lock.yaml',
      '.env.production',
    ]) {
      assert.ok(isSensitive(p), `${p} should be sensitive`);
    }
    assert.ok(!isSensitive('apps/web/src/components/Button.tsx'));
  });

  test('rulesFor maps areas to rule files', () => {
    assert.deepEqual(rulesFor(['security', 'backend']), ['security', 'backend']);
    assert.deepEqual(rulesFor(['docs']), []);
  });

  test('generated output is recognised', () => {
    assert.ok(isGenerated('pnpm-lock.yaml'));
    assert.ok(isGenerated('apps/web/dist/main.js'));
    assert.ok(!isGenerated('apps/web/src/main.ts'));
  });

  test('the harness own cache and vendored copy are not project code', () => {
    // Regression: `install` then `review` dumped the whole harness into the diff.
    assert.ok(isGenerated('.claude/yindee/map.json'));
    assert.ok(isGenerated('.claude/skills/yindee/scripts/yindee.mjs'));
    assert.ok(!isGenerated('.claude/settings.json'), "a project's own claude config is not ours to hide");
  });
});

// ------------------------------------------------------------------- utils ---

describe('util', () => {
  test('every module exports its public surface', () => {
    for (const [name, mod, fn] of [
      ['sh', sh, 'run'], ['fsx', fsx, 'walk'], ['gitx', gitx, 'changedFiles'],
      ['verify', verifyLib, 'runPlan'], ['install', installLib, 'install'],
    ]) {
      assert.equal(typeof mod[fn], 'function', `${name}.${fn} missing`);
    }
  });

  test('tokenize drops stopwords and short tokens', () => {
    assert.deepEqual(tokenize('Add a refresh token to the login endpoint'), ['refresh', 'token', 'login', 'endpoint']);
  });
  test('errorExcerpt keeps error lines over noise', () => {
    const noise = Array.from({ length: 200 }, (_, i) => `info line ${i}`).join('\n');
    const out = errorExcerpt(noise + '\nerror: boom\nerror: bang\nerror: crash', 10);
    assert.ok(out.includes('error: boom'));
    assert.ok(out.split('\n').length <= 11);
  });
  test('columns aligns without trailing whitespace', () => {
    const out = columns([['a', 'bbb'], ['cc', 'd']]);
    assert.ok(!/ $/m.test(out));
    assert.equal(out.split('\n').length, 2);
  });
});

// ------------------------------------------------------------------ detect ---

describe('detect: node monorepo', () => {
  test('finds workspace packages, manager and tool', () => {
    const d = detect(path.join(TMP, 'node'));
    assert.ok(d.stacks.includes('node'));
    assert.equal(d.packageManager, 'pnpm');
    assert.equal(d.monorepo.tool, 'turbo');
    assert.equal(d.packages.length, 5);
    assert.deepEqual(d.packages.map((p) => p.name).sort(), ['@demo/api', '@demo/db', '@demo/types', '@demo/ui', '@demo/web'].sort());
  });

  test('builds the internal dependency graph in both directions', () => {
    const d = detect(path.join(TMP, 'node'));
    const types = d.packages.find((p) => p.name === '@demo/types');
    const db = d.packages.find((p) => p.name === '@demo/db');
    assert.deepEqual(db.deps, ['@demo/types']);
    assert.deepEqual(types.dependents.sort(), ['@demo/db', '@demo/ui']);
    assert.deepEqual(types.deps, [], 'external deps must not leak into the internal graph');
  });

  test('derives commands and turbo affected forms', () => {
    const d = detect(path.join(TMP, 'node'));
    assert.equal(d.commands.lint, 'pnpm run lint');
    assert.equal(d.commands.fmtCheck, 'pnpm run format:check');
    assert.match(d.commands.testPkg, /--filter=\{pkg\}/);
    assert.match(d.affected.test, /--filter=\.\.\.\[\{base\}\]/);
  });

  test('reads CI provider, jobs and declared commands', () => {
    const d = detect(path.join(TMP, 'node'));
    assert.equal(d.ci.provider, 'github-actions');
    assert.deepEqual(d.ci.jobs, ['quality']);
    assert.ok(d.ci.commands.includes('pnpm run test'));
  });

  test('finds agent instructions without loading them', () => {
    const d = detect(path.join(TMP, 'node'));
    assert.deepEqual(d.docs.agentInstructions, ['CLAUDE.md']);
  });
});

describe('detect: cargo workspace', () => {
  test('expands member globs and path deps', () => {
    const d = detect(path.join(TMP, 'cargo'));
    assert.deepEqual(d.stacks, ['rust']);
    assert.equal(d.packageManager, 'cargo');
    assert.equal(d.monorepo.tool, 'cargo-workspace');
    assert.deepEqual(d.packages.map((p) => p.name).sort(), ['demo-core', 'demo-server']);
    const server = d.packages.find((p) => p.name === 'demo-server');
    assert.deepEqual(server.deps, ['demo-core']);
    assert.equal(server.kind, 'bin');
  });

  test('uses cargo commands with per-package scoping', () => {
    const d = detect(path.join(TMP, 'cargo'));
    assert.equal(d.commands.fmtCheck, 'cargo fmt --all -- --check');
    assert.equal(d.commands.testPkg, 'cargo test -p {pkg}');
    assert.match(d.commands.lint, /-D warnings/);
  });
});

describe('detect: go workspace', () => {
  test('a go.work-only root is still a go repo', () => {
    // Regression: root had no go.mod, so the stack came back "unknown".
    const root = path.join(TMP, 'gowork');
    w(root, 'go.work', 'go 1.23\n\nuse (\n\t./svc/api\n\t./pkg/store\n)\n');
    w(root, 'svc/api/go.mod', 'module example.com/api\n\ngo 1.23\n\nrequire (\n\texample.com/store v0.0.0\n)\n');
    w(root, 'svc/api/main.go', 'package main\n');
    w(root, 'pkg/store/go.mod', 'module example.com/store\n\ngo 1.23\n');
    w(root, 'pkg/store/store.go', 'package store\n');
    const d = detect(root);
    assert.deepEqual(d.stacks, ['go']);
    assert.equal(d.monorepo.tool, 'go-work');
    assert.equal(d.packages.length, 2);
    const api = d.packages.find((p) => p.name === 'example.com/api');
    assert.deepEqual(api.deps, ['example.com/store'], 'go.work siblings must form dep edges');
    assert.equal(api.kind, 'bin');
    assert.equal(d.commands.test, 'go test ./...');
  });
});

describe('detect: single-package repo', () => {
  test('does not invent workspace-scoped verification commands', () => {
    // Regression: a lone package produced `npm run test --workspace <pkg>`.
    const root = path.join(TMP, 'solo');
    w(root, 'package.json', { name: 'solo', scripts: { lint: 'eslint .', test: 'vitest run' } });
    w(root, 'src/index.js', 'export const a = 1;\n');
    w(root, 'tests/a.test.js', 'test("x", () => {});\n');
    const m = buildMap(root);
    assert.equal(m.monorepo.isMonorepo, false);
    const i = computeImpact(root, m, { paths: ['src/index.js'] });
    assert.ok(i.steps.length > 0);
    assert.ok(!i.steps.some((s) => s.cmd.includes('--workspace')), i.steps.map((s) => s.cmd).join(' | '));
    assert.ok(i.steps.some((s) => s.cmd === 'npm run test'));
  });
});

// ------------------------------------------------------------ overrides ---

describe('per-repo overrides (.claude/yindee.json)', () => {
  const mkRepo = (name, config) => {
    const root = path.join(TMP, name);
    w(root, 'package.json', { name, scripts: { lint: 'eslint .', test: 'vitest run' } });
    w(root, 'src/index.js', 'export const a = 1;\n');
    w(root, 'billing/rates.js', 'export const rate = 1;\n');
    w(root, 'warehouse/load.js', 'export const load = 1;\n');
    if (config) w(root, '.claude/yindee.json', config);
    return root;
  };

  test('commands are overridden', () => {
    const root = mkRepo('ovr-cmd', { commands: { test: 'make test' } });
    assert.equal(buildMap(root).commands.test, 'make test');
  });

  test('sensitive paths reach impact and raise the tier', () => {
    // Regression: `detect` read the config but `buildMap` dropped it, so
    // `impact` — which only ever sees the map — classified with defaults.
    const root = mkRepo('ovr-sens', { sensitive: ['billing/**'] });
    const map = buildMap(root);
    assert.deepEqual(map.config.sensitive, ['billing/**']);
    const i = computeImpact(root, map, { paths: ['billing/rates.js'] });
    assert.equal(i.tier, 'critical');
    assert.ok(i.sensitive.includes('billing/rates.js'));
  });

  test('area globs reach impact and select rule files', () => {
    const root = mkRepo('ovr-area', { areas: { database: ['warehouse/**'] } });
    const i = computeImpact(root, buildMap(root), { paths: ['warehouse/load.js'] });
    assert.ok(i.areas.includes('database'), i.areas.join(','));
    assert.ok(i.rules.includes('database'));
  });

  test('a repo without overrides is unaffected', () => {
    const root = mkRepo('ovr-none', null);
    const map = buildMap(root);
    assert.deepEqual(map.config, {});
    assert.equal(map.configPresent, false);
    assert.equal(computeImpact(root, map, { paths: ['billing/rates.js'] }).tier, 'standard');
  });

  test('adding a config file invalidates an already-cached map', () => {
    // Regression: the fingerprint is taken over the *cached* file list, so a
    // config filtered in only once it exists could never invalidate the map
    // that predates it.
    const root = mkRepo('ovr-cache', null);
    loadMap(root, { force: true });
    assert.equal(loadMap(root).cached, true);
    w(root, '.claude/yindee.json', { sensitive: ['billing/**'] });
    const { map, cached } = loadMap(root);
    assert.equal(cached, false, 'a new override file must rebuild the map');
    assert.deepEqual(map.config.sensitive, ['billing/**']);
  });
});

// --------------------------------------------------------------------- map ---

describe('map', () => {
  test('is stable across rebuilds', () => {
    const a = buildMap(path.join(TMP, 'node'));
    const b = buildMap(path.join(TMP, 'node'));
    assert.equal(a.fingerprint, b.fingerprint);
    assert.deepEqual(a.packages, b.packages);
  });

  test('carries a harness fingerprint so cached maps invalidate on upgrade', () => {
    // Regression: improving detection left every cached map stale forever.
    const m = buildMap(path.join(TMP, 'node'));
    assert.equal(typeof m.harness, 'string');
    assert.ok(m.harness.length >= 8);
    const stale = { ...m, harness: 'stale' };
    fs.mkdirSync(path.join(TMP, 'node', '.claude', 'yindee'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'node', '.claude', 'yindee', 'map.json'), JSON.stringify(stale));
    const { cached } = loadMap(path.join(TMP, 'node'));
    assert.equal(cached, false, 'a map from a different harness build must be rebuilt');
  });

  test('reuses the cache when nothing moved', () => {
    const root = path.join(TMP, 'node');
    loadMap(root, { force: true });
    assert.equal(loadMap(root).cached, true);
  });

  test('assigns areas and entry points to packages', () => {
    const m = buildMap(path.join(TMP, 'node'));
    const db = m.packages.find((p) => p.name === '@demo/db');
    const web = m.packages.find((p) => p.name === '@demo/web');
    assert.ok(db.areas.includes('database'));
    assert.ok(web.areas.includes('frontend'));
    assert.equal(db.entry, 'packages/db/src/index.ts');
  });
});

// ------------------------------------------------------------------ impact ---

describe('impact tiers', { skip: !hasGit ? 'git not available' : false }, () => {
  const root = () => path.join(TMP, 'node');
  const map = () => buildMap(root());
  const reset = () => {
    git(root(), 'checkout', '-q', '--', '.');
    git(root(), 'clean', '-qfd');
  };

  test('clean tree needs no verification', () => {
    reset();
    const i = computeImpact(root(), map(), {});
    assert.equal(i.tier, 'docs');
    assert.equal(i.steps.length, 0);
    assert.match(i.reasons.join(), /no changes/);
  });

  test('docs-only change stays at the docs tier', () => {
    reset();
    fs.appendFileSync(path.join(root(), 'README.md'), '\nmore words\n');
    const i = computeImpact(root(), map(), {});
    assert.equal(i.tier, 'docs');
    assert.equal(i.steps.length, 0);
    reset();
  });

  test('single leaf package -> standard, scoped commands only', () => {
    reset();
    fs.appendFileSync(path.join(root(), 'apps/web/src/app/page.tsx'), '\nexport const x = 1;\n');
    const i = computeImpact(root(), map(), {});
    assert.equal(i.tier, 'standard');
    assert.deepEqual(i.packages.direct, ['@demo/web']);
    assert.ok(i.steps.length > 0);
    assert.ok(i.steps.every((s) => s.cmd.includes('@demo/web')), 'standard tier must not run workspace-wide commands');
    reset();
  });

  test('shared package -> broad, and uses the build tool affected graph', () => {
    reset();
    fs.appendFileSync(path.join(root(), 'packages/types/src/index.ts'), '\nexport type T = 1;\n');
    const i = computeImpact(root(), map(), {});
    assert.equal(i.tier, 'broad');
    assert.ok(i.packages.affected.includes('@demo/web'), 'transitive dependents must be included');
    assert.ok(i.steps.some((s) => s.cmd.includes('--filter=...[')), 'should delegate to turbo affected');
    reset();
  });

  test('auth or migration change -> critical, full verification', () => {
    reset();
    fs.appendFileSync(path.join(root(), 'apps/api/src/middleware/requireAuth.ts'), '\nexport const y = 1;\n');
    const i = computeImpact(root(), map(), {});
    assert.equal(i.tier, 'critical');
    assert.equal(i.reviewDepth, 'deep');
    assert.ok(i.rules.includes('security'));
    const ids = i.steps.map((s) => s.id);
    for (const need of ['lint', 'typecheck', 'test', 'build']) assert.ok(ids.includes(need), `critical must run ${need}`);
    reset();
  });

  test('new untracked migration is detected and is critical', () => {
    reset();
    w(root(), 'packages/db/prisma/migrations/20240202_x/migration.sql', 'ALTER TABLE "User" ADD COLUMN "a" TEXT;\n');
    const i = computeImpact(root(), map(), {});
    assert.equal(i.tier, 'critical');
    assert.ok(i.files.some((f) => f.path.endsWith('20240202_x/migration.sql')));
    assert.ok(i.rules.includes('database'));
    reset();
  });

  test('tier can be forced', () => {
    reset();
    fs.appendFileSync(path.join(root(), 'apps/web/src/app/page.tsx'), '\nexport const z = 1;\n');
    const i = computeImpact(root(), map(), { tier: 'critical' });
    assert.equal(i.tier, 'critical');
    reset();
  });

  test('packageOf resolves by longest path prefix', () => {
    const m = map();
    assert.equal(packageOf(m, 'apps/api/src/index.ts').name, '@demo/api');
    assert.equal(packageOf(m, 'packages/db/src/index.ts').name, '@demo/db');
  });
});

// ----------------------------------------------------------------- context ---

describe('context', { skip: !hasGit ? 'git not available' : false }, () => {
  test('scopes an auth task to the api package and security rules', () => {
    const root = path.join(TMP, 'node');
    const ctx = computeContext(root, buildMap(root), 'add refresh token rotation to the login middleware');
    assert.ok(ctx.areas.includes('security'));
    assert.ok(ctx.rules.includes('security'));
    assert.ok(ctx.packages.some((p) => p.pkg.name === '@demo/api'));
    assert.ok(ctx.files.some((f) => f.file.includes('requireAuth')));
  });

  test('explicit paths override keyword scoring', () => {
    const root = path.join(TMP, 'node');
    const ctx = computeContext(root, buildMap(root), 'anything', { paths: ['packages/ui'] });
    assert.deepEqual(ctx.packages.map((p) => p.pkg.name), ['@demo/ui']);
  });

  test('surfaces per-package agent instructions', () => {
    const root = path.join(TMP, 'node');
    w(root, 'apps/api/CLAUDE.md', 'api-specific rules\n');
    const ctx = computeContext(root, buildMap(root), 'change the api routes handler');
    assert.ok(ctx.localInstructions.includes('apps/api/CLAUDE.md'));
    fs.rmSync(path.join(root, 'apps/api/CLAUDE.md'));
  });
});

// ------------------------------------------------------------------ review ---

describe('review', { skip: !hasGit ? 'git not available' : false }, () => {
  test('includes untracked files and bounds the diff', () => {
    const root = path.join(TMP, 'node');
    git(root, 'checkout', '-q', '--', '.');
    git(root, 'clean', '-qfd');
    w(root, 'packages/db/prisma/migrations/20240303_y/migration.sql', 'ALTER TABLE "User" ADD COLUMN "b" TEXT;\n');
    fs.appendFileSync(path.join(root, 'apps/api/src/index.ts'), '\nexport const extra = 1;\n');
    const map = buildMap(root);
    const impact = computeImpact(root, map, {});
    const r = buildReview(root, map, impact, { maxLines: 500 });
    assert.ok(r.kept.some((k) => k.file.includes('20240303_y')), 'untracked file must reach the diff');
    assert.ok(r.kept.some((k) => k.file.includes('apps/api/src/index.ts')));
    assert.ok(r.checks.length > 0, 'path-scoped checklist must be non-empty for a db+security change');
    git(root, 'checkout', '-q', '--', '.');
    git(root, 'clean', '-qfd');
  });

  test('drops generated files from the diff budget', () => {
    const root = path.join(TMP, 'node');
    w(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n" + 'x: y\n'.repeat(500));
    const map = buildMap(root);
    const impact = computeImpact(root, map, {});
    const r = buildReview(root, map, impact, {});
    assert.ok(!r.kept.some((k) => k.file === 'pnpm-lock.yaml'));
    assert.ok(r.omitted.some((o) => o.startsWith('pnpm-lock.yaml')));
    fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
    git(root, 'checkout', '-q', '--', '.');
    git(root, 'clean', '-qfd');
  });
});
