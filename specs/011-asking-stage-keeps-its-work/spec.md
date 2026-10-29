# 011. A stage that asks a question keeps its work

Status: written 2026-10-28 from the delivery-system design for issue #13;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 ("What happens while it waits": on a reply the work "resumes where
it stopped") and section 10 ("Small work skips layers": a bug spec hangs
directly off a top design); amends
[006-no-human-stops](../006-no-human-stops/spec.md) AC-13, AC-15 and AC-21
(the "branch left by a failed attempt" rule) and
[005-keep-unpushed-commits](../005-keep-unpushed-commits/spec.md) AC-2, as
section 4 records; consistent with
[007-telegram-channel](../007-telegram-channel/spec.md), whose session resume
runs the asking stage "in the same worktree".

## 1. Goal

Work a stage did before it asked a question is kept, and the stage that
resumes after the answer continues from it. Today it is thrown away twice.

### What happens today (spec agent's reading of the code, 2026-10-28)

Observed live on issue #9 (2026-10-27): implement ran 31 minutes, committed,
pushed `issue-9` without opening a PR, then returned a `capability`
escalation. Then:

1. The question check runs in the issue's worktree. Before any agent stage
   the driver prepares the worktree (`syncWorktree`). With no PR bound it
   saves the local commits as a patch (`recovered-commits`), applies the
   "branch left by a failed attempt" rule of spec 006 AC-21 (the pushed
   branch's commits saved as `stale-branch`, its open PRs closed, the branch
   deleted on GitHub: `stale-branch-dropped`) and resets the branch to
   `origin/main`. The work is gone before the question is even sent.
2. The pause keeps the worktree (the `pause` action removes only the claim),
   but the worktree is already clean. When the maintainer answers, the
   resumed implement runs the same preparation again and starts from
   `origin/main`, redoing the whole implementation.

The failed-attempt rule exists for branches left by *failed* attempts, so the
next push and `gh pr create` start clean. A stage that asks has not failed:
its work is the input to the resumed run. Nothing in the chain state records
that the branch holds work the chain still wants, so the driver cannot tell
the two cases apart.

### After this spec

The chain state records **held work**: the branch and head a stage left when
its result carried a question. While the chain holds work, the driver's
worktree preparation keeps that branch where it is (locally and on origin,
with any open PR from it) instead of patching, dropping and resetting it. The
held work follows the chain through the question check, the pause (it is in
the paused record's state), the resume, decide mode and follow-ups, and
through the spec PR that records a product or technical answer, until a PR is
bound on the branch or the chain discards the attempt. The resumed stage is
told where its earlier run left the branch. Every discard path keeps its
rules: a failed attempt, a rescue, a re-plan, a spec revision, a release, a
chain error and an abandonment still save a patch, drop the stale branch and
start clean. Everything is crash-safe: the held work is written to the claim
or the paused record before any step that depends on it, and a patch of the
held commits is saved when the question is raised, so a lost worktree costs
nothing.

## 2. Out of scope

- Uncommitted changes at the moment a stage asks. They are saved as a patch
  and discarded before the next stage, as spec 005 says: the question check
  and the resumed stage start from a clean tree. The stage prompts tell the
  stage to commit before it asks (section 5), which is what it does for every
  other result.
- Replaying a saved patch automatically (spec 005 section 2).
- Keeping work across a release, a chain-error release or an abandonment.
  The issue keeps today's rules there; spec 006 AC-7 keeps the unrecorded
  answer, not the branch.
- Keeping work across a rescue, a re-plan or a spec revision (spec 006 AC-1
  to AC-3), which start again by design.
- Resuming the asking stage's session rather than a fresh one (spec 007).
  Spec 007 runs the resumed session in the same worktree; this spec makes
  sure that worktree still holds the work.
- A review or verify question. Both run with a PR bound, whose branch the
  driver already keeps (spec 005 AC-3); nothing changes for them.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.

**Definitions.** *Held work* is the field `heldWork` of `ChainState`:
`{ branch, head } | null`, where `branch` is the chain's branch at the time
(`issue-<n>` or `spec-<n>`, spec 006 AC-21) and `head` is the worktree's
`HEAD` commit when the asking stage's result was read. The *asking stage* and
the *question path* are as spec 006 AC-12 to AC-15 define them.

- AC-1. **A question records the work.** Given a plan, implement or fix
  result that carries an `escalation`, or a spec result with verdict
  `question`, when the driver turns it into its `stage_ok` event, then the
  event carries `head`, the worktree's `HEAD` after the run, and the driver
  first saves the branch's commits not on `origin/main` as a patch (kind
  `held`, through `savePatch`; no file when there are none) and logs
  `{ kind: "held-work", issue, stage, branch, head, pushed, prs, patch }`,
  where `pushed` says whether the branch exists on origin and `prs` lists the
  open PRs from it (each `null` when its lookup failed). A fix result
  escalates with a PR bound: its held work is on the PR's branch and is kept
  as AC-2 says for that case. The machine sets `heldWork` to `{ branch, head }` on every
  transition that routes the question (to the question check, or straight to
  `paused` for a follow-up). A `stage_ok` on that path without `head` throws,
  as one without `scope` does today. A follow-up or a second question from
  the resumed stage replaces the held work with the new head.
- AC-2. **The question check runs on the work as it was left.** Given held
  work on the chain's branch, the worktree on that branch at the held head,
  and no PR bound, when the question check is prepared (first attempt,
  retry, or after a quota postponement), then the preparation fetches, saves
  and discards uncommitted leftovers as today, and otherwise leaves the
  worktree as it is: no `recovered-commits` patch, no `stale-branch-dropped`,
  no PR closed, the branch on origin untouched, and `HEAD` still the held
  head. The log carries `{ kind: "held-work-kept", issue, branch, head }`.
  Given the branch's `HEAD` instead builds on the held head (the resumed
  stage committed more, then failed, was postponed or crashed), then `HEAD`
  is kept too, the held head becomes `HEAD`, and the log carries
  `{ kind: "held-work-advanced", issue, branch, from, to }`.
  Given a PR is bound on the held branch (a fix that asked), then the
  preparation syncs to the remote head as spec 005 AC-3 says, which keeps a
  held head that builds on the remote head (`held-work-kept`, or
  `held-work-advanced` when `HEAD` builds on the held head), and the driver
  does not rebase it onto `origin/main` before the stage (the rewritten
  commits would be unpushed and diverged from the PR). When the remote head
  diverged from the held head, the sync drops it as today (its `dropped`
  patch saved), and the driver logs `held-work-lost` and clears the held work.
- AC-3. **The pause and the resume carry it.** Given the question check
  returns `send`, then the paused record's `state` carries the held work.
  Given the maintainer replies and the issue resumes (spec 006 AC-15), then
  the claim's state carries it, and the resumed stage is prepared as in AC-2:
  it runs on the branch at the held head, with the pushed branch and any
  open PR from it still there. The same holds for the resumed stage in decide
  mode (spec 006 AC-14) and after a follow-up's reply.
- AC-4. **The resumed stage is told.** Given a plan, implement, fix or spec
  stage runs while the chain holds work on the chain's branch, then its input
  carries `held_work`: a short text naming the branch, the held head, whether
  the branch is on origin, and any open PR from it (`gh pr list` would show
  the same), saying that the work is the stage's own from before the
  question and that the stage continues from it. A lookup that failed is
  stated as unknown, never as "not on origin" or "(none)". The field is
  present only when the worktree's `HEAD` is the held head after the
  preparation (AC-2, AC-5); given no held work, or held work the preparation
  could not keep, the field is absent and the prompt renders "(none)". Given an implement run
  with `held_work` naming an open PR, then its result may report that PR: the
  binding check of spec 001 (open, from the chain's branch, at the result's
  head) is unchanged.
- AC-5. **A lost worktree is restored.** Given held work and a worktree whose
  `HEAD` is not the held head (the worktree was recreated from `origin/main`,
  or a crash left it elsewhere), when the next stage on the question path is
  prepared, then the driver puts the branch at the held head when that commit
  exists in the repository (`held-work-restored`, `source: "local"`), first
  saving the local branch's commits not reachable from the held head as a
  patch (kind `held-diverged`; the record's `patch` field names it, null when
  there are none) unless the branch builds on the held head (AC-2);
  otherwise, when the branch exists on origin after the fetch, at the branch's
  remote head (`held-work-restored`, `source: "origin"`); a fetch that fails
  for any reason but the branch missing on origin fails the step and changes
  nothing; otherwise it logs
  `{ kind: "held-work-lost", issue, branch, head }`, clears the held work and
  prepares the worktree as it does without it. The patch of AC-1 is the
  fallback in the last case. Given the held head is reachable from
  `origin/main` (the stage committed nothing), then there is nothing to keep
  and the preparation runs as without held work.
- AC-6. **Held work survives the spec PR that records an answer.** Given
  implement asked a product or technical question with held work on
  `issue-<n>`, when the reply routes to the spec stage in `record` mode
  (spec 006 AC-18, on `spec-<n>`), then the spec-track preparation leaves
  `issue-<n>` alone locally and on origin (it switches branches; it patches
  and drops `spec-<n>` only, as today), and after the spec PR merges the
  `delete_branch` action puts the worktree back on `issue-<n>` at the held
  head without a reset (today it checks `issue-<n>` out from `origin/main`);
  plan then runs with `held_work` in its input and implement continues from
  the branch (AC-3, AC-4). The chain's fresh stage counters (spec 006 AC-4)
  are unchanged.
- AC-7. **Held work is cleared when the work is bound or discarded, and only
  then.** The machine clears `heldWork` on:
  - a `stage_ok` of implement or spec (`revised`) that binds a PR on the
    held branch: the work is then the PR's, and spec 005 AC-3 applies;
  - a `stage_failed` of the asking stage that is not a quota postponement
    (the retry is a failed attempt);
  - every `escalate` transition (rescue, re-plan, spec revision,
    abandonment), the question check's second failure included;
  - `liveness_expired`, `chain_error` and every `release`;
  - the `done` of an abandonment.

  Every other transition carries it unchanged, in particular: the question
  check's first failure and its retry, a quota postponement and the `waiting`
  stage it leads to, `send` to `paused`, `answered`, `decide_yourself`
  (first on the issue), a follow-up pause, the spec track's verify, review,
  fix and merge while recording an answer, and plan's `stage_ok`. The
  table-driven test of spec 006 AC-27 asserts, for every valid pair, whether
  the held work is carried or cleared. Given the held work is cleared and the
  next stage runs with no PR bound, then the preparation of spec 006 AC-21
  applies in full: patch, stale-branch drop, reset to `origin/main`.
- AC-8. **Failed attempts, re-plans and releases still start clean.** Given
  the failed-attempt chains the recorded end-to-end tests of spec 006 AC-28
  drive (rescue, re-plan, spec revision, abandonment) and the stale-branch
  test of the driver, then their patches, closed PRs and deleted branches are
  as today. Given a claim after a release, then the preparation drops a
  branch left on origin as today.
- AC-9. **A claim written before this spec loads.** Given a claim or paused
  record without `heldWork`, when it is read, then it normalizes to `null`
  and its chain continues (spec 006 AC-7).
- AC-10. **End to end.** Recorded end-to-end chains (fake adapter, mocked
  GitHub) drive and assert:
  - a capability question from implement, which committed on and pushed
    `issue-<n>` before asking: no `recovered-commits` and no
    `stale-branch-dropped` for that branch, the resumed implement's input
    carries `held_work`, its worktree `HEAD` is the held head, and the PR it
    opens merges;
  - the same with a PR opened before the question: the PR is not closed, and
    the resumed implement reports it;
  - a technical question from implement with held work: the spec PR records
    the answer and merges, plan runs, and implement continues from the held
    head (AC-6);
  - a `decide_yourself` after a question with held work: the stage in decide
    mode continues from the held head;
  - a question whose resumed stage then fails: the retry starts clean, with
    the `stale-branch-dropped` record.

## 4. Amendments to earlier specs

This spec's PR may not edit other specs (spec 006 AC-21 scope), so the
readings below are recorded here; the earlier text stands with these
exceptions.

- **Spec 006 AC-21, "A branch left by a failed attempt."** The rule applies
  "given a stage is about to run with no PR bound" *and the chain holds no
  work on that branch*. The question check and the stages the question path
  resumes (AC-2, AC-3, AC-6 above) are not retries, rescues, re-plans,
  revisions or claims after a release; the rule does not apply to them.
  AC-21's "the scheduler creates that branch from `origin/main` and checks it
  out ... before the spec stage runs" holds unless held work names
  `spec-<n>`, in which case the branch is left at the held head.
- **Spec 006 AC-13.** "The chain state" written to `paused/<issue>.json`
  includes the held work.
- **Spec 006 AC-15.** The resumed stage runs "in a fresh session with the
  question and the reply as input" and, with held work, in the worktree as
  the asking stage left it, with `held_work` as input.
- **Spec 005 AC-2.** "Given a claim with no pull request whose worktree
  carries a commit not on `origin/main`, when the next stage is prepared"
  applies when the chain holds no work on the branch; with held work the
  commits are kept, not patched, and `recovered-commits` is not written (the
  `held` patch of AC-1 was written when the question was raised).
- **Spec 006 section 4.** No row changes. The `heldWork` field is set and
  cleared as AC-1 and AC-7 say; the table stays the single source of the
  transitions.

## 5. Interfaces and files

- `tools/scheduler/src/chain/types.ts`: `heldWork: { branch: string; head:
  string } | null` in `ChainState`; `head?: string` on the `stage_ok` events
  of plan, implement, fix and spec.
- `tools/scheduler/src/chain/machine.ts`: `initialChainState` sets
  `heldWork: null` (so `normalizeChainState` fills it, AC-9); `ask` sets it
  from the event's `head` and throws without one (AC-1); the clears of AC-7
  in `settle` (when a PR is bound on the held branch), the failure rows, the
  escalate rows, `releaseClaim`, the chain-error and abandonment steps.
- `tools/scheduler/src/chain/driver.ts`:
  - the escalation branches of `codeEvent`, the plan case of `runAgentStage`
    and the `question` branch of `specEvent` compute `head`, save the `held`
    patch and log `held-work` (AC-1);
  - `syncWorktree`: the held-work path with no PR bound (AC-2, AC-5), before
    the `recovered-commits` and `dropStaleRemoteBranch` steps; a held branch
    other than the chain's branch is left alone (AC-6);
  - the `delete_branch` action: back on `issue-<n>` at the held head, without
    a reset, when held work names it and the commit exists (AC-6);
  - `buildInput`: `held_work` (AC-4), using `openPullRequestsFrom`.
- `tools/scheduler/src/stages/prompt.ts` and
  `schemas/scheduler/stage-input.json`: the optional `held_work` string,
  rendered "(none)" when absent.
- `schemas/scheduler/claim.json`: the optional `heldWork` property of
  `state` (`null` or `{ branch, head }`).
- `agents/stages/implement.md`, `agents/stages/fix.md`,
  `agents/stages/spec.md`: a `{{held_work}}` line and a sentence in the
  escalation paragraph: commit your work before you escalate; it is kept, and
  your resumed run continues from it. In `implement.md`, with a PR already
  open from the branch, push to it and report its number rather than
  opening a second one. `agents/stages/plan.md` gets `{{held_work}}` too, as
  plan runs after the record route (AC-6) and may name what the branch holds.
  These stage prompts are under `agents/`, which `agents/sensitive-paths.txt`
  lists, so the security review checks the diff.
- `tools/scheduler/src/runner/worktree.ts`: no new function is expected;
  `checkoutBranch(worktree, branch, head)` with the held head serves AC-5
  and AC-6. *(agent's call: the plan may add a helper if `checkoutBranch`'s
  `-B` reset proves wrong for an existing branch at the same head.)*
- `tools/scheduler/test/driver.test.ts`: AC-1, AC-2, AC-5, AC-6 and AC-8 on
  the file's repo-pair setup (the spec 005 tests and the stale-branch test
  are the models).
- `tools/scheduler/test/chain.test.ts`: AC-7 in the table-driven test of
  spec 006 AC-27, and the throw of AC-1.
- `tools/scheduler/test/e2e.test.ts`: the chains of AC-10, built on the
  "capability question from implement" test; the fake implement commits and
  pushes before it escalates.
- `tools/scheduler/test/state.test.ts` or `paused.test.ts`: AC-9.

`tools/scheduler/` and `agents/` are sensitive paths; the security review
applies (spec 006 AC-9). No other file is created or modified.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
  clean.
- The driver test for AC-2 fails on `main` before the change (it finds a
  `stale-branch-dropped` record and `HEAD` at `origin/main`) and passes after
  it; the end-to-end chain of AC-10's first bullet fails on `main` the same
  way.
- Live check after deploy, recorded in the PR: the next live question raised
  by implement or the spec stage shows, in the service log, one `held-work`
  record and `held-work-kept` before the question check and before the
  resumed stage, and no `stale-branch-dropped` or `recovered-commits` for
  that branch between the question and the resumed stage's result.

## 7. Open decisions

None.
