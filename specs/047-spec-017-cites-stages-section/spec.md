# 047. Spec 017's Derives-from line cites spec 001 section 6 for the stage prompt

Status: written 2026-11-06 from the delivery-system design for issue #81;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 6.2 (a reviewed PR for every change to repository
content); [001-scheduler-core](../001-scheduler-core/spec.md) section 6
(Stages: the stage definition file and the placeholder list of its prompt
body, `{{profile_instructions}}` among them) and section 8 (Gates: the
table of pure-function gates, which says nothing about the stage prompt);
[017-read-only-stages-not-told-to-run-tests](../017-read-only-stages-not-told-to-run-tests/spec.md)
(the Derives-from line being corrected);
[021-stale-spec-text-after-008](../021-stale-spec-text-after-008/spec.md)
and [032-spec-008-lists-advisory-lookup](../032-spec-008-lists-advisory-lookup/spec.md)
(the convention this spec follows: a landed spec's text is corrected by a
small tooling spec whose implementation PR edits the landed text).

## 1. Goal

An agent that follows spec 017's Derives-from line to the parent text on the
stage prompt and its `{{profile_instructions}}` placeholder lands on the
section of spec 001 that holds it.

### What is wrong today

Spec 017's Derives-from line (lines 11 to 12 of
`specs/017-read-only-stages-not-told-to-run-tests/spec.md` on `main`) reads:

> [001-scheduler-core](../001-scheduler-core/spec.md) section 8 (the stage
> prompt and its `{{profile_instructions}}` placeholder) and section 9 (a
> profile's `instructions.md` is appended to the prompt of every stage that
> runs under it)

Section 8 of spec 001 is "Gates": a table of pure-function gates, their
checks and their failure labels, and the sensitive-path list. It says
nothing about the stage prompt. The stage definition file, its prompt body
and the placeholder list that names `{{profile_instructions}}` are in
section 6, "Stages". Section 9, "Profiles", is cited correctly: it is where
`instructions.md` is said to be appended to the prompt.

The link resolves (it points at the file, not at a heading), so the review
of the spec 017 PR passed it and recorded the mismatch as a finding instead;
the filer verified both files on `main` at commit f932bfe and opened issue
#81. A Derives-from line is what later agents follow to find the parent text,
so a wrong section number sends them to the wrong place.

### The fix

One text correction, nothing else: the word "8" in that clause becomes "6".
The parenthesis after it already describes section 6 and stays as it is.

## 2. Out of scope

- Spec 001: unchanged. Its section numbering is right; spec 017's citation
  of it is wrong.
- Every other line of spec 017: its goal, criteria, interfaces and
  verification describe work that shipped (PR #61 for issue #25) and are not
  revisited here. In particular the citation of section 9 is correct and
  stays.
- A sweep of the other specs' Derives-from lines for section numbers that
  have drifted. The issue names this one; any other is a finding for the
  filer, not this spec.
- A mark under spec 039 (`Amended by ...`) on spec 017. A mark keeps the
  earlier text as the record and points to the new reading; here the earlier
  text is a wrong pointer with nothing to preserve, and the convention of
  specs 021 and 032 for a correction of this kind is a direct edit by the
  implementation PR.
- Any change to how the spec review checks derives-from links, so that a
  resolving link to the wrong section would block rather than be recorded.
  That is a change to the review's criteria or instructions, which this spec
  does not plan.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the PR branch, read as text; "then" clauses
are checked by reading them and by `pnpm test` where it says so.

- AC-1. **Spec 017 cites section 6 for the stage prompt.** Given
  `specs/017-read-only-stages-not-told-to-run-tests/spec.md`, when an agent
  reads its Derives-from line, then the clause citing
  `[001-scheduler-core](../001-scheduler-core/spec.md)` for "the stage
  prompt and its `{{profile_instructions}}` placeholder" names section 6,
  and the file nowhere cites spec 001 section 8. The clause citing section 9
  for the profile's `instructions.md` is as it is on `main`.
- AC-2. **Nothing else in spec 017 changes.** Given the implementation PR's
  diff of `specs/017-read-only-stages-not-told-to-run-tests/spec.md`, then
  it changes one line, the one carrying "section 8", and on that line only
  the section number: every other line of the file is as it is on `main`.
- AC-3. **No maintainer decision and no enforcement changes.** Given the
  implementation PR's diff, then it touches no file other than spec 017's
  `spec.md`: nothing under `docs/`, `tools/`, `agents/`, `.github/` or
  `schemas/`, no text marked `(maintainer answer, question #<id>)`, and no
  gate, bound or label rule of specs 001 and 006 (security criterion 5).
- AC-4. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root, then it passes: the spec-present gate and
  the design-tree check still accept spec 017 and this spec.

## 4. Interfaces and files

No code, schema or prompt changes. The implementation PR edits exactly one
file:

- `specs/017-read-only-stages-not-told-to-run-tests/spec.md`: in the
  Derives-from line, "section 8 (the stage prompt and its
  `{{profile_instructions}}` placeholder)" becomes "section 6 (the stage
  prompt and its `{{profile_instructions}}` placeholder)" (AC-1). The line
  is line 11 on `main` today.

The spec PR itself adds `specs/047-spec-017-cites-stages-section/spec.md`
and lists it under `## Children` in `docs/delivery-system-design.md`.

`specs/017-read-only-stages-not-told-to-run-tests/spec.md` is not a
sensitive path (`agents/sensitive-paths.txt` lists specs 001 and 006 only),
so the ordinary review applies to the implementation PR. This spec plans no
change to the charter, to a protected maintainer decision, to the
sensitive-path list, to the security review criteria or instructions, or to
what decides that a sensitive diff gets the security review, that both
reviews must approve, or that a sensitive path must be listed in the spec.

The corrected lines, for the implementer (the second line is unchanged and
shown for context):

> [001-scheduler-core](../001-scheduler-core/spec.md) section 6 (the stage
> prompt and its `{{profile_instructions}}` placeholder) and section 9 (a

## 5. Verification

- `pnpm test` from the repository root passes (AC-4).
- `git diff main --stat` lists
  `specs/017-read-only-stages-not-told-to-run-tests/spec.md` and no other
  file (AC-3), and `git diff main -- specs/017-read-only-stages-not-told-to-run-tests/spec.md`
  shows one changed line, differing from `main` only in the section number
  (AC-2).
- Reading check: after the change,
  `grep -n "section 8" specs/017-read-only-stages-not-told-to-run-tests/spec.md`
  prints nothing, and
  `grep -n "section 6 (the stage" specs/017-read-only-stages-not-told-to-run-tests/spec.md`
  prints line 11 (AC-1). `grep -n "^## 6. Stages" specs/001-scheduler-core/spec.md`
  confirms the target heading.

## 6. Open decisions

None.
