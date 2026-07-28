# Git-native team workflow

Read this before your first branch, commit or PR in a session, and whenever work spans more than
one intent.

**GitHub is the source of truth for work status.** Issues, PR state, review comments, CI results and
milestones live there. Do not mirror them into Markdown files — a status doc is stale the moment
another developer pushes, and it conflicts on merge. `yindee status` reads the real state.

## The chain

```
milestone → issue → branch → commits → PR → CI → review → merge
```

Each step exists so the next one can be small. Skipping a step moves its cost later, it does not
remove it.

### 1. Start from an issue

Work that outlives one sitting gets an issue. `gh issue view <n>` is the spec — read it before
planning, not after.

```
gh issue list --milestone "<name>" --state open        # what's queued
gh issue view <n>                                       # the spec
gh issue create -t "<title>" -b "<body>" [-m "<milestone>"] [-l "<label>"]
```

No issue for a one-line fix is fine. One issue for five unrelated things is not.

### 2. One branch, one intent

```
git switch -c <type>/<issue>-<slug>      # feat/142-refresh-token-rotation
```

`<type>` ∈ feat, fix, chore, docs, refactor, perf, test. The issue number in the branch name is how
`yindee status` links the branch back to its issue and milestone — keep it.

**If the plan covers more than one intent, that is more than one branch and more than one PR.**
Split before writing code, not after. Reviewers reject a 40-file diff that does three things and
they are right to.

### 3. Concurrent developers

Before starting, check what else is live:

```
git fetch --prune
git worktree list                 # your own parallel lanes
gh pr list --state open           # what teammates hold
```

- **Another branch's commits, another PR's files, and another developer's uncommitted work are off
  limits.** Never rebase, amend, force-push or stash a branch you do not own.
- Two agents/sessions on one repo → one **worktree** each (`git worktree add ../repo-<slug> -b <branch>`),
  never two sessions editing the same working tree.
- Rebase your own branch on the base branch to stay current; never rebase a shared branch.

### 4. Commits

Conventional commits, imperative mood, scoped to one logical change:

```
<type>(<scope>): <what changed>          # feat(api): rotate refresh tokens on login
```

- Commit only files you touched deliberately — `git status` before every `git add`. Never `git add -A`
  in a repo you did not just inspect: it sweeps up other people's work and generated files.
- Reference the issue in the body (`Refs #142`), not the subject.
- Never `--no-verify`. If a hook fails, the hook found something.

### 5. PR

```
gh pr create --fill --base <base>          # add --draft while CI is still red
gh pr view --json number,title,statusCheckRollup
gh pr checks --watch
```

The PR body states: what changed, why, how it was verified, and `Closes #<issue>`. Paste the
`yindee verify` summary — that is the "how it was verified" line.

Open it as a **draft** until verification is green locally. A PR that lands red wastes every
reviewer who looks at it.

### 6. CI

CI is the shared verification contract; local verification is the fast approximation of it.

- CI red → read the failing job's log, reproduce locally with the same command
  (`yindee verify --ci` runs the commands the workflow declares), fix, push.
- **Never** disable a check, mark a test skipped, lower a coverage gate, or relax a lint rule to get
  green. If a check is genuinely wrong, that is its own PR with its own justification.

### 7. Review and merge

- Address review comments as new commits on the branch; don't force-push mid-review — reviewers lose
  their place.
- Merge only when CI is green and required approvals exist. Use the repo's merge strategy — check
  what previous PRs did rather than assuming squash.
- Delete the branch after merge; close the issue via the PR (`Closes #n`) rather than by hand.

## Where state lives

| State | Source of truth | Never |
| --- | --- | --- |
| What to build next | Issues + milestones | a `TODO.md` |
| Work in progress | branches, draft PRs | a `STATUS.md` |
| Whether it works | CI + `yindee verify` | a claim in a doc |
| Why it's built this way | ADR / `docs/`, committed with the change | a chat message |
| Repo layout & commands | `yindee map` (generated) | a hand-maintained map |
