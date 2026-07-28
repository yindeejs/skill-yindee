# Backend rules

Loaded when a change touches APIs, handlers, services, jobs, workers or server-side code.

## Contracts

- **A public response shape is a contract.** Changing or removing a field breaks callers. Add
  rather than change; if you must change, version it or confirm every caller in the same repo.
- **Validate input at the edge**, once, into a typed shape — then the rest of the code trusts it.
  Do not re-validate defensively at every layer; do not skip it at the boundary.
- Say what an endpoint returns on failure and use the status/error type consistently with the rest
  of the codebase. Follow the existing envelope; do not invent a second error format.
- Keep contract-shaped changes (routes, DTOs, events, queue payloads) out of unrelated diffs —
  they need their own review.

## Failure handling

- **No swallowed errors.** An empty catch, a discarded `Result`/`err`, or a bare log-and-continue
  hides the outage. Handle it, or propagate it with context added.
- Error messages carry what a responder needs (operation, id, cause) and nothing a caller must not
  see (secrets, internal hostnames, stack traces to end users).
- **Anything crossing the network can fail or hang.** Set a timeout. Decide retry vs fail-fast, and
  make retries idempotent with backoff — retrying a non-idempotent write duplicates data.
- Clean up what you acquire: connections, file handles, locks, transactions — on the error path too.

## Behaviour under load

- **Keep the request path short.** Work that is slow, retriable, or not needed for the response
  belongs in a job/queue. Never block a request on an unbounded external call.
- **Bound every collection you return or accept.** Pagination and payload limits are correctness
  concerns, not optimisations.
- Concurrency: name what happens if two callers do this at once. Read-modify-write on shared state
  needs a transaction, a lock, or an atomic operation.
- Do not add caching to hide a slow query — fix the query first, then decide about caching, and say
  how the cache is invalidated.

## Fitting in

- **Use what exists.** Before adding a client, helper, error type or dependency, check whether the
  repo already has one — the map (`yindee map`) lists packages; check the target package's imports.
- Match the surrounding code's error handling, logging and module layout even if you'd write it
  differently. Consistency is worth more than local preference.
- Log at boundaries with correlation ids, not inside tight loops.
