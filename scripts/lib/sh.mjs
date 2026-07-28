// Command execution with captured output. Sync on purpose: these run one at a
// time and the caller wants deterministic, ordered results.
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/**
 * Every subprocess this process spawned, timed on the monotonic clock.
 * Telemetry reads it at flush time; nothing here depends on telemetry, so the
 * counters cost one addition per command whether anyone is watching or not.
 */
export const shellStats = { count: 0, ms: 0 };

/**
 * Run a shell command string in `cwd`. Never throws.
 * Returns { ok, code, stdout, stderr, out, ms, timedOut }.
 */
export function run(cmd, opts = {}) {
  const started = performance.now();
  const res = spawnSync(cmd, {
    cwd: opts.cwd || process.cwd(),
    shell: true,
    encoding: 'utf8',
    timeout: opts.timeout ?? 15 * 60 * 1000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env || {}), CI: process.env.CI ?? '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    windowsHide: true,
  });
  const ms = Math.round(performance.now() - started);
  shellStats.count++;
  shellStats.ms += ms;
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  return {
    cmd,
    ok: res.status === 0,
    code: res.status ?? (res.error ? -1 : 1),
    stdout,
    stderr,
    out: (stdout + (stdout && stderr ? '\n' : '') + stderr).replace(/\s+$/, ''),
    ms,
    timedOut: res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM',
    error: res.error ? String(res.error.message) : null,
  };
}

/** Run and return trimmed stdout, or null when the command fails. */
export function capture(cmd, opts = {}) {
  const r = run(cmd, { timeout: 60_000, ...opts });
  return r.ok ? r.stdout.replace(/\s+$/, '') : null;
}

export function lines(cmd, opts = {}) {
  const out = capture(cmd, opts);
  if (!out) return [];
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const haveCache = new Map();
/** Is a binary on PATH? Cached per process. */
export function have(bin) {
  if (haveCache.has(bin)) return haveCache.get(bin);
  const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
  const ok = run(probe, { timeout: 10_000 }).ok;
  haveCache.set(bin, ok);
  return ok;
}
