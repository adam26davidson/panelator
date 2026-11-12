# 054. The delivery-system design's section 10 says row E was split into specs 029 and 051

Status: written 2026-11-12 from the delivery-system design for issue #103;
specs derived from that design need no maintainer approval (design section 11).
The section 10 sentence this spec corrects is a protected statement (security
criterion 7); the maintainer's answer to question #6819390363 chose the new
wording and delegated the sentence to agents, and this spec's implementation
PR carries that answer into the design (section 4).
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
tooling spec whose implementation PR edits the landed text).

## 1. Goal

An agent reading the delivery-system design learns that row E was delivered as
two specs hanging directly from the top design, spec 029 (the design stage) and
spec 051 (the console), and does not expect an E sub-design that will never be
written.

### What is wrong today

Section 10's last paragraph (lines 413 to 415 of
`docs/delivery-system-design.md` on `main` at d66927b) reads:

> This document's own children are specs A to G below (F split into F1 and F2); E is expected to become
> a sub-design (design stage, console) when it is written. The existing specs
> 001 to 005 get `Parent: docs/delivery-system-design.md` as part of B.

Row E was written as spec 029 (PR #96) and spec 051 (PR #202), both listed in
this document's `## Children`, because a spec PR could not then introduce a
sub-design (spec 029 section 4; spec 052 fixes the scope gate but leaves row E
as it is). The section 11 table the issue also names no longer exists: spec 031
turned it into the `## Children` section, where row E is already two entries,
`specs/029-design-stage/spec.md` (row E, issue #38) and
`specs/051-console/spec.md` (row E, the console, issue #101).

The sentence is not marked *(author's call)*, so security criterion 7
protects it as a maintainer decision, and the spec stage asked the maintainer
before planning a change to it. Question #6819390363 offered three options and
the maintainer chose the second: "Correct the sentence and delegate its
descriptive breakdown to agents".

### Why the implementation PR makes the change

A spec PR may edit a top design only in its `## Children` section, unless it
records a maintainer's product answer; the answer to question #6819390363 is
logged as a capability answer, so this spec's PR could not carry the section 10
edit (the scope gate rejected it twice). The implementation PR, whose plan
names `docs/delivery-system-design.md`, makes the edit instead, as the
convention of spec 047 has a tooling spec do for landed text. Its diff adds
the citation `(maintainer answer, question #6819390363)` to the sentence it
changes, which is how the security review's cited-answers list verifies the
answer (security criteria 7 and 8).

## 2. Out of scope

- Re-parenting spec 029 or spec 051 under a sub-design (spec 052 section 2).
- Row D, F and G wording in section 10: the issue names row E only.
- Section 11's other paragraphs, section 12, the charter, the sensitive-path
  list and the review criteria: unchanged.
- Any other statement of section 10, or of the design, that security
  criterion 7 protects: the delegation of question #6819390363 covers the one
  breakdown sentence and nothing else.
- Code, schema, prompt and test changes: none. The implementation PR edits
  one paragraph of one document.

## 3. Acceptance criteria

"Given" states are the files on the implementation PR's branch, read as text;
"then" clauses are checked by reading them and by `pnpm test` where it says so.

- AC-1. **Section 10 records the split.** Given `docs/delivery-system-design.md`,
  when an agent reads the last paragraph of section 10, then it says this
  document's children are specs A to G, F split into F1 and F2 and E into
  spec 029 (the design stage) and spec 051 (the console), both children of
  this document; it nowhere says E is expected to become a sub-design.
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
  The spec PR makes this change; the implementation PR leaves `## Children`
  as the spec PR left it.
- AC-4. **Nothing else changes.** Given the implementation PR's diff against
  `main`, then it touches `docs/delivery-system-design.md` only, and in it only
  the section 10 paragraph of AC-1 and AC-2: the sentence "The existing specs
  001 to 005 get `Parent: docs/delivery-system-design.md` as part of B." stays
  as it is, and no text marked `(maintainer answer, question #<id>)` other
  than the mark AC-2 adds is touched.
- AC-5. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root, then it passes: the spec-present gate and the
  design-tree check accept this spec, and the implementation PR changes no
  test.

## 4. Interfaces and files

No code, schema or prompt changes. The implementation PR edits exactly one
file, `docs/delivery-system-design.md`, in one place:

- section 10, last paragraph (AC-1, AC-2): the two sentences that begin
  "This document's own children" and "E is expected to become" are replaced by
  the recorded maintainer answer. The sentence about specs 001 to 005 stays.

The spec PR itself adds `specs/054-design-text-records-row-e-split/spec.md`
and, in the `## Children` section of `docs/delivery-system-design.md`, lists
this spec and gives the spec 029 entry the words "the design stage" (AC-3).

`docs/delivery-system-design.md` is sensitive (`agents/sensitive-paths.txt`),
so the security review runs on the implementation PR, and the file is named
here so the scope gate accepts the sensitive diff. The implementation PR's
diff cites question #6819390363 in the mark it adds to the sentence it changes
(security criteria 7 and 8); the question is logged as answered on issue #103,
which is what marks the citation verified. This spec plans no change to the
charter, to any other protected decision, to the sensitive-path list, to the
security review criteria or instructions, or to what decides that a sensitive
diff gets the security review, that both reviews must approve, or that a
sensitive path must be listed in the spec.

The corrected paragraph, for the implementer (the last sentence is unchanged
and shown for context):

> This document's own children are specs A to G below (F split into F1 and F2;
> E into spec 029, the design stage, and spec 051, the console, both children
> of this document) *(author's call: the breakdown, like section 11)*
> (maintainer answer, question #6819390363). The existing specs
> 001 to 005 get `Parent: docs/delivery-system-design.md` as part of B.

## 5. Verification

- `pnpm test` from the repository root passes (AC-5).
- `git diff main --stat` on the implementation PR lists
  `docs/delivery-system-design.md` and no other file (AC-4).
- `grep -n "expected to become" docs/delivery-system-design.md` prints
  nothing; `grep -n "question #6819390363" docs/delivery-system-design.md`
  prints the section 10 line (AC-1, AC-2).
- `grep -n "row E" docs/delivery-system-design.md` prints the spec 029 and
  spec 051 entries of `## Children` (AC-3).
- `git diff main -- docs/delivery-system-design.md` on the implementation PR
  shows one changed hunk, in section 10, and no change to `## Children` (AC-3,
  AC-4).

## 6. Open decisions

None.
