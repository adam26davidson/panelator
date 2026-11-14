# 060. A spec or design PR whose required check fails on code outside its scope waits for main instead of spending its escalation path

Status: written 2026-11-14 from the delivery-system design for issue #115;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 ("What happens while it waits": an issue that waits on something
outside the chain releases its slot so other work continues), section 4
(the bounds count failures of the work; the terminal state is abandonment
with the full record) and section 10 ("Small work skips layers": a bug spec
hangs directly off a top design);
[001-scheduler-core](../001-scheduler-core/spec.md) AC-14 (a failed check
starts a fix with the log excerpt; this spec amends it for two tracks, as
section 4 records) and section 12 (`actions (write)`, granted for ADR 0006,
which makes a check re-run possible);
[006-no-human-stops](../006-no-human-stops/spec.md) AC-5 ("Spec track": a
bound on a spec PR runs one rescue, then abandons; amended as section 4
records), AC-6 (the bounds are constants of the chain module), AC-7 (the
ledger and its history), AC-13 (a paused issue holds no slot and the
shortlist treats it as claimed, the shape this spec reuses) and AC-21 (a
released spec track frees its branch, which this spec's wait must not do);
[009-postponed-chain-holds-slot](../009-postponed-chain-holds-slot/spec.md)
(a `waiting` claim holds its slot, which is why this spec does not wait as a
claim); [015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md)
(its reading that the bounds count failures of the work, which this spec
extends to a failure that is main's);
[024-rebase-respects-merged-main](../024-rebase-respects-merged-main/spec.md)
(the rebase and conflict path the resume reuses);
[029-design-stage](../029-design-stage/spec.md) AC-2 (the design PR's
scope) and [spec-scope gate](../006-no-human-stops/spec.md) AC-22 (the spec
PR's scope), which say what "outside the PR's scope" means;
[054-ci-installs-chromium-with-its-libraries](../054-ci-installs-chromium-with-its-libraries/spec.md)
(the fix for the failure that sank issues #39 and #49; this spec is about
what the chain does the next time such a failure happens);
[056-check-failure-history-keeps-the-failing-lines](../056-check-failure-history-keeps-the-failing-lines/spec.md)
(the history entry and the whole-excerpt fix input, both kept).

## 1. Goal

A spec or design PR is judged by what it can change. When its required check
fails for a cause that lies outside the PR's allowed paths, the chain does
not spend fixes, the spec-track rescue and the issue on it. It waits, holding
no slot, until `main` has moved in a way that can clear the cause, then
rebases the PR and verifies again. The cause reaches the findings filer at
once, so the work that does clear it is filed and runs in the slot the
waiting chain gave up.

### What is wrong today (spec agent's reading of the code and the records, 2026-11-14)

`verifyChecks` in `tools/scheduler/src/chain/machine.ts` turns every
`checks` event with `status: "failed"` into a fix (`toFix`), on any track.
On the spec track the fix's diff is held to the spec directory, `docs/designs/`,
`docs/decisions/` and the parent's `## Children` section by `specScopeGate`
(`tools/scheduler/src/gates/spec-scope.ts`); on the design track to the
spec's `design/` directory (`designScopeGate`). A failure caused by anything
else, from a broken or flaky test on `main` to a CI step that depends on the
runner, is one the fix cannot touch. The fix returns the head unchanged, the
check fails the same way, and after `MAX_FIXES` the bound hits: spec 006
AC-5's spec-track rule allows one rescue and then abandons the issue, with
its finished spec closed and its branch deleted.

The records show it twice in one morning:

- Issue #39, PR #105, touching only `specs/030-beyond-github/`. The `test`
  check failed in `tools/design-stage/test/render.test.ts` (Playwright's
  Chromium was not on the runner, issue #107). The fix run
  `39-fix-1-20261101T093527` concluded "the failure is in main's spec 029
  code, not this spec PR" and could change nothing in scope. The ledger
  `escalations/39.abandoned-2026-11-01T09-03-10-729Z.json` ends with
  `specRescues` 1 of 1 and the abandonment at 09:03Z.
- Issue #49, PR #113, touching only `specs/031-network-failure-in-a-run/`
  and one documentation line. The same check failed the same way three
  times; the fix run `49-fix-1-20261101T100820` filed the cause as a finding
  (`.github/workflows/ci.yml`, outside a spec PR's allowed paths) and
  returned its head unchanged; the ledger
  `escalations/49.abandoned-2026-11-01T10-23-44-585Z.json` shows `fix loop
  limit reached (3 fixes)`, the rescue spent on the same failure, and the
  abandonment at 10:23Z.

Two facts shape the fix. First, `main` was green all morning (`gh run list`
for the `ci` workflow on `main`: successes at 04:52Z, 09:13Z and 11:15Z on
2026-11-01), so "the same check fails on `main`" would not have caught either
case: the cause was in CI's environment, and only the PR runs hit it. The
chain cannot tell from the check runs alone where a failure lies; the fix
stage can, and in both cases it did. Second, the recovery was a change to
`main` (PR #118, commit 42010d9, 11:15Z), after which a rebased spec PR would
have passed. The chain never got there because the escalation path was spent
first.

### The fix

On the spec and design tracks only, a failed required check goes through
three steps before it costs anything, each uncounted:

1. **Main red on the same check.** The driver reads the same required checks
   on `origin/main`'s head when a PR's check fails. If the failing check is
   failed on `main` too, the chain does not run a fix: it blocks (step 3)
   until `main` is green on that check.
2. **One re-run.** Otherwise, the chain re-requests the failed check run
   once per PR head (the App has `actions: write` since ADR 0006). A green
   re-run goes to review as if the check had passed; a failed or refused one
   falls through to the fix as today.
3. **The fix's verdict.** The fix stage, which already investigates the
   cause, may answer that the cause lies outside the PR's allowed paths,
   naming the files whose change would clear it. On these two tracks that
   verdict is not a fix: the chain records it, files one finding so the
   filer can file the work, and blocks until `main` changes one of the named
   files. A fix that pushes a change, or names only files inside the PR's
   scope, is an ordinary fix as today.

**Blocking** is a pause without a question: the claim is removed and a
record kept, as spec 006 AC-13 does for a maintainer question, so the slot
is free for the work that clears the cause (with `slots: 1` a waiting claim
would hold the only slot and nothing could fix `main`). The loop resumes a
blocked issue when its condition holds on `origin/main`; the chain rebases
the PR onto `main`, pushes the new head and verifies again. A failure after
the resume takes the same steps again, bounded by `MAX_BLOCKS`; past that
bound the chain runs as today, so every path still ends.

*(agent's call)* The verdict is the fix stage's, not a parse of the log: a
spec PR can break `pnpm test` through its own files (the design-tree check,
the spec-present gate, the design stage's lint and render tests read
`specs/` and `design/`), so no mechanical rule tells the PR's failures from
`main`'s, and in both live cases the fix stage had already made the call
correctly. The check on `main` and the re-run come first because they cost
no agent run. The wait is a pause and not a `waiting` claim because of the
slot (spec 009), and not a release because a released spec track closes its
PR and deletes its branch (spec 006 AC-21), which is the loss this spec
prevents. The issue track is left alone: an implementation PR's fix may
change any file in the plan's scope, and whether a failure is the PR's is
the fix's ordinary work. The decision is cheap to reverse (one route in the
machine, one record kind) and has one clearly right shape once the slot and
the branch are considered; no ADR (design section 3, item 2).

## 2. Out of scope

- The issue track: a failed check on an implementation PR starts a fix as
  today; the `out_of_scope` verdict is recorded in the history and otherwise
  treated as a fix that changed nothing. Extending the route to it is later
  work with its own evidence.
- Fixing `main` itself. The finding is the hand-off; the filer, its issue
  and that issue's chain are unchanged.
- The `ci_failure_main` event and its watcher (spec 008 AC-4, spec 036):
  unchanged. The driver's read of `main`'s checks here is the chain's own,
  made only when a PR's check has failed.
- The pending-check path (spec 006 AC-17: six hours, one re-run, the
  capability question): unchanged, including its `rerun_checks` action.
- The fix loop bound `MAX_FIXES`, the rescue, re-plan and spec revision
  counts, and the history cap: unchanged. `MAX_BLOCKS` is added beside them.
- The maintainer question pause (spec 006 AC-13 to AC-15), its record,
  comment, labels and Telegram message: unchanged. A blocked issue has its
  own record and no question.
- The console (spec 051): it is not taught the blocked record here; a
  finding may ask for it. The record is readable in the state directory.
- Rewriting issue #39's or #49's ledgers or comments.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the recorded
worlds of `tools/scheduler/test/helpers/e2e-routes.ts`, and the unit tests of
`tools/scheduler/test/chain.test.ts`, `driver.test.ts` and `loop.test.ts`.
*The PR's scope* is the set of paths `specScopeGate` (spec track) or
`designScopeGate` (design track) allows for the chain's PR; a path is
*outside the scope* when a diff of that one path would be a violation.
*Main's head* is the SHA of `origin/main` after the tick's fetch. *Blocked*
is the state of section 3's AC-4.

- AC-1. **The driver reads main's checks when a PR's check fails.** Given
  verify on a spec- or design-track PR finds a required check failed, when
  `verifyEvent` builds the `checks` event, then it also calls `gh.checks` on
  main's head with the configured `required_checks`, records the result with
  `recordChecks` (as the watcher does), and the event carries
  `main: { sha, failed: string[] }`, where `failed` lists the names of
  required checks failed on main's head (a pending or missing check is not
  failed). Given the read fails, then `main` is `{ sha, failed: [] }` and the
  failure is logged `{ kind: "main-checks-unknown", issue, error }`: a read
  the driver cannot make never blocks a chain. Given the issue track, or a
  green or pending summary, then the event is as on `main` today, without
  `main`.
- AC-2. **Main red on the same check blocks the chain.** Given a `checks`
  event with `status: "failed"`, `log` naming check `<name>`, and
  `main.failed` containing `<name>`, on the spec or design track, when the
  machine processes it, then no fix runs: the history gains the entry of
  spec 056 AC-2 followed by a line `check <name> also fails on origin/main
  <sha>; blocked until main is green on it`, and the step is the block of
  AC-4 with condition `{ kind: "main_green", check: <name>, main_sha }`.
  Given the same event on the issue track, then the fix runs as today and the
  `main` field is ignored.
- AC-3. **One re-run before the fix.** Given the event of AC-2 but with
  `<name>` not in `main.failed`, and `state.checkRerun` not equal to the
  PR's head SHA, then the machine sets `checkRerun` to the head SHA, notes
  `check <name> failed; re-run requested once` in the history, and emits
  `{ type: "rerun_check", id }` (the failed check run's id, carried on the
  event as `failedId`) followed by a `wait` of `PENDING_WAIT_S`; the stage
  stays `verify`, so the next step reads the checks again (a re-requested
  run reports as pending, then completes). The driver applies `rerun_check`
  through `gh.rerequestCheckRun` and logs `rerun-check` or
  `rerun-check-refused` as `rerunChecks` does; a refusal is not an error of
  the step. Given the event with `checkRerun` equal to the head SHA (the
  re-run already happened for this head, whatever it returned), then the fix
  runs as today, with the whole excerpt as `fixInput` (spec 056 AC-4) and
  the fix's input gaining, on these two tracks, the paragraph of AC-5. A new
  head (a fix's or a rebase's) clears `checkRerun`.
- AC-4. **A block is a pause without a question.** Given the machine blocks,
  then the state's stage is `blocked`, the state carries `blocked: { on:
  <condition>, since, check, main_sha, blocks }` (`blocks` counting this
  issue's blocks, kept in the ledger beside the other counters), and the
  actions are, in this order: one `finding` (`what: "required check <name>
  fails on a <track> PR for a cause outside its scope"`, `where` the
  condition's files or `origin/main <sha>`, `evidence` the history entry's
  failing lines and, for AC-6, the fix's `cause`, `noticed_how: "verify of
  PR #<n> on the <track> track"`), one `comment` on the issue (no
  @-mention) saying the PR waits for `main` and why, one `notify` (gate
  `infra`, rate-limited as today), and `{ type: "block", condition }`. The
  driver applies `block` as `pauseIssue` applies `pause`: it writes
  `blocked/<issue>.json` (`{ issue, state, worktree, since, condition,
  pr }`, a new `blocked.json` schema under `schemas/scheduler/`), keeps the
  worktree, and removes the claim; `in-progress` stays on the issue. A
  blocked record holds no slot (spec 009's held count excludes it, as it
  excludes a paused record), and the shortlist treats the issue as claimed
  (spec 006 AC-13's rule for a paused record). Liveness does not apply: there
  is no claim. A crash between the steps is completed on the next tick from
  the record, as a pause is.
- AC-5. **The fix stage may say the cause is outside the PR.** Given the
  fix stage runs on a spec- or design-track PR for a failed check, then its
  input ends with a paragraph telling it that, when the failing test or job
  fails for a cause that no file inside this PR's scope can change, it must
  return its head unchanged with `out_of_scope: { cause, paths }` (`cause`
  one paragraph naming the failing test or step and why it is main's;
  `paths` the repository files, outside the scope, whose change would clear
  it, at least one), and that it must not widen the diff. `fix-result.json`
  gains the optional `out_of_scope` object (`cause` a non-empty string,
  `paths` a non-empty array of strings); `FixResult` gains the field;
  `agents/stages/fix.md` documents it in a few lines. The paragraph is not
  added on the issue track.
- AC-6. **An out-of-scope verdict blocks instead of counting.** Given a
  `stage_ok` for `fix` on the spec or design track whose result carries
  `out_of_scope`, whose `head_sha` equals the PR's head, and whose every
  path is outside the PR's scope, when `state.blocked?.blocks ?? 0` (the
  ledger's count) is below `MAX_BLOCKS` (3), then `fixes` is not increased,
  `rescueRun` is cleared without a counted outcome (a rescue that ends in
  this verdict is not "failed"), the history gains `fix: cause outside the
  PR's scope: <cause> (paths: <paths>)`, and the step is the block of AC-4
  with condition `{ kind: "paths", paths, main_sha }` (main's head as the
  driver read it before the run, carried on the event as `mainSha`). Given
  the head differs from the PR's head (the fix changed something), or any
  path is inside the scope, or the track is `issue`, then the verdict is
  ignored, the history notes `out_of_scope ignored: <reason>`, and the
  result is applied as a fix today. Given `blocks` is at `MAX_BLOCKS`, then
  the verdict is applied as a fix that changed nothing (the fix is counted,
  verify runs, and today's path follows), with the history noting `block
  bound reached`.
- AC-7. **The loop resumes a blocked issue when its condition holds.** Given
  a `blocked/<issue>.json` record, when a tick runs after its fetch of
  `origin/main`, then the loop tests the condition against main's head:
  `main_green` holds when main's head differs from `main_sha` or the record
  is older than `BLOCK_RECHECK_S` (1800 s) since its last check, and
  `gh.checks` on main's head reports `check` neither failed nor pending
  (the read is made at most once per `BLOCK_RECHECK_S` per record, its time
  kept on the record); `paths` holds when main's head differs from
  `main_sha` and `git diff --name-only <main_sha> <head>` in the
  scheduler's checkout names a file equal to, or under, one of `paths` (a
  path ending in `/` covers the directory). Given the condition holds, then
  the loop writes the claim back from the record with `pendingEvent: {
  type: "unblocked", main_sha: <head> }`, removes the record, logs `{ kind:
  "unblocked", issue, condition, main_sha }`, records an event
  `block.ended`, and the claim takes a slot in the order of spec 016 after
  answered resumes and before standing agents. Given it does not hold, then
  nothing is written beyond the record's check time and the tick goes on;
  a blocked record has no time ceiling (the finding is the recovery path).
- AC-8. **The resume rebases, pushes and verifies.** Given the chain's first
  step applies `unblocked` at stage `blocked`, then the state's stage is
  `verify`, `blocked` keeps `blocks` and drops the condition, `checkRerun`
  is cleared, and the actions are `{ type: "rebase_push" }` then `verify`.
  The driver applies `rebase_push` by syncing the worktree to the PR's
  remote head, rebasing onto `origin/main` as it does before a stage (spec
  024's merge-aware rule included), and, when the rebase succeeds and the
  head changed, pushing the branch with `--force-with-lease` and setting
  `state.pr.head_sha` to the new head; an unchanged head pushes nothing. A
  conflict raises the `rebase_conflict` event of spec 024 as before a stage,
  and the fix that resolves it runs as today. Given verify then finds the
  check green, then review runs as today. Given it finds the check failed
  again, then AC-2, AC-3 and the fix follow again, with `checkRerun` clear
  for the new head.
- AC-9. **Nothing is counted or lost.** Given a chain blocked by AC-2 or
  AC-6 and resumed by AC-7, then `fixes`, `rescues`, `specRescues`,
  `replans`, `specRevisions` and `attempt` are as before the block, the PR
  is open on the same branch with its commits, `heldWork` is unchanged, and
  the only new ledger counter is `blocks`. Given a chain released or
  abandoned for another reason while a `blocked` record exists (not
  possible by construction: a blocked issue has no claim), then no action
  is specified; the record is removed only by AC-7. Given a stop of the
  scheduler while blocked, then the next tick reads the record and AC-7
  applies.
- AC-10. **Live cases end to end.** Recorded worlds drive and assert:
  - a spec-track chain whose PR's `test` check fails on a test that also
    fails on main's head: no fix runs, one finding, one comment, a
    `blocked/<issue>.json` record and no claim; the loop claims a second
    issue in the freed slot; after main's head moves and `test` is green
    there, the tick resumes the first issue, the driver pushes a rebased
    head, the mocked checks report green on it, and the chain reaches
    `review` with `fixes` 0 and `specRescues` 0;
  - a spec-track chain whose `test` fails with main green: the first step is
    one `rerun_check` and a wait; the mocked re-run fails again; the fix runs
    with the AC-5 paragraph and its scripted result is `OUT_OF_SCOPE` (head
    unchanged, `paths: [".github/workflows/ci.yml"]`): the chain blocks on
    `paths`; a main move that touches `README.md` does not resume it; a main
    move that touches `.github/workflows/ci.yml` does; the rebased head's
    check is green and the chain reaches `review` with `fixes` 0. This test
    fails on `main` before the change (the chain counts the fix and, after
    three, abandons the issue);
  - the same with `blocks` already at `MAX_BLOCKS` in the ledger: the
    verdict is counted as a fix and the fix loop runs as today;
  - an issue-track chain whose fix returns `out_of_scope`: ignored, the fix
    counted, verify runs, as today.
  The existing spec 006, 015, 024, 029 and 056 chain tests pass unchanged:
  the mocked `checks` reports main green by default and the fake harness
  returns no `out_of_scope` unless its script says so.

## 4. Amendments to earlier specs

- Spec 001 AC-14 is marked `Amended by
  [060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
  AC-2: on the spec and design tracks a check failed on main too, or one not
  yet re-run for this head, does not start the fix at once.`
- Spec 006 AC-5's **Spec track** paragraph is marked `Amended by
  [060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
  AC-6: a fix verdict that the failure's cause is outside the PR's scope is
  not a bound hit while the block bound holds; the chain blocks and waits
  for main.`
- Spec 006 AC-6's list of bounds gains `MAX_BLOCKS` (three blocks per issue)
  by this spec's text; the test that asserts the bounds' values gains it.
  The list is marked `Amended by
  [060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
  AC-6: MAX_BLOCKS (3) is a bound of the same kind.`

Spec 009's held count is not amended: its definition excludes an issue with
a paused record, and AC-4 asks the same of a blocked record; the
implementation extends the same exclusion and the spec's text ("whose issue
has no paused record") is read as "no paused or blocked record", which AC-4
states here. Spec 056 is not amended: the history entry and the whole
excerpt as fix input are kept.

## 5. Interfaces and files

- `tools/scheduler/src/chain/types.ts`: `ChainStage` gains `blocked`;
  `ChainState` gains `checkRerun: string | null` and `blocked: { on:
  BlockCondition | null; since: string | null; check: string | null;
  main_sha: string | null; blocks: number } | null`;
  `BlockCondition = { kind: "main_green"; check: string; main_sha: string }
  | { kind: "paths"; paths: string[]; main_sha: string }`; the `checks`
  event gains `main?: { sha: string; failed: string[] }` and `failedId?:
  number`; the `stage_ok` fix event gains `mainSha?: string`; new events
  `{ type: "unblocked"; main_sha: string }`; new actions `{ type:
  "rerun_check"; id: number }`, `{ type: "block"; condition: BlockCondition }`,
  `{ type: "rebase_push" }` (AC-1 to AC-4, AC-6 to AC-8).
- `tools/scheduler/src/chain/machine.ts`: `MAX_BLOCKS = 3` beside the other
  bounds; `verifyChecks` branches on track for AC-2 and AC-3; the `fix` case
  of `stageOk` applies AC-6; `unblocked` applies AC-8; the ledger
  (`ledgerOf`, `initialChainState`) carries `blocks`; `boundsText` names
  `block <n>/${MAX_BLOCKS}`.
- `tools/scheduler/src/chain/driver.ts`: `verifyEvent` reads main's checks
  (AC-1); `rerun_check`, `block` (`blockIssue`, beside `pauseIssue`) and
  `rebase_push` in `applyActions` (AC-3, AC-4, AC-8); the fix input's
  paragraph on the spec and design tracks (AC-5); `mainSha` on the fix's
  `stage_ok` (AC-6).
- `tools/scheduler/src/state/paths.ts`: `blocked` directory;
  `tools/scheduler/src/state/blocked.ts` (new): read, write, remove the
  record; `schemas/scheduler/blocked.json` (new) and
  `schemas/scheduler/escalation-ledger.json` (`blocks`),
  `schemas/scheduler/claim.json` (the new state fields),
  `schemas/scheduler/fix-result.json` (`out_of_scope`),
  `schemas/scheduler/action.json` (the three actions) regenerated as the
  schema tooling does.
- `tools/scheduler/src/service/loop.ts`: the blocked resume step (AC-7)
  with `BLOCK_RECHECK_S = 1800`, placed after answered resumes; the held
  count and the shortlist's claimed set read `blocked/` as they read
  `paused/`.
- `tools/scheduler/src/types.ts`: `FixResult.out_of_scope?`;
  `agents/stages/fix.md`: the verdict documented (AC-5).
- `tools/scheduler/test/helpers/e2e-routes.ts`: `OUT_OF_SCOPE` script
  value, a `mainChecks` option on the worlds (default green), a `moveMain`
  helper that advances the fixture's `origin/main` with named files.
- Tests: `chain.test.ts` (AC-2, AC-3, AC-6, AC-8, AC-9 and the bounds
  assertion), `driver.test.ts` (AC-1's read and its failure, `rebase_push`,
  `block`), `loop.test.ts` (AC-7's two conditions, the recheck interval,
  the slot order), `e2e.test.ts` (AC-10).
- `specs/001-scheduler-core/spec.md` AC-14 and
  `specs/006-no-human-stops/spec.md` AC-5 and AC-6: the marks of section 4.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `schemas/` are sensitive paths; the
security review applies to the implementation PR (spec 006 AC-9). The change
adds a route that spends no bound and a bound (`MAX_BLOCKS`) that ends it;
it does not change the sensitive-path list, the security review criteria or
instructions, what routes a sensitive diff to the security review, that
both reviews must approve, or that a sensitive path must be listed in the
spec. The re-run uses the `actions: write` permission already granted
(spec 001 section 12, ADR 0006) through the existing `rerequestCheckRun`;
`rebase_push` pushes only the chain's own PR branch, with a lease, as the
stages' own pushes do. The verdict is honoured only when the head is
unchanged and every named path is outside the PR's scope, so a fix cannot
use it to widen a diff or to skip a check it could have fixed.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The second AC-10 chain fails on `main` before the change and passes after
  it; the existing chain, driver and loop tests pass without edits other
  than the bounds assertion gaining `MAX_BLOCKS`.
- `grep -n "MAX_BLOCKS" tools/scheduler/src/chain/machine.ts` prints the
  constant and its uses; `grep -rn "rerequestCheckRun" tools/scheduler/src`
  prints the pending re-run of spec 006 AC-17 and the one of AC-3.
- Live check after deploy: the next spec PR whose `test` check fails on a
  cause outside its scope shows, in the service log, `rerun-check` once, a
  fix run whose result carries `out_of_scope`, a `blocked/<issue>.json`
  record, one finding in the queue naming the paths, and no `fix attempt`
  entry in the ledger; after the named file changes on `main`, `unblocked`,
  a pushed head and the chain at `review`.

## 7. Open decisions

None.
