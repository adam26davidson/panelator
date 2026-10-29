# 019. The findings filer decides identical records once

Status: written 2026-10-29 from the delivery-system design for issue #63;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (the findings filer) and section 10 ("Small work skips layers":
a bug spec hangs directly off a top design);
[008-agent-registry](../008-agent-registry/spec.md) AC-15 (the filer's input:
at most 20 records, oldest first);
[014-filer-batch-integrity](../014-filer-batch-integrity/spec.md) AC-1, AC-2
and AC-4 (each ref once per batch, settled refs never re-sent, the cursor
follows the triage log); amends 008 AC-15 as section 4 records.

## 1. Goal

A run of identical findings costs one decision, not one per copy.

### What happens today (observed live 2026-10-29)

The 2026-10-28 rate-limit loop (fixed by spec 013 AC-7) queued 643 copies
of the scheduler's own record `standing agent findings-filer failed twice`,
identical but for `run_id` and `timestamp`. `buildFilerInput` takes the next
20 unsettled records oldest first, so each strong-tier filer run (about $3)
spends its whole batch discarding 20 copies for the reason the run before
gave, and about 50 real findings from the chains on issues 13, 15 and 25 wait
behind roughly 31 such runs. The `repeat` annotation tells the model the
earlier reason but still asks for a decision per copy.

### Why collapse rather than auto-discard

Auto-settling a record identical to one discarded recently would skip the
investigation the prompt asks for on repeat discards (process-spec 4.2 step
2: a model judges every distinct finding). Collapsing keeps one model
decision per distinct record and only stops paying for the copies. It also
drains the present backlog on its first run, with no hand edit of the state
directory.

## 2. Out of scope

- Stopping a producer from queueing copies in the first place (issue #62
  covers a standing agent's own failure re-waking it).
- Near-identical records (same `what` but different `evidence`); they stay
  separate entries and the existing `repeat` annotation applies.
- Rewriting `queue.jsonl` or `triage.jsonl` by hand.

## 3. Acceptance criteria

"Given" states use temporary state directories and a mocked GitHub client,
as in `tools/scheduler/test/filer.test.ts`.

- AC-1. **Identical records share one entry.** Two queue records are
  identical when every field but `run_id` and `timestamp` is equal (field
  order ignored). Given unsettled records after the cursor, then the batch
  holds the 20 oldest distinct ones, and every later unsettled record
  identical to an entry, anywhere in the queue, is listed in that entry's
  `duplicate_refs` instead of taking a place of its own. A retried advisory
  (spec 014) is an entry too, and collects its unsettled copies the same way.
  Given the live shape (hundreds of copies ahead of distinct findings), then
  one batch holds one entry for the copies and the distinct findings behind
  them.
- AC-2. **One decision settles every copy.** Given a decision on an entry with
  `duplicate_refs`, then after its own triage row each listed ref not already
  settled gets a row with the same outcome, issue and advisory and the reason
  `same record as ref <ref>: <reason>`, and no further GitHub call is made for
  them. The cursor then moves past every consecutive settled ref (spec 014
  AC-4). A decision whose advisory failed settles no copies; they ride on its
  retry.
- AC-3. **The model is told.** The filer prompt says a record with
  `duplicate_refs` stands for those identical records and that its one
  decision settles them all. Decisions still cover exactly the entries' refs
  (spec 014 AC-3); `duplicate_refs` need no decisions.

## 4. Amendments to earlier specs

- Spec 008 AC-15: "the next 20 unsettled records, oldest first" counts
  distinct records; later identical records ride on their entry (AC-1 here).

## 5. Interfaces and files

- `tools/scheduler/src/filer/input.ts`: `recordKey`,
  `QueueRecord.duplicate_refs`, the collapse in `buildFilerInput`.
- `tools/scheduler/src/filer/apply.ts`: the copy rows after an entry's row.
- `agents/standing/findings-filer.md`: `duplicate_refs`.
- `tools/scheduler/test/filer.test.ts`: AC-1 to AC-3, including the live shape.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `docs/delivery-system-design.md` are
sensitive paths; the security review applies (spec 006 AC-9).

## 6. Verification

- `pnpm test` from the repository root passes.
- The live-shape test fails on `main` (20 copies fill the batch) and passes
  after the change.
- Live check after deploy: the next findings-filer run's `input.json` has one
  entry for the `failed twice` copies, and after it `findings/cursor.json`
  is past line 724.

## 7. Open decisions

None.
