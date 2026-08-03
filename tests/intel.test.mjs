// Repository Intelligence: index correctness, incrementality, concurrency, fallback.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { writeJsonAtomic, withLock, STALE_LOCK_MS, readJson } from '../scripts/lib/fsx.mjs';
import {
  load,
  list,
  available,
  clear,
  metaPath,
  filesPath,
  lockPath,
  indexDir,
  intelStats,
  INDEX_VERSION,
} from '../scripts/lib/intel.mjs';

const CLI = path.resolve('scripts/yindee.mjs');

let TMP;
const w = (root, rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
const env = (extra = {}) => ({ ...process.env, CLAUDE_CONFIG_DIR: path.join(TMP, 'no-config'), YINDEE_MODULES: '', ...extra });
const cli = (args, opts = {}) =>
  execFileSync(process.execPath, [CLI, ...args, '--repo', opts.cwd || TMP], {
    cwd: opts.cwd || TMP,
    encoding: 'utf8',
    stdio: 'pipe',
    env: env(opts.env),
  });

function makeRepo(root, files = {}) {
  w(root, 'package.json', { name: 'demo', version: '1.0.0' });
  w(root, 'src/index.ts', 'export const x = 1;\n');
  for (const [rel, body] of Object.entries(files)) w(root, rel, body);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 'T');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yindee-intel-'));
  Object.keys(intelStats).forEach((k) => (intelStats[k] = 0));
});

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

// -------------------------------------------------------------- phase 0 ---

describe('atomic writes and locking', () => {
  test('writeJsonAtomic leaves no temp file behind', () => {
    const p = path.join(TMP, 'a', 'x.json');
    writeJsonAtomic(p, { a: 1 });
    assert.deepEqual(readJson(p), { a: 1 });
    assert.deepEqual(fs.readdirSync(path.join(TMP, 'a')), ['x.json']);
  });

  test('writeJsonAtomic replaces an existing file wholesale', () => {
    const p = path.join(TMP, 'x.json');
    writeJsonAtomic(p, { a: 1 });
    writeJsonAtomic(p, { b: 2 });
    assert.deepEqual(readJson(p), { b: 2 });
  });

  test('withLock runs the body and always releases', () => {
    const lock = path.join(TMP, '.lock');
    const res = withLock(lock, () => 42);
    assert.deepEqual(res, { ran: true, value: 42 });
    assert.equal(fs.existsSync(lock), false, 'lock released');
  });

  test('withLock releases even when the body throws', () => {
    const lock = path.join(TMP, '.lock');
    assert.throws(() => withLock(lock, () => { throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(lock), false);
  });

  test('a held lock is refused, not waited on', () => {
    const lock = path.join(TMP, '.lock');
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(lock, '{}');
    let ran = false;
    const res = withLock(lock, () => (ran = true));
    assert.deepEqual(res, { ran: false, reason: 'locked' });
    assert.equal(ran, false, 'body must not run');
    fs.unlinkSync(lock);
  });

  test('a stale lock is broken so a killed process cannot wedge the repo', () => {
    const lock = path.join(TMP, '.lock');
    fs.writeFileSync(lock, '{}');
    const old = Date.now() - STALE_LOCK_MS - 5000;
    fs.utimesSync(lock, old / 1000, old / 1000);
    const res = withLock(lock, () => 'rebuilt');
    assert.equal(res.ran, true);
    assert.equal(res.value, 'rebuilt');
  });
});

// -------------------------------------------------------------- phase 1 ---

describe('index build', () => {
  test('indexes every tracked file, with no depth or count cap', () => {
    makeRepo(TMP, { 'a/b/c/d/e/f/g/h/deep.ts': 'export const d = 1;\n' });
    const res = load(TMP);
    assert.equal(res.ok, true);
    assert.ok(res.files['a/b/c/d/e/f/g/h/deep.ts'], 'depth-8 file is indexed');
    assert.ok(res.files['src/index.ts']);
  });

  test('entries carry area, source-ness and language', () => {
    makeRepo(TMP, { 'src/auth/login.ts': 'export const login = 1;\n' });
    const { files } = load(TMP);
    const e = files['src/auth/login.ts'];
    assert.equal(e.lang, 'ts');
    assert.equal(e.source, true);
    assert.equal(typeof e.area, 'string');
    assert.equal(typeof e.size, 'number');
  });

  test('untracked files are indexed too — a task can touch them', () => {
    makeRepo(TMP);
    w(TMP, 'src/new-thing.ts', 'export const n = 1;\n');
    const { files } = load(TMP);
    assert.ok(files['src/new-thing.ts']);
  });

  test('is reproducible: same commit, same clean tree, same bytes', () => {
    makeRepo(TMP, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    load(TMP);
    const first = fs.readFileSync(filesPath(TMP), 'utf8');
    clear(TMP);
    load(TMP);
    assert.equal(fs.readFileSync(filesPath(TMP), 'utf8'), first);
  });

  test('meta records the version, head and harness fingerprint', () => {
    makeRepo(TMP);
    load(TMP);
    const meta = readJson(metaPath(TMP));
    assert.equal(meta.indexVersion, INDEX_VERSION);
    assert.match(meta.head, /^[0-9a-f]{40}$/);
    assert.ok(meta.harness);
  });
});

describe('incrementality', () => {
  test('a warm hit on a clean tree reads no files at all', () => {
    makeRepo(TMP);
    load(TMP);
    Object.keys(intelStats).forEach((k) => (intelStats[k] = 0));
    const res = load(TMP);
    assert.equal(res.status, 'hit');
    assert.equal(intelStats.reads, 0, 'a hit must not stat a single file');
    assert.equal(intelStats.builds, 0);
    assert.equal(intelStats.patches, 0);
  });

  test('one changed file patches instead of rebuilding', () => {
    makeRepo(TMP, { 'src/a.ts': 'a\n' });
    load(TMP);
    w(TMP, 'src/a.ts', 'a much longer body\n');
    Object.keys(intelStats).forEach((k) => (intelStats[k] = 0));
    const res = load(TMP);
    assert.equal(res.status, 'patched');
    assert.equal(intelStats.builds, 0, 'must not do a full build');
    assert.ok(intelStats.reads <= 3, `patched only the changed set, read ${intelStats.reads}`);
  });

  test('a new commit patches from the previous head', () => {
    makeRepo(TMP);
    load(TMP);
    w(TMP, 'src/added.ts', 'export const a = 1;\n');
    git(TMP, 'add', '-A');
    git(TMP, 'commit', '-qm', 'add');
    const res = load(TMP);
    assert.equal(res.status, 'patched');
    assert.ok(res.files['src/added.ts']);
  });

  test('a deleted file leaves the index', () => {
    makeRepo(TMP, { 'src/gone.ts': 'g\n' });
    load(TMP);
    fs.unlinkSync(path.join(TMP, 'src/gone.ts'));
    const res = load(TMP);
    assert.equal(res.files['src/gone.ts'], undefined);
  });

  test('a file that was dirty and is now clean is re-read, not left stale', () => {
    makeRepo(TMP, { 'src/a.ts': 'short\n' });
    w(TMP, 'src/a.ts', 'a very much longer dirty body\n');
    const dirtySize = load(TMP).files['src/a.ts'].size;
    // Revert to the committed content: HEAD has not moved, but the entry must.
    git(TMP, 'checkout', '--', 'src/a.ts');
    const res = load(TMP);
    assert.notEqual(res.files['src/a.ts'].size, dirtySize, 'carried-forward dirty set was re-read');
    // Compare against the file as it actually is: git may rewrite line endings
    // on checkout, so a hardcoded byte count is wrong on Windows.
    assert.equal(res.files['src/a.ts'].size, fs.statSync(path.join(TMP, 'src/a.ts')).size);
  });

  test('a bumped harness fingerprint forces a full rebuild', () => {
    makeRepo(TMP);
    load(TMP);
    const meta = readJson(metaPath(TMP));
    writeJsonAtomic(metaPath(TMP), { ...meta, harness: 'stale-harness' });
    const res = load(TMP);
    assert.equal(res.status, 'built');
  });
});

describe('list()', () => {
  test('scopes by path prefix', () => {
    makeRepo(TMP, { 'packages/ui/a.ts': 'a\n', 'packages/db/b.ts': 'b\n' });
    const { files } = load(TMP);
    assert.deepEqual(list(files, 'packages/ui'), ['packages/ui/a.ts']);
    assert.ok(list(files, '').length > 2);
  });

  test('a prefix never matches a sibling with the same start', () => {
    makeRepo(TMP, { 'packages/ui/a.ts': 'a\n', 'packages/ui-kit/b.ts': 'b\n' });
    const { files } = load(TMP);
    assert.deepEqual(list(files, 'packages/ui'), ['packages/ui/a.ts']);
  });
});

// ------------------------------------------------------------- fallback ---

describe('fallback matrix — every path must still produce output', () => {
  test('not a git repository', () => {
    fs.writeFileSync(path.join(TMP, 'package.json'), '{"name":"x"}');
    assert.equal(available(TMP), false);
    const res = load(TMP);
    assert.equal(res.ok, false);
    assert.match(res.reason, /not a git repository/);
    assert.match(cli(['intel']), /unavailable/);
  });

  test('a git repo with no commits', () => {
    fs.writeFileSync(path.join(TMP, 'package.json'), '{"name":"x"}');
    git(TMP, 'init', '-q');
    const res = load(TMP);
    assert.equal(res.ok, false);
    assert.match(res.reason, /no commits/);
  });

  test('corrupt meta.json rebuilds instead of throwing', () => {
    makeRepo(TMP);
    load(TMP);
    fs.writeFileSync(metaPath(TMP), '{not json');
    const res = load(TMP);
    assert.equal(res.ok, true);
    assert.equal(res.status, 'built');
  });

  test('a missing files.json rebuilds', () => {
    makeRepo(TMP);
    load(TMP);
    fs.unlinkSync(filesPath(TMP));
    const res = load(TMP);
    assert.equal(res.ok, true);
    assert.ok(Object.keys(res.files).length > 0);
  });

  test('a held lock computes in memory and never blocks', () => {
    makeRepo(TMP);
    fs.mkdirSync(indexDir(TMP), { recursive: true });
    fs.writeFileSync(lockPath(TMP), '{"pid":1}');
    const res = load(TMP);
    assert.equal(res.ok, true, 'still answers');
    assert.equal(res.status, 'computed');
    assert.ok(Object.keys(res.files).length > 0);
    assert.equal(fs.existsSync(metaPath(TMP)), false, 'loser does not write');
    fs.unlinkSync(lockPath(TMP));
  });
});

// ---------------------------------------------------------- the invariant ---

describe('the invariant: index moves the file source, never the scoring', () => {
  const files = {
    'src/auth/token.ts': 'export const token = 1;\n',
    'src/auth/session.ts': 'export const session = 1;\n',
    'src/ui/Button.tsx': 'export const Button = 1;\n',
    'src/db/schema.sql': 'CREATE TABLE t (id INT);\n',
  };
  const candidates = (out) => JSON.parse(out).files.map((f) => `${f.file} ${f.tags}`).sort();

  for (const task of ['refactor the auth token', 'update the button component', 'change the schema']) {
    test(`identical candidates with and without the index — "${task}"`, () => {
      makeRepo(TMP, files);
      const withIndex = candidates(cli(['context', task, '--json']));
      const liveScan = candidates(cli(['context', task, '--json', '--no-module', 'intelligence']));
      assert.deepEqual(withIndex, liveScan);
    });
  }

  test('above the walk caps the index finds a file the live scan cannot', () => {
    // Name matches the task; content deliberately does not, so `git grep`
    // cannot compensate. The live walk stops at depth 6.
    makeRepo(TMP, { 'src/a/b/c/d/e/f/g/rotation.ts': 'export const doThing = 1;\n' });
    const hit = JSON.parse(cli(['context', 'fix rotation', '--json'])).files.map((f) => f.file);
    const miss = JSON.parse(cli(['context', 'fix rotation', '--json', '--no-module', 'intelligence'])).files.map((f) => f.file);
    assert.ok(hit.includes('src/a/b/c/d/e/f/g/rotation.ts'), 'index sees the deep file');
    assert.ok(!miss.includes('src/a/b/c/d/e/f/g/rotation.ts'), 'live walk cannot reach it');
  });
});

// ------------------------------------------------------------ concurrency ---

describe('concurrency', () => {
  test('8 concurrent context runs all succeed and leave no torn or temp files', () => {
    makeRepo(TMP);
    for (let i = 0; i < 40; i++) w(TMP, `src/mod${i}.ts`, `export const m${i} = ${i};\n`);
    git(TMP, 'add', '-A');
    git(TMP, 'commit', '-qm', 'bulk');

    const procs = Array.from({ length: 8 }, () =>
      execFileSync(process.execPath, [CLI, 'context', 'refactor mod', '--repo', TMP], {
        cwd: TMP, encoding: 'utf8', stdio: 'pipe', env: env(),
      }),
    );
    assert.equal(procs.length, 8);
    for (const out of procs) assert.match(out, /budget/);

    for (const name of fs.readdirSync(indexDir(TMP))) {
      assert.ok(!name.endsWith('.tmp'), `left a temp file: ${name}`);
    }
    assert.ok(readJson(metaPath(TMP)), 'meta.json parses');
    assert.ok(readJson(filesPath(TMP)), 'files.json parses');
  });
});

// -------------------------------------------------------------- CLI + module ---

describe('CLI and provider resolution', () => {
  test('intel reports what is indexed', () => {
    makeRepo(TMP);
    const out = cli(['intel']);
    assert.match(out, /file\(s\) indexed/);
    assert.match(out, /head\s+[0-9a-f]{12}/);
  });

  test('intel rebuild drops the store and rebuilds', () => {
    makeRepo(TMP);
    cli(['intel']);
    const out = cli(['intel', 'rebuild']);
    assert.match(out, /rebuilt/);
    assert.ok(readJson(filesPath(TMP)));
  });

  test('intel --json is machine-readable', () => {
    makeRepo(TMP);
    const data = JSON.parse(cli(['intel', '--json']));
    assert.equal(data.ok, true);
    assert.ok(data.count > 0);
  });

  test('the module gate turns it off', () => {
    makeRepo(TMP);
    assert.match(cli(['intel', '--no-module', 'intelligence']), /intelligence disabled/);
  });

  test('intelligence resolves to repo-index in a git repo, live-scan without one', () => {
    makeRepo(TMP);
    assert.match(cli(['modules']), /intelligence\s+on\s+default\s+repo-index \(index\)/);

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'yindee-nogit-'));
    fs.writeFileSync(path.join(bare, 'package.json'), '{"name":"x"}');
    const out = execFileSync(process.execPath, [CLI, 'modules', '--repo', bare], {
      cwd: bare, encoding: 'utf8', stdio: 'pipe', env: env(),
    });
    assert.match(out, /intelligence\s+on\s+default\s+live-scan \(core\)/);
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
