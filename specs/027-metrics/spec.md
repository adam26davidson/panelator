# 027. Metrics as queries

Status: written 2026-10-31 by the split of spec 012 (ADR 0004): AC-1 to AC-6 here
are 012's AC-5 to AC-10; specs derived from the design need no maintainer approval
(delivery-system design section 11). Needs spec 026 on `main`.
Class: tooling. Domain: backend.
Parent: docs/designs/metrics-reflection.md
Derives from: [metrics and reflection design](../../docs/designs/metrics-reflection.md);
[delivery-system design](../../docs/delivery-system-design.md) sections 6.2 and 7;
[charter](../../docs/charter.md) (metrics); [design-tree](../../docs/design-tree.md)
R6.Q12, R7.Q2;
[ADR 0002](../../docs/decisions/0002-event-store-jsonl-with-sqlite-query-index.md)
(a metric is a SQL query); [ADR 0004](../../docs/decisions/0004-split-metrics-reflection-spec.md)
(the split); builds on [026-event-store](../026-event-store/spec.md).

What the maintainer decided, kept as it is here: metrics are derived as queries;
a metric change is a reviewed design change, and a replaced metric keeps running
beside the new one for a few weeks.

## 1. Goal

A metric is a definition file in the repository holding a SQL query over the
events, with the charter goal it tracks and the reasoning for it. The scheduler
computes every active metric, and every replaced metric still inside its overlap
window, on demand. The design's seed set ships as the first definitions, and
`panelator-scheduler metrics` is the maintainer's view until the console.

## 2. Out of scope

- The console (spec E). Its History screen shows the metrics this spec computes,
  old and new side by side. Until E lands, `panelator-scheduler metrics` on the
  laptop is the maintainer's view (AC-6). The metrics report (AC-5) is the data
  contract E consumes; no screen is designed here.
- AWS cost records (spec F1). The spend metric uses token cost only until F1
  records them.
- Changing any metric's definition after it ships, adding a metric beyond the seed
  set, or retiring one: each is a reviewed PR that a reflection files as an issue
  (spec 028 AC-9); this spec builds the mechanism, not the second metric.
- The event store and what it records (spec 026). A metric that needs a field the
  events lack is a change to 026's recording, not worked around here.
- Reflection agents (spec 028). The `metrics.snapshot` of a reflection run is
  recorded by 028 through the function of AC-5.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.

- AC-1. **A metric is a definition file.** `agents/metrics/<name>.yaml` has:
  `name` (equal to the file name), `goal` (one of `speed`, `delivery`,
  `quality`, `spend`, `autonomy`, the charter's five), `description` (one
  line), `unit`, `direction` (`lower` or `higher` is better), `introduced`
  (a date), `rationale` (the design write-up: what decision the metric
  drives and why it tracks the goal, at least 200 characters), `query` (SQL
  over the `events` table of spec 026 AC-3, returning rows `(bucket, value, n)` for
  weekly buckets when run with the parameters `:from` and `:to`), and
  optionally `replaces` (the name of the metric it supersedes) and
  `retired` (a date after which it is no longer computed). Given a file with
  an unknown key, a missing required key, a `goal` not in the list, a query
  that fails to prepare against an empty index, or a query that does not
  return the three columns, then loading fails naming the file and the key,
  the service exits 78 as for a bad config, and the same check fails the
  vitest registry test over the repository's `agents/metrics/`. The query
  may read the table of spec 026 AC-3 only: a query naming another table, or any
  statement other than one `SELECT` (or `WITH ... SELECT`), is rejected by
  the loader, and the index is opened read-only for metrics.
- AC-2. **The seed set ships.** The repository carries these five
  definitions, each with its rationale, computed per ISO week:
  - `issue_to_merge_days` (speed, lower): median days from the issue's
    `validated` labelling (`validated_at` of its first `issue.eligible` payload,
    or that payload's `created_at` when `validated_at` is `null`) to its
    `merge` event, for issues
    merged in the bucket;
  - `merged_per_week` (delivery, higher): count of `merge` events in the
    bucket, with `n` the count and `value` the count, and companion rows
    split by `work` (`system` and `product`) as separate metric definitions
    `merged_per_week_system` and `merged_per_week_product`, counted as one
    seed metric in this list;
  - `rework_per_merge` (quality, lower): mean fix cycles plus rescues per
    merged issue in the bucket (`chain.transition` events into `fix` and
    with `rescue: true`), and `post_merge_defects` (quality, lower): count
    of `issue.filed` events with class `class:bug` in the bucket whose body
    cites a PR merged in the previous 30 days (the filer's body carries the
    finding's `where`), where "cites" means the body holds `#<pr>` not followed
    by another digit, so the fixture's `#12` does not match a merge of PR 123; both are seed metrics under "rework and post-merge
    defects";
  - `cost_per_merged_issue_usd` (spend, lower): the sum of `run.ended`
    `cost_usd` over every run with the issue's number, divided by the merges
    in the bucket, for issues merged in the bucket;
  - `questions_per_week` (autonomy, lower): count of `question` events with
    event `sent` in the bucket, with a companion `questions_decide_yourself`
    counting `checked` events whose verdict is `decide_yourself`, since the
    design uses that to tune the threshold.

  Given the fixture event set in `tools/scheduler/test/fixtures/events/`
  (hand-written events covering every kind of spec 026 AC-2 across six weeks), then
  each seed metric returns the values listed in the fixture's
  `expected.json`, asserted by a test.
- AC-3. **A replaced metric runs beside its replacement.** Given a
  definition with `replaces: <old>`, then the metric `<old>` must still exist
  and be computed until 28 days after the new definition's `introduced` date:
  the registry test fails when `<old>` is missing and today is inside that
  window, and the metrics report (AC-5) carries both, marking the old one
  `replaced_by: <new>` and the days left. Given the window has passed, then
  the old file may be removed or given `retired` in a reviewed PR, and until
  it is, it keeps being computed. A metric with `retired` in the past is
  loaded (so history can still be queried with `metrics show <name>`) and
  left out of the report by default.
- AC-4. **A metric change is a reviewed change with a write-up.** Adding,
  changing or removing a file under `agents/metrics/` is repository content
  under `agents/`, so it goes through a reviewed PR (design section 6.2,
  level 2) and the security review as every `agents/` change does (spec 006
  AC-9); nothing in this spec changes which paths are sensitive or what
  routes them. The `rationale` field is the design write-up the design asks
  for: given a changed or new definition whose `rationale` is unchanged from
  the metric it `replaces`, or shorter than 200 characters, then the registry
  test fails, so a PR cannot swap a query without saying why. A reflection
  proposes a metric change only as an issue (spec 028 AC-9); no action kind writes
  under `agents/`.
- AC-5. **The report.** `computeMetrics(index, definitions, { from, to })`
  returns `metrics-report`: `{ from, to, computed_at, metrics: [{ name,
  goal, unit, direction, introduced, status: active | replaced | retired,
  replaced_by?, overlap_days_left?, buckets: [{ bucket, value, n }] }] }`,
  for every definition not retired (and retired ones on request), over
  weekly buckets from `from` to `to`. Given a bucket with no events, then it
  appears with `value: null` and `n: 0`, so a gap is visible rather than
  skipped. The report is what the reflection inputs carry (spec 028 AC-5, when spec 028 lands)
  and what the `metrics` command prints, and each computation for a reflection
  run or with `--snapshot` is recorded as a `metrics.snapshot` event through one
  function here, which spec 028's input builder also calls; this spec sets that
  kind's payload in `schemas/scheduler/event.json` to `metrics-report.json`, so the History
  screen (spec E) and meta-reflection can see what a reflection saw at the
  time. Given the index is deleted while the service runs, then the next
  computation rebuilds it (spec 026 AC-3) and every metric gives the same values as
  before, asserted by a test.
- AC-6. **The maintainer's view until the console.** `panelator-scheduler
  metrics [--weeks <n>] [--json] [--snapshot] [--all]` prints the report for
  the last `n` weeks (default 12) as a table, one row per metric and bucket,
  or as JSON; `--all` includes retired metrics; `metrics show <name>` prints
  one metric's definition and its full history, computed from the ISO week
  of the earliest event in the index (backfilled events included, so the
  weeks before `introduced` appear) to now, retired or not. `panelator-scheduler events
  query "<sql>"` runs one read-only `SELECT` against the index and prints the
  rows, for the maintainer and for a dev-log. The commands run on the laptop
  as the service user and read the state directory; they open the index with
  `readOnly` (spec 026 AC-3), so they contend with the service only for the load, under
  its busy timeout; they never write the JSONL, except that `--snapshot`
  records its event through `recordEvent`.

## 4. Design notes (agent's calls)

- **The metric is SQL** (ADR 0002): a declarative query a reviewer can read against
  the charter.
- **Metrics live under `agents/`** because that directory is already the system's
  configuration of itself, already sensitive (spec 006 AC-9), and already loaded
  with a registry test at start and in CI; a metric change therefore gets the review
  the design requires without adding a path or a rule.
- **The overlap is enforced by a test, not by the scheduler.** "A few weeks" becomes
  28 days, and the registry test is what stops a PR removing the old metric early;
  the report marking the old metric `replaced_by` is what makes the side-by-side
  visible (and what the History screen will show).
- **A citation is `#<pr>`.** Findings that name only a file and line do not count
  toward `post_merge_defects`, so the metric undercounts rather than guesses;
  whether that is good enough is meta-reflection's question.

## 5. Interfaces and files

The paths in backticks are what the scope gate reads: a sensitive file in the diff
passes only if it is listed here in full (exactly, or under a listed entry ending
in `/`).

**Plan scope.** The plan for this spec lists as prefix entries (the scope gate
accepts an entry ending in `/`): `tools/scheduler/src/metrics/`,
`tools/scheduler/src/events/`, `tools/scheduler/test/`, `agents/metrics/` and
`schemas/scheduler/`. It also lists `tools/scheduler/bin/scheduler.ts`,
`tools/scheduler/src/schema/validate.ts` and `tools/README.md` by name.

- `tools/scheduler/src/metrics/`: `tools/scheduler/src/metrics/definitions.ts`
  (loads `agents/metrics/*.yaml`, the checks of AC-1, AC-3 and AC-4, the read-only
  `SELECT` rule), `tools/scheduler/src/metrics/compute.ts` (`computeMetrics`, weekly
  buckets, the report, the snapshot function, AC-5),
  `tools/scheduler/src/metrics/format.ts` (the table for AC-6). Further helpers there
  are the implementer's call.
- `tools/scheduler/bin/scheduler.ts`: the `metrics`, `metrics show` and `events query`
  commands (AC-6); loading the definitions at service start (AC-1).
- `tools/scheduler/src/schema/validate.ts`: the new schema names.
- `agents/metrics/`: `agents/metrics/issue_to_merge_days.yaml`,
  `agents/metrics/merged_per_week.yaml`, `agents/metrics/merged_per_week_system.yaml`,
  `agents/metrics/merged_per_week_product.yaml`, `agents/metrics/rework_per_merge.yaml`,
  `agents/metrics/post_merge_defects.yaml`,
  `agents/metrics/cost_per_merged_issue_usd.yaml`,
  `agents/metrics/questions_per_week.yaml`,
  `agents/metrics/questions_decide_yourself.yaml` (AC-2).
- `schemas/scheduler/`: `schemas/scheduler/metric-definition.json`,
  `schemas/scheduler/metrics-report.json`; `schemas/scheduler/event.json`: the payload
  of `metrics.snapshot` (AC-5).
- `tools/scheduler/test/`: `tools/scheduler/test/metrics.test.ts` (definition checks,
  the read-only rule, seed values against the fixture, the overlap window, the
  rationale rule, the report's null buckets, rebuild equality, the commands), and the
  registry test over `agents/metrics/`.
- `tools/scheduler/test/fixtures/events/`: the monthly JSONL fixture files and
  `tools/scheduler/test/fixtures/events/expected.json` (AC-2).
- `tools/README.md`: the commands and the `agents/metrics/` layout.

No file outside `tools/scheduler/`, `agents/metrics/`, `schemas/scheduler/`,
`tools/README.md` and `dev-logs/` is changed by the implementation. `tools/scheduler/`
and `agents/` are sensitive paths, so the security review runs on the PR as spec 006
AC-9 says. Nothing here changes the sensitive-path list, the security criteria, or
what routes a sensitive diff to the security review.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean, including:
  - the registry test over `agents/metrics/` (AC-1, AC-3, AC-4) and the seed values
    against `tools/scheduler/test/fixtures/events/expected.json` (AC-2), with a body
    citing `#12` not matching a merge of PR 123;
  - index deletion and rebuild giving identical metric values, null buckets, and one
    `metrics.snapshot` event from `--snapshot` (AC-5);
  - `metrics show <name>` over a backfilled state directory printing the weeks before
    `introduced` (AC-6);
  - the recorded chains of specs 006, 007, 008 and 026 unchanged.
- After the service is restarted on the merged code: the first
  `panelator-scheduler metrics` output over the real history is written up in
  `dev-logs/`.

## 7. Open decisions

None.
