# 024. A rebase respects a branch that merged main

Status: written 2026-10-31 from the delivery-system design for the abandonment
of issue #15 (PR #77); specs derived from that design need no maintainer
approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain with no human stops, and its per-issue bounds, which this
spec does not change) and section 10 ("Small work skips layers": a bug spec
hangs directly off a top design);
[001-scheduler-core](../001-scheduler-core/spec.md) AC-16 and C1;
[006-no-human-stops](../006-no-human-stops/spec.md) AC-1 and its valid-events
list; [015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md) AC-1;
amends 001 AC-16 and 006's valid events as section 4 records.

## 1. Goal

A conflict that is not there costs no fix, and a fix that resolves nothing is
not counted as a success.

### What happens today (observed live 2026-10-31)

PR #77 on issue #15 held commit d9150ff, a merge of main into `issue-15`.
`rebaseOntoMain` ran a plain `git rebase` before the review, which linearises
past a merge and raised again the conflict that merge had resolved
(`tools/scheduler/src/filer/apply.ts`). The chain went to fix, told to rebase
and resolve. Both fix runs (`15-fix-1-20261031T172909`,
`15-fix-1-20261031T173347`) saw that the branch already contains origin/main
and returned the unchanged head 5b84968 with `addressed: [0, 1]`. The machine
counted each as a successful fix and cleared `conflictPending`, verify passed,
and the next review's rebase raised the same conflict. At `MAX_FIXES` the
escalation path, already spent, abandoned the issue at 17:38:25Z, and its
history had no entry saying a rebase was the cause.

## 2. Out of scope

- The per-issue bounds of design section 4 and `MAX_FIXES`: their values, and
  what a rescue, a re-plan and a spec revision are.
- Restoring issue #15; the abandoned issue's re-triage is spec C's.
- `commitsPatch` omitting merge commits (`git format-patch` skips them, so a
  saved patch loses a merge's conflict resolution).
- A fix that returns a new head and still does not end the conflict: the next
  stage's rebase raises it again and `MAX_FIXES` bounds it, as today.
- Refreshing the conflict detail in a retry's input when main moved between
  runs; the agent runs the merge or rebase itself and sees the real conflict.

## 3. Acceptance criteria

"Given" states use real git in the repo-pair setup, the fake harness and a
mocked GitHub API, as in the worktree and driver tests.

- AC-1. **A head holding main is not rebased.** Given `origin/main` is an
  ancestor of `HEAD`, when `rebaseOntoMain` runs, then no rebase happens, `HEAD`
  and any merge commit in the branch stay, and it returns `{ ok: true, moved:
  false }`.
- AC-2. **A branch holding a merge is not linearised.** Given `origin/main..HEAD`
  holds a merge commit and `origin/main` is not an ancestor of `HEAD`, then no
  rebase happens and nothing is changed: `git merge-tree --write-tree` judges
  merging main into `HEAD`. A clean merge returns `{ ok: true, moved: false }`,
  so such a branch runs its stage without main's newest commits (the diffs the
  gates and review judge are against the merge base either way, and GitHub
  judges mergeability at the merge stage). A conflict returns `{ ok: false,
  conflict }` and the chain goes to fix as AC-16 says. A merge only on main's
  side does not count: a linear branch rebases as before.
- AC-3. **An unchanged head does not resolve a conflict.** Given
  `conflictPending` and a fix result with no escalation whose `head_sha` equals
  `pr.head_sha`, then the run is a failed fix: `fixes` is not counted,
  `conflictPending` stays, and the failure takes the existing fix-failure path
  (a rescue, and for a failed rescue the PR closes and the issue is planned
  again). The next run's input says the head came back unchanged, names it, and
  says the conflict is real. Every conflict's fix input says that resolving it
  means a new head containing origin/main, and that a branch already holding a
  merge of main takes another merge, not a rebase. An unchanged head with no
  conflict pending is an ordinary fix, as a fix may be told to change nothing.
- AC-4. **No agent is told about a conflict that is gone.** Given a fix about
  to run with `conflictPending` and no held work on the PR's branch, then the
  driver runs `rebaseOntoMain` after the sync. A conflict leaves the worktree as
  it was and the fix runs (001 C1). Otherwise any rebase it made is reset, `{
  kind: "conflict-gone", issue, head }` is logged, no agent runs, and the event
  `conflict_gone` is raised, valid only in `fix` with `conflictPending`. It
  clears `conflictPending`, adds a history entry, and goes to verify with
  `fixes` one higher and `rescueRun` cleared (a rescue already counted stays
  counted). The round is spent so that a conflict that keeps coming and going
  still reaches `MAX_FIXES`. Given the fix still owes work (`recordAnswer`,
  `recordIds`, `answer` or `decideInput`), it runs instead with an input saying
  the conflict is gone, and nothing is counted until it ends.
- AC-5. **The record explains itself.** Every `rebase_conflict` adds a history
  entry naming the stage, the head and the conflict's detail, so the rescue's
  history and the abandonment comment show it.
- AC-6. **Termination.** A chain whose every review raises a conflict and whose
  every fix returns the unchanged head, and one whose every fix finds
  `conflict_gone`, both end `abandoned` with each bound of design section 4 at
  its existing value (the test drives both).

## 4. Amendments to earlier specs

- Spec 001 AC-16: "the worktree is rebased first" does not apply to a branch
  AC-1 or AC-2 covers, and C1's "skips the rebase while a conflict is pending"
  now reads: runs it only to check that the conflict is real (AC-4).
- Spec 006, valid events: adds `conflict_gone` (AC-4).

## 5. Interfaces and files

- `tools/scheduler/src/runner/worktree.ts`: `rebaseOntoMain`, `mergeConflict`.
  `git merge-tree --write-tree` needs git 2.38 or later.
- `tools/scheduler/src/chain/machine.ts`: `conflictUnresolved`, `conflictGone`,
  the `rebase_conflict` history entry and fix input.
- `tools/scheduler/src/chain/types.ts`: the `conflict_gone` event.
- `tools/scheduler/src/chain/driver.ts`: the check before a conflict-pending fix.
- Tests: `tools/scheduler/test/worktree.test.ts` (AC-1, AC-2),
  `chain.test.ts` (AC-3 to AC-6), `driver.test.ts` (AC-1, AC-3 to AC-5).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/` and `docs/delivery-system-design.md` are sensitive paths; the
security review applies (spec 006 AC-9).

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-1 tests and the AC-3 chain tests fail on `main`.
- Live check after deploy: the next PR holding a merge of main logs no
  `rebase_conflict` transition while main stays its ancestor.

## 7. Open decisions

None.
