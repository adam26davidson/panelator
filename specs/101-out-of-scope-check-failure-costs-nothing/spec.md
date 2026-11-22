# 101. A required-check failure outside a spec PR's scope costs the issue nothing: the re-run works, the block returns what the failure spent, and the Telegram test waits on what it asserts

Status: written 2026-11-21 from the delivery-system design for issue #252;
specs derived from that design need no maintainer approval (design section 11).
Amends [060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
AC-3 (the re-run's mechanism and the once-per-head rule), AC-6 (what the
block returns) and AC-9 (`fixes` and the rescue after a block), with marks on
those three criteria in this PR.
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the bounds count failures of the work; "Bounds still apply", counted
per issue as chain configuration) and section 10 ("Small work skips layers": a
bug spec hangs directly off a top design);
[060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
(the route this spec repairs: AC-3's re-run, AC-6's verdict and block, AC-8's
resume, AC-9's "nothing is counted or lost");
[033-rerun-workflow-permission](../033-rerun-workflow-permission/spec.md) and
[ADR 0006](../../docs/decisions/0006-app-actions-write-for-rerun-workflow.md)
(the App's `actions: write`, proved on a workflow run; the permission this
spec's re-run uses), with
[079-rerun-proof-spares-head-run](../079-rerun-proof-spares-head-run/spec.md)
(how such a proof is made without sinking the PR's head);
[006-no-human-stops](../006-no-human-stops/spec.md) AC-5 (the spec-track
rescue) and AC-6 (the bounds are constants of the chain module);
[015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md) (the bounds
count failures of the work, not of the world);
[024-rebase-respects-merged-main](../024-rebase-respects-merged-main/spec.md)
AC-3 (the conflict fix the resume of #116 needed and never got);
[042-poller-handler-failure-is-not-an-outage](../042-poller-handler-failure-is-not-an-outage/spec.md)
AC-4 (the criterion the flaky test covers; the criterion is unchanged);
[058-loop-test-polls-for-the-started-chain](../058-loop-test-polls-for-the-started-chain/spec.md)
(issue #111: a loop test waits on its condition instead of sleeping a fixed
time; this spec applies the same rule to the wait's bound).

## 1. Goal

A spec or design PR whose required check fails for a cause outside its scope
reaches review without spending the issue, as spec 060 promised. The three
places where issue #116 fell through are closed: the re-run that spec 060
puts before any fix now actually runs; the block returns the fixes and the
rescue that were spent on main's failure before the fix stage named it; and
the test that failed, `loop.test.ts`'s spec 042 AC-4 case, waits for the state
it asserts with a bound that CI load cannot exhaust.

### What happened to issue #116 (spec agent's reading of the records, 2026-11-21)

The running service had spec 060: the service log shows `restart` with
reason "tools/scheduler or agents changed on main" at 2026-11-14T16:24:12Z,
seven seconds after spec 060's implementation merged (d3dbae2), and #116's
spec stage started at 16:24:52Z. The route then went wrong in three places,
in order:

1. **The re-run never ran.** Spec 060 AC-3 re-requests the failed check run
   through `POST /repos/{owner}/{repo}/check-runs/{id}/rerequest`. That
   endpoint needs the App's `checks: write`, which the App does not have (it
   has `actions: write`, ADR 0006). The service log has `rerun-check-error`
   with "Resource not accessible by integration" at 16:43:45Z, 16:53:32Z and
   17:06:59Z, one per round, and no `rerun-check` line anywhere in the log.
   Each time, the next verify poll found the same failed run, `checkRerun`
   equalled the head, and the fix ran. The step that costs no agent run, and
   that would have cleared a flaky test, was dead; and it was attempted three
   times for one head because the `fix` case of `stageOk` clears `checkRerun`
   whether or not the head changed.
2. **Two fixes returned the head unchanged without a verdict.** Both fix
   runs (`116-fix-1-20261114T164349`, `116-fix-1-20261114T165337`) had spec
   060 AC-5's paragraph in their prompt, found that "no file in this PR can
   affect it", and said so as a *finding* instead of as `out_of_scope`. Each
   counted as a fix; at two, `fix loop limit reached (2 fixes)` spent the
   spec-track rescue. The rescue run returned `out_of_scope`, and the chain
   blocked at 17:17:54Z with `blocks` 1, `fixes` 2 and `specRescues` 1.
3. **The resume had nothing left.** Main moved onto one of the three named
   paths at 00:40:12Z on 2026-11-15 (a cumulative diff since the block's
   `main_sha`, through an unrelated scheduler change to `service/loop.ts`);
   the resume's `rebase_push` conflicted on `docs/delivery-system-design.md`
   (seven hours of merges to its `## Children` section), the conflict became
   a fix, `fixLoopGate(2)` failed, and with the rescue already spent the
   issue was abandoned at 00:41:35Z. No agent ran after the resume. Spec 060
   AC-9 kept `fixes` "as before the block", so the two fixes spent on main's
   failure, and the rescue they triggered, were still charged.

The finding the block filed (`stops_pipeline: true`) reached the queue at
17:17:53Z but no issue, because the findings filer was failing (`spawn
E2BIG`, issue #250); the recovery path spec 060 relies on did not exist that
night. That is #250's work, not this spec's.

### Why the test failed

The test waits for the offset file and one sent Telegram message, bounded by
400 iterations of 10 ms (about 4 s), then asserts `server.sent` has length 1
whatever the wait found. Run alone on this machine the test takes 3.3 s, and
an instrumented copy shows where: the first comment post fails at 131 ms with
the mocked 422, the poller's handler-failed retry is immediate (the sleep is
stubbed), the second handler's `listComments` returns at 151 ms, and its
comment post leaves at 3128 ms. The 3 s gap is Octokit's throttling plugin,
which spaces requests that trigger notifications (issue comments among them)
at least three seconds apart on one client. So the flow the test waits for
takes at least 3 s by construction, the bound left under a second of margin,
and on a CI runner carrying the rest of the suite that second is gone. There
is no ordering race: the sequence is deterministic and the bound was short.
The same test passed 15 of 15 `main` runs in the window because the margin
usually suffices; it is the kind of fixed bound issue #111 removed from the
same file (spec 058).

### The fix

*(agent's call)* Four small changes, none of them a decision with real
uncertainty:

- The re-run uses the mechanism the App can use: re-running the failed jobs of
  the workflow run that produced the check (`actions: write`, which ADR 0006
  granted and spec 033 proved on `POST .../actions/runs/{id}/rerun`;
  `rerun-failed-jobs` is the same permission). Asking the maintainer for
  `checks: write` would be a capability question for a permission the chain
  does not need.
- One re-run per head means one: `checkRerun` is cleared by a new head only.
- A fix that returns the head unchanged without a verdict is told so once,
  plainly, before its next run; the prompt says a finding is not a verdict.
  It stays a counted fix: a rule that uncounted it would let a fix that does
  nothing loop for free.
- The block returns what the failure spent. By spec 015's reading, which spec
  060 extended to main's failures, the two fixes that returned the head
  unchanged on that failure, and the rescue they triggered, were never
  failures of the work; the verdict proves it after the fact. Returning them
  makes AC-9's "nothing is counted" true, and `MAX_BLOCKS` (3) still bounds
  the whole. The resume then has the ordinary fix loop for what follows it (a
  conflict after hours blocked is routine).

The issue asks whether a re-run rather than a block is the right move when
main is green. With the re-run working, a flaky test is re-run once before
any fix, which is the cheap remedy; after a verdict, the resume's rebase and
push produce a fresh run, which is a second one. Spec 060's "no time ceiling"
on a block is kept: the filer is the recovery path for the test itself, and
changing that is a different decision from the one this issue records.

## 2. Out of scope

- Spec 042 AC-4's behaviour: the poller, the handler-failure log and the
  acknowledgement are unchanged; only the test's wait changes.
- Spec 006 AC-17's pending-check re-run (`rerunChecks`, the `rerun_checks`
  action after six hours pending): it calls the same `check-runs/{id}/rerequest`
  endpoint and will be refused the same way; a finding in this spec's result
  names it. Changing it is its own small spec, since a run still in progress
  cannot be re-run with `rerun-failed-jobs`.
- `MAX_BLOCKS`, the block record, the `main_green` and `paths` conditions and
  their resume rule (spec 060 AC-4, AC-7): unchanged. Whether a `paths`
  condition should be narrower than the fix agent's list is not decided here.
- The issue track: unchanged, as spec 060 left it.
- The findings filer's failure (#250) and the test's own flakiness under a
  working re-run: the first is #250's; the second is answered by the re-run.
- Asking for `checks: write`: not needed.
- Rewriting #116's ledger, comments or its retry; `docs/charter.md`;
  `docs/delivery-system-design.md` beyond its `## Children` section.

## 3. Acceptance criteria

"Given" states use the mocked GitHub API, the fake Telegram server and the
recorded worlds of `tools/scheduler/test/helpers/e2e-routes.ts`, and the unit
tests of `chain.test.ts`, `driver.test.ts`, `loop.test.ts` and `e2e.test.ts`.
*The PR's scope*, *outside the scope*, *main's head* and *blocked* are as spec
060 section 3 defines them. *The head unchanged* means the fix result's
`head_sha` equals `state.pr.head_sha` before the run.

- AC-1. **The Telegram test waits on the state it asserts.** Given the
  `loop.test.ts` case "a GitHub error while posting the answer is a handler
  failure, not a Telegram outage (spec 042 AC-4)", then its wait ends only
  when every state the assertions read is reached: the offset file names
  `next_update_id` 2, the mocked GitHub API has received two comment posts,
  `server.sent` has one message and the paused record's phase is `resuming`;
  the wait's bound is at least 20 s (within the case's 30 s timeout), polled
  at 10 ms or finer; and when the bound is reached the case fails naming the
  state still missing, so a timeout reads as one and not as "expected [] to
  have a length of 1". Given the other wait loops of `loop.test.ts` with the
  same shape (a `for` loop bounded by an iteration count whose body sleeps
  until a condition), then each gets a bound of at least 20 s where it was
  shorter; a loop already at or above that stays. Given the case is run
  twenty times in a row (`vitest run -t` in a shell loop) on the implementer's
  machine, then it passes every time, and the case alone still takes about 3
  s (the throttle is not removed: it is the client's behaviour against GitHub
  and the test exercises the real client).
- AC-2. **The re-run re-runs the workflow run's failed jobs.** Given the
  `checks` event of spec 060 AC-3 (a required check failed on a spec- or
  design-track PR, main not failed on it, `checkRerun` not equal to the head),
  then the machine's step is unchanged (`rerun_check` with the failed check
  run's id, then the wait), and the driver applies `rerun_check` by finding
  the workflow run that produced the check run (the run id in the check run's
  `details_url`, `/actions/runs/<id>/`; the `checks` summary's run entries
  carry `details_url` for it) and calling `POST
  /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`
  (`GitHubClient.rerunFailedJobs(runId)`, no client retry), logging `{ kind:
  "rerun-check", issue, sha, id, run_id }` on success. Given the check run
  has no `details_url` naming a run, or GitHub answers 404, 409 or 422 (not
  re-runnable), then the driver logs `rerun-check-refused` with the reason
  and the step is not an error (as spec 060 AC-3 says of a refusal); any
  other error is logged `rerun-check-error` as today. Given the mocked API
  records the call, then the e2e worlds' `rerun_check` route is the
  `rerun-failed-jobs` path and the `check-runs/{id}/rerequest` route is no
  longer called by the chain (a test asserts the mock never sees it).
- AC-3. **One re-run per head.** Given a `stage_ok` for `fix` on the spec or
  design track whose head is unchanged, then `checkRerun` keeps its value; it
  is cleared only when the PR's head changes (a fix or rebase that pushes a
  new head, a spec or design run's new PR head), as spec 060 AC-3's last
  sentence says. Given the same failed check on the same head after a fix
  that changed nothing, then the fix runs again without a second re-run
  request (the history has one `re-run requested once` entry per head).
- AC-4. **A fix that returns the head unchanged without a verdict is told
  so.** Given a `stage_ok` for `fix` on the spec or design track, for a
  failed required check (`pendingFixInput` starts with `A required check
  failed:`), with the head unchanged and no `out_of_scope` in the result, then
  the fix is counted as today and the history gains `fix returned the head
  unchanged without a verdict`; and given the check fails again and the next
  fix runs for it, then its input begins with the paragraph: "The previous
  fix run returned the head unchanged and no `out_of_scope` verdict. On this
  PR that is a counted fix and the fix loop ends in the issue's abandonment.
  Either change a file inside this PR's scope that clears the failure, or
  return your head unchanged with `out_of_scope: { cause, paths }` as
  described below; a finding is not a verdict." (then spec 056 AC-4's whole
  excerpt and spec 060 AC-5's paragraph as today). `agents/stages/fix.md`'s
  description of the verdict gains one sentence saying the same. On the
  issue track nothing changes.
- AC-5. Amended 2026-11-22 by the maintainer's direction on escalation bounds ([006-no-human-stops](../006-no-human-stops/spec.md) AC-1 as amended): a rescue now has several fix rounds, each a rescue run; "a rescue run" below means the rescue's own first run (`rescueFirstRun`), and a block on a later round returns that round's fixes only, leaving the rescue in effect. **The block returns what the failure spent.** Given spec 060 AC-6
  blocks (the verdict honoured), then the blocked state's `fixes` is 0, and,
  when the run that returned the verdict was a rescue run (`rescueRun` true
  before the step), the track's rescue counter (`specRescues` on the spec
  track, `rescues` on the design track) is one less than before the run, not
  below 0; the history gains `block: returned <n> fixes and the rescue spent
  on main's failure` (or `returned <n> fixes` when no rescue was spent), the
  ledger written by the block carries the returned counts, and the
  abandonment comment's bounds line, should the issue end later, reads them.
  Given the block of spec 060 AC-2 (main red on the same check, no fix ran),
  then nothing is returned because nothing was spent on it: `fixes` and the
  rescue counters are as before. Given `blocks` is at `MAX_BLOCKS`, then spec
  060 AC-6's last sentence applies unchanged: the verdict is a counted fix and
  nothing is returned.
- AC-6. **The resume has the ordinary fix loop.** Given the resume of spec
  060 AC-8 after an AC-5 block, and then a `rebase_conflict`, a failed check
  whose cause is inside the PR, or review findings, then the fix runs with
  `fixes` counting from 0 and the bounds as AC-5 left them; the spec-track
  rule of spec 006 AC-5 applies from there. Given a second verdict after the
  resume with `blocks` below `MAX_BLOCKS`, then AC-5 applies again: the fixes
  spent since the resume are returned and the chain blocks with `blocks`
  increased. The whole is bounded by `MAX_BLOCKS` as before.
- AC-7. **Issue #116's record, replayed, ends in review.** A recorded world
  drives a spec-track chain whose PR's `test` check fails on a test that is
  green on main's head: the first step requests the re-run through
  `rerun-failed-jobs` (the mock records it) and waits; the mocked re-run fails
  again; the fix runs and its scripted result is the head unchanged with a
  finding and no verdict, twice (the second fix's input starts with AC-4's
  paragraph and the history has one `re-run requested once`); the bound
  spends the rescue; the rescue's scripted result is `OUT_OF_SCOPE` naming
  `tools/scheduler/test/loop.test.ts`; the chain blocks with `blocks` 1,
  `fixes` 0 and `specRescues` 0 in the ledger; a main move that touches that
  file resumes it; the fixture's `origin/main` has moved the parent design's
  `## Children` section so the `rebase_push` conflicts; the conflict fix runs
  (scripted to merge main and push), the rebased head's check is green and
  the chain reaches `review` with `fixes` 1, `specRescues` 0 and `blocks` 1.
  This world fails on `main` before the change at the conflict: the chain
  abandons the issue with `fix loop limit reached (2 fixes)` and no run. The
  spec 060 AC-10 worlds and the spec 006, 015, 024, 029, 056 and 097 chain
  tests pass, with their `rerun_check` expectation moved to the new route.

## 4. Amendments to earlier specs

- Spec 060 AC-3 is marked `Amended by
  [101-out-of-scope-check-failure-costs-nothing](../101-out-of-scope-check-failure-costs-nothing/spec.md)
  AC-2 and AC-3: the re-run re-runs the failed jobs of the check's workflow
  run through actions: write, and checkRerun is cleared by a new head only.`
- Spec 060 AC-6 is marked `Amended by
  [101-out-of-scope-check-failure-costs-nothing](../101-out-of-scope-check-failure-costs-nothing/spec.md)
  AC-5: the block sets fixes to 0 and returns the rescue the verdict's run
  spent.`
- Spec 060 AC-9 is marked `Amended by
  [101-out-of-scope-check-failure-costs-nothing](../101-out-of-scope-check-failure-costs-nothing/spec.md)
  AC-5: after a verdict block, fixes is 0 and the rescue spent reaching the
  verdict is returned; the other counters are as before the block.`

Spec 042 is not amended: AC-4's behaviour is unchanged and the test's wait is
verification detail. Spec 006 AC-17 is not amended (section 2). Spec 033 and
ADR 0006 are not amended: `rerun-failed-jobs` is a use of the permission they
record, not a new one.

## 5. Interfaces and files

- `tools/scheduler/test/loop.test.ts`: the spec 042 AC-4 case's wait (AC-1)
  and the other short-bounded wait loops of the file.
- `tools/scheduler/src/github/client.ts`: `rerunFailedJobs(runId): Promise<boolean>`
  (false on 404, 409, 422, as `rerequestCheckRun` is today; `request: {
  retries: 0 }`); the `checks` summary's run entries gain `details_url:
  string | null`; `rerequestCheckRun` stays for `rerunChecks` (section 2).
- `tools/scheduler/src/chain/driver.ts`: `rerunCheck` resolves the run id
  from `details_url` and calls `rerunFailedJobs`, with the three log kinds
  (AC-2); the fix input's paragraph of AC-4 on the spec and design tracks.
- `tools/scheduler/src/chain/machine.ts`: the `fix` case of `stageOk` keeps
  `checkRerun` when the head is unchanged (AC-3) and notes the unchanged head
  without a verdict (AC-4); `outOfScopeVerdict`'s block sets `fixes: 0` and
  returns the rescue (AC-5); a flag on the state (`unchangedWithoutVerdict:
  boolean`, or the last history entry) tells the driver to prepend AC-4's
  paragraph.
- `tools/scheduler/src/chain/types.ts`, `schemas/scheduler/claim.json`: the
  flag if added, regenerated as the schema tooling does.
- `agents/stages/fix.md`: one sentence (AC-4).
- `tools/scheduler/test/helpers/e2e-routes.ts`: the `rerun-failed-jobs`
  route, `details_url` on the mocked check runs, scripted fix results for
  "head unchanged with a finding", a `moveMain` that conflicts the parent
  design's `## Children`.
- Tests: `loop.test.ts` (AC-1), `driver.test.ts` (AC-2's resolution and the
  three log kinds), `chain.test.ts` (AC-3, AC-4, AC-5, AC-6), `e2e.test.ts`
  (AC-7).
- `specs/060-out-of-scope-check-failure-blocks-on-main/spec.md`: the three
  marks of section 4 (this PR).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `schemas/` are sensitive paths; the security
review applies to the implementation PR (spec 006 AC-9). The change spends an
existing permission (`actions: write`) on an existing kind of call, returns
counters inside a bound that already exists (`MAX_BLOCKS`), and changes
nothing in the sensitive-path list, the security review's criteria or
instructions, what routes a sensitive diff to the security review, that both
reviews must approve, or that a sensitive path must be listed in the spec.

## 6. Verification

- `pnpm test` from the repository root passes, including the design-tree
  check for this spec's `Parent:` line and the Children entry.
- AC-1: the spec 042 AC-4 case run twenty times in a row passes twenty times;
  its wait loop reads the four states named; `grep -n 'i<400' tools/scheduler/test/loop.test.ts`
  finds no wait loop of the old bound.
- AC-2: `driver.test.ts` shows the `rerun-failed-jobs` call with the run id
  taken from `details_url`, and the refused and error logs; the e2e mock
  asserts `check-runs/{id}/rerequest` is never called by the chain.
- AC-3 to AC-6: `chain.test.ts` drives the sequences named and asserts
  `checkRerun`, the history entries, `fixes`, `specRescues`, `rescues` and
  `blocks` after each step, and the bounds line of `boundsText`.
- AC-7: the recorded world passes on the branch and its assertion of
  `review` fails on `main` before the change.
- Live, once, in the implementation PR: `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`
  with the App's token returns 201 on a completed, failed-or-cancelled
  workflow run of an earlier commit of the PR's own branch (spec 079's
  reading of spec 033 AC-3: never the head's run), and the service log of
  the next spec-track check failure, if one happens while the PR is open,
  shows `rerun-check` and no `rerun-check-error`.

## 7. Open decisions

None.
