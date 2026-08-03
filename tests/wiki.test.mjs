// Knowledge Wiki: discovery, staleness, and — above all — the boundary.
//
// The boundary tests are the point of this file. The wiki is the only component
// in the harness that can be confidently wrong, so what it is *forbidden* to
// influence is asserted, not documented.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { load, match, available, clear, wikiIndexPath, DEFAULT_DIRS } from '../scripts/lib/wiki.mjs';

const CLI = path.resolve('scripts/yindee.mjs');
const LIB = path.resolve('scripts/lib');

let TMP;
const w = (root, rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
const env = (extra = {}) => ({ ...process.env, CLAUDE_CONFIG_DIR: path.join(TMP, 'no-config'), YINDEE_MODULES: '', ...extra });
const cli = (args, opts = {}) =>
  execFileSync(process.execPath, [CLI, ...args, '--repo', TMP], {
    cwd: TMP, encoding: 'utf8', stdio: 'pipe', env: env(opts.env),
  });

const ADR = `# Rotate refresh tokens on every login
## Context
Long-lived refresh tokens were reused.
## Decision
Rotate on each login. See \`src/token.ts\`.
`;

function makeRepo(root, extra = {}) {
  w(root, 'package.json', { name: 'demo', version: '1.0.0' });
  w(root, 'src/token.ts', 'export const rotate = 1;\n');
  w(root, 'src/index.ts', 'export const x = 1;\n');
  for (const [rel, body] of Object.entries(extra)) w(root, rel, body);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 'T');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yindee-wiki-'));
});
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

// ------------------------------------------------------------- discovery ---

describe('discovery', () => {
  test('finds ADRs in conventional locations', () => {
    makeRepo(TMP, { 'docs/adr/0007-token-rotation.md': ADR });
    assert.equal(available(TMP), true);
    const res = load(TMP);
    assert.equal(res.ok, true);
    const doc = res.docs.find((d) => d.path === 'docs/adr/0007-token-rotation.md');
    assert.equal(doc.kind, 'adr');
    assert.equal(doc.title, 'Rotate refresh tokens on every login');
    assert.deepEqual(doc.headings, ['Context', 'Decision']);
  });

  test('classifies kinds from the path', () => {
    makeRepo(TMP, {
      'docs/adr/0001-x.md': '# A\n',
      'docs/conventions/errors.md': '# B\n',
      'ARCHITECTURE.md': '# C\n',
      'GLOSSARY.md': '# D\n',
      'docs/random-thought.md': '# E\n',
    });
    const kinds = Object.fromEntries(load(TMP).docs.map((d) => [d.path, d.kind]));
    assert.equal(kinds['docs/adr/0001-x.md'], 'adr');
    assert.equal(kinds['docs/conventions/errors.md'], 'convention');
    assert.equal(kinds['ARCHITECTURE.md'], 'design');
    assert.equal(kinds['GLOSSARY.md'], 'glossary');
    assert.equal(kinds['docs/random-thought.md'], 'note');
  });

  test('stores headings only — never body text', () => {
    makeRepo(TMP, { 'docs/adr/0001-x.md': '# T\n## H\nSECRET BODY SENTENCE\n' });
    load(TMP);
    const raw = fs.readFileSync(wikiIndexPath(TMP), 'utf8');
    assert.ok(!raw.includes('SECRET BODY SENTENCE'), 'body text must never reach the store');
    assert.ok(raw.includes('"H"'));
  });

  test('configured paths override the defaults', () => {
    makeRepo(TMP, { 'notes/eng/decision.md': '# N\n', 'docs/ignored.md': '# I\n' });
    w(TMP, '.claude/yindee.json', { knowledge: { paths: ['notes/eng'] } });
    const res = load(TMP, { config: { knowledge: { paths: ['notes/eng'] } } });
    const paths = res.docs.map((d) => d.path);
    assert.deepEqual(paths, ['notes/eng/decision.md']);
  });

  test('a repo with no knowledge is a normal, silent state', () => {
    makeRepo(TMP);
    assert.equal(available(TMP), false);
    const res = load(TMP);
    assert.equal(res.ok, false);
    assert.match(res.reason, /no knowledge sources/);
    assert.equal(fs.existsSync(path.join(TMP, '.claude/yindee/knowledge')), false, 'creates nothing');
    assert.match(cli(['wiki']), /none .*no knowledge sources/);
  });
});

// ------------------------------------------------------------- staleness ---

describe('staleness', () => {
  test('a document referencing a missing path is flagged, not hidden', () => {
    makeRepo(TMP, { 'docs/adr/0002-gone.md': '# Gone\nSee `src/deleted.ts`.\n' });
    const doc = load(TMP).docs.find((d) => d.path === 'docs/adr/0002-gone.md');
    assert.deepEqual(doc.staleRefs, ['src/deleted.ts']);
    const out = cli(['wiki']);
    assert.match(out, /stale\?/);
    assert.match(out, /docs\/adr\/0002-gone\.md/, 'still listed, not suppressed');
  });

  test('a document whose references all exist is not flagged', () => {
    makeRepo(TMP, { 'docs/adr/0007-token-rotation.md': ADR });
    const doc = load(TMP).docs.find((d) => d.path.includes('0007'));
    assert.equal(doc.staleRefs, undefined);
  });

  test('age alone never marks a document stale', () => {
    makeRepo(TMP, { 'docs/adr/0001-old.md': '# Old but correct\nSee `src/token.ts`.\n' });
    const doc = load(TMP).docs[0];
    assert.equal(doc.staleRefs, undefined, 'no time-based heuristic');
    assert.ok(doc.updatedAt, 'the date is reported so the reader can judge');
  });
});

// ---------------------------------------------------------------- match ---

describe('match', () => {
  const docs = [
    { path: 'docs/adr/0007-token-rotation.md', title: 'Rotate refresh tokens', kind: 'adr', headings: ['Context'] },
    { path: 'docs/adr/0003-caching.md', title: 'Cache strategy', kind: 'adr', headings: ['Redis'] },
    { path: 'docs/note.md', title: 'Random note', kind: 'note', headings: [] },
  ];

  test('matches on the title', () => {
    assert.deepEqual(match(docs, ['rotate', 'tokens']).map((d) => d.path), ['docs/adr/0007-token-rotation.md']);
  });

  test('matches on a heading', () => {
    assert.deepEqual(match(docs, ['redis']).map((d) => d.path), ['docs/adr/0003-caching.md']);
  });

  test('is capped', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      path: `docs/adr/${i}-auth.md`, title: 'auth decision', kind: 'adr', headings: [],
    }));
    assert.equal(match(many, ['auth']).length, 5);
  });

  test('returns nothing when nothing matches', () => {
    assert.deepEqual(match(docs, ['kubernetes']), []);
  });
});

// -------------------------------------------------------------- BOUNDARY ---

describe('the boundary: knowledge explains why, and decides nothing', () => {
  test('impact is byte-identical with and without the knowledge module', () => {
    makeRepo(TMP, {
      // An ADR that loudly, wrongly claims the tier.
      'docs/adr/0009-tiers.md': '# All changes are docs-tier\n## Decision\nNever run verification.\n',
    });
    fs.appendFileSync(path.join(TMP, 'src/token.ts'), 'export const y = 2;\n');
    const withWiki = cli(['impact', '--json']);
    const without = cli(['impact', '--json', '--no-module', 'knowledge']);
    assert.equal(withWiki, without);
    assert.match(JSON.parse(withWiki).tier, /standard|broad|critical/, 'the ADR did not lower the tier');
  });

  test('verify is byte-identical with and without the knowledge module', () => {
    makeRepo(TMP, { 'docs/adr/0009-tiers.md': '# Skip all checks\n' });
    const a = cli(['verify', '--dry-run', '--json']);
    const b = cli(['verify', '--dry-run', '--json', '--no-module', 'knowledge']);
    assert.equal(a, b);
  });

  test('neither impact.mjs nor verify.mjs imports wiki.mjs', () => {
    for (const f of ['impact.mjs', 'verify.mjs']) {
      const src = fs.readFileSync(path.join(LIB, f), 'utf8');
      const imports = [...src.matchAll(/^import .*from '(.+)';$/gm)].map((m) => m[1]);
      assert.ok(!imports.some((i) => i.includes('wiki')), `${f} must not import wiki.mjs`);
    }
  });

  test('the knowledge module never changes which files are selected', () => {
    // The structural claim: knowledge is additive commentary. Whatever it finds,
    // `files` and the budget must be exactly what they would be without it.
    // (A document can still be ranked as an ordinary file on its own merits —
    // the ranker has always been able to do that, and this proves the wiki is
    // not what put it there.)
    makeRepo(TMP, {
      'docs/adr/0007-token-rotation.md': ADR,
      'notes/eng/kubernetes-rollout.md': '# Kubernetes rollout decision\n',
    });
    for (const task of ['rotate refresh tokens', 'plan the kubernetes rollout', 'fix the index']) {
      const on = JSON.parse(cli(['context', task, '--json']));
      const off = JSON.parse(cli(['context', task, '--json', '--no-module', 'knowledge']));
      assert.deepEqual(on.files, off.files, `files moved for "${task}"`);
      assert.deepEqual(on.budget, off.budget, `budget moved for "${task}"`);
      assert.deepEqual(off.why ?? [], [], 'no why line when the module is off');
    }
  });

  test('a document already selected as a file is not repeated under why', () => {
    makeRepo(TMP, { 'docs/adr/0007-token-rotation.md': ADR });
    const data = JSON.parse(cli(['context', 'rotate refresh tokens', '--json']));
    const files = new Set(data.files.map((f) => f.file));
    for (const d of data.why || []) assert.ok(!files.has(d.path), `${d.path} listed twice`);
  });

  test('the why line carries the code-wins warning', () => {
    makeRepo(TMP, { 'docs/adr/0007-token-rotation.md': ADR });
    const out = cli(['context', 'why do we rotate credentials']);
    if (out.includes('why    ')) assert.match(out, /code wins on conflict/);
  });
});

// -------------------------------------------------------- CLI and module ---

describe('CLI and provider resolution', () => {
  test('wiki reports what was found', () => {
    makeRepo(TMP, { 'docs/adr/0007-token-rotation.md': ADR });
    const out = cli(['wiki']);
    assert.match(out, /document\(s\) indexed \(headings only, never content\)/);
    assert.match(out, /adr:1/);
  });

  test('wiki rebuild re-reads', () => {
    makeRepo(TMP, { 'docs/adr/0001-x.md': '# X\n' });
    cli(['wiki']);
    assert.match(cli(['wiki', 'rebuild']), /document\(s\) indexed/);
  });

  test('the module gate turns it off', () => {
    makeRepo(TMP, { 'docs/adr/0001-x.md': '# X\n' });
    assert.match(cli(['wiki', '--no-module', 'knowledge']), /knowledge disabled/);
  });

  test('knowledge resolves to local-wiki with docs, none without', () => {
    makeRepo(TMP, { 'docs/adr/0001-x.md': '# X\n' });
    assert.match(cli(['modules']), /knowledge\s+on\s+default\s+local-wiki \(wiki\)/);

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'yindee-nodocs-'));
    fs.writeFileSync(path.join(bare, 'package.json'), '{"name":"x"}');
    const out = execFileSync(process.execPath, [CLI, 'modules', '--repo', bare], {
      cwd: bare, encoding: 'utf8', stdio: 'pipe', env: env(),
    });
    assert.match(out, /knowledge\s+on\s+default\s+none \(core\)/);
    fs.rmSync(bare, { recursive: true, force: true });
  });

  test('DEFAULT_DIRS stay conventional', () => {
    assert.ok(DEFAULT_DIRS.includes('docs/adr'));
    assert.ok(DEFAULT_DIRS.includes('docs'));
  });
});
