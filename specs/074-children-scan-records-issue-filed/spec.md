# 074. The children scan's issue filing is one of spec 026's recorded creations

Status: written 2026-11-18 from the delivery-system design for issue #142;
specs derived from that design need no maintainer approval (design section 11).
Amends [026-event-store](../026-event-store/spec.md) AC-2 (the `issue.filed`
kind names the children scan's filing beside the filer's two) and section 5
(the recording-call list names `tools/scheduler/src/children/scan.ts`). Each is
marked as section 4 records.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 3 ("Recording": everything is recorded raw), section 7 (metrics are
queries over the raw events) and section 10 ("Small work skips layers": a
tooling spec hangs directly off a top design);
[metrics and reflection design](../../docs/designs/metrics-reflection.md)
section 3, "Contracts between the children" ("`createIssueRecorded` belongs to
026. The one-caller test holds from 026 on", unchanged here);
[026-event-store](../026-event-store/spec.md) AC-2 and section 5 (amended);
[031-design-files-children](../031-design-files-children/spec.md) AC-4 (the
scan files one issue per planned child) and section 2 ("When it lands, the
filing of AC-4 goes through its recorded wrapper as the findings filer's does,
which is that spec's change, not this one's").

## 1. Goal

Spec 026 says every issue the scheduler creates goes through
`createIssueRecorded` and records `issue.filed`, and a test asserts that
`src/events/filed.ts` is the only caller of the client's `createIssue`. Its
enumeration of the creations, and its list of recording calls, name only the two
calls in `src/filer/apply.ts`: it was written before spec 031 (#135) gave
`src/children/scan.ts` a third creation, a planned child's issue. Issue #142
found the gap while 026 was unbuilt.

How this reaches `main`: spec 026 has since been built (#197), and its build
already routed the scan's filing through the wrapper
(`tools/scheduler/src/children/scan.ts` line 135 calls `createIssueRecorded`
with `by: d.botLogin`, `class: labels[0]`, `marker: childMarker(design, slug)`),
so the one-caller test passes on `main`. What is still missing is that spec 026
does not say so, and no test asserts the scan's `issue.filed`: a later change to
the scan could drop or misfill the record and only the one-caller test, which
checks the call and not the payload, would stand in the way. This spec writes
the scan into spec 026 by marks and adds that test. *(agent's call: the issue
asks for 026's text to change; since 026 is built, the change is recorded as
marks on 026 with the payload pinned here, which is how a landed spec is amended
(spec 039, ADR 0009).)*

## 2. Out of scope

- Any change to the recording itself, to `createIssueRecorded`, to the
  `issue.filed` payload schema or to the one-caller test: all are on `main` and
  stay as they are.
- What happens when `createIssueRecorded` creates the issue and then fails to
  record (a full disk, a schema failure): the issue exists without its
  `issue.filed`, for the filer and the scan alike. That is a property of the
  wrapper, not of the scan, and is not changed here.
- The design's sentence "The one-caller test holds from 026 on": it already
  states the rule the scan follows and stays as it is, as the issue says.
- Spec 031's section 2 bullet quoted above: it said the wrapping was 026's
  change, which it was; it is not marked.
- Spec 028's reflection issues: still that spec's addition to the list, as
  spec 026 AC-2 says.

## 3. Acceptance criteria

- AC-1. **The scan's filing records `issue.filed`.** Given a merged design with
  a planned child that has no issue, when the children scan files the child's
  issue (spec 031 AC-4), then it creates it through `createIssueRecorded` and
  exactly one `issue.filed` event is recorded for it, with `issue` the new
  issue's number and the payload `{ number, by, class, labels, marker, body }`
  where `number` is the new issue's number, `by` is the scan's App bot login
  (`ChildrenDeps.botLogin`, the same login the filer passes), `class` is the
  child's class label (the first of its labels: the entry's `class:` or spec
  031 AC-1's default), `labels` are the labels the issue was created with (the
  class, `validated`, and `blocked` when the child is filed blocked), `marker`
  is `<!-- panelator-child:<design path>:<slug> -->` and `body` is the issue
  body as created. Given the same design on the next scan, then nothing is
  filed and no second `issue.filed` is recorded. A test in
  `tools/scheduler/test/children.test.ts` runs the scan on a design with two
  planned children, one filed blocked, and asserts the two events and their
  payloads by reading the event store, then runs the scan again and asserts the
  count is still two.
- AC-2. **A failed creation records nothing.** Given the client's `createIssue`
  throws while the scan files a child, then no `issue.filed` is recorded and the
  scan's `child-filing-failed` handling of spec 031 AC-4 is unchanged. A test in
  `tools/scheduler/test/children.test.ts` asserts no `issue.filed` event after
  such a scan.
- AC-3. **Spec 026 names the scan.** Given spec 026 on `main` after this spec's
  PR, then its AC-2 carries the mark
  `Amended by [074-children-scan-records-issue-filed](../074-children-scan-records-issue-filed/spec.md) AC-1:`
  saying the children scan's filing of a planned child is one of the
  creations `issue.filed` records, and its section 5 carries a block-quote mark
  under the heading saying the recording calls include
  `tools/scheduler/src/children/scan.ts`, `issue.filed` through
  `createIssueRecorded` at the filing of a planned child. The earlier text
  follows each mark unchanged (section 4).

## 4. Design notes (agent's calls)

- **The marks.** Spec 026 AC-2 is one criterion holding every kind, and the
  `issue.filed` bullet inside it has no bold title, so the smallest unit the
  mark can go on is the criterion: it is prepended after `AC-2.`, before the
  marks of specs 068 and 063 already there. Section 5's recording-call list is
  a bullet inside the section with no title of its own, so its mark is a block
  quote under the `## 5. Interfaces and files` heading. Both are written in
  this spec's PR (AC-3); neither changes the text that follows them.
- **`by` for the scan.** The issue asks for a `by` value for the scan. It is
  the App's bot login, the account the scan files with (spec 031 AC-4 "with the
  App's credentials") and the one the filer records, so a query over
  `issue.filed` reads every scheduler-created issue as the App's. The scan is
  told apart from the filer by its marker (`panelator-child:` against
  `panelator-finding:` and the capability marker), not by `by`. *(agent's
  call: a separate `by` value such as `children-scan` would make `by` mean "the
  component" for one producer and "the account" for the others; the marker
  already carries the distinction.)*
- **No callers list test.** A test pinning the callers of
  `createIssueRecorded` to the filer and the scan would make spec 028's
  reflection filing fail it until 028 edits the test. The one-caller test on
  `createIssue` already guarantees every creation records, which is the rule
  the design states; this spec adds the payload test for the scan only.

## 5. Interfaces and files

The paths in backticks are what the scope gate reads; `tools/scheduler/` is a
sensitive path, so each file is listed in full.

- `tools/scheduler/test/children.test.ts`: the tests of AC-1 and AC-2, reading
  the events the scan recorded under the test's state directory (through
  `openIndex` or the monthly JSONL, the implementer's call).
- `tools/scheduler/src/events/filed.ts`: its doc comment cites spec 012 AC-2,
  which the split of ADR 0004 moved to spec 026 AC-2; it is changed to cite
  spec 026 AC-2. No code in it changes.
- `specs/026-event-store/spec.md`: the two marks of AC-3, written in this
  spec's PR, not by the implementation.

No other file is changed by the implementation. No source behaviour changes:
the scan already calls the wrapper. Nothing here changes the sensitive-path
list, the security criteria, or what routes a sensitive diff to the security
review; `tools/scheduler/` is a sensitive path, so the security review runs on
the implementation PR as spec 006 AC-9 says.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including the AC-1 and AC-2 tests and spec 026's one-caller test, unchanged.
- The AC-1 test fails if `scan.ts` is changed back to call `d.gh.createIssue`
  directly (checked by hand during implementation and noted in the PR).
- Spec 026's marks are present as AC-3 says (read in the spec review).

## 7. Open decisions

None.
