# 087. Spec 041's sensitive-path sentence names only `tools/scheduler/`

Status: written 2026-11-19 from the delivery-system design for issue #174;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 6.2 (a reviewed PR for every change to repository
content); `agents/sensitive-paths.txt` (the list the sentence cites);
[041-registry-validates-standing-definitions](../041-registry-validates-standing-definitions/spec.md)
section 5 (the sentence being corrected);
[039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md)
section 2 (a false scope sentence is not a superseded criterion, paragraph
or section, and is a finding for the filer);
[021-stale-spec-text-after-008](../021-stale-spec-text-after-008/spec.md),
[032-spec-008-lists-advisory-lookup](../032-spec-008-lists-advisory-lookup/spec.md)
and [047-spec-017-cites-stages-section](../047-spec-017-cites-stages-section/spec.md)
(the convention this spec follows: a landed spec's false text is corrected
by a small tooling spec whose implementation PR edits the landed text).

## 1. Goal

An agent that reads spec 041 section 5 to learn which of the paths it
touches get the security review reads only what `agents/sensitive-paths.txt`
says.

### What is wrong today

Spec 041 section 5 (lines 273 to 275 of
`specs/041-registry-validates-standing-definitions/spec.md` on `main`)
reads:

> `tools/scheduler/` and `schemas/` are sensitive paths
> (`agents/sensitive-paths.txt`); the security review applies to the
> implementation PR (spec 006 AC-9).

`agents/sensitive-paths.txt` lists `tools/scheduler/` but no glob that
matches anything under `schemas/`: its entries are four `backend/**`
subtrees, two `firmware/**` subtrees, `tools/scheduler/`, `agents/`,
`.github/`, four named documents under `docs/`, specs 001 and 006,
`AGENTS.md`, `package.json`, `pnpm-workspace.yaml` and `**/vitest.config.*`.
Nothing was lost for spec 041 itself: every edit it planned touches
`tools/scheduler/`, so its implementation PR got the security review. But a
landed spec is read as the record, and the sentence tells a reader that a
change under `schemas/` alone would be routed to the security review, which
it would not be. The review stage of issue #70 noticed the mismatch while
judging its criterion 7; the filer verified both files on `main` and opened
issue #174.

### The fix

One text correction, nothing else: on line 273 of spec 041,
"`tools/scheduler/` and `schemas/` are sensitive paths" becomes
"`tools/scheduler/` is a sensitive path". The parenthesis citing
`agents/sensitive-paths.txt` and the rest of the sentence stay as they are.

## 2. Out of scope

- Whether `schemas/` (or `schemas/scheduler/`) should be on the
  sensitive-path list. The issue leaves it open; adding it is a change to
  `agents/sensitive-paths.txt`, which is how the security review is
  enforced (spec review criterion 7) and is not planned here. A later spec
  or the maintainer may take it up.
- Every other line of spec 041: its goal, criteria, interfaces and
  verification describe work that shipped and are not revisited. The
  section 5 sentences after the corrected one ("The change touches no gate,
  bound, label rule or permission. ...") stay.
- The same claim in other specs. Specs 060, 063 and 066 each say
  "`tools/scheduler/`, `agents/` and `schemas/` are sensitive paths" in
  their interfaces section; the issue names spec 041 only, so these are
  recorded as a finding for the filer, not corrected here.
- A mark under spec 039 (`Amended by ...`) on spec 041. A mark keeps the
  earlier text as the record and points to a new reading; here the earlier
  clause is false with nothing to preserve, spec 039 section 2 puts a false
  scope sentence outside its marks, and the convention of specs 021, 032 and
  047 for a correction of this kind is a direct edit by the implementation
  PR.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the PR branch, read as text; "then" clauses
are checked by reading them and by `pnpm test` where it says so.

- AC-1. **Spec 041 names only the listed path.** Given
  `specs/041-registry-validates-standing-definitions/spec.md`, when an agent
  reads section 5's sentence citing `agents/sensitive-paths.txt`, then it
  reads "`tools/scheduler/` is a sensitive path
  (`agents/sensitive-paths.txt`); the security review applies to the
  implementation PR (spec 006 AC-9).", and no line of the file says that
  `schemas/` is a sensitive path.
- AC-2. **Nothing else in spec 041 changes.** Given the implementation PR's
  diff of `specs/041-registry-validates-standing-definitions/spec.md`, then
  it changes one line, the one beginning "`tools/scheduler/` and
  `schemas/`", and on that line only the words between "`tools/scheduler/`"
  and "sensitive": every other line of the file is as it is on `main`.
- AC-3. **No maintainer decision and no enforcement changes.** Given the
  implementation PR's diff, then it touches no file other than spec 041's
  `spec.md`: nothing under `docs/`, `tools/`, `agents/`, `.github/` or
  `schemas/`, no text marked `(maintainer answer, question #<id>)`, and no
  gate, bound or label rule of specs 001 and 006 (security criterion 5).
- AC-4. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root, then it passes: the spec-present gate and
  the design-tree check still accept spec 041 and this spec.

## 4. Interfaces and files

No code, schema or prompt changes. The implementation PR edits exactly one
file:

- `specs/041-registry-validates-standing-definitions/spec.md`: line 273
  "`tools/scheduler/` and `schemas/` are sensitive paths" becomes
  "`tools/scheduler/` is a sensitive path" (AC-1). Lines 274 and 275 are
  unchanged; the paragraph is not reflowed (AC-2).

The spec PR itself adds
`specs/087-spec-041-schemas-not-a-sensitive-path/spec.md` and lists it
under `## Children` in `docs/delivery-system-design.md`.

`specs/041-registry-validates-standing-definitions/spec.md` is not a
sensitive path (`agents/sensitive-paths.txt` lists specs 001 and 006 only),
so the ordinary review applies to the implementation PR. This spec plans no
change to the charter, to a protected maintainer decision, to the
sensitive-path list, to the security review criteria or instructions, or to
what decides that a sensitive diff gets the security review, that both
reviews must approve, or that a sensitive path must be listed in the spec.

The corrected lines, for the implementer (lines 274 and 275 unchanged and
shown for context):

> `tools/scheduler/` is a sensitive path
> (`agents/sensitive-paths.txt`); the security review applies to the
> implementation PR (spec 006 AC-9). The change touches no gate, bound,

## 5. Verification

- `pnpm test` from the repository root passes (AC-4).
- `git diff main --stat` lists
  `specs/041-registry-validates-standing-definitions/spec.md` and no other
  file (AC-3), and
  `git diff main -- specs/041-registry-validates-standing-definitions/spec.md`
  shows one changed line, line 273 (AC-2).
- Reading check: after the change,
  `grep -n "schemas/\` are sensitive" specs/041-registry-validates-standing-definitions/spec.md`
  prints nothing, and
  `grep -n "^\`tools/scheduler/\` is a sensitive path$" specs/041-registry-validates-standing-definitions/spec.md`
  prints line 273 (AC-1). `grep -c "schemas/" agents/sensitive-paths.txt`
  prints 0, confirming the list the corrected sentence cites.

## 6. Open decisions

None.
