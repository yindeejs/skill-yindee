# Database rules

Loaded when a change touches migrations, schema, models/entities, repositories or SQL.
Migrations are `critical` tier: they run once, in production, against real data.

## Migrations

- **Assume the table is large and live.** Ask: does this lock writes? How long? On the biggest
  table this touches? If the answer is "I don't know", say so rather than assuming it's fine.
- **Adding a `NOT NULL` column needs a plan**: add nullable → backfill in batches → add the
  constraint. A `NOT NULL` without a default on a populated table fails or blocks; a `NOT NULL`
  *with* a default rewrites the table on older engines.
- **Every migration is reversible, or its irreversibility is stated in the diff.** Destructive
  steps (drop column/table, narrow a type, delete rows) need an explicit "this cannot be undone".
- **Expand → migrate → contract** for anything the running code reads. Ship the additive change,
  deploy code that uses it, then remove the old shape in a later migration — never in one step.
- **One migration = one logical change**, forward-only, never edited after merge. If it shipped,
  fix it with a new migration.
- Renames are drop+add to the database. Preserve data explicitly.

## Schema and queries

- The schema change, the model/type change, and the code that uses them ship in the **same diff**.
  A migration whose types are updated in a later PR breaks whoever deploys in between.
- **Index what you filter, join and sort on.** A new query path with no supporting index is a
  finding — say which index and why. Adding an index concurrently where the engine supports it.
- **No N+1.** A query inside a loop over rows is a defect; batch or join it.
- Constrain in the database, not only in application code: foreign keys, unique constraints,
  check constraints. Application-only invariants drift.
- **Bound every list query** — pagination or an explicit limit. `SELECT *` over an unbounded table
  will eventually be the outage.
- Wrap multi-statement invariants in a transaction; be explicit about isolation when it matters.

## Data handling

- Never write real user data into fixtures, seeds or tests.
- Deleting user data: check for retention/audit requirements before making it unrecoverable.
- Multi-tenant schemas: every query filters by tenant. A missing tenant predicate is a security
  finding, not a performance one — see `security.md`.
