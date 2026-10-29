# 0002. Event store: append-only JSONL in the state directory, queried through a rebuildable SQLite index

Status: accepted
Date: 2026-10-28
Settles: [delivery-system design](../delivery-system-design.md) section 13, "the
event store's technology and schema"; section 7 leaves "the store itself" to the
builder
Decided by: the spec stage, as a large technical decision with one clearly right
answer (design section 3, kind 2); carried by
[specs/012-metrics-reflection](../../specs/012-metrics-reflection/spec.md)

## Context

Design section 7 fixes what the store must do, not what it is: every run,
stage, merge, CI result, review, finding, direct action, question and answer,
wait time, pause and slot occupancy is a raw event that is never discarded, and
a metric is a query over those events, so a new metric can be computed back
over the whole history. The data lives in the delivery system's own store, not
the product's Postgres. The maintainer chose that metrics are discovered and
changed by the reflection agents, that a metric change is a reviewed change,
and that a replaced metric keeps running beside its replacement for a few
weeks.

Constraints the scheduler already has:

- It is one Node process on the laptop with a state directory of JSON and
  JSONL files (spec 001 section 11; spec 008's action log, parameter history,
  triage lines, question log). Appending a line is its durability primitive,
  and a crash between an effect and its record is already reasoned about in
  those terms.
- Nothing may need a daemon, a service account or a new credential (design
  section 8: credentials are requests to the maintainer).
- Metric definitions must be readable and writable by agents in a reviewed
  PR, and a reviewer must be able to judge a metric against the charter's
  goals, so the definition language must be short and declarative.
- Node 26, which the scheduler requires, ships `node:sqlite` (SQLite with the
  JSON functions built in) with no dependency to install.

Options considered:

1. **JSONL only, metrics as TypeScript functions.** No new concept; but every
   metric is code, so "a metric is a query" becomes "a metric is a function
   with a test", a reviewer judges TypeScript, and re-computing a new metric
   over the history means writing a scan each time.
2. **SQLite as the store.** One file, SQL metrics, fast queries; but the raw
   record then lives in a binary file whose schema a migration can get wrong,
   and the state directory would have two durability models.
3. **Postgres, DuckDB or another engine.** Postgres needs a server the laptop
   does not run for the scheduler and the design keeps the product's Postgres
   separate; DuckDB is a native dependency to build and a second engine beside
   the one Node already has. Neither buys anything at this volume (hundreds of
   events a day).
4. **JSONL as the record, SQLite as a derived index** (chosen). Raw events are
   appended to monthly JSONL files and never rewritten; a SQLite database is
   loaded from them, can be deleted and rebuilt at any time, and is what
   metric SQL runs against.

## Decision

- The raw event store is `events/<YYYY-MM>.jsonl` under the scheduler's state
  directory, one JSON event per line, appended by one function in the
  scheduler, never rewritten, never pruned. Each event is an envelope
  `{ id, at, kind, issue?, run_id?, agent?, payload }`; `payload` is the raw
  record as the scheduler had it (a usage record, a merge record, an action
  log entry), not a summary of it.
- `events/index.sqlite` is a derived index built from those files with
  `node:sqlite`: one `events` table with the envelope's columns and the payload
  as JSON text, plus indexes on `(kind, at)` and `(issue)`. It is loaded
  incrementally on each use (the index remembers how far into each monthly
  file it has read) and is rebuilt from scratch when missing, corrupt, or older
  than the schema version in code. Deleting it loses nothing.
- A metric is a SQL query over that table, stored as a definition file in the
  repository (`agents/metrics/<name>.yaml`), so a metric change is a reviewed
  PR and the whole history can be queried with the new definition.
- Existing records (usage records, `merges.jsonl`, the action log, the
  question log, the findings queue and triage lines) stay as they are. The
  event store copies them at the moment they are written; a one-time backfill
  imports what exists before this decision lands. Spec 001's 180-day pruning
  of usage files no longer loses anything, because the event store keeps the
  copy.

## Consequences

- The scheduler gains a dependency on the `node:sqlite` module of Node 26,
  which the engines field already requires. No package is added.
- Payload shapes are whatever the scheduler wrote at the time. A metric that
  reads a payload field must cope with the field's absence in older events
  (SQLite's `json_extract` returns NULL), and the metric registry test runs
  each query against a fixture of every event kind so a definition that
  assumes a field fails before merge.
- Reading the whole history is a scan of the JSONL once per rebuild, then an
  indexed SQL query; at the expected volume this is seconds, not minutes. If
  volume grows past that, the index and its loader can change without touching
  the record or the metric definitions.
- The index is not a source of truth: a metric value is reproducible from the
  JSONL and the definition file alone, which is what makes "compute a new
  metric back over the whole history" and "run the old metric beside the new
  one" trivially true.
