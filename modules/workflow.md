# Module: workflow

**Providers, highest priority first:** `code-review-and-quality`,
`test-driven-development`, `debugging-and-error-recovery`, `documentation-and-adrs` — each
invoked via the Skill tool when installed — otherwise Yindee's own commands.

A judgement layer on top of the loop. It **never replaces** the deterministic core:
`Y context` still selects files, `Y impact` still decides the tier, `Y verify` still runs the
plan. These skills decide how well you think about what those commands hand you.

## Routing

| Situation | Provider, if installed | Fallback |
| --- | --- | --- |
| About to review a change | `code-review-and-quality` | `Y review` — bounded diff + path-scoped checklist |
| New behavior or a bug report | `test-driven-development` | Write the failing test first, then fix; `Y verify` proves it |
| A check failed | `debugging-and-error-recovery` | Root-cause it from the `Y verify` excerpt; never weaken the check |
| An architectural decision was made | `documentation-and-adrs` | Record it in the repo's existing docs location that `Y map` named |

## Rules that hold either way

1. **`Y review` is the review input.** Feed the skill the bounded diff — do not have it
   re-read the repository. Repository discovery belongs to Yindee.
2. **Never weaken a check to make it pass.** Not the test, not the type, not the lint rule,
   not the CI job.
3. **Fix the cause, then re-run `Y verify`.** Repeat until green. Do not stop at the first
   failure and do not report partial verification as done.
4. **A skill's advice does not change the tier.** If `Y impact` says `critical`, it is
   critical regardless of how simple the change looks.

## Exploration still applies

These skills are subject to the exploration policy in `SKILL.md`. If one wants to scan the
repository, give it the paths `Y context` printed instead.
