# 004. The pi adapter passes pi's own tool names

Status: approved by the maintainer 2026-10-16.
Class: tooling. Domain: backend.
Derives from: [001-scheduler-core](../001-scheduler-core/spec.md) sections
12 and 13 (AC-18, AC-19); [ADR 0001](../../docs/decisions/0001-harness-per-model-vendor.md);
the branch review's residual R3.

## 1. Goal

Profiles list tools by their Claude Code names (`Read`, `Edit`, `Write`,
`Bash`, `Glob`, `Grep`). The pi adapter passes that list to `pi --tools`
unchanged, which pi does not understand, and when a plan or review stage
has no profile it passes no `--tools` at all, so pi runs with its default
tool set including edit, write and bash. The adapter must always hand pi a
list of pi tool names, and plan and review must always get a read-only
list.

## 2. Out of scope

The claude adapter, the profile files, pi's skill or extension flags, and
any change to which tools a profile grants.

## 3. Acceptance criteria

AC-1. Given a profile tool list in Claude Code names, when the pi command
is built, then each name is mapped case-insensitively to pi's name:
`Read` to `read`, `Edit` to `edit`, `Write` to `write`, `Bash` to `bash`,
`Glob` to `find`, `Grep` to `grep`; a name with no mapping is dropped; the
result has no duplicates and keeps the profile's order.

AC-2. Given a plan or review stage with any profile, when the pi command
is built, then `--tools` is exactly the mapped list with `edit`, `write`
and `bash` removed, and if that leaves nothing it is `read,grep,find`.

AC-3. Given a plan or review stage with no profile, when the pi command is
built, then `--tools read,grep,find` is passed.

AC-4. Given an implement or fix stage with no profile, when the pi command
is built, then no `--tools` argument is passed, as today.

## 4. Interfaces and files

- `tools/scheduler/src/adapters/pi.ts`: a `piToolNames(tools: string[]): string[]` mapping (exported for tests) and the read-only default `read,grep,find`; `buildCommand` uses them as the criteria say.
- `tools/scheduler/test/adapters-pi.test.ts`: tests for AC-1 to AC-4; the existing profile-tools test's expectation changes to the mapped names.

No other file is created or modified.

## 5. Verification

`pnpm install --frozen-lockfile` then `pnpm test` from the repository root
pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
clean. No test spawns a real `pi` process; the argument list is asserted.

## 6. Open decisions

None.
