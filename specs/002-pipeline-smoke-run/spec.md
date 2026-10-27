# 002. Pipeline smoke run

Status: approved by the maintainer 2026-10-16.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [001-scheduler-core](../001-scheduler-core/spec.md) section 16
(AC-29, the first hand-run); [process-spec](../../docs/process-spec.md)
section 6.

## 1. Goal

Carry one deliberately trivial issue through the whole pipeline, from claim
to merge, so the scheduler's first live run exercises every stage against
the real harness and the real GitHub API with nothing at stake. The change
itself is a single new Markdown page.

## 2. Out of scope

Any change outside the one file named below. No code, no tests, no
configuration, no edits to existing documents.

## 3. Acceptance criteria

AC-1. Given main after this issue's PR is merged, when `docs/pipeline-smoke-run.md`
is read, then it exists, starts with the heading `# Pipeline smoke run`, and
contains one paragraph stating that the file was produced by the panelator
pipeline for this issue, naming the issue number.

AC-2. Given the PR for this issue, when CI runs, then the `test` check
passes, because the change touches no code.

## 4. Interfaces and files

- `docs/pipeline-smoke-run.md`: new. Heading, one paragraph, nothing else.

No other file is created or modified.

## 5. Verification

`pnpm test` passes on the PR. The merged file renders as plain Markdown with
the heading and paragraph of AC-1.

## 6. Open decisions

None.
