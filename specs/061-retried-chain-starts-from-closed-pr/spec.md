# 061. A chain retried after abandonment starts from the closed PR's saved work

Status: written 2026-11-14 from the delivery-system design for issue #116;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the terminal state is abandonment "with the full record", left
open "for spec C to re-triage", and "C's re-triage is the recovery path";
after a rescue fails "the issue is planned again from scratch", which this
spec keeps) and section 10 ("Small work skips layers": a bug spec hangs
directly off a top design);
[005-keep-unpushed-commits](../005-keep-unpushed-commits/spec.md) (the
`closed-pr` patch is saved so the work is not lost; this spec hands it on);
[006-no-human-stops](../006-no-human-stops/spec.md) AC-5 (the abandonment
closes the PR, saves its branch as a patch and deletes it; its first bullet
is amended as section 4 records) and AC-7 (the ledger is archived at
abandonment and a re-claim "starts with fresh counts"; an unrecorded answer is
carried into the fresh ledger, the shape this spec reuses; amended as
section 4 records);
[011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
(held work: the hold, its restoration and the `held_work` input; its
section 2, AC-4 and AC-5 are amended as section 4 records),
[040-held-work-per-branch](../040-held-work-per-branch/spec.md) (holds per
branch; its AC-4 is amended as section 4 records) and
[053-incomplete-implement-run-keeps-its-work](../053-incomplete-implement-run-keeps-its-work/spec.md)
(a *carried* hold, the work of an earlier attempt rather than of a stage that
asked; this spec adds a second kind of carried hold);
[060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
(the fix for the failure that abandoned issues #39 and #49; this spec is
about what a retried chain is given when an abandonment does happen).

## 1. Goal

When the findings filer retries an abandoned issue (its `retry` outcome
removes the `abandoned` label, spec 006 AC-5), the new chain starts where the
old one's pull request stopped, not from nothing. The spec PR (or design PR)
that the abandonment closed is restored on the chain's branch before the
first stage runs, the stage is told whose work it is and why the issue was
abandoned, and the issue's abandonment comment names what was kept. The
counts stay fresh, as spec 006 AC-7 says: this spec carries work, not
failures.

### What is wrong today (spec agent's reading of the code and the records, 2026-11-14)

`abandon()` in `tools/scheduler/src/chain/machine.ts` emits `close_pr` for
the open PR (and a parked issue PR), then `comment`, `label`, `finding`,
`notify` and `done`. The driver's `close_pr` case saves the branch's commits
as a `closed-pr` patch, comments, closes the PR and deletes the branch on
GitHub; its `done` case saves the worktree's leftovers, archives the ledger
and, only when an answer is not yet recorded on `main`, writes a fresh ledger
carrying that answer (spec 006 AC-7, "Tm4"). Nothing records the closed PR's
head. The filer's retry (`tools/scheduler/src/filer/apply.ts`) comments
`Retry: <reason>` and removes the label. The next claim reads the fresh
ledger (or none), `initialChainState` seeds nothing but counts, and the spec
stage's preparation (`syncWorktree`) resets `spec-<n>` to `origin/main`; the
stage input's history is `(none)` and `held_work` is `(none)`.

Issue #39: PR #105 held the finished spec 030 at `7080e8c`; the abandonment
on 2026-11-01 at 09:03Z closed it, deleted `spec-39` and saved the patch.
The retried run `39-spec-1-20261101T092316` was told only that
`specs/030-beyond-github/spec.md` was not on `main`; it found the spec
through a stale remote-tracking ref in the worktree and an earlier run's
`result.json`, neither of which the pipeline promises. Issue #49 is in the
same position: PR #113's spec sits at `3bdc478` in a `closed-pr` patch.

### The fix

Three small pieces, each on a path that exists:

1. **Record.** The abandonment records every PR it closes (`pr`, `branch`,
   `head`, the saved patch's path, the time) in the fresh ledger it writes
   at `done`, beside an unrecorded answer, and the abandonment comment names
   each closed PR, its head and that a retried chain starts from it.
2. **Restore.** The claim that follows a retry reads the ledger as today.
   The entry whose branch is the branch of the chain's first stage becomes a
   carried hold (spec 053's `carried` field, plus the PR number). The
   preparation of spec 011 then restores the branch at the closed PR's head,
   from the local object store when the commit is still there, otherwise
   from `refs/pull/<pr>/head`, which GitHub keeps for a closed PR. Nothing is
   pushed by the driver; the stage pushes, as it does for held work.
3. **Tell.** The stage's `held_work` input says this is the earlier chain's
   PR, closed at abandonment, at a head that builds on an older `main`, and
   where the abandonment record and the retry's reason are (the issue's
   comments). When neither source has the commit, the input still names the
   PR, the head and the patch path, so the stage can recover by hand instead
   of guessing.

*(agent's call)* The restore reuses held work rather than replaying the
patch: a spec PR edits its parent design's `## Children` section, which
changes on every spec merge, so `git am` of the patch onto a moved `main`
would conflict in nearly every case, while a branch at the old head is what
every other hold is, and the stage checks it against `main` as spec 053's
carried hold is checked against the plan. Only the first stage's branch is
restored: an issue-track PR (`issue-<n>`) is recorded and named but not
restored, because design section 4 says a failed rescue is "planned again
from scratch" and the retried chain's plan is new. The pointer lives in the
ledger because the claim already reads it and spec 006 AC-7 already carries
an unrecorded answer the same way; the record is small and reversible, so no
ADR (design section 3, item 2).

## 2. Out of scope

- The filer: its `retry` decision, comment and label removal are unchanged.
  The retried stage reads the retry's reason from the issue's comments, where
  the filer already puts it.
- Restoring an issue-track PR's work (`issue-<n>`, the chain's PR or a parked
  one) for the retried chain's plan or implement. It is recorded and named
  (AC-1), not restored (AC-2).
- The abandonment's other steps: the label, the finding, the notification,
  the archived ledger and its counts, the `issue_abandoned` event (spec 006
  AC-5, AC-7). A retried chain still starts with fresh counts and an empty
  history.
- Which transitions clear a hold, beyond the one carve-out of AC-5: spec 011
  AC-7 and spec 040 AC-4 stand.
- Replaying a saved patch (spec 005 section 2); the `closed-pr`,
  `recovered-commits` and `stale-branch` patches are saved as today.
- A spec PR closed to revise the spec (`designToSpecRevise`) or by a re-plan:
  those are discards by design and record nothing here.
- The console (spec 051) and the question path: unchanged.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the recorded
worlds of `tools/scheduler/test/helpers/e2e-routes.ts`, and the unit tests of
`tools/scheduler/test/chain.test.ts`, `driver.test.ts` and `loop.test.ts`.

**Definitions.** *Closed work* is the field `closedWork` of `ChainState` and
of the ledger: a list of `{ pr, branch, head, patch, at }` entries (`pr` the
PR number, `branch` its head branch, `head` its head SHA when closed, `patch`
the saved `closed-pr` patch path or `null`, `at` the abandonment's ISO time),
empty when there is none. A *closed-PR hold* is a `heldWork` entry (spec 040)
with `carried` set to a text naming the closed PR and `pr` set to its number.
The *first stage's branch* of a new chain is `spec-<n>` when the chain starts
at the spec stage (a spec problem, spec 006 AC-19), `design-<n>` when it
starts at the design stage (a design problem, spec 029), and `issue-<n>`
otherwise.

- AC-1. **The abandonment records what it closed.** Given `abandon()` emits
  one or more `close_pr` actions, then the abandoned state's `closedWork`
  holds one entry per closed PR (`pr`, `branch`, `head` from the state's
  `pr` or `parkedPr`, `patch: null`, `at` the step's time), and the
  abandonment comment gains, after the bounds line, one line per entry:
  `PR #<pr> (<branch> at <head>) is closed, not lost: its commits are saved
  as a patch in the scheduler state directory, and a chain retried after this
  abandonment starts from it.` (for `issue-<n>`: `...; a retried chain is
  planned again from scratch and may read it.`). When the driver applies the
  `close_pr` action it fills the matching entry's `patch` with the path
  `savePatch` returned, in the claim's state, before it closes the PR. When
  the driver applies the abandonment's `done`, then after archiving the
  ledger it writes the fresh ledger whenever `closedWork` is non-empty or an
  answer is pending, carrying both (`{ ...ledgerOf(initialChainState(issue)),
  pendingAnswer, closedWork }`); given neither, no fresh ledger is written,
  as today. A crash between `close_pr` and `done` loses at most a `patch`
  path, never an entry: the entries are in the state the claim file holds.
- AC-2. **The retried claim carries it as a hold.** Given a claim whose
  ledger carries `closedWork`, when `initialChainState` seeds from the
  ledger, then the state's `closedWork` is the ledger's list, and `heldWork`
  holds one closed-PR hold `{ branch, head, carried: "closed PR #<pr>,
  abandoned <at>", pr }` for the entry whose `branch` is the first stage's
  branch, when there is one; every other entry stays a pointer in
  `closedWork` only. Given no such entry (the closed PRs were on other
  branches), then `heldWork` is empty as today. `ledgerOf` carries
  `closedWork` (written only when non-empty, like `blocks`), so the
  chain's ledger writes keep it for the chain's life; the next abandonment's
  fresh ledger replaces it.
- AC-3. **The preparation restores the branch.** Given a closed-PR hold on
  the chain's branch and no PR bound, when the first stage is prepared
  (`syncWorktree`, through `keepHeldWork`), then:
  - given the held head exists in the worktree's repository, the branch is
    put at it as spec 011 AC-5 says (`held-work-restored`, `source:
    "local"`), and the preparation ends with `held-work-kept`;
  - given it does not, and the fetch of `refs/heads/<branch>` finds no such
    ref (the abandonment deleted it), then before `held-work-lost` the driver
    fetches `refs/pull/<pr>/head` from origin; given that ref resolves to the
    held head, the branch is put at it and the log carries
    `held-work-restored` with `source: "pull"`, then `held-work-kept`; given
    the ref is missing or resolves to another commit, or the fetch fails for
    the ref being missing, then `held-work-lost` is logged, the hold is
    removed as spec 040 AC-5 says, and the preparation continues as without
    held work (a reset to `origin/main`; no `stale-branch-dropped`, since the
    branch is not on origin). A fetch that fails for any other reason fails
    the step, as spec 011 AC-5 says.
  Nothing is pushed by the driver, and `recovered-commits` is not written
  for the restored commits. The restored branch builds on an older
  `origin/main`; the spec and design stages are never rebased by the driver
  (spec 006 section 4), the stage pushes the branch, and the PR's merge path
  (spec 024) rebases as for any PR. A hold whose head is already reachable
  from `origin/main` is nothing to keep (spec 011 AC-5); the stage runs as
  without held work.
- AC-4. **The stage is told.** Given a closed-PR hold kept by AC-3 and the
  worktree's `HEAD` at its head, when the spec or design stage runs, then its
  `held_work` input names the branch, the head, whether it is on origin and
  the open PRs from it as spec 011 AC-4 says, and in place of the closing
  sentence says: this is the work of this issue's earlier chain, PR #<pr>,
  closed (not merged) when the issue was abandoned on <at>; it builds on an
  older `origin/main`; the issue's comments hold the abandonment record and
  the retry's reason (`gh issue view <n> --comments`); check the work against
  the issue, its parent design and `main` as it is now, and continue from it
  rather than writing it again. Given a closed-PR hold the preparation lost
  (AC-3's last case), then `held_work` is not absent: it reads `The earlier
  chain's PR #<pr> (<branch> at <head>, closed at abandonment on <at>) could
  not be restored on this branch; its commits are saved as a patch at <patch>
  on this machine` (or `; no patch was saved` when `patch` is null), followed
  by the same instruction to read the issue's comments and continue from the
  work. The text is built from `closedWork`, which still holds the entry. The
  `{{held_work}}` line of `agents/stages/spec.md` and `agents/stages/design.md`
  reads as the work of an earlier run of this issue (before a question, or
  of a chain abandoned and retried), as spec 053 AC-6 did for implement.
- AC-5. **What clears it.** Given a closed-PR hold, then it is removed when a
  PR binds on its branch (spec 040 AC-2), it survives the spec or design
  stage's failure (the stage is not an asking stage, so spec 040 AC-3 does not
  drop it today, and this spec keeps that) and a quota postponement, and it
  is carried into the spec-track rescue of that stage (the `escalate` to a
  rescue keeps a closed-PR hold on the chain's branch, as spec 053 AC-2 keeps
  a carried `issue-<n>` hold into an implement rescue); every other clear of
  spec 040 AC-4 (a spec revision, an abandonment, `liveness_expired`,
  `chain_error`, every `release`, the `done` of an abandonment or a split)
  empties the list as today. `closedWork` itself is never cleared by a
  transition. The table-driven test of spec 006 AC-27 gains a variant with a
  closed-PR hold on the chain's branch and asserts, for every valid pair,
  whether the entry is carried, removed or kept through the rescue.
- AC-6. **Old records load.** Given a ledger, claim or paused record without
  `closedWork`, when it is read, then it normalizes to `[]`; given a
  `heldWork` entry without `pr`, then it is a question hold or an incomplete
  run's hold as today (spec 053 AC-7). `schemas/scheduler/escalation-ledger.json`
  and `schemas/scheduler/claim.json` accept the new fields and reject an
  entry missing `pr`, `branch`, `head` or `at`.
- AC-7. **End to end.** Recorded worlds drive and assert, built on the
  abandonment chain of spec 006 AC-28:
  - a spec-track chain whose spec PR is abandoned: the abandonment comment
    names the PR and its head; `escalations/<n>.json` after `done` carries
    `closedWork` with the PR, `spec-<n>`, the head and a patch path; the test
    removes the `abandoned` label on the mocked GitHub (the filer's retry);
    the loop claims the issue again; the spec stage's worktree `HEAD` is the
    closed PR's head, its input carries `held_work` naming the PR as AC-4
    says and `history` is `(none)`; the log has `held-work-restored`
    (`source: "local"`, the fixture's object store still holds the commit)
    and no `recovered-commits` or `stale-branch-dropped` for `spec-<n>`
    between the claim and the run; the stage pushes and returns `revised`
    with a PR that merges; `specRescues`, `fixes` and the history are fresh.
    This test fails on `main` before the change (`HEAD` at `origin/main`,
    `held_work` `(none)`);
  - the same with the commit pruned from the fixture's repository before the
    re-claim: the restore comes from `refs/pull/<pr>/head` on the mocked
    origin (`source: "pull"`); the fake origin provides that ref for a closed
    PR as GitHub does (the test helper gains it);
  - the same with neither source: `held-work-lost`, `HEAD` at `origin/main`,
    and `held_work` naming the PR, the head and the patch path;
  - an issue-track chain whose implementation PR is abandoned: `closedWork`
    names `issue-<n>`, the comment says the retried chain is planned again
    from scratch, and after the retry the plan runs with no hold and
    `held_work` `(none)`;
  - the spec stage of a retried chain fails once with a closed-PR hold: the
    retry's `HEAD` is still the held head (`held-work-kept`).
  The existing abandonment, held-work and filer tests pass unchanged except
  where they assert the abandonment comment's text or the fresh ledger's
  presence.

## 4. Amendments to earlier specs

Each is marked in that spec's text in this PR (spec 039, ADR 0009); the
marks point here.

- **Spec 006 AC-5, first bullet.** The closed PR's branch is saved as a patch
  and deleted, and its number, branch, head and patch are recorded for the
  retried chain (AC-1).
- **Spec 006 AC-7.** "starts with fresh counts" stands; the fresh ledger
  carries the closed PRs' pointers beside an unrecorded answer, and the
  retried chain holds the first stage's branch's work from them (AC-1, AC-2).
- **Spec 011 section 2.** "Keeping work across ... an abandonment" is no
  longer wholly out of scope: the work the abandonment closed is carried to
  the retried chain as a closed-PR hold; a release and a chain-error release
  keep today's rules.
- **Spec 011 AC-4.** For a closed-PR hold the preparation could not restore,
  `held_work` names the PR, its head and the saved patch instead of being
  absent (AC-4).
- **Spec 011 AC-5.** A hold carrying a closed PR is fetched from
  `refs/pull/<pr>/head` before it is declared lost; `held-work-restored`
  gains `source: "pull"` (AC-3).
- **Spec 040 AC-4.** The `escalate` to a spec-track rescue of the spec or
  design stage keeps a closed-PR hold on the chain's branch; every other
  clear stands (AC-5).

Spec 053 is not amended: its `carried` field is reused with the same meaning
(the work of an earlier attempt), and its implement rules are untouched. Spec
005 is not amended: every patch it names is still saved.

## 5. Interfaces and files

- `tools/scheduler/src/chain/types.ts`: `closedWork: ClosedWork[]` on
  `ChainState`, `ClosedWork = { pr: number; branch: string; head: string;
  patch: string | null; at: string }`; `pr?: number` on a `heldWork` entry.
- `tools/scheduler/src/chain/machine.ts`: `abandon()` sets `closedWork` and
  the comment's lines (AC-1; `abandonmentComment` takes the entries);
  `LedgerCounts` and `ledgerOf` carry `closedWork` when non-empty;
  `initialChainState` sets `closedWork: []` and `seedFromLedger` builds the
  closed-PR hold for the first stage's branch (AC-2; the first stage's
  branch follows from `specProblem` and `designProblem`); `escalate` keeps a
  closed-PR hold on the chain's branch into a spec-track rescue (AC-5);
  `normalizeChainState` defaults `closedWork` (AC-6).
- `tools/scheduler/src/chain/driver.ts`: the `close_pr` case fills `patch`
  in `claim.state.closedWork` (AC-1); the `done` case writes the fresh
  ledger with `closedWork` (AC-1); `keepHeldWork` fetches
  `refs/pull/<pr>/head` for a hold with `pr` before `held-work-lost` (AC-3);
  `heldWorkText` gives the closed-PR sentences and the lost-hold text from
  `closedWork` (AC-4).
- `tools/scheduler/src/state/ledger.ts`: no change expected; `writeLedger`
  validates the new field through the schema.
- `schemas/scheduler/escalation-ledger.json`: optional `closedWork` array;
  `schemas/scheduler/claim.json`: `closedWork` on `state` and optional `pr`
  on a `heldWork` entry (AC-6).
- `agents/stages/spec.md`, `agents/stages/design.md`: the `{{held_work}}`
  line of AC-4. `agents/` is a sensitive path; the diff touches no bound.
- `tools/scheduler/test/chain.test.ts`: AC-1's state and comment, AC-2's
  seeding (spec, design and issue first stages), AC-5 in the table-driven
  test, AC-6's normalization.
- `tools/scheduler/test/driver.test.ts`: AC-1's `close_pr` and `done` on the
  repo-pair setup; AC-3's three sources (the spec 011 held-work tests are the
  models; the bare origin gains a `refs/pull/<n>/head` ref in the test);
  AC-4's two texts.
- `tools/scheduler/test/helpers/e2e-routes.ts`: the mocked `closePullRequest`
  records `refs/pull/<n>/head` on the fixture origin; a way to remove the
  `abandoned` label and to prune a commit from the fixture repository.
- `tools/scheduler/test/e2e.test.ts`: the chains of AC-7.
- `tools/scheduler/test/state.test.ts`, `schema.test.ts`: AC-6.
- `specs/006-no-human-stops/spec.md`, `specs/011-asking-stage-keeps-its-work/spec.md`,
  `specs/040-held-work-per-branch/spec.md`: the marks of section 4.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `schemas/` are sensitive paths; the
security review applies to the implementation PR (spec 006 AC-9). The change
adds a record and a restore of the chain's own closed PR; it does not change
the sensitive-path list, the security review criteria or instructions, what
routes a sensitive diff to the security review, that both reviews must
approve, that a sensitive path must be listed in the spec, or any bound. The
driver fetches only `refs/pull/<pr>/head` of a PR the chain itself closed and
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
  seeding, the `close_pr` fill, the `done` write and `heldWorkText`.
- Live check after deploy, recorded in a follow-up finding if not seen
  within two weeks: the next abandonment of a spec-track chain shows, in the
  issue's comment, the closed PR and its head; `escalations/<n>.json` carries
  `closedWork`; and when the filer retries the issue, the service log shows
  `held-work-restored` for `spec-<n>` and the spec run's input carries
  `held_work` naming the PR, with no `recovered-commits` for the branch.

## 7. Open decisions

None.
