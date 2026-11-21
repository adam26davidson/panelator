# 104. A pending self-restart is downtime: a claim the scheduler does not resume meanwhile is never judged stalled

Status: written 2026-11-21 by hand in an interactive session for issue #412
(the scheduler stopped meanwhile; the issue labelled `blocked` as a manual
claim); a bug spec under the delivery-system design needs no maintainer
approval (design section 11). Amends
[100-host-outage-pauses-scheduler](../100-host-outage-pauses-scheduler/spec.md)
AC-6 (the downtime log gains the reason `restart`), marked as section 4
records.
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain's bounds count failures of the work);
[ADR 0015](../../docs/decisions/0015-host-outage-pauses-scheduler.md) (only
an issue's own failures spend its bounds); spec 100 AC-6 and AC-7 (liveness,
verify pending and an outage's age count running time only, through the
downtime log); [001-scheduler-core](../001-scheduler-core/spec.md) AC-17 (a
merge that changes `tools/scheduler/` or `agents/` sets a pending restart,
after which the tick resumes and claims nothing).

## 1. Goal

A claim that is waiting (on its checks, an outage's retry, a slot) is moved
on only when a tick resumes it, and resuming it is what writes its activity.
With a self-restart pending, the tick resumes nothing, while another chain
running stage to stage can hold the restart off for hours (#370). Today the
liveness loop still runs in that tick, before the early return, so the
waiting claim's two-hour window runs out although nothing looked at it: on
2026-11-21 issue #254's PR #402 waited on CI from 11:45 to 13:51 with no
poll, was released by liveness, closed, and the issue began again from plan.
The time also counts against spec 006 AC-17's verify-pending window and an
outage's age after the restart.

The fix treats a pending restart like a stop, which spec 100 already makes
downtime: the interval in which the scheduler works no inactive claim.

## 2. Out of scope

Shortening the pending interval itself (stopping a chain drive at the next
stage boundary when a restart is pending) is #370's. Active chains keep
running as today.

Accepted limits: the `restart` interval also covers time in which an active
chain was still working, so a window measured from inside it (an outage's
age, a verify `pendingSince` of a chain that was polling) is discounted too;
the error only delays a release or an escalation, never brings one early.
`host.json`'s schema is closed, so a rollback of this spec while a restart is
pending (or with `restart` entries in the log) makes the older reader reject
the file and start from an empty host state, as for any schema growth.

## 3. Acceptance criteria

- AC-1. **The moment is kept.** When the tick sets the pending restart, the
  host monitor's `markRestartPending()` writes `restart_pending_since` (now)
  into `host.json`; a later call keeps the first value. A failed write is
  logged as an `error` line and does not stop the tick. Test: the field
  holds the first tick's time after a second tick an hour later.
- AC-2. **The next process records it as downtime.** On the first tick of a
  process, `startupGap` turns a `restart_pending_since` into a downtime
  interval `{ from: restart_pending_since, to: now, reason: "restart" }`
  with a `{ kind: "downtime", from, to, ms, reason: "restart" }` log line,
  and removes the field, before its existing `stopped` rule (the two may
  overlap; `downtimeBetween` counts the union once). Liveness, verify
  pending and an outage's age then subtract it through spec 100 AC-6 and
  AC-7 unchanged. Tests: a claim in `verify` last active 3 h ago, with a
  2 h 55 min pending restart before a 30 s gap, is resumed and not released;
  the same claim without the field is released (control); the unit test
  checks the interval, the log line and the cleared field.
- AC-3. **No liveness expiry while pending.** While a restart is pending,
  the tick does not run the liveness loop (neither expiry nor the stale-claim
  drop); the claims are judged by the next process, with AC-2's interval.
  Test: a claim in `verify` last active 3 h ago, on the tick that sets the
  pending restart and on a tick an hour later, is neither started nor
  released and logs no `stale-claim`.

## 4. Amendments to earlier specs

- Spec 100 AC-6 is marked `Amended by [104] AC-2`: the reasons are `host`,
  `sleep`, `stopped` and `restart`.

## 5. Interfaces and files

- `tools/scheduler/src/service/host.ts`: `DowntimeReason` gains `restart`;
  `HostState.restart_pending_since?`; `HostMonitor.markRestartPending()`;
  `startupGap` (AC-1, AC-2).
- `schemas/scheduler/host.json`: the optional `restart_pending_since`
  (date-time) and the `restart` reason.
- `tools/scheduler/src/service/loop.ts`: the freshness step calls
  `markRestartPending()` (AC-1); the liveness loop is skipped while a restart
  is pending (AC-3).
- Tests: `tools/scheduler/test/host.test.ts` (AC-1, AC-2),
  `tools/scheduler/test/loop.test.ts` (AC-2, AC-3, in spec 100's block).
