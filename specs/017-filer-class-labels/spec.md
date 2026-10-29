# 017. The findings filer's class labels

Status: written 2026-10-29 from the delivery-system design for a live
defect found right after specs 013 to 016 were deployed; specs derived from
that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (the findings filer) and section 10 ("Small work skips layers":
a bug spec hangs directly off a top design);
[008-agent-registry](../008-agent-registry/spec.md) AC-15 (the filer's input)
and AC-16 (`class` is one of the class labels of `agents/scheduler.yaml`);
[014-filer-batch-integrity](../014-filer-batch-integrity/spec.md) (the
filer can always make progress); amends 008 AC-15 and AC-16 as section 4
records.

## 1. Goal

One decision's class label can no longer throw away a whole batch.

### What happens today (observed live 2026-10-29)

Run `standing-findings-filer-2-1793274946208` succeeded at the model: 21
decisions for 20 queue records and one abandoned issue. The apply step then
rejected the whole batch with `unknown issue class tooling`:
`applyFilerResult` validates every decision before any effect, and requires
`issue.class` to be exactly one of the configured labels (`class:product`,
`class:bug`, `class:tooling`, `class:dependency`). The model wrote
`"tooling"`, without the `class:` prefix, on eight `file` and `merge_into`
decisions. The prompt only says "Choose class from the scheduler
configuration", and nothing in the input lists the labels, so the model
guessed. Two such failures notify the maintainer, and each throws away a
strong-tier run's work.

### Why a new spec rather than an amendment to 014

Spec 014 is delivered and deployed; its acceptance criteria are about which
refs a batch holds and where the cursor goes, and they all still hold here.
This defect is about the content of one field and the input the model is
given (spec 008 AC-15, AC-16), so it is a separate small bug spec off the
top design, as the README allows, and it amends 008 rather than 014.

### Fallback rather than skip

A decision whose class still cannot be resolved is applied with a default
label, not skipped. Skipping would leave its ref unsettled: spec 014 AC-2
and AC-4 keep that correct (later settled refs are not re-sent, the cursor
stops before it), but the next strong-tier run would investigate the same
record again, could guess the same wrong label again, and the cursor would
stay behind it meanwhile. The class is only a label on an issue, which any
later stage or the maintainer can change; the investigation is the
expensive part, so it is kept.

## 2. Out of scope

- Other fields of a decision the model may get wrong (outcomes, question
  kinds); they still reject the batch as in spec 008 AC-16.
- Relabelling issues already filed.
- Choosing the class from the finding's content in code.

## 3. Acceptance criteria

"Given" states use temporary state directories and a mocked GitHub client,
as in `tools/scheduler/test/filer.test.ts`.

- AC-1. **The input lists the labels.** Given a filer run, then the filer
  input carries `issue_classes`: the configured `feature_classes` followed
  by `debt_classes`, exactly as written in `agents/scheduler.yaml`. The
  filer prompt tells the model to copy `class` from `issue_classes` exactly,
  with its prefix.
- AC-2. **Unambiguous near misses are resolved.** Given a decision's
  `issue.class` that is not a configured label, then it is resolved to the
  one configured label that equals it, or equals `class:` plus it, ignoring
  case and surrounding whitespace. An exact match always wins; a value that
  matches more than one label is not resolved. Given the live shape
  (`"class": "tooling"` on `file` and `merge_into` decisions), then the
  issues are created with `class:tooling`.
- AC-3. **An unresolved class does not reject the batch.** Given a `file`,
  `merge_into`, `escalate` or `rewrite` decision whose class AC-2 cannot
  resolve, then it is applied with `class:bug` (or the first configured
  class when `class:bug` is not configured), its triage reason says
  `class '<value>' is not configured; labelled <label>`, and the service log
  gets `{kind: "filer-class-fallback", run_id, ref, class, used}`. The other
  decisions of the batch apply as usual and the cursor moves past it (spec
  014 AC-4). A class on any other outcome is ignored, as it is not used.

## 4. Amendments to earlier specs

- Spec 008 AC-15: the filer's input also carries `issue_classes` (AC-1
  here).
- Spec 008 AC-16: "`class` is one of the class labels of
  `agents/scheduler.yaml`" is what the model is asked for; the scheduler
  resolves near misses and falls back for the rest (AC-2, AC-3 here) instead
  of failing the run.

## 5. Interfaces and files

- `tools/scheduler/src/filer/input.ts`: `FilerInput.issue_classes`;
  `FilerDeps.log` (optional).
- `tools/scheduler/src/filer/apply.ts`: `resolveClass(value, classes)`, the
  default label shared with the existing `class:bug` fallback, and the
  per-decision resolution before applying.
- `tools/scheduler/src/standing/run.ts`: the filer's deps take the service
  log.
- `schemas/scheduler/filer-input.json`: `issue_classes`.
- `agents/standing/findings-filer.md`: copy `class` from `issue_classes`.
- `tools/scheduler/test/filer.test.ts`: AC-1 to AC-3, including the live
  regression.

- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `docs/delivery-system-design.md` are
sensitive paths; the security review applies (spec 006 AC-9).

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-2 regression test fails on `main` (`unknown issue class tooling`)
  and passes after the change.
- Live check after deploy: the next findings-filer run's `input.json` holds
  `issue_classes`, and its batch applies.

## 7. Open decisions

None.
