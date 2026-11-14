# 040. Held work is kept per branch

Status: written 2026-11-06 from the delivery-system design for issue #68;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 ("What happens while it waits": on a reply the work "resumes where
it stopped") and section 10 ("Small work skips layers": a bug spec hangs
directly off a top design);
[011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md),
whose goal this spec completes and whose Definitions paragraph, AC-1, AC-2,
AC-5, AC-6, AC-7, AC-9 and section 5 it amends, each marked as section 4
records; consistent with [006-no-human-stops](../006-no-human-stops/spec.md)
AC-14 (a second question from the same stage goes to the check again) and
AC-18 (the `record` route) and with
[005-keep-unpushed-commits](../005-keep-unpushed-commits/spec.md) (every
discard still saves a patch).

## 1. Goal

Work a stage left when it asked a question is kept until a PR is bound on
its branch or the attempt is discarded, on every branch the chain holds
work on at once. Today the chain can hold work on only one branch, so the
one path that holds work on two drops the first.

### What is wrong today

Spec 011 made `heldWork` a single `{ branch, head } | null`. Spec 006 AC-18
routes a product or technical answer to an implement (or plan) question
through the spec stage in `record` mode on `spec-<n>`, while the implement
work waits on `issue-<n>` as held work; spec 011 AC-6 keeps `issue-<n>`
alone during that route. Spec 006 AC-14 allows the spec stage to ask a
question of its own there. When it does (`tools/scheduler/src/chain/machine.ts`,
`heldPatch`), spec 011 AC-1's replacement rule sets `heldWork` to
`{ branch: "spec-<n>", head }`: the record of the issue branch's hold is
gone. The spec stage's question is checked, answered and the revised spec
binds a PR on `spec-<n>`, which clears `heldWork` (AC-7, `unholdIfBound`).
After the spec PR merges, the `delete_branch` action
(`tools/scheduler/src/chain/driver.ts`) finds no hold naming `issue-<n>` and
checks it out from `origin/main`; plan's preparation (`syncWorktree`) then
finds a branch on origin with no PR and no hold, and spec 006 AC-21's
failed-attempt rule applies: the commits are saved as a `stale-branch`
patch, any open PR is closed and the branch is deleted on GitHub. The
maintainer answered the question that work raised, and the work survives
only as a patch nobody replays.

The path is rare (a question inside the recording of an answer) but
reachable, and every step of it is behaviour a spec asked for; the flaw is
the shape of the record.

### The fix

`heldWork` becomes a list of holds, at most one per branch. A question holds
the chain's branch and leaves the other branches' holds as they are; a PR
bound on a branch releases that branch's hold only; the asking stage's
failure drops its own branch's hold only; the transitions that discard the
attempt (escalations, liveness, chain errors, releases, abandonment) clear
every hold, as spec 011 AC-7 already says. The driver already looks up held
work by branch everywhere it reads it; each lookup becomes "the hold on
this branch", and a hold the preparation cannot keep is removed on its own.
Old claims and paused records normalize into the list.

*(agent's call)* A list keyed by branch was chosen over a fixed pair of
fields (an issue hold and a spec hold) because the design track
(`design-<n>`, spec 029) asks questions through the same `heldPatch`, so a
fixed pair would be three fields, and over leaving the spec stage's own
work unheld in record mode (the second direction the issue suggests)
because spec 011's goal is that *every* asking stage keeps its work; the
spec stage's half-written recording would otherwise be patched and reset
before its question check. The change is small and reversible (one field's
shape, a normalizer and the lookups that read it), so it is not an ADR
(design section 3, item 2).

## 2. Out of scope

- Which transitions clear held work. Spec 011 AC-7's list stands: this spec
  changes only *which* holds a transition clears (one branch's or all),
  never *whether* it clears. In particular a spec-track escalation (a spec
  rescue or revision) while `issue-<n>` holds work still clears every hold,
  as a rescue starts again by design (spec 011 section 2).
- The `held_work` input of a stage (spec 011 AC-4): it still names the
  chain's branch's hold only. A stage is never told about another branch's
  hold.
- The `held` patch, the `held-work`, `held-work-kept`, `held-work-advanced`,
  `held-work-restored` and `held-work-lost` log records: their fields are
  unchanged; each names one branch, as today.
- Replaying a saved patch (spec 005 section 2), uncommitted changes at the
  moment a stage asks (spec 011 section 2), and the design track's own
  question handling beyond what the list gives it for free.
- The stage prompts under `agents/` and `schemas/scheduler/stage-input.json`:
  unchanged.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.

**Definitions.** The chain's *holds* are the field `heldWork` of
`ChainState`: a list of `{ branch, head }` entries with at most one entry
per branch, empty when the chain holds nothing. The *hold on a branch* is
the entry naming that branch; "the chain holds work on a branch" means such
an entry exists. `branch` and `head` mean what spec 011 AC-1 says. The
*chain's branch* is `branchOf(state)` (`issue-<n>`, `spec-<n>` or
`design-<n>`).

- AC-1. **A question holds the chain's branch and leaves the others.**
  Given a chain on the spec track in `record` mode holding work on
  `issue-<n>`, when the spec result carries a `question` (of any kind,
  including `other`, which goes straight to decide mode) and the driver's
  `stage_ok` carries `head`, then the new state's holds are the `issue-<n>`
  entry unchanged and a `spec-<n>` entry at that head, in that order (a new
  hold is appended). Given the chain already holds work on its own branch
  (a follow-up or a second question from the resumed stage), then that
  entry's head is replaced in place and every other entry is unchanged. The
  same holds for the design track and for plan, implement and fix on the
  issue track. A `stage_ok` on the question path without `head` still
  throws (spec 011 AC-1); a `review` question still holds nothing.
- AC-2. **A bound PR releases its branch's hold only.** Given holds on
  `issue-<n>` and `spec-<n>`, when a spec `revised` result binds a PR on
  `spec-<n>`, then the `spec-<n>` entry is removed and the `issue-<n>` entry
  stays. Given the same holds, when an implement result on the issue track
  binds a PR on `issue-<n>`, then the `issue-<n>` entry is removed and the
  `spec-<n>` entry stays. A PR bound on a branch no hold names changes
  nothing (as `unholdIfBound` does today for a hold elsewhere).
- AC-3. Amended by [053-incomplete-implement-run-keeps-its-work](../053-incomplete-implement-run-keeps-its-work/spec.md) AC-2: an incomplete implement run's failure replaces the `issue-<n>` hold with a carried entry instead of dropping it. **The asking stage's failure drops its branch's hold only.** Given
  holds on `issue-<n>` and `spec-<n>` and a chain on the spec track whose
  asking stage is `spec`, when the spec stage fails other than by a quota
  postponement, or returns a question not marked `new_blocker` in decide
  mode (spec 006 AC-14), then the `spec-<n>` entry is removed and the
  `issue-<n>` entry stays. The failure of a stage that is not the asking
  stage, the question check's first failure and its retry, and a quota
  postponement carry every hold unchanged, as spec 011 AC-7 says.
- AC-4. Amended by [061-retried-chain-starts-from-closed-pr](../061-retried-chain-starts-from-closed-pr/spec.md) AC-5: the escalate to a spec-track rescue of the spec or design stage keeps a closed-PR hold on the chain's branch. Amended by [053-incomplete-implement-run-keeps-its-work](../053-incomplete-implement-run-keeps-its-work/spec.md) AC-2 and AC-3: the escalate to an implement rescue after an incomplete run keeps the carried entry. **Discarding the attempt clears every hold.** Given any holds, when
  an `escalate` transition (rescue, re-plan, spec revision, abandonment, the
  question check's second failure included), `liveness_expired`,
  `chain_error`, any `release`, the `done` of an abandonment or the `done`
  of a split (spec 031 AC-9) applies, then `heldWork` is empty. Every other
  transition carries the list unchanged. The table-driven test of spec 006
  AC-27 asserts, for every valid pair and for each of: no holds, a hold on
  the chain's branch, a hold on the other track's branch, and holds on
  both, whether each entry is carried, set, replaced or removed, with the
  rules of AC-1 to AC-4 as the oracle.
- AC-5. **The driver reads the hold on the branch it works on.** Given holds
  on `issue-<n>` and `spec-<n>` and the chain on the spec track with no PR
  bound, when the spec stage or the question check is prepared, then
  `syncWorktree` keeps `spec-<n>` as spec 011 AC-2 and AC-5 say for the
  chain's branch (its `held-work-kept`, `held-work-advanced` and
  `held-work-restored` records name `spec-<n>` and update only that entry's
  head), leaves `issue-<n>` alone locally and on origin, and writes no
  `recovered-commits` patch for the issue branch's commits when the
  worktree's `HEAD` is the `issue-<n>` hold's head (spec 011 AC-6's
  `heldElsewhere` check, now against any other branch's entry). The `held_work`
  input of the spec stage names `spec-<n>` and its head, never `issue-<n>`.
  The same lookup by the chain's branch applies to `settleHeldOnPr` and the
  rebase skip of spec 011 AC-2 when a PR is bound. Given the preparation
  cannot keep the chain's branch's hold (`held-work-lost`, spec 011 AC-2 and
  AC-5), then only that branch's entry is removed; the other entries stay.
- AC-6. **The merged spec PR hands back the issue branch's hold.** Given
  holds on `issue-<n>` (from implement's question) and none on `spec-<n>`
  (the spec PR bound and released it, AC-2), when the spec PR merges and the
  `delete_branch` action runs, then the worktree is put on `issue-<n>` at
  the `issue-<n>` hold's head without a reset and `held-work-kept` names
  `issue-<n>`, as spec 011 AC-6 says; plan then runs with `held_work` naming
  `issue-<n>` and `syncWorktree` keeps it (`held-work-kept`, no
  `recovered-commits`, no `stale-branch-dropped` for `issue-<n>`). Given no
  hold names `issue-<n>`, then the action checks it out from `origin/main`
  as today.
- AC-7. **Old records normalize.** Given a claim or paused record whose
  `state.heldWork` is absent or `null`, when it is read, then it normalizes
  to `[]`; given one whose `heldWork` is a single `{ branch, head }` object
  (written by spec 011's code), then it normalizes to `[{ branch, head }]`,
  and its chain continues (spec 006 AC-7, spec 011 AC-9). `initialChainState`
  sets `heldWork: []`. The claim schema's `heldWork` is an array of
  `{ branch, head }` objects, both strings, no other properties; `null` and a
  bare object are no longer valid on write (records are normalized on read
  before they are written again).
- AC-8. **End to end.** A recorded end-to-end chain (fake adapter, mocked
  GitHub), built on spec 011 AC-10's "technical question from implement"
  test, drives and asserts: implement commits on and pushes `issue-<n>`,
  then asks a technical question; the maintainer answers; the spec stage in
  `record` mode commits on `spec-<n>` and returns a `capability` question;
  the question check sends it; the maintainer answers; the resumed spec
  stage's input carries `held_work` naming `spec-<n>` at the commit it made,
  its worktree `HEAD` is that commit, and it returns `revised` with a PR;
  the spec PR merges; plan's input carries `held_work` naming `issue-<n>` at
  implement's head; implement's worktree `HEAD` is that head and the PR it
  opens merges. The log carries `held-work` for both branches, no
  `stale-branch-dropped` and no `recovered-commits` naming `issue-<n>`
  between implement's question and its resumed run's result, and the
  `issue-<n>` branch on the mocked origin is never deleted before that PR
  merges. A second chain does the same with the spec stage's question of
  kind `other` (decide mode, spec 006 AC-14) in place of the capability
  question and its check. Every existing chain of spec 011 AC-10 passes
  unchanged except for the shape of `heldWork` in its assertions.

## 4. Amendments to earlier specs

Spec 011's text is marked in its `spec.md` in this spec's PR (spec 039,
ADR 0009); the marks point here.

- **Spec 011 section 3, "Definitions."** `heldWork` is a list of
  `{ branch, head }` entries, at most one per branch (Definitions above),
  not a single entry or `null`.
- **Spec 011 AC-1.** "A follow-up or a second question from the resumed
  stage replaces the held work with the new head" applies to the hold on
  the chain's branch; a question on another branch adds a hold beside the
  existing ones (AC-1 above).
- **Spec 011 AC-2 and AC-5.** "clears the held work" on `held-work-lost`
  means: removes the hold on that branch (AC-5 above).
- **Spec 011 AC-6.** The route holds work on `issue-<n>` and, when the spec
  stage asks, on `spec-<n>` at once; the `delete_branch` action reads the
  `issue-<n>` hold (AC-5, AC-6 above).
- **Spec 011 AC-7.** A bound PR and the asking stage's failure clear the
  hold on the chain's branch only; the other clears empty the list; "carries
  it unchanged" carries every entry (AC-2 to AC-4 above).
- **Spec 011 AC-9.** A record without `heldWork` normalizes to `[]`, and one
  with spec 011's single object normalizes to a one-entry list (AC-7 above).
- **Spec 011 section 5.** The `types.ts` shape is the list; `initialChainState`
  sets `[]`; `unholdIfBound` and the clears of AC-7 work per entry; the
  driver's lookups are by branch (section 5 below).

Spec 006 section 4 is unchanged: no row is added or removed; the `heldWork`
field is set and cleared as AC-1 to AC-4 say.

## 5. Interfaces and files

- `tools/scheduler/src/chain/types.ts`: `heldWork: { branch: string; head:
  string }[]` in `ChainState` (the doc comment names this spec).
- `tools/scheduler/src/chain/machine.ts`:
  - `initialChainState` sets `heldWork: []`; `normalizeChainState` turns
    `null`, `undefined` and a single object into the list (AC-7);
  - `heldPatch` replaces the entry for `branchOf(state)` in place or appends
    one (AC-1);
  - `unholdIfBound` removes the entry for `branchOf(state)` (AC-2);
  - the asking stage's failure row (`stage_failed`, and `failedInDecideMode`
    through it) removes the entry for `branchOf(state)` (AC-3);
  - `escalate`, `releaseClaim`, the chain-error step, the abandonment and
    split `done` steps set `heldWork: []` (AC-4);
  - a helper (suggested `heldOn(state, branch)`) exported for the driver.
- `tools/scheduler/src/chain/driver.ts`: `heldWorkText`, `syncWorktree`
  (the keep path and the `heldElsewhere` check), `keepHeldWork`,
  `settleHeldOnPr`, the `heldOnPr` rebase skip and the `delete_branch`
  action look up the hold by branch; `held-work-lost` removes one entry;
  `held-work-advanced` and `held-work-restored` update one entry's head
  (AC-5, AC-6).
- `schemas/scheduler/claim.json`: `heldWork` becomes an array of
  `{ branch, head }` (AC-7). `schemas/scheduler/paused.json` types `state`
  as a bare object and is unchanged.
- `tools/scheduler/test/chain.test.ts`: the `heldVariants` of the spec 011
  AC-7 table-driven test become the four variants of AC-4 with a per-entry
  oracle; the "held work (spec 011)" block gains AC-1 to AC-3 cases on two
  holds; the existing cases change only in the shape of their expectations.
- `tools/scheduler/test/driver.test.ts`: AC-5 (two holds, chain on
  `spec-<n>`: `spec-<n>` kept, `issue-<n>` untouched, no
  `recovered-commits`; `held-work-lost` on `spec-<n>` leaves the `issue-<n>`
  entry) and AC-6 (`delete_branch` with the `issue-<n>` hold second in the
  list, or the only one, and with no hold); the existing spec 011 tests
  change only in the shape of `heldWork`.
- `tools/scheduler/test/e2e.test.ts`: the two chains of AC-8.
- `tools/scheduler/test/state.test.ts`, `paused.test.ts` and
  `schema.test.ts`: AC-7 (absent, `null` and the old single object
  normalize; the schema accepts the array and rejects `null` and a bare
  object).

`tools/scheduler/` is a sensitive path; the security review applies (spec
006 AC-9). `schemas/scheduler/claim.json` is kept by hand, as today, and
`schema.test.ts` validates the state shapes against it. No file under
`agents/` or `docs/` is created or modified by the implementation. The spec PR itself adds this
file, marks `specs/011-asking-stage-keeps-its-work/spec.md` as section 4
says and lists this spec under `## Children` in
`docs/delivery-system-design.md`.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
  clean.
- The machine test of AC-1 (a spec question in record mode with a hold on
  `issue-<n>` leaves two holds) fails on `main` before the change (one hold,
  on `spec-<n>`) and passes after it; the end-to-end chain of AC-8 fails on
  `main` the same way (plan's input has no `held_work`; the log has
  `stale-branch-dropped` for `issue-<n>`).
- `grep -rn "heldWork" tools/scheduler/src` shows no comparison of
  `heldWork` with `null` and no read of `heldWork.branch` or
  `heldWork.head` outside a per-entry lookup.
- Live check after deploy, recorded in the PR: the next live question raised
  by the spec stage while recording an answer shows, in the service log,
  `held-work` for `spec-<n>`, then after the spec PR merges `held-work-kept`
  for `issue-<n>` from the `delete_branch` action and from plan's
  preparation, and no `stale-branch-dropped` for `issue-<n>`. If no such
  question occurs before the PR is reviewed, the recorded end-to-end chain
  of AC-8 stands in for it, and the PR says so.

## 7. Open decisions

None.
