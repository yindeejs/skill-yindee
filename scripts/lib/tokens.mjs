// Claude Code token usage — read, never estimated.
//
// Claude Code persists every assistant turn to a session transcript as JSONL
// under `<config>/projects/<slug>/<session-id>.jsonl`. Each assistant record
// carries the raw `message.usage` block the API returned. That is structured
// data written by the runtime, not scraped UI text, so it is the only source
// this file will accept.
//
// If the transcript cannot be located or carries no usage, the answer is
// `unavailable`. There is no fallback, no heuristic and no estimate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDir, exists } from './fsx.mjs';

/** Where Claude Code keeps its state. `CLAUDE_CONFIG_DIR` wins when set. */
export function configDir(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return path.resolve(env.CLAUDE_CONFIG_DIR);
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude');
}

/** Session id of the Claude Code session that spawned us, if any. */
export const sessionIdOf = (env = process.env) =>
  env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || null;

/**
 * Locate `<session-id>.jsonl`. The project directory name is a slug of the cwd,
 * but the slugging rule is Claude Code's business — so we scan `projects/*`
 * for the file instead of trying to reproduce it.
 */
export function findTranscript(sessionId, env = process.env) {
  if (!sessionId) return null;
  const projects = path.join(configDir(env), 'projects');
  if (!exists(projects)) return null;
  const file = `${sessionId}.jsonl`;
  for (const entry of listDir(projects)) {
    if (!entry.isDirectory()) continue;
    const p = path.join(projects, entry.name, file);
    if (exists(p)) return p;
  }
  return null;
}

const EMPTY = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

/**
 * Sum `message.usage` across a transcript, optionally windowed to
 * [fromISO, toISO]. Streaming writes the same request several times, so
 * records are de-duplicated by `requestId` — summing raw lines would multiply
 * every number by the number of partial writes.
 */
export function readTranscriptUsage(file, { from = null, to = null } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'unavailable', reason: `transcript unreadable: ${file}` };
  }

  const byRequest = new Map();
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    const usage = rec?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const ts = rec.timestamp || null;
    if (from && ts && ts < from) continue;
    if (to && ts && ts > to) continue;
    // No requestId (older records) still deserves its own bucket; fall back to
    // the message id, then to the record uuid, which is unique per line.
    byRequest.set(rec.requestId || rec.message?.id || rec.uuid, usage);
  }

  if (!byRequest.size) {
    return { status: 'unavailable', reason: 'transcript contains no usage records for this window' };
  }

  const totals = EMPTY();
  for (const u of byRequest.values()) {
    totals.inputTokens += Number(u.input_tokens) || 0;
    totals.outputTokens += Number(u.output_tokens) || 0;
    totals.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
    totals.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
  }
  return {
    status: 'ok',
    source: 'claude-code-session-transcript',
    transcript: file,
    requests: byRequest.size,
    ...totals,
    totalTokens:
      totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens,
    ...(malformed ? { malformedLines: malformed } : {}),
  };
}

/**
 * Actual Claude token usage for a telemetry window.
 * Returns `{ status: 'unavailable', reason }` whenever anything is missing —
 * callers must render that verbatim rather than substituting a guess.
 */
export function readTokenUsage({ sessionId, transcript, from = null, to = null, env = process.env } = {}) {
  const id = sessionId || sessionIdOf(env);
  const file = (transcript && exists(transcript) ? transcript : null) || findTranscript(id, env);
  if (!file) {
    return {
      status: 'unavailable',
      reason: id
        ? `no session transcript found for ${id} under ${path.join(configDir(env), 'projects')}`
        : 'not running inside a Claude Code session (no CLAUDE_CODE_SESSION_ID)',
    };
  }
  return readTranscriptUsage(file, { from, to });
}

// ------------------------------------------------------------- subagents ---

/**
 * Subagent types that go looking around a repository. Naming them is how the
 * exploration policy gets an honest scoreboard: "did this run spawn the thing
 * the policy exists to prevent?"
 */
export const EXPLORATION_AGENTS = new Set(['Explore', 'general-purpose', 'Plan']);

/**
 * Subagent activity in a transcript window, read the same way usage is: from
 * structured records the runtime wrote.
 *
 * Two independent signals, reported separately because they can be observable
 * at different times:
 *   · `spawned`   — `Task` tool_use blocks in the main transcript
 *   · `sidechain` — usage on records flagged `isSidechain`, i.e. tokens the
 *                   subagents themselves burned
 * A window with a readable transcript and no Task blocks is a measurement of
 * zero, not a missing measurement — that distinction is the whole point here.
 */
export function readAgentActivity({ sessionId, transcript, from = null, to = null, env = process.env } = {}) {
  const id = sessionId || sessionIdOf(env);
  const file = (transcript && exists(transcript) ? transcript : null) || findTranscript(id, env);
  if (!file) {
    return {
      status: 'unavailable',
      reason: id ? `no session transcript found for ${id}` : 'not running inside a Claude Code session',
    };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'unavailable', reason: `transcript unreadable: ${file}` };
  }

  const byType = {};
  let spawned = 0;
  let exploration = 0;
  const sideRequests = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = rec.timestamp || null;
    if (from && ts && ts < from) continue;
    if (to && ts && ts > to) continue;

    const content = rec?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || block?.name !== 'Task') continue;
        const type = block.input?.subagent_type || '(unspecified)';
        spawned++;
        byType[type] = (byType[type] || 0) + 1;
        if (EXPLORATION_AGENTS.has(type)) exploration++;
      }
    }
    if (rec.isSidechain === true && rec?.message?.usage) {
      sideRequests.set(rec.requestId || rec.message?.id || rec.uuid, rec.message.usage);
    }
  }

  let sidechainTokens = 0;
  for (const u of sideRequests.values()) {
    sidechainTokens +=
      (Number(u.input_tokens) || 0) +
      (Number(u.output_tokens) || 0) +
      (Number(u.cache_read_input_tokens) || 0) +
      (Number(u.cache_creation_input_tokens) || 0);
  }

  return {
    status: 'ok',
    source: 'claude-code-session-transcript',
    transcript: file,
    spawned,
    exploration,
    byType,
    sidechain: sideRequests.size
      ? { status: 'ok', requests: sideRequests.size, totalTokens: sidechainTokens }
      : {
          status: 'unavailable',
          reason: 'no sidechain usage records in this transcript (subagent turns may be logged elsewhere)',
        },
  };
}

/**
 * Yindee's OWN generated context, in tokens. This is an ESTIMATE over bytes
 * Yindee printed — it is never Claude's usage and must always be rendered with
 * its label attached.
 */
export function estimateContextTokens(bytes) {
  return { label: 'estimate', method: 'contextCharacters/4', value: Math.round((Number(bytes) || 0) / 4) };
}
