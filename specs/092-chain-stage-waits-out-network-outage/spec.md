# 092. A chain stage run that cannot reach the API waits out the outage; it is not the stage's failure

Status: written 2026-11-19 from the delivery-system design for issue #189;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain's bounds count failures of the work: two attempts per
stage, a rescue, a re-plan, a spec revision) and section 10 ("Small work
skips layers": a bug spec hangs directly off a top design);
[015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md), whose
reading that the bounds count failures of the work and not of the
infrastructure, and whose transient-outage path (AC-1, AC-5 to AC-9, AC-13)
this spec applies to a stage run, amending its section 2 (marked as section
4 records);
[045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
AC-1, whose classification of a run's judgement (`transientRun`) this spec
reuses unchanged, amending its section 2 (marked as section 4 records);
[059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md)
AC-4, the host-refused run whose rejection this spec's rejection follows;
[053-incomplete-implement-run-keeps-its-work](../053-incomplete-implement-run-keeps-its-work/spec.md)
AC-1 and AC-2, the held work of an implement run stopped before its result,
which this spec keeps for a run that lost the API; and
[001-scheduler-core](../001-scheduler-core/spec.md) AC-25 to AC-27 and
[013-quota-planning](../013-quota-planning/spec.md) AC-9, the rate-limit
retry and postponement, which this spec leaves as they are.

## 1. Goal

A chain stage run whose harness lost its connection to the model API (DNS,
a refused or reset connection, a 5xx from the API) is not a failed attempt
of the stage. The driver step rejects with a transient error, so the chain
waits with spec 015's backoff, alarm and ceiling and then runs the same
attempt again. No attempt, rescue, re-plan or spec revision is spent on an
outage.

### What is wrong today (spec agent's reading of the code, 2026-11-19)

`runAgentStage` in `tools/scheduler/src/chain/driver.ts` has three ways out
of a run that did not end `ok`:

- a run the host refused (spec 059 AC-4) throws an `ENOSPC` error, which the
  service loop handles as a transient outage;
- a rate-limited run (`apiErrorStatus` 429, `rateLimited` in
  `tools/scheduler/src/runner/retry.ts`) takes a fallback or is postponed
  (spec 001 AC-25 to AC-27, spec 013 AC-9);
- every other run becomes `stage_failed`, which the machine notes as
  `<stage> attempt <n> failed: <reason>` and counts: a second failure
  escalates to the rescue, then to a re-plan or a spec revision, then to
  abandonment.

A run whose harness could not reach the API takes the third way. On
2026-10-28 a standing run (`standing-findings-filer-2-1793204966244`) ended
with the result text `API Error: Can't reach the API server — check your
internet or DNS (EAI_AGAIN)`; spec 045 made such a standing run wait out
the outage and added `transientRun` to `tools/scheduler/src/chain/transient.ts`
to recognise it, but its section 2 left the chain stage run out, and spec
015 section 2 had left "network failures inside an agent's own run" to the
adapter's judgement. A chain stage run in the same outage is judged the same
(`outcome: "failed"`, `apiErrorStatus` `null`, that reason) and counts: an
outage of a few minutes during two consecutive runs of a stage spends both
of its attempts and sends the issue to the rescue. `transientRun` is called
only from `tools/scheduler/src/standing/run.ts`.

### The fix

After a stage run, the driver asks `transientRun(judgement)`. When it
returns a label, the run is no result of the work: the driver undoes its own
rebase, keeps any commits an implement run left, logs the run, and rejects
the step with an error that `transientCause` labels the same way. The loop
then takes spec 015 AC-5's path, unchanged: the claim records the outage,
waits 60 s doubling to 1800 s, raises one alarm after two hours, and counts
the outage's failures as genuine chain failures only past its 24-hour
ceiling.

*(agent's call)* The run rejects the step, as spec 059's host-refused run
does, rather than returning a postponed `stage_failed` as a 429 does. The
429 postponement waits for a quota reset the quota book knows
(`waitAfterLimit`); an outage has no reset time, and spec 015's path already
has the backoff, the once-per-outage log, the alarm, the liveness rule and
the ceiling the chain needs, so a second outage mechanism for stage runs
would duplicate it and could disagree with it. A transient run gets no
fallback run on another model, as spec 045 decided for standing agents: the
cause is the network, not the model. `retry.ts` is unchanged: a 429 is never
transient (`transientRun` returns `null` for every 4xx), so the transient
check and the rate-limit rules never both apply to a run. The change adds
one check to one function, cheap to reverse; no ADR (design section 3,
item 2).

## 2. Out of scope

- The Claude adapter's own judgement of a connection drop (open issue #117)
  and the pi adapter's judgement of one: this spec reads the judgement as
  `transientRun` defines it and changes no adapter.
- The rate-limit rules: `rateLimited`, `retryDecision`, `afterFallback`,
  spec 001 AC-25 to AC-27 and spec 013 AC-9 are unchanged.
- The service loop's transient-outage handling (spec 015 AC-5 to AC-9,
  AC-13, spec 059 AC-4's disk alarm) and the standing runner's (spec 045):
  unchanged. A stage run's outage is the claim's outage; it is not merged
  with a standing agent's.
- A stage run that ended with another outcome (`timeout`, `bounds`,
  `max turns reached`, `exit <n>`, `result: invalid`) or a 4xx: genuine, as
  today, whatever its reason names.
- A transient failure in the steps after a run that ended `ok` (the PR
  binding check): spec 015 AC-10 already keeps the result.
- A fix or review run with a PR bound that committed before it lost the API:
  its commits are treated by the next preparation's sync exactly as after a
  failed run today (spec 005 AC-3, spec 015 AC-3).
- Rewriting the ledgers or notes of issues whose attempts an earlier outage
  counted.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the repo-pair
setup of the driver tests, as spec 015 does. A *transient run* is a stage
run whose `StageOutcome.judgement` makes `transientRun` (spec 045 AC-1,
`tools/scheduler/src/chain/transient.ts`) return a label; its *cause* is
that label.

- AC-1. **A transient run rejects the step and counts nothing.** Given a
  stage run (any agent stage, a rescue run, a resumed session or a
  conversation turn included) that spawned, whose `hostRefusal` is `null`
  and which is a transient run, then the driver:
  - undoes its own rebase (spec 015 AC-1);
  - logs `{ kind: "stage-transient", issue, stage, attempt, run_id, cause }`
    beside the usual `stage` line;
  - does not record `stageRun`, does not apply the result, emits no
    `stage_ok` and no `stage_failed` (so no note, no attempt, no rescue, no
    re-plan, no spec revision, no question check);
  - runs no fallback, whatever the stage's `fallback`, `independent` and
    tier;
  - leaves `resumeSession` on the claim as it was before the run, so the
    retry resumes the same session;
  - writes the claim and rejects the step with an error whose message is
    `run <run_id> could not reach the model API: <reason>` and which
    carries `status: <apiErrorStatus>` when that status is from 500 to 599,
    so that `transientCause(error)` returns the run's cause.
  The usage record and `outcome.json` are written as today (the tokens were
  spent). The loop then takes spec 015 AC-5's path: `chainFailures`, the
  ledger, `state.attempt` and `state.rescueRun` are unchanged, the claim
  carries `outage` with the backoff, and the chain is not stepped again
  before `retry_at`. Given the run is retried after `retry_at` and ends
  `ok`, then the outage ends (`transient-outage-over`, spec 015 AC-6) and
  the result is applied as the attempt's own; given it fails genuinely, then
  it counts as that attempt's failure, as today.
- AC-2. **The order of the checks.** The transient check comes after the
  host-refused rejection (spec 059 AC-4) and before `retryDecision`, and it
  is applied to the fallback run too, after that run's host-refused check
  and before `afterFallback`. A run with `apiErrorStatus` 429 takes the
  rate-limit rules as today. A conversation turn's worktree check comes
  first: a turn that changed the worktree is restored and fails with
  `conversation: worktree changed` as today, whatever its judgement; a turn
  that changed nothing and is a transient run takes AC-1, so the
  conversation's single retry (`retried`) is not spent.
- AC-3. **An implement run keeps its commits.** Given a transient implement
  run with no PR bound that left commits on `issue-<n>` not on
  `origin/main`, then before the rejection the driver keeps them as spec 053
  AC-1 does for a failed run (the `held` patch and the `held-work` log line
  with `carried` the run's reason) and sets the `issue-<n>` entry of the
  claim's `heldWork` to `{ branch: "issue-<n>", head, carried: <reason> }`
  as spec 053 AC-2's transition does (replacing any entry on that branch,
  other entries unchanged), written with the claim. The retry after
  `retry_at` is prepared from that hold (spec 011 AC-2 and AC-5): no
  `recovered-commits`, no `stale-branch-dropped`, `HEAD` at the held head.
  Given no commits off `origin/main`, nothing is held and `heldWork` is
  unchanged.
- AC-4. **Genuine runs are unchanged.** A run with outcome `failed` whose
  `apiErrorStatus` is a 4xx (a 401 whose reason names `ECONNRESET`
  included), or `null` with a reason naming no transient cause (`exit 1`),
  and a run with outcome `timeout` or `bounds`, become `stage_failed` as
  today; no `stage-transient` line is written.
- AC-5. **The outage is bounded.** A stage whose runs keep failing
  transiently is bounded by spec 015 AC-13 unchanged: past the 24-hour
  ceiling, with at least three failures spanning 30 minutes, each rejection
  counts as a chain failure prefixed `outage past ceiling: `, and after
  `MAX_CHAIN_FAILURES` the `chain_error` release follows. The two-hour alarm
  of spec 015 AC-8 (`network outage blocks the chain`, gate `infra`,
  `infra_alarm` with `kind: "network_outage"`) is raised once per outage.
- AC-6. **End to end.** Recorded end-to-end chains (the scripted adapter's
  `NETWORK_DOWN` value, mocked GitHub) drive and assert:
  - implement fails with `NETWORK_DOWN` twice, then succeeds: no `implement
    attempt` note in the state, `attempt` 1 and no rescue on the run that
    succeeds, the claim's `outage.count` 1 then 2 with `retry_at` 60 s then
    120 s ahead, no step before `retry_at`, one `transient-outage`, two
    `stage-transient` and one `transient-outage-over` line, no `chain-error`,
    and the chain goes on to review;
  - review on a stage definition with an independent fallback fails with
    `NETWORK_DOWN` once: no fallback run is started, and the next review run
    after `retry_at` is on the stage's own model;
  - a rescue run fails with `NETWORK_DOWN` once, then succeeds: the run
    after `retry_at` is still the rescue (`rescueRun` true, the rescue
    model), and no re-plan happens;
  - implement commits on `issue-<n>` and then ends with `NETWORK_DOWN`: the
    `held-work` line, the claim's `heldWork` entry, and on the retry
    `held-work-kept` (or `-restored`) with no `recovered-commits` patch;
  - a conversation turn ends with `NETWORK_DOWN` once, then settles: the
    conversation's `retried` stays false after the first turn and the
    settled decision is recorded as today.
  The existing tests of spec 015 AC-12, spec 059 and the rate-limit
  fallback and postponement tests pass unchanged.

## 4. Amendments to earlier specs

- Spec 015 section 2 is marked `Amended by
  [092-chain-stage-waits-out-network-outage](../092-chain-stage-waits-out-network-outage/spec.md)
  AC-1`: its bullet "Network failures inside an agent's own run" no longer
  leaves a run whose judgement is transient (the harness losing its API
  connection) to the adapter's judgement and the chain's attempt rules; such
  a run rejects the driver step as a transient error. An agent's own `git
  push` failing stays as that bullet says.
- Spec 045 section 2 is marked `Amended by
  [092-chain-stage-waits-out-network-outage](../092-chain-stage-waits-out-network-outage/spec.md)
  AC-1`: its bullet on a chain stage run whose harness cannot reach the API
  is the finding this spec fixes, through `transientRun` in
  `chain/driver.ts`; `runner/retry.ts` stays unchanged.

Spec 053 AC-1 to AC-3 are not amended: a transient run is no `stage_failed`,
and AC-3 here keeps its commits the way those criteria keep a failed run's.
Spec 006's bounds are not amended: they count `stage_failed` events, and a
transient run produces none, as spec 059's host-refused run does not.

## 5. Interfaces and files

- `tools/scheduler/src/chain/driver.ts`: `runAgentStage` gains a rejection
  for a transient run beside `rejectHostRefused` (AC-1), called after it for
  the first run and the fallback run and, for a conversation turn, after the
  worktree check (AC-2); it undoes the rebase, keeps an implement run's
  commits (AC-3, through `holdWork` and a `heldWork` entry written with the
  claim), restores `resumeSession`, logs `stage-transient` and throws. It
  imports `transientRun` from `./transient.ts`.
- `tools/scheduler/src/chain/transient.ts`: no change; `transientRun`'s doc
  comment names the chain stage run as a caller.
- `tools/scheduler/src/runner/retry.ts`, `tools/scheduler/src/service/loop.ts`,
  `tools/scheduler/src/chain/machine.ts`: no change.
- `tools/scheduler/test/helpers/e2e-routes.ts`: when the scripted adapter
  cannot yet express a run that commits and then ends with `NETWORK_DOWN`,
  a script function may return `NETWORK_DOWN` after its git work.
- Tests: `tools/scheduler/test/driver.test.ts` (AC-1 to AC-4: the
  rejection, its error's `transientCause`, the undone rebase, the held work,
  the kept `resumeSession`, no fallback, a 429 and the genuine cases
  unchanged), `tools/scheduler/test/e2e.test.ts` (AC-5's alarm and AC-6).
- `specs/015-chain-keeps-its-work/spec.md` and
  `specs/045-standing-agent-waits-out-network-outage/spec.md` section 2: the
  marks of section 4.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/` is a sensitive path; the security review applies to the
implementation PR (spec 006 AC-9). Nothing here changes the sensitive-path
list, the security criteria, or what routes a sensitive diff to the
security review. No parameter, stage prompt, stage definition or schema
changes.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The first AC-6 test fails on `main` before the change (the second
  `NETWORK_DOWN` run escalates implement to the rescue) and passes after it.
- A grep of `tools/scheduler/src/chain/driver.ts` shows `transientRun`
  called on every run before `retryDecision` and `afterFallback`.
- Live check after deploy: in `log/service.jsonl`, the next connection or
  DNS failure during a stage run is followed by `stage-transient` and
  `transient-outage` lines, no `<stage> attempt <n> failed` note for it in
  the claim's state, and the same attempt running again after the outage.

## 7. Open decisions

None.
