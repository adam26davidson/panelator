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
fails; a record once judged security stays private on every retry; and an
advisory that fails three times is held privately. When GitHub refused the
App (403), a public, content-free capability issue carries the question to
the maintainer through the chain's spec stage and question check (as
`escalate` issues do, spec 008 AC-21); the maintainer's answer closes it and
releases the held findings, and a daily probe closes it on its own once the
permission works.

## 2. Out of scope

- Rate-limit and quota retries of the standing run (issue #24, another
  spec).
- The cost of `searchOpenIssuesByMarker`, which lists every open issue with
  its timeline per filed decision.
- Granting the App permission itself, which is the maintainer's action.
- A capability question the question check sends back as "decide it
  yourself": the spec stage then decides in `decide` mode as for any other
  issue. The daily probe of AC-5 still closes the issue once the permission
  works.

## 3. Acceptance criteria

"Given" states use temporary state directories and a mocked GitHub client,
as in `tools/scheduler/test/filer.test.ts`.

**Definitions.** A ref is *settled* when `triage.jsonl` holds a row for it.
An advisory failure is a *permission* failure when GitHub answered 403 (or
"Resource not accessible by integration"), else an *error*. A queue ref's
*advisory attempts* of a kind is, when its last triage row is a failed
`security` row of that kind, that row's `attempt` (or `ADVISORY_ATTEMPTS - 1`
= 2 when the row is held), else 0. A *capability issue* is an open
bot-authored issue carrying the marker
`<!-- panelator-capability:security-advisories -->`.

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
  advisory call fails, then the row records `failed: true`, `failure`
  (`permission` or `error`) and `attempt: <advisory attempts of that kind +
  1>`; a failure of the other kind starts again at 1. Given the attempt
  reaches 3, then the row also records `held: true`, and for a permission
  failure `capability_issue: <number>` (AC-6). A held ref is offered again:
  - all at once, when its `capability_issue` is no longer open (AC-8);
  - otherwise as a *probe*: at most one held ref per batch, the one whose
    held row is oldest, and only when that row is at least a day old.

  A ref offered again starts at 2 attempts, so its first failure holds it
  again (under the open capability issue, or a new one when that issue is
  closed): a held ref costs at most one batch slot a day. A probe that fails
  again sends no notification; a new hold, or a hold that files a new
  issue, sends one, with the full error (notifications are private).
- AC-6. **A held permission failure becomes a capability question.** Given
  a permission failure held under AC-5, then the scheduler files, as the
  App, an issue carrying the capability marker, unless one is already open:
  it looks the capability issue up at most once per batch and remembers the
  one it creates, so two holds in a batch file one issue. The issue is
  labelled `validated` and `class:tooling` (or the first configured class
  when that label is not configured). Its body names the missing capability
  (the App's "repository security advisories: write" permission), the HTTP
  status and a fixed phrase, and the count of findings held; it never
  carries GitHub's error message, which can echo the advisory payload, nor
  any finding's title, description or evidence. It says the spec stage
  should return it as a question of kind `capability`. An `error` hold files
  no issue and is reported only in the private notification. Given an
  advisory that succeeds while something is held under a capability issue,
  then the scheduler looks the issue up once in that batch and closes it
  with a comment saying advisories work again; a success with nothing held
  lists no issues.
- AC-7. **The issue list re-lists before it fails.** Given the REST listing
  and the GraphQL total disagree, then `listOpenIssues` waits and lists both
  again, up to three more times with growing delays (1 s, 3 s, 9 s by
  default; the client takes the delays as an option), and returns the first
  listing that agrees. Given they still disagree after the last attempt, it
  throws `issue list incomplete: got <n>, server reports <m>` as before.
- AC-8. **How the chain handles a capability issue.** The issue has no
  `Spec:` line, so the chain claims it at the spec stage in `write` mode
  (spec 006 AC-19), which returns the capability question; the question
  check judges it and the issue pauses (spec 006 AC-12 to AC-16). Given the
  maintainer's answer to a paused issue that is a capability issue (by
  issue comment or Telegram), then the scheduler does not resume the chain:
  it writes the `answered` line to the questions log as for any answer,
  emits `maintainer_reply` (which wakes the findings filer, whose trigger
  now includes it), closes the issue with a comment, removes
  `needs-decision`, the paused record and any claim, and logs
  `capability-answered`. The filer's next input then offers every ref held
  under that issue (AC-5). Given the permission was granted without an
  answer, the daily probe succeeds and closes the issue (AC-6); the paused
  record of a closed issue is dropped as today (spec 006, review focus 5).
- AC-9. **A record once judged security stays private.** Given a record in
  the batch with `advisory_failed: true`, or whose ref has any earlier
  `security` triage row, or whose finding has `security: true`, then any
  decision other than `discard` is applied as `security`: no issue is
  created and no comment is posted. The filer prompt allows only `security`
  or `discard` for a retried record.

## 4. Amendments to earlier specs

- Spec 008 AC-16: "one per record in the input" means one per distinct ref,
  and "only then does `findings/cursor.json` move past the batch" becomes:
  the cursor is written after every apply, successful or not, at the end of
  the consecutive settled run (AC-4 here). Records already settled are not
  offered again (AC-2).
- Spec 008 AC-22: "the record is listed in the next run's input ... so the
  filer retries it" holds for the first three attempts; after them the
  record is held and, for a permission failure, raised as a capability
  issue (AC-5, AC-6 here). Its "a security flag overrides every public
  outcome" extends to records already judged security (AC-9).
- Spec 006 AC-15 and AC-18: an answer to a capability issue's question does
  not resume the asking stage; the issue is closed instead (AC-8 here).
- Spec 008 section on the filer's trigger: `maintainer_reply` is added.

## 5. Interfaces and files

- `tools/scheduler/src/filer/input.ts`: `buildFilerInput` builds the batch
  from distinct refs (AC-1, AC-2, AC-5); `QueueRecord.advisory_attempts`;
  `TriageEntry` gains `attempt`, `failure`, `held` and `capability_issue`; a
  `settledCursor(cursor, triage)` helper shared with `apply.ts`;
  `ADVISORY_ATTEMPTS = 3`, `PROBE_MS` (one day) and `CAPABILITY_MARKER`.
- `tools/scheduler/src/filer/apply.ts`: the distinct-ref check (AC-3), the
  cursor written in a `finally` (AC-4), the failure kind, attempt count,
  hold, capability issue and its closing (AC-5, AC-6), the privacy rule
  (AC-9).
- `tools/scheduler/src/service/loop.ts`: the capability issues of each tick
  and the answer path of AC-8.
- `agents/standing/findings-filer.md`: `maintainer_reply` in the trigger;
  distinct refs; a retried record is decided only as `security` or
  `discard`.
- `tools/scheduler/src/github/client.ts`: `listOpenIssues` re-lists (AC-7);
  the constructor takes an optional `{ settleDelaysMs }`.
- `tools/scheduler/test/filer.test.ts`: AC-1 to AC-6 and AC-9, including the
  regression for #33 (a failed advisory still inside the cursor window) and
  a batch aborted half way.
- `tools/scheduler/test/client.test.ts`: AC-7 (a first listing that is
  short, then one that agrees; and a persistent mismatch).
- `tools/scheduler/test/loop.test.ts`: AC-8, and the client takes zero
  delays in its setup.

`tools/scheduler/` and `agents/` are sensitive paths; the security review applies (spec 006
AC-9).

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-1 test fails on `main` before the change (the batch holds ref 10
  twice and no result validates) and passes after it.
- Live check after deploy: the next findings-filer run that is not rate
  limited applies its batch; `findings/cursor.json` exists; ref 10 is offered
  at most twice more, then held with one capability issue filed; that issue
  reaches the maintainer as a capability question, and the answer closes it
  with `capability-answered` in the service log.

## 7. Open decisions
