# 005. Commits about to be discarded are saved as a patch

Status: approved by the maintainer 2026-10-16.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [001-scheduler-core](../001-scheduler-core/spec.md) sections
11 and 16 (AC-15, AC-16, AC-24); the branch review's residual R4.

## 1. Goal

Before a plan or implement stage with no pull request, the driver resets
the worktree to `origin/main`; when a pull request exists, it syncs the
worktree to the branch's remote head and, if the two have diverged, the
remote wins. Both paths can discard local commits (an implement attempt
that committed but never pushed, or local work that diverged from a push
made elsewhere). Uncommitted work is already saved as a patch under
`patches/`; discarded commits must be saved the same way, so nothing the
pipeline produced is lost silently.

## 2. Out of scope

Replaying saved patches automatically, changing when the worktree is reset
or synced, and the branch-rebase path (a conflict there aborts the rebase
and discards nothing).

## 3. Acceptance criteria

AC-1. Given a worktree whose `HEAD` has commits that `<base>` does not,
when `commitsPatch(worktree, base, head = "HEAD")` is called, then it
returns the output of `git format-patch --stdout <base>..<head>`; given no
such commits, it returns an empty string.

AC-2. Given a claim with no pull request whose worktree carries a commit
not on `origin/main`, when the next stage is prepared, then before the
reset a patch of those commits is written under `patches/` through the
existing `savePatch`, a log record `{ kind: "recovered-commits", issue,
patch, base: "origin/main" }` is written, and the worktree then starts
from `origin/main` as today.

AC-3. Given a claim with a pull request whose worktree has diverged from
`origin/issue-N`, when the next stage is prepared, then after the sync a
patch of the commits reachable from the dropped local head but not from
the remote head is written under `patches/` through `savePatch`, and the
existing `worktree-synced` record additionally names that patch path
(`patch` field, null when nothing was dropped).

AC-4. Given the reset or sync would discard nothing, when the next stage is
prepared, then no patch file is written and no `recovered-commits` record
appears.

## 4. Interfaces and files

- `tools/scheduler/src/runner/worktree.ts`: `commitsPatch(worktree, base, head?)`.
- `tools/scheduler/src/chain/driver.ts`: the worktree preparation (the `syncWorktree` helper) calls it before `resetToBase` and after a `syncToRemote` that dropped a head, saving through `savePatch` and logging as above.
- `tools/scheduler/test/worktree.test.ts`: tests for AC-1.
- `tools/scheduler/test/driver.test.ts`: tests for AC-2, AC-3 and AC-4 built on the file's existing repo-pair setup (the C1 "stray commit" test and the R1 "moved PR head" test are the models; the R1 test needs a diverged local commit added to cover AC-3).

No other file is created or modified.

## 5. Verification

`pnpm install --frozen-lockfile` then `pnpm test` from the repository root
pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
clean. A saved patch applies with `git am` onto the base it was taken
from; the AC-1 test asserts that.

## 6. Open decisions

None.
