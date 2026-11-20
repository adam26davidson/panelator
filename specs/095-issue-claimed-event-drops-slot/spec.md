# 095. The `issue.claimed` event drops its `slot` field

Status: written 2026-11-20 from the delivery-system design for issue #199;
specs derived from that design need no maintainer approval (design section 11).
Amends [026-event-store](../026-event-store/spec.md) AC-2 (the `issue.claimed`
payload is `{}`, not `{ slot }`), marked as section 4 records.
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 7 ("Raw events, derived metrics": concurrency slot occupancy is a raw
event, which is what `slots.sample` records, so a claim carries no count of its
own) and section 10
("Small work skips layers": a bug spec hangs directly off a top design);
[ADR 0007](../../docs/decisions/0007-claim-record-has-no-slot-field.md) (a
claim has no slot and no slot identity is defined; this spec applies that
decision to the one record that still names one);
[034-claim-drops-slot-field](../034-claim-drops-slot-field/spec.md) (the claim
record lost the field; its AC-4 is the model for how an older record is read);
[026-event-store](../026-event-store/spec.md) AC-1 (an event line is never
rewritten; a payload is validated against `schemas/scheduler/event.json` when
recorded), AC-2 (the `issue.claimed` payload, amended here, and `slots.sample`,
which already records occupancy at each change) and AC-3 (the index loads
stored lines without the per-kind payload check).

## 1. Goal

An `issue.claimed` event says only that the issue was claimed and when. Spec
026 AC-2 gave it the payload `{ slot }`, written when the claim record still
carried `slot`. ADR 0007 and spec 034 removed that field from the claim
because its value (the size of the active set at claim time) is not a slot
number and nothing reads it. The recording call in
`tools/scheduler/src/service/loop.ts` now substitutes the count of claims
held at claim time, which is the same pseudo-slot under the name ADR 0007
rejected. The payload becomes `{}`; the schema stops knowing `slot`; the
events already in the store keep their lines, as spec 026 AC-1 requires.

## 2. Out of scope

- A slot identity (ADR 0007 decides there is none; a spec written from a
  reader's needs would define one).
- A held-count field under another name. Occupancy at each change is already
  `slots.sample` (spec 026 AC-2), recorded in the same tick as the claim, so a
  count on the claim event would duplicate it; see design section 7.
- The claim record, `Claim` type and `schemas/scheduler/claim.json` (spec 034
  did that work; `state/claims.ts` keeps dropping a legacy `slot` on read).
- Rewriting, migrating or re-indexing stored event lines, and the backfill
  (spec 026 AC-1 and AC-4).
- The metrics and queries of specs 027 and 028. None reads `payload.slot` of
  `issue.claimed` (queue wait is measured from `issue.eligible` or the
  issue's `validated_at` to the `at` of `issue.claimed`); a test asserts it
  stays that way (AC-5).
- The three places that record `issue.claimed` and when they record it; only
  the payload they pass changes.

## 3. Acceptance criteria

"Given" states use a temporary state directory and a mocked GitHub client,
as in `tools/scheduler/test/loop.test.ts` and `tools/scheduler/test/events.test.ts`.

- AC-1. **A new claim records `issue.claimed` with an empty payload.** Given a
  free slot and a shortlisted issue, when a tick claims it, then the
  `issue.claimed` event appended to the month's JSONL has `issue` the issue
  number and `payload` equal to `{}` (no `slot` key and no other key). The
  same holds for the two other recording sites: given a paused record whose
  question is answered and a free slot, when the tick resumes the issue, and
  given a blocked record whose condition holds (spec 060 AC-7), when the tick
  claims it again, then each `issue.claimed` event's payload is `{}`.
- AC-2. **The schema does not know the field.** Given an envelope with
  `kind: "issue.claimed"` and `payload: { slot: 0 }`, when it is validated as
  `event`, then validation fails (the `issue.claimed` payload definition in
  `schemas/scheduler/event.json` is an object with no properties and
  `additionalProperties: false`), and `recordEvent` with that payload throws
  and writes nothing (spec 026 AC-1). Given the same envelope with
  `payload: {}`, then validation passes.
- AC-3. **An older stored event is still read.** Given a monthly JSONL file
  in `events/` containing an `issue.claimed` line whose payload is
  `{ "slot": 1 }`, written before this spec, when `openIndex` loads it (spec
  026 AC-3), then the line is indexed like any other, the file is not
  rewritten (its bytes are unchanged), and a query for the kind returns the
  event with its stored payload. The fixture
  `tools/scheduler/test/fixtures/events/2026-09.jsonl`, which stands for a
  store from before this spec, keeps its `issue.claimed` lines as they are.
- AC-4. **Nothing in the scheduler builds a slot number for the event.**
  Given `tools/scheduler/src/`, then no `record(...)` or `recordEvent(...)`
  call for `issue.claimed` passes a payload with a key, and no source still
  computes a value named `slot` for it: `grep -rn "issue.claimed" tools/scheduler/src`
  shows the kind table, the three recording calls with `{}` and comments only.
  `pnpm -F @panelator/scheduler typecheck` passes.
- AC-5. **No reader depended on the field.** Given the metric definitions and
  queries of specs 027 and 028 (`tools/scheduler/src/metrics/`,
  `tools/scheduler/src/reflection/`, the metric definition files they load),
  then none selects `payload.slot` of an `issue.claimed` event, and the
  metrics tests pass unchanged with the fixture of AC-3 (whose stored `slot`
  values are still there and still unread). A test greps those directories
  for `slot` and asserts every hit is the `slots` count or `slots.sample`.
- AC-6. **The landed text follows.** Given this spec's PR, then spec 026 AC-2
  carries the mark of section 4 before its earlier marks, and no other line of
  spec 026 changes; no text marked `(maintainer answer, question #<id>)`
  changes anywhere.

**Why `{}` and not a renamed count** *(agent's call)*: the issue offers both.
A count of held claims at claim time is `slots.sample.active` of the same
tick, which spec 026 AC-2 records "on each change within a tick", so the
claim event would carry a copy of a number already next to it in the store,
under a name that still invites the reading ADR 0007 rejected (two claims in
one tick get consecutive counts that look like positions). ADR 0007's
reasoning applies without change: nothing wants the number, and a record that
says only what the scheduler uses is the smaller change. This is not a large
decision; it applies the recorded one, so no ADR is added.

## 4. Amendments to earlier specs

- **Spec 026 AC-2.** AC-2 is one criterion holding every kind, and the
  `issue.claimed` entry sits inside the `issue.eligible` bullet with no title
  of its own, so the smallest unit is the criterion: the mark
  `Amended by [095-issue-claimed-event-drops-slot](../095-issue-claimed-event-drops-slot/spec.md) AC-1: the issue.claimed payload is {}, with no slot (ADR 0007).`
  is prepended after `AC-2.`, before the marks of specs 074, 068 and 063
  already there. The text that follows, including `` `issue.claimed`: `{ slot }` ``,
  stays unchanged as the record. Section 5 of spec 026 needs no mark: its
  recording-call list names `issue.claimed` in `loop.ts` without a payload,
  which stays true.

## 5. Interfaces and files

- `tools/scheduler/src/service/loop.ts`: the three `record(d.paths,
  "issue.claimed", ...)` calls (the paused-issue resume, the blocked-record
  reclaim and the start step's claim) pass `{}` as the payload. The `held`
  counter and `this.active` keep their other uses; nothing else in the file
  changes.
- `schemas/scheduler/event.json`: the `issue.claimed` entry under
  `$defs.payloads` becomes `{ "type": "object", "properties": {},
  "additionalProperties": false }` (AC-2). No other definition changes.
- `tools/scheduler/src/events/store.ts`, `index.ts`, `backfill.ts`,
  `kinds.ts`: no change (AC-3 holds because the index never validated
  payloads and the store never rewrites a line).
- Tests:
  - `tools/scheduler/test/loop.test.ts`: AC-1's three cases, each reading the
    month's JSONL and asserting the `issue.claimed` payload (the start-step
    case may extend an existing claim test).
  - `tools/scheduler/test/schema.test.ts` or `events.test.ts`: AC-2.
  - `tools/scheduler/test/events.test.ts`: AC-3, a line with `{ "slot": 1 }`
    written directly to a monthly file, then `openIndex` and a query.
  - `tools/scheduler/test/events.test.ts` (which already loads the fixture):
    AC-5's grep assertion; the fixture itself is unchanged.
- `specs/026-event-store/spec.md`: the AC-2 mark of section 4, and nothing
  else.
- `docs/delivery-system-design.md` `## Children`: lists this spec.

No config key, stage prompt, state file format, label rule or log kind
changes. `tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`),
so the security review runs on the implementation PR as spec 006 AC-9 says;
nothing here touches a gate, a bound or what decides that review.
`schemas/scheduler/event.json` is not a sensitive path.

## 6. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean with the tests of
  section 5.
- The AC-1 tests fail on `main` (the payload carries `slot`) and pass after
  the change; the AC-2 test fails on `main` (the schema requires `slot`) and
  passes after.
- `grep -rn "slot" tools/scheduler/src/service/loop.ts` finds no `issue.claimed`
  payload key; `grep -n "slot" schemas/scheduler/event.json` finds only the
  `slots.sample` definition and its `slots` property.
- `git diff main -- specs/026-event-store/spec.md` shows only the mark after
  `AC-2.`.
- Live check after deploy: the first `issue.claimed` line the deployed
  scheduler appends has `"payload": {}`, and `scheduler events query` (spec
  027) over the month still returns the earlier lines with their `slot`.

## 7. Open decisions

None.
