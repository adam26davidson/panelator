# 085. A spec-track rescue keeps the issue branch's hold

Status: written 2026-11-19 from the delivery-system design for issue #172;
specs derived from that design need no maintainer approval (design section 11).
Amends [040-held-work-per-branch](../040-held-work-per-branch/spec.md)
section 2 and AC-4,
[011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
section 2 and AC-7, and
[053-incomplete-implement-run-keeps-its-work](../053-incomplete-implement-run-keeps-its-work/spec.md)
AC-3, each marked in this spec's PR as section 4 records (spec 039).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 ("What happens while it waits": on a reply the work "resumes where
it stopped"), section 4 (the rescue is one more attempt of the stuck stage)
and section 10 ("Small work skips layers": a bug spec hangs directly off a
top design); [040-held-work-per-branch](../040-held-work-per-branch/spec.md),
whose goal (work a stage left when it asked is kept until a PR is bound on
its branch or the attempt is discarded, on every branch at once) this spec
completes; consistent with [006-no-human-stops](../006-no-human-stops/spec.md)
AC-1 (the rescue), AC-18 (the `record` route) and AC-27 (the table-driven
test) and with [005-keep-unpushed-commits](../005-keep-unpushed-commits/spec.md)
(every discard still saves a patch).

## 1. Goal

When the spec stage, recording a maintainer's answer to an implement (or
plan) question, gets stuck and is rescued, the work implement held on
`issue-<n>` survives the rescue. The merged spec PR hands it back to plan
and implement as spec 040 AC-6 says, instead of it being dropped as a stale
branch.

### What is wrong today

Spec 006 AC-18 records a product or technical answer to an implement
question on `spec-<n>` in `record` mode while implement's pushed work waits
as a hold on `issue-<n>` (spec 011 AC-6, spec 040). When the recording
spec stage fails twice (`tools/scheduler/src/chain/machine.ts`,
`stage_failed`, case `spec`), or a question it asked fails the question
check twice (`escalateAsker`), the machine calls `escalate`. `escalate`
sets `heldWork: []` before it branches on the track, and on the spec track
reruns the stuck stage as a spec-track rescue. The rescue starts the
recording again on `spec-<n>`; it has no reason to discard `issue-<n>`, but
the hold on `issue-<n>` is gone with the rest.

After the rescued spec PR merges, the `delete_branch` action
(`tools/scheduler/src/chain/driver.ts`) finds no hold naming `issue-<n>` and
checks the branch out from `origin/main`; plan's preparation
(`syncWorktree`) finds `issue-<n>` on origin with no PR and no hold and
applies spec 006 AC-21's failed-attempt rule: the commits are saved as a
`stale-branch` patch, the branch is deleted on GitHub and implement starts
over. That is the loss spec 040 fixed for a spec-stage question, reached
through a spec-stage failure.

Spec 040 section 2 kept this out of scope, citing spec 011 section 2 ("a
rescue starts again by design"). Spec 011 was written when the chain held
work on one branch, so the work a rescue starts again and the held work
were the same thing. On the spec track in `record` mode they are not: what
starts again is the recording on `spec-<n>`.

### The fix

The escalate that reruns a stage as a spec-track rescue removes only the
hold on `spec-<n>`, the branch the rescue runs on, and carries every other
entry unchanged. Every other escalation keeps emptying the list: the
spec-track abandonment and the issue-track re-plan and spec revision
discard the attempt (the implement PR, if any, is closed), and the
issue-track rescue reruns the stage on `issue-<n>` itself (spec 053's
carried entry aside). The driver needs no change: spec 040 AC-5 and AC-6
already read the hold by branch.

*(agent's call)* The rule is stated by the branch the rescue runs on rather
than as "keep `issue-<n>`" so that a hold on `spec-<n>` (a question the
spec stage asked before the check failed twice) still starts again, as
spec 011 section 2 intends for the rescued stage's own work. The change is
one transition's effect on one field and is reversible, so it is not an ADR
(design section 3, item 2).

## 2. Out of scope

- The design track. Its rescue and its hand-over to a spec revision
  (spec 029 AC-4) still clear every hold; whether a design-track
  escalation should keep an `issue-<n>` hold is left to its own issue.
- Which transitions clear held work other than the escalate to a
  spec-track rescue: spec 040 AC-1 to AC-4, as amended by spec 053, stand.
- The driver's preparation, the `delete_branch` action, the `held_work`
  stage input and the `held-work*` log records: unchanged (spec 040 AC-5,
  AC-6).
- Spec 006 section 4's table: no row is added or removed.
- The stage prompts under `agents/` and the schemas under `schemas/`:
  unchanged.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
*Holds*, *the hold on a branch* and *the chain's branch* mean what spec 040
section 3 says. A *spec-track rescue* is the `escalate` step that reruns the
stuck stage with `specRescues` raised by one and the track set to `spec`
(spec 006 AC-1 on the spec track).

- AC-1. **A spec-track rescue removes the `spec-<n>` hold only.** Given any
  holds, when an `escalate` transition reruns a stage as a spec-track
  rescue (whatever led to it: the spec stage's second failure in any mode,
  the question check's second failure for a question the spec stage asked,
  a failed spec-track review or fix, or the spec-present gate failing after
  a spec or design PR merged), then the new state's `heldWork` is the list
  the transition started from with the `spec-<n>` entry removed, every
  other entry unchanged and in its order, a carried entry on `issue-<n>`
  (spec 053) included.
- AC-2. **Every other escalation still clears every hold.** Given any
  holds, when an `escalate` transition abandons the issue (the spec-track
  rescue already used), reruns a stage as an issue-track rescue, re-plans,
  revises the spec from the issue track, or runs a design-track rescue or
  the design track's spec revision, then `heldWork` is as today: empty,
  except the carried entry an implement rescue keeps (spec 053 AC-2).
  `liveness_expired`, `chain_error`, every `release`, and the `done` of an
  abandonment or a split still empty it (spec 040 AC-4).
- AC-3. **The table-driven test pins it.** The table-driven test of spec
  040 AC-4 (spec 006 AC-27's pairs) asserts, for every valid pair and every
  holds variant it already uses, that a transition which raises
  `specRescues` leaves the starting holds without the `spec-1` entry, and
  that every other escalation leaves what AC-2 says. The variants with a hold on `issue-1` and the chain on
  the spec track are among those that assert a kept entry.
- AC-4. **The merged spec PR hands back the issue branch's hold.** Given a
  hold on `issue-<n>` from implement's question and a spec-track rescue
  that kept it (AC-1), when the rescued spec stage returns `revised` with a
  PR that merges, then spec 040 AC-6 applies: the `delete_branch` action
  puts the worktree on `issue-<n>` at the hold's head (`held-work-kept`),
  plan runs with `held_work` naming `issue-<n>`, and its preparation writes
  no `stale-branch-dropped` and no `recovered-commits` for `issue-<n>`.
  While the rescue is prepared on `spec-<n>`, spec 040 AC-5 applies:
  `issue-<n>` is left alone locally and on origin.
- AC-5. **End to end.** Two recorded end-to-end chains (fake adapter,
  mocked GitHub), built on spec 040 AC-8's, drive and assert:
  1. implement commits on and pushes `issue-<n>`, then asks a technical
     question; the maintainer answers; the spec stage in `record` mode
     fails twice; the spec-track rescue returns `revised` with a PR; review
     approves and the spec PR merges; plan's input carries `held_work`
     naming `issue-<n>` at implement's head; implement's worktree `HEAD` is
     that head and the PR it opens merges;
  2. the same, except that the spec stage in `record` mode commits on
     `spec-<n>` and returns a `capability` question, the question check
     fails twice, and the spec-track rescue returns `revised` with a PR.

  In both, the log carries no `stale-branch-dropped` and no
  `recovered-commits` naming `issue-<n>` between implement's question and
  its resumed run's result, the `issue-<n>` branch on the mocked origin is
  never deleted before implement's PR merges, and the run sequence shows
  exactly one spec-track rescue. The existing chains of spec 040 AC-8 and
  spec 006 AC-28 pass unchanged.

## 4. Amendments to earlier specs

Each is marked in its `spec.md` in this spec's PR (spec 039, ADR 0009); the
marks point here.

- **Spec 040 section 2.** The first bullet's "a spec-track escalation (a
  spec rescue or revision) while `issue-<n>` holds work still clears every
  hold" no longer applies to the spec-track rescue, which removes only the
  `spec-<n>` hold (AC-1). A spec revision is an issue-track escalation and
  still clears every hold (AC-2).
- **Spec 040 AC-4.** "an `escalate` transition (rescue, ...) ... then
  `heldWork` is empty" excepts the spec-track rescue (AC-1, AC-2); its
  table-driven test's oracle changes as AC-3 says.
- **Spec 011 section 2.** "Keeping work across a rescue ... which start
  again by design" applies to the rescued branch's own hold; a spec-track
  rescue keeps work held on any other branch (AC-1).
- **Spec 011 AC-7.** The bullet "every `escalate` transition" excepts the
  spec-track rescue, which clears only the hold on `spec-<n>` (AC-1).
- **Spec 053 AC-3.** A carried entry on `issue-<n>` is kept by the escalate
  to a spec-track rescue as well as by the escalate to an implement rescue
  (AC-1).

## 5. Interfaces and files

- `tools/scheduler/src/chain/machine.ts`: in `escalate`, the spec-track
  rescue's `rerun` patch sets `heldWork` to the incoming state's holds
  without the `spec-<issue>` entry; the abandonment and the other tracks'
  steps keep the cleared list. A comment on the line names this spec. No
  other function changes.
- `tools/scheduler/test/chain.test.ts`: the spec 040 AC-4 table-driven test
  ("held work is carried, set, replaced or removed per entry ...") gains
  the AC-3 oracle for a raised `specRescues`; the "held work" block gains
  machine cases for AC-1 (record mode with a hold on `issue-1`: the spec
  stage's second failure, and the question check's second failure for the
  spec stage's question with holds on `issue-1` and `spec-1`, each leaving
  `[issue-1]`) and AC-2 (the spec-track rescue already used: abandonment,
  `[]`).
- `tools/scheduler/test/e2e.test.ts`: the two chains of AC-5, beside spec
  040 AC-8's describe block.

`tools/scheduler/` is a sensitive path; the security review applies (spec
006 AC-9). No file under `agents/`, `docs/` or `schemas/` is created or
modified by the implementation. The spec PR itself adds this file, marks
spec 040, spec 011 and spec 053 as section 4 says and lists this spec under
`## Children` in `docs/delivery-system-design.md`.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
  clean.
- The machine case of AC-1 (record mode, hold on `issue-1`, the spec stage
  fails twice) fails on `main` before the change (`heldWork` is `[]`) and
  passes after it; the first end-to-end chain of AC-5 fails on `main` the
  same way (plan's input has no `held_work`; the log has
  `stale-branch-dropped` for `issue-7`).
- Live check after deploy, recorded in the PR: the next live spec-track
  rescue of a recording spec stage while `issue-<n>` holds work shows, in
  the service log, `held-work-kept` for `issue-<n>` from the
  `delete_branch` action and from plan's preparation after the spec PR
  merges, and no `stale-branch-dropped` for `issue-<n>`. If no such rescue
  occurs before the PR is reviewed, the recorded end-to-end chains of AC-5
  stand in for it, and the PR says so.

## 7. Open decisions

None.
