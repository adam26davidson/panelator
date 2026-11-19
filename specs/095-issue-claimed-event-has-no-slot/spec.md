# 095. The `issue.claimed` event carries no `slot`

Status: written 2026-11-19 from the delivery-system design for issue #199;
specs derived from that design need no maintainer approval (design section 11).
Marks [026-event-store](../026-event-store/spec.md) AC-2 (amended by AC-1
here).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 7 (queue and shortlist wait time are recorded as raw events) and
section 10 ("Small work skips layers": a bug spec hangs directly off a top
design); [ADR 0007](../../docs/decisions/0007-claim-record-has-no-slot-field.md)
(a claim has no slot field: nothing wants a slot identity, and a number that
looks like one misleads); [034-claim-drops-slot-field](../034-claim-drops-slot-field/spec.md)
(the claim record lost the field; this spec removes its copy from the event);
[026-event-store](../026-event-store/spec.md) AC-1 (events are never
rewritten) and AC-2 (the `issue.claimed` payload, amended here; `slots.sample`,
which already records occupancy); [027-metrics](../027-metrics/spec.md)
(the readers of the store, none of which reads the field).

## 1. Goal

The `issue.claimed` event says only what the scheduler knows at a claim: which
issue, and when. Nobody reading the store takes a number from it for a slot
the claim does not hold.

### What is wrong today

Spec 026 AC-2 defines the `issue.claimed` payload as `{ slot }`, and
`schemas/scheduler/event.json` requires an integer `slot` there. Spec 026 was
written from spec 012, before spec 034 and ADR 0007 removed `slot` from the
claim record because the value was not a slot number and nothing read it.
The implementation of spec 026 (issue #93), merged after spec 034, had no
claim field to copy, so it records the number of claims held at claim time
instead: `held` at the shortlist claim in `tools/scheduler/src/service/loop.ts`
(the start step), and `this.active + 1` at the two other claim writes (the
resume of a paused issue, `#resume`, and the unblocking of a blocked issue,
`#handleBlocked`). That is the pseudo-slot ADR 0007 rejected: two claims made
while one chain runs both record `slot: 2`, and the number names no slot.
Nothing reads it: no metric definition under `agents/metrics/` queries
`issue.claimed` at all, and nothing under `tools/scheduler/src/` reads the
payload of one.

### The fix

*(agent's call)* Drop the field. The payload of `issue.claimed` is the empty
object; the schema requires nothing there and accepts nothing. The issue
offered two fixes: drop `slot`, or rename it to a held-count field. Occupancy
at the moment of a claim is already recorded: `slots.sample` is written once
per tick and on each change within a tick (spec 026 AC-2), so the sample
beside an `issue.claimed` event gives `active`, `slots`, `chains` and
`standing` at that moment, and a held count on the claim event would be a
second place for the same number to be wrong. A field named for a slot is
what ADR 0007 removed from the claim; this spec follows that decision rather
than reopening it. Events already in the store keep their `slot` (spec 026
AC-1: nothing rewrites a file under `events/`); the index loads them without
a payload check, and no reader consults the key, so they need no migration.
Cheap to reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- How slots are counted, held and granted (specs 009, 016, 023) and
  `slots.sample` (spec 026 AC-2): unchanged.
- The claim record and its schema (spec 034): unchanged.
- Every other event kind and payload of spec 026 AC-2, including
  `issue.eligible` and `issue.released`: unchanged.
- Rewriting events already in `events/*.jsonl`, the backfill (spec 026
  AC-4), or the test fixture `tools/scheduler/test/fixtures/events/2026-09.jsonl`,
  whose two `issue.claimed` lines carry `"slot": 0` as events written before
  this change do; they are loaded through the index as any stored line is.
- The metrics definitions and the `metrics` and `events query` commands
  (spec 027): none reads `payload.slot` of an `issue.claimed` event, and
  none changes.

## 3. Acceptance criteria

"Given" states use a temporary state directory and the mocked GitHub client
of `tools/scheduler/test/loop.test.ts`, and the `validate` of
`tools/scheduler/src/schema/validate.ts` for the schema cases.

- AC-1. **A claim records an empty payload.** Given a free slot and a
  shortlisted issue, when a tick claims it, then the store holds one
  `issue.claimed` event with `issue` the issue's number, `at` the claim
  time, and `payload` equal to `{}`. Given a paused record whose question is
  answered and a free slot, when a tick resumes the issue into a claim, then
  its `issue.claimed` event's payload is `{}`. Given a blocked record whose
  condition holds on `origin/main` and a free slot (spec 060 AC-7), when a
  tick unblocks it, then its `issue.claimed` event's payload is `{}`. No
  `issue.claimed` event written by the scheduler carries a `slot` key or any
  other key; `grep -n "issue.claimed" tools/scheduler/src/service/loop.ts`
  finds the three recording calls, each with the payload `{}`.
- AC-2. **The schema knows no `slot`.** Given `schemas/scheduler/event.json`,
  then the `issue.claimed` payload definition is an object with no
  properties, nothing required and `additionalProperties: false`. Given an
  event `{ kind: "issue.claimed", issue: 7, at: <an ISO time>, id: <a
  string>, payload: {} }`, when it is validated as `event`, then validation
  passes; given the same event with `payload: { slot: 1 }`, then it fails.
  A schema test asserts both; the second case fails on `main` before the
  change.
- AC-3. **Stored events are read as they are.** Given an `events/<month>.jsonl`
  holding an `issue.claimed` line with `"payload": {"slot": 0}` (the fixture
  of section 2, or a line appended by the test), when `openIndex` loads it,
  then the row is in the index with its payload as written and no skipped
  line is reported; `events.test.ts` and `metrics.test.ts` pass with the
  fixture unchanged. Nothing rewrites the line (spec 026 AC-1).
- AC-4. **The landed text follows.** Given the spec PR, then spec 026 AC-2
  carries the mark of section 4 and its earlier text follows unchanged; no
  other line of spec 026 changes, and no text marked `(maintainer answer,
  question #<id>)` changes anywhere.

## 4. Amendments to earlier specs

- Spec 026 AC-2 is marked `Amended by [095-issue-claimed-event-has-no-slot](../095-issue-claimed-event-has-no-slot/spec.md) AC-1: the issue.claimed payload is empty; its slot field, which spec 034 and ADR 0007 removed from the claim, is gone.`

Spec 026 section 5 is not amended: its list of recording calls in
`tools/scheduler/src/service/loop.ts` still names `issue.claimed` and still
holds. Spec 034 and ADR 0007 are not amended: they decide the claim record,
and this spec applies their decision to the event that copied it.

## 5. Interfaces and files

- `tools/scheduler/src/service/loop.ts`: the three `record(d.paths,
  "issue.claimed", ...)` calls (the shortlist claim in the start step, the
  claim write in `#resume`, the claim write in `#handleBlocked`) pass `{}`
  as the payload (AC-1). Nothing else in the file changes; `held` and
  `this.active` keep their other uses.
- `schemas/scheduler/event.json`: the `issue.claimed` entry under
  `$defs/payloads` becomes `{ "type": "object", "properties": {},
  "additionalProperties": false }` (AC-2). The kind list, the envelope and
  every other payload are unchanged.
- `tools/scheduler/test/schema.test.ts` (or `events.test.ts`, beside the
  envelope tests): the two cases of AC-2.
- `tools/scheduler/test/loop.test.ts`: the three cases of AC-1, read from
  the index (`openIndex`, `SELECT issue, payload FROM events WHERE kind =
  'issue.claimed'`) as the spec 063 AC-5 test reads `issue.eligible`. The
  resume and unblock cases may be assertions added to the existing tests
  that resume a paused record and unblock a blocked one, where those tests
  already run a tick that claims.
- `tools/scheduler/test/events.test.ts`: the AC-3 case, when the existing
  index tests do not already load the fixture's `issue.claimed` lines
  (`metrics.test.ts` does).
- `tools/scheduler/test/fixtures/events/2026-09.jsonl`: unchanged (section
  2).
- `specs/026-event-store/spec.md`: the AC-2 mark of section 4, and nothing
  else (AC-4).
- `docs/delivery-system-design.md` `## Children`: lists this spec.

No config key, stage prompt, state file format, log kind or metric
definition changes. `tools/scheduler/` and `schemas/` are sensitive paths,
so the security review runs on the implementation PR as spec 006 AC-9 says;
nothing here touches what decides that review, the sensitive-path list or
the security criteria. No new network call, listener or shell execution.

## 6. Verification

- `pnpm test` from the repository root passes and `pnpm -F
  @panelator/scheduler typecheck` is clean, with the tests of section 5
  added; the every-kind assertion of spec 026 AC-2 over the recorded chains
  (`e2e.test.ts`), which validates each written event against the schema,
  passes with the new payload.
- The AC-2 reject case fails on `main` before the change (the schema accepts
  `slot`) and passes after it; the AC-1 cases fail on `main` (the payload
  carries `slot`) and pass after it.
- `grep -rn "slot" schemas/scheduler/event.json` finds only the `slots` of
  the `slots.sample` payload; `grep -n "slot:" tools/scheduler/src/service/loop.ts`
  finds nothing.
- `git diff main -- specs/026-event-store/spec.md` shows only the mark of
  section 4.
- Live check after deploy: the first `issue.claimed` line the deployed
  scheduler appends under `events/` has `"payload": {}`, and the next
  `metrics` run reports the same metrics as before.

## 7. Open decisions

None.
