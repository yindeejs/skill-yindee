// Git/GitHub state. Everything degrades gracefully: no repo, no remote, no
// upstream and no `gh` all still produce a usable answer.
import { capture, lines, run, have } from './sh.mjs';
import { toPosix, uniq } from './util.mjs';

const g = (root, args) => capture(`git ${args}`, { cwd: root });

export const isRepo = (root) => g(root, 'rev-parse --is-inside-work-tree') === 'true';

export function currentBranch(root) {
  return g(root, 'rev-parse --abbrev-ref HEAD') || null;
}

export function upstream(root) {
  return g(root, 'rev-parse --abbrev-ref --symbolic-full-name @{u}') || null;
}

/** Best guess at the integration branch, preferring what the remote declares. */
export function defaultBranch(root) {
  const head = g(root, 'symbolic-ref --quiet refs/remotes/origin/HEAD');
  if (head) return head.replace('refs/remotes/origin/', '');
  const remoteShow = capture('git remote show origin', { cwd: root, timeout: 8000 });
  const m = remoteShow && remoteShow.match(/HEAD branch:\s*(\S+)/);
  if (m && m[1] !== '(unknown)') return m[1];
  for (const cand of ['main', 'master', 'develop', 'trunk']) {
    if (g(root, `rev-parse --verify --quiet refs/remotes/origin/${cand}`)) return cand;
    if (g(root, `rev-parse --verify --quiet refs/heads/${cand}`)) return cand;
  }
  return null;
}

export function remoteInfo(root) {
  const url = g(root, 'remote get-url origin');
  if (!url) return { url: null, host: null, slug: null };
  const m = url.match(/(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) return { url, host: null, slug: null };
  return { url, host: m[1], slug: m[2] };
}

function parsePorcelain(out) {
  const files = [];
  for (const raw of out.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const status = raw.slice(0, 2);
    let file = raw.slice(3).trim();
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    // Renames show as "old -> new"; the new path is what matters.
    const arrow = file.indexOf(' -> ');
    if (arrow !== -1) file = file.slice(arrow + 4);
    files.push({ path: toPosix(file), status: status.trim() || '??' });
  }
  return files;
}

/**
 * Changed files for the current unit of work.
 * mode: 'auto' (branch vs base + working tree) | 'worktree' | 'staged' | 'branch'
 */
export function changedFiles(root, opts = {}) {
  const mode = opts.mode || 'auto';
  const base = opts.base || null;
  const out = { files: [], base: null, sources: [] };
  if (!isRepo(root)) return out;

  const add = (paths, source) => {
    for (const p of paths) {
      const path = typeof p === 'string' ? toPosix(p) : p.path;
      if (!path) continue;
      if (!out.files.some((f) => f.path === path)) {
        out.files.push({ path, status: typeof p === 'string' ? 'M' : p.status });
      }
    }
    if (paths.length) out.sources.push(source);
  };

  if (mode === 'staged') {
    add(lines(`git diff --name-only --cached`, { cwd: root }), 'staged');
    return out;
  }

  if (mode === 'auto' || mode === 'worktree') {
    const porcelain = capture('git status --porcelain=v1 --untracked-files=all', { cwd: root });
    if (porcelain) add(parsePorcelain(porcelain), 'worktree');
  }

  if (mode === 'auto' || mode === 'branch') {
    const br = currentBranch(root);
    const baseBranch = base || defaultBranch(root);
    if (baseBranch && br && br !== baseBranch && br !== 'HEAD') {
      const ref = g(root, `rev-parse --verify --quiet refs/remotes/origin/${baseBranch}`)
        ? `origin/${baseBranch}`
        : baseBranch;
      const mergeBase = g(root, `merge-base ${ref} HEAD`);
      if (mergeBase) {
        out.base = ref;
        add(lines(`git diff --name-only ${mergeBase}..HEAD`, { cwd: root }), `branch vs ${ref}`);
      }
    }
  }

  return out;
}

export function diffStat(root, base) {
  const range = base ? `${base}...HEAD` : 'HEAD';
  return g(root, `diff --stat ${range}`) || g(root, 'diff --stat') || '';
}

/** Unified diff for review. Includes the working tree so uncommitted work is reviewable. */
export function unifiedDiff(root, opts = {}) {
  const { base = null, context = 3, paths = [] } = opts;
  const pathArgs = paths.length ? ' -- ' + paths.map((p) => `"${p}"`).join(' ') : '';
  const chunks = [];
  if (base) {
    const mergeBase = g(root, `merge-base ${base} HEAD`) || base;
    const d = g(root, `diff -U${context} ${mergeBase}..HEAD${pathArgs}`);
    if (d) chunks.push(d);
  }
  const worktree = g(root, `diff -U${context} HEAD${pathArgs}`);
  if (worktree) chunks.push(worktree);
  return chunks.join('\n');
}

export function aheadBehind(root) {
  const u = upstream(root);
  if (!u) return null;
  const out = g(root, `rev-list --left-right --count ${u}...HEAD`);
  if (!out) return null;
  const [behind, ahead] = out.split(/\s+/).map(Number);
  return { ahead, behind, upstream: u };
}

export function recentCommits(root, n = 5) {
  return lines(`git log --oneline -${n}`, { cwd: root });
}

export function worktrees(root) {
  return lines('git worktree list', { cwd: root });
}

/** Issue number implied by the branch name (feat/123-thing, 123-thing, issue-123). */
export function issueFromBranch(branch) {
  if (!branch) return null;
  const m = branch.match(/(?:^|\/|-)(?:issue[-_]?)?(\d{1,6})(?:-|$)/);
  return m ? Number(m[1]) : null;
}

/** GitHub context via `gh`, when available and authenticated. Never blocks long. */
export function ghContext(root, branch) {
  if (!have('gh')) return { available: false };
  // Probe with the real query rather than a separate `gh auth status` call —
  // one network round trip instead of two.
  const prRes = run(
    `gh pr list --head "${branch}" --state open --limit 1 --json number,title,url,isDraft,statusCheckRollup`,
    { cwd: root, timeout: 20_000 },
  );
  if (!prRes.ok && /auth|login|token/i.test(prRes.out)) return { available: true, authed: false };
  const ctx = { available: true, authed: true, pr: null, issue: null };
  const prJson = prRes.ok ? prRes.stdout : null;
  if (prJson) {
    try {
      const arr = JSON.parse(prJson);
      if (arr[0]) {
        const checks = (arr[0].statusCheckRollup || []).map((c) => c.conclusion || c.state).filter(Boolean);
        ctx.pr = {
          number: arr[0].number,
          title: arr[0].title,
          url: arr[0].url,
          draft: arr[0].isDraft,
          checks: {
            total: checks.length,
            failing: checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c)).length,
            pending: checks.filter((c) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'].includes(c)).length,
          },
        };
      }
    } catch {
      /* ignore malformed gh output */
    }
  }
  const num = issueFromBranch(branch);
  if (num) {
    const issueJson = capture(`gh issue view ${num} --json number,title,state,labels,milestone`, {
      cwd: root,
      timeout: 20_000,
    });
    if (issueJson) {
      try {
        const i = JSON.parse(issueJson);
        ctx.issue = {
          number: i.number,
          title: i.title,
          state: i.state,
          labels: (i.labels || []).map((l) => l.name),
          milestone: i.milestone?.title || null,
        };
      } catch {
        /* ignore */
      }
    }
  }
  return ctx;
}

export function state(root) {
  if (!isRepo(root)) return { isRepo: false };
  const branch = currentBranch(root);
  const remote = remoteInfo(root);
  return {
    isRepo: true,
    branch,
    base: defaultBranch(root),
    upstream: upstream(root),
    aheadBehind: aheadBehind(root),
    remote,
    dirty: (capture('git status --porcelain', { cwd: root }) || '').length > 0,
    worktrees: uniq(worktrees(root)).length,
  };
}
