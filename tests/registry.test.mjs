// Module registry tests: Core -> Modules -> Providers.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  MODULES,
  PROVIDER_TYPES,
  resolveModules,
  renderModules,
  setModule,
  findSkill,
  clearSkillCache,
  configPath,
} from '../scripts/lib/registry.mjs';

const CLI = path.resolve('scripts/yindee.mjs');

let TMP;
const w = (root, rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
/** A repo with no HOME leakage: detection must not see the developer's own skills. */
const isolated = (extra = {}) => ({ ...process.env, CLAUDE_CONFIG_DIR: path.join(TMP, 'no-such-config'), YINDEE_MODULES: '', ...extra });
// Provider-mechanics tests want the whole table detected. Ordinary commands
// deliberately skip detection for modules that are off — asserted separately.
const resolve = (root, flags = {}, env = {}) => resolveModules(root, flags, isolated(env), { detectAll: true });
const resolveLazy = (root, flags = {}, env = {}) => resolveModules(root, flags, isolated(env));

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd || TMP,
    encoding: 'utf8',
    env: isolated(opts.env),
    stdio: 'pipe',
  });

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yindee-registry-'));
  w(TMP, 'package.json', { name: 'demo', version: '1.0.0' });
  w(TMP, 'src/index.js', 'export const x = 1;\n');
  clearSkillCache();
});

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

// --------------------------------------------------------------- invariant ---

describe('terminal-provider invariant', () => {
  test('every module ends in a provider that is always present', () => {
    const terminal = new Set(['builtin', 'core']);
    for (const [name, def] of Object.entries(MODULES)) {
      assert.ok(def.providers?.length, `${name} declares no providers`);
      const last = def.providers[def.providers.length - 1];
      assert.ok(terminal.has(last.type), `${name} chain does not end in builtin/core (got ${last.type})`);
      assert.equal(last.priority, 0, `${name} terminal provider should sit at priority 0`);
    }
  });

  test('every declared provider type has a detector', () => {
    for (const [name, def] of Object.entries(MODULES)) {
      for (const p of def.providers) {
        assert.ok(PROVIDER_TYPES.includes(p.type), `${name}: unknown provider type ${p.type}`);
      }
    }
  });

  test('every enabled module resolves to an active provider', () => {
    for (const r of resolve(TMP).resolved.filter((x) => x.enabled)) {
      assert.ok(r.active, `${r.module} resolved to nothing`);
    }
  });

  test('detection is skipped for modules that are off', () => {
    const lazy = resolveLazy(TMP).resolved;
    for (const r of lazy.filter((x) => !x.enabled)) {
      assert.equal(r.detected, false, `${r.module} paid for detection while disabled`);
    }
    for (const r of lazy.filter((x) => x.enabled)) {
      assert.equal(r.detected, true);
      assert.ok(r.active, `${r.module} is on but resolved to nothing`);
    }
  });
});

// ------------------------------------------------------------------ layers ---

describe('enablement layers', () => {
  test('defaults: benchmark, telemetry and verbose are off; concise-output is on', () => {
    const m = resolve(TMP);
    assert.equal(m.enabled.has('benchmark'), false);
    assert.equal(m.enabled.has('telemetry'), false);
    assert.equal(m.enabled.has('verbose'), false);
    assert.equal(m.enabled.has('concise-output'), true);
    assert.equal(m.level, 'quiet');
  });

  test('config beats defaults', () => {
    w(TMP, '.claude/yindee.json', { modules: { benchmark: true, 'concise-output': false } });
    const m = resolve(TMP);
    assert.equal(m.enabled.has('benchmark'), true);
    assert.equal(m.enabled.has('concise-output'), false);
    assert.equal(m.source.get('benchmark'), 'config');
  });

  test('env beats config', () => {
    w(TMP, '.claude/yindee.json', { modules: { verbose: false } });
    const m = resolve(TMP, {}, { YINDEE_MODULES: 'verbose' });
    assert.equal(m.level, 'verbose');
    assert.equal(m.source.get('verbose'), 'env');
  });

  test('env supports a leading - to turn a module off', () => {
    const m = resolve(TMP, {}, { YINDEE_MODULES: '-concise-output' });
    assert.equal(m.enabled.has('concise-output'), false);
  });

  test('flags beat env', () => {
    const m = resolve(TMP, { 'no-module': 'benchmark' }, { YINDEE_MODULES: 'benchmark' });
    assert.equal(m.enabled.has('benchmark'), false);
    assert.equal(m.source.get('benchmark'), 'flag');
  });

  test('--verbose raises the render level', () => {
    assert.equal(resolve(TMP, { verbose: true }).level, 'verbose');
  });

  test('benchmark transitively enables telemetry', () => {
    const m = resolve(TMP, { module: 'benchmark' });
    assert.equal(m.enabled.has('telemetry'), true);
    assert.match(m.source.get('telemetry'), /required by benchmark/);
  });

  test('an unknown module name is reported, not thrown', () => {
    const m = resolve(TMP, { module: 'nope' });
    assert.match(m.warnings.join('\n'), /unknown module "nope"/);
  });
});

// ------------------------------------------------------------ config shape ---

describe('config shapes', () => {
  test('boolean and object forms both parse', () => {
    w(TMP, '.claude/yindee.json', { modules: { benchmark: true, workflow: { enabled: true } } });
    const m = resolve(TMP);
    assert.equal(m.enabled.has('benchmark'), true);
    assert.equal(m.enabled.has('workflow'), true);
  });

  test('config providers merge by id and can outrank the registry', () => {
    w(TMP, '.claude/yindee.json', {
      modules: { workflow: { enabled: true, providers: [{ id: 'house-review', type: 'builtin', priority: 99 }] } },
    });
    const wf = resolve(TMP).resolved.find((r) => r.module === 'workflow');
    assert.equal(wf.active.id, 'house-review');
    assert.equal(wf.chain[0].priority, 99);
  });

  test('a config entry can re-prioritize an existing provider', () => {
    w(TMP, '.claude/yindee.json', {
      modules: { 'concise-output': { providers: [{ id: 'modules/concise-output.md', type: 'builtin', priority: 500 }] } },
    });
    const c = resolve(TMP).resolved.find((r) => r.module === 'concise-output');
    assert.equal(c.chain[0].id, 'modules/concise-output.md');
    assert.equal(c.chain[0].priority, 500);
  });

  test('malformed providers are dropped and reported, never thrown', () => {
    w(TMP, '.claude/yindee.json', {
      modules: {
        workflow: {
          enabled: true,
          providers: [
            { type: 'skill' },
            { id: 'x', type: 'quantum' },
            { id: 'y', type: 'skill', priority: 'soon' },
            'not-an-object',
          ],
        },
      },
    });
    const m = resolve(TMP);
    const warn = m.warnings.join('\n');
    assert.match(warn, /no "id"/);
    assert.match(warn, /unknown type "quantum"/);
    assert.match(warn, /non-numeric priority/);
    assert.match(warn, /not an object/);
    const wf = m.resolved.find((r) => r.module === 'workflow');
    assert.ok(wf.active, 'chain still resolves after dropping bad entries');
  });

  test('other config keys survive a module write', () => {
    w(TMP, '.claude/yindee.json', { commands: { test: 'npm test' }, areas: { api: ['src/api'] } });
    setModule(TMP, 'benchmark', true);
    const cfg = JSON.parse(fs.readFileSync(configPath(TMP), 'utf8'));
    assert.deepEqual(cfg.commands, { test: 'npm test' });
    assert.deepEqual(cfg.areas, { api: ['src/api'] });
    assert.equal(cfg.modules.benchmark, true);
    assert.equal(cfg.modules.telemetry, true, 'requires are written too');
  });

  test('toggling an object entry keeps its providers', () => {
    w(TMP, '.claude/yindee.json', {
      modules: { workflow: { enabled: true, providers: [{ id: 'house', type: 'builtin', priority: 5 }] } },
    });
    setModule(TMP, 'workflow', false);
    const cfg = JSON.parse(fs.readFileSync(configPath(TMP), 'utf8'));
    assert.equal(cfg.modules.workflow.enabled, false);
    assert.equal(cfg.modules.workflow.providers.length, 1);
  });

  test('setModule rejects an unknown module', () => {
    assert.throws(() => setModule(TMP, 'nope', true), /unknown module/);
  });
});

// -------------------------------------------------------------- providers ---

describe('provider chain', () => {
  test('falls back to builtin/core when no skill is installed', () => {
    const c = resolve(TMP).resolved.find((r) => r.module === 'concise-output');
    assert.equal(c.active.type, 'builtin');
    assert.equal(c.active.id, 'modules/concise-output.md');
  });

  test('an installed skill outranks the builtin fallback', () => {
    w(TMP, '.claude/skills/i-have-adhd/SKILL.md', '---\nname: i-have-adhd\n---\n\nbody\n');
    clearSkillCache();
    const c = resolve(TMP).resolved.find((r) => r.module === 'concise-output');
    assert.equal(c.active.type, 'skill');
    assert.equal(c.active.id, 'i-have-adhd');
    assert.equal(c.active.invocable, false, 'i-have-adhd is defer-only');
  });

  test('a skill is found by frontmatter name, not directory name', () => {
    // taste-skill ships skills/taste-skill/ whose skill name is design-taste-frontend.
    w(TMP, '.claude/skills/taste-skill/SKILL.md', '---\nname: design-taste-frontend\ndescription: x\n---\n\nbody\n');
    clearSkillCache();
    assert.ok(findSkill(TMP, 'design-taste-frontend'));
    const t = resolve(TMP).resolved.find((r) => r.module === 'taste-formatting');
    assert.equal(t.active.id, 'design-taste-frontend');
  });

  test('highest priority present wins across several installed skills', () => {
    w(TMP, '.claude/skills/documentation-and-adrs/SKILL.md', '---\nname: documentation-and-adrs\n---\n');
    w(TMP, '.claude/skills/code-review-and-quality/SKILL.md', '---\nname: code-review-and-quality\n---\n');
    clearSkillCache();
    const wf = resolve(TMP).resolved.find((r) => r.module === 'workflow');
    assert.equal(wf.active.id, 'code-review-and-quality', 'priority 40 beats priority 10');
  });

  test('ties resolve in declaration order', () => {
    const chain = resolve(TMP).resolved.find((r) => r.module === 'workflow').chain;
    const cores = chain.filter((p) => p.priority === 0);
    assert.equal(cores[0].type, 'core');
  });

  test('detection writes nothing', () => {
    const snapshot = () => execFileSync('git', ['status', '--porcelain'], { cwd: TMP, encoding: 'utf8' });
    execFileSync('git', ['init', '-q'], { cwd: TMP, stdio: 'pipe' });
    const before = snapshot();
    resolve(TMP);
    assert.equal(snapshot(), before);
  });
});

// ------------------------------------------------------------------ render ---

describe('renderModules', () => {
  test('shows state, source and the winning provider', () => {
    const out = renderModules(resolve(TMP));
    assert.match(out, /concise-output\s+on\s+default/);
    assert.match(out, /benchmark\s+off/);
    assert.match(out, /defer only|modules\/concise-output\.md/);
  });

  test('verbose lists the whole chain with priorities', () => {
    const out = renderModules(resolve(TMP), { verbose: true });
    assert.match(out, /i-have-adhd \(skill, 10\)/);
    assert.match(out, /code-review-and-quality \(skill, 40\)/);
  });

  test('warnings surface in the table', () => {
    const out = renderModules(resolve(TMP, { module: 'nope' }));
    assert.match(out, /warn\s+unknown module "nope"/);
  });
});

// --------------------------------------------------------------------- CLI ---

describe('CLI gating', () => {
  test('benchmark is disabled by default and exits 0', () => {
    const out = run(['benchmark', 'start']);
    assert.match(out, /benchmark disabled/);
    assert.equal(fs.existsSync(path.join(TMP, '.claude/yindee/telemetry')), false);
  });

  test('no telemetry is written when the module is off', () => {
    run(['map']);
    run(['context', 'add rate limiting']);
    assert.equal(fs.existsSync(path.join(TMP, '.claude/yindee/telemetry')), false);
  });

  test('opting in restores benchmark and telemetry', () => {
    const out = run(['benchmark', 'start'], { env: { YINDEE_MODULES: 'benchmark' } });
    assert.match(out, /benchmark started/);
    run(['map'], { env: { YINDEE_MODULES: 'benchmark' } });
    assert.ok(fs.existsSync(path.join(TMP, '.claude/yindee/telemetry')));
  });

  test('modules list and enable/disable round-trip', () => {
    assert.match(run(['modules']), /benchmark\s+off/);
    const enabled = run(['modules', 'enable', 'benchmark']);
    assert.match(enabled, /benchmark\s+on/);
    assert.match(run(['benchmark', 'status']), /no session running/);
    run(['modules', 'disable', 'benchmark']);
    assert.match(run(['benchmark', 'status']), /benchmark disabled/);
  });

  test('modules --json is machine-readable', () => {
    const data = JSON.parse(run(['modules', '--json']));
    assert.equal(data.level, 'quiet');
    assert.ok(data.resolved.find((r) => r.module === 'benchmark' && r.enabled === false));
  });

  test('enabling an unknown module fails cleanly', () => {
    let err;
    try {
      run(['modules', 'enable', 'nope']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected a non-zero exit');
    assert.match(String(err.stdout), /unknown module "nope"/);
    assert.equal(fs.existsSync(path.join(TMP, '.claude/yindee.json')), false, 'nothing written');
  });
});
