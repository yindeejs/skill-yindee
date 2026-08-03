# skill-yindee

<!-- Keep this file short. It is loaded into context on every request, so it holds only what is
     true for every task. Everything else is loaded on demand — see the router below. -->

## Conventions

- Follow the style of the file you are editing; match its naming, error handling and test layout.
- Never weaken tests, types, lint rules, authorization or CI to make verification pass.
- Commit only files you changed deliberately. One branch, one intent.

<!-- yindee:start -->
## Yindee harness

Deterministic project map, change-impact and verification live in scripts — do not rediscover
the repo by reading it. This repo *is* the harness, so run it from the source tree,
not from a vendored copy: `node scripts/yindee.mjs <cmd>`:

| When | Command |
| --- | --- |
| start of any task | `map` — layout, packages, commands, CI (cached; initializes on first use) |
| before opening files | `context "<task>"` — which packages/rules/files to read |
| after editing | `impact` — changed files, risk tier, verification plan |
| verify | `verify` — runs that plan, reports failures only |
| before commit/PR | `review` — bounded diff + path-scoped checklist |
| which behaviors are on | `modules` — and who provides each one |

Measurement is an opt-in module and is off by default. Unless `modules` reports `benchmark` as
on, state no elapsed time, no token usage and no cost — you have no way to measure them.

If a script can answer it, do not explore it. Task breadth does not justify repository breadth.
`context` prints an `explore` level — obey it. Broad, repo-wide agents are not permitted without
first stating "Yindee deterministic retrieval insufficient because …". When it prints `phases`,
work one phase per pass instead of widening the search.

Path-scoped rules load on demand from `rules/` (frontend, backend, database, security) —
read only the ones `context`/`impact` name. Module docs load the same way from
`modules/` — read only the ones `modules` reports as on.
<!-- yindee:end -->

## Where to look

- Layout, packages, commands, CI → `yindee map` (generated; do not hand-maintain)
- What a task needs → `yindee context "<task>"`
- Work status (issues, PRs, CI) → GitHub, via `yindee status`
