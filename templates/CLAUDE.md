# {{REPO}}

<!-- Keep this file short. It is loaded into context on every request, so it holds only what is
     true for every task. Everything else is loaded on demand — see the router below. -->

## Conventions

- Follow the style of the file you are editing; match its naming, error handling and test layout.
- Never weaken tests, types, lint rules, authorization or CI to make verification pass.
- Commit only files you changed deliberately. One branch, one intent.

{{YINDEE_BLOCK}}

## Where to look

- Layout, packages, commands, CI → `yindee map` (generated; do not hand-maintain)
- What a task needs → `yindee context "<task>"`
- Work status (issues, PRs, CI) → GitHub, via `yindee status`
