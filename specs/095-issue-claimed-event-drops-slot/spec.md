# 095. The `issue.claimed` event drops its `slot` field

Status: written 2026-11-19 from the delivery-system design for issue #199;
specs derived from that design need no maintainer approval (design section 11).
Marks [026-event-store](../026-event-store/spec.md) AC-2 (amended by AC-1
here: the `issue.claimed` payload).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (agents resolve their own blockers; a flaw the
filer records is fixed through an ordinary spec);
[ADR 0007](../../docs/decisions/0007-claim-record-has-no-slot-field.md)
(a claim has no slot identity; the count of claims held at claim time is
not a slot number and is removed rather than defined);
[034-claim-drops-slot-field](../034-claim-drops-slot-field/spec.md) (the
claim record lost the field; this spec removes the same value from the
event that records the claim);
[026-event-store](../026-event-store/spec.md) AC-1 (an event's payload is
validated against `schemas/scheduler/event.json`; a file under `events/` is
never rewritten) and AC-2 (the `issue.claimed` payload this spec amends,
and `slots.sample`, which already records occupancy on each change).

## 1. Goal

The `issue.claimed` event says only what the scheduler knows: that the
issue was claimed, and when. Nobody reading the event store sees a field
that looks like a slot number and is not one.

### What is wrong today

Spec 026 AC-2 defines the `issue.claimed` payload as `{ slot }`. It was
written before spec 034, which removed `slot` from the claim record on ADR
0007's decision that a claim has no slot identity. The issue #93
implementation, which landed spec 026, had no slot to record and put the
number of claims held at the moment of the claim in its place:
`tools/scheduler/src/service/loop.ts` records `{ slot: held }` at the
shortlist claim and `{ slot: this.active + 1 }` at the resume of an
answered pause and at the unblocking of a blocked record. That is the value
ADR 0007 rejected: two claims written while one chain runs both carry
`slot: 1`, and the number names nothing the scheduler does. The schema
(`schemas/scheduler/event.json`, the `issue.claimed` payload) requires it,
so the implementation cannot drop it without diverging from the spec.

### The fix

Remove the field: from the payload in spec 026 AC-2 (marked here), from the
three records in the loop and from the schema. The payload is the empty
object. The event still gives queue and shortlist wait time, which is what
spec 026 AC-2 wants from it: that is the event's time against
`issue.eligible` and the issue's `validated_at` or `created_at`, and no
payload field takes part. Slot occupancy at the moment of a claim is
already in the store: spec 026 AC-2 records `slots.sample` once per tick and
on each change within a tick, and a claim is such a change. Events already
on disk that carry `slot` stay as they are: spec 026 AC-1 never rewrites a
file under `events/`, and the index loads a line without checking its
payload.

*(agent's call)* The field is dropped, not renamed to a held count. ADR
0007 already decided that nothing wants the value and that keeping it under
any name misleads in the same way; `slots.sample` carries the count for any
reader that wants occupancy, with its `slots` ceiling beside it, which a
bare count on the claim event would lack. No ADR is added: ADR 0007 is the
decision, and this spec only carries it to the one record spec 034 missed.

## 2. Out of scope

- How slots are counted and granted (specs 009, 016, 023), and the claim
  record itself (spec 034): no change.
- Every other event kind of spec 026 AC-2, including `slots.sample` and
  `issue.eligible`: unchanged. In particular `issue.claimed` gains no other
  field (no reason, no origin of the claim): a new field is a new reader's
  spec, as ADR 0007 says of a slot identity.
- The metrics of spec 027 and the reflection input of spec 028: neither
  reads a field of the `issue.claimed` payload, and neither changes.
- Rewriting, backfilling or migrating events already recorded with `slot`.
  They are history and stay as written (spec 026 AC-1).
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states use a temporary state directory, the fake harness and a
mocked GitHub client, as in `tools/scheduler/test/loop.test.ts`, except
where an AC says it reads or writes files as text.

- AC-1. **A claim records `issue.claimed` with an empty payload.** Given a
  free slot and a shortlisted issue, when a tick claims it, then exactly one
  `issue.claimed` event is appended for that tick with `issue` the issue's
  number and `payload` equal to `{}` (no `slot` key, no other key). Given a
  paused record whose question is answered and a free slot, when a tick
  resumes the issue into a claim, then the `issue.claimed` event it records
  has `payload` `{}`. Given a blocked record whose condition holds on
  `origin/main` (spec 060 AC-7) and a free slot, when a tick turns it back
  into a claim, then the `issue.claimed` event it records has `payload`
  `{}`. In each case the event's `at` and `issue` are as before, and every
  other event the tick records is unchanged. Spec 026 AC-2 carries an
  `Amended by` mark naming this AC, placed after `AC-2.` and before the
  marks already there, whose clause says the `issue.claimed` payload is the
  empty object; its text after the mark is unchanged.
- AC-2. **The schema does not know the field.** Given an event envelope of
  kind `issue.claimed` with `payload: { slot: 1 }`, when it is validated as
  `event`, then validation fails (the `issue.claimed` payload schema is an
  object with no properties and `additionalProperties: false`, and `slot`
  is neither required nor a property). Given the same envelope with
  `payload: {}`, then validation passes. Given `recordEvent` is called with
  the first envelope, then it throws and nothing is written (spec 026
  AC-1's rule, now covering this field).
- AC-3. **An older event is still loaded and never rewritten.** Given an
  `events/<YYYY-MM>.jsonl` file holding an `issue.claimed` line with
  `payload: { "slot": 0 }` written before this spec, when `openIndex` loads
  it, then the line is loaded as one row of `events` (not skipped, not
  reported in the service log) and the file's bytes are unchanged
  afterwards. The two `issue.claimed` lines of the fixture
  `tools/scheduler/test/fixtures/events/2026-09.jsonl` drop their `slot`
  key, and the metrics tests that read that fixture pass with no change to
  their expectations.
- AC-4. **The code has no slot to record and compiles.** Given
  `tools/scheduler/src/service/loop.ts`, then no `record` call of kind
  `issue.claimed` passes a `slot` property; given `pnpm -F
  @panelator/scheduler typecheck` (or the equivalent `tsc --noEmit` in
  `tools/scheduler/`), then it passes. The held-slot count of spec 009 and
  the turn taking of spec 016 are untouched: the tests of spec 009 (AC-1 to
  AC-6), spec 016 (AC-1 to AC-8) and spec 034 (AC-1 to AC-6) pass without
  changes to their expectations.

## 4. Interfaces and files

- `tools/scheduler/src/service/loop.ts`: the three `issue.claimed` records
  (the shortlist claim in the start step, the resume of an answered pause,
  the unblocking of a blocked record) pass `{}` as the payload. The
  `held++` beside the shortlist claim stays: it is the held count of spec
  009, which this spec does not touch. Nothing else in the file changes.
- `schemas/scheduler/event.json`: the `issue.claimed` payload definition
  becomes an object with empty `properties`, no `required`, and
  `additionalProperties: false` (AC-2). The kind list and the per-kind
  `if`/`then` that references the definition are unchanged.
- `tools/scheduler/test/loop.test.ts`: tests for AC-1 (the three claim
  paths, each asserting the `issue.claimed` event's payload is `{}`; the
  resume and unblock cases may extend the existing tests of those paths).
- `tools/scheduler/test/schema.test.ts` or
  `tools/scheduler/test/events.test.ts`: the AC-2 validation test and the
  `recordEvent` throw.
- `tools/scheduler/test/events.test.ts`: the AC-3 load of an older line.
- `tools/scheduler/test/fixtures/events/2026-09.jsonl`: the two
  `issue.claimed` lines lose `"slot": 0` (AC-3).
- `specs/026-event-store/spec.md`: the AC-1 mark on AC-2, and nothing else.
- `docs/delivery-system-design.md` `## Children`: lists this spec.

The spec PR itself adds `specs/095-issue-claimed-event-drops-slot/spec.md`,
the mark in spec 026 and the Children entry.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`); the
security review applies to the implementation PR (spec 006 AC-9).
`schemas/` is not on the list. The change touches no gate, bound, label
rule or permission: it removes a field from an event payload and the schema
that describes it.

## 5. Verification

- `pnpm test` from the repository root passes and `pnpm -F
  @panelator/scheduler typecheck` is clean.
- The AC-1 tests fail on `main` (the recorded payload carries `slot`) and
  pass after the change. The AC-2 test fails on `main` (the schema requires
  `slot`) and passes after.
- `grep -n "slot:" tools/scheduler/src/service/loop.ts` finds nothing (the
  `slots` configuration key and the `slots.sample` payload keep their names
  and are not matched by `slot:`).
- `grep -n '"slot"' schemas/scheduler/event.json` finds nothing.
- `git diff main -- specs/026-event-store/spec.md` shows only the mark
  before AC-2's existing text.
- Live check after deploy: the first `issue.claimed` line the deployed
  scheduler appends has `"payload":{}`, and `panelator-scheduler metrics`
  (spec 027) runs over a store that holds both older lines with `slot` and
  new ones without, with no skipped-line report in the service log.

## 6. Open decisions

None.
