# 061. The Claude adapter reports a run's API retries, so a connection drop is told from an unknown error and never recorded as status 0

Status: written 2026-11-14 from the delivery-system design for issue #117;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain's bounds count failures of the work, so the record of a
run must say what failed) and section 10 ("Small work skips layers": a bug
spec hangs directly off a top design);
[001-scheduler-core](../001-scheduler-core/spec.md) section 13 (each adapter
owns event parsing; the runner keeps the judgement and its reasons with the
run, AC-21 and AC-22);
[045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
AC-1, whose rule that the adapter reports `apiErrorStatus` `null`, not 0,
this spec keeps unchanged and pins on live-shaped streams; and
[015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md) section 2,
which leaves network failures inside an agent's own run to the adapter and
to issue #49, and whose classification this spec feeds without changing.
This spec marks no text of another spec.

## 1. Goal

A run's judgement and its `outcome.json` say what the Claude harness's API
retries were: how many, whether the API answered with a status, with an
error and no status, or with nothing at all, and what the last retry said.
A connection drop that the harness retried through can then be told from a
run that never retried and from an error the harness could not name, and a
retry whose `error_status` is `null` is never recorded as status 0.

### What is wrong today

The issue (filed 2026-11-01) names two defects in `judge` of
`tools/scheduler/src/adapters/claude.ts`. The first is fixed on `main`; the
second is not.

1. **Status 0 for a null status.** `judge` took the last `api_retry`
   record's `error_status` through `Number(...)` as the fallback for
   `apiErrorStatus`, and `Number(null)` is 0. Spec 045 AC-1 fixed this in
   PR #183 (commit `cf3cd4c`, merged after the issue was filed): the
   fallback is taken only when `error_status` is a number, and
   `test/adapters-claude.test.ts` pins it on `claude-unreachable.jsonl`.
   The run records written before that fix keep the fabricated value:
   `runs/39-spec-1-20261101T092316/outcome.json`,
   `runs/15-review-1-20261028T074610/outcome.json` and
   `runs/15-plan-1-20261031T141551/outcome.json` each carry
   `apiErrorStatus: 0`. The fixture that pins the fix is synthetic in the
   field set of the first live streams and has no `no_response` object.
2. **The retries are dropped.** `judge` reads the `api_retry` records for
   their `error_status` and nothing else. Their `error` text and their
   `no_response` object, and how many there were, are not in the
   `Judgement` and not in `outcome.json`. So a run that never retried and a
   run that spent eleven retries on a dead network both record
   `apiErrorStatus: null`, and the only trace of the outage is the final
   result's text, when the harness gives up with one:
   - `runs/15-review-1-20261028T074610/events.jsonl` lines 81 to 91: one
     `api_retry` with `error_status: null`, `error: "unknown"` and
     `no_response: { waited_ms: 181000, retry_wait_ms: 599000 }`, then ten
     with `error_status: null`, `error: "unknown"` and no `no_response`;
     the `result` has `subtype: "success"`, `is_error: true`,
     `api_error_status: null` and the text `API Error: Can't reach the API
     server — check your internet or DNS (EAI_AGAIN)`. The judgement is
     `failed` with that reason; `transientRun` (spec 045 AC-1) recognises it
     only through the text.
   - `runs/39-spec-1-20261101T092316/events.jsonl` line 75: one `api_retry`
     with `no_response` (`waited_ms: 181000`) and the same null status, then
     a successful result. The run ended `ok`; its record says nothing of the
     three minutes the API did not answer.
   - `runs/15-plan-1-20261031T141551/events.jsonl` lines 180 to 184: five
     `api_retry` records with `error_status: null` and no `no_response`,
     then a successful result.
   A run that ends without a result event, or with `exit 1`, after such
   retries is judged `failed` with `no result event` or `exit 1` and
   `apiErrorStatus: null`; nothing in the record says the network was down.

Across the 21 recorded runs under `runs/` that hold an `api_retry` record,
the records take three shapes: `error_status: null, error: "unknown"` with no
`no_response` (72 records), the same with a `no_response` object (5 records,
each `waited_ms` 181000 or 184000 and `retry_wait_ms` 599000), and a numeric
status with a named error (`error_status: 401, error:
"authentication_failed"`, 2 records; the fixture `claude-429.jsonl` has
`429, "rate_limit"`). The adapter reads these shapes as they are: a *status
retry* is one whose `error_status` is a number (the API answered); a
*connection retry* is one whose `error_status` is `null` (no HTTP response
reached the harness); a *no-response retry* is a connection retry carrying a
`no_response` object (the harness reports it waited `waited_ms` for a
response that never came). What the harness means beyond these fields is
not interpreted here.

### The fix

`judge` summarises the stream's `api_retry` records into one field of the
`Judgement`, `apiRetries`, and the runner writes it into `outcome.json`
beside `apiErrorStatus`. The summary carries the count of retries, how many
were no-response retries, and the last retry's status, error text and
`no_response` numbers. The `apiErrorStatus` rule of spec 045 AC-1 is
unchanged and pinned on two fixtures cut from the live runs above, one with
a `no_response` object. Nothing decides on the new field yet: the three
readers of `apiErrorStatus` (`quota/book.ts`, `runner/retry.ts`,
`standing/run.ts`) compare against 429 as today, and `transientRun` reads
the reason text as today. The classification of a network failure inside a
run is issue #49's.

*(agent's call)* A summary rather than the list of retry records: the three
live shapes are told apart by two counts and the last record, a stage of 150
turns can retry many times and `outcome.json` is read by people and by the
console, and the full records stay in `events.jsonl` beside it. The field is
optional on `Judgement` and present only when the stream holds a retry: the
pi and fake adapters, and the runner's own judgements for a process that did
not spawn or was killed on a bound, do not change, and the twenty-odd test
literals that build a `Judgement` compile as they are. Both choices are
cheap to reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- Deciding anything on the new field: classifying a run as transient from
  its retries, postponing or holding work, changing `transientRun`,
  `retryDecision`, `afterFallback` or the quota book. That is the network
  failure inside a run of spec 015 section 2 and issue #49, which gets the
  record it needs from this spec. (Issue #49 is open, labelled `abandoned`,
  and its `Spec:` line names a path another spec now holds; recorded as a
  finding of this spec PR, not touched here.)
- The `apiErrorStatus` fallback itself. It stays spec 045 AC-1's: the
  result's `api_error_status` when a number, else the last `api_retry`
  record's `error_status` when a number, else `null`. Taking the last
  numeric status among earlier retries (a 429 followed by a connection
  retry) would change that rule and is not asked for.
- Rewriting the three `outcome.json` files that carry `apiErrorStatus: 0`,
  or any record under `runs/`.
- The pi adapter. pi's JSON stream has no retry record the adapter knows;
  `piAdapter.judge` sets no `apiRetries`.
- The usage record (`UsageRecord`, schema `usage-record`), the event store of
  spec 026 and the metrics of spec 027: no field is added to any schema or
  event. `outcome.json` has no schema.
- The console (spec 051): it may show the field later; nothing here changes
  it.
- Re-recording the existing fixtures. The two new fixtures are cut from live
  runs and added beside them; `claude-unreachable.jsonl` and its test stay.

## 3. Acceptance criteria

"Given" states use recorded event streams under
`tools/scheduler/test/fixtures/streams/` read by `readJsonlFile`, as the
adapter tests of spec 001 section 17 do. An *`api_retry` record* is a stream
record with `type: "system"` and `subtype: "api_retry"`. *Status retry*,
*connection retry* and *no-response retry* are defined in section 1.

- AC-1. **A null status is reported as `null`, pinned on live-shaped
  streams.** Given a stream whose result has no numeric `api_error_status`
  and whose last `api_retry` record has `error_status: null`, when the
  adapter judges it, then `apiErrorStatus` is `null`, never 0, whatever the
  record's `error` text and whether or not it carries `no_response`; given
  the last `api_retry` record has a numeric `error_status` and the result
  none, then `apiErrorStatus` is that number; given the result has a numeric
  `api_error_status`, then `apiErrorStatus` is the result's. This is spec
  045 AC-1's rule, unchanged. Tests pin it on the two new fixtures of AC-4
  (both `null`), on `claude-429.jsonl` (429 from the result) and on the same
  stream with the result's `api_error_status` set to `null` (429 from the
  retries).
- AC-2. **The judgement summarises the retries.** `Judgement` gains the
  optional field `apiRetries?: ApiRetries`, where
  `ApiRetries = { count: number; noResponses: number; last: { status:
  number | null; error: string | null; noResponse: { waitedMs: number |
  null; retryWaitMs: number | null } | null } }`. Given a stream with at
  least one `api_retry` record, when the Claude adapter judges it, then the
  judgement, whatever its outcome (`ok`, `failed`, `bounds` or `timeout`),
  has `apiRetries` with `count` the number of `api_retry` records,
  `noResponses` the number of them whose `no_response` is an object, and
  `last` read from the last `api_retry` record in stream order: `status` its
  `error_status` when a number, else `null`; `error` its `error` when a
  string, else `null`; `noResponse` `null` when the record has no
  `no_response` object, else `{ waitedMs, retryWaitMs }` with each number
  taken from `waited_ms` and `retry_wait_ms` when numeric and `null`
  otherwise. Given a stream with no `api_retry` record, then the judgement
  has no `apiRetries` property. The pi and fake adapters, and the runner's
  judgements for a process that did not spawn or was killed on
  `max_turns`, set no `apiRetries`. The reader is the exported
  `claudeApiRetries(events): ApiRetries | undefined`, which `judge` calls
  once.
- AC-3. **The run record carries it.** Given a stage run that spawned, when
  `runStage` writes `outcome.json`, then the record has `apiRetries` equal
  to the judgement's `apiRetries`, or `null` when the judgement has none,
  beside `apiErrorStatus`; the `resume_fallback` rewrite of the same file
  keeps it. The `UsageRecord`, the quota book's `observeRun` input and every
  schema are unchanged. A runner test with a fake adapter whose `judge`
  returns `apiRetries` asserts the field in `outcome.json`; the existing
  runner tests, whose fake judgements have none, read `apiRetries: null`.
- AC-4. **Live cases.** Two fixtures are cut from the live runs of section 1,
  trimmed to the fields the adapter reads as the existing `claude-*.jsonl`
  fixtures are, and the fixtures README names their source runs:
  - `claude-no-response-then-ok.jsonl`, from `39-spec-1-20261101T092316`:
    the `init` record, the one `api_retry` record (`error_status: null`,
    `error: "unknown"`, `no_response: { waited_ms: 181000, retry_wait_ms:
    599000 }`) and the `result` (`subtype: "success"`, `is_error: false`,
    `api_error_status: null`). Judged with exit 0: outcome `ok`,
    `apiErrorStatus` `null`, `apiRetries` `{ count: 1, noResponses: 1,
    last: { status: null, error: "unknown", noResponse: { waitedMs: 181000,
    retryWaitMs: 599000 } } }`.
  - `claude-unreachable-after-stall.jsonl`, from
    `15-review-1-20261028T074610`: the `init` record, the eleven `api_retry`
    records in order (the first with `no_response`, the next ten without)
    and the `result` (`subtype: "success"`, `is_error: true`,
    `api_error_status: null`, text `API Error: Can't reach the API server —
    check your internet or DNS (EAI_AGAIN)`). Judged with exit 1: outcome
    `failed`, reason that text, `apiErrorStatus` `null`, `apiRetries` `{
    count: 11, noResponses: 1, last: { status: null, error: "unknown",
    noResponse: null } }`, and `transientRun` of the judgement is
    `EAI_AGAIN` as today.
  - `claude-429.jsonl` (existing): `apiRetries` `{ count: 2, noResponses:
    0, last: { status: 429, error: "rate_limit", noResponse: null } }` and
    `apiErrorStatus` 429. `claude-success.jsonl` and
    `claude-partial-tail.jsonl` (existing): no `apiRetries` property.
  The existing adapter, runner, retry, quota and standing tests pass
  unchanged.

## 4. Amendments to earlier specs

None. Spec 045 AC-1's `apiErrorStatus` rule is kept as it is and pinned by
AC-1; spec 015 section 2's exclusion of network failures inside a run stays
with issue #49; spec 001 section 13's description of the adapter interface
gains a field by this spec's text and is not marked, as spec 059 added
`hostRefusal` without a mark.

## 5. Interfaces and files

- `tools/scheduler/src/adapters/types.ts`: the exported `ApiRetries` type
  and `Judgement.apiRetries?: ApiRetries` (AC-2).
- `tools/scheduler/src/adapters/claude.ts`: `claudeApiRetries(events)`
  exported; `judge` sets `apiRetries` on every judgement it returns when the
  reader returns a value (AC-2). The `apiErrorStatus` computation is
  unchanged (AC-1).
- `tools/scheduler/src/runner/run.ts`: `persisted.apiRetries =
  judgement.apiRetries ?? null` (AC-3).
- `tools/scheduler/test/fixtures/streams/claude-no-response-then-ok.jsonl`
  and `claude-unreachable-after-stall.jsonl` (new, AC-4);
  `tools/scheduler/test/fixtures/streams/README.md` gains one line naming
  the two files, their source runs and dates (2026-11-01 and 2026-10-28).
- Tests: `tools/scheduler/test/adapters-claude.test.ts` (AC-1, AC-2, AC-4),
  `tools/scheduler/test/adapters-pi.test.ts` (no `apiRetries` on a pi
  judgement, AC-2), the runner test file that asserts `outcome.json`
  (AC-3).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/` and `docs/delivery-system-design.md` are sensitive paths;
the security review applies to the implementation PR (spec 006 AC-9).
Nothing here changes the sensitive-path list, the security criteria, or what
routes a sensitive diff to the security review. No schema changes:
`outcome.json` has no schema and `UsageRecord` is untouched. No new network
listener, outbound call or shell execution: the adapter reads the event
stream it already reads.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- A grep of `tools/scheduler/src` shows `apiRetries` written in
  `adapters/claude.ts` and read in `runner/run.ts` only: no decision is made
  on it (section 2).
- The two new fixtures each judge as AC-4 says; the AC-2 test on
  `claude-no-response-then-ok.jsonl` fails on `main` before the change
  (the judgement has no `apiRetries`) and passes after it.
- Live check after deploy: the next run whose `events.jsonl` holds an
  `api_retry` record has an `outcome.json` whose `apiRetries.count` equals
  the number of those records and whose `apiErrorStatus` is `null` or a
  real HTTP status, never 0.

## 7. Open decisions

None.
