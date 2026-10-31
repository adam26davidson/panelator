# 021. Spec text left stale by spec 008 is corrected

Status: written 2026-10-31 from the delivery-system design for issue #32;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 9 ("Parameters at the start": the work ratio is a console parameter
that replaces process-spec 4.5's fixed 2:1) and section 10 ("Small work skips
layers": a tooling spec hangs directly off a top design);
[008-agent-registry](../008-agent-registry/spec.md) AC-14 (the shortlist
ranks by the work share; the feature-to-debt ratio is no longer used) and its
status line ("amends 001-scheduler-core section 7 (the 2:1 ratio)");
[001-scheduler-core](../001-scheduler-core/spec.md) section 7 (the shortlist
stub); [process-spec](../../docs/process-spec.md) section 4.5 (the superseded
note it already carries). Writes the amendment spec 008 announced but did not
make, and corrects spec 008's own file-scope sentence.

## 1. Goal

An agent that reads spec 001 section 7 for the shortlist ranking rules, or
spec 008 section 5 for the files spec 008 changed, reads what shipped.

### What is wrong today

Two passages contradict what spec 008 and its implementation (PR #16)
shipped, as the issue's filer verified on `main`:

1. `specs/001-scheduler-core/spec.md` section 7 ("Shortlist stub") says the
   shortlist ranks by "a maintainer priority label first, then the 2:1
   feature-to-debt ratio of process-spec 4.5 by change-class label, then
   oldest first". Spec 008 AC-14 replaced the ratio with the
   `system_work_share` parameter (design section 9), the ranking is live in
   `tools/scheduler/src/shortlist/rank.ts`, and process-spec 4.5 carries a
   "Superseded" note, but spec 001 section 7 carries none. Spec 008's
   status line says it "amends 001-scheduler-core section 7 (the 2:1
   ratio)", yet spec 008's file list (section 5) did not include spec 001,
   so the amendment was never written down where a reader of spec 001 finds
   it.
2. `specs/008-agent-registry/spec.md` section 5 lists `tools/README.md` as a
   changed file ("the three commands and the `agents/standing/` layout") and
   then says "No file outside `tools/scheduler/`, `agents/`,
   `schemas/scheduler/` and `dev-logs/` is changed". PR #16 followed the
   explicit list and changed `tools/README.md`, so the scope sentence is
   false.

### The fix

Two text corrections, nothing else:

- a superseded note at the top of spec 001 section 7, in the form
  process-spec 4.5 already uses (a block quote beginning "Superseded by"),
  pointing at spec 008 AC-14 and design section 9 for the ranking that
  applies, with the original paragraph kept beneath it as the record of
  what spec 001 asked for;
- the file-scope sentence of spec 008 section 5 corrected so that it names
  `tools/README.md` beside the four directories.

## 2. Out of scope

- The ranking itself (spec 008 AC-14, `tools/scheduler/src/shortlist/rank.ts`,
  `agents/scheduler.yaml`), the parameter store, and process-spec 4.5: all
  unchanged. This spec records what shipped; it ships nothing new.
- The rest of spec 001 section 7 (eligibility, the `validated` label and its
  actor, pagination and the count assertion of process-spec 6.4): still in
  force and not touched. Only the ranking sentence is superseded.
- Spec 008's status line and its "amends" clause, and spec 008 section 5's
  list of files: unchanged. The list is right; the scope sentence after it is
  what is wrong.
- Whether `tools/README.md` should have been in spec 008's scope at all: PR
  #16 merged with that change under review, and the file is documentation
  of the tool in its own package, as spec 008's list says.
- Any other passage of any spec that a later spec amended without writing
  the amendment in. The issue names these two; a sweep of the others is a
  finding for the filer, not this spec.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the PR branch, read as text; "then" clauses
are checked by reading them and by `pnpm test` where it says so.

- AC-1. **Spec 001 section 7 carries a superseded note on the ranking.**
  Given `specs/001-scheduler-core/spec.md` section 7 ("Shortlist stub"), when
  an agent reads it for the shortlist ranking, then the first thing after the
  section heading is a block quote (lines beginning `> `) that starts with
  "Superseded" and states that the ranking by the 2:1 feature-to-debt ratio
  is replaced by the `system_work_share` parameter of delivery-system design
  section 9, as spec 008 AC-14 specifies, and that the rest of the section
  still applies. The note names spec 008 AC-14 and design section 9 by those
  numbers, with a relative link to `../008-agent-registry/spec.md`.
- AC-2. **The original paragraph stays as the record.** Given the same
  section after the change, then the paragraph beginning "Until spec 002, the
  shortlist is:" is present, word for word as it is on `main` today, after
  the note. Nothing else in `specs/001-scheduler-core/spec.md` changes: the
  diff of that file touches section 7 only and only adds lines.
- AC-3. **Spec 008's scope sentence names `tools/README.md`.** Given
  `specs/008-agent-registry/spec.md` section 5, then the sentence that today
  reads "No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/`
  and `dev-logs/` is changed." names `tools/README.md` as the one file
  outside those four directories that is changed, so that the sentence and
  the list above it agree. The rest of that paragraph (the sensitive-path
  statement and the statement that nothing changes the sensitive-path list,
  the security criteria, or the routing of a sensitive diff) is unchanged,
  and the diff of that file touches that sentence only.
- AC-4. **No maintainer decision and no enforcement changes.** Given the
  implementation PR's diff, then it changes no text marked `(maintainer
  answer, question #<id>)`, nothing under `docs/`, `tools/`, `agents/`,
  `.github/` or `schemas/`, and no gate, bound or
  label rule of specs 001 and 006 (security criterion 5): the superseded note
  changes what spec 001 says about ranking order, which spec 008 AC-14 (a
  merged spec) already changed, and nothing about eligibility, claiming,
  gates or labels.
- AC-5. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root, then it passes: the spec-present gate and
  the design-tree check still accept spec 001, spec 008 and this spec.

## 4. Interfaces and files

No code, schema or prompt changes. The implementation PR edits exactly these
two files:

- `specs/001-scheduler-core/spec.md`: section 7 gains the superseded note of
  AC-1 above its existing text (AC-2).
- `specs/008-agent-registry/spec.md`: the file-scope sentence of section 5 is
  corrected (AC-3).

The spec PR itself adds `specs/021-stale-spec-text-after-008/spec.md` and
lists it under `## Children` in `docs/delivery-system-design.md`.

`specs/001-scheduler-core/spec.md` is a sensitive path (listed in
`agents/sensitive-paths.txt` as a spec that defines the charter's
enforcement), so the security review runs on the implementation PR as spec
006 AC-9 says, and that path is listed here so the scope gate accepts the
diff. `specs/008-agent-registry/spec.md` is not sensitive. Nothing here
changes the sensitive-path list, the security criteria, or what routes a
sensitive diff to the security review; the only change to spec 001 is a note
that records a ranking change a merged spec already made.

Suggested wording for the note (the implementer may tighten it, keeping
AC-1's content):

> Superseded in part by [008-agent-registry](../008-agent-registry/spec.md)
> AC-14: the ranking by the 2:1 feature-to-debt ratio of process-spec 4.5 is
> replaced by the `system_work_share` parameter of the delivery-system design
> section 9 (a maintainer priority label first, then the preferred kind of
> work by share, then oldest first). The eligibility rules, the pagination
> and the count assertion below still apply.

Suggested wording for the scope sentence:

> No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/` and
> `dev-logs/` is changed except `tools/README.md`, listed above.

## 5. Verification

- `pnpm test` from the repository root passes (AC-5).
- `git diff main -- specs/001-scheduler-core/spec.md` shows only added lines,
  all inside section 7 and before the "Until spec 002" paragraph (AC-1,
  AC-2).
- `git diff main -- specs/008-agent-registry/spec.md` shows one changed
  sentence in section 5 (AC-3).
- `git diff main --stat` lists no file other than those two (AC-4).
- Reading check: after the change, `grep -n "2:1" specs/001-scheduler-core/spec.md`
  finds the ratio only inside or after the superseded note, and
  `grep -n "No file outside" specs/008-agent-registry/spec.md` finds a
  sentence that names `tools/README.md`.

## 6. Open decisions

None.
