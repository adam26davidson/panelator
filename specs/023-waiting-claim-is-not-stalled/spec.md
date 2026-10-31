# 023. A waiting claim is not stalled

Status: written 2026-10-31 from the delivery-system design for a defect seen
live; specs derived from that design need no maintainer approval (design
section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a bug spec hangs directly off a top
design); [009-postponed-chain-holds-slot](../009-postponed-chain-holds-slot/spec.md)
(a `waiting` claim holds its slot, whether its `postponedUntil` has passed or
not); [015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md) AC-9
(unchanged); amends [013-quota-planning](../013-quota-planning/spec.md) AC-5
and [001-scheduler-core](../001-scheduler-core/spec.md) AC-15 as section 4
records. Each amended criterion carries a note pointing here.

## 1. Goal

A chain that waits out a quota limit keeps its claim and its work, however
long it waited and however late the scheduler gets to it.

### What happens today (observed live)

Spec 013 AC-5 exempts a `waiting` claim from liveness only while its
`postponedUntil` is in the future. A wait does not refresh
`last_activity_at`, and a tick's liveness step runs before its start step. So
the first tick after a reset releases any waiting claim last active more than
`liveness_hours` (2) ago, closes its spec or parked PR and restarts it from
plan, in the same tick that would have started it. A claim queued behind a full slot after
its reset has no exemption at all.

- Issue #15, 2026-10-31: postponed 14:57:34Z, reset 17:10Z, released
  17:10:11Z, PR #73 closed.
- Issue #15, 2026-10-31: released on the first tick after a 45.9-hour sleep.
- Issue #17, 2026-10-28: postponed 05:59:15, waiting behind a full slot,
  released 08:00:04.
- Issue #37, 2026-10-31: released at 22:10:12Z.

The test for spec 009 AC-1 hid this: it aged the claim exactly 2 hours, and
the gate's comparison is strict.

### Why every waiting claim, with no time clause

Liveness finds chains nothing is driving. Nothing is left undriven here: each
tick either starts a due `waiting` claim, or it stays queued for a running
slot, or its reset is still ahead. Starting it applies the `start` event,
which moves it to its resume stage and sets `last_activity_at`, so normal
liveness applies from there.

No clause for outages is added: a claim retrying through an outage already
refreshes its activity (spec 015 AC-5, AC-9).

## 2. Out of scope

Each of these is a residual gap, left as it is by this spec:

- **Repeated re-postponement has no time bound.** A chain whose stage is
  postponed again each time it starts stays claimed for as long as that goes
  on. Until this spec, the release at a reset ended such a chain by accident,
  at the cost section 1 describes; now only the limit lifting ends it.
- **A wrong far-future `resets_at` holds the slot** until that instant. The
  wait stays visible in the quota summary of the service log's ticks (spec
  013 AC-10). Liveness never bounded this case either (spec 013 AC-5).
- **A queued claim's wait is bounded only by the chains ahead of it.** Claims
  start in issue order, so a lower-numbered claim that keeps returning to the
  queue goes first until its chain ends.
- **A `verify` claim after a long sleep still expires,** as any stage but
  `waiting` does (AC-5). A sleep through a `verify` wait is a separate
  question.
- Restoring work the incidents above already lost.

## 3. Acceptance criteria

"Given" states use a temporary state directory and a mocked GitHub client, as
in `tools/scheduler/test/loop.test.ts`.

- AC-1. **The tick after a reset starts the claim.** Given a claim in stage
  `waiting` on the spec track with an open PR, a reset 11 seconds past and
  `last_activity_at` 2 hours 12 minutes old, when a tick runs, then the claim
  is not released, its chain starts, no PR is closed or branch deleted, no
  comment is posted and `in-progress` is kept.
- AC-2. **So does the first tick after a long sleep.** Given a claim in stage
  `waiting` whose reset passed 43 hours ago, when the first tick runs, then
  the claim is not released and its chain starts.
- AC-3. **A claim queued behind a full slot is kept.** Given `slots: 1`, a
  running chain, and a claim in stage `waiting` whose reset passed over 2
  hours ago with activity older than that, when ticks run, then it is neither
  released nor started and it still holds its slot (spec 009); given the slot
  frees, then the next tick starts it.
- AC-4. **A lost label still drops the claim.** Given a claim in stage
  `waiting`, its reset ahead or passed, whose issue no longer has
  `in-progress`, when a tick runs, then the claim is dropped as a stale claim
  and its chain does not start (spec 009 AC-6 unchanged).
- AC-5. **Other stages still expire.** Given a claim in `implement` or
  `verify` with no run in flight and activity older than `liveness_hours`,
  when a tick runs, then it is released as spec 001 AC-15 says.
- AC-6. **A stepped claim leaves `waiting`.** Given a due claim in stage
  `waiting`, when its chain takes a step, then the claim on disk is in its
  resume stage with `last_activity_at` set to that step's time; given no
  activity for `liveness_hours` after that, then a tick releases it.

## 4. Amendments to earlier specs

- **Spec 013 AC-5.** "Given a postponed claim whose `postponedUntil` is in
  the future, then the liveness step does not expire it" holds for any claim
  in stage `waiting`, whether `postponedUntil` has passed or not.
- **Spec 001 AC-15 (liveness)**, and the Liveness row of its section 8 that
  restates it. "a claimed issue with no run in flight" excludes a claim in
  stage `waiting`, which is checked only for its `in-progress` label. The
  amendment of spec 015 section 4 stands.

## 5. Interfaces and files

- `tools/scheduler/src/service/loop.ts`: `#liveness` exempts stage `waiting`
  after the stale-label check, with no test of `postponedUntil`.
- `tools/scheduler/test/loop.test.ts`: AC-1 to AC-6; the spec 009 AC-1 test
  moves its second tick past the liveness window.
- `specs/013-quota-planning/spec.md` AC-5 and
  `specs/001-scheduler-core/spec.md` AC-15: a one-line amendment note each,
  pointing to section 4.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/` and `docs/delivery-system-design.md` are sensitive paths;
the security review applies (spec 006 AC-9).

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-1, AC-2, AC-3 and AC-6 tests, and the moved spec 009 AC-1 test, fail
  on `main` (the claim is released) and pass after the change.
- Live check after deploy: a chain postponed to a reset with its last activity
  over 2 hours before it logs no `liveness` release on the first tick after the
  reset, and its next stage starts with its PR still open.

## 7. Open decisions

None.
