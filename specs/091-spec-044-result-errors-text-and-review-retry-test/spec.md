# 091. Spec 044 follow-ups: AC-1's `resultErrors` text, and the AC-2 test checks the approve verdict's row

Status: written 2026-11-19 from the delivery-system design for issue #188;
specs derived from that design need no maintainer approval (design section 11).
Marks [044-conversation-turn-outside-a-conversation-is-an-invalid-result](../044-conversation-turn-outside-a-conversation-is-an-invalid-result/spec.md)
AC-1 (amended by AC-1 here).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design);
[044-conversation-turn-outside-a-conversation-is-an-invalid-result](../044-conversation-turn-outside-a-conversation-is-an-invalid-result/spec.md)
AC-1, AC-2 and section 4 (the criteria and interface this spec corrects and
tests); [001-scheduler-core](../001-scheduler-core/spec.md) AC-22 (a failed
run's reason `result: invalid` and its validation errors are separate
values); [006-no-human-stops](../006-no-human-stops/spec.md) section 4 (the
review rows: `approve` goes to merge, or to the security review on a
sensitive diff).

## 1. Goal

Spec 044's text and its tests say the same thing as its code.

1. **AC-1's `resultErrors` text.** Spec 044 AC-1 says the runner fails the
   run with reason `result: invalid: conversation turn outside a
   conversation` and that `outcome.json` has "that same text" as its one
   `resultErrors` entry. Spec 044 section 4 says the entry is the bare
   `conversation turn outside a conversation` and only the reason carries
   the `result: invalid: ` prefix. The merged runner
   (`tools/scheduler/src/runner/run.ts`, `OUTSIDE_CONVERSATION`) and its
   test (`tools/scheduler/test/run.test.ts`, which asserts
   `resultErrors` equal to `["conversation turn outside a conversation"]`
   and the same in `outcome.json`) follow section 4, as does spec 001 AC-22,
   which keeps a failed run's reason and its validation errors apart. AC-1
   is the text at fault; this spec amends it with a mark. The code does not
   change.
2. **The AC-2 test's second step.** Spec 044 AC-2 ends: "Given the second
   attempt returns a valid verdict, then the chain continues as spec 006
   says for that verdict". The test in
   `tools/scheduler/test/driver.test.ts` ("fails a plain review run
   returning the conversation shape as a run, not a chain failure (spec 044
   AC-2)") scripts `approve` as the second review result, steps once more,
   and asserts only that the history does not contain the exact line
   `review attempt 2 failed: result: invalid`. That line could never match
   the real failure text (which goes on with `: conversation turn outside a
   conversation`), and the assertion passes whether or not the approval
   moved the chain on. The test is changed to assert the row spec 006
   section 4 gives `approve`.

*(agent's call)* The text is amended, not the code: the code matches
section 4 and spec 001 AC-22, and a `resultErrors` entry carrying the
reason's prefix would repeat in the errors list what the reason already
says. The test asserts the stage the approve row leads to rather than a
later merge call: the merge is the next step's work and has its own tests,
and the stage is what AC-2's second Given is about.

## 2. Out of scope

- `tools/scheduler/src/`: no source file changes. The runner's check, the
  driver and the machine stay as spec 044 left them.
- Spec 044's other criteria and sections: AC-2, AC-3, AC-4 and section 4 are
  correct as written and are not marked.
- `tools/scheduler/test/run.test.ts`: its AC-1 assertions already match the
  amended text and are not edited.
- The AC-3 tests in `driver.test.ts` (implement and spec): unchanged.
- The merge step after the approval, and the security-review path of a
  sensitive diff: covered by their own tests and not exercised here.

## 3. Acceptance criteria

"Given" states use the fake harness and mocked GitHub API of spec 001, as
spec 044 does.

- AC-1. **The `resultErrors` entry is the bare text.** Given a plain run of
  any agent stage whose result validates against its stage's schema and
  carries `conversation` (spec 044 AC-1), when the run ends with exit 0,
  then the run's reason is `result: invalid: conversation turn outside a
  conversation`, its `resultErrors` (in the runner's return value and in
  `outcome.json`) is exactly `["conversation turn outside a conversation"]`,
  without the `result: invalid: ` prefix, and everything else spec 044 AC-1
  says applies unchanged. Spec 044 AC-1 carries an `Amended by` mark
  naming this spec's AC-1, whose clause says the one `resultErrors` entry
  is the bare text and only the reason carries the `result: invalid: `
  prefix, placed between `AC-1.` and its bold title; its text after the
  mark is unchanged. The existing assertions of `run.test.ts` on this case pass
  without edits.
- AC-2. **The AC-2 test checks where the approval sends the chain.** Given
  the spec 044 AC-2 test (a chain at `review`, attempt 1, PR 9 bound, the
  review script `[settled, approve]`, a diff that touches no sensitive
  path), when the test takes the second `step` after the failed first
  attempt, then it asserts that:
  - the second review run ran: the scripted adapter's run list holds two
    review runs;
  - no history entry starts with `review attempt 2 failed`;
  - the state has left `review` for `merge`, the row spec 006 section 4
    gives `approve` on a diff that is not sensitive, with `chainFailures`
    null and `chainErrors` 0.
  The test's first-step assertions (spec 044 AC-2) are kept as they are.
  The assertion `not.toContain("review attempt 2 failed: result:
  invalid")` is replaced by the prefix check above. A change that made the
  second attempt fail for any reason, or left the chain at `review` after a
  valid `approve`, fails the test.

## 4. Interfaces and files

- `specs/044-conversation-turn-outside-a-conversation-is-an-invalid-result/spec.md`:
  the AC-1 mark of AC-1 above, and nothing else.
- `tools/scheduler/test/driver.test.ts`: the spec 044 AC-2 test's second
  step asserts AC-2 above (the adapter's `ran` list has two `review:`
  entries, `r2.claim.state.history.some((h) => h.startsWith("review attempt
  2 failed"))` is false, `r2.claim.state` matches `{ stage: "merge",
  chainFailures: null, chainErrors: 0 }`). The test's title gains
  `, then continues on approve` or similar wording; it keeps citing spec
  044 AC-2 and adds spec 091 AC-2.
- `docs/delivery-system-design.md` `## Children`: lists this spec.

No source file, schema, config key, stage prompt, state file format or log
kind changes. `tools/scheduler/` is a sensitive path, so the security review
runs on the implementation PR as spec 006 AC-9 says; the change there is a
test only.

## 5. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean
  with the test of section 4 changed.
- The changed test fails when the second scripted review result is replaced
  by the conversation shape again (the second attempt then fails), and when
  it is replaced by a `changes_requested` verdict (the state goes to `fix`,
  not `merge`); checked by hand once while writing the test, not committed.
- `git diff main -- tools/scheduler/src` is empty.
- In spec 044, the only change is the mark before AC-1's bold title.

## 6. Open decisions

None.
