# Module: intelligence

**Provider:** `repo-index` in a git repository, otherwise `live-scan` (core). On by default.

Repository Intelligence answers **what** and **where**: which files exist, what they declare,
what they import. It is derived from git and from paths — never from prose — so it cannot be
out of date without git knowing.

## What it changes for you

Nothing you must do. `Y context` and `Y impact` consume it automatically. Two things get better:

- **The file list is complete.** The live scan stops at depth 6 and 3000 entries; the index has
  no cap, so a deep or distant file that matches a task is no longer invisible.
- **`Y impact` can name file-level dependents** — "these 8 files may import what you changed" —
  which manifests cannot express, because they only describe package-to-package edges.

## What it does not change

**Candidate scoring.** The weights, the threshold and the ordering are identical with and
without the index; only the source of the file list moves. That is why it is safe on by
default, and a test asserts it. If you ever need today's exact pre-index behavior:
`Y context "<task>" --no-module intelligence`.

## Known limits — read these before trusting a symbol

Imports and top-level declarations are extracted by **line-level regex, not a parser**. Node
ships no AST for these languages and the harness has no dependencies, so this is a deliberate
trade, not an oversight.

It misses: dynamic `import()`, re-exports through barrel files, macro- and decorator-generated
symbols, and anything assembled from strings.

Consequences you must respect:

- A file-level dependent list is a **superset by name match**, not a resolved graph. Present it
  as "may import", never as "imports". `Y impact` labels it that way; keep the label.
- A missing symbol means the extractor did not see it, **not** that it does not exist. Never
  conclude "there is no such function" from the index. `git grep` remains the ground truth.
- Nothing here changes a risk tier or a verification plan. `Y impact` decides those from paths
  and packages, as it always has.

## Operating it

```
Y intel              what is indexed, how fresh, how large
Y intel rebuild      drop the store and build from scratch
```

The index lives in `.claude/yindee/index/`, is excluded from git, and is safe to delete at any
time. It updates from `git diff` against the last indexed commit, so a warm run on a clean tree
reads no files at all.

Concurrent sessions share it: writers take an advisory lock, readers never block, and a session
that loses the race computes in memory for that call instead of waiting.
