# 057. The recorded design-stage run carries held work across the design merge

Status: written 2026-11-14 from the delivery-system design for issue #110;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 ("What happens while it waits": on a reply the work "resumes where
it stopped"), section 9 ("Design first") and section 10 ("Small work skips
layers": a tooling spec hangs directly off a top design);
[029-design-stage](../029-design-stage/spec.md) AC-1 (the design stage runs
in place of the park when the UI-design gate fails on `main` after a spec PR
merges), AC-3 (the visual review and the fix on the design PR), AC-4 (after
the design PR merges, `plan` runs "with fresh stage counters and the issue's
held work (specs 011 and 015) as after a spec-track merge") and section 6
(the recorded runs), whose section 6 this spec amends, marked as section 4
records; [011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
AC-4 (the resumed stage's `held_work` input) and AC-6 (the issue branch
waits while the spec track records an answer);
[040-held-work-per-branch](../040-held-work-per-branch/spec.md) AC-6 (the
merged spec PR hands back the issue branch's hold) and AC-8 (the recorded
chain this spec's run is built on); [006-no-human-stops](../006-no-human-stops/spec.md)
AC-18 (a technical answer to an implement question is recorded by the spec
stage in `record` mode on `spec-<n>`).

## 1. Goal

The test suite records, through the real Scheduler, driver and machine with
the fake adapter and the mocked GitHub, the path spec 029 AC-4 promises and
section 6 asks for: an issue whose implement stage has work held on
`issue-<n>` goes through a spec-track merge whose recorded answer changes the
UI design section, so the UI-design gate fails on `main` and the design stage
runs, its PR is sent back once and fixed, merged, and `plan` then runs with
`held_work` naming the held head, and implement continues from it. Today
that path is checked only by one machine unit test; the recorded run that
spec 029 section 6 names starts without a question and asserts nothing about
held work.

### What the suite has today (spec agent's reading, 2026-11-14)

- `tools/scheduler/test/e2e.test.ts`, "end to end: the design stage (spec
  029)", first test ("runs the design stage on design-7 for a UI spec
  without design/, reviews it with the design profile, fixes, merges, then
  plans (AC-1, AC-3, AC-4)", lines 1289 to 1322 on `main` at 2be2212): the
  chain starts on a UI spec with no `design/`, so the design stage is the
  first stage; its results map has no `question-check` and no `spec` entry,
  no stage asks, `heldWork` stays empty, and the plan input's `held_work` is
  never read. It covers AC-1, AC-3 and the counters and branch of AC-4, not
  AC-4's held work.
- `tools/scheduler/test/chain.test.ts`, "a merge with a passing gate deletes
  design-<n> and runs plan with fresh counters and held work" (line 1610):
  one `transition` call on a `merge` state of track `design` with a hold on
  `issue-1`; it asserts the hold is on the resulting `plan` state. It does
  not drive the driver's `delete_branch` action, `syncWorktree`, or the
  `held_work` text of the plan input.
- The spec-track runs of spec 011 AC-10 and spec 040 AC-8 (e2e.test.ts lines
  534 to 566 and 568 onward) drive the whole path for a spec merge whose gate
  passes: `inputsOf(w, "plan")[1].held_work` contains the held head and the
  resumed implement starts there. No run drives a spec merge whose UI-design
  gate fails.

The machine already carries the hold: `specMerged` passes `heldWork`
through to `toDesign` (its `FRESH` counters do not touch it), `designMerged`
passes it to `proceedToPlan`, and the driver's `delete_branch` action puts
the worktree on `issue-<n>` at the hold's head for both deleted branches
(`tools/scheduler/src/chain/driver.ts`, `delete_branch` case;
`syncWorktree`'s `heldElsewhere` check keeps the design stage's preparation
from saving the held commits as `recovered-commits`). This spec records that
behaviour end to end so a regression in any of those three places fails
`pnpm test`; it changes none of them unless the recorded run shows one is
wrong (AC-3).

## 2. Out of scope

- Any change to the chain's behaviour that the recorded run does not show
  to be wrong: the machine's routes, the held-work rules of specs 011, 040
  and 053, the design-stage bounds and profiles of spec 029, the
  `delete_branch` action and `syncWorktree`.
- The existing recorded runs: the four tests of the spec 029 block and every
  earlier recorded chain stay as they are; the first spec 029 test is not
  rewritten to carry a question (it is the record of AC-1, a chain whose
  first stage is the design stage).
- A recorded run for the design stage asking a question of its own (spec
  040 AC-1's design hold, chain.test.ts line 1397), for a product answer to
  a design PR's review (machine.ts `answered`, track `design`), or for the
  gate still failing after the design merge with held work: the machine
  tests cover the holds there, and none is the run spec 029 section 6 names.
- The UI spec fixture `tools/scheduler/test/fixtures/specs/good-webui.md`:
  unchanged. The recorded answer is made in the test by editing the
  fixture's text, as the spec-track runs edit `specOf()`.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the implementation PR's branch and the test
suite of `tools/scheduler/test/`. The *recorded run* is a new `it` block in
the "end to end: the design stage (spec 029)" describe block of
`tools/scheduler/test/e2e.test.ts`, built with `chainWorld`, `agents`,
`asksAfterPushing` (or an equivalent that commits and pushes `issue-7` and
returns a question) and the block's `design` helper. The *held head* is the
commit implement pushes on `issue-7` before it asks.

- AC-1. **The recorded run drives the whole path.** Given the repository on
  `main` holds the UI spec fixture at `specs/010-thing/spec.md` with a
  complete `design/` for its two named screens (the block's
  `uiFiles(true)`), when the run executes, then the chain goes through, in
  this order and with nothing else between: `plan`; `implement`, which
  commits and pushes `issue-7` (the held head) and returns a `technical`
  question; `question-check` returning `send`; a maintainer reply; `spec`
  in `record` mode on `spec-7`, which commits a spec whose `Screens:` line
  names a third screen (for example `editor-saving`) beside the two, carries
  the mark `(maintainer answer, question #<id>)` of the reply, and opens a
  PR that is approved and merged; `design` on `design-7`, whose input
  `design_problem` names the third screen's missing renders (its
  `<screen>.png`, `<screen>.mobile.png` and `<screen>.tablet.png`), which
  pushes a story and the three renders of every named screen and opens a
  design PR; `review` with profile `design` returning `changes_requested`;
  `fix` on `design-7`; `review` with profile `design` returning `approve`;
  the design PR merged; `plan` on `issue-7`; `implement` on `issue-7`
  opening the issue PR; `review` with the plan's profile; that PR merged.
  `w.adapter.ran` equals `["plan", "implement", "question-check", "spec",
  "review", "design", "review", "fix", "review", "plan", "implement",
  "review"]`, the merged PRs are the spec PR, the design PR and the issue
  PR in that order, and `expectSettled` holds (no chain error, no unmatched
  route, no claim, no paused record).
- AC-2. **Held work crosses both merges.** Given the run of AC-1, then: the
  plan input after the design merge (`inputsOf(w, "plan")[1].held_work`)
  contains the held head and names `issue-7`; the resumed implement's
  worktree `HEAD` at its start is the held head (as the spec-track runs
  assert with `starts`); the design run's input `held_work` is `undefined`
  (the hold is on `issue-7`, not `design-7`; spec 040 AC-5) and so is the
  spec run's and the question check's; the log has at least one
  `held-work-kept` entry for `issue-7` at the held head after each of the
  two `delete_branch` actions and none with another head; the log has no
  `stale-branch-dropped` and no `recovered-commits` entry; the mocked
  origin's `issue-7` is never deleted before the issue PR merges (no
  `DELETE /repos/o/r/git/refs/heads/issue-7` among `w.writes()`), while
  `spec-7` and `design-7` each are; the resumed implement runs on branch
  `issue-7` and the issue PR it opens merges; and the plan input's
  `history` carries the machine's entry for the spec merge whose gate
  failed (`spec merged, UI-design gate failed: …`, naming the third
  screen's render), the record that the design stage ran because of the
  recorded answer.
- AC-3. **The code changes only if the run shows it must.** Given the run of
  AC-1 and AC-2 passes against `tools/scheduler/src` as on `main`, then the
  implementation PR changes nothing under `tools/scheduler/src`. Given it
  fails there, then the PR changes the chain (machine or driver) only as far
  as spec 029 AC-4, spec 011 AC-6 and spec 040 AC-6 already require, says in
  its body which assertion failed on `main` and why, and records the
  failing assertion as a finding on the spec that the behaviour belongs to
  (spec 029 or spec 040) so the filer can judge whether that spec needs a
  correction; it does not weaken an assertion of AC-2 to make the run pass.
- AC-4. **The existing runs stand.** Given the change, then the first test
  of the spec 029 block keeps its results map (no question, no spec stage)
  and its assertions, and every other recorded chain of the suite passes
  unchanged. The `design` helper may gain a parameter for the screens it
  renders (the new run needs the third screen) with the existing calls
  unchanged in behaviour.
- AC-5. **The suite passes.** Given the change, when `pnpm test` runs from
  the repository root and `pnpm -F @panelator/scheduler typecheck` runs,
  then both pass, and the new run finishes within the block's timeout for a
  twelve-stage chain (240 seconds, as the block's longest run uses).

## 4. Amendment to spec 029

Spec 029 section 6 lists, as one recorded run, "a design PR with
`request_changes`: the fix stage on the design PR, then approve, merge, gate
passes, `plan` runs with held work (AC-3, AC-4)". The merged suite records
the first half of that run without a question before the design stage. This
spec's AC-1 run is the run that sentence describes, with the held work
coming from an implement question recorded through the spec track, the only
way held work reaches a design merge in the chain as built. The existing run
stays as the record of AC-1 and AC-3. Spec 029 section 6 is marked
`Amended by [057-design-stage-e2e-run-carries-held-work](../057-design-stage-e2e-run-carries-held-work/spec.md) AC-1`
in this spec's PR, and the earlier text stays unchanged after the mark.

No ADR: the change adds a test and decides nothing about the system.

## 5. Interfaces and files

No schema, prompt or interface change. The implementation PR edits:

- `tools/scheduler/test/e2e.test.ts`: one new `it` in the "end to end: the
  design stage (spec 029)" block (AC-1, AC-2), after the first test; the
  block's `design` helper takes the screens to render (default `SCREENS`)
  so the new run renders the third screen (AC-4); `asksAfterPushing`,
  `rev`, `kinds` and the other helpers of the spec 011 block are hoisted to
  the file's shared helpers or duplicated locally, whichever keeps the
  existing blocks unchanged *(agent's call: hoist, so the two blocks assert
  held work the same way)*.
- Nothing else, unless AC-3's second branch applies; then the files it
  names under `tools/scheduler/src/chain/`, each change explained in the PR
  body.

The spec PR itself adds
`specs/057-design-stage-e2e-run-carries-held-work/spec.md`, lists it under
`## Children` in `docs/delivery-system-design.md`, and marks section 6 of
`specs/029-design-stage/spec.md` as section 4 says.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`), so
the security review applies to the implementation PR (spec 006 AC-9). The
change adds a recorded test; it touches no gate, bound, label rule,
permission or token handling. This spec plans no change to the charter, to
a protected maintainer decision, to the sensitive-path list, to the security
review criteria or instructions, or to what decides that a sensitive diff
gets the security review, that both reviews must approve, or that a
sensitive path must be listed in the spec.

## 6. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean (AC-5).
- `grep -n "held_work" tools/scheduler/test/e2e.test.ts` prints, inside
  the spec 029 block, an assertion on `inputsOf(w, "plan")[1].held_work`
  (AC-2); `grep -c "it(" tools/scheduler/test/e2e.test.ts` is one more than
  on `main` (AC-1, AC-4).
- Mutation check, run once by the implementation and reported in the PR
  body: with `proceedToPlan` in `tools/scheduler/src/chain/machine.ts`
  temporarily setting `heldWork: []` for the `design` track, the new run
  fails on the `held_work` assertion of AC-2 and nothing else in the suite
  fails for that reason alone; the change is reverted before the push
  (AC-2, AC-3).
- `git diff origin/main --stat -- tools/scheduler/src` on the
  implementation branch is empty, or the PR body explains each file it
  lists (AC-3).

## 7. Open decisions

None.
