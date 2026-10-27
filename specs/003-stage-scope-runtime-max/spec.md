# 003. Stage scopes get a runtime ceiling

Status: approved by the maintainer 2026-10-16.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [001-scheduler-core](../001-scheduler-core/spec.md) sections 11
and 16 (AC-15, AC-23, AC-30); the branch review's residual R2.

## 1. Goal

A stage runs in a transient systemd scope named `panelator-stage-<run id>`.
If the scheduler crashes while a stage is in flight, the orphaned scope
keeps running and, on resume, the driver waits for it (the claim's
`run_id` is set, so liveness never expires the claim). A stage that hangs
inside that scope therefore holds its slot forever. Give every scope a
`RuntimeMaxSec` so systemd kills it on its own, and let the driver's wait
end when the unit is gone.

## 2. Out of scope

Changing the stage timeouts themselves, the inhibitor, the unit file, or
how the driver resumes a stage whose scope has ended.

## 3. Acceptance criteria

AC-1. Given a stage whose definition has `bounds.timeout_min = N`, when its
scope is created, then the `systemd-run` argument list contains
`-p RuntimeMaxSec=<S>` where `S = N * 60 + 600` (the stage timeout plus a
ten-minute grace for the runner's own kill), next to the existing
`MemoryMax`, `OOMPolicy` and `KillMode` properties.

AC-2. Given scopes are disabled in the configuration, when a stage runs,
then no `systemd-run` arguments are produced at all, as today.

AC-3. Given `scopeArgv` is called without a runtime ceiling, then it
produces exactly the argument list it produces today, so every existing
caller and test is unchanged.

## 4. Interfaces and files

- `tools/scheduler/src/runner/process.ts`: `scopeArgv(argv, unitName, bin, runtimeMaxSec?)` gains an optional ceiling in seconds and emits `-p RuntimeMaxSec=<S>` when it is given; the `scope` option of `spawnBounded` gains an optional `runtimeMaxSec` that is passed through.
- `tools/scheduler/src/runner/run.ts`: `runStage` passes `req.def.bounds.timeout_min * 60 + 600` as the ceiling.
- `tools/scheduler/test/process.test.ts`: tests for AC-1 and AC-3 on `scopeArgv`.
- `tools/scheduler/test/run.test.ts`: one test asserting the ceiling reaches the scope arguments for a stage definition with a known timeout, using the test's existing fake `systemd-run` shim or an argument capture.

No other file is created or modified.

## 5. Verification

`pnpm install --frozen-lockfile` then `pnpm test` from the repository root
pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
clean. No test spawns a real `systemd-run`; the argument list is asserted.

## 6. Open decisions

None.
