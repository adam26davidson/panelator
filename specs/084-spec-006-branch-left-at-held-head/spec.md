# 084. Spec 006 AC-21's Branch paragraph names the held-work exception

Status: written 2026-11-18 from the delivery-system design for issue #171;
specs derived from that design need no maintainer approval (design section 11).
Amends [006-no-human-stops](../006-no-human-stops/spec.md) AC-21 (the
paragraph beginning `**Branch.**`), with a mark in this spec's PR (spec 039).
Records the reading [011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
section 4 already made and
[040-held-work-per-branch](../040-held-work-per-branch/spec.md) AC-5 builds
on; no behaviour changes.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design); [011-asking-stage-keeps-its-work](../011-asking-stage-keeps-its-work/spec.md)
section 4 (the bullet on spec 006 AC-21, whose last sentence reads the
Branch paragraph) and AC-2 and AC-5 (the held branch is kept or restored at
the held head); [040-held-work-per-branch](../040-held-work-per-branch/spec.md)
AC-5 (the driver keeps `spec-<n>` as spec 011 AC-2 and AC-5 say);
[039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md)
AC-5 and AC-8 and [ADR 0009](../../docs/decisions/0009-spec-pr-marks-superseded-text.md)
(the spec PR marks the earlier text in place; spec 039 section 2: a reading
found unmarked later is a finding);
[075-spec-006-split-closes-issue](../075-spec-006-split-closes-issue/spec.md)
(the precedent: a spec that marks spec 006 for a change another spec
shipped, and corrects the matching code comment).

## 1. Goal

An agent that reads spec 006 AC-21 for how the spec-track branch is set up
before the spec stage runs sees, at the start of the Branch paragraph, that
held work changes it, and finds the rule that ships.

### What is wrong today

Spec 006 AC-21's paragraph beginning `**Branch.**` says: "The scheduler
creates that branch from `origin/main` and checks it out in the issue's
worktree before the spec stage runs". Spec 011 section 4, in its bullet on
spec 006 AC-21, reads that sentence: "AC-21's 'the scheduler creates that
branch from `origin/main` and checks it out ... before the spec stage runs'
holds unless held work names `spec-<n>`, in which case the branch is left at
the held head." Spec 039 AC-8 turned the rest of that bullet into a mark on
the paragraph beginning `**A branch left by a failed attempt.**`, the
heading the bullet carries, and missed this last sentence, which reads a
different paragraph. The Branch paragraph has no mark and reads as current.
Spec 040 AC-5 depends on the same reading.

The behaviour is live in `syncWorktree` in
`tools/scheduler/src/chain/driver.ts`: with no PR bound and a hold on the
chain's branch, `keepHeldWork` keeps or restores the branch at the held head
and the function returns before `checkoutBranch(..., "origin/main")`. The
doc comment on `syncWorktree` says the same stale thing as the paragraph:
"with no PR, the chain's branch (`issue-<n>` or `spec-<n>`) fresh from
origin/main (C1, AC-21)".

### The fix

- In this spec PR, one mark on spec 006 AC-21's Branch paragraph, after its
  bold title, pointing to this spec's AC-1, which says what applies (AC-1).
  The mark names this spec, not spec 011: a mark names the spec whose PR
  writes it (spec 039 AC-5), and AC-1 points on to spec 011 section 4.
- In the implementation PR, the doc comment on `syncWorktree` is corrected
  (AC-2). No statement, type, test or record changes.

## 2. Out of scope

- The behaviour of held work (specs 011 and 040), the chain's transitions,
  the gates, the log records and the recorded tests: all unchanged. This
  spec records what shipped.
- The rest of spec 006 AC-21: its other paragraphs, their existing marks
  (specs 071, 065, 053, 011 and 039) and the Branch paragraph's text after
  the mark, all unchanged.
- Spec 011's own text, including section 4: unchanged; it is what AC-1
  points to.
- The spec stage prompt's own "Branch." paragraph (`agents/stages/spec.md`):
  it is not a spec criterion, and a stage resumed with held work is told so
  by its `held_work` input (spec 011 AC-4).
- Any other passage of spec 006 or of any other spec.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the branch, read as text; "then" clauses are
checked by reading them and by `pnpm test` where it says so.

- AC-1. **What applies to the Branch paragraph.** Given a chain on the spec
  track with no PR bound, when the spec stage or a question check it asks is
  prepared, then:
  - when the chain's held work has an entry for `spec-<issue>`, the
    scheduler does not create the branch from `origin/main`: it keeps the
    branch at the held head, or restores it there, as spec 011 AC-2 and AC-5
    say, per branch as spec 040 AC-5 says (spec 011 section 4);
  - when that entry cannot be kept (`held-work-lost`, spec 011 AC-5), or no
    entry names `spec-<issue>` (including when only `issue-<issue>` holds
    work, spec 040 AC-5), the Branch paragraph applies unchanged: the
    scheduler creates `spec-<issue>` from `origin/main` and checks it out
    before the spec stage runs.

  `specs/006-no-human-stops/spec.md` AC-21's paragraph beginning
  `**Branch.**` carries, after that bold title, the mark
  `Amended by [084-spec-006-branch-left-at-held-head](../084-spec-006-branch-left-at-held-head/spec.md) AC-1: when held work names spec-<issue>, the branch is left at the held head instead of being created from origin/main (spec 011 section 4).`
  The rest of the paragraph, and every other line of spec 006, is unchanged
  word for word.
- AC-2. **The code comment agrees.** Given
  `tools/scheduler/src/chain/driver.ts` after the implementation PR, then
  the doc comment on `syncWorktree` no longer says without exception that
  with no PR the chain's branch is put fresh from origin/main: it says that
  held work on the chain's branch is kept at its held head (spec 011 AC-2
  and AC-5) and that otherwise the branch is put fresh from origin/main. The
  diff of that file changes that comment only; no statement, type or test
  changes.
- AC-3. **No maintainer decision and no enforcement changes.** Given this
  spec's PR and its implementation PR, then neither changes text marked
  `(maintainer answer, question #<id>)`, the sensitive-path list, the
  security criteria or instructions, or what routes a sensitive diff to the
  security review. The mark changes only what spec 006 says about a case
  spec 011, a merged spec, already changed.
- AC-4. **The test suite still passes.** Given each PR, when `pnpm test`
  runs from the repository root, then it passes: the spec-present gate and
  the design-tree check accept spec 006 and this spec, and the recorded
  held-work tests of specs 011 and 040 pass unchanged.

## 4. Interfaces and files

No schema, prompt or behaviour change.

The spec PR changes:

- `specs/084-spec-006-branch-left-at-held-head/spec.md` (this file);
- `specs/006-no-human-stops/spec.md`: the mark of AC-1, nothing else;
- `docs/delivery-system-design.md`: this spec listed under `## Children`.

The implementation PR changes exactly one file:

- `tools/scheduler/src/chain/driver.ts`: the doc comment on `syncWorktree`
  (AC-2). Suggested wording, which the implementer may tighten keeping
  AC-2's content: `/** Fetch, keep any leftovers as a patch, then put the
  worktree where the next step must see it: with no PR, the chain's branch
  (`issue-<n>` or `spec-<n>`) at its held head when held work names it (spec
  011 AC-2, AC-5), otherwise fresh from origin/main (C1, AC-21); with a PR,
  ... */`, the rest of the comment unchanged.

Sensitive paths: `specs/006-no-human-stops/spec.md` (the spec PR) and
`tools/scheduler/` (the implementation PR) are on
`agents/sensitive-paths.txt`, so the security review runs on both PRs as
spec 006 AC-9 says, and both paths are listed here so the scope gate accepts
the diffs. Neither change touches what makes a path sensitive, the security
criteria, or the review routing.

## 5. Verification

- `pnpm test` from the repository root passes on each PR (AC-4).
- `git diff main -- specs/006-no-human-stops/spec.md` on the spec PR shows
  one changed line: the line holding `**Branch.**` gains the mark between
  that bold title and `The PR is from branch`; no other line changes (AC-1).
- Reading check: `grep -n "084-spec-006-branch-left-at-held-head"
  specs/006-no-human-stops/spec.md` finds exactly one line, in AC-21's
  Branch paragraph (AC-1).
- `git diff main -- tools/scheduler/src/chain/driver.ts` on the
  implementation PR touches only the doc comment above
  `async function syncWorktree` (AC-2).

## 6. Open decisions

None.
