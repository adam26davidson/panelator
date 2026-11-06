# 045. A standing agent waits out a network outage; it is not the agent's failure

Status: written 2026-11-06 from the delivery-system design for issue #78;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (standing agents: the registry, their schedule and events, the
findings filer) and section 10 ("Small work skips layers": a bug spec hangs
directly off a top design);
[015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md), whose
reading that the bounds count failures of the work and not of the
infrastructure, and whose definition of a *transient error*, backoff, alarm
and ceiling (AC-4, AC-5, AC-8, AC-13) this spec applies to standing agents;
[013-quota-planning](../013-quota-planning/spec.md) AC-7, the quota
postponement whose `postponed_until` this spec reuses and leaves as it is;
[008-agent-registry](../008-agent-registry/spec.md) AC-3, which this spec
amends (marked as section 4 records); and
[020-failure-finding-does-not-wake-its-agent](../020-failure-finding-does-not-wake-its-agent/spec.md)
AC-1, whose list of what is not a failure this spec amends (marked as section
4 records).

## 1. Goal

A standing agent whose run, or whose runner step around the run, fails because
the network is down waits with backoff and tries again. Nothing about the
agent or its input was wrong, so the attempt counts toward no failure, writes
no failure finding and sends no notification.

### What is wrong today

`tools/scheduler/src/standing/run.ts` has one path out of a failed attempt
that is not a failure: a judgement with `apiErrorStatus` 429, which spec 013
AC-7 postpones to the limit's reset through `postpone(...)`. Every other
error, whether the run's judgement (the `throw` after the 429 check) or an
error thrown around the run (building the filer's input from GitHub, `git
worktree add` from `origin/main`, applying the result), reaches the `catch`,
is logged as `standing-error`, and counts: the first attempt sets `failures`
to 1, the second writes the `standing agent <name> failed twice` finding to
the queue and sends the notification, as spec 008 AC-3 says a failure should.

Observed live (`log/service.jsonl`, `findings/queue.jsonl` record ref 320,
run `standing-findings-filer-2-1793204966244`):

- 2026-10-28 16:36: the Claude harness could not reach the API. Its stream
  carried eleven `api_retry` records with `error_status: null`, then a
  `result` whose text was `API Error: Can't reach the API server — check your
  internet or DNS (EAI_AGAIN)`; the adapter judged the run `failed` with that
  reason and `apiErrorStatus` 0 (`Number(null)`). It was the second attempt,
  so the queue gained a `failed twice` record with that text as its evidence
  and the maintainer was notified.
- 2026-10-28 18:07: `standing-error` for the filer with `read EHOSTUNREACH`,
  a socket error from a GitHub call around the run, counted the same way.

Spec 015 fixed the same thing for the chain: a driver step that fails on a
transient infrastructure error postpones the chain with backoff and counts
toward no bound, with one alarm after two hours and a ceiling after a day.
Its section 2 left "network failures inside an agent's own run" to the
adapter and said nothing about standing agents, and spec 013 AC-7 covers the
rate limit only. Spec 020 stopped the failure finding from waking the agent
that produced it, so the loop is gone, but the count, the record and the
notification are still produced for an outage.

### The fix

The standing runner classifies a failed attempt the way the service loop
classifies a failed driver step (spec 015 AC-4, `transientCause`). A
transient failure postpones the agent: `postponed_until` is set to a backoff
after now, the agent's state records the outage, and `failures`, the pending
events and `next_run` stay as they are. A run that ends `ok`, or a genuine
failure, ends the outage. An outage two hours old raises one alarm; an outage
a day old stops being transient and its failures count as genuine, so a
failure that only looks like the network's cannot retry for ever.

*(agent's call)* The spec reuses spec 015's classifier, backoff and constants
rather than defining a second set for standing agents: the two are the same
judgement about the same infrastructure, and one definition of "transient"
keeps the chain and the standing agents from disagreeing about a given error.
A transient failure gets no fallback run on another model (the retry and
fallback rules act on a 429 only, as today): the cause is not the model. The
change adds one classification step to one runner and two optional fields to
one state file, cheap to reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- The quota postponement of spec 013 AC-7 (a 429, or a blocked model when the
  agent is due): unchanged, and checked before this spec's classification.
  A 429 is never transient here.
- A chain stage run whose harness cannot reach the API. Spec 015 section 2
  leaves it to the adapter's judgement and the chain's retry rules; this spec
  changes nothing in `chain/driver.ts` or `runner/retry.ts`. It is recorded
  as a finding of this spec's PR, not fixed here.
- Keeping a finished run's result across a transient error in the steps after
  the run (applying a filer result, an action's GitHub call). The attempt is
  postponed and the next attempt is a fresh run, as a failed attempt's retry
  is today; the filer's input is rebuilt from the queue cursor (spec 008
  AC-15, spec 014), so no record is lost. Spec 015 AC-10 does this for the
  chain; a standing run is cheaper than a stage and the postponement already
  bounds how often it repeats.
- The filer's repeat marking (spec 008 AC-19), which matches a record to an
  earlier discard by `what` and `where` only, so a `failed twice` record for
  one cause inherits the reason written for another. Recorded as a finding.
- Rewriting `findings/queue.jsonl` or the agent state files by hand; the
  record of 2026-10-28 stays for the filer to decide.
- The `transient-outage` handling of claims in `service/loop.ts` (spec 015
  AC-5 to AC-13): unchanged. A standing agent's outage is kept on the agent's
  state, not on a claim, and raises its own alarm (AC-5); the two are not
  merged.
- The prompts, inputs, bounds or decisions of any standing agent.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the standing
world of `tools/scheduler/test/helpers/e2e-routes.ts` (`standingWorld`), as
spec 020's tests do. *Transient error* is spec 015's definition (its section
3, "Definitions"), as `transientCause` in `tools/scheduler/src/chain/transient.ts`
implements it. The *outage* of an agent is the record of its consecutive
transient failures, kept in its state file (AC-2).

- AC-1. **Classification.** A failed attempt of a standing agent is
  *transient* when either holds, and *genuine* otherwise:
  - the run's judgement has outcome `failed`, its `apiErrorStatus` is `null`
    or from 500 to 599, and either `apiErrorStatus` is from 500 to 599 or
    `transientCause(new Error(reason))` is not `null`;
  - an error thrown around the run (building the input, the `git worktree
    add`, validating the input, applying a filer result, appending the
    findings, applying an action) has `transientCause(error)` not `null`.
  `transientCause` additionally recognises the Claude harness's connection
  message `Can't reach the API server` (any case, with or without a code in
  parentheses after it) as a transient label, as it recognises git's
  messages. The Claude adapter reports `apiErrorStatus` `null`, not 0, when
  the result has no `api_error_status` and the last `api_retry` record's
  `error_status` is `null`. A judgement with `apiErrorStatus` 429 takes spec
  013 AC-7's path before this classification and is never transient; one
  with any other status from 400 to 499 is genuine whatever its reason says
  (an invalid API key, a bad request); `result: invalid`, `exit <n>`, `max
  turns reached` and `max budget reached` are genuine. Tests cover each
  class: the live reason `API Error: Can't reach the API server — check your
  internet or DNS (EAI_AGAIN)` with `apiErrorStatus` `null` (transient,
  label `EAI_AGAIN`), the same message without a code (transient, the
  message as label), `read EHOSTUNREACH` thrown by the mocked GitHub client
  (transient), a judgement with `apiErrorStatus` 529 and reason `overloaded`
  (transient, `HTTP 529`), a judgement with `apiErrorStatus` 401 whose reason
  names `ECONNRESET` (genuine), a 429 (spec 013's path, asserted by the
  existing tests), `exit 1` (genuine) and a GitHub 404 thrown while applying
  a filer result (genuine).
- AC-2. **A transient failure postpones the agent and counts nothing.** Given
  a due standing agent whose attempt fails transiently, then its state gets
  `postponed_until` set to now plus `outageBackoffS(count)` (60 s, doubling
  per consecutive transient failure, capped at 1800 s, spec 015 AC-5) and
  `outage: { since, count, last, alarmed }` with `count` one more than
  before (`since` and `alarmed: false` set by the first failure), `last` the
  error's message; `failures`, `pending_events`, `next_run` and `last_run`
  are unchanged; `running` is cleared and a fresh worktree is removed as
  today; no run directory beyond the attempt's own is created; nothing is
  appended to `findings/queue.jsonl`; no notification is sent. The tick does
  not start the agent before `postponed_until`, whatever events arrive
  (the skip spec 013 AC-7 already makes), and when it starts the agent after
  `postponed_until` the attempt number is `failures + 1` as today, so a
  transient failure never makes an attempt the second one. Given the agent
  had `failures` 1 when the transient failure happened (its first attempt
  failed genuinely), then `failures` stays 1 and the retry after
  `postponed_until` is the second attempt as today.
- AC-3. **Logged as an outage, not an error.** A transient failure writes
  `{ kind: "standing-postponed", agent, error }` to the service log, as a
  quota postponement writes today, with `error` ending `; postponed until
  <postponed_until>`; it writes no `standing-error` line. The first transient
  failure of an outage also writes `{ kind: "standing-outage", agent, cause,
  error }` before it, where `cause` is the label `transientCause` returned;
  later failures of the same outage write no `standing-outage` line.
- AC-4. **The outage ends with the next real outcome.** Given an agent with
  an outage whose next attempt ends `ok`, then the result is applied as
  today, the state's `outage` is removed, and the service log gets
  `{ kind: "standing-outage-over", agent, since, failures }` with `failures`
  the outage's `count`. Given its next attempt fails genuinely, then the
  outage is removed and the same line written, and the failure counts as
  spec 008 AC-3 says: `failures` 1 after a first attempt, the finding and the
  notification after a second. Transient failures between genuine ones
  neither count nor reset `failures`.
- AC-5. Amended by [050-infra-alarm-kind-and-aws-cap-zero](../050-infra-alarm-kind-and-aws-cap-zero/spec.md) AC-2: the `infra_alarm` payload gains `kind: "network_outage"`. **A long outage raises one alarm.** Given a transient failure whose
  outage's `since` is `OUTAGE_ALARM_MS` (two hours, spec 015 AC-8) or more
  before now and `alarmed` false, then the runner sets `alarmed` true, logs
  `{ kind: "standing-outage-alarm", agent, since, failures, cause }`, appends
  one finding to the queue (`what: "network outage blocks standing agent
  <name>"`, `where: "agents/standing/<name>.md"`, `evidence` naming the
  count, `since`, the cause and the last error, `noticed_how: "standing run
  transient error"`), excluding the agent itself from the `finding_queued`
  delivery as spec 020 AC-1 excludes the failure finding's agent, sends one
  notification (gate `infra`, label `<name>:outage`) and emits one
  `infra_alarm` event with `{ agent, since, failures, cause }` when the event
  emitter is configured. Later failures of the same outage raise nothing
  more. The alarm is per agent per outage: two agents in the same outage each
  raise one.
- AC-6. **An outage has a ceiling.** Given a transient failure whose outage's
  `since` is `OUTAGE_CEILING_MS` (24 hours, spec 015 AC-13) or more before
  now, then the failure is recorded in `outage.past_ceiling: { since,
  failures }`. Failures past the ceiling count as genuine only from the one
  that makes at least `CEILING_MIN_FAILURES` (3) spanning at least
  `CEILING_MIN_SPAN_MS` (30 minutes), so a laptop that slept through the day
  does not count its first failure after waking. From then on the outage
  stays on the state with `ceiling: true`, the backoff still applies, and
  each transient failure takes spec 008 AC-3's failure path with the error
  prefixed `outage past ceiling: `: the first sets `failures` 1 and
  `postponed_until`; the second writes `last_run` with outcome `failed`, the
  `failed twice` finding (its evidence carrying the prefix) and the
  notification, schedules `next_run` and clears the events, as today. The
  first counted failure logs `{ kind: "standing-outage-ceiling", agent,
  since, failures, cause }`. A run that ends `ok` removes the outage,
  `ceiling` included (AC-4).
- AC-7. **Live cases end to end.** Recorded standing worlds drive and assert:
  - the findings filer's run fails with the live reason of AC-1 twice, then
    succeeds: after the first failure `failures` is 0, `postponed_until` is
    60 s ahead, the queue is empty and no notification was sent; a tick
    before `postponed_until` starts nothing; after the second, `postponed_until`
    is 120 s ahead and `outage.count` is 2; the third attempt (after the
    wait) runs, is applied, and leaves no `outage`; the service log holds one
    `standing-outage`, two `standing-postponed`, one `standing-outage-over`
    and no `standing-error` for the filer;
  - the filer's input build fails on the mocked GitHub rejecting with `read
    EHOSTUNREACH` once, then succeeds: the same postponement, no run
    directory for the failed attempt beyond what the runner writes today, no
    finding, no notification;
  - the operator agent fails genuinely once, then transiently once, then
    genuinely once: `failures` 1 after the first, still 1 with
    `postponed_until` after the second, and the `failed twice` finding and
    notification after the third, with `outage` removed;
  - an outage whose `since` is set two hours back: the next transient failure
    writes one alarm finding, one `infra` notification and one
    `standing-outage-alarm` line, and a further failure writes none;
  - an outage whose `since` is set a day back and `past_ceiling` holding two
    failures 30 minutes apart: the next transient failure counts (`failures`
    1, `ceiling: true`, the ceiling line), and the one after it writes the
    `failed twice` finding whose evidence starts `outage past ceiling: `.
  The existing test "retries a failed standing run once and then records one
  finding and notification" and the spec 020 tests pass unchanged: `exit 1`
  is genuine.

## 4. Amendments to earlier specs

- Spec 008 AC-3 is marked `Amended by
  [045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
  AC-2`: "Given it fails, then it is retried once at the next tick; a second
  failure writes ..." counts genuine failures only. An attempt that fails on
  a transient infrastructure error (AC-1 here) postpones the agent with
  backoff and counts toward nothing (AC-2), until its outage passes the
  ceiling (AC-6). The text of AC-3 stays as the record, with the notes spec
  013 and spec 025 left on it.
- Spec 020 AC-1 is marked `Amended by
  [045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
  AC-2`: its "any failure that is not a quota postponement under spec 013
  AC-7" also excludes a transient-outage postponement under this spec. The
  exclusion of the producing agent from the `finding_queued` delivery is
  unchanged and is what AC-5 here uses for the alarm finding.

Spec 013 AC-7 is not amended: a 429 still takes its path first, and the
`postponed_until` semantics it defines (the tick skips the agent, whatever
events arrive; the field is cleared when the run starts) are what this spec
relies on. Spec 015 is not amended: its section 2 scoped the chain spec and
left standing agents unmentioned; this spec applies its definitions to them.

## 5. Interfaces and files

- `tools/scheduler/src/chain/transient.ts`: `transientCause` gains the Claude
  harness's connection message (`Can't reach the API server`) among the
  messages it labels (AC-1); `transientRun(judgement)` (new) returns the
  label for a transient judgement as AC-1 defines it, `null` otherwise, and
  is the one place that reads `apiErrorStatus` for this purpose.
  `outageBackoffS`, `OUTAGE_ALARM_MS`, `OUTAGE_CEILING_MS`,
  `CEILING_MIN_FAILURES`, `CEILING_MIN_SPAN_MS` and `PAST_CEILING` are
  reused, not duplicated.
- `tools/scheduler/src/adapters/claude.ts`: `judge` reports `apiErrorStatus`
  `null` when the last `api_retry` record's `error_status` is `null` or not
  a number (AC-1); `tools/scheduler/test/adapters-claude.test.ts` pins it
  with a stream of `api_retry` records whose `error_status` is `null`.
- `tools/scheduler/src/standing/state.ts`: `AgentState` gains the optional
  `outage: { since, count, last, alarmed, past_ceiling?, ceiling? }` (AC-2,
  AC-5, AC-6). `schemas/scheduler/agent-state.json` gains the optional
  `outage` property with that shape (`additionalProperties` stays true).
- `tools/scheduler/src/standing/run.ts`: after the 429 check and before the
  attempt is treated as failed, a transient judgement (AC-1) and, in the
  `catch`, a transient thrown error take the outage path: the state write
  of AC-2, the lines of AC-3, the alarm of AC-5 and the ceiling of AC-6; a
  run that ends `ok` or fails genuinely removes `outage` and writes the AC-4
  line before the existing failure handling runs. The quota `postpone`
  helper and everything spec 013 AC-7 does are unchanged. The alarm finding
  uses `appendFindings` with `exclude: def.name` (spec 020) and the
  `infra_alarm` emit uses `d.emitEvent` when present.
- `tools/scheduler/src/service/loop.ts`: no change; its `postponed_until`
  skip (spec 013 AC-7) covers the new postponement.
- `tools/scheduler/test/helpers/e2e-routes.ts`: the scripted adapter gains a
  script value for a transient failure (an exit code the fake `judge` maps
  to outcome `failed`, the live reason of AC-1 and `apiErrorStatus` `null`),
  beside `RATE_LIMITED`.
- Tests: `tools/scheduler/test/transient.test.ts` (AC-1's classification and
  the new message), `adapters-claude.test.ts` (AC-1's `null`),
  `e2e.test.ts` (AC-2 to AC-7, beside "retries a failed standing run once
  and then records one finding and notification").
- `specs/008-agent-registry/spec.md` AC-3 and
  `specs/020-failure-finding-does-not-wake-its-agent/spec.md` AC-1: the
  marks of section 4.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `schemas/` and `docs/delivery-system-design.md` are
sensitive paths; the security review applies to the implementation PR (spec
006 AC-9). Nothing here changes the sensitive-path list, the security
criteria, or what routes a sensitive diff to the security review. No
parameter, stage prompt, standing definition or action changes.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The first AC-7 test fails on `main` before the change (the second
  transient failure writes the `failed twice` record and the notification)
  and passes after it. The existing standing failure tests pass without
  edits.
- A grep of `tools/scheduler/src/standing/run.ts` shows `standing-error`
  written only for an attempt the classification found genuine.
- Live check after deploy: in `log/service.jsonl`, the next connection or
  DNS failure of a standing run is followed by `standing-outage` and
  `standing-postponed` lines, no `standing-error`, no `failed twice` record
  in `findings/queue.jsonl` and no notification; the agent's state file
  shows `outage` and `postponed_until`, and both are gone after the next
  `ok` run.

## 7. Open decisions

None.
