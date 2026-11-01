# 0006. The test-board spec is written and its scheduler side built before any firmware exists

Status: accepted
Date: 2026-11-01
Decided by: the spec agent for issue #40 (design section 3: a decision of order
with one clearly right answer, recorded with its reasoning), while writing
[spec 030](../../specs/030-test-board/spec.md), row G of the delivery-system
design's section 11.

## Context

Design section 5 and row G ask for HIL tests on the real board, automatic
promotion from beta to stable under criteria the spec sets, and the
bricked-board pause. `firmware/` is empty and product milestone 1 (the runtime
spike, product-spec 12) has not started, so there is no firmware to flash, no
HIL suite, no build to publish and no OTA distribution to promote into. The
issue asked the spec stage to say so if the spec cannot be meaningfully built
before milestone 1, and to decide the order itself unless the order is a
direction decision for the maintainer.

The order is not a direction decision: the maintainer has already set
milestone 1 first (R2.Q8) and firmware beta-then-stable with no human release
action (design section 5). What remains is which half to build first.

Options considered:

1. **Wait for milestone 1, then write one spec** covering the scheduler side,
   the HIL job and the firmware workflow. Milestone 1's own PRs would then be
   merged with no board test and no pause, which is the untested-firmware
   state design section 5 is written to end, and the first firmware issue
   would carry a scheduler change, a workflow, a serial harness and a test
   suite in one chain (the shape ADR 0004 records as failing five times).
2. **Write spec G now and build only the scheduler side** (chosen): the board
   state, the pause, the capability question, the HIL-check gate, the release
   records and the promotion criteria, all testable with the fake harness and
   a mocked GitHub, against a fixed contract for the HIL job's artifact. The
   firmware side (the workflow, the serial harness, the suite, the build and
   beta publication) is its own spec under the same parent, written once
   milestone 1 has a buildable project on `main`.
3. **Build the HIL workflow now too**, with a placeholder job. A workflow on a
   self-hosted runner with no firmware to flash would be either always green
   (which would promote nothing but would also gate nothing) or never
   reported (which would block every firmware PR forever); either way it
   could not be verified.

## Decision

- Spec 030 is written now with the scheduler-side acceptance criteria and a
  contract section for the HIL job's artifact, triggers, concurrency and the
  meaning of `bricked`.
- Its implementation changes `tools/scheduler/`, `agents/`,
  `schemas/scheduler/` and `tools/README.md` only, and adds no workflow.
- The firmware side is a separate spec under `docs/delivery-system-design.md`,
  filed as its own issue, blocked until milestone 1's firmware is on `main`;
  it implements spec 030 section 8 and may tighten the contract, not loosen it.
- With no `firmware` block configured the scheduler is unchanged, so landing
  030 first costs nothing until firmware exists.

## Consequences

- Milestone 1's first firmware PR is gated on the HIL check from the start,
  once the firmware-side spec has landed; until then, with the block
  configured and no workflow, a firmware PR would wait on a check that never
  reports. The `firmware` block is therefore left unconfigured until the
  firmware-side spec merges, and that spec's implementation configures it.
- The promotion criteria (spec 030 AC-6) are fixed in code before any build
  exists; the first real promotion is the verification step of the
  firmware-side spec, written up in `dev-logs/`.
- The channel representation (a GitHub Release's prerelease flag) is decided
  by spec 030 and read by the backend's OTA distribution when that exists; a
  backend spec that needs another representation changes it through a
  reviewed PR against 030's design notes.
