# 014. Findings filer batch integrity

Status: written 2026-10-29 from the delivery-system design for issues #33 and
#26; specs derived from that design need no maintainer approval (design
section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (the findings filer), section 3 item 3 ("What agents cannot do":
credentials and access) and section 10 ("Small work skips layers": a bug spec
hangs directly off a top design); [process-spec](../../docs/process-spec.md)
section 6.4 (listings are complete or the run fails); amends
[008-agent-registry](../008-agent-registry/spec.md) AC-16 (one decision per
distinct ref; the cursor follows the triage log) and AC-22 (advisory retries
are bounded), as section 4 records.

## 1. Goal

The findings filer can always make progress. Today it cannot.

### What happens today (observed live 2026-10-28 and 2026-10-29)

1. **Duplicated ref (#33).** The advisory for queue record 10 failed: the
   GitHub App lacks "repository security advisories: write"
   (`Resource not accessible by integration`). `buildFilerInput` lists failed
   advisories as retries, and also takes `queue.slice(cursor, cursor + n)`.
   The cursor was still 0 (earlier batches aborted, item 2), so record 10
   was in the batch twice. `applyFilerResult` requires
   `decisions.length` to equal the number of input records and the decision
   refs to be distinct, so no result can satisfy it: every run since has
   failed, and the model's own summaries say "ref 10 appears twice".
2. **Aborted batches never move the cursor.** The cursor is written only
   after the last decision of a batch is applied. A batch that aborts half
   way (item 3) keeps its applied decisions in `triage.jsonl`, but the cursor
   stays where it was, so every later run re-sends the already triaged
   records to the model.
3. **Issue-list race (#26).** Right after the filer creates an issue, the REST
   issue listing and the GraphQL `totalCount` disagree for a few seconds
   (eventual consistency). `listOpenIssues` fails on the first mismatch, so
   the filer's own write aborts the rest of its batch and counts as a
   standing-agent failure.
4. **Advisory retries never end.** A failed advisory is offered again in
   every batch, forever, and each failure sends a notification. A missing
   App permission is something agents cannot fix (design section 3, item 3);
   it should reach the maintainer as a capability question, not repeat
   silently.

### After this spec

The batch holds each ref once; the cursor follows the triage log, so applied
work is never re-sent; the completeness check re-lists a few times before it
fails; and an advisory that fails three times is held privately while a
public, content-free capability issue carries the question to the
maintainer through the chain (as `escalate` issues do, spec 008 AC-21).

## 2. Out of scope

- Rate-limit and quota retries of the standing run (issue #24, another
  spec).
- The cost of `searchOpenIssuesByMarker`, which lists every open issue with
  its timeline per filed decision.
- Granting the App permission itself, which is the maintainer's action.
- Changing how the chain handles the capability issue once filed: it is an
  ordinary validated issue without a `Spec:` line (spec 006 AC-19).

## 3. Acceptance criteria

"Given" states use temporary state directories and a mocked GitHub client,
as in `tools/scheduler/test/filer.test.ts`.

**Definitions.** A ref is *settled* when `triage.jsonl` holds a row for it.
A queue ref's *advisory attempts* is the `attempt` field of its last triage
row when that row is a failed `security` row that is not held, else 0.

- AC-1. **Each ref appears once in a batch.** Given a queue record whose
  last triage row is a failed `security` row, and that record also inside
  the cursor window, when the filer input is built, then the record appears
  once, as a retry with `advisory_failed: true` and `advisory_attempts`, and
  the batch is filled with other unsettled queue records up to 20.
- AC-2. **Settled records are not re-sent.** Given queue refs settled in an
  earlier, aborted batch, when the filer input is built, then they are not
  in the batch, and the input's `cursor` is the stored cursor advanced past
  every consecutive settled ref.
- AC-3. **Decisions cover distinct refs.** Given an input, then a result is
  valid only when its decisions carry each distinct input ref (records and
  abandoned issues) exactly once and no other ref. An input that somehow
  holds a ref twice still accepts one decision for it.
- AC-4. **The cursor follows the triage log.** Given a batch whose apply
  throws after some decisions were applied, then `findings/cursor.json` is
  still written, at the last ref of the consecutive settled run from the old
  cursor. Given a complete batch, the cursor moves past it as before (spec
  008 AC-16). A failed advisory row settles its ref (spec 008 AC-22: "the
  cursor still moves").
- AC-5. **Advisory retries are bounded.** Given a `security` decision whose
  advisory call fails, then the row records `failed: true` and
  `attempt: <advisory attempts + 1>`. Given the third consecutive failure,
  then the row also records `held: true` and `capability_issue: <number>`,
  and the ref is no longer offered as a retry while that issue is open and
  the held row is less than 7 days old. When the issue is closed, or after 7
  days, the ref is offered again with its attempts back at 0, so a held ref
  costs at most one batch slot a week.
- AC-6. **A held advisory becomes a capability question.** Given an
  advisory held under AC-5, then the scheduler files, as the App, at most
  one open issue carrying the marker
  `<!-- panelator-capability:security-advisories -->` (it searches open
  bot-authored issues for the marker first), labelled `validated` and
  `class:tooling` (or the first configured class when that label is not
  configured). Its body names the missing capability (the App's
  "repository security advisories: write" permission), the last error, and
  the count of findings held, says the spec stage should return it as a
  question of kind `capability`, and contains nothing of any finding's
  title, description or evidence. One notification says the finding is
  held. Given a later advisory that succeeds while that issue is open, then
  the scheduler closes it with a comment saying advisories work again.
- AC-7. **The issue list re-lists before it fails.** Given the REST listing
  and the GraphQL total disagree, then `listOpenIssues` waits and lists both
  again, up to three more times with growing delays (1 s, 3 s, 9 s by
  default; the client takes the delays as an option), and returns the first
  listing that agrees. Given they still disagree after the last attempt, it
  throws `issue list incomplete: got <n>, server reports <m>` as before.

## 4. Amendments to earlier specs

- Spec 008 AC-16: "one per record in the input" means one per distinct ref,
  and "only then does `findings/cursor.json` move past the batch" becomes:
  the cursor is written after every apply, successful or not, at the end of
  the consecutive settled run (AC-4 here). Records already settled are not
  offered again (AC-2).
- Spec 008 AC-22: "the record is listed in the next run's input ... so the
  filer retries it" holds for the first three attempts; after them the
  record is held and raised as a capability issue (AC-5, AC-6 here).

## 5. Interfaces and files

- `tools/scheduler/src/filer/input.ts`: `buildFilerInput` builds the batch
  from distinct refs (AC-1, AC-2, AC-5); `QueueRecord.advisory_attempts`;
  `TriageEntry` gains `attempt`, `held` and `capability_issue`; a
  `settledCursor(cursor, triage)` helper shared with `apply.ts`;
  `ADVISORY_ATTEMPTS = 3` and the 7-day hold.
- `tools/scheduler/src/filer/apply.ts`: the distinct-ref check (AC-3), the
  cursor written in a `finally` (AC-4), the attempt count, hold, capability
  issue and its closing (AC-5, AC-6).
- `agents/standing/findings-filer.md`: one sentence each on distinct refs and
  `advisory_attempts`, and that a held record is never made public.
- `tools/scheduler/src/github/client.ts`: `listOpenIssues` re-lists (AC-7);
  the constructor takes an optional `{ settleDelaysMs }`.
- `tools/scheduler/test/filer.test.ts`: AC-1 to AC-6, including the
  regression for #33 (a failed advisory still inside the cursor window) and
  a batch aborted half way.
- `tools/scheduler/test/client.test.ts`: AC-7 (a first listing that is
  short, then one that agrees; and a persistent mismatch).
- `tools/scheduler/test/loop.test.ts`: the incomplete-list test passes zero
  delays to the client.

`tools/scheduler/` and `agents/` are sensitive paths; the security review applies (spec 006
AC-9).

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-1 test fails on `main` before the change (the batch holds ref 10
  twice and no result validates) and passes after it.
- Live check after deploy: the next findings-filer run that is not rate
  limited applies its batch; `findings/cursor.json` exists; ref 10 is offered
  at most twice more, then held with one capability issue filed.

## 7. Open decisions
