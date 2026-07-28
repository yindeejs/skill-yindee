---
name: yindee
description: Token-efficient development harness for any repository and stack. Deterministic scripts do the project mapping, stack detection, git/change-impact analysis, risk tiering, targeted verification and diff-first review, so the model never rescans the repo. Use for any real development task in a codebase — feature work, bug fixes, refactors, reviews, and Git/GitHub team workflow (issues, branches, PRs, CI). Cooperates with existing CLAUDE.md/AGENTS.md instead of replacing them. Trigger with /yindee.
---

# /yindee — adaptive development harness

Scripts answer what scripts can answer. You spend tokens on judgement, not on rediscovering the
repository.

**Language:** talk to the user in **Thai**. Everything internal — reasoning, code, commit messages,
PR text, subagent prompts — stays **English**.

`Y` below means `node <this skill's directory>/scripts/yindee.mjs`. Every command takes
`--repo <dir>` (defaults to the current repo root) and `--json`.

## The loop

Run it in order. Do not skip to implementing, and **do not stop at the first failed verification.**

| # | Step | How |
| --- | --- | --- |
| 0 | Measure | `Y benchmark start --label "<task>"` — idempotent; safe to run every time. |
| 1 | Understand | Read the task. If it names an issue: `gh issue view <n>`. |
| 2 | Orient | `Y map` — layout, packages, commands, CI. Cached; costs ~15 lines. Initializes the project on first use, so `Y init` is optional. |
| 3 | Scope | `Y context "<task>"` — the packages, rules and files this task needs, inside a context budget. Add `--reference <dir>` when the task names another repo. |
| 4 | Load minimum | Read **only** what step 3 named, plus the rule files it lists. |
| 5 | Implement | Edit those files. Match the surrounding code. |
| 6 | Classify | `Y impact` — changed files → affected packages → risk tier → verify plan. |
| 7 | Verify | `Y verify` — runs that plan, prints failures only. |
| 8 | Fix → re-verify | Fix the cause and re-run **7**. Repeat until green. Never weaken a check. |
| 9 | Review | `Y review` — bounded diff + path-scoped checklist + failure evidence. |
| 10 | Broaden | If review changed anything, or tier is `broad`/`critical`: `Y verify` again. |
| 11 | Ship | Commit / PR — see `references/workflow.md`. |
| 12 | Close the measurement | `Y benchmark stop` — prints the measured run. Quote it; never restate it from memory. |

Steps 2–3 replace repository exploration. If you catch yourself globbing `**/*` or reading files to
find your bearings, stop and run `Y context` instead.

## Exploration policy (step 3 decides, not you)

**If a script can answer it, you must not explore it. Task breadth does not justify repository
breadth. Use agents for reasoning, never for rediscovering repository structure.**

Yindee owns repository discovery: structure, stack, packages, components, tests, configuration,
dependency edges, git impact, CI commands. Never spawn an agent to re-derive any of it.

`Y context` prints an `explore` line. Obey it:

| Level | What you may do |
| --- | --- |
| `none` | Open the files it listed. No agent. |
| `targeted` | **One** agent, sequential, path-scoped to the `scoped:` paths it printed. |
| `semantic` | **One** agent, for meaning grep cannot express. Still path-scoped. |
| `broad` | Never printed. Yindee does not recommend it. |

Before any broad, repo-wide agent you must first state, in the response: *"Yindee deterministic
retrieval insufficient because …"* — naming what you asked Yindee for and what it could not answer.
"The task is big" is not such a reason. Never run repository-wide agents in parallel.

When `context` prints `phases`, the task is broad: work one phase per pass
(`context --paths` → implement → `impact` → scoped `verify`), then verify broadly at the end.
Decompose the work; do not widen the search.

`budget` on the same output is the ceiling on what you may open. If it reports deferred files, finish
the current batch before asking for `--batch 2` — do not read the whole candidate set.

## Risk tiers (step 6 decides, not you)

| Tier | Trigger | Verification |
| --- | --- | --- |
| `docs` | documentation only | none |
| `standard` | 1–2 packages, ordinary code | scoped lint + typecheck + tests for those packages |
| `broad` | 3+ packages, shared package, cross-layer, or dependency change | affected-graph or workspace-wide lint/typecheck/test/build |
| `critical` | auth, permissions, secrets, migrations, schema, CI, lockfiles | full verification + `security.md`/`database.md` + deep review |

Override only with a reason: `Y impact --tier critical`.

## Token discipline

- **Never scan the whole repository.** `Y map` and `Y context` exist so you don't have to.
- **Load rules on demand.** Read `rules/{frontend,backend,database,security}.md` only when `context`
  or `impact` names them. Never read all four.
- **Review the diff, not the repo.** `Y review` is the review input. Open a source file during
  review only to resolve a specific question the diff raised.
- **Prefer the deterministic answer.** Anything git, the build system, tests, CI or a script can
  decide must not cost model reasoning.
- **Command output is evidence, not scrollback.** `Y verify` already truncates to the failing lines;
  don't re-run tools with verbose flags unless the excerpt was genuinely insufficient.
- **Work alone by default.** You have the whole context; a subagent starts empty and must re-derive
  it. Spawn one only when the exploration policy above allows it, or for large independent parallel
  edits with non-overlapping file sets. Never one agent per technology, and never one per repository.
- **A second repo is a reference, not a second context.** `Y context "<task>" --reference <dir>`
  maps it deterministically and returns the few files that pair with yours. Never explore it.

## Reporting: measured, never estimated

You have no clock and no view of your own token usage. **Every number in a final report comes from
`Y benchmark`, or it does not appear.**

- **Never state elapsed time you did not read from `Y benchmark`.** You cannot tell how long a task
  took. "About 20 minutes" is a fabrication even when it happens to be close.
- **Never invent Claude token usage.** If the report says `unavailable`, write exactly:
  > Token usage unavailable from runtime telemetry
- **Never dress a Yindee number up as a Claude number.** `Yindee context` is bytes Yindee printed.
  `Estimated tokens` is those bytes ÷ 4 — it is Yindee's own output, labelled `estimate`, and it is
  never the size of your context window, your prompt, or your billed usage.
- **Never derive tokens from time**, from file counts, or from anything else. There is no conversion.
- If no session was running, say so — do not reconstruct the numbers from what you remember doing.

`Y benchmark stop` prints the whole report. Paste its figures; do not re-derive or round them.

```
Y benchmark start [--label "<name>"]   open a session (idempotent; --restart replaces)
Y benchmark status                     live counters for the open session
Y benchmark stop                       close it, persist the run, print the report
Y benchmark report [<run>] [--json]    re-render a run (defaults to the open session)
Y benchmark compare <a> <b> [--json]   deltas between two runs
Y benchmark list / prune [--keep N]    bounded history (default 20 runs)
```

Duration is measured from real timestamps taken by the process; per-command and shell durations use a
monotonic clock. Actual Claude token usage is read from the Claude Code session transcript when one is
reachable, and reported as `unavailable` when it is not.

## Cooperate, never overwrite

- The repo's `CLAUDE.md` / `AGENTS.md` **win** over this skill's rules on any conflict. `Y map` and
  `Y context` list them; per-package `CLAUDE.md` files are surfaced by `context`.
- Never rewrite a project's instructions to suit the harness. `Y install` only ever adds a marked
  block to an existing `CLAUDE.md`.
- Generated state lives in `.claude/yindee/` and is excluded via `.git/info/exclude` — nothing the
  harness generates is ever committed or shown in a teammate's `git status`.

## Team workflow

`Y status` — branch, base, ahead/behind, changed files, tier, open PR + CI checks, linked issue.

Read `references/workflow.md` before your first branch, commit or PR, and whenever work spans more
than one intent. Short version: GitHub holds work status — never mirror it into Markdown; one
branch per intent; draft PR until local verification is green; never `--no-verify`; never touch a
branch or working tree you do not own.

## Commands

```
Y init [--refresh] [--json]              detect stack/packages/commands/CI, cache the map (automatic)
Y map [--force] [--verbose]              layout, packages, deps, commands, CI  (cached)
Y context "<task>" [--paths a,b]         packages + rules + files for this task
        [--reference <dir>]              compare against another repo, deterministically
        [--batch N] [--max-bytes N]      context budget: next batch / raise the ceiling
Y impact [--base <ref>] [--tier T]       changed files → affected → tier → plan
Y verify [--dry-run] [--only lint,test]  run the plan; failures only
Y verify --ci                            run the commands CI itself declares
Y review [--max-lines N]                 bounded diff + checklist + failure evidence
Y status                                 branch, PR, CI, issue, last verify
Y install [--target <dir>]               vendor the harness into a repo
Y doctor                                 environment + detection self-check
Y benchmark start|stop|report|compare    measured telemetry for the task (see above)
```

If a command reports something wrong about the repo (missing command, wrong package), fix it in the
repo's `.claude/yindee.json` (`commands`, `areas`, `sensitive`, `context` overrides) rather than
working around it by hand — the next session inherits the fix. The context budget lives there too:
`{ "context": { "maxFiles": 20, "maxBytes": 150000 } }`.
