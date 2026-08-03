# Module: telemetry

**Provider:** `core` — the recorder in `scripts/yindee.mjs`.

Disabled by default. When on, every Yindee command appends one event to the open session so
`benchmark` has something to aggregate. It is a prerequisite of `benchmark`, and enabling
`benchmark` enables it automatically.

## What is recorded

Per command: the command name, its duration, how many bytes it printed, how many shell
commands it ran and for how long, its exit code, and the command-specific facts it already
computes — files suggested, candidates ranked, budget hits, exploration level, risk tier,
verify steps and failures.

**Not recorded:** file contents, diffs, task text, prompts, model output, or anything from
outside the repo. Nothing leaves the machine — there is no network call anywhere in the
harness.

## Where it lives

```
.claude/yindee/telemetry/session.json    the open session
.claude/yindee/telemetry/session.jsonl   its events
.claude/yindee/telemetry/runs/<id>.json  completed runs (bounded; default 20)
```

`.claude/yindee/` is added to `.git/info/exclude`, so generated state never appears in a
teammate's `git status` and is never committed.

## Turning it off

`yindee modules disable telemetry`, or leave it at its default. With it off, no session file
is created and no event is written — the `finally` recorder in the CLI is skipped entirely.

Disabling telemetry while `benchmark` is on leaves benchmark with nothing to aggregate;
disable `benchmark` too.
