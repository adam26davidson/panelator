# 053. An implement run stopped before it finished keeps its work for the next attempt

Status: written 2026-11-12 from the delivery-system design for issue #106;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the rescue is "one more attempt on the strongest model with the
full history"; after it fails "the issue is planned again from scratch"),
section 13 (the precise rescue, re-plan and spec-revision bounds are left to
the builder) and section 10 ("Small work skips layers");
[ADR 0010](../../docs/decisions/0010-incomplete-implement-run-keeps-its-work.md),
which records the decision and the options it rejects. It builds on the held
work of [011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
and [040-held-work-per-branch](../040-held-work-per-branch/spec.md), and
marks spec 011 AC-7, AC-8 and AC-10, spec 040 AC-3 and AC-4, and
[006-no-human-stops](../006-no-human-stops/spec.md) AC-21's paragraph "A
branch left by a failed attempt", as section 4 records; consistent with
[005-keep-unpushed-commits](../005-keep-unpushed-commits/spec.md) (every
discard still saves a patch).

## 1. Goal

When an implement run is stopped before it returns a result (its budget,
turn or time bound, a session limit the fallback did not absorb, a harness
that ended without a result event), the commits it left on `issue-<n>` are
the next attempt's starting point, not a failed attempt's leftovers. The
retry and the rescue continue from them; the re-plan still starts from
scratch, as the design says. No bound and no counter changes.

### What happens today (spec agent's reading of the code, 2026-11-12)

`runAgentStage` in `tools/scheduler/src/chain/driver.ts` turns every run
whose outcome is not `ok` into `stage_failed`. The machine
(`tools/scheduler/src/chain/machine.ts`) retries implement once
(`implementFailures`), then `escalate` clears `heldWork` and reruns it as a
rescue, then re-plans. Before each of those runs `syncWorktree` finds no
hold on the branch, saves its commits as a `recovered-commits` patch, drops
the branch on origin with its open PRs (`stale-branch-dropped`) and resets
it to `origin/main`. Issue #38 (spec 029) lost four runs of work this way
before a re-plan's run fit within one bound (ADR 0010).

The runner already tells the two kinds of failure apart: the adapter's
judgement says whether the harness stopped the run (`bounds`, `timeout`,
`failed`), and a run the harness finished but whose result file is missing
or invalid becomes `failed` with reason `result: invalid` only afterwards
(`tools/scheduler/src/runner/run.ts`).

## 2. Out of scope

- Changing any bound (`agents/stages/implement.md`, `scheduler.yaml`), any
  failure counter, or the order retry, rescue, re-plan, spec revision,
  abandonment (spec 006 AC-1 to AC-5).
- Keeping work across a re-plan, a spec revision, an abandonment, a release
  or a chain error. The design re-plans "from scratch"; these keep today's
  rules.
- A run that returned a result the chain rejects: a missing or invalid
  result file, a failed gate, scope or binding check. It is a wrong attempt
  and starts clean as today.
- Uncommitted changes a stopped run leaves. They are saved as a patch and
  discarded as spec 005 says; the implement prompt asks for a commit after
  each task (AC-6).
- Plan, fix, review, spec and design runs that stop early. The fix stage
  works on a bound PR whose pushed head spec 005 AC-3 keeps; the others are
  separate work if their runs show the same loss.
- Splitting a large spec into ordered PRs: that stays the spec stage's split
  rule.
- Replaying a saved patch (spec 005 section 2).

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.

**Definitions.** An *incomplete run* is an implement run whose adapter
judgement, before the result file is read, is not `ok` (outcome `bounds`,
`timeout` or `failed`), outside a conversation turn. A run whose judgement
is `ok` and whose result is missing, invalid or rejected is not incomplete.
*Carried work* is a `heldWork` entry (spec 040) on `issue-<n>` with a
`carried` field holding the incomplete run's failure reason.

- AC-1. **An incomplete run records its work.** Given an implement run with
  no PR bound that is incomplete and is not postponed (spec 013 AC-5, spec
  006 AC-27), and `issue-<n>` has commits not on `origin/main` after the
  run, when the driver turns it into `stage_failed`, then it first saves
  those commits as a patch (kind `held`, through `savePatch`), logs
  `{ kind: "held-work", issue, stage: "implement", branch, head, pushed, prs, patch, carried: <reason> }`
  as spec 011 AC-1 does, and the event carries `head`, the worktree's
  `HEAD`. Given no commits off `origin/main`, or a run that is not
  incomplete, or a postponement, then the event carries no `head` and
  nothing is logged. A `stage_failed` carrying `head` for any stage other
  than implement throws (an invalid event).
- AC-2. **The retry and the rescue continue from it.** Given an implement
  `stage_failed` carrying `head`, when the machine applies it, then the
  `issue-<n>` entry of `heldWork` is set to
  `{ branch: "issue-<n>", head, carried: <reason> }` (replacing any entry on
  that branch, a question's hold included; other entries unchanged), the
  failure is noted and counted as today, and the hold is carried into the
  next step when that step is the retry (attempt 2) or the rescue. Given
  that step is a re-plan or an abandonment, then `heldWork` is empty and the
  re-plan's run starts clean, as today. When the retry or rescue is
  prepared with no PR bound, then spec 011 AC-2 and AC-5 apply to the
  carried entry unchanged: `held-work-kept` (or `-advanced`, `-restored`,
  `-lost`), no `recovered-commits`, no `stale-branch-dropped`, the branch
  on origin and any open PR from it untouched, and `HEAD` at the carried
  head.
- AC-3. **What clears it.** Given carried work, then it is replaced by a
  later incomplete implement failure's head (AC-2), cleared by an implement
  failure without `head` that is not a postponement (the attempt is then a
  wrong one, or left nothing; a postponed retry or rescue keeps the entry
  unchanged, as spec 040 AC-3 says, and spec 011 AC-5 covers commits the
  postponed run made),
  removed when an implement result binds a PR on `issue-<n>` (spec 040
  AC-2), replaced by a question's hold on that branch (spec 011 AC-1), and
  cleared by every transition spec 040 AC-4 lists except the `escalate` to
  a rescue of AC-2. The table-driven test of spec 006 AC-27 asserts, for
  every valid pair and for the holds spec 040 AC-4 lists plus a carried
  entry on `issue-<n>`, whether each entry is carried, set, replaced or
  removed.
- AC-4. **The next run is told.** Given carried work and the worktree's
  `HEAD` at the carried head after the preparation, when implement runs,
  then its `held_work` input names the branch, the head, whether it is on
  origin and its open PRs (unknown when a lookup failed), as spec 011 AC-4
  says, and in place of that criterion's "from before the question"
  sentence says that this is the work of the stage's earlier attempt, which
  stopped before it finished (with the carried reason), and that the stage
  checks it against the plan and finishes the remaining tasks rather than
  starting again. A rescue run gets the same text. Given an open PR named
  there, then the run may report it; the binding check of spec 001 is
  unchanged.
- AC-5. **End to end.** Recorded end-to-end chains (fake adapter, mocked
  GitHub) drive and assert:
  - implement commits and pushes, then ends incomplete (a non-zero exit or a
    timeout of the fake run); the retry's worktree `HEAD` is the pushed head,
    its input carries `held_work` with the reason, there is no
    `recovered-commits` and no `stale-branch-dropped` for `issue-<n>`, and
    the PR it opens merges;
  - the same with a PR opened before the run stopped: the PR is not closed,
    and the retry reports it;
  - attempt 1 and attempt 2 both end incomplete, each adding commits; the
    rescue starts at attempt 2's head and its PR merges;
  - attempt 1, attempt 2 and the rescue all end incomplete: the re-plan runs,
    `heldWork` is empty, and the next implement starts at `origin/main` with
    the `stale-branch-dropped` record, as today;
  - implement ends with an exit-0 run whose result is missing or invalid
    after committing: the retry starts clean, with the `stale-branch-dropped`
    record. The existing test of spec 011 AC-10's last bullet scripts the
    resumed implement as a non-zero exit, which is an incomplete run, so that
    test changes: its chain now continues from the held head
    (`starts == [held.head, held.head]`, `held-work-kept`, no
    `stale-branch-dropped`, a `held_work` input), and the clean case above is
    a new test with an exit-0 run and an invalid result;
  - an incomplete run that committed nothing: the retry starts clean and no
    `held-work` record is written.
- AC-6. **The prompt says what is kept.** Given `agents/stages/implement.md`,
  then its `{{held_work}}` line reads as the work of an earlier run of this
  issue (before a question, or an attempt that stopped before it finished),
  and its instructions say to commit after each task, because only committed
  work is carried to the next attempt when a run is stopped by its bounds.
- AC-7. **Old records load.** Given a claim or paused record whose
  `heldWork` entries have no `carried` field, when it is read, then it loads
  as today (spec 040 AC-7) and those entries are question holds.

## 4. Amendments to earlier specs

Each is marked in that spec's text in this PR (spec 039).

- **Spec 011 AC-7.** An implement failure carrying `head` sets the carried
  entry instead of clearing the hold, and the `escalate` to a rescue keeps
  it (AC-2, AC-3).
- **Spec 011 AC-8.** The failed-attempt chains still start clean for a
  wrong attempt, a re-plan and a release; an implement retry or rescue after
  an incomplete run continues from its commits (AC-2).
- **Spec 011 AC-10.** Its last bullet's failure, a resumed implement that
  exits non-zero, is an incomplete run, so that chain now continues from the
  held head; a run that ends with exit 0 and a missing or invalid result
  stays clean, and AC-5 tests both.
- **Spec 040 AC-3.** An incomplete implement failure of the asking stage
  replaces the hold on `issue-<n>` with the carried entry instead of
  dropping it.
- **Spec 040 AC-4.** The `escalate` to an implement rescue after an
  incomplete failure keeps the carried entry; every other clear stands.
- **Spec 006 AC-21, "A branch left by a failed attempt."** An implement
  retry or rescue that carries an incomplete run's work is not a failed
  attempt for this rule, as spec 011 already reads it for held work.

## 5. Interfaces and files

- `tools/scheduler/src/runner/run.ts`: `StageOutcome` says whether the run
  was stopped before its result was read (the adapter's judgement was not
  `ok`), so the driver need not parse `reason`. *(agent's call: a field such
  as `stopped: boolean`; the plan may name it.)*
- `tools/scheduler/src/chain/types.ts`: `head?: string` on `stage_failed`;
  `carried?: string` on a `heldWork` entry.
- `tools/scheduler/src/chain/machine.ts`: the `stage_failed` row sets the
  carried entry for implement and throws on `head` for any other stage
  (AC-1, AC-2); `escalate` keeps the carried entry when it reruns implement
  as a rescue, and clears as today otherwise (AC-2, AC-3).
- `tools/scheduler/src/chain/driver.ts`: in `runAgentStage`, the non-`ok`
  path for an incomplete implement run saves the `held` patch, logs
  `held-work` with `carried` and puts `head` on the event (AC-1; `holdWork`
  may serve with the reason added); `heldWorkText` gives the AC-4 sentence
  for a carried entry. `syncWorktree` and `keepHeldWork` need no change.
- `schemas/scheduler/claim.json`: the optional `carried` string on a
  `heldWork` entry (AC-7).
- `agents/stages/implement.md`: the `{{held_work}}` line and the commit
  sentence of AC-6. `agents/` is a sensitive path; the security review
  checks the diff, which must not touch the bounds.
- `tools/scheduler/test/chain.test.ts`: AC-2, AC-3 in the table-driven test;
  the throw of AC-1.
- `tools/scheduler/test/driver.test.ts`: AC-1 and the preparation of AC-2 on
  the repo-pair setup (spec 011's held-work tests are the models).
- `tools/scheduler/test/e2e.test.ts`: the chains of AC-5. The chain world's
  fake run may need a way to commit and then end with a non-zero exit or a
  timeout; the plan adds it to the test helpers if they lack one.
- `tools/scheduler/test/state.test.ts` or `paused.test.ts`: AC-7.

`tools/scheduler/` and `agents/` are sensitive paths; the security review
applies (spec 006 AC-9). No other file is created or modified.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
  clean.
- The end-to-end chain of AC-5's first bullet fails on `main` before the
  change (the retry starts at `origin/main`, with `stale-branch-dropped`)
  and passes after it.
- Live check after deploy, recorded in a follow-up finding if it is not seen
  within two weeks: the next implement run that ends on a bound or a session
  limit after committing shows, in the service log, one `held-work` record
  with `carried`, then `held-work-kept` before the retry, and no
  `stale-branch-dropped` or `recovered-commits` for `issue-<n>` between them.

## 7. Open decisions

None.
