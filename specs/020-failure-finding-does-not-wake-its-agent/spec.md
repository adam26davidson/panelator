# 020. A standing agent's own failure finding does not wake it

Status: written 2026-10-31 from the delivery-system design for issue #62;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (standing agents, the findings filer) and section 10 ("Small
work skips layers": a bug spec hangs directly off a top design);
[008-agent-registry](../008-agent-registry/spec.md) AC-3 (a second failure
"schedules the next run as if it had succeeded") and AC-4 (`finding_queued`
is appended to the pending events of every subscriber);
[013-quota-planning](../013-quota-planning/spec.md) AC-7 (the 429 instance of
the same loop, fixed by a postponement); closes the gap
[016-fair-slot-scheduling](../016-fair-slot-scheduling/spec.md) section 2
left open under #24 ("the self-wake through its own failure finding").
Amends 008 AC-4 as section 4 records.

## 1. Goal

A standing agent that fails twice is not run again until its schedule or an
event from outside it, whatever the failure was.

### What happens today

`tools/scheduler/src/standing/run.ts` handles a second failure as spec 008
AC-3 asks: it clears the received events, writes `next_run` one interval
ahead, appends one finding `standing agent <name> failed twice` to the
findings queue and sends one notification. The append emits
`finding_queued` (`src/state/findings.ts`, through the listener in
`src/service/loop.ts`) to every subscriber (`src/standing/events.ts`), and
the findings filer subscribes to it. So the filer's own failure finding
lands in the filer's `pending_events`, and any pending event makes an agent
due at the next tick (`loop.ts`, the standing-agent step), in spite of
`next_run`. For the filer, every failure that persists across runs is an
unbounded loop: two runs, one finding, one notification, repeat every tick.

Observed live:

- 2026-10-28 02:56 to 2026-10-29 08:48: 643 records `standing agent
  findings-filer failed twice` in `findings/queue.jsonl`, every run id an
  attempt-2 id, about 105 seconds apart; spec 016 section 1 counts 1,284
  `standing-findings-filer-*` run directories for the same loop. Those runs
  failed on a 429, which spec 013 AC-7 now turns into a postponement with no
  finding, so that instance is closed.
- 2026-10-29 12:01: a non-429 failure (`unknown issue class tooling`,
  `log/service.jsonl` lines 4804-4805) took the same path: failure finding
  appended, `finding_queued` emitted, filer due again at the next tick. It
  stopped only because the following run succeeded.

Any persistent non-429 failure takes that path today: GitHub unreachable
while the filer's input is built (`EAI_AGAIN`, as the chains saw on
2026-10-28), a result the apply step rejects, a harness or CLI error.
Spec 013 AC-7 covers the limit case only; spec 016 names the general case as
out of scope under #24, which spec 013 closed, so nothing covers it.

### The fix

The failure finding the scheduler appends about agent X is still queued
(the filer must triage it, and for the filer's own failure the next run reads
it from the queue as it reads every record) and still wakes every other
subscriber, but it is not delivered to X's own `pending_events`. The queue,
not the event, carries the record, so nothing is lost: X next runs at its
`next_run` or on an event from outside it, and that run's input includes the
record as usual.

## 2. Out of scope

- The findings a standing agent returns in a successful result (spec 008
  AC-5): they still emit `finding_queued` to every subscriber, the producer
  included. A filer that files findings of its own is woken to triage them,
  as it is today; that is bounded by the model's output, not a loop.
- Changing how a second failure sets `next_run` or clears the received
  events (spec 008 AC-3), or holding a twice-failed agent against every
  event until `next_run`: see section 5.
- The quota postponement of spec 013 AC-7, unchanged.
- Two standing agents each waking the other through their failure findings:
  only the findings filer subscribes to `finding_queued` today, and nothing
  in the registry's checks (spec 008 AC-1) is added for it.
- Rewriting `findings/queue.jsonl` or the agent state files by hand; spec
  019 drains the copies the loop queued.
- The findings filer's prompt, input or decisions (specs 008, 014, 018,
  019), unchanged.

## 3. Acceptance criteria

"Given" states use the fake harness, temporary state directories and the
mocked GitHub client of `tools/scheduler/test/e2e.test.ts` (the standing
world) and `test/standing.test.ts`.

- AC-1. **The failure finding skips its own agent.** Given a standing agent
  X subscribed to `finding_queued` whose run fails for the second time (any
  failure that is not a quota postponement under spec 013 AC-7), when the
  scheduler appends the finding `standing agent X failed twice`, then the
  record is appended to `findings/queue.jsonl` and the one notification is
  sent as before, the resulting `finding_queued` event is appended to the
  `pending_events` of every subscriber other than X, and X's `pending_events`
  holds no event from that append. X's state after the append is what spec
  008 AC-3 asks for: `failures` 0, `last_run` with outcome `failed`,
  `next_run` one schedule interval ahead (or `null` without a schedule),
  and the events it received cleared.
- AC-2. **A twice-failed agent is not due before its schedule or a foreign
  event.** Given the findings filer has just failed twice as in AC-1 and no
  other event arrives, when the scheduler ticks before `next_run`, then the
  filer is not started: no run directory, no usage record and no further
  queue record or notification. Given `next_run` then passes, or an event
  from outside the filer arrives (a `finding_queued` from a chain stage's
  findings or another agent's result, an `issue_abandoned`, a
  `capability_answered`; the events the filer subscribes to), then the filer is started as usual, and that run's
  input lists its own failure record among the unsettled records. *(Amended by
  spec 025 section 4: a foreign `finding_queued` is delivered at once but starts
  the filer only after `standing.event_debounce` has passed since its last run;
  the other events still start it at once.)*
- AC-3. **Every other subscriber is still woken.** Given a second subscriber
  to `finding_queued` (a test registry entry), when agent X's failure finding
  is appended, then that subscriber's `pending_events` gains the event with
  the same payload (`count`, `offset`) it gains today. Given the append is
  for any finding other than a failure finding (a chain stage's findings, a
  standing agent's result findings), then delivery is unchanged: every
  subscriber, the producer included, receives it (spec 008 AC-4).
- AC-4. **Delivery is still durable and deduplicated.** The exclusion
  changes nothing else about `emit`: the event is written to each receiving
  subscriber's state file before the queue append completes, a redelivered
  event with the same payload is kept once, and an unknown event name is
  still refused (spec 008 AC-4).
- AC-5. **The record is still triaged.** Given a filer run after AC-2, then
  the failure record is in its batch (spec 008 AC-15, spec 019 AC-1 for
  copies) and the filer decides it like any record. The filer stays the one
  consumer of its own failure records; nothing auto-discards them.

## 4. Amendments to earlier specs

- Spec 008 AC-4 ("it is appended to `pending_events` of every agent that
  subscribes to it"): the `finding_queued` event raised by the scheduler's
  own failure finding of spec 008 AC-3 is appended to every subscriber but
  the agent the finding names (AC-1 here). Every other emit is unchanged.
- Spec 016 section 2: the self-wake it lists as out of scope is covered here.

## 5. Design notes (agent's calls)

- **Exclude the producer rather than hold the agent.** The issue offers two
  fixes within the design: not delivering the failure finding's event to the
  agent that produced it, or holding a twice-failed agent until its
  `next_run` as spec 013 AC-7 holds a rate-limited one. The hold would make a
  twice-failed filer ignore every event for a day, including an
  `issue_abandoned` or a `capability_answered` that has nothing to do with
  the failure, and the design's reason for events (section 6.1: agents woken
  by what happens) is lost for that day. Excluding the producer removes the
  only edge that closes the loop and leaves every foreign wake as it is. A
  persistently failing agent then costs at most two runs, one finding and one
  notification per schedule interval or foreign event, which is the bound
  spec 008 AC-3 intended ("schedules the next run as if it had succeeded").
- **The queue carries the record; the event is only a wake.** That is why
  skipping the delivery loses nothing: the filer's input is built from the
  cursor over `queue.jsonl` (spec 008 AC-15, spec 014), not from its pending
  events, so its own failure record is read on its next run whatever woke it.
- **Only the scheduler's failure finding is excluded.** An agent's own result
  findings keep waking the filer, including when the filer is the producer:
  that is the ordinary path for a finding to be triaged, and a model-produced
  finding is not a loop the code can enter on its own. The rule is narrow so
  spec 008 AC-4 stays the rule for everything else.
- **The exclusion travels with the append.** `appendFindings` already lets a
  caller supply the emit it uses; the failure path in `run.ts` names the
  failed agent, and `emit` skips that one name. No event payload field is
  added, so the `{{events}}` an agent sees and the payload-based
  deduplication of spec 008 AC-4 are unchanged.

## 6. Interfaces and files

- `tools/scheduler/src/standing/events.ts`: `emit` takes an optional
  excluded agent name and skips that subscriber (AC-1, AC-3, AC-4).
- `tools/scheduler/src/chain/driver.ts` (`DriverDeps.emitEvent`) and
  `tools/scheduler/src/service/loop.ts` (the `onFindingsQueued` listener and
  the `emitEvent` default): carry the excluded name through to `emit`.
- `tools/scheduler/src/state/findings.ts`: `appendFindings` lets the caller
  name the agent to exclude when the append emits `finding_queued`; every
  existing call is unchanged.
- `tools/scheduler/src/standing/run.ts`: the second-failure append names the
  failed agent as excluded (AC-1); the result-findings append does not
  (section 2).
- `tools/scheduler/test/standing.test.ts`: `emit` with an excluded name
  delivers to every other subscriber and nothing else changes (AC-3, AC-4).
- `tools/scheduler/test/e2e.test.ts`: beside "retries a failed standing run
  once and then records one finding and notification": the findings filer
  fails twice, a tick before `next_run` starts nothing, and `next_run`
  passing or a foreign finding starts it with the failure record in its
  input (AC-1, AC-2, AC-5).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/` and `docs/delivery-system-design.md` are sensitive paths;
the security review applies (spec 006 AC-9). Nothing here changes the
sensitive-path list, the security criteria, or what routes a sensitive diff
to the security review.

## 7. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean.
- The AC-2 test fails on `main` (the filer is started at the tick after its
  second failure, with its own failure finding in `pending_events`) and
  passes after the change.
- Live check after deploy: in `log/service.jsonl`, the next
  `standing-error` for the findings filer on an attempt-2 run id is followed
  by no `findings-filer` run until its `next_run` or a foreign event, and
  `findings/queue.jsonl` gains one `failed twice` record for it, not one per
  tick.

## 8. Open decisions

None.
