# 025. The filer's results are kept, its wakes are paced, and a discard resting on a PR is not final

Status: written 2026-10-31 from the delivery-system design; specs derived
from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (the findings filer, event triggers, schedules as parameters) and
section 10 ("Small work skips layers": a bug spec hangs directly off a top
design); [process-spec](../../docs/process-spec.md) section 4.2 step 2 ("not an
issue": recorded with reason);
[008-agent-registry](../008-agent-registry/spec.md) AC-3, AC-11, AC-15, AC-16
and AC-19; [014-filer-batch-integrity](../014-filer-batch-integrity/spec.md)
AC-2 and AC-8; [018-filer-class-labels](../018-filer-class-labels/spec.md);
[019-filer-collapses-identical-records](../019-filer-collapses-identical-records/spec.md);
[020-failure-finding-does-not-wake-its-agent](../020-failure-finding-does-not-wake-its-agent/spec.md)
AC-2. Amends 008, 014 and 020 as section 4 records.

## 1. Goal

A filer run's investigation is not thrown away over the shape of its JSON, a
stream of findings does not start a strong-tier run for each one, and a finding
discarded because of work in flight comes back if that work is abandoned.

### What happens today (observed live)

- **The prompt does not name the keys.** It describes "file (issue with title,
  body, class)" and "a fallback issue", never the key `issue`. The schema has
  `additionalProperties: false`, and `file` requires `issue` and `reason`. Two
  runs ($5.11 and $3.12; `standing-findings-filer-1-1793449615091` and
  `-1793455815375`) ended `result: invalid` from 7 `fallback` keys and 9 flat
  `file` decisions.
- **The prompt asks for a file the agent cannot write.** Standing agents have
  no write tool and their result comes from the final text. Some runs tried,
  were refused and emitted the JSON again, about $1 each.
- **Every pending event starts a run.** The first retry of an invalid result is
  a fresh run of the whole investigation. Events are then cleared, but the
  unsettled records are offered again at the next wake, so an invalid batch
  repeats at the pace findings arrive.
- **A discard is final.** One resting on an in-flight PR (triage rows citing
  #73, which closed unmerged) silently loses the finding.

## 2. Out of scope

- MCP isolation of standing runs (a separate branch, in the runner and
  adapters).
- A repair turn for a result the apply step refuses after validation
  (`decisions must cover each input ref exactly once`). Only `result: invalid`
  gets one.
- Issue #58, the per-decision issue listings in `applyDecisions`, unchanged.
  The PR lookups added here follow its advice and are cached per run.
- `agents/standing/action-audit.md`, which carries the same write instruction
  (`{{result_path}}`). It has no recorded runs yet and is left as it is.
- Draining a backlog faster: a batch is still 20 records per run (section 5).

## 3. Acceptance criteria

"Given" states use temporary state directories, a mocked GitHub client and the
scripted harness of `tools/scheduler/test/helpers/e2e-routes.ts`.

### The prompt

- AC-1. **The prompt shows the exact shape.** `findings-filer.md` names the
  keys, gives one JSON example per outcome (`discard`, also with `rests_on_pr`;
  `file`; `merge_into`, whose fallback goes in `issue`; `escalate`; `security`;
  `retry`; `rewrite`; `close`; `defer`), says to return the JSON as the final
  message and that there is no write tool, and no longer names `{{result_path}}`.
  Given the examples, then each validates against `filer-result`, and rendering
  the prompt leaves them intact.

### Recorded shapes

- AC-2. **The two recorded shapes are put right before validation.** Given a
  decision with outcome `file`, `rewrite`, `escalate` or `merge_into`, then:
  `fallback` with no `issue` and no flat keys becomes `issue`; `title`, `body`
  and `class`, all strings, with no `issue` and no `fallback`, are gathered into
  `issue`; and a missing `reason` becomes a placeholder that says what it is.
  Given anything else (some flat keys only, `fallback` beside `issue` or beside
  flat keys, a `fallback` that is no object, these keys on any other outcome, a
  missing `reason` on any other outcome, an unknown key), then it is left alone
  and the schema refuses it. `result.json` keeps what the model returned, and
  `outcome.json` lists what was changed under `normalised`. A normalised result
  passes `applyFilerResult`, whose checks then run as for any result; given a
  `merge_into` whose target has closed, then the moved `issue` is what is filed.

### The repair turn

- AC-3. **An invalid result gets one repair turn.** Given a first attempt whose
  run ends `result: invalid`, then the same session is resumed once on the same
  harness and model, under run id `<run id>-repair` and with at most 5 turns,
  with a prompt listing the validation errors (at most 40) and asking for the
  complete corrected JSON as the final message and no further investigation.
  Given the repaired result validates, then it is applied as the run's result.
- AC-4. **A second invalid result is a failure.** Given the repair turn is also
  invalid, then the attempt counts as a failure under spec 008 AC-3.
- AC-5. **Retries stay bounded.** The retry of spec 008 AC-3 is a fresh run with
  no repair turn of its own, so one wake costs at most three runs and a second
  failure ends as it did. Given a first attempt that failed in any other way,
  then it gets no repair turn.
- AC-6. **A repair turn is an ordinary run.** It has its own run directory and
  usage record, `running` names it, and a 429 on it postpones the agent as in
  spec 013 AC-7 with no failure counted. Given the session cannot be resumed,
  then the runner's existing fall back to a fresh run applies, under the same
  turn cap, so it cannot become a full investigation; if it does not return a
  valid result, that counts as AC-4.

### A discard resting on a PR

- AC-7. **The decision names the PR.** `filer-result` allows an integer
  `rests_on_pr` on a `discard` only. The prompt requires it when a discard relies
  on unmerged work, unless the discard cites binding spec text.
- AC-8. **The row keeps it.** Given such a decision, then its triage row, and the
  rows of the copies it settles (spec 019 AC-2), carry `rests_on_pr`.
- AC-9. **A closed PR re-offers the ref.** Given a ref whose last row rests on a
  PR, when `buildFilerInput` runs, then: if the PR is open the ref stays settled
  and is asked about again next run; if it merged the ref stays settled for good;
  if it closed unmerged (or the number is no PR: a 404) the queue record is
  offered again, ahead of new records and within the batch of 20, with
  `rests_on_pr_closed` and the earlier reason in `repeat`. Identical re-offered
  records collapse as in spec 019 AC-1, and one decision settles them all. The
  new decision is applied like any other, including the privacy of a security
  record, and its rows carry `reoffered: true`.
- AC-10. **GitHub calls are bounded.** One input build asks about each PR once
  and about at most 20 distinct PRs, oldest discard first; the rest wait for a
  later run. A merge is recorded (`rests_on_pr_state: merged` on an appended
  row), so it is never asked about again. Any error but a 404 is logged
  (`filer-pr-check-failed`), leaves the ref settled for that run and fails
  nothing.
- AC-11. **Nothing is re-offered forever.** A ref is re-offered at most twice.
  Given a later discard of it resting on a PR that also closes unmerged, then a
  row with `rests_on_pr_state: reoffer_limit` is appended, `filer-reoffer-limit`
  is logged, and the ref stays settled and is not asked about again.

### The event debounce

- AC-12. **Routine events wait; the schedule does not.** A parameter
  `standing.event_debounce` (duration, default `6h`, `0m` to `30d`, `auto`) is
  defined in `agents/parameters.yaml` and read each tick. Given an agent whose
  pending events are all `finding_queued` and whose `last_run` ended less than
  that long ago, when the scheduler ticks, then the agent starts no run and its
  pending events are kept. Given the interval has passed, or `next_run` has
  passed, or the agent has no `last_run`, then it is due as before.
- AC-13. **Urgent events do not wait.** Given any other event pending
  (`issue_abandoned`, `capability_answered`, `merge`, `maintainer_reply`,
  `ci_failure_main`, `infra_alarm`, `credential_expiry`), alone or beside
  `finding_queued`, then the agent is due at once and the run clears all it
  received. `run_agent` works through `next_run` and is not affected.
- AC-14. **Failure handling is unchanged.** Given `failures` is 1, then the
  retry of spec 008 AC-3 starts at the next tick whatever is pending. An agent's
  own failure finding still does not reach its `pending_events` (spec 020 AC-1).
  After a second failure `last_run` is that failure, so a foreign `finding_queued`
  is delivered and waits out the interval; a foreign urgent event still starts it
  at once. A quota postponement (spec 013 AC-7) is unchanged and still wins.
- AC-15. **Abandonment handling is unchanged.** `issue_abandoned` wakes the filer
  at once, and `capability_answered` still retries held findings at once (spec
  014 AC-8). The abandoned list and its seven-day rule are not touched.

## 4. Amendments to earlier specs

- **The wake rule.** Design section 6.1 lists "new records in the findings queue"
  as what wakes the filer, and spec 008 AC-3 has an agent due when `pending_events`
  is not empty. This spec adjusts that rule: `finding_queued` still wakes the
  filer, no later than one debounce interval after its last run (AC-12); every
  other event wakes it as before.
- Spec 020 AC-2 ("an event from outside the filer arrives ... then the filer is
  started as usual"): a foreign `finding_queued` waits out the debounce (AC-14).
- Spec 008 AC-3: a first attempt ending `result: invalid` gets a repair turn
  before it counts as a failure (AC-3 to AC-5).
- Spec 008 AC-11: adds `standing.event_debounce`.
- Spec 008 AC-16: a `discard` may carry `rests_on_pr`. A result in a recorded
  shape is put right before validation (AC-2).
- Spec 008 AC-19 and spec 014 AC-2: a discard resting on a PR that closes unmerged
  is offered again (AC-9), at most twice (AC-11).

## 5. Design notes (agent's calls)

- **Normalise in the runner.** Validation happens in `runStage`, which is what
  decides `result: invalid`, so the shapes are put right just before it, for
  `filer-result` only. `applyFilerResult` validates again and checks the batch
  (every ref once, outcome allowed for the ref) before any effect; a normalised
  result has the same refs and outcomes, so those checks are unaffected.
- **The placeholder is limited to issue-carrying outcomes.** The issue's title
  and body hold the substance of such a decision. On a discard or a close the
  reason is the whole decision (process-spec 4.2: "recorded with reason"), and on
  a retry it instructs the next attempt, so inventing one would lose the finding
  silently; those stay invalid and go to the repair turn.
- **Repair on the first attempt only.** A repair on each attempt would make four
  runs per wake. Tracking "one repair per wake" would add agent state for little:
  the cost is a run that failed for another reason and then returned bad JSON,
  which AC-1 and AC-2 make rare. The cap of 5 turns keeps a repair to rewriting JSON;
  a resumed session needs none.
- **Only `finding_queued` is debounced.** It is the one event produced in bulk and
  the one whose queue record survives without the event (spec 020 section 5: the
  queue carries the record, the event is only a wake). The others are rare and
  say something needs an answer: spec 014 AC-8 promises held findings are retried
  at once, and an abandoned issue waits on its re-triage.
- **The interval runs from the end of the last run,** whatever woke it and however
  it ended, so a failing agent is also held. `last_run` is already kept.
- **A backlog drains as it did.** A run takes 20 records, and with no new event
  the next is at the schedule (`1d`). The debounce only limits wakes from new
  findings, to about four a day by default; the parameter lowers it.
- **A final answer goes on a triage row** rather than a new state file: the log is
  already the filer's record, the last row per ref is already what counts, and the
  row keeps its original `at` so the 30-day repeat window does not move.
- **A 404 counts as closed.** The model cited something that is not a PR, so the
  discard rests on nothing; offering it again is the safe side and is bounded by
  AC-11.
- **Schemas are edited by hand.** `AGENTS.md` calls `schemas/` generated, but no
  generator exists for `schemas/scheduler/`; these files are the source.

## 6. Interfaces and files

- `agents/standing/findings-filer.md`: AC-1, AC-7, AC-9.
- `agents/parameters.yaml`: `standing.event_debounce`.
- `schemas/scheduler/filer-result.json`: `rests_on_pr`, on a discard only.
- `schemas/scheduler/triage-entry.json`: `rests_on_pr`, `rests_on_pr_state`,
  `reoffered`.
- `tools/scheduler/src/filer/normalize.ts`: `normalizeFilerResult`.
- `tools/scheduler/src/runner/run.ts`: calls it before validation; `normalised`
  in `outcome.json`.
- `tools/scheduler/src/standing/run.ts`: the repair turn.
- `tools/scheduler/src/standing/state.ts`: `eventsWake`, `DEBOUNCED_EVENTS`.
- `tools/scheduler/src/service/loop.ts`: uses `eventsWake` in the due check.
- `tools/scheduler/src/filer/input.ts`: `discardsToReoffer`, `isRestingDiscard`,
  `PR_CHECKS`, `REOFFER_LIMIT`, `QueueRecord.rests_on_pr_closed`.
- `tools/scheduler/src/filer/apply.ts`: keeps `rests_on_pr`, applies a re-offered
  decision and settles its copies.
- `tools/scheduler/test/filer-results.test.ts`,
  `tools/scheduler/test/standing-wakes.test.ts`, and the spec 020 test in
  `tools/scheduler/test/e2e.test.ts`.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `docs/delivery-system-design.md` are sensitive
paths; the security review applies (spec 006 AC-9).
Nothing here changes the sensitive-path list or the security criteria. A re-offered
security record stays private through the existing checks in `applyDecisions`.

## 7. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean.
- The tests of the new behaviour fail on `main`.
- Live check after deploy: the next filer run's `outcome.json` ends `ok`, with
  `normalised` absent or naming what was changed; in `log/service.jsonl` a
  `standing-repair` line is followed by a `-repair` run directory; between
  scheduled runs, filer runs are at least six hours apart unless an urgent event
  is in that run's `input.json`.

## 8. Open decisions

None.
