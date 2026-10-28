# 009. A postponed chain holds its slot

Status: written 2026-10-28 from the delivery-system design for issue #17;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 ("What happens while it waits": a paused issue releases its slot)
and section 4; [design-tree](../../docs/design-tree.md) R6.Q10 (pull on
completion into a concurrency slot); amends
[001-scheduler-core](../001-scheduler-core/spec.md) section 3 (AC-1, AC-2,
AC-5, AC-25; the decision "one issue holds one concurrency slot for its whole
chain") and keeps [006-no-human-stops](../006-no-human-stops/spec.md) AC-13
and AC-15 as they are.

## 1. Goal

Spec 001 AC-25 says a strong-tier stage that hits the API quota is
postponed "and the chain waits with the claim held". The scheduler's tick
computes its free slots from the chains running in the process, and a
postponed chain is not running: its claim sits on disk in stage `waiting`
with a `postponedUntil` time. So every tick during the wait sees a free
slot and claims the next shortlisted issue, which is then postponed too.
Observed 2026-10-27/28 with `slots: 1`: issues #10, #12, #13 and #15 held
`in-progress` claims and worktrees at once, ranking was bypassed, and a
claim could outlive its slot.

After this spec, a claim holds its slot from the moment it is written until
it is removed or its issue is paused. The number of new issues the shortlist
may claim, and the number of answered paused issues it may resume, is
`slots` minus the slots held, where a postponed (`waiting`) claim holds one.
A paused issue still holds no slot: the design says a question releases its
slot so other work continues, and spec 006 AC-13 builds on that.

## 2. Out of scope

- Releasing or re-ranking the extra claims the bug already created. They
  drain as today: each is started in turn when a running slot is free, and
  no new issue is claimed while more claims are held than `slots` allows.
- Changing how a postponed stage is resumed (the resume time, the
  `POSTPONE_WAIT_S` wait, or that resumption respects `slots`), how a chain
  is postponed (spec 001 AC-25, spec 006 AC-26 and AC-27), or when a paused
  issue takes a slot (spec 006 AC-15).
- Liveness and stale-claim handling (spec 001 section 8, spec 006 AC-7).
- The `slot` field of the claim record, which today stores the size of the
  active set at claim time rather than a slot number; nothing reads it.

## 3. Acceptance criteria

The *held* count of a tick is the number of claims in the state directory
whose issue has no paused record, after the tick's liveness step has removed
stale claims. A chain running in the process holds one through its claim
file; a `waiting` claim, whether its `postponedUntil` has passed or not,
holds one; a claim carrying a pending event or pending actions holds one. A
paused record holds none, whatever claim a crash mid-pause or mid-resume
left beside it. *Free* is `slots` minus held, never below zero.

- AC-1. **A postponed chain holds its slot.** Given `slots: 1`, a claim for
  issue A in stage `waiting` with `postponedUntil` in the future, and the
  shortlist returning an eligible issue B, when a tick runs, then B is not
  claimed, receives no label and no comment, and no claim or worktree is
  created for it. Given ticks continue until `postponedUntil` has passed,
  then A's chain is started on that tick and B is still not claimed.
- AC-2. **The slot is counted, not the running chain.** Given `slots: 2`,
  one chain running and one claim in `waiting`, when a tick runs with two
  eligible issues shortlisted, then neither is claimed. Given `slots: 2`,
  one claim in `waiting` and no chain running, then exactly one issue is
  claimed, in rank order.
- AC-3. **A paused issue holds no slot.** Given `slots: 1`, a paused record
  for issue P with no reply, and an eligible issue B shortlisted, when a
  tick runs, then B is claimed, as spec 006 AC-13 says (P stays treated as
  claimed by the shortlist and is not claimed again). Given, in addition, a
  claim file for P left by a crash mid-pause, then B is still claimed.
- AC-4. **A resume waits for a held slot too.** Given `slots: 1`, a claim in
  `waiting` whose `postponedUntil` is in the future, and a paused issue P
  whose question the maintainer has answered, when a tick runs, then P is
  not resumed on that tick and its paused record is kept; given the
  `waiting` chain later ends and frees the slot, then P is resumed before
  any shortlisted issue (spec 006 AC-15 unchanged).
- AC-5. **Over-held state drains without new claims.** Given `slots: 1` and
  three `waiting` claims whose `postponedUntil` has passed (the state the
  bug left), when ticks run, then one chain is started per free running
  slot, in the order the claims are listed, and no shortlisted issue is
  claimed until the held count is below `slots`. No claim is released or
  removed by this rule.
- AC-6. **A slot is freed when its claim goes.** Given `slots: 1` and one
  claim in `waiting`, when that claim is removed (its chain ends, its issue
  loses `in-progress` and the liveness step drops it, or its issue is
  paused) and a tick runs, then the next shortlisted issue is claimed on that
  tick.

## 4. Interfaces and files

- `tools/scheduler/src/service/loop.ts`: in `tick`, the free-slot count used
  for resumes (spec 006 AC-15) and for the shortlist's `ranked.slice(0,
  free)` is `slots` minus the held count defined in section 3 (claims on
  disk not in `pausedIssues`), in place of `slots` minus the active set's
  size. The early return when nothing is paused and nothing is free uses the
  same count. Starting a claim from disk, and resuming an answered paused
  issue into a running chain, still require a running slot (`active <
  slots`) as today. The `TickInfo` returned by `tick` and written to the
  service log gains `held: number`, so the service log shows why no issue
  was claimed. *(agent's call)*
- `tools/scheduler/test/loop.test.ts`: tests for AC-1 to AC-6 built on the
  file's `setup` helper (the "claims only as many issues as there are
  slots" and "claims two with slots: 2" tests are the models; a `waiting`
  claim is written with `writeClaim` and `initialChainState` with `stage:
  "waiting"`, `resumeStage` and `postponedUntil` set; a paused record with
  `writePaused` as the file's resume tests do).
- `specs/001-scheduler-core/spec.md` is not edited; this spec records the
  reading of AC-25 that the code must satisfy.

No other file is created or modified.

## 5. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
  clean.
- The loop tests for AC-1 to AC-6 fail on `main` before the change (AC-1,
  AC-2 and AC-4 claim or resume where they must not) and pass after it.
- Live check after deploy, recorded in the PR: with `slots: 1` and the
  claims the bug left, the service log's ticks show `held` above one and
  `claimed: []` until the held chains have drained; once one claim remains,
  a postponed chain keeps `claimed: []` for the length of its wait while the
  shortlist is non-empty.

## 6. Open decisions

None.
