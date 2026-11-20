# 096. The stale-claim drop records `issue.released` when the store holds an open claim

Status: written 2026-11-20 from the delivery-system design for issue #204;
specs derived from that design need no maintainer approval (design section 11).
Marks [026-event-store](../026-event-store/spec.md) AC-2 (amended by AC-1
here: the service loop's stale-claim drop is a release, recorded as
`issue.released` with reason `stopped` when the store holds an open
`issue.claimed` for the issue).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a bug spec hangs directly off a top
design); [026-event-store](../026-event-store/spec.md) AC-2 (`issue.claimed`
and `issue.released: { reason }` together give queue and shortlist wait time;
the recording points, amended here), AC-3 (the index, which the lookup of AC-1
reads) and section 5 (`issue.released` is a recording call of
`tools/scheduler/src/service/loop.ts`);
[001-scheduler-core](../001-scheduler-core/spec.md) section 11 (GitHub holds
the visible state; when it and the state directory disagree, GitHub wins and
the claim is treated as stale); [ADR 0002](../../docs/decisions/0002-event-store-jsonl-with-sqlite-query-index.md)
(the index is the store's query path).

## 1. Goal

Every `issue.claimed` the scheduler records is closed by an `issue.released`,
including when the claim ends because someone removed the `in-progress` label
on GitHub by hand: the service loop's stale-claim drop records
`issue.released` with reason `stopped`. A claim whose labelling failed, which
never recorded `issue.claimed`, is dropped as today and records nothing, so
the store never holds a release with no claim before it either.

### What is wrong today

In `Scheduler.#liveness` (`tools/scheduler/src/service/loop.ts`), a claim
whose issue no longer carries `in-progress` is logged as `stale-claim`, its
uncommitted patch saved, and its claim file removed; no event is recorded.
Every other release path records one: the driver's `paused`, `blocked`,
`error` or `stopped`, `done` or `abandoned` and `postponed` releases
(`tools/scheduler/src/chain/driver.ts`), and the loop's own liveness expiry,
which goes through the machine's `liveness_expired` transition and records
`issue.released` with reason `stopped`. So a label removed by hand after a
successful claim leaves an `issue.claimed` with no matching release, and the
issue's next `issue.eligible` and `issue.claimed` begin while the earlier
claim still looks open, which skews the claimed-to-released intervals spec
026 AC-2 says these events provide.

The claim path writes the claim file before it adds the label and records
`issue.claimed` only after the label is added (the comment above `writeClaim`
in the shortlist's claim loop says why: a failure in between must leave a
claim file without a label, which this same stale-claim check drops, never a
label without a claim file). A stale claim can therefore also be one whose
labelling failed and which never recorded `issue.claimed`. Recording a
release unconditionally would give that issue a release with no claim.

### The fix

*(agent's call)* The drop records `issue.released` with reason `stopped`,
after the claim file is removed (the driver's order), and only when the store
holds an open `issue.claimed` for the issue, read from the index (AC-1). The
reason is `stopped` because the label is applied and removed only by the
scheduler (spec 001 section 11), so a label that is gone means a person
stopped the chain from outside, which is what the liveness expiry already
calls `stopped`; a new reason would change `schemas/scheduler/event.json`
and spec 026's list for one rare path with nothing to distinguish it that the
service log's `stale-claim` record does not already say. The lookup, rather
than an unconditional record, is chosen because it makes the rule hold on
every path that can leave a claim file without an `issue.claimed` (the
shortlist's claim loop and the paused resume both write the claim before the
label), not only the one the issue names, and because the event store
already has the pattern: `recordChecks` in `tools/scheduler/src/events/ci.ts`
opens the index to decide whether to record. A stale drop is rare, so an
index open per drop costs nothing that matters. Queue wait (`validated_at` or
`created_at` to `issue.claimed`) is unaffected either way.

## 2. Out of scope

- A new `issue.released` reason (such as `stale`): not added; the schema's
  enum and spec 026's list are unchanged by this spec.
- The order of the claim file, the label and the `issue.claimed` record on
  the claim paths (the shortlist's claim loop, the paused resume, the blocked
  resume): unchanged.
- The other `removeClaim` calls in `tools/scheduler/src/service/loop.ts`
  (the paused record's cleanup and the blocked record's drop), which clean up
  after a release the driver already recorded as `paused` or `blocked`: not
  touched.
- The liveness expiry (`#expire`), its `chain.transition` and its
  `issue.released`: unchanged.
- The `stale-claim` service log record, the saved patch and the `released`
  entry of `TickInfo`: unchanged.
- Spec 027's metrics and any reader of these events: not changed; the fix
  only makes the pairs they read complete.

## 3. Acceptance criteria

"Given" states use the loop test harness of `tools/scheduler/test/loop.test.ts`
(`setup(...)`, with its state directory and event store) as the existing
stale-claim test does. "The store holds an open `issue.claimed` for an issue"
means: among the events of that issue whose kind is `issue.claimed` or
`issue.released`, ordered by `at` and then by insertion order (the index's
`rowid`), the latest is `issue.claimed`. An issue with no event of either kind
holds no open claim.

- AC-1. **A stale claim's drop records its release when its claim was
  recorded.** Given a claim file for an issue whose GitHub labels no longer
  include `in-progress`, and the store holds an open `issue.claimed` for that
  issue, when a tick's liveness step drops the claim as stale, then after the
  `stale-claim` log record, the saved patch and the claim file's removal, one
  `issue.released` event is recorded for the issue with payload `{ reason:
  "stopped" }` and `at` the tick's `deps.now()`, through `record` of
  `tools/scheduler/src/events/store.ts`, and nothing else is recorded for the
  issue by the drop (in particular no `chain.transition`: the drop bypasses
  the machine, as today). The openness is read from the index
  (`openIndex(paths)` of `tools/scheduler/src/events/index.ts`, opened and
  closed within the check, as `recordChecks` does) by `claimOpen(paths,
  issue)` in `tools/scheduler/src/events/claimed.ts` (section 4). Given the
  lookup itself fails (the index cannot be opened or queried), then the claim
  is still dropped, the error is pushed onto the tick's `errors` as
  `stale-claim <issue>: <message>`, and the release is recorded as if the
  claim were open, since a recorded claim is the common case.
- AC-2. **A stale claim whose claim was never recorded records nothing.**
  Given a claim file for an issue whose GitHub labels no longer include
  `in-progress`, and the store holds no open `issue.claimed` for the issue
  (either no `issue.claimed` at all, as after a labelling failure in the
  shortlist's claim loop, or an `issue.claimed` already followed by an
  `issue.released` from an earlier chain), when the tick drops the claim as
  stale, then the drop is as today (`stale-claim` log record, saved patch,
  claim file removed, the issue in the tick's `released`) and no event is
  recorded for the issue.
- AC-3. **The tests pin both.** Given `tools/scheduler/test/loop.test.ts`,
  then the existing test `releases a stale claim whose issue lost in-progress
  on GitHub (review focus 2)` records `issue.claimed` with payload `{ slot: 1
  }` for issue 7 (through `record` of `tools/scheduler/src/events/store.ts`)
  after writing the claim file and before the tick, keeps its assertions on
  `t.released` and `listClaims`, and asserts, reading the index as the
  liveness-expiry test beside it does (`SELECT kind, issue, payload FROM
  events WHERE issue = 7 AND kind IN ('chain.transition', 'issue.claimed',
  'issue.released') ORDER BY at, rowid`), that the rows are exactly
  `["issue.claimed", 7, { slot: 1 }]` followed by `["issue.released", 7, {
  reason: "stopped" }]` (AC-1). Two new tests, each naming `spec 096 AC-2`,
  write the same claim file with the labels gone: one with nothing recorded
  for issue 7, one with an `issue.claimed` `{ slot: 1 }` followed by an
  `issue.released` `{ reason: "done" }` recorded for issue 7 before the claim
  file is written; each asserts `t.released` equal to `[7]`, `listClaims`
  empty, and that the same query returns no rows (first test) or exactly the
  two rows it recorded (second test). All three tests declare no tick error.
- AC-4. **Nothing else changes.** Given the implementation PR's diff, then it
  changes only the files of section 4; `schemas/scheduler/event.json` and
  `tools/scheduler/src/events/kinds.ts` are as on `main`; the recorded chains
  of spec 026 AC-2's every-kind test and every other test keep passing
  unchanged; and `pnpm test` and `pnpm -F @panelator/scheduler typecheck`
  pass.

## 4. Interfaces and files

No schema, config key, stage prompt, state file format, event kind or reason
and no log kind changes. The implementation PR edits:

- `tools/scheduler/src/events/claimed.ts` (new): `claimOpen(paths: StatePaths,
  issue: number): boolean`, which opens the index with `openIndex(paths)`,
  runs `SELECT kind FROM events WHERE issue = ? AND kind IN ('issue.claimed',
  'issue.released') ORDER BY at DESC, rowid DESC LIMIT 1`, closes the index
  in a `finally`, and returns whether the row exists and its `kind` is
  `issue.claimed` (AC-1, AC-2). It reads only; it records nothing.
- `tools/scheduler/src/service/loop.ts`: in `#liveness`, after `removeClaim`,
  the guarded `record(d.paths, "issue.released", d.now(), { reason: "stopped"
  }, { issue: claim.issue })` of AC-1, with the lookup's failure handled as
  AC-1 says; the comment above the shortlist's `writeClaim` gains the clause
  that such a drop records no release because no `issue.claimed` was
  recorded.
- `tools/scheduler/test/loop.test.ts`: the amended test and the two new tests
  of AC-3.

The spec PR itself adds
`specs/096-stale-claim-drop-records-issue-released/spec.md`, marks spec 026
AC-2 as amended by it, and lists this spec under `## Children` in
`docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`), so the
security review applies to the implementation PR (spec 006 AC-9). The change
adds one read of the scheduler's own index and one recording call on an
existing release path; it touches no gate, bound, label rule, permission or
token handling, and plans no change to the charter, to a protected maintainer
decision, to the sensitive-path list, to the security review criteria or
instructions, or to what decides that a sensitive diff gets the security
review, that both reviews must approve, or that a sensitive path must be
listed in the spec.

## 5. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean (AC-4).
- The amended stale-claim test and the two new tests of AC-3 pass; the
  liveness-expiry test beside them (`releases a claim with no run and no
  activity for the liveness window, saving a patch (AC-15)`) still asserts
  exactly its `chain.transition` and `issue.released` rows.
- Checked by hand once while implementing, not committed: with the `record`
  call left out, the amended test fails on its missing `issue.released` row;
  with the `claimOpen` guard left out (an unconditional record), both AC-2
  tests fail on an extra `issue.released` row.
- `git diff main -- schemas/scheduler/event.json tools/scheduler/src/events/kinds.ts`
  is empty (AC-4).

## 6. Open decisions

None.
