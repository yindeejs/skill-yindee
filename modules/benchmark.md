# Module: benchmark

**Provider:** `core` — `Y benchmark`. Requires the `telemetry` module, which is enabled
automatically with this one.

Disabled by default. When it is off, no measurement is taken and **no numbers appear in your
report** — that is the correct behavior, not a gap to fill from memory.

## The loop, with measurement

Wrap the normal loop:

| # | Step | How |
| --- | --- | --- |
| 0 | Measure | `Y benchmark start --label "<task>"` — idempotent; safe to run every time. |
| … | The normal steps 1–10 from `SKILL.md` | unchanged |
| 11 | Close the measurement | `Y benchmark stop` — prints the measured run. Quote it; never restate it from memory. |

## Reporting: measured, never estimated

You have no clock and no view of your own token usage. **Every number in a final report comes
from `Y benchmark`, or it does not appear.**

- **Never state elapsed time you did not read from `Y benchmark`.** You cannot tell how long
  a task took. "About 20 minutes" is a fabrication even when it happens to be close.
- **Never invent Claude token usage.** If the report says `unavailable`, write exactly:
  > Token usage unavailable from runtime telemetry
- **Never dress a Yindee number up as a Claude number.** `Yindee context` is bytes Yindee
  printed. `Estimated tokens` is those bytes ÷ 4 — it is Yindee's own output, labelled
  `estimate`, and it is never the size of your context window, your prompt, or your billed
  usage.
- **Never derive tokens from time**, from file counts, or from anything else. There is no
  conversion.
- If no session was running, say so — do not reconstruct the numbers from what you remember
  doing.

`Y benchmark stop` prints the whole report. Paste its figures; do not re-derive or round them.

## Commands

```
Y benchmark start [--label "<name>"]   open a session (idempotent; --restart replaces)
Y benchmark status                     live counters for the open session
Y benchmark stop                       close it, persist the run, print the report
Y benchmark report [<run>] [--json]    re-render a run (defaults to the open session)
Y benchmark compare <a> <b> [--json]   deltas between two runs
Y benchmark list / prune [--keep N]    bounded history (default 20 runs)
```

Duration is measured from real timestamps taken by the process; per-command and shell
durations use a monotonic clock. Actual Claude token usage is read from the Claude Code
session transcript when one is reachable, and reported as `unavailable` when it is not.

## Turning it off again

`yindee modules disable benchmark`. Stored runs survive and stay readable after re-enabling.
