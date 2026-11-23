# 113. A chain retried after abandonment starts from the closed PR's saved work

Status: written 2026-11-23 from the delivery-system design for issue #256;
specs derived from that design need no maintainer approval (design section 11).
Amends [006-no-human-stops](../006-no-human-stops/spec.md) AC-5 and AC-7,
[011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
section 2, AC-4 and AC-5,
[040-held-work-per-branch](../040-held-work-per-branch/spec.md) AC-4 and
[085-spec-rescue-keeps-issue-hold](../085-spec-rescue-keeps-issue-hold/spec.md)
AC-1 and AC-2, each marked in this spec's PR as section 4 records (spec 039).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the terminal state is abandonment "with the full record", left
open "for spec C to re-triage", and "C's re-triage is the recovery path")
and section 10 ("Small work skips layers": a bug spec hangs directly off a
top design);
[005-keep-unpushed-commits](../005-keep-unpushed-commits/spec.md) (the
`closed-pr` patch is saved so the work is not lost; this spec hands it on);
[006-no-human-stops](../006-no-human-stops/spec.md) AC-5 (the abandonment
closes the PR, saves its branch as a patch and deletes it) and AC-7 (the
ledger is archived at abandonment, a re-claim "starts with fresh counts",
and an unrecorded answer is carried into the fresh ledger, the shape this
spec reuses);
[011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
and [040-held-work-per-branch](../040-held-work-per-branch/spec.md) (held
work: the hold per branch, its restoration and the `held_work` input);
[085-spec-rescue-keeps-issue-hold](../085-spec-rescue-keeps-issue-hold/spec.md)
(which holds a spec-track rescue keeps);
[039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md)
(the marks). The spec continues the one written for issue #116 on branch
`spec-116` at `357d333`, whose PR #227 was closed at that issue's
abandonment; it is brought in line with `main` as of 2026-11-23.

## 1. Goal

When the findings filer retries an abandoned issue (its `retry` outcome
removes the `abandoned` label, spec 006 AC-5), the new chain starts where
the old one's pull request stopped, not from nothing. The spec PR or design
PR that the abandonment closed is restored on the chain's branch before the
first stage runs, and the stage is told whose work it is. An implementation
PR the abandonment closed is not restored, but the retried chain's plan and
implement stages are told where it is. The issue's abandonment comment names
what was kept. The counts stay fresh, as spec 006 AC-7 says: this spec
carries work, not failures.

### What is wrong today (spec agent's reading of the code and the records, 2026-11-23)

`abandon()` in `tools/scheduler/src/chain/machine.ts` emits `close_pr` for
the open PR (and a parked issue PR), then `comment`, `label`, `finding`,
`notify` and `done`. The driver's `close_pr` case
(`tools/scheduler/src/chain/driver.ts`) saves the branch's commits as a
`closed-pr` patch, comments, closes the PR and deletes the branch on GitHub;
its `done` case saves the worktree's leftovers, archives the ledger and,
only when an answer is not yet recorded on `main`, writes a fresh ledger
carrying that answer. Nothing records the closed PR's number or head. The
filer's retry (`tools/scheduler/src/filer/apply.ts`) comments and removes
the label. The next claim reads the fresh ledger (or none),
`initialChainState` seeds counts only, and the first stage's preparation
(`syncWorktree`) puts `spec-<n>` at `origin/main`; the stage input's history
is `(none)` and `held_work` is `(none)`.

Issue #39: PR #105 held the finished spec 030; the abandonment on
2026-11-01 closed it, deleted `spec-39` and saved the patch. The retried
spec run was told only that the spec was not on `main`; it found the spec
through a stale remote-tracking ref, which the pipeline does not promise.
Issue #49 (PR #113, `3bdc478`) and issue #116 (PR #227, `357d333`) were left
the same way, and spec 069 section 1 had to name `origin/issue-39` at
`3b4aa7d` by hand.

### The fix

1. **Record.** The abandonment records every PR it closes (number, branch,
   head, the saved patch's path, the time) in the chain state, and the fresh
   ledger written at `done` carries the list beside an unrecorded answer.
   The abandonment comment names each closed PR and its head.
2. **Restore.** The claim that follows a retry reads the ledger as today.
   When the new chain starts at the spec stage in `write` mode or at the
   design stage, the entry on that stage's branch becomes a hold (spec 040)
   that carries the PR's number. The preparation of spec 011 restores the
   branch at the closed PR's head: from the local object store when the
   commit is still there, otherwise from `refs/pull/<pr>/head`, which GitHub
   keeps for a closed PR. The driver pushes nothing; the stage pushes, as it
   does for any held work.
3. **Tell.** The stage's `held_work` input says this is the earlier chain's
   PR, closed at abandonment, built on an older `main`. Where nothing is
   restored (an `issue-<n>` entry, or a commit neither source has),
   `held_work` still names the PR, its head, the patch path and
   `refs/pull/<pr>/head`, so the stage can read the work instead of guessing.

*(agent's call)* The restore reuses held work instead of replaying the
patch: a spec PR edits its parent design's `## Children` section, which
changes on every spec merge, so `git am` of the patch onto a moved `main`
would conflict in nearly every case, while a branch at the old head is what
every other hold is. An implementation PR is named but not restored: its
plan belonged to the abandoned chain, and the retried chain plans again
against `main` as it is now, so the old diff is reference, not a starting
head. The pointer lives in the ledger because the claim already reads it
and spec 006 AC-7 already carries an unrecorded answer the same way. The
record is small and reversible, so no ADR (design section 3, item 2).

## 2. Out of scope

- The filer: its `retry` decision, comment and label removal are unchanged.
- An issue re-filed under a new number, as this one was from #116: the
  ledger is per issue, so the new issue's chain gets nothing from this spec;
  the filer's body names the earlier work, and renumbering is issue #133.
- Restoring an `issue-<n>` PR's commits for the retried chain. They are
  recorded and pointed to (AC-1, AC-4), not restored (AC-2).
- The abandonment's other steps: the label, the finding, the notification,
  the archived ledger and its counts, the `issue_abandoned` event. A retried
  chain still starts with fresh counts and an empty history.
- A PR closed to re-plan or to revise the spec (`escalate`,
  `designToSpecRevise`): those are discards by design and record nothing.
- Replaying a saved patch (spec 005 section 2); every patch kind is saved as
  today.
- The loop test of spec 042 AC-4 that failed PR #227's required check: spec
  101 covers it.
- The console and the question path: unchanged.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API, the repo-pair
setup of the driver tests and the recorded worlds of
`tools/scheduler/test/helpers/e2e-routes.ts`.

**Definitions.** *Closed work* is the field `closedWork` of `ChainState` and
of the ledger: a list of `{ pr, branch, head, patch, at }` entries (`pr` the
PR number, `branch` its head branch, `head` its head SHA when closed, `patch`
the saved `closed-pr` patch's path or `null`, `at` the ISO time the driver
closed it or `null`), at most one entry per branch, empty when there is
none. A *closed-PR hold* is a `heldWork` entry (spec 040) with `pr` set to
the closed PR's number; it has no `carried` field, so no rule of spec 053
applies to it.

- AC-1. **The abandonment records what it closed.** Given `abandon()` emits
  one or more `close_pr` actions, then the abandoned state's `closedWork` is
  the incoming list with, for each closed PR, the entry on its branch
  replaced by (or added as) `{ pr, branch, head, patch: null, at: null }`,
  `pr` and `head` from the state's `pr` or `parkedPr`. Given it emits none,
  `closedWork` is the incoming list unchanged, so work an earlier
  abandonment closed is still carried. The abandonment comment gains, after
  the bounds line, one line per entry of the new list on `spec-<n>` or
  `design-<n>`: `PR #<pr> (<branch> at <head>) is closed, not lost: its
  commits are saved as a patch in the scheduler state directory, and a chain
  retried after this abandonment starts from it.`; and per entry on
  `issue-<n>`: `PR #<pr> (<branch> at <head>) is closed, not lost: its
  commits are saved as a patch in the scheduler state directory; a retried
  chain plans again and is pointed to it.` The comment still carries no `@`.
  When the driver applies a `close_pr` action while the claim's state holds
  an entry with that `pr`, it sets the entry's `patch` to the path
  `savePatch` returned (null when there were no commits) and `at` to the
  time, in the claim's state, before it closes the PR. When the driver
  applies the abandonment's `done`, then after archiving the ledger it
  writes the fresh ledger whenever `closedWork` is non-empty or an answer is
  pending, carrying both; given neither, no fresh ledger is written, as
  today. A scheduler that stops between `close_pr` and `done` loses at most
  a `patch` path, never an entry: the entries are in the state the claim
  file holds (spec 006 AC-5's resume rule).
- AC-2. **The retried claim carries it as a hold.** Given a claim whose
  ledger carries `closedWork`, when `initialChainState` seeds from the
  ledger, then the state's `closedWork` is the ledger's list, and:
  - given a spec problem (the chain starts at the spec stage in `write`
    mode) and an entry on `spec-<n>`, `heldWork` holds the closed-PR hold
    `{ branch: "spec-<n>", head, pr }`;
  - given no spec problem, a design problem, no pending answer (the chain
    starts at the design stage) and an entry on `design-<n>`, `heldWork`
    holds `{ branch: "design-<n>", head, pr }`;
  - otherwise `heldWork` is empty, as today. An `issue-<n>` entry never
    becomes a hold.

  `ledgerOf` carries `closedWork` (written only when non-empty, like
  `blocks`), so the chain's ledger writes keep it, and a chain released and
  claimed again is seeded the same way. Given a PR from a branch merges on
  this chain, then the entries on that branch are removed from `closedWork`:
  what merged supersedes them.
- AC-3. **The preparation restores the branch.** Given a closed-PR hold on
  the chain's branch and no PR bound, when the stage is prepared
  (`syncWorktree`, through `keepHeldWork`), then:
  - given the held head exists in the worktree's repository, the branch is
    kept or put at it as spec 011 AC-2 and AC-5 say (`held-work-restored`
    with `source: "local"` when it had to be moved), and the preparation
    ends with `held-work-kept`;
  - given it does not, and the branch is on origin after the fetch, the
    branch's remote head is taken as spec 011 AC-5 says (`source:
    "origin"`);
  - given it does not and the branch is not on origin, then before
    `held-work-lost` the driver fetches `refs/pull/<pr>/head` from origin.
    Given that ref resolves to the held head, the branch is put at it and
    the log carries `held-work-restored` with `source: "pull"`, then
    `held-work-kept`. Given the ref is missing or resolves to another
    commit, then `held-work-lost` is logged, the hold is removed as spec 040
    AC-5 says, and the preparation continues as without held work. A fetch
    that fails for any reason but the ref missing fails the step and changes
    nothing, as spec 011 AC-5 says.

  A closed-PR hold whose head advances or is restored keeps its `pr`.
  Nothing is pushed by the driver, and `recovered-commits` is not written
  for the restored commits. The restored branch builds on an older
  `origin/main`; the driver does not rebase it, the stage pushes it, and the
  PR's merge path (spec 024) rebases as for any PR. A hold whose head is
  reachable from `origin/main` is nothing to keep (spec 011 AC-5).
- AC-4. **The stage is told.** Given a closed-PR hold kept by AC-3 and the
  worktree's `HEAD` at its head, when the spec or design stage runs, then
  its `held_work` input names the branch, the head, whether it is on origin
  and the open PRs from it as spec 011 AC-4 says, and in place of the
  closing sentence says: this is the work of this issue's earlier chain,
  PR #<pr>, closed (not merged) when the issue was abandoned on <at>; it
  builds on an older `origin/main`; the issue's comments hold the
  abandonment record and the retry's reason; check the work against the
  issue, its parent design and `main` as it is now, and continue from it
  instead of writing it again.

  **A pointer where nothing is restored.** Given no PR bound, no hold kept
  on the chain's branch (`heldWorkText` would return nothing) and a
  `closedWork` entry on the chain's branch, when a spec, design, plan or
  implement stage runs, then `held_work` is not absent. It reads: `The
  earlier chain's PR #<pr> (<branch> at <head>, closed when the issue was
  abandoned on <at>) is not restored on this branch. Its commits are saved
  as a patch at <patch> on this machine` (or `No patch of it was saved` when
  `patch` is null) `and stay on origin at refs/pull/<pr>/head.`, followed
  for `spec-<n>` and `design-<n>` by the instruction to read the work and
  continue from it instead of writing it again, and for `issue-<n>` by:
  `This chain's plan is new; read the earlier work as reference where the
  plan covers the same ground.` An `at` of null is rendered without the
  date. A stage with a PR bound (fix, review, verify) and the question check
  get no pointer.

  The `{{held_work}}` line of `agents/stages/spec.md`, `design.md` and
  `plan.md` reads as the work of an earlier run of this issue (before a
  question, or of a chain that was abandoned and retried), and the line of
  `agents/stages/implement.md` adds the same case to the two it names.
- AC-5. **What clears the hold.** Given a closed-PR hold, then:
  - it is removed when a PR binds on its branch (spec 040 AC-2);
  - it survives the stage's failure (the stage is not the asking stage, so
    spec 040 AC-3 does not drop it) and a quota postponement;
  - a question the stage asks replaces it with the stage's own hold (spec
    040 AC-1): the work is then the stage's own;
  - the `escalate` that reruns the spec stage as a spec-track rescue keeps a
    closed-PR hold on `spec-<n>`, and the `escalate` that reruns the design
    stage as a design-track rescue keeps a closed-PR hold on `design-<n>`:
    the rescue is one more attempt of the stuck stage, and the closed PR's
    work is its input, not the failed attempt's. A hold without `pr` on
    those branches is removed as spec 085 AC-1 and AC-2 say;
  - every other clear of spec 040 AC-4 (a spec revision, an abandonment,
    `liveness_expired`, `chain_error`, every `release`, the `done` of an
    abandonment or a split) empties the list as today.

  `closedWork` is changed only by AC-1 and by the merge of AC-2. The
  table-driven test of spec 006 AC-27 (spec 040 AC-4, spec 085 AC-3) gains a
  variant with a closed-PR hold on the chain's branch and asserts, for every
  valid pair, whether the entry is carried, replaced, removed or kept
  through the rescue.
- AC-6. **Old records load.** Given a ledger or a claim without
  `closedWork`, when it is read, then it normalizes to `[]`; given a
  `heldWork` entry without `pr`, then it is a question hold or an incomplete
  run's hold as today. `schemas/scheduler/escalation-ledger.json` and
  `schemas/scheduler/claim.json` accept the new fields and reject a
  `closedWork` entry missing `pr`, `branch` or `head`.
- AC-7. **End to end.** Recorded worlds drive and assert, built on the
  abandonment chain of spec 006 AC-28:
  - a spec-track chain whose spec PR is abandoned: the abandonment comment
    names the PR and its head; `escalations/<n>.json` after `done` carries
    `closedWork` with the PR, `spec-<n>`, the head, a patch path and a
    time; the test removes the `abandoned` label on the mocked GitHub (the
    filer's retry); the loop claims the issue again; the spec stage's
    worktree `HEAD` is the closed PR's head, its input carries `held_work`
    naming the PR as AC-4 says and `history` is `(none)`; the log has
    `held-work-kept` for `spec-<n>` and no `recovered-commits` or
    `stale-branch-dropped` for it between the claim and the run; the stage
    pushes and returns `revised` with a PR that merges; `specRescues`,
    `fixes` and the history are fresh, and `closedWork` has no `spec-<n>`
    entry after the merge. This test fails on `main` before the change
    (`HEAD` at `origin/main`, `held_work` `(none)`);
  - an issue-track chain whose implementation PR is abandoned: `closedWork`
    names `issue-<n>`, the comment says a retried chain plans again, and
    after the retry the plan runs with no hold, the worktree at
    `origin/main` and `held_work` carrying the pointer of AC-4;
  - the spec stage of a retried chain fails twice with a closed-PR hold:
    the retry's and the rescue's `HEAD` are still the held head.

  Driver tests on the repo-pair setup assert AC-3's sources: the commit in
  the local repository (`source: "local"`); the commit absent locally and
  the bare origin holding `refs/pull/<n>/head` at it (`source: "pull"`);
  neither (`held-work-lost`, `HEAD` at `origin/main`, and `held_work` the
  pointer of AC-4 with the patch path). The existing abandonment, held-work
  and filer tests pass unchanged except where they assert the abandonment
  comment's text or the fresh ledger's presence.

## 4. Amendments to earlier specs

Each is marked in that spec's text in this PR (spec 039, ADR 0009); the
marks point here.

- **Spec 006 AC-5.** The closed PR's branch is saved as a patch and deleted,
  and its number, branch, head and patch are recorded for the retried chain;
  the comment names them (AC-1).
- **Spec 006 AC-7.** "starts with fresh counts" stands; the fresh ledger
  carries the closed PRs' pointers beside an unrecorded answer, and the
  retried chain holds the first stage's branch's work from them (AC-1,
  AC-2).
- **Spec 011 section 2.** "Keeping work across ... an abandonment" is no
  longer wholly out of scope: the spec or design work an abandonment closed
  is carried to the retried chain as a closed-PR hold (section 1); a release
  and a chain-error release keep today's rules.
- **Spec 011 AC-4.** With no hold kept and a closed PR recorded on the
  chain's branch, `held_work` names the PR, its head and the saved patch
  instead of being absent (AC-4).
- **Spec 011 AC-5.** A hold carrying a closed PR is fetched from
  `refs/pull/<pr>/head` before it is declared lost; `held-work-restored`
  gains `source: "pull"` (AC-3).
- **Spec 040 AC-4, spec 085 AC-1 and AC-2.** The `escalate` to a spec-track
  rescue of the spec stage keeps a closed-PR hold on `spec-<n>`, and the
  `escalate` to a design-track rescue of the design stage keeps one on
  `design-<n>`; every other clear stands (AC-5).

Spec 053 is not amended: a closed-PR hold has no `carried` field, and its
implement rules are untouched. Spec 005 is not amended: every patch it
names is still saved.

## 5. Interfaces and files

- `tools/scheduler/src/chain/types.ts`: `closedWork: ClosedWork[]` on
  `ChainState`, `ClosedWork = { pr: number; branch: string; head: string;
  patch: string | null; at: string | null }`; `pr?: number` on a `heldWork`
  entry.
- `tools/scheduler/src/chain/machine.ts`: `abandon()` sets `closedWork` and
  `abandonmentComment` renders its lines (AC-1); `LedgerCounts` and
  `ledgerOf` carry `closedWork` when non-empty; `initialChainState` sets
  `closedWork: []` and, seeded from a ledger, builds the closed-PR hold from
  `specProblem`, `designProblem` and the pending answer (AC-2); the merge
  transition removes the merged branch's entries (AC-2); `escalate` keeps a
  closed-PR hold into the spec-track and design-track rescue (AC-5);
  `normalizeChainState` defaults `closedWork` (AC-6).
- `tools/scheduler/src/chain/driver.ts`: the `close_pr` case fills `patch`
  and `at` in `claim.state.closedWork` (AC-1); the `done` case writes the
  fresh ledger with `closedWork` (AC-1); `keepHeldWork` fetches
  `refs/pull/<pr>/head` for a hold with `pr` before `held-work-lost`, and
  `setHeld` keeps `pr` (AC-3); `heldWorkText` gives the closed-PR sentences
  and the pointer (AC-4).
- `tools/scheduler/src/state/ledger.ts`: no change expected; `writeLedger`
  validates the new field through the schema.
- `schemas/scheduler/escalation-ledger.json`: optional `closedWork` array;
  `schemas/scheduler/claim.json`: `closedWork` on `state` and optional `pr`
  on a `heldWork` entry (AC-6).
- `agents/stages/spec.md`, `agents/stages/design.md`,
  `agents/stages/plan.md`, `agents/stages/implement.md`: the
  `{{held_work}}` line of AC-4, and nothing else in those files.
- `tools/scheduler/test/chain.test.ts`: AC-1's state and comment, AC-2's
  seeding (spec, design, record-mode and plan starts) and merge removal,
  AC-5 in the table-driven test, AC-6's normalization.
- `tools/scheduler/test/driver-1.test.ts` or
  `tools/scheduler/test/driver-2.test.ts`: AC-1's `close_pr` and `done`;
  AC-3's three sources (the spec 011 held-work tests are the models; the
  bare origin gains a `refs/pull/<n>/head` ref in the test); AC-4's texts.
- `tools/scheduler/test/helpers/`: what the chains of AC-7 need from the
  recorded worlds (removing the `abandoned` label on the mocked GitHub).
- `tools/scheduler/test/`: the end-to-end chains of AC-7, added to an
  existing `e2e-*.test.ts` file or a new one of that pattern (the directory is
  listed because the scope gate matches listed paths literally).
- `tools/scheduler/test/state.test.ts`, `tools/scheduler/test/schema.test.ts`,
  `tools/scheduler/test/stages.test.ts`: AC-6, and the prompt lines of AC-4
  where a test pins them.

The spec PR itself adds this file, marks specs 006, 011, 040 and 085 as
section 4 says and lists this spec under `## Children` in
`docs/delivery-system-design.md`.

`tools/scheduler/`, `agents/` and `schemas/` paths are listed above for the
scope gate; the security review applies to the implementation PR where they
are sensitive (spec 006 AC-9). The change adds a record and a restore of the
chain's own closed PR. It does not change the sensitive-path list, the
security review criteria or instructions, what routes a sensitive diff to
the security review, that both reviews must approve, that a sensitive path
must be listed in the spec, or any bound. The driver fetches only
`refs/pull/<pr>/head` of a PR the scheduler itself closed for this issue and
pushes nothing; the stage's push and PR go through the gates as today.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The first AC-7 chain fails on `main` before the change and passes after
  it; the existing abandonment and held-work tests pass with only the
  comment-text and fresh-ledger assertions changed.
- `grep -n "closedWork" tools/scheduler/src/chain/machine.ts
  tools/scheduler/src/chain/driver.ts` prints the record at `abandon()`, the
  seeding, the merge removal, the `close_pr` fill, the `done` write and
  `heldWorkText`.
- Live check after deploy, recorded in the PR: the next abandonment of a
  spec-track chain shows, in the issue's comment, the closed PR and its
  head, and `escalations/<n>.json` carries `closedWork`; when the filer
  retries the issue, the service log shows `held-work-kept` for `spec-<n>`
  and the spec run's input carries `held_work` naming the PR, with no
  `recovered-commits` for the branch. If no abandonment occurs before the PR
  is reviewed, the recorded chains of AC-7 stand in for it, and the PR says
  so.

## 7. Open decisions

None.
