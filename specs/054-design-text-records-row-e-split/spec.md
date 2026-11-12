# 054. The delivery-system design's section 10 says row E was split into specs 029 and 051

Status: written 2026-11-12 from the delivery-system design for issue #103;
specs derived from that design need no maintainer approval (design section 11).
The section 10 sentence this spec corrects was a protected statement (security
criterion 7); the maintainer's answer to question #6819390363 chose the new
wording and delegated the sentence to agents, and this spec's PR carries that
answer into the design (section 4).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 (the paragraph naming this document's own children), section 11
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
tooling spec).

## 1. Goal

An agent reading the delivery-system design learns that row E was delivered as
two specs hanging directly from the top design, spec 029 (the design stage) and
spec 051 (the console), and does not expect an E sub-design that will never be
written.

### What was wrong

Section 10's last paragraph (lines 413 to 415 of
`docs/delivery-system-design.md` on `main` at 25688b5) read:

> This document's own children are specs A to G below (F split into F1 and F2); E is expected to become
> a sub-design (design stage, console) when it is written.

Row E was written as spec 029 (PR #96) and spec 051 (PR #202), both listed in
this document's `## Children`, because a spec PR could not then introduce a
sub-design (spec 029 section 4; spec 052 fixes the scope gate but leaves row E
as it is). The section 11 table the issue also names no longer exists: spec 031
turned it into the `## Children` section, where row E is already two entries,
`specs/029-design-stage/spec.md` (row E, issue #38) and
`specs/051-console/spec.md` (row E, the console, issue #101).

The sentence was not marked *(author's call)*, so security criterion 7
protected it as a maintainer decision, and the spec stage asked the maintainer
before changing it (question #6819390363, answered: "Correct the sentence and
delegate its descriptive breakdown to agents").

## 2. Out of scope

- Re-parenting spec 029 or spec 051 under a sub-design (spec 052 section 2).
- Row D, F and G wording in section 10: the issue names row E only.
- Section 11's other paragraphs, section 12, the charter, the sensitive-path
  list and the review criteria: unchanged.
- An implementation PR. This spec's PR makes the whole change (section 4);
  nothing is left to build.

## 3. Acceptance criteria

- AC-1. **Section 10 records the split.** Given `docs/delivery-system-design.md`
  on this spec's branch, when an agent reads the last paragraph of section 10,
  then it says this document's children are specs A to G, F split into F1 and
  F2 and E into spec 029 (the design stage) and spec 051 (the console), both
  children of this document; it nowhere says E is expected to become a
  sub-design.
- AC-2. **The breakdown sentence is agents' to keep current.** Given the same
  paragraph, then the sentence of AC-1 carries the mark
  *(author's call: the breakdown, like section 11)* followed by
  `(maintainer answer, question #6819390363)`, so that a later change to the
  breakdown updates the sentence without a new maintainer answer, while the
  rest of section 10 stays protected under security criterion 7.
- AC-3. **Children name both parts of row E.** Given the `## Children`
  section, then the entry for spec 029 reads
  `(row E, the design stage, issue #38)`, the entry for spec 051 reads
  `(row E, the console, issue #101)` as on `main`, and this spec is listed.
- AC-4. **Nothing else changes.** Given `git diff main`, then outside this
  spec's directory only `docs/delivery-system-design.md` differs, and in it
  only the section 10 paragraph of AC-1 and AC-2 and the two `## Children`
  lines of AC-3. No text marked `(maintainer answer, question #<id>)` other
  than the one this spec adds is touched.
- AC-5. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root, then it passes: the spec-present gate and the
  design-tree check accept this spec.

## 4. Interfaces and files

No code, schema or prompt changes. This spec's PR edits one file beyond its own
directory, `docs/delivery-system-design.md`:

- section 10, last paragraph (AC-1, AC-2): the recorded maintainer answer. The
  spec stage may edit a top design in full only while recording a maintainer's
  product answer; question #6819390363 is that answer, and its mark is on the
  sentence.
- `## Children` (AC-3): the spec 029 entry gains "the design stage"; this spec
  is listed.

The file is sensitive (`agents/sensitive-paths.txt`), so the security review
runs. The PR cites question #6819390363 for the protected sentence it changes
(security criteria 7 and 8). This spec plans no change to the charter, to any
other protected decision, to the sensitive-path list, to the security review
criteria or instructions, or to what decides that a sensitive diff gets the
security review, that both reviews must approve, or that a sensitive path must
be listed in the spec.

## 5. Verification

- `pnpm test` from the repository root passes (AC-5).
- `git diff main --stat` lists `docs/delivery-system-design.md` and this
  spec's `spec.md` only (AC-4).
- `grep -n "expected to become" docs/delivery-system-design.md` prints
  nothing; `grep -n "question #6819390363" docs/delivery-system-design.md`
  prints the section 10 line (AC-1, AC-2).
- `grep -n "row E" docs/delivery-system-design.md` prints the spec 029 and
  spec 051 entries of `## Children` (AC-3).

## 6. Open decisions

None.
