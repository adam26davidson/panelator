# 031. A network failure inside an agent's run is not a failed attempt

Status: written 2026-11-01 from the delivery-system design for issue #49;
specs derived from that design need no maintainer approval (design section
11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain's bounds count failures of the work: the reading
[015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md) records in
its status line) and section 10 ("Small work skips layers": a bug spec hangs
directly off a top design); extends spec 015 (transient failures of a driver
step) to the agent's own run, which spec 015 section 2 left out, and amends
its transient-error definition and
[011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
AC-4 and AC-8 as section 4 records; consistent with
[001-scheduler-core](../001-scheduler-core/spec.md) AC-21 and AC-24 and
[013-quota-planning](../013-quota-planning/spec.md) (rate limits are
untouched).

## 1. Goal

A transient network failure that happens inside an agent's own run (the
harness losing its connection to the model's API, or the agent's own
`git push` or `gh` call failing on DNS) costs the chain nothing but the wait:
no attempt, no rescue, no re-plan, and no history entry.

### What happens today (spec agent's reading of the code and the live log, 2026-11-01)

The harness adapter judges a run from its event stream (spec 001 AC-21).
When Claude Code loses the API, it retries on its own (`api_retry` events
with `error_status: null`) and then ends with a result whose `is_error` is
true and whose text is the connection error. The adapter returns
`failed`, the driver turns it into `stage_failed`, and the machine spends
the stage's attempt: a second failure escalates to a rescue, then a re-plan.
Spec 015 scoped its transient handling to errors thrown by scheduler steps
and left this case out (its section 2).

Live, on 2026-10-28 during the resolver outage (`dev-logs/2026-10-28-first-autonomous-run.md`,
#29): run `15-review-1-20261028T074610` ended at 07:54:42Z with `failed`,
reason `API Error: Can't reach the API server — check your internet or DNS
(EAI_AGAIN)`, after $1.55 of work; the service log shows `stage_failed` and
review attempt 2 starting at 07:56. The same stream carried four
`api_retry` events with `error_status: null, error: "unknown"`. Two runs
that succeeded (`15-plan-1-20261031T141551`, `39-spec-1-20261101T092316`)
carried the same retry events, so the retries alone tell nothing; only the
end of the run does.

The second case has no live instance yet: an agent whose `git push -u origin
HEAD` or `gh pr create` fails on DNS ends its run with a result the driver
cannot bind (`result: pr mismatch` for implement and fix; the spec and
design tracks' PR checks likewise), which is also a failed attempt, and the
next preparation drops the unpushed commits as a failed attempt's leftovers
(spec 006 AC-21, spec 011 AC-8).

### After this spec

- A run whose failure is a transient network failure is a *transient run
  failure*. The driver treats it as spec 015 treats a transient driver step:
  the outage record, backoff, once-per-outage logging, two-hour alarm,
  24-hour ceiling and liveness rule of spec 015 AC-5 to AC-9 and AC-13 apply
  unchanged, and the stage runs again at the same attempt when the backoff
  passes.
- The commits such a run left on the chain's branch are held, as an asking
  stage's work is held (spec 011), so the retried run continues from them
  instead of starting again.
- Everything else the run produced is kept as today: its run directory,
  usage record and quota-book entry, its findings, and its stage record in
  the service log, which now names the cause.

## 2. Out of scope

- Rate limits (API status 429): spec 013 postpones them; a 429 is never a
  transient run failure here, and neither is any other 4xx.
- A run that ends `timeout`, `bounds`, or `failed` with `no result event` /
  `no agent_end event` / `spawn: ...`: the stream does not say whether the
  network was the cause, so these stay genuine failures, as today.
- An agent that answers a network failure by escalating (a `capability`
  question saying it cannot push) or by writing a result that passes the
  checks: the question check and the result checks judge those as today.
- Network failures in the harness's tool calls that the agent recovers from
  within the run (a retried push that lands): the run ends `ok` and nothing
  changes.
- The driver's own GitHub and git calls around the run (spec 015), standing
  agents (they are not chains and have no attempts), and the backoff
  schedule (spec 015 AC-5's is reused, so a mid-run drop at an outage's
  start can cost one more early-failing run a minute later; later retries
  fail at their first request, at no cost).
- Resuming the harness session of the cut-off run instead of running the
  stage afresh.
- Replaying patches, and the cost already spent by the live runs above.

## 3. Acceptance criteria

"Given" states use the fake harness, a mocked GitHub API and the repo-pair
setup of the driver tests, as in specs 005 and 015. The spec 015 definitions
(*transient error*, *outage*) apply; *transient run failure* is defined in
AC-1.

- AC-1. **Classification.** `transientRunCause(judgement, events)` of an
  adapter returns a short label (as spec 015 AC-4's `transientCause`) or
  `null`. For a judgement with outcome `failed`, it returns a label when:
  (a) `apiErrorStatus` is from 500 to 599; or (b) `apiErrorStatus` is null
  or 0 and `transientCause(new Error(reason))` is not null, where the
  spec 015 message list is extended with the harness messages `Can't reach
  the API server`, `check your internet or DNS`, `Connection error`, `fetch
  failed`, `no such host`, `error connecting to` and `i/o timeout` (section
  4); or (c) the judgement's reason starts with `result: ` (the run ended
  `ok` on the harness and failed its result check, AC-4) and the stream
  holds a *failed network tool call*: a tool call of the harness's shell
  tool (`Bash` on Claude, `bash` on pi) whose command text contains `git `
  or `gh `, whose tool result is an error (Claude: a `tool_result` with
  `is_error: true`; pi: a `tool_execution_end` with `isError: true`) and
  whose result text matches a transient error by the same rule as (b). A
  judgement with outcome `ok`, `timeout` or `bounds`, a `failed` one with
  `apiErrorStatus` from 400 to 499, and one whose reason is `no result
  event`, `no agent_end event`, `result: invalid` or starts with `spawn: `
  or `exit ` without a matching message, return `null`. Tests cover, from
  recorded streams: the live Claude stream of 2026-10-28 (`api_retry` events
  with `error_status: null`, then a result with `is_error: true` and the
  `EAI_AGAIN` text; label `EAI_AGAIN`); a Claude result with
  `api_error_status: 529`; a pi assistant message with `stopReason:
  "error"` and `errorMessage: "fetch failed"`; a Claude stream whose last
  `Bash` call is `git push -u origin HEAD` with an error result `fatal:
  unable to access ...: Could not resolve host: github.com`, judged with
  reason `result: pr mismatch`; and as null: the 429 fixture, a 401, a
  `no result event` stream, a `Read` tool result quoting `Could not resolve
  host` (a file that contains the words is not a failed call), and a
  `pnpm test` call whose failing output quotes it.
- AC-2. **A transient run failure postpones the chain, at the same
  attempt.** Given an agent stage whose run ends with a transient run
  failure, when the driver handles the outcome, then it undoes its own
  rebase as spec 015 AC-1 says, logs the `stage` record with `transient:
  <label>` beside `outcome` and `reason`, and the step fails with a
  `TransientRunError` (its `code` the label, its message the run's reason),
  which `transientCause` recognises; the service loop then records the
  outage on the claim as spec 015 AC-5 says. The claim's stage and
  `attempt` are unchanged, no `stage_failed` event is applied, the ledger
  and history gain nothing, `chainFailures` is unchanged, and `run_id` is
  null on disk. When `retry_at` passes, the next step runs the same stage
  at the same attempt (the run id carries the same attempt number). Given
  the run was a rescue run, then it stays a rescue (`rescueRun` is kept
  and the rescue bound is not spent again), as a postponed rescue does
  (spec 006 AC-27). Given the run was a fallback run (spec 001 AC-25), then
  the postponement is the same; the fallback is not spent (the next run
  starts on the primary model, as any new run of the stage does).
- AC-3. **The run's records are kept.** Given AC-2, then the run directory,
  `outcome.json` (with a `transient` field holding the label), the usage
  record of spec 001 AC-24 and the quota book's observation are written as
  for any failed run, and the run's findings are queued (spec 001 AC-28).
- AC-4. **A failed push is a transient run failure.** Given an implement,
  fix, spec or design run that ends `ok` on the harness, whose result fails
  its PR binding check (`result: pr mismatch`, or the spec and design
  tracks' equivalent reasons), and whose stream holds a failed network tool
  call (AC-1 (c)), then the driver treats the run as AC-2 says instead of
  returning `stage_failed`. Given the same result check failure without
  such a tool call, then `stage_failed` with that reason, as today.
- AC-5. **The run's commits are held.** Given AC-2 and the worktree's
  `HEAD` after the run is not the run's `start` commit, then before the
  step fails the driver holds the work as spec 011 AC-1 holds an asking
  stage's: the branch's commits not on `origin/main` are saved as a `held`
  patch, `{ kind: "held-work", ... }` is logged, and the claim's state gets
  `heldWork: { branch, head, cause: <label> }`, written to disk. Uncommitted
  changes are saved and discarded by the next preparation as today (spec
  005). Given a PR bound, then the held head is kept by the preparation as
  spec 011 AC-2 keeps a fix's held work (the sync keeps a head ahead of the
  remote head, and the driver does not rebase held work). Given no PR
  bound, then the preparation keeps the held work as spec 011 AC-2 and AC-5
  say: no `recovered-commits` patch, no stale-branch drop, no reset to
  `origin/main`. Given `HEAD` is still `start`, then nothing is held.
- AC-6. **The retried run is told.** Given held work with a `cause`, when
  the stage runs again, then its input's `held_work` text is spec 011
  AC-4's with its last line replaced by: `This is your own work from your
  earlier run of this stage, which ended on a network failure (<cause>);
  you continue from it, you do not start again. Commits not on origin are
  not yet pushed.` The rest of AC-4 (the branch, head, whether it is on
  origin, open PRs, lookup failures stated as unknown) is unchanged.
- AC-7. **Held work for a transient cause is cleared like other held
  work, plus on a genuine failure.** Given held work with a `cause`, then it
  is cleared where spec 011 AC-7 clears held work (the work is bound or
  discarded), and also when the retried stage's genuine `stage_failed` is
  applied, so the next attempt starts clean (spec 011 AC-8). Given held
  work without a `cause` (an asking stage's), nothing changes.
- AC-8. **Fake harness.** `FakeOptions` gains `transient?: string`; the fake
  adapter's `transientRunCause` returns it for a `failed` judgement and
  `null` otherwise, so the driver and end-to-end tests can drive AC-2 to
  AC-7 without a recorded stream.
- AC-9. **End to end.** Recorded end-to-end chains (fake adapter, mocked
  GitHub) drive and assert:
  - a chain whose review run fails transiently twice, then succeeds: the
    service log has two `stage` records with `transient`, one
    `transient-outage` and one `transient-outage-over`, the review's three
    run ids all carry attempt 1, the ledger's history has no `review
    attempt 1 failed` entry, no rescue runs, and the chain merges;
  - a chain whose implement run commits, then fails transiently before its
    push: the retried implement (attempt 1) finds the branch at the held
    head with `held_work` in its input, pushes it, opens the PR, and the
    chain merges; no `recovered-commits` or `stale-branch` patch is written;
  - a chain whose implement run fails genuinely after a transient failure:
    `implement attempt 1 failed` is noted once, the held work is cleared,
    and attempt 2 starts from `origin/main` as today;
  - an outage past spec 015's ceiling (AC-13) with the run still failing
    transiently: the failures count as genuine from the third past the
    ceiling, and the `chain_error` release follows as spec 015 AC-13 says.

## 4. Amendments to earlier specs

- **Spec 015 section 2** ("Network failures inside an agent's own run ...
  judged by the adapter as today") no longer holds: this spec covers them.
  Spec 015 AC-5 to AC-9 and AC-13 apply to a transient run failure exactly
  as to a transient driver step; `transientCause` (AC-4) recognises
  `TransientRunError` by its `code`.
- **Spec 015 AC-4's definition of a transient error** gains the messages
  `Can't reach the API server`, `check your internet or DNS`, `Connection
  error`, `fetch failed`, `no such host`, `error connecting to` and `i/o
  timeout`, matched whatever their case, with a test each. An HTTP status
  from 400 to 499 stays genuine whatever the message says.
- **Spec 011 AC-4**: the last line of `held_work` differs when the held
  work has a `cause` (AC-6 above). **Spec 011 AC-8**: a failed attempt
  starts clean also after held work for a transient cause (AC-7 above);
  the retry of a transient run failure is not a failed attempt and keeps
  its work (AC-5).
- **Spec 001 AC-21** stands: the adapter still records the run as failed
  with its reason; what changes is what the driver does with that failure.

## 5. Interfaces and files

- `tools/scheduler/src/adapters/types.ts`: `Adapter.transientRunCause?
  (judgement, events)`; `tools/scheduler/src/adapters/transient.ts` (new):
  the shared rule of AC-1 (`runTransientCause(judgement, events, shell)`
  where `shell` finds the harness's failed shell tool calls), used by
  `claude.ts` and `pi.ts`; `fake.ts`: the `transient` option (AC-8).
- `tools/scheduler/src/chain/transient.ts`: the added messages;
  `TransientRunError` (`code`, `cause` label).
- `tools/scheduler/src/runner/run.ts`: `StageOutcome.transient: string |
  null`, from the adapter after the result check (so AC-1 (c) sees the
  `result: ...` reason); persisted in `outcome.json`.
- `tools/scheduler/src/chain/driver.ts`: `runAgentStage` handles a
  transient outcome after the rate-limit rules of spec 001 AC-25 and spec
  013 and before the generic `stage_failed`: undo the rebase, hold the work
  (AC-5), log, throw; `heldWorkText` renders the `cause` variant (AC-6).
- `tools/scheduler/src/chain/machine.ts`: `heldWork` gains the optional
  `cause`; the `stage_failed` transition clears held work that has one
  (AC-7).
- `tools/scheduler/src/state/claims.ts` and `schemas/scheduler/claim.json`:
  the optional `cause` of `heldWork`.
- Tests: `tools/scheduler/test/adapters-claude.test.ts`,
  `adapters-pi.test.ts` and `transient.test.ts` (AC-1, section 4, with new
  fixtures under `test/fixtures/streams/`: `claude-api-unreachable.jsonl`
  taken from the live run, `claude-529.jsonl`, `claude-push-dns.jsonl`,
  `pi-connection-error.jsonl`), `run.test.ts` (AC-3), `driver.test.ts`
  (AC-2, AC-4 to AC-7), `loop.test.ts` (AC-2's outage record),
  `e2e.test.ts` (AC-9).
- `specs/015-chain-keeps-its-work/spec.md` section 2 and AC-4, and
  `specs/011-asking-stage-keeps-its-work/spec.md` AC-4 and AC-8: a one-line
  amendment note each, pointing to section 4.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `schemas/` and `docs/delivery-system-design.md` are
sensitive paths; the security review applies (spec 006 AC-9).

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean.
- The AC-2 driver test fails on `main` before the change (the chain applies
  `stage_failed` and attempt 2 runs), and the AC-1 adapter test on the live
  stream fails on `main` (no classification exists).
- Live check after deploy: the next run that ends with `Can't reach the API
  server` logs a `stage` record with `transient` and a `transient-outage`,
  no `stage_failed` transition, and the same stage runs again at the same
  attempt once the network is back.

## 7. Open decisions

None.
