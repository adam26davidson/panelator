# 044. A conversation turn outside a conversation is an invalid result

Status: written 2026-11-06 from the delivery-system design for issue #76;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 ("The chain with no human stops": a failed run is retried and
bounded by the chain's own counts) and section 10 ("Small work skips
layers": a bug spec hangs directly off a top design);
[001-scheduler-core](../001-scheduler-core/spec.md) AC-22 (a result that
fails its schema is a failed run with `result: invalid` and the validation
errors), which this spec extends to one more invalid shape without marking
it; [007-telegram-channel](../007-telegram-channel/spec.md) AC-13 (the
conversation turn and its `settled` result), which this spec leaves as it is;
[006-no-human-stops](../006-no-human-stops/spec.md) AC-7 (the chain-error
release), which a conversation-shaped result must no longer reach.

## 1. Goal

A stage run that is not a conversation turn and returns the conversation
shape `{ "conversation": "settled", "decision": "..." }` fails as an invalid
result, with a reason that names the mistake, on every stage alike. It never
reaches the chain machine, never throws in a transition, and never counts
toward the chain-error release.

### What is wrong today

Spec 007 AC-13 added the conversation turn: a resumed asking session that
answers the maintainer's reply and returns `settled` when nothing more is
needed. Its result shape was added as a second `oneOf` branch to the result
schemas of the asking stages (`plan-result.json`, `implement-result.json`,
`review-result.json`, `fix-result.json`, `spec-result.json`,
`design-result.json` under `schemas/scheduler/`). The runner
(`tools/scheduler/src/runner/run.ts`) validates every result against its
stage's whole schema, so the conversation shape passes validation on a plain
run too. The driver (`tools/scheduler/src/chain/driver.ts`) treats the
result as a conversation only when `state.conversation` is set; otherwise
`stageEvent` hands it to the stage's checks, which were written for the
verdict shape:

- `review` is passed through unchecked. The machine's review case
  (`tools/scheduler/src/chain/machine.ts`, `stageOk`) reads
  `r.findings_on_pr.map` and throws a `TypeError` inside `transition`. The
  driver step rejects, the loop counts it as a chain failure
  (`tools/scheduler/src/service/loop.ts`), and repeated ones become the
  `chain_error` release of spec 006 AC-7: a harsher path than a failed
  run's retry, with a reason that names a scheduler error rather than the
  agent's mistake.
- `plan` fails as `profile not available: undefined`; `design` as
  `result: invalid: spec_path differs from the issue's Spec: line`;
  `implement`, `fix` and `spec` as `result: pr mismatch`. Each is a failed
  run, which is the right outcome, but each reason points at the wrong
  thing.

The outcome is safe in every case (nothing is approved or merged), but the
review path fails the chain instead of the run, and the reasons differ by
stage for one and the same mistake.

### The fix

The runner knows whether the run is a conversation turn (its request carries
`conversation`). It refuses a result that carries `conversation` when the
run is not one, as part of the result check it already does, before the
result is handed to the driver. The failure is the existing invalid-result
failure of spec 001 AC-22, with the validation error naming the mistake, so
every stage fails the same way and the chain's ordinary retry applies. The
schemas stay as they are: the conversation branch is still a valid result of
a conversation turn.

*(agent's call)* The check belongs in the runner, not the driver or the
machine, because the runner is where a result is judged against what the
run was allowed to return, and it is the one place every agent stage passes
through (spec, design, plan, implement, review, fix). Narrowing the schema
per mode instead (validate against the conversation branch only when
`conversation` is set) would mean either two schema files per stage or a
runtime edit of the `oneOf`; the explicit check is a few lines and reports a
plainer error. The machine is left unguarded on purpose: a `stage_ok` of
review without `findings_on_pr` is a driver bug, and a throw is the right
signal for one. The change is small and reversible; no ADR (design section
3, item 2).

## 2. Out of scope

- The conversation turn itself (spec 007 AC-13): what a turn may return,
  the retry of a failed turn, and the `settled` row are unchanged. A
  conversation turn that returns the verdict shape is already a failed turn
  under AC-13 and the machine's conversation handling; this spec does not
  touch it.
- The result schemas under `schemas/scheduler/`: no branch is removed or
  split. The schema test that accepts the settled shape on every asking
  stage keeps passing.
- The chain-error release of spec 006 AC-7 and the transient-error rules
  of spec 015: unchanged. This spec only stops one agent mistake from
  reaching them.
- The reasons the stage checks give for other malformed results
  (`pr mismatch`, `profile not available`, `spec_path differs`): unchanged
  for the results they were written for.
- A conversation shape returned by the question check, a standing agent or
  the filer: their schemas have no conversation branch, so the shape already
  fails as `result: invalid`.

## 3. Acceptance criteria

"Given" states use the fake harness and mocked GitHub API of spec 001. The
*conversation shape* is a result object with a `conversation` property. A
*plain run* is a stage run started with `conversation` unset or false in its
request: every run that is not the conversation turn of spec 007 AC-13,
including a resumed session that continues its work with an answer.

- AC-1. **A plain run returning the conversation shape is an invalid
  result.** Given a plain run of any agent stage (spec, design, plan,
  implement, review or fix) whose result file holds a result that validates
  against its stage's schema and carries `conversation`, when the run ends
  with exit 0, then the runner records the run as failed with reason
  `result: invalid: conversation turn outside a conversation`, the run's
  `outcome.json` has that same text as its one `resultErrors` entry, and
  the result is not returned to the driver (the run's `result` is null, as
  for any invalid result). The run's usage record and events are written as
  for any failed run. Given the result file is missing and the final text
  holds the conversation shape, then the same applies when the run is one
  the runner reads the final text for; a plain run on a harness with a
  write tool keeps failing as `result file missing`, as today.
- AC-2. **A plain review run fails as a run, not as a chain failure.**
  Given a chain at `review`, attempt 1, with a PR bound, whose review run
  returns `{ "conversation": "settled", "decision": "approve it" }`, then
  the driver step resolves (it does not reject), the claim's history gains
  `review attempt 1 failed: result: invalid: conversation turn outside a
  conversation`, the state is at `review` attempt 2 with `chainFailures`
  null and `chainErrors` 0, no `chain-error` or `pending-work-failing` line
  is written to the service log, no finding with `noticed_how: "scheduler
  chain error"` is queued, and the PR is neither approved nor merged. Given
  the second attempt returns a valid verdict, then the chain continues as
  spec 006 says for that verdict.
- AC-3. **Every other stage fails the same way.** Given a plain run of
  plan, implement, fix, spec or design that returns the conversation shape,
  then the claim's history entry is `<stage> attempt <n> failed: result:
  invalid: conversation turn outside a conversation` and the chain takes the
  failed-run row of spec 006 section 4 for that stage (a second attempt
  where the stage has one, the rescue path where it does not). None of
  `result: pr mismatch`, `profile not available` or `spec_path differs` is
  recorded for that result, the issue body is not edited, and no PR is
  looked up for it.
- AC-4. **A conversation turn is unchanged.** Given a conversation turn
  (spec 007 AC-13: the asking stage resumed with `conversation` set), when it
  returns `{ "conversation": "settled", "decision": "..." }`, then the
  runner accepts it as today and the machine takes the `settled` row; when
  it returns a follow-up, then it pauses as today. The existing conversation
  tests (the schema test accepting the settled shape on every asking stage,
  the driver's conversation-protection tests, the recorded end-to-end chains
  of spec 007 section 6) pass unchanged.

## 4. Interfaces and files

- `tools/scheduler/src/runner/run.ts`: in the result check, after the
  schema validation passes and before the result is kept, a plain run
  (`req.conversation` not true) whose parsed result is an object with a
  `conversation` property gets `resultErrors = ["conversation turn outside a
  conversation"]` and the judgement `{ outcome: "failed", reason: "result:
  invalid: conversation turn outside a conversation" }` (AC-1). The check
  applies only to agent stages (`req.def.kind !== 'standing'`, not the filer
  result); a standing or filer schema has no such branch and is not touched.
  The findings side channel still queues `findings` from the parsed result,
  as for any result that parsed (spec 001 AC-28). Nothing else in the runner
  changes: the final-text fallback, the usage record and `outcome.json` are
  written as today.
- `tools/scheduler/src/chain/driver.ts`, `tools/scheduler/src/chain/machine.ts`,
  `tools/scheduler/src/service/loop.ts`, `schemas/scheduler/*.json`:
  unchanged. The review case of `stageOk` keeps reading `findings_on_pr`
  unconditionally; after this spec no plain run's result reaches it without
  one.
- `tools/scheduler/test/run.test.ts` (the tests of `runStage`'s result
  check): AC-1 for a plain run with the conversation
  shape (the reason, the one `resultErrors` entry, `result` null) and for a
  conversation turn with the same shape (accepted).
- `tools/scheduler/test/driver.test.ts`: AC-2 with a scripted review run
  returning the conversation shape: `step` resolves, the history entry, the
  state at review attempt 2, `chainFailures` null, no chain-error log line
  or finding, no approve or merge call to the mocked GitHub. AC-3 for at
  least implement and spec, asserting the history entry and that the
  earlier reason (`result: pr mismatch`) is not recorded and no PR route is
  called for that run.
- `tools/scheduler/test/schema.test.ts`: unchanged; its conversation test
  keeps passing (AC-4).

No file outside `tools/scheduler/` and `specs/` is changed. `tools/scheduler/`
is a sensitive path, so the security review runs on the implementation PR as
spec 006 AC-9 says. No schema, config key, stage prompt, state file format
or log kind changes; the new reason is a run reason like `result: invalid`,
recorded in the claim's history, the run's `outcome.json` and the `stage`
service-log line as any failed run's reason is.

## 5. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  with the tests of section 4 added.
- The existing tests that pin `result: pr mismatch` for a wrong PR binding,
  `result: invalid` for a `spec_path` outside `specs/`, and the settled
  conversation shape on every asking stage pass without edits.
- A grep of `tools/scheduler/src` shows the string `conversation turn
  outside a conversation` in `runner/run.ts` and its test only.
- Every recorded end-to-end chain of spec 006 AC-28 and spec 007 section 6
  passes unchanged.

## 6. Open decisions

None.
