# 026. Event store and recording

Status: written 2026-10-31 by the split of spec 012 (ADR 0004): AC-1 to AC-4
here are 012's AC-1 to AC-4, amended for #71 and #82; specs derived from the
design need no maintainer approval (delivery-system design section 11).
Class: tooling. Domain: backend.
Parent: docs/designs/metrics-reflection.md
Derives from: [metrics and reflection design](../../docs/designs/metrics-reflection.md);
[delivery-system design](../../docs/delivery-system-design.md) sections 3
("Recording"), 7 and 13; [charter](../../docs/charter.md) (metrics, "all the
data necessary" for finding bottlenecks); [design-tree](../../docs/design-tree.md)
R6.Q12, R7.Q2;
[ADR 0002](../../docs/decisions/0002-event-store-jsonl-with-sqlite-query-index.md)
(the store); [ADR 0004](../../docs/decisions/0004-split-metrics-reflection-spec.md)
(the split).

What the maintainer decided, kept as it is here: everything is recorded raw and
metrics are derived as queries.

## 1. Goal

Give the delivery system its memory. Every run, stage transition, merge, CI
result, review, finding, direct action, question and answer, wait in the queue
and shortlist, pause on the maintainer, slot occupancy sample, notification,
parameter change and standing-agent run is appended as a raw event to the
scheduler's own store and never discarded (ADR 0002). What exists from before
this spec is backfilled. Nothing reads the store yet except the index and the
`ci.check` lookup; specs 027 and 028 are its readers.

## 2. Out of scope

- Metrics, the `metrics` and `events query` commands (spec 027).
- Reflection agents, plans, `min_events` (spec 028).
- AWS cost records (spec F1). The event kind `aws.cost` is a reserved name with
  no producer here.
- Funds, credential and first-contact requests (F1 and F2). They are maintainer
  contacts and are recorded as `maintainer.contact` events with the function
  this spec provides; here the contacts recorded are questions, reminders and
  notifications.
- Changing the issue chain, its stages, bounds or transitions, the findings
  filer, the action audit or the parameter store, beyond the recording calls
  (AC-2). When the service computes the shortlist is not changed (AC-2).
- Rerouting existing records through the store. They stay, with one writer each.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.

- AC-1. **One writer, one envelope, never rewritten.** `recordEvent(paths,
  event)` in `tools/scheduler/src/events/store.ts`, with the backfill's
  `recordBackfillEvent` beside it (AC-4), is the only code that writes `events/<YYYY-MM>.jsonl` in the state directory (the month of `at`).
  An event is `{ id, at, kind, issue?, run_id?, agent?, payload }`: `id` a
  random string, `at` an ISO time, `kind` one of the names in AC-2, `issue`
  the issue number when the event belongs to one, `run_id` and `agent` when
  it belongs to a run or a standing agent, and `payload` the raw record as
  the scheduler had it, validated against `schemas/scheduler/event.json`
  (which fixes the envelope and names, per kind, the payload schema or
  `true`; `metrics.snapshot` and `reflection.plan` are `true` here, and specs
  027 and 028 tighten them as they add the producers). Given a `recordEvent` call, then one line is appended before the
  caller continues; given a kind not in AC-2 or a payload that fails its
  schema, then the call throws and nothing is written. The one exception is
  `recordBackfillEvent` (AC-4), which still validates the kind and the
  envelope and skips only the per-kind payload check; only `events/backfill.ts`
  calls it, asserted by a test. Nothing in the
  scheduler rewrites, truncates, moves or deletes a file under `events/`;
  the only files under `events/` are the monthly JSONL, `index.sqlite`
  (AC-3, the one file there that is rewritten, because it is derived, with
  SQLite's own transient journal beside it) and
  `backfilled.json` (AC-4, written once). Any other scheduler state that
  records lives elsewhere: the "already recorded as eligible" marks of AC-2
  are `shortlist/eligible.json` in the state directory, not under `events/`.
  A test greps the source for every open of a path under `events/` (every
  `StatePaths` member whose value is under the events directory, not only
  the directory itself) and asserts each is an append, a read, or the
  index's own rebuild. The usage pruning of spec 001 section 11 is unchanged
  and no longer loses data (the event has the copy).
- AC-2. **Every point the design names is recorded.** The scheduler records,
  at the moment it writes the existing record or makes the transition, with
  the payload shown:
  - `run.ended`: the usage record of spec 001 AC-24 (chain stages, rescues,
    question checks and standing agents alike), with `issue`, `run_id` and,
    for a standing agent, `agent`;
  - `chain.transition`: `{ from, to, event, attempt, fixes, track, rescue }`
    on every change of `ChainState.stage`, wherever the change is made: the
    driver's `step()`, and every path outside it that calls `transition()`
    on a claim (the service loop's liveness expiry, `event:
    liveness_expired`, `to: released`, is one; a test asserts it), so stage
    durations, attempts and fix cycles per issue are derivable;
  - `issue.eligible`: `{ rank, work, cls, validated_at, created_at }`
    (`validated_at` the time of the issue's `validated` labelling read from its
    label events, or `null` when none; `created_at` the issue's creation time)
    the first tick an issue is in the
    eligible shortlist and not claimed (recorded once per issue per period of
    eligibility, the marks kept in `shortlist/eligible.json`, AC-1; a later
    claim closes the wait), `issue.claimed`: `{ slot }`,
    and `issue.released`: `{ reason }` (`done`, `abandoned`, `postponed`,
    `paused`, `error`, `stopped`), which together give queue and shortlist
    wait time. "The first tick" means the first tick on which the service
    computes the shortlist, and the service computes it only when a new claim
    fits under the held count (`src/service/loop.ts`); this spec does not
    change that. So under saturation `issue.eligible` is recorded when a slot
    frees, not when the issue became eligible, and the eligible-to-claimed
    interval is short by construction. That is expected: queue wait is
    `validated_at` (or `created_at`) to `issue.claimed`, which saturation does
    not hide;
  - `merge`: the merge record of spec 001 (`issue`, `pr`, `cls`, `work`,
    `at`), and `pr.opened`: `{ pr, track }`;
  - `ci.check`: `{ sha, pr?, check, status, run_id }` whenever the scheduler
    reads a check run's final state for a PR head or for `main` (spec 008's
    `main` watcher), once per `(sha, check, status)` across the life of the
    store, not of the process: before recording, the scheduler queries the
    index (AC-3) for an existing `ci.check` with that `(sha, check, status)`
    and records only when none is found, so a service restart between two
    reads of the same completed check does not record it twice (a test
    restarts the loop between two reads and asserts one event);
  - `review.result`: `{ pr, head_sha, verdict, findings, criteria_failed,
    independent, reviewer_model, security }` for every review and security
    review result;
  - `finding.queued`: the queue envelope and the finding; `finding.triaged`:
    the triage entry of spec 008 AC-16;
  - `action`: the action log entry of spec 008 AC-9, on each status rewrite
    (so `pending`, `applied`, `refused`, `failed` and `undone` each appear);
  - `question`: the question log entry of spec 006 AC-18, for each of its
    events (`asked`, `checked`, `sent`, `reminded`, `answered`), with the
    question comment id when present;
  - `pause.started` and `pause.ended`: `{ stage, question_comment_id?,
    reason }` when a paused record is written and when the issue resumes,
    giving time paused on the maintainer;
  - `slots.sample`: `{ active, slots, chains, standing }` once per tick, and
    on each change within a tick, giving slot occupancy over time;
  - `maintainer.contact`: `{ channel, kind, issue?, question_comment_id?,
    label, text }` for every notification the notifier sends (`kind:
    notification`, `channel: log`, since `LogNotifier` is the only `Notifier` and spec 007's
    Telegram code sends questions and reminders, not notifications), every
    question sent (`kind: question`) and every reminder (`kind: reminder`),
    each of those two with the `channel` of its question log entry (`telegram`
    or `issue`). The schema also accepts the `kind`s `funds`, `credential` and
    `first_contact`, which F1 and F2 produce;
  - `parameter.changed`: the history entry of spec 008 AC-11;
  - `agent.run`: `{ outcome, summary, events_received, actions, findings,
    attempt, error? }` when a standing agent's attempt ends, whatever the
    outcome: the first failed attempt (spec 008 AC-3's `failures: 1`) is
    recorded with `outcome: failed` and its `error` before the scheduler
    returns to wait for the retry, so a run that fails once and then
    succeeds leaves two events;
  - `issue.filed`: `{ number, by, class, labels, marker, body }` for every
    issue the scheduler creates (today the filer's finding issues and the capability issue of spec 014, the
    two `createIssue` calls in `src/filer/apply.ts`; spec 028 adds a reflection's
    plan and item issues. Spec 006's escalation path files no issue, so the
    driver records no `issue.filed`), `body` the issue body as created, so a query
    can read what the issue cites (spec 027 AC-2's `post_merge_defects`). Every
    issue creation in `tools/scheduler/src/` goes through
    `createIssueRecorded` in `src/events/filed.ts` (section 5), which
    creates the issue and records the event; a test greps `src/` for calls
    of the client's `createIssue` and asserts that `events/filed.ts` is the
    only caller, so a new creation path cannot skip the record, and a test drives a
    `permission` advisory failure through the filer and finds the `issue.filed`
    of the capability issue;
  - `reflection.plan`: the plan of spec 028 AC-6 with its plan issue number (the name is valid here;
    spec 028 is the producer);
  - `metrics.snapshot`: the report of spec 027 AC-5 as computed for a reflection run or
    the `metrics --snapshot` command (the name is valid here; specs 027 and 028
    are the producers).

  `aws.cost` is a valid name with no producer (section 2). Given the recorded
  chains of spec 006 AC-28, spec 007 and spec 008 section 6 run with
  recording on, then every kind above except `aws.cost`, the F1 and F2 contact
  kinds, `metrics.snapshot` and `reflection.plan` appears at least once across them, asserted by a test over the
  resulting `events/` files, the two not yet produced named in one constant in
  that test, which spec 028 empties; and the chains' own assertions still pass
  unchanged.
- AC-3. **The index is derived and rebuildable.** `events/index.sqlite` is a
  `node:sqlite` database with one table `events(id TEXT PRIMARY KEY, at TEXT,
  kind TEXT, issue INTEGER, run_id TEXT, agent TEXT, payload TEXT)` with
  indexes on `(kind, at)` and `(issue)`, and a `meta` table holding the
  schema version and, per monthly file, the byte offset read so far.
  `openIndex(paths, { log?, readOnly? })` loads every line not yet loaded, then
  returns the database (with `readOnly`, a read-only connection opened after
  the load on a short-lived writable one closes). A line counts as loaded only
  once its newline is there, so a partial last line waits for the next load.

  Every connection, writable or read-only, is opened with a busy timeout of
  30 seconds (the `timeout` option of `DatabaseSync`), because the service and
  the laptop commands of spec 027 open the same file at the same time and a
  load is a write. Each monthly file loads in its own `BEGIN IMMEDIATE`
  transaction that re-reads the stored offset inside it and inserts with `OR
  IGNORE`, so two loaders racing over the same lines load each once and a
  rebuild holds the lock for one file at a time. A timeout that still expires
  throws as any other I/O failure of that caller does; nothing retries or
  swallows it. A test holds a write transaction from a child process for
  about a second and asserts that `openIndex` from the test waits and returns,
  and a second test races two loaders over the same unread lines and asserts
  one row per event.
 Given the file is missing or fails to open, then it is deleted and rebuilt
  from the JSONL in full. Given it carries an older schema version, then its
  tables are dropped and recreated in one transaction and reloaded in full, so
  a connection another process holds is not left on a deleted file.
  Given a line that fails to parse, then it is skipped, counted, and reported
  in the service log once per file; the raw file is not touched. The report
  is not optional: `openIndex` takes a log function and, when the caller
  passes none, appends to the service log itself (the `serviceLog` path of
  `StatePaths`), so every opener in the service (the `ci.check` recorder,
  the reflection input, the metrics command) reports the skip, and the
  offset moving past the line never hides it; a test opens an index over a
  file with one bad line without a log argument and finds the report in the
  service log. Given the
  index is deleted while the service runs, then the next `openIndex` rebuilds
  it and a query over `events` gives the same rows as before, asserted by a
  test.
- AC-4. **History is backfilled once.** `panelator-scheduler events backfill`
  reads the records that exist before this spec, `usage/*.json`,
  `merges.jsonl`, `actions/log.jsonl`, `questions/log.jsonl`,
  `findings/queue.jsonl`, `findings/triage.jsonl` and `parameters/history.jsonl`,
  and records each as the matching kind of AC-2 with the record's own time as
  `at` and `payload.backfilled: true`; the service also runs it at the first
  start after this code lands (a marker `events/backfilled.json` holds the
  time and counts). Given it is run twice, then no event is recorded twice
  (the backfill id is derived from the source record, so the second run finds
  every id present). Given a record that fails its payload schema (an old
  shape), then it is recorded through `recordBackfillEvent` (AC-1) with the
  envelope's `payload` as it is and the count of such records is printed,
  rather than dropped. The test's source
  is the fixture state directory
  `tools/scheduler/test/fixtures/events/backfill-state/`, which carries one
  file of each pre-spec record kind named above, including a usage record
  of an old shape.

## 4. Design notes (agent's calls)

- **The record is JSONL, the index is SQLite** (ADR 0002). The raw line is what
  was written at the time, the index is disposable. `node:sqlite` is in Node 26,
  so nothing is installed.
- **Existing records stay; the event store copies them.** Spec 008's action log,
  the question log and the usage records each have one writer and consumers that
  read them; rerouting them through the event store would touch every consumer
  for no gain. Recording beside the existing write is one call, and the backfill
  means history starts before this spec.
- **A busy timeout, not a single loader (#82).** Letting only the service load
  and having the laptop commands read without loading would make `metrics` stale
  whenever the service is down, which is when the maintainer is likeliest to
  look. A load takes milliseconds and the rare wait is bounded, so every
  connection waits.
- **`issue.filed` carries `body`, and no `prs` array.** #71 reported an
  implementation adding `prs`. Once the payload carries the body as created, the
  metric's query can read the citation from the raw record (spec 027 AC-2), so a
  second, derived field would only be another place to be wrong.
- **The backfill has its own entry point.** A raw old-shape record must not be
  dropped, and a new caller must not be able to write an invalid payload. Two
  functions, with a test pinning the second one's only caller, state both rules.

## 5. Interfaces and files

The paths in backticks are what the scope gate reads: a sensitive file in the
diff passes only if it is listed here in full (exactly, or under a listed entry
ending in `/`), so this section spells out full paths.

**Plan scope.** The scope gate (spec 001, `tools/scheduler/src/gates/scope.ts`)
treats a plan file entry that ends in `/` as a directory prefix. The plan for
this spec lists as prefix entries, on the tasks that work under them:
`tools/scheduler/src/` (a state writer found during implementation that gains a
one-line recording call is then inside the scope), `tools/scheduler/test/`
(which covers the helpers and fixtures under it) and `schemas/scheduler/`.
It also lists `tools/scheduler/bin/scheduler.ts` and `tools/README.md` by name.
This spec adds nothing under `tools/scheduler/src/metrics/`,
`tools/scheduler/src/reflection/` or `agents/`.

- `tools/scheduler/src/events/`: `tools/scheduler/src/events/store.ts`
  (`recordEvent`, `recordBackfillEvent`, the envelope, the kind table and payload
  schema map, AC-1, AC-2), `tools/scheduler/src/events/index.ts` (`openIndex`,
  incremental load, rebuild, schema version, busy timeout, the default service
  log, AC-3), `tools/scheduler/src/events/backfill.ts` (AC-4),
  `tools/scheduler/src/events/kinds.ts` (the names of AC-2 as a `const` array
  shared with the schema), `tools/scheduler/src/events/ci.ts` (the `ci.check`
  recorder with its index lookup, AC-2), `tools/scheduler/src/events/filed.ts`
  (`createIssueRecorded(gh, paths, { title, body, labels, by, class, marker })`,
  the one wrapper every issue creation goes through, AC-2). Further helpers there
  are the implementer's call.
- Recording calls (AC-2):
  - `tools/scheduler/src/chain/driver.ts`: `chain.transition`, `pr.opened`,
    `review.result`, `ci.check` for PR heads;
  - `tools/scheduler/src/state/merges.ts`: `merge`, beside the record's own write;
  - `tools/scheduler/src/service/loop.ts`: `issue.eligible`, `issue.claimed`,
    `issue.released`, `slots.sample`, `pause.started`, `pause.ended`,
    `chain.transition` for the liveness expiry, the first-start backfill;
  - `tools/scheduler/src/state/runs.ts`: `run.ended`;
  - `tools/scheduler/src/state/findings.ts`: `finding.queued`;
  - `tools/scheduler/src/filer/apply.ts`: `finding.triaged`, and `issue.filed`
    through `createIssueRecorded` at both `createIssue` calls (finding issues at
    line 90, the capability issue at line 114 on the commit this was written from);
  - `tools/scheduler/src/actions/log.ts`: `action`;
  - `tools/scheduler/src/state/questions.ts`: `question`, and `maintainer.contact`
    for `sent` and `reminded`;
  - `tools/scheduler/src/notify/recorded.ts` (new): a wrapper taking any `Notifier`
    and recording `maintainer.contact` beside each send, with
    `tools/scheduler/src/notify/log.ts` changed as it needs. In
    `tools/scheduler/bin/scheduler.ts` it wraps `LogNotifier` inside `rateLimited`,
    so a notification the rate limit suppresses, which was not sent, is not a
    contact;
  - `tools/scheduler/src/parameters/store.ts`: `parameter.changed`;
  - `tools/scheduler/src/standing/run.ts`: `agent.run` per attempt;
  - `tools/scheduler/src/standing/events.ts`: `ci.check` for `main`;
  - `tools/scheduler/src/state/claims.ts`: the claim's transition helper, when the
    `chain.transition` record is placed there;
  - `tools/scheduler/src/service/log.ts`: the service log `openIndex` appends to.
- `tools/scheduler/src/state/paths.ts`: `events/`, `events/index.sqlite`,
  `events/backfilled.json`, `shortlist/eligible.json`.
- `tools/scheduler/src/schema/validate.ts`: the new schema name.
- `tools/scheduler/bin/scheduler.ts`: the `events backfill` command (AC-4) and the
  notifier wiring.
- `schemas/scheduler/event.json`: the envelope and per-kind payload references.
- `tools/scheduler/test/`: `tools/scheduler/test/events.test.ts` (envelope,
  append-only grep, the one-caller greps, every kind recorded across the recorded
  chains, index rebuild equality, busy timeout, racing loaders, backfill
  idempotence), the recorded runs in `tools/scheduler/test/e2e.test.ts`, the mocked
  routes and event store wiring in `tools/scheduler/test/helpers/e2e-routes.ts`
  and, when a run needs them, `tools/scheduler/test/helpers/mock-github.ts`, and
  every existing test file of a module that gains a recording call, as its
  assertions need.
- `tools/scheduler/test/fixtures/events/backfill-state/` (AC-4): a state directory
  with `usage/` holding a current-shape and an old-shape record, `merges.jsonl`,
  `actions/log.jsonl`, `questions/log.jsonl`, `findings/queue.jsonl`,
  `findings/triage.jsonl` and `parameters/history.jsonl`.
- `tools/README.md`: the `events backfill` command (documentation of the tool, in
  its own package).

No file outside `tools/scheduler/`, `schemas/scheduler/`, `tools/README.md` and
`dev-logs/` is changed by the implementation. `tools/scheduler/` is a sensitive
path, so the security review runs on the PR as spec 006 AC-9 says. Nothing here
changes the sensitive-path list, the security criteria, or what routes a
sensitive diff to the security review.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including:
  - the append-only assertion over the source, and the one-caller assertions for
    `createIssue` and `recordBackfillEvent` (AC-1, AC-2);
  - the every-kind assertion over the recorded chains, with `metrics.snapshot` and
    `reflection.plan` as the only additions to the exceptions (AC-2), and the spec
    006 AC-28, spec 007 and spec 008 chains' own assertions unchanged;
  - the capability issue of spec 014 recording its `issue.filed` (AC-2);
  - a liveness expiry recording its `chain.transition`; a restart between two
    reads of one completed check recording one `ci.check`; a standing agent that
    fails once and succeeds on retry leaving two `agent.run` events (AC-2);
  - index deletion and rebuild giving identical rows, the bad-line report without a
    log argument, a wait behind a held write transaction and two racing loaders
    (AC-3);
  - a backfill of the fixture state directory, run twice, with the second run
    recording nothing, and the old-shape usage record kept and counted (AC-4).
- After the service is restarted on the merged code: the backfill's counts, and a
  query of the index by kind over the real history, are written up in `dev-logs/`.

## 7. Open decisions

None.
