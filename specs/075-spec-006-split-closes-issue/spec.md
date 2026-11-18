# 075. Spec 006's post-merge spec-present rule names spec 031's split exception

Status: written 2026-11-18 from the delivery-system design for issue #143;
specs derived from that design need no maintainer approval (design section 11).
Amends [006-no-human-stops](../006-no-human-stops/spec.md) AC-4 (a failed
post-merge spec-present gate is a bound hit with the spec stage stuck) and
section 4 (the chain table's row "merge, spec track | merged, spec-present
fails on `origin/main`"), with marks in this spec's PR (spec 039). Records
what [031-design-files-children](../031-design-files-children/spec.md) AC-9
already shipped; no behaviour changes.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design); [031-design-files-children](../031-design-files-children/spec.md)
AC-9 (a split closes the issue `done` instead of escalating) and section 4
("Why the split issue is closed, not escalated"; spec 031 section 5 left spec
006's text unchanged because spec 006 was outside its PR's scope);
[039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md)
and [ADR 0009](../../docs/decisions/0009-spec-pr-marks-superseded-text.md)
(the spec PR marks the earlier text in place);
[021-stale-spec-text-after-008](../021-stale-spec-text-after-008/spec.md)
(the precedent: a spec that corrects text another spec left stale).

## 1. Goal

An agent that reads spec 006 for what happens when a spec-track PR merges
and spec-present then fails on `origin/main` reads the rule that ships,
including the split case of spec 031 AC-9.

### What is wrong today

Spec 006 AC-4 says "Given spec-present fails, then it is a bound hit with the
spec stage as the stuck stage, under the spec-track rule of AC-5: the spec
stage runs again in `write` mode with the reason, or the issue is abandoned."
Spec 006 section 4's chain table has the row "merge, spec track | merged,
spec-present fails on `origin/main` | delete `spec-<issue>`; escalate (stuck:
spec, `write` mode with the reason)". Neither names an exception.

Spec 031 AC-9 added one: when the issue's `Spec:` path does not exist on
`main`, the directory of that path holds a `README.md` on `main`, and the
merged PR's diff added or changed a file under `docs/designs/` whose
`## Children` lists at least two entries, the chain posts one comment naming
the design, closes the issue, removes the claim label and ends `done`;
`spec-<issue>` is deleted as after any spec-track merge. This is live in
`specMerged` in `tools/scheduler/src/chain/machine.ts` (the branch on
`gate.specDirReadme && gate.designTouched`) and is pinned by the recorded
test "a split (README.md pointer and a merged design) closes the issue and
ends done instead of escalating (spec 031 AC-9)" in
`tools/scheduler/test/chain.test.ts`. Spec 031 section 5 lists no change to
spec 006, so spec 006 still states the escalation as the only outcome.

The doc comment on `specMerged` says the same stale thing in code: "AC-4:
after a spec PR merges, spec-present and the UI-design gate ran again on
origin/main. The chain is not done." For a split the chain is done.

### The fix

- In this spec PR, two marks on spec 006 (spec 039): one on AC-4, one on
  section 4 (the table row is not a unit a mark can sit on, so the mark is a
  block quote under the section heading, as spec 039 says for a section).
  Each points here; this spec's AC-1 and AC-2 say what applies.
- In the implementation PR, the doc comment on `specMerged` is corrected
  (AC-3). No transition, gate, label or test changes.

## 2. Out of scope

- The behaviour of the split case (spec 031 AC-9), the chain's transitions,
  the gates, the labels and the recorded tests: all unchanged. This spec
  records what shipped.
- The UI-design row beside it ("merge, spec track | merged, UI design missing
  on `origin/main` | ... `needs-design-stage`; released, ledger kept") and the
  matching sentence of spec 006 AC-4, which spec 029 AC-1 changed (the design
  stage runs instead of the park). That is a separate stale passage left by a
  different spec; it is recorded as a finding of this run, not marked here,
  since a mark names the new spec and this spec does not say what applies
  there.
- Any other passage of spec 006 or of any other spec, and spec 031's own
  text.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the branch, read as text; "then" clauses are
checked by reading them and by `pnpm test` where it says so.

- AC-1. **What applies to AC-4's failed spec-present gate.** Given a
  spec-track PR has merged and the post-merge spec-present gate fails on
  `origin/main`, then the outcome is:
  - when the conditions of spec 031 AC-9 hold (the issue's `Spec:` path is
    absent on `main`, its directory holds a `README.md` on `main`, and the
    merged diff added or changed a file under `docs/designs/` whose
    `## Children` lists at least two entries): `spec-<issue>` is deleted, one
    comment naming the design is posted, the issue is closed, the claim label
    is removed and the chain ends `done`, with no bound hit and no escalation;
  - otherwise: spec 006 AC-4's rule unchanged (a bound hit with the spec stage
    stuck in `write` mode with the reason, under AC-5's spec-track rule, or
    abandonment).

  `specs/006-no-human-stops/spec.md` AC-4 carries, after `AC-4.` and before
  its bold title, the mark `Amended by
  [075-spec-006-split-closes-issue](../075-spec-006-split-closes-issue/spec.md)
  AC-1:` followed by one clause stating that a split of spec 031 AC-9 closes
  the issue `done` instead of the bound hit, and a period. The rest of AC-4 is
  unchanged word for word.
- AC-2. **What applies to the chain table.** Given spec 006 section 4's table,
  then a row "merge, spec track | merged, spec-present fails on `origin/main`,
  a split (spec 031 AC-9) | delete `spec-<issue>`; comment naming the design;
  issue closed; claim label removed; `done`" applies before the row "merge,
  spec track | merged, spec-present fails on `origin/main`", which applies
  unchanged to every other failure (the table's first-match rule). Section 4
  carries, as the first thing under its heading, a block quote (lines
  beginning `> `) reading `Amended by
  [075-spec-006-split-closes-issue](../075-spec-006-split-closes-issue/spec.md)
  AC-2:` followed by one clause naming the row above and the split case, and
  a period. The section's text and table are otherwise unchanged.
- AC-3. **The code comment agrees.** Given `tools/scheduler/src/chain/machine.ts`
  after the implementation PR, then the doc comment on `specMerged` no longer
  says without exception that the chain is not done: it says the chain is not
  done except for a split (spec 031 AC-9), which ends `done`. The diff of that
  file changes that comment only; no statement, type or test changes.
- AC-4. **No maintainer decision and no enforcement changes.** Given this
  spec's PR and its implementation PR, then neither changes text marked
  `(maintainer answer, question #<id>)`, the sensitive-path list, the security
  criteria or instructions, or what routes a sensitive diff to the security
  review. The marks change only what spec 006 says about a case spec 031
  AC-9, a merged spec, already changed.
- AC-5. **The test suite still passes.** Given each PR, when `pnpm test` runs
  from the repository root, then it passes: the spec-present gate and the
  design-tree check accept spec 006, spec 031 and this spec, and the recorded
  chain tests, among them spec 031 AC-9's split test, pass unchanged.

## 4. Interfaces and files

No schema, prompt or behaviour change.

The spec PR changes:

- `specs/075-spec-006-split-closes-issue/spec.md` (this file);
- `specs/006-no-human-stops/spec.md`: the two marks of AC-1 and AC-2, nothing
  else;
- `docs/delivery-system-design.md`: this spec listed under `## Children`.

The implementation PR changes exactly one file:

- `tools/scheduler/src/chain/machine.ts`: the doc comment on `specMerged`
  (AC-3). Suggested wording, which the implementer may tighten keeping AC-3's
  content: `/** AC-4: after a spec PR merges, spec-present and the UI-design
  gate ran again on origin/main. The chain is not done, except for a split
  (spec 031 AC-9, spec 075), which closes the issue and ends done. */`

Sensitive paths: `specs/006-no-human-stops/spec.md` (the spec PR) and
`tools/scheduler/` (the implementation PR) are on `agents/sensitive-paths.txt`,
so the security review runs on both PRs as spec 006 AC-9 says, and both paths
are listed here so the scope gate accepts the diffs. Neither change touches
what makes a path sensitive, the security criteria, or the review routing.

## 5. Verification

- `pnpm test` from the repository root passes on each PR (AC-5).
- `git diff main -- specs/006-no-human-stops/spec.md` shows two changes: the
  AC-4 line gains the mark between `AC-4.` and `**A merged spec PR`, and one
  block quote is added under `## 4. Chain changes`; no other line changes
  (AC-1, AC-2).
- `git diff main -- tools/scheduler/src/chain/machine.ts` on the
  implementation PR touches only the doc comment above `function specMerged`
  (AC-3).
- Reading check: `grep -n "075-spec-006-split-closes-issue" specs/006-no-human-stops/spec.md`
  finds exactly two lines, one in AC-4 and one in section 4 (AC-1, AC-2).

## 6. Open decisions

None.
