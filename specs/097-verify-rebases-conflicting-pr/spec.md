# 097. Verify rebases a PR that conflicts with main instead of waiting for its checks

Status: written 2026-11-20 from the delivery-system design for issue #366, at
the maintainer's request outside the pipeline (spec and implementation in one
PR); specs derived from that design need no maintainer approval (design
section 11).
Marks [006-no-human-stops](../006-no-human-stops/spec.md) AC-17 (amended by
AC-1 and AC-3 here: a PR that GitHub reports not mergeable, with a required
check that has no run, is not waited on) and
[060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
AC-8 (amended by AC-2 here: verify applies `rebase_push` too, and a pushed
head clears the pending window).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a bug spec hangs directly off a top
design); [006-no-human-stops](../006-no-human-stops/spec.md) AC-17 (the
six-hour pending bound, its investigating fix and its question, amended
here); [060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
AC-8 (`rebase_push`, reused here);
[024-rebase-respects-merged-main](../024-rebase-respects-merged-main/spec.md)
(the `rebase_conflict` event, its fix input and its `conflictPending` rule,
reused; its transition now also clears `pendingSince`).

## 1. Goal

A chain in verify whose PR conflicts with `main` brings the branch up to date
with `main` at once instead of waiting out the six-hour pending bound. A clean
rebase is pushed and verify goes on with the new head; a conflicting one goes
to the fix stage with the conflict, and the paths it is in, as its input. The
six-hour path and its question stay for a mergeable PR whose checks do not
report.

### What is wrong today

GitHub starts no `pull_request` workflow for a PR that conflicts with its base,
so no required check ever reports on it. `GitHubClient.checks`
(`tools/scheduler/src/github/client.ts`) reads a required check with no run as
`pending`, `verifyEvent` (`tools/scheduler/src/chain/driver.ts`) sends a
`checks` `pending` event, and `verifyChecks`
(`tools/scheduler/src/chain/machine.ts`) waits `PENDING_WAIT_S` at a time
until `VERIFY_PENDING_MAX_H` (6) runs out, holding a slot. Then the fix stage
is asked to investigate checks that "never report", which does not name the
conflict, and after that a question goes to the maintainer. The PR's
mergeability is read only in the merge step, which such a chain never reaches.
Seen on issue #199 (PR #358) and issue #37 (PR #365) on 2026-11-20.

### The fix

*(agent's call)* The driver reads the PR (`GitHubClient.pullRequest`, which
already returns `mergeable`) only when a pending result has a required check
with no run, because only then can a conflict be the reason; this keeps the
extra GitHub requests to one per verify poll while a check is missing, and
none while every required check has a run. The `checks` event carries the
answer as `conflicts: true`. The machine then answers with the existing
`rebase_push` action of spec 060 AC-8 followed by the usual wait, rather than
new machinery: `rebase_push` already syncs to the PR's remote head, rebases
onto `origin/main` with spec 024's merge-aware rule, pushes with a lease and
binds the new head, and on a conflict raises spec 024's `rebase_conflict`,
which is already valid in verify and already tells the fix stage the conflict
detail (git's `CONFLICT` lines, which name the paths) with spec 024's
guidance. The wait (rather than an immediate verify) keeps a PR that GitHub
still reports not mergeable after a clean, unmoved rebase from looping
without pause; the pending window is cleared only when a new head is pushed,
so such a PR is still bounded by AC-17.

## 2. Out of scope

- The fix stage's prompt and the text of spec 024's `rebase_conflict` fix
  input: unchanged (issue #320, telling a fix that its branch was rebased, is
  separate).
- The merge step's `not_mergeable` path: unchanged.
- A PR whose checks are failed or green, or pending with every required check
  having a run: no PR read, behaviour unchanged.
- `GitHubClient`, the claim and event schemas, the stage prompts and
  `agents/scheduler.yaml`: unchanged.

## 3. Acceptance criteria

Driver criteria are tested with the driver harness of
`tools/scheduler/test/driver.test.ts` (`setup(...)` with a real origin, a
`spec-7` PR as `onSpec7` makes it, and mocked GitHub routes); machine criteria
with `transition` in `tools/scheduler/test/chain.test.ts`.

- AC-1. **A conflicting PR with no check run is not waited on.** Given verify
  reads the PR's head and the result is `pending`, and a required check has no
  run (with `required_checks` empty: the head has no run at all), then the
  driver reads the PR once with `GitHubClient.pullRequest`; given its
  `mergeable` is `false`, then the `checks` event carries `conflicts: true` and
  the driver logs `verify-not-mergeable` with the issue, PR and head. Given
  `conflicts: true` at stage `verify`, then, whatever the time since
  `pendingSince`, the machine's actions are `{ type: "rebase_push" }` then
  `{ type: "wait", seconds: PENDING_WAIT_S }`, the stage stays `verify`,
  `pendingSince` is set as for any pending result, and nothing is counted.
  Given `mergeable` is `null` (GitHub still computing) or `true`, then the
  event carries no `conflicts` and the chain waits as today.
- AC-2. **The rebase decides what follows.** Given `rebase_push` is applied in
  verify and the rebase is clean and moves the head, then the branch is pushed
  with a lease, `state.pr.head_sha` is the new head and `pendingSince` is
  cleared, so verify polls the new head in a new window. Given the rebase
  conflicts, then the PR head is unchanged, the claim's pending event is spec
  024's `rebase_conflict` with git's conflict detail, and the next step runs
  it: the chain goes to `fix` with `conflictPending` set and `pendingSince`
  cleared (the fix's head gets a new window), the fix input
  `origin/main conflicts with this branch:` followed by the detail and spec
  024's guidance, and the history entry `origin/main conflicted before verify,
  on head <sha>:` with the detail, all as spec 024 defines. Given a clean
  rebase that does not move the head, nothing is pushed and the wait follows.
- AC-3. **The six-hour path stays for checks that do not report.** Given a
  pending result whose event carries no `conflicts`, then spec 006 AC-17
  applies unchanged: the re-run and investigating fix after six hours, then
  the question.
- AC-4. **No PR read when every required check has a run.** Given a pending
  result where every required check has a run (queued or in progress), then
  verify makes no `GET /repos/{owner}/{repo}/pulls/{n}` request.
- AC-5. **The tests pin it.** `tools/scheduler/test/chain.test.ts` has a test
  that `conflicts: true` gives the AC-1 actions at the first poll and past the
  six-hour bound, and that a following `rebase_conflict` in verify gives the
  AC-2 fix; a test that a pending event with `conflicts: false` past the bound
  takes AC-17's path; and the every-event-in-every-stage table includes a
  pending `checks` event with `conflicts: true`.
  `tools/scheduler/test/driver.test.ts` has a `spec 097` describe block with:
  a conflicting PR with no check run and a clean rebase (the push, the new
  head bound, `pendingSince` cleared, one PR read, the log record); one whose
  rebase conflicts (the `rebase_conflict` pending event naming the path, then
  the fix with `conflictPending`); `mergeable: null` (waits, nothing pushed);
  a mergeable PR with no check run past six hours (the investigating fix,
  nothing pushed); and a required check with a run (no PR read).

## 4. Interfaces and files

No schema, config key, stage prompt or state file format changes; the new
event field is in memory only (a `checks` event is never stored as a claim's
pending event). The PR edits:

- `tools/scheduler/src/chain/types.ts`: the `checks` event gains `conflicts?:
  boolean`.
- `tools/scheduler/src/chain/driver.ts`: `verifyEvent` reads the PR and sets
  `conflicts` as AC-1 says; `rebasePush` clears `pendingSince` when it binds a
  new head (AC-2; in spec 060's resume it is already null).
- `tools/scheduler/src/chain/machine.ts`: `verifyChecks` answers `conflicts`
  before the bound (AC-1); the `rebase_conflict` transition clears
  `pendingSince` (AC-2; before this spec it was already null at every point
  that raised it).
- `tools/scheduler/test/chain.test.ts` and
  `tools/scheduler/test/driver.test.ts`: the tests of AC-5.
- This spec, the amendment marks on spec 006 AC-17 and spec 060 AC-8, and its
  line under `## Children` in `docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`), so the
security review applies. The change adds one read-only GitHub request on an
existing path and reuses an existing push with a lease on the chain's own
branch; it touches no gate, bound, label rule, permission or token handling,
and plans no change to the charter, to a protected maintainer decision, to the
sensitive-path list, to the security review criteria or instructions, or to
what decides that a sensitive diff gets the security review.

## 5. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean.
- Checked by hand once while implementing, not committed: with the source
  changes reverted and the tests kept, the AC-1 machine test and the
  conflicting, conflict-on-rebase and `mergeable: null` driver tests fail; the
  AC-3 and AC-4 tests pass either way, as they pin unchanged behaviour.

## 6. Open decisions

None.
