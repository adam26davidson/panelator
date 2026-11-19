# 093. The scheduler's own failure findings name their cause, so a repeat matches only the same cause

Status: written 2026-11-19 from the delivery-system design for issue #190;
specs derived from that design need no maintainer approval (design section 11).
Marks [020-failure-finding-does-not-wake-its-agent](../020-failure-finding-does-not-wake-its-agent/spec.md)
AC-1 (amended by AC-1 here).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (standing agents and the findings filer) and section 10 ("Small
work skips layers": a bug spec hangs directly off a top design);
[008-agent-registry](../008-agent-registry/spec.md) AC-3 (a standing agent's
second failure appends one finding naming the agent and the error) and AC-19
(the filer's repeat marking, keyed on `what` and `where`, which this spec
keeps); [020-failure-finding-does-not-wake-its-agent](../020-failure-finding-does-not-wake-its-agent/spec.md)
AC-1 (the `standing agent X failed twice` finding, amended here);
[045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
section 2 (which left this mismatch to a finding) and AC-6 (a standing
failure counted past the outage ceiling); [015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md)
AC-4 (`transientCause`, the label of a transient error), AC-7 and AC-13 (the
`pending-work-failing` finding of a claim carrying work it must not drop);
[019-filer-collapses-identical-records](../019-filer-collapses-identical-records/spec.md)
AC-1 (duplicate collapsing on the whole finding, unchanged).

## 1. Goal

A queue record that the scheduler writes about its own failures is marked as
a repeat (spec 008 AC-19) only when an earlier discard was about the same
cause, so the filer never sees one cause's record carrying a discard reason
written for another.

### What is wrong today

Spec 008 AC-19 marks a record as a repeat, with the earlier discard's reason,
when a discard in the last 30 days has the same `finding.what` and
`finding.where` (`tools/scheduler/src/filer/input.ts`, the loop after the
batch is built). For findings written by agents that key works: `what` says
what is wrong. The scheduler's own failure findings put the same `what` and
`where` on every cause and the cause only in `evidence`:

- `tools/scheduler/src/standing/run.ts`, a standing agent's second failure:
  `what: "standing agent <name> failed twice"`, `where:
  "agents/standing/<name>.md"`, `evidence` the error.
- `tools/scheduler/src/service/loop.ts`, a claim carrying a pending event or
  abandonment that keeps failing (spec 015 AC-7, and AC-13 past the outage
  ceiling): `what: "pending work keeps failing"`, `where: "issue #<n>,
  pending <type> event"` (or `pending abandonment actions`), `evidence` the
  last error.

So a DNS failure, a rate limit and a genuine bug in the same agent are one
key, and the filer is shown the newest under a reason written for an older,
unrelated one, with the invitation to treat the repetition as the issue.
Issue #78 observed it: queue record ref 320's repeat reason named a 429 while
its evidence was `API Error: Can't reach the API server — check your internet
or DNS (EAI_AGAIN)`.

### The fix

Each of those two findings carries a short label of its cause at the end of
its `what`: `standing agent <name> failed twice: <cause>` and `pending work
keeps failing: <cause>`. The cause is the transient label the scheduler
already computed (`transientCause` or `transientRun`, spec 015 AC-4, spec 045
AC-1) when the failure was a transient one counted past the outage ceiling,
and otherwise the first line of the error, at most 60 characters. AC-19's key
is unchanged, so two records match only when their causes do.

*(agent's call)* The issue offered two fixes: (a) put the cause into `what`
for the scheduler's own findings, or (b) amend AC-19 to compare evidence too.
This spec takes (a). Spec 008 AC-19 is right for the findings it was written
for: an agent-written finding's evidence differs from run to run (a run id, a
line number, a quoted log), and requiring equal evidence would stop most real
repeats being recognised. The defect is in the two scheduler findings that put
their distinguishing text outside the key, so the fix is in them. The cause
is a short label rather than the whole error so that the same cause seen
again (the same `result: invalid`, the same `stage timeout`, the same thrown
message) still forms the same key; the first line and the 60-character cap
keep the parts that usually vary (a list of validation errors, a stack, a
quoted payload) out of it. A cause cut too short makes two different errors
one key, as today; one cut too long makes the same error two keys, which only
costs a repeat mark that is not shown: the filer still decides the record on
its evidence. For a transient failure counted past the ceiling the label is
the one the outage recorded (`EAI_AGAIN`, `HTTP 503`, `Can't reach the API
server`), not the error's first line, which starts with the constant `outage
past ceiling: ` prefix and would otherwise make every such outage one cause.

## 2. Out of scope

- Spec 008 AC-19's key and the code of the repeat marking in
  `filer/input.ts`: unchanged.
- Spec 019's duplicate collapsing (`recordKey`, every field but run and time):
  unchanged. It keys on the whole finding, `evidence` included, so it already
  keeps different causes apart; the longer `what` changes no collapsing
  between records written after this change.
- The outage findings (`network outage blocks standing agent <name>`,
  `network outage blocks the chain`, `disk space blocks the chain`, `network
  outage outlasted the retry ceiling`): unchanged. Each names one kind of
  cause in its `what` already (an outage, a full disk), and a discard reason
  written for one network outage (wait it out, or the host's network was
  down) applies to the next whatever its code; their label stays in
  `evidence` as spec 015 AC-8, AC-13 and spec 045 AC-5 have it.
- Agent-written findings and every other scheduler finding (scope, review,
  children scan, sweep): unchanged. Their `what` already says what is wrong.
- The notification texts (`Standing agent <name> failed twice: <error>`, the
  `chain_error` text), their labels, the log lines and the `agent.run`
  records: unchanged; they already carry the whole error.
- Rewriting `findings/queue.jsonl` or `findings/triage.jsonl`: records and
  discards written before this change keep their `what`. A new record never
  matches an old discard (the old `what` has no `: <cause>`), so an old
  discard stops being offered as a repeat as soon as the change lands, and
  ages out of the 30-day window on its own.
- Choosing which errors are transient: spec 015 AC-4 and spec 045 AC-1 as
  they are.

## 3. Acceptance criteria

- AC-1. **A standing agent's failure finding names its cause.** Given a
  standing agent `X` whose second consecutive attempt fails, so that the
  scheduler appends the failure finding of spec 008 AC-3 and spec 020 AC-1,
  then the finding is `{ what: "standing agent X failed twice: <cause>",
  where: "agents/standing/X.md", evidence: <the error>, noticed_how:
  "standing run retry exhausted" }`, where `<cause>` is `failureCause(error,
  transient)` (AC-3) with `error` the attempt's error as recorded today and
  `transient` the transient label the attempt was classified with (spec 045
  AC-1), which is non-null only for a failure counted past the outage
  ceiling (spec 045 AC-6). `where`, `evidence`, `noticed_how`, the envelope,
  the `exclude` of spec 020 AC-1 and the one notification are as today.
  Given a run judged failed with reason `result: invalid` both times, then
  the finding's `what` is `standing agent X failed twice: result: invalid`.
  Given an outage counted past the ceiling whose label is `EAI_AGAIN`, then
  the `what` is `standing agent X failed twice: EAI_AGAIN` and the evidence
  still starts `outage past ceiling: ` (spec 045 AC-6).
- AC-2. **The pending-work finding names its cause.** Given a claim carrying
  a pending event or abandonment whose failures reach the count at which the
  scheduler appends the `pending work keeps failing` finding (spec 015 AC-7,
  `#countFailure` in `service/loop.ts`), then the finding's `what` is
  `pending work keeps failing: <cause>` with `<cause>` =
  `failureCause(error, null)`. Given the same finding appended on the first
  failure counted past the outage ceiling (spec 015 AC-13,
  `#countTransient`), then `<cause>` = `failureCause(last, cause)` with
  `cause` the outage's transient label. `where`, `evidence`, `noticed_how`,
  the envelope, the `pending-work-failing` log line and the `chain_error`
  notification are as today. Given a genuine error `boom` thrown three times
  on such a claim, then the `what` is `pending work keeps failing: boom`.
- AC-3. **The cause label.** `failureCause(error: string, transient: string
  | null): string`, exported from `tools/scheduler/src/chain/transient.ts`,
  returns `transient` when it is a non-empty string; otherwise the first line
  of `error` (the text before its first `\n`), trimmed, cut to its first 60
  code points (`CAUSE_MAX = 60`, a named constant) and trimmed again; and
  `unknown error` when that is empty. So:
  - `failureCause("result: invalid", null)` is `result: invalid`;
  - `failureCause("outage past ceiling: API Error: Can't reach the API
    server (EAI_AGAIN)", "EAI_AGAIN")` is `EAI_AGAIN`;
  - `failureCause("standing input: /records/0 must have required property
    'where'; /records/1 ...", null)` is the first 60 code points of that
    text;
  - `failureCause("exit 1\nstack ...", null)` is `exit 1`;
  - `failureCause("", null)` and `failureCause("  \n", null)` are `unknown
    error`;
  - `failureCause("boom", "")` is `boom`.
  A text of more than 60 code points with a character outside the BMP at the
  cut is not split inside the character.
- AC-4. **A repeat matches only the same cause.** Given a discard in
  `findings/triage.jsonl` within the last 30 days of a record `{ what:
  "standing agent findings-filer failed twice: rate limited (429)", where:
  "agents/standing/findings-filer.md" }` with reason `R`, when the filer's
  input is built with a new queue record for the same agent whose `what` is
  `standing agent findings-filer failed twice: EAI_AGAIN`, then that record
  has no `repeat`. Given a new record whose `what` is `standing agent
  findings-filer failed twice: rate limited (429)` (its evidence may differ),
  then it has `repeat: R`, as spec 008 AC-19 says. The same holds for two
  `pending work keeps failing: <cause>` records with the same `where`.
- AC-5. **Nothing else changes.** Given the input built from a queue holding
  records written before this change and after it, then spec 019's
  collapsing and spec 008 AC-19's marking are applied by the code as it is
  today, with no special case for the old or the new `what`. The outage
  findings of section 2 are written as today.

## 4. Interfaces and files

- `tools/scheduler/src/chain/transient.ts`: `CAUSE_MAX = 60` and
  `failureCause(error, transient)` of AC-3, exported, with a doc comment
  citing spec 093 AC-3.
- `tools/scheduler/src/standing/run.ts`: the `failed twice` finding's `what`
  of AC-1. The attempt's `transient` value is already in scope where the
  finding is appended (it is non-null there only on the `keepOutage` path of
  spec 045 AC-6).
- `tools/scheduler/src/service/loop.ts`: the two `pending work keeps failing`
  findings' `what` of AC-2 (`#countFailure` with `failureCause(error,
  null)`, `#countTransient` with `failureCause(last, cause)`).
- `tools/scheduler/src/filer/input.ts`: no change.
- Tests:
  - `tools/scheduler/test/transient.test.ts`: AC-3's cases.
  - `tools/scheduler/test/filer.test.ts`: AC-4, next to `marks repeat
    discards with the earlier reason` (a discard and two new records, one
    per cause, for the standing finding; one same-cause pair for the
    pending-work finding).
  - `tools/scheduler/test/standing-wakes.test.ts`: the assertion that the
    last queue record's `what` is `standing agent findings-filer failed
    twice` becomes `standing agent findings-filer failed twice: result:
    invalid` (AC-1's first example).
  - `tools/scheduler/test/e2e.test.ts`: `FAILED_TWICE` stays the prefix, and
    the `toEqual([FAILED_TWICE])` assertion on the queue's `what` values
    becomes an assertion that there is one record whose `what` starts with
    `FAILED_TWICE + ": "` and ends with the scripted failure's cause; the
    `toContain(FAILED_TWICE)` assertions are unchanged. The spec 045 AC-6
    test (`an outage a day old stops being transient ...`), which already
    reads the one queued record, also asserts that its `what` is `standing
    agent operator failed twice: <label>` with `<label>` the transient label
    of its scripted network failure, not the evidence's first line.
  - `tools/scheduler/test/loop.test.ts`: the `pending work keeps failing`
    assertion's `what` becomes `pending work keeps failing: boom` (AC-2's
    example); the AC-13 pending-work case, where one exists, asserts the
    outage label.
- `specs/020-failure-finding-does-not-wake-its-agent/spec.md`: the AC-1 mark
  of AC-1 above, and nothing else.
- `docs/delivery-system-design.md` `## Children`: lists this spec.

No schema, config key, stage prompt, state file format or log kind changes:
`what` is a free string in `schemas/finding.schema.json`.
`tools/scheduler/` is a sensitive path, so the security review runs on the
implementation PR as spec 006 AC-9 says; nothing here touches what decides
that review.

## 5. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean
  with the tests of section 4.
- The AC-4 test fails when `failureCause` is replaced by a function returning
  the empty string (both records then share the old key and the `EAI_AGAIN`
  record is marked with the 429 reason); checked by hand once while writing
  the test, not committed.
- `git diff main -- tools/scheduler/src/filer/input.ts` is empty.
- In spec 020, the only change is the mark after AC-1's number.

## 6. Open decisions

None.
