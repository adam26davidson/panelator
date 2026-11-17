# 0013. The test-board gate is built before any firmware; the HIL workflow is the firmware's own

Status: accepted
Date: 2026-11-17
Decided by: the spec stage of issue #132 (design section 3: a decision of
order and ownership with one clearly right answer, recorded with its
reasoning), while writing
[spec 070](../../specs/070-test-board/spec.md), row G of the delivery-system
design's section 11. Recovers the decision drafted for issue #40 (commit
7768b8a, then ADR 0006, a number since taken) and changes who builds the HIL
workflow.

## Context

Design section 5 and row G ask for firmware tested on the real board, automatic
promotion from beta to stable under criteria the spec sets, and the pause of
firmware work when a test bricks the board. `firmware/` holds only `.gitkeep`
and product milestone 1 (the runtime spike, product-spec 12) has not started:
there is no firmware to flash, no HIL suite, no build to publish and no OTA
distribution. Issue #132 asks the spec stage to say so if the spec cannot be
meaningfully built before milestone 1, and to decide the order itself unless
it is a direction decision for the maintainer.

It is not one. The maintainer has set milestone 1 first (R2.Q8), firmware
beta-then-stable with no human release action (design section 5), and HIL on
the existing self-hosted runner (R5.Q5). What remains is which half is built
when, and by whom.

Options considered:

1. **Wait for milestone 1, then build everything in one spec**: the scheduler
   side, the HIL workflow, the harness and the release workflow. Milestone
   1's first firmware PRs would merge with no board test, which is the state
   design section 5 is written to end, and one chain would carry a scheduler
   change, a workflow, a serial harness and a suite (the size of work ADR
   0004 split into separate specs).
2. **Build the scheduler side now and a placeholder HIL workflow.** A workflow
   on the runner with nothing to flash is either always green (gating
   nothing) or never reported (blocking every firmware PR); neither can be
   verified.
3. **Build the scheduler side now, gate on from the start, and leave the HIL
   workflow, harness, suite and release workflow to the firmware work**
   (chosen). The gate, the board state, the pause, the release records and
   the promotion criteria are testable today with the fake harness and a
   mocked GitHub, against a fixed contract (spec 070 section 8). The HIL
   end-to-end test is already a product testing contract (product-spec 13),
   and building and publishing firmware is part of the firmware, so the
   workflows that do it are written with the firmware, by whichever chain
   first needs them.

## Decision

- Spec 070 is written now and built now. Its implementation changes
  `tools/scheduler/`, `agents/`, `schemas/scheduler/`, `tools/README.md` and
  `dev-logs/` only, and adds no workflow.
- `agents/scheduler.yaml` turns firmware handling on in the same change. A
  firmware PR whose head has no HIL workflow is blocked (spec 060's block)
  with a finding naming the missing workflow and spec 070 section 8; the
  findings filer turns it into an issue, and the block resumes by itself when
  `main` gains the workflow. So the first firmware PR cannot merge untested,
  and the firmware side is built exactly when it is first needed, with
  firmware on `main` to test against.
- No planned child for the firmware side is added to the delivery-system
  design: row G is covered by spec 070, and the HIL workflow and release
  workflow belong with the firmware (product-spec 12 and 13), whose specs
  meet section 8's contract and may tighten it, not loosen it.

## Consequences

- Until a firmware PR exists, firmware handling costs one releases listing
  every ten minutes and nothing else.
- The first firmware PR waits for the HIL workflow. A milestone 1 chain may
  add the workflow in the same PR as its firmware, in which case the HIL
  check runs on that PR's own head.
- The promotion criteria (spec 070 AC-10) are fixed in code before any build
  exists; the first real promotion is written up in `dev-logs/` by the work
  that brings the HIL workflow.
- The channel representation (a GitHub Release's prerelease flag) is set by
  spec 070 and read by the backend's OTA distribution when that exists; a
  backend spec that needs another representation changes it by a reviewed PR.
