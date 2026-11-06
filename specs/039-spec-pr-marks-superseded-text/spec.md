# 039. A spec PR marks the text of an earlier spec it supersedes

Status: written 2026-11-06 from the delivery-system design for issue #60;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design; "Decisions sit where they belong": lower designs and specs are
agent territory) and section 4 (agents resolve their own blockers);
[process-spec](../../docs/process-spec.md) 4.2 step 3 (a possible design
flaw the question check does not send is decided by agents and recorded as
an ADR); [ADR 0009](../../docs/decisions/0009-spec-pr-marks-superseded-text.md)
(the spec PR marks the earlier text in place; the gate allows the `spec.md`
of a linked spec); [021-stale-spec-text-after-008](../021-stale-spec-text-after-008/spec.md)
AC-2 (the earlier text stays as the record); amends
[006-no-human-stops](../006-no-human-stops/spec.md) AC-21 (the Scope list)
as section 4 records; turns the readings of
[009-postponed-chain-holds-slot](../009-postponed-chain-holds-slot/spec.md)
section 4 and [011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
section 4 into marks on the criteria they read.

## 1. Goal

An agent that opens a landed spec and reads a criterion a later spec has
replaced or changed sees that at once, from a mark at the start of the
criterion that names the later spec; and the spec PR that makes the change
writes that mark itself, in the same reviewed diff.

### What is wrong today

The spec-track scope check (spec 006 AC-21 and AC-22,
`tools/scheduler/src/gates/spec-scope.ts`) allows a spec PR to touch only
its own directory, `docs/designs/`, `docs/decisions/` and the `## Children`
section of its parent. A spec that supersedes or amends a criterion of an
earlier spec therefore writes a "reading" into its own text (spec 009
section 4 for spec 001 AC-25; spec 011 section 4 for spec 006 AC-13, AC-15
and AC-21 and spec 005 AC-2), and the earlier criterion stays as it was and
reads as current. Cleaning that up has cost a chain run per passage (issue
#32, spec 021; spec 032) or has been pushed into implementation PRs (spec
013 on spec 001 AC-25, spec 034 on spec 001 section 11), where a reviewer
judging code is asked to judge a spec-text decision. ADR 0009 decides that
the spec PR marks the earlier text itself.

### The fix

- The scope check also allows the `spec.md` of another spec when the new
  spec links to it (AC-1 to AC-4). Nothing else about the check changes.
- The mark has two forms, already used in the specs: `Superseded by` and
  `Amended by`, each a link to the new spec and the criterion or section
  that now applies, prepended to the earlier text, which is kept (AC-5).
  The spec review's scope criterion checks the mark; the spec stage's
  prompt tells it to write one (AC-6).
- Spec 006 AC-21's Scope paragraph is marked as amended by this spec
  (AC-7), and the readings specs 009 and 011 already recorded become marks
  on the criteria they read (AC-8), so no sweep issue is needed for them.
- `specs/README.md` states the convention (AC-9).

## 2. Out of scope

- The implement-track scope gate (`tools/scheduler/src/gates/scope.ts`):
  unchanged. An implementation PR may still edit a spec its own spec lists
  in "Interfaces and files", as spec 034's did; a spec may still choose to
  carry a mark that way.
- The charter rule and the top-design rules of the spec-scope gate, the
  design-scope gate, the sensitive-path routing (`isSensitive`,
  `pickProfile`, `securityPass`), `agents/sensitive-paths.txt` and the
  security review criteria and instructions: all unchanged. A spec PR that
  marks text in spec 001 or spec 006 touches a sensitive path and gets the
  security review as spec 006 AC-9 and AC-21 already say.
- Any file of another spec other than its `spec.md`: `plans/`, `design/`
  and a split's `README.md` stay outside the spec PR's scope.
- Edits to another spec beyond a mark: rewording, deleting or rewriting a
  criterion. A spec that needs more than a mark to change an earlier spec
  puts the change in its own criteria and marks the earlier text as
  superseded by them.
- Stale text that is not a superseded or amended criterion, paragraph or
  section (a false scope sentence, as spec 021 AC-3 and spec 032 fixed):
  still a finding for the filer.
- Marks in documents that are not specs (`docs/process-spec.md` carries
  block-quote notes of its own form): unchanged.
- The existing "Superseded by spec 006:" prefixes in spec 001, the block
  quote spec 021 added to spec 001 section 7, and the "(Amended by spec 013
  and ADR 0003: ...)" parenthetical in spec 001 AC-25: left as they are.
- The staleness check of the reflection agents (spec 028 AC-5, design
  section 10): unchanged.
- Readings recorded anywhere other than spec 009 section 4 and spec 011
  section 4: none are known; any found later is a finding.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

In AC-1 to AC-4 the *new spec* is the spec the PR is for (the issue's
`Spec:` line, `specs/NNN-<slug>/spec.md`), its *text* is that file's
content in the worktree as the driver already reads it, and *another spec's
file* is `specs/<dir>/spec.md` for a directory other than the new spec's.
The new spec *links to* another spec when its text contains that spec's
path either relative to the new spec's directory (`../<dir>/spec.md`) or
from the repository root (`specs/<dir>/spec.md`).

- AC-1. **A linked spec's `spec.md` is in scope.** Given a spec PR whose new
  spec links to `specs/006-no-human-stops/spec.md`, when the PR's diff
  includes `specs/006-no-human-stops/spec.md`, then the spec-scope gate
  reports no violation for that file, and the result is `ok: true` when the
  rest of the diff is in scope.
- AC-2. **An unlinked spec's `spec.md` is a violation that says why.** Given
  the same diff and a new spec whose text does not link to
  `specs/006-no-human-stops/spec.md` in either form, then the gate reports
  the violation `specs/006-no-human-stops/spec.md: another spec; <new spec
  path> does not link to it`. Given the new spec's text is empty (a split:
  a `README.md` beside a missing `spec.md`, spec 031 AC-9), then another
  spec's file is always this violation.
- AC-3. **Only `spec.md`, and the earlier rules first.** Given a diff
  touching `specs/006-no-human-stops/plans/plan.md`,
  `specs/029-design-stage/design/home.png` or `specs/012-metrics-reflection/README.md`,
  then each is the violation `<path>: outside spec PR scope` whatever the
  new spec links to. Given a diff touching `docs/charter.md`, a top design
  outside its `## Children` section, or `specs/README.md`, then the gate
  reports the violation it reports today; linking to those paths from the
  new spec changes nothing. Every existing `specScopeGate` test in
  `tools/scheduler/test/gates.test.ts` passes with no change other than the
  added argument.
- AC-4. **The driver supplies the text.** Given the spec-track scope check
  runs (`specTrackScope` in `tools/scheduler/src/chain/driver.ts`), then the
  gate receives the new spec's text as read from the worktree, the same
  read the function already makes for the `Parent:` line, and the empty
  string when the file does not exist.
- AC-5. **The mark, checked by the spec review.** Given a spec PR that edits
  another spec's `spec.md`, then the spec review's scope criterion (criterion
  5 of `agents/profiles/spec/review-criteria.md`) states that the allowed
  paths include the `spec.md` of a spec the new spec links to, and that
  every change to such a file is a *mark*: text prepended to the smallest
  unit it applies to (a criterion, after its `AC-n.` number and before its
  text or bold title; a titled paragraph inside a criterion, after its bold
  title; a section, as a block quote under its heading) that reads either
  `Superseded by [NNN-slug](../NNN-slug/spec.md) AC-k:` or
  `Amended by [NNN-slug](../NNN-slug/spec.md) AC-k: <one clause>.`, where
  `NNN-slug` is the new spec and `AC-k` (or `section k`) is where the new
  spec says what applies; the earlier text follows the mark unchanged, and
  the new spec's status line names the earlier spec and the units it marks.
  An edit that is not a mark, or a mark that names a spec other than the
  new one, is a finding under that criterion. Criterion 6 (marked
  maintainer answers) is unchanged and still applies to the marked file.
- AC-6. **The spec stage is told.** Given the spec stage prompt
  (`agents/stages/spec.md`), then its "Files you may change" list includes
  the `spec.md` of another spec the new spec links to, for marks only; and
  the prompt says that when the spec supersedes or amends a criterion,
  paragraph or section of a landed spec, the stage writes the mark of AC-5
  on that text in the same PR and names it in the status line, instead of
  recording a reading only in the new spec. The new spec may still explain
  the amendment in its own text; the mark points to that explanation.
- AC-7. **Spec 006 AC-21 carries the amendment.** Given
  `specs/006-no-human-stops/spec.md` AC-21, then its paragraph beginning
  `**Scope.**` starts, after that bold title, with
  `Amended by [039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md) AC-1: the list also allows the spec.md of another spec the new spec links to, for the marks of its AC-5.`
  and the rest of the paragraph and its list are unchanged.
- AC-8. **The readings of specs 009 and 011 become marks.** Given the files
  below, then each named unit starts with the mark given, placed as AC-5
  says, and nothing else in those files changes (the diff of each file adds
  text only, inside the named units):
  - `specs/001-scheduler-core/spec.md` AC-25, after `AC-25.`:
    `Amended by [009-postponed-chain-holds-slot](../009-postponed-chain-holds-slot/spec.md) section 3: the held claim holds its concurrency slot while the chain waits.`
    The existing "(Amended by spec 013 and ADR 0003: ...)" parenthetical at
    the end of AC-25 stays as it is.
  - `specs/006-no-human-stops/spec.md` AC-13, after `AC-13.` and before
    the bold title:
    `Amended by [011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md) section 4: the chain state written to the paused record includes the held work.`
  - `specs/006-no-human-stops/spec.md` AC-15, after `AC-15.` and before
    the bold title:
    `Amended by [011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md) section 4: with held work the stage resumes in the worktree as the asking stage left it, with the held work as input.`
  - `specs/006-no-human-stops/spec.md` AC-21, the paragraph beginning
    `**A branch left by a failed attempt.**`, after that bold title:
    `Amended by [011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md) section 4: applies only when the chain holds no work on the branch; the question check and the stages the question path resumes are not retries.`
  - `specs/005-keep-unpushed-commits/spec.md` AC-2, after `AC-2.`:
    `Amended by [011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md) section 4: applies when the chain holds no work on the branch; with held work the commits are kept and no recovered-commits record is written.`
  Spec 009 section 4 and spec 011 section 4 are unchanged; they are what the
  marks point to.
- AC-9. **`specs/README.md` states the convention.** Given `specs/README.md`,
  then one paragraph says that a spec which supersedes or amends a
  criterion, paragraph or section of a landed spec marks that text in its
  own spec PR with one of the two forms of AC-5, keeping the earlier text as
  the record; that the spec-scope gate allows another spec's `spec.md` only
  when the new spec links to it; and that the spec review checks the mark
  (spec 039).
- AC-10. **Nothing protected is weakened.** Given the implementation PR's
  diff, then: the charter check and the top-design checks of
  `specScopeGate` run before the new allowance exactly as today and their
  code is unchanged; `tools/scheduler/src/gates/scope.ts`,
  `tools/scheduler/src/gates/sensitive.ts`, `pickProfile` and `securityPass`,
  `agents/sensitive-paths.txt`, `agents/profiles/security/` and
  `docs/charter.md` are unchanged; no text marked
  `(maintainer answer, question #<id>)` is changed; nothing under `docs/`
  changes; and `pnpm test`
  from the repository root passes, including the recorded end-to-end chain
  tests of `tools/scheduler/test/e2e.test.ts` without change.

## 4. Amendments to earlier specs

This spec's own PR is gated by the rule it changes, so it records the
amendment here and its implementation writes the mark (AC-7). After this
spec, a spec in this position writes the mark instead.

- **Spec 006 AC-21, "Scope."** The list of paths the scope check of AC-22
  holds the spec PR to gains: the `spec.md` of another spec that the new
  spec links to, for marks only (AC-1, AC-5). The charter remains never
  allowed; the top designs remain as AC-21 says. AC-21's "Review" paragraph
  is unchanged in text; the `spec` criteria file it names gains the mark
  rule (AC-5).
- **Spec 006 AC-22.** Unchanged: a violation of the widened scope is handled
  as it says.

## 5. Interfaces and files

The implementation PR edits exactly these files:

- `tools/scheduler/src/gates/spec-scope.ts`: `specScopeGate` takes the new
  spec's text (suggested: a trailing parameter `specText = ""` after
  `recordsProductAnswer`, so existing callers and tests keep their argument
  order) and, after the charter and top-design checks and before the
  prefix allowances, allows a path matching `specs/<dir>/spec.md` whose
  `<dir>` is not the new spec's when `specText` contains
  `../<dir>/spec.md` or `specs/<dir>/spec.md`, else reports AC-2's
  violation (AC-1 to AC-3). The function's doc comment names this spec.
- `tools/scheduler/src/chain/driver.ts`: `specTrackScope` passes `text`
  (AC-4).
- `tools/scheduler/test/gates.test.ts`: tests for AC-1 to AC-3 in the
  `specScopeGate` block (linked allowed; unlinked violation with the
  message; empty text; `plans/`, `design/` and `README.md` of another spec;
  charter and top design unchanged when linked).
- `agents/profiles/spec/review-criteria.md`: criterion 5 (AC-5).
- `agents/stages/spec.md`: the "Files you may change" list and the
  amendment instruction (AC-6).
- `specs/README.md`: the convention paragraph (AC-9).
- `specs/006-no-human-stops/spec.md`: the marks of AC-7 and AC-8.
- `specs/001-scheduler-core/spec.md`: the mark of AC-8.
- `specs/005-keep-unpushed-commits/spec.md`: the mark of AC-8.

The spec PR itself adds this file and
`docs/decisions/0009-spec-pr-marks-superseded-text.md`, and lists this spec
under `## Children` in `docs/delivery-system-design.md`.

Sensitive paths this spec lists, so the implement-track scope gate accepts
the diff and the security review runs (spec 006 AC-9): `tools/scheduler/`,
`agents/`, `specs/001-scheduler-core/spec.md` and
`specs/006-no-human-stops/spec.md`. Nothing here changes the sensitive-path
list, the security criteria or instructions, the charter rule of
`spec-scope.ts` that security criterion 5 names, or what routes a sensitive
diff to the security review and requires both reviews (AC-10). The
allowance added is a new branch after those checks; a spec PR that uses it
on spec 001 or spec 006 still touches a sensitive path and still gets the
security review, whose criterion 9 judges the mark.

Suggested wording for `specs/README.md` (the implementer may tighten it,
keeping AC-9's content):

> A spec that supersedes or amends a criterion, paragraph or section of a
> landed spec marks that text in its own spec PR (spec 039, ADR 0009):
> `Superseded by [NNN-slug](../NNN-slug/spec.md) AC-k:` when the text no
> longer applies, or `Amended by [NNN-slug](../NNN-slug/spec.md) AC-k:
> <one clause>.` when it applies as changed, prepended to the earlier text,
> which stays as the record. The spec-scope gate allows another spec's
> `spec.md` only when the new spec links to it, and the spec review checks
> that every change there is such a mark.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
  clean (AC-3, AC-10).
- The new `gates.test.ts` cases fail on `main` before the change (a linked
  spec's `spec.md` is `outside spec PR scope`) and pass after it (AC-1,
  AC-2, AC-3).
- `git diff main --stat` lists only the files of section 5 (AC-10).
- `git diff main -- specs/001-scheduler-core/spec.md specs/005-keep-unpushed-commits/spec.md specs/006-no-human-stops/spec.md`
  shows only added text inside AC-25, AC-2, AC-13, AC-15 and the two AC-21
  paragraphs (AC-7, AC-8).
- Reading check: `grep -n "Amended by \[039-" specs/006-no-human-stops/spec.md`
  finds the Scope paragraph; `grep -c "Amended by \[011-" specs/006-no-human-stops/spec.md`
  prints 3 and the same grep on `specs/005-keep-unpushed-commits/spec.md`
  prints 1; `grep -c "Amended by \[009-" specs/001-scheduler-core/spec.md`
  prints 1 (AC-8).
- Reading check: `agents/profiles/spec/review-criteria.md` criterion 5 and
  `agents/stages/spec.md` name the two mark forms (AC-5, AC-6).

## 7. Open decisions

None.
