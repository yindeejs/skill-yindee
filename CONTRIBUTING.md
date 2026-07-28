# Contributing to Yindee

Thanks for your interest. Yindee is small on purpose, and staying small is a feature — please read
the two principles below before opening a PR, because most review feedback here traces back to one of
them.

## The two rules

### 1. Zero dependencies

Yindee ships no runtime dependencies and no build step. `package.json` has no `dependencies` and no
`devDependencies`: tests run on `node --test`, which is in the standard library.

This is not minimalism for its own sake. Yindee gets vendored into other people's repositories by
`yindee install`, and runs inside agent sessions and CI. A dependency there is a supply-chain surface,
an install step, and a version conflict in somebody else's project.

If you need something a dependency would give you, write the small version of it. `toml.mjs` and
`globToRegex` in `util.mjs` exist for exactly this reason. A ~60-line parser that handles the cases
Yindee actually meets beats a general one that costs everyone an install.

A PR that adds a dependency needs to argue why the feature is worth that cost, and will usually be
asked to inline a narrower implementation instead.

### 2. Deterministic-first

> If git, the build system, the test runner, CI, or a filesystem walk can answer it,
> it must not cost model reasoning.

Yindee's value is that its answers are computed, not guessed. Concretely:

- **Same input, same output.** The map is cached behind a fingerprint; identical repo state must
  produce an identical map, tier and plan.
- **No estimating what can be measured.** This applies hardest to telemetry: elapsed time comes from a
  clock, token usage comes from the runtime's own records. When a measurement is unavailable, say
  `unavailable` — never substitute a plausible number. See `scripts/lib/tokens.mjs`.
- **No network calls** in detection, mapping, context or impact. `gitx.mjs` may shell out to `gh`, and
  degrades gracefully when it is missing or unauthenticated.
- **Bounded everything.** Filesystem walks are capped by depth and entry count; diffs and command
  output are capped by line budgets. No command may accidentally traverse a whole monorepo or dump a
  10k-line log.
- **Never fatal on a broken environment.** No git, no remote, no upstream, no `gh`, a read-only
  checkout, a corrupt cache — each must still produce a usable answer.

## Development setup

Requirements: **Node.js ≥ 18**. That is the whole setup.

```bash
gh repo clone yindeejs/skill-yindee
cd skill-yindee

npm test                          # full suite, node --test
npm run lint                      # syntax check
node scripts/yindee.mjs doctor    # environment + detection self-check
```

Run the harness against a real project while you work:

```bash
node scripts/yindee.mjs map --repo /path/to/some/project
node scripts/yindee.mjs context "a task in that project" --repo /path/to/some/project
```

## Architecture

One command per question. Each module answers one thing and does not reach past its own concern.

```
scripts/yindee.mjs        CLI: arg parsing, dispatch, output, telemetry recording
scripts/lib/
  detect.mjs              stacks, package manager, workspaces, commands, CI, per-repo config
  map.mjs                 assembles + caches the project map
  areas.mjs               path -> area + sensitivity (the single source of path classification)
  context.mjs             task -> packages, rules, files
  impact.mjs              changed files -> dependents -> risk tier -> verification plan
  verify.mjs              executes a plan, extracts failing evidence
  review.mjs              bounded diff + path-scoped checklist
  gitx.mjs                git and GitHub state
  telemetry.mjs           session lifecycle, event log, aggregation, run history
  tokens.mjs              actual token usage, or "unavailable"
  benchmark.mjs           report + comparison rendering (presentation only)
  sh.mjs fsx.mjs util.mjs toml.mjs   subprocess, filesystem, helpers, TOML
tests/
  harness.test.mjs        detection, mapping, areas, impact, context, review
  telemetry.test.mjs      timing, lifecycle, counters, tokens, comparison, persistence
```

Things worth knowing before you change them:

- **`map.mjs` carries a harness fingerprint.** It hashes the detection modules, so improving detection
  invalidates already-cached maps. If you add a module that changes detection output, add it to that
  file list — otherwise users keep a stale map forever.
- **`areas.mjs` is the only place paths get classified.** Impact, context and review all defer to it.
  Fix classification bugs there, not at the call site.
- **The map is the only thing `impact` sees.** Anything `impact` needs must be *in* the map — a field
  that stops at `detect()` is invisible to it.
- **`benchmark.mjs` renders, it does not measure.** Every number reaching it is already measured.
- **Generated state lives in `.claude/yindee/`** and is excluded from git. Nothing Yindee generates may
  appear in a user's `git status`.

## Tests

```bash
npm test
node --test tests/telemetry.test.mjs      # one file
```

Every PR that changes behaviour needs a test. Some conventions that make the suite useful:

- **Test against real fixture repos.** The suite builds actual node/cargo/go workspaces in a temp dir
  and runs the real code over them. Prefer that to mocking a filesystem.
- **Name the regression.** Where a test exists because something broke, the comment says so
  (`// Regression: a shared type edit used to classify as "other" and skip verification.`). That
  comment is why the next person will not "simplify" the fix away.
- **Assert the honest-failure paths too**, not just the happy ones: unavailable token usage, corrupt
  caches, interrupted sessions, missing git, empty sessions.
- **No flaky timing assertions.** Timing tests busy-wait on a bound and assert monotonicity, not exact
  durations.

Tests must pass on Linux, macOS and Windows. Watch out for path separators (`toPosix`), line endings,
and Windows file locks in cleanup.

## Pull requests

- **One intent per PR.** A bug fix and a refactor in the same diff take twice as long to review.
- **Say what breaks if you are wrong.** A short "here's the failure this prevents" is worth more than
  a long description of the code.
- **Include the test.** See above.
- **Keep the docs true.** If you change a command, flag, or output shape, update `README.md` and
  `SKILL.md` in the same PR. `SKILL.md` is what the agent reads — an out-of-date instruction there is
  a behaviour bug, not a docs nit.
- **No unsupported performance claims.** Do not add token-saving or time-saving numbers to the docs
  unless they come from a reproducible `yindee benchmark` comparison, and say how it was measured.
- **Never weaken a check to make CI pass.** Not tests, not types, not lint rules. That rule is in the
  harness's own instructions; it applies to the harness itself.

Run before pushing:

```bash
npm test && npm run lint
```

## Reporting bugs

The most useful bug report for a detection or impact issue includes the output of:

```bash
node scripts/yindee.mjs doctor --repo /path/to/repo
node scripts/yindee.mjs map --repo /path/to/repo
```

Please redact anything private — those outputs contain package names, paths and commands.

Before filing a detection bug, check whether `.claude/yindee.json` solves it (`commands`, `areas`,
`sensitive` overrides — see the README). If the override was needed for something Yindee should have
detected on its own, that is the bug worth reporting.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
