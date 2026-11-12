# 053. The delivery-system design's section 10 says row E was split into specs 029 and 051

Status: written 2026-11-12 from the delivery-system design for issue #103;
specs derived from that design need no maintainer approval (design section 11).
Draft: the section 10 sentence is a protected statement (security criterion 7),
so its new wording waits on the maintainer's answer to the question this spec
stage returned.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 (the paragraph naming this document's own children, "E is expected
to become a sub-design (design stage, console) when it is written"), section 11
(the breakdown is the `## Children` section, spec 031) and section 6.2 (a
reviewed PR for every change to repository content);
[029-design-stage](../029-design-stage/spec.md) section 4 (row E was flattened
into spec 029 and a sibling console spec);
[051-console](../051-console/spec.md) (the console, row E's second part);
[052-spec-pr-lists-its-new-sub-design](../052-spec-pr-lists-its-new-sub-design/spec.md)
section 2 (row E is not restructured again);
[ADR 0004](../../docs/decisions/0004-split-metrics-reflection-spec.md) (row D's
split, the precedent for recording a split in the breakdown);
[047-spec-017-cites-stages-section](../047-spec-017-cites-stages-section/spec.md)
(the convention: landed text outside a spec PR's scope is corrected by a small
tooling spec whose implementation PR edits it).

## 1. Goal

An agent reading the delivery-system design learns that row E was delivered as
two specs hanging directly from the top design, spec 029 (the design stage) and
spec 051 (the console), and does not expect an E sub-design that will never be
written.

### What is wrong today

Section 10's last paragraph (lines 413 to 415 of
`docs/delivery-system-design.md` on `main` at 25688b5) reads:

> This document's own children are specs A to G below (F split into F1 and F2); E is expected to become
> a sub-design (design stage, console) when it is written.

Row E was written as spec 029 (PR #96) and spec 051 (PR #202), both listed in
this document's `## Children`, because a spec PR could not then introduce a
sub-design (spec 029 section 4; spec 052 fixes the scope gate but leaves row E
as it is). The section 11 table the issue also names no longer exists: spec 031
turned it into the `## Children` section, where row E is already two entries,
`specs/029-design-stage/spec.md` (row E, issue #38) and
`specs/051-console/spec.md` (row E, the console, issue #101).

## 2. Out of scope

- Re-parenting spec 029 or spec 051 under a sub-design (spec 052 section 2).
- Row D, F and G wording in section 10: the issue names row E only.
- Section 11's other paragraphs, section 12, the charter, the sensitive-path
  list and the review criteria: unchanged.

## 3. Acceptance criteria

- AC-1. **Children name both parts of row E.** Given this spec's PR, then the
  `## Children` entry for spec 029 reads `(row E, the design stage, issue #38)`
  and the entry for spec 051 is as on `main`.
- AC-2. **Section 10 records the split.** Given the change that carries the
  maintainer's answer, then the section 10 sentence no longer says E is
  expected to become a sub-design and instead says E was split into spec 029
  (the design stage) and spec 051 (the console), both children of this
  document; the edit cites `(maintainer answer, question #<id>)`. Pending
  that answer.
- AC-3. **Nothing else changes.** Given the diffs, then outside this spec's
  directory only the lines of AC-1 and AC-2 differ from `main`.
- AC-4. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root, then it passes.

## 4. Interfaces and files

No code, schema or prompt changes. `docs/delivery-system-design.md` only: its
`## Children` entry for spec 029 (AC-1) and the section 10 sentence (AC-2).
The file is sensitive, so the security review runs.

## 5. Verification

- `pnpm test` from the repository root passes (AC-4).
- `git diff main -- docs/delivery-system-design.md` shows only the lines of
  AC-1 and AC-2 (AC-3).

## 6. Open decisions

None.
