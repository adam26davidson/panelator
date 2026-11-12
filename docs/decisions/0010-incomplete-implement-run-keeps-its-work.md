# 0010. An implement run stopped before it finished keeps its work for the next attempt

Status: accepted
Date: 2026-11-12
Amends: [specs/011-asking-stage-keeps-its-work](../../specs/011-asking-stage-keeps-its-work/spec.md)
AC-7, AC-8 and AC-10, [specs/040-held-work-per-branch](../../specs/040-held-work-per-branch/spec.md)
AC-3 and AC-4, and [specs/006-no-human-stops](../../specs/006-no-human-stops/spec.md)
AC-21 ("A branch left by a failed attempt")
Decided by: the spec stage of issue #106 (an agent's call: a technical
decision about the chain's own retries that one PR reverses, with one option
that dominates the others on spend; delivery-system design section 3 and
process-spec 4.2 step 3); carried by
[specs/053-incomplete-implement-run-keeps-its-work](../../specs/053-incomplete-implement-run-keeps-its-work/spec.md)

## Context

The implement stage runs under one bound for every issue
(`agents/stages/implement.md`: 90 minutes, 300 turns, $10). When a run hits a
bound, or its harness stops it (a session limit the fallback did not absorb,
a process that ended without a result event), the chain counts a failed
attempt. The next preparation saves the branch's commits as a patch, drops
the branch on origin and starts the retry from `origin/main` (spec 006 AC-21,
spec 011 AC-8). So does the rescue after a second failure (spec 011 AC-7,
spec 040 AC-4: every `escalate` clears the held work).

A spec whose work needs more than one bound therefore fails the same way on
every attempt. Issue #38 (spec 029, about 5000 added lines) spent four
implement runs that way: "no result event", the session limit twice, "max
budget reached" on attempt and rescue. Each one started from `origin/main`;
only the re-plan's run fit and landed (PR #104). About three bounds of work
were discarded as patches nobody replays.

The delivery-system design leaves the precise rescue, re-plan and
spec-revision bounds to the builder (section 13). It fixes two things this
decision must keep: a rescue is "one more attempt on the strongest model
with the full history", and when the rescue fails "the PR is closed and its
branch saved as a patch, and the issue is planned again from scratch"
(section 4).

The findings filer offered three options:

1. Carry the commits of a run that stopped before finishing into the retry,
   as held work.
2. Scale the implement bound by issue class or plan size.
3. Require the plan stage to split a spec that exceeds one bound into
   ordered PRs.

## Decision

Option 1, for the implement stage. A run whose harness stopped it before it
returned a result (a bound, the timeout, or a harness failure: the adapter's
judgement is not `ok`) is an incomplete run, not a wrong one. Its commits on
`issue-<n>` become held work (spec 011's mechanism, spec 040's per-branch
list), and the retry and the rescue continue from them, told so in their
input. A run that returned a result the chain rejects (a missing or invalid
result file, a failed gate or binding check) is a wrong attempt and starts
clean as today. The re-plan, the spec revision, the abandonment and every
release still discard the work, as the design says. No bound and no counter
changes.

## Reasons

- **It costs nothing more.** The attempts the chain already allows (two runs
  and a rescue before a re-plan) now add up instead of repeating. Option 2
  raises the spend of every failed attempt, and the spend is the
  maintainer's subscriptions (charter, design section 5); it still discards
  the work of a run that misses the larger bound.
- **It covers every way a run stops early.** Two of issue #38's four
  failures were session limits, which no budget figure and no split
  prevents. Option 3 predicts cost before the work starts, which nothing in
  the chain measures; and splitting large work is already the spec stage's
  rule ("A split" in its prompt), the stage that owns the breakdown, not the
  plan stage's.
- **It reuses tested machinery.** Specs 011 and 040 already keep a branch,
  its push and its open PR across stages, restore it when a worktree is lost,
  save a patch when it is held, and tell the next run where it stands. This
  decision adds one more reason to hold, not a new path.
- **The design's backstop stays.** If carried work is itself the trouble,
  the rescue sees the whole history and the re-plan still starts from
  scratch, so no chain loops on bad work longer than today.

## Consequences

- Work a stopped run left uncommitted is still saved as a patch and
  discarded (spec 005); the implement prompt tells the stage to commit after
  each task, since only committed work is carried.
- Plan, fix, spec and design runs that stop early keep today's rules. The fix
  stage already works on a bound PR whose pushed head is kept; extending the
  rule to the others is separate work if their runs show the same pattern.
- Option 2 stays open as a tuning of bounds, which the design leaves to the
  builder, if carried runs still fail to land.
