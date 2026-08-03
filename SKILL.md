---
name: yindee
description: Token-efficient development harness. Deterministic scripts map the repo, scope context, tier risk, verify and review, so the model never rescans it. Use for any real development task in a codebase — feature work, bug fixes, refactors, reviews, and Git/GitHub workflow (issues, branches, PRs, CI). Cooperates with existing CLAUDE.md/AGENTS.md. Trigger with /yindee.
---

# /yindee — adaptive development harness

Scripts answer what scripts can answer. You spend tokens on judgement, not on rediscovering the
repository. **This file is a router: it names the step, the command prints the policy.**

`Y` = `node <this skill's directory>/scripts/yindee.mjs`. Every command takes `--repo <dir>`
(default: current repo root), `--json`, and `--verbose`.

**Language:** talk to the user in **Thai**. Everything internal — reasoning, code, commit
messages, PR text, subagent prompts — stays **English**.

## The loop

In order. Do not skip to implementing, and **do not stop at the first failed verification.**

| # | Step | How |
| --- | --- | --- |
| 1 | Understand | Read the task. If it names an issue: `gh issue view <n>`. |
| 2 | Orient | `Y map` — layout, packages, commands, CI. Cached. |
| 3 | Scope | `Y context "<task>"` — the packages, rules and files this task needs. `--reference <dir>` when the task names another repo. |
| 4 | Load minimum | Read **only** what step 3 named, plus the rule files it lists. |
| 5 | Implement | Edit those files. Match the surrounding code. |
| 6 | Classify | `Y impact` — changed files → affected packages → risk tier → verify plan. |
| 7 | Verify | `Y verify` — runs that plan, prints failures only. |
| 8 | Fix → re-verify | Fix the cause, re-run **7**. Repeat until green. |
| 9 | Review | `Y review` — bounded diff + path-scoped checklist + failure evidence. |
| 10 | Broaden | If review changed anything, or tier is `broad`/`critical`: `Y verify` again. |
| 11 | Ship | Commit / PR — read `references/workflow.md` first. |

Steps 2–3 replace repository exploration. If you catch yourself globbing `**/*` or opening files
to find your bearings, stop and run `Y context` instead.

## Standing rules

These precede any command, so they live here rather than in output.

- **Yindee owns repository discovery** — structure, stack, packages, tests, config, dependency
  edges, git impact, CI. Never spawn an agent to re-derive any of it. Agents are for reasoning.
  Task breadth does not justify repository breadth.
- **Obey the policy lines the commands print; do not summarize them.** `context` prints
  `explore` (how much searching is allowed) and `budget` (the ceiling on what you may open —
  finish a batch before asking for the next). `impact` prints the tier, why, the rules to read,
  and the plan. Override a tier only with a reason: `Y impact --tier critical`.
- **Never weaken a check** — test, type, lint rule, authorization or CI job — to pass verification.
- **Review the diff, not the repo.** Open a source file during review only to answer a question
  the diff raised.
- **Work alone by default.** A subagent starts empty and must re-derive what you already have.
- **The repo's `CLAUDE.md` / `AGENTS.md` win** over this skill on any conflict.

## Modules

Behavior beyond the loop is modular. Run `Y modules`; read the files it lists under `docs`, and
nothing else. Each module resolves to a **provider** — an installed skill when present, else
Yindee's own file — and `Y modules` names the winner. Never install a skill to satisfy a module.

`benchmark` is off by default, so **you have no clock and no view of your token usage**: state
no elapsed time, no token count, no cost. Say what now works. Do not reconstruct figures from
memory.

Two modules supply facts, and they do not carry the same authority. **`intelligence`** is
derived from git and the code — authoritative about what exists and where. **`knowledge`** is
human prose (ADRs, conventions, design notes) surfaced as a `why` line — it explains intent,
it can be out of date, and **on any conflict the code wins**. Never cite a document as evidence
about what the code does; check the code.

Enable per repo with `Y modules enable <name>`, or per command with `--module <name>` /
`YINDEE_MODULES=<name>`.

## Reference

- `Y help` — every command and flag. `Y intel` / `Y wiki` — what each layer knows.
- `references/workflow.md` — branches, commits, PRs, CI. Read before your first one.
- `README.md` — module table, risk tiers, supported stacks, per-repo config.

Wrong detection is a config fix, not a workaround: set `commands`, `areas`, `sensitive`,
`context` or `modules` in the repo's `.claude/yindee.json` so the next session inherits it.
