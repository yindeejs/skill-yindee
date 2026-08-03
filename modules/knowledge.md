# Module: knowledge

**Provider:** `local-wiki` when the repo has knowledge documents, otherwise `none` (core). On by
default, and completely inert when there is nothing to read.

The Knowledge Wiki answers **why**: ADRs, architecture decisions, conventions, framework notes,
design documents, the glossary, research notes.

## The rule that matters

> **The wiki explains intent. The code defines behavior. On any conflict, the code wins —
> and the conflict is worth reporting to the user.**

A document is a claim made by a person at a point in time. Repository Intelligence and git are
derived from the code and cannot lie; a document can be confidently, plausibly wrong. Treat the
`why` line as context for a decision you are about to make, never as evidence about what the
code does.

Specifically, never:

- cite a document as proof that a function exists, a flag is supported, or an API behaves a
  certain way — check the code;
- let a document change how thoroughly you verify. `Y impact` sets the tier; an ADR does not;
- treat a convention document as binding over the repo's `CLAUDE.md` / `AGENTS.md`, which win.

## What you get

One capped line in `Y context`, pointers only:

```
why    explains intent, not behavior — code wins on conflict:
  docs/adr/0007-token-rotation.md  adr · 2025-11-04
  docs/conventions/errors.md       convention · 2025-06-12  stale? refs src/old.ts missing
```

Only **titles and headings** are indexed — never body text. Opening a document is your decision,
and it costs what it costs; having a wiki costs a few lines. A document already listed under
`files` is not repeated here.

`stale?` means the document references a path that no longer exists at HEAD. It is a deliberate
signal, not a time heuristic: an old ADR can be perfectly correct, and a document written
yesterday can be wrong. Stale entries are still shown — a superseded decision often explains why
something exists — but weight them accordingly, and consider saying so to the user.

## Where it looks

Configured paths win:

```jsonc
{ "knowledge": { "paths": ["docs/adr", "docs/design", "notes/engineering"] } }
```

Otherwise: `docs/adr`, `docs/decisions`, `docs/design`, `docs/rfc`, `docs`, plus
`ARCHITECTURE.md`, `DESIGN.md`, `ADR.md`, `GLOSSARY.md`, `CONVENTIONS.md`.

## Yindee never writes here

The wiki is read-only. Yindee indexes documents; it does not create, edit or "maintain" them.
If a decision is worth recording, say so and let a human write it — authored knowledge is the
only kind worth reading.

```
Y wiki             what was found, by kind, and what looks stale
Y wiki rebuild     re-read the documents
```

With no documents present, there is no `why` line, no store, and no warning. That is the
designed state, not a degraded one.
