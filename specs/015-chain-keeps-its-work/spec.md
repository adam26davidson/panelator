# 015. The chain keeps its work through postponements and network outages

Status: written 2026-10-29 from the delivery-system design for issues #35 and
#29; specs derived from that design need no maintainer approval (design
section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain with no human stops: bounds count failures of the
work, not of the infrastructure) and section 6.1 (infra health is woken by
alarms); [001-scheduler-core](../001-scheduler-core/spec.md) AC-25 (a
postponed stage waits with the claim held);
[005-keep-unpushed-commits](../005-keep-unpushed-commits/spec.md) AC-3;
[006-no-human-stops](../006-no-human-stops/spec.md) C7 and AC-7 (chain
errors); amends 005 AC-3 and 006 C7 as section 4 records.

## 1. Goal

Two ways the chain loses work, or spends the bounds that protect it, for
reasons that are not a defect of the work.

### What happens today (spec agent's reading of the code and the live log, 2026-10-29)

**Issue #35, a postponed retry drops its own rebase.** With a PR bound,
`runAgentStage` syncs the worktree to the PR's remote head and then rebases
it onto `origin/main` before every review or fix run. When the run is
postponed (spec 001 AC-25) the rebased commits are never pushed. Thirty
minutes later the retry's `syncWorktree` finds the local head diverged from
the remote head, resets to the remote and saves the local head as a
`dropped` patch (spec 005 AC-3), then rebases again. Live on 2026-10-28,
issue #15 (PR #34): from 13:33 to 16:38 every retry logged `worktree-synced
... dropped: <sha>` and saved an identical 258 kB patch, and the same
happened again from 18:18 to 21:25: fifteen patches, each a copy of the PR's
own commits rebased. The same drop happens after any successful review,
which never pushes: the next `verify` syncs back to the remote head. Nothing
is lost, but the patches directory fills with copies and the log says work
was discarded when none was.

**Issue #29, a network outage spends the chain-error budget.** When a
driver step throws, the service loop counts a chain failure; after
`MAX_CHAIN_FAILURES` (3) in a row it raises `chain_error`, which releases
the claim and, the second time (`MAX_CHAIN_ERRORS` = 1), abandons the
issue. On 2026-10-28 06:56 to 07:55 the laptop's resolver failed
intermittently (`getaddrinfo EAI_AGAIN api.github.com`, `git fetch ...
Could not resolve host: github.com`); issue #13 was released through the
chain-error path and its ledger now holds `chainErrors: 1` for an error that
was the network's, so one more blip abandons it. A release also costs the
work: the re-claim starts with no PR bound, so the next stage's preparation
(spec 006 AC-21) closes the open PR and deletes its branch. Two more losses
follow from the same throw: a stage whose run finished but whose result
could not be turned into an event (a GitHub call in the PR binding check
failed) is run again from scratch on the next step, and an outage longer
than `liveness_hours` (2) lets the liveness check release the claim once the
network is back, as nothing touched the claim meanwhile.

### After this spec

- A run that ends without a result leaves the worktree where the
  preparation found it: the driver's own rebase is undone. A dropped head
  whose commits are all, change for change, already on the remote head (the
  remote head rebased) is not saved as a patch.
- A driver step that fails on a transient infrastructure error (DNS, a
  refused, reset or timed-out connection, a GitHub 5xx, a git transport
  failure with one of these causes) is retried with backoff. It counts
  neither toward `MAX_CHAIN_FAILURES` nor `MAX_CHAIN_ERRORS`, keeps the
  claim alive, is logged once per outage, and after two hours raises one
  notification, one finding and one `infra_alarm` event. Genuine errors
  still count as today.
- A stage run that finished with a result is recorded on the claim before
  its result is checked, so a step that then fails retries the check, not
  the run.
- A chain-error release recorded for a transient cause before this spec is
  not counted when the issue is next claimed (this restores #13).

## 2. Out of scope

- Rate limits of any kind: the model provider's quota (spec 001 AC-25 to
  AC-27) and GitHub's primary and secondary rate limits (HTTP 403 or 429
  with a rate-limit message). Spec 013 plans quota and rate-limit retries;
  this spec classifies a GitHub rate-limit response as a genuine error, as
  today.
- Network failures inside an agent's own run (the harness losing its API
  connection, the agent's `git push` failing). They end the run as a failed
  or rate-limited outcome, judged by the adapter as today.
- Errors outside a chain's driver step: the tick's freshness fetch, the
  shortlist's issue list and the paused-issue handling already log the
  error and try again on the next tick without counting anything.
- Replaying saved patches, and pruning the patches #35 already wrote.
- Slot accounting: a claim waiting out an outage holds its slot exactly as
  a postponed (`waiting`) claim does under spec 009 and the slot-scheduling
  spec; this spec changes neither.
- Changing which stages are rebased or when (spec 001 C1, AC-16).

## 3. Acceptance criteria

"Given" states use the fake harness, a mocked GitHub API and the repo-pair
setup of the driver tests, as in spec 005.

**Definitions.** A *transient error* is an error whose message, `code`,
`status` or `cause` chain shows one of: the DNS codes `EAI_AGAIN`,
`ENOTFOUND`; the socket codes `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`,
`ETIMEDOUT`, `EPIPE`, `ENETUNREACH`, `ENETDOWN`, `EHOSTUNREACH`, undici's
`UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET`, `UND_ERR_HEADERS_TIMEOUT`;
`socket hang up`; an HTTP status from 500 to 599; or the git transport
messages `Could not resolve host`, `Could not resolve hostname`, `Temporary
failure in name resolution`, `Connection timed out`, `Connection reset`,
`Failed to connect to`, `The remote end hung up unexpectedly`, `early EOF`,
`RPC failed` and `The requested URL returned error: 5xx`. Anything else,
a GitHub 4xx (rate limits included) among it, is *genuine*. The *outage* of
a claim is the record of its consecutive transient failures.

### Postponed runs and rebased heads (#35)

- AC-1. **A run without a result undoes the driver's rebase.** Given a
  claim with a PR bound whose remote head is behind a moved `origin/main`,
  when a review, fix or implement run is prepared (the rebase moves `HEAD`)
  and the run ends without an `ok` outcome (postponed on a rate limit, or
  failed), and the worktree's `HEAD` is still the commit the rebase made and
  the tree is clean, then the driver resets the branch to the head it had
  before the rebase and logs `{ kind: "rebase-undone", issue, stage, from,
  to }`. Given the run moved `HEAD` or left uncommitted changes, nothing is
  undone.
- AC-2. **The retry drops nothing.** Given AC-1's postponed run, when the
  stage is retried after the wait, then the preparation's sync finds the
  worktree at the remote head: no `worktree-synced` record with a `dropped`
  head and no `dropped` patch. Repeated postponements write no patch at all
  (the regression test drives three).
- AC-3. **A rebased head is not saved as dropped work.** Given a claim with
  a PR bound whose worktree head is the remote head rebased onto
  `origin/main` (no commit of its own beyond the remote head's commits, each
  equal by `git patch-id` to one of them), when the next stage is prepared
  and the sync drops that head, then no patch is written and the
  `worktree-synced` record carries `patch: null` and `rebased: true`. Given
  the dropped head carries a commit whose change is not on the remote head
  (with or without a rebase), the patch is saved as spec 005 AC-3 says and
  the record carries `rebased: false`.

### Transient infrastructure failures (#29)

- AC-4. **Classification.** `transientCause(error)` returns a short label
  for a transient error (the code, `HTTP <status>` or the matched git
  message) and `null` for a genuine one, looking through `cause` up to five
  levels deep. Tests cover each class with a mocked error: Node's DNS error
  (`code: "EAI_AGAIN"`), Octokit's wrapped fetch failure (`status: 500`,
  message `getaddrinfo EAI_AGAIN api.github.com`, `cause.cause.code`), a
  GitHub 502 and 503, an `ECONNRESET` socket error, `socket hang up`, a
  failed `git fetch` (`Could not resolve host: github.com`), a failed `git
  ls-remote` over SSH (`Could not resolve hostname`), and as genuine: a
  GitHub 404 and 422, a 403 and a 429 with a rate-limit message, a `git`
  merge conflict and a plain `TypeError`.
- AC-5. **A transient step failure postpones the chain.** Given a running
  chain whose driver step throws a transient error, when the service loop
  handles the rejection, then the claim's `chainFailures` and the ledger are
  unchanged, the claim carries `outage: { since, count, last, retry_at,
  alarmed }` with `count` one more than before and `retry_at` the backoff
  after now, `last_activity_at` is set to now, and the chain is not started
  again before `retry_at`. The backoff is 60 s doubling per consecutive
  transient failure, capped at 1800 s (`POSTPONE_WAIT_S`).
- AC-6. **Logged once per outage.** The first transient failure of an
  outage writes `{ kind: "transient-outage", issue, cause, error }` to the
  service log; later failures in the same outage write nothing. The next
  step that returns, or that fails on a genuine error, clears the outage and
  writes `{ kind: "transient-outage-over", issue, since, failures }`.
- AC-7. **A genuine error still counts.** Given a claim with an outage
  whose next step fails on a genuine error, then the outage is cleared and
  `chainFailures` counts the genuine error as today; after
  `MAX_CHAIN_FAILURES` genuine failures in a row the `chain_error` event is
  raised as spec 006 C7 says. Transient failures between genuine ones
  neither count nor reset the count.
- AC-8. **A long outage raises one alarm.** Given an outage whose `since`
  is two hours or more before a transient failure and `alarmed` false, then
  the loop sets `alarmed`, logs `{ kind: "transient-outage-alarm", issue,
  since, failures, cause }`, appends one finding (`what: "network outage
  blocks the chain"`, `noticed_how: "scheduler transient error"`), sends one
  notification (gate `infra`) and emits one `infra_alarm` event with `{
  issue, since, failures, cause }` when the event registry is configured.
  Later failures of the same outage raise nothing more.
- AC-9. **Liveness waits for the outage.** Given a claim with an outage
  whose last transient failure was within `liveness_hours`, the liveness
  check does not expire it (AC-5 keeps `last_activity_at` fresh).
- AC-10. **A finished run is not run again.** Given a stage run that ends
  `ok`, then before its result is checked the claim records `stageRun: {
  stage, attempt, run_id, result, start, security, sensitive }` on disk.
  Given the step then throws (a transient error in the PR binding check),
  when the stage is stepped again, then no agent runs, the worktree is not
  synced or rebased, the driver logs `{ kind: "stage-result-kept", issue,
  stage, run_id }`, and the recorded result is checked and turned into its
  event as if the run had just ended. Every transition clears `stageRun`;
  a `stageRun` of another stage or attempt is ignored and cleared.
- AC-11. **Earlier transient chain errors are forgiven.** Given an issue
  ledger whose history holds `chain error in <stage>: <message>` entries
  with a transient message, when the issue is claimed, then `chainErrors`
  is lowered by the number of those entries (not below 0), each entry is
  rewritten to `chain error in <stage> (transient, not counted): <message>`
  so it is forgiven once, the ledger is written, and the service log carries
  `{ kind: "chain-errors-forgiven", issue, forgiven }`. A genuine chain
  error entry is left as it is.
- AC-12. **End to end.** Recorded end-to-end chains (fake adapter, mocked
  GitHub) drive and assert:
  - review postponed three times on a PR whose base moved, then run:
    no `dropped` patch, no `worktree-synced` record with a dropped head, and
    the review sees the rebased head;
  - a chain whose GitHub calls fail with `EAI_AGAIN` for four steps in a
    row, then recover: no `chain_error`, no release, the PR still open and
    bound, the chain merges, and the service log has one `transient-outage`
    and one `transient-outage-over`;
  - the same chain with a genuine error thrown three times: `chain_error`
    and a release, as today.

## 4. Amendments to earlier specs

This spec's PR may not edit other specs (spec 006 AC-21 scope), so the
readings below are recorded here; the earlier text stands with these
exceptions.

- **Spec 005 AC-3.** "a patch of the commits reachable from the dropped
  local head but not from the remote head is written" applies when the
  dropped head carries a change the remote head lacks; a dropped head that
  is the remote head rebased writes no patch (AC-3 above), and the record
  gains the `rebased` field.
- **Spec 006 C7 and AC-7.** "a chain whose driveChain rejects this many
  times in a row" counts genuine errors only; a transient error postpones
  the chain (AC-5 above). The ledger's `chainErrors` excludes chain-error
  releases recorded for a transient cause (AC-11).
- **Spec 001 AC-15** (a stage run is not repeated after a crash between its
  end and the transition): extended to a step that throws after the run
  (AC-10 above).

## 5. Interfaces and files

- `tools/scheduler/src/chain/transient.ts` (new): `transientCause(error)`,
  `outageBackoffS(count)`, `OUTAGE_ALARM_MS`, `forgiveTransientChainErrors
  (ledger)`.
- `tools/scheduler/src/runner/worktree.ts`: `onlyRebased(worktree, dropped,
  remote, base)`.
- `tools/scheduler/src/chain/driver.ts`: `syncWorktree` uses `onlyRebased`
  (AC-3); `runAgentStage` undoes its rebase after a run without a result
  (AC-1), records `stageRun` and resumes from it (AC-10); `step` clears
  `stageRun`.
- `tools/scheduler/src/state/claims.ts`: the optional `stageRun` and
  `outage` fields of `Claim`.
- `schemas/scheduler/claim.json`: the `stageRun` and `outage` properties.
- `tools/scheduler/src/service/loop.ts`: the rejection handler classifies
  the error (AC-5 to AC-8); the tick skips a claim before its `retry_at`;
  the claim path forgives transient chain errors (AC-11).
- Tests: `tools/scheduler/test/transient.test.ts` (new, AC-4, AC-11),
  `worktree.test.ts` (AC-3's helper), `driver.test.ts` (AC-1 to AC-3,
  AC-10), `loop.test.ts` (AC-5 to AC-9, AC-11), `e2e.test.ts` (AC-12).

`tools/scheduler/` is a sensitive path; the security review applies (spec
006 AC-9).

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean.
- The AC-2 driver test fails on `main` before the change (it finds a
  `dropped` patch per retry), and the loop test for AC-5 fails on `main`
  (the transient error counts as a chain failure).
- Live check after deploy: the next postponed review on a PR whose base
  moved writes no `dropped` patch; the next resolver failure logs one
  `transient-outage` per affected claim and no `chain-error`; #13's ledger
  shows `chainErrors: 0` after its next claim.

## 7. Open decisions
