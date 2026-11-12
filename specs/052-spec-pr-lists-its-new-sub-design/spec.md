# 052. A spec PR may list its new sub-design in the top design's Children

Status: written 2026-11-12 from the delivery-system design for issue #102;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("One document type for designs, any depth": sub-designs live in
`docs/designs/`; "A design must have at least two children"; "Small work
skips layers": a tooling spec hangs directly off a top design) and section 4
(agents resolve their own blockers); [031-design-files-children](../031-design-files-children/spec.md)
AC-1 and AC-9 (planned children count toward the two-children rule; the
split's parent is the sub-design's parent); [039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md)
AC-5 (the mark); amends [006-no-human-stops](../006-no-human-stops/spec.md)
AC-21 (the paragraph **Scope.**, marked in this PR) as section 4 records.

## 1. Goal

A spec stage can write a spec whose parent is a new sub-design under
`docs/designs/`, together with that sub-design and the line listing it in the
top design's `## Children`, in one spec PR that passes both the spec-scope
gate (spec 006 AC-21, AC-22) and the design-tree check (spec 006 AC-24).

### What is wrong today

The design-tree check requires every design under `docs/designs/` to be
listed in the `## Children` of its parent and to have at least two children.
The spec-scope gate (`tools/scheduler/src/gates/spec-scope.ts`) allows the
spec's directory, `docs/designs/`, `docs/decisions/`, and the `## Children`
section of the spec's *own* parent. When that parent is a new sub-design
whose parent is a top design, listing the sub-design means editing the top
design's `## Children`, and the gate reports
`docs/delivery-system-design.md: outside spec PR scope`. Without that edit
the design-tree check fails with `not listed in the Children of its parent`.
No diff passes both. PR #96 (issue #38) hit this and row E was flattened.

Two of the failures issue #102 lists are already fixed on `main`:

- `child specs/030-console/spec.md does not exist` and
  `a sub-design needs at least two children, has 1`: since spec 031 a
  design's sibling child whose spec is not written yet is a planned bullet,
  which counts toward the two-children rule and needs no file.
- A split (a `README.md` beside a missing `spec.md`, spec 031 AC-9): the
  driver's `splitParent` already passes the sub-design's parent to the gate
  as the parent, so the top design's `## Children` is allowed there.

What is left is the case where the spec PR writes the spec itself and hangs
it from a new sub-design. This spec closes it.

### The fix

- When the spec's parent is a file under `docs/designs/`, the gate also
  allows the `## Children` section of the top design that parent descends
  from, judged with the same `stripChildren` comparison as a top-design
  parent (AC-1, AC-2).
- The driver finds that top design by following `Parent:` lines through
  `docs/designs/` in the worktree, and passes its text before and after
  (AC-4).
- The spec stage prompt and the spec review's scope criterion name the new
  allowance (AC-5, AC-6), and spec 006 AC-21's **Scope.** paragraph carries
  the mark (AC-7, written in this spec's own PR).

## 2. Out of scope

- The directories of other specs a sub-design lists as children, which the
  issue's suggested fix also named. A new sub-design's siblings of the spec
  are planned bullets (spec 031), so the design-tree check needs no other
  spec file; allowing other spec directories would let one spec PR write
  several specs, which the split rule of the spec stage (one spec per issue,
  the rest planned children with their own issues) rules out. Another spec's
  `spec.md` stays allowed only as spec 039 says, for marks.
- Moving an existing spec under a new sub-design (changing that spec's
  `Parent:` line, which is not a mark): not covered; a spec PR still cannot
  do it.
- The charter rule, the rule that a top design changes in full only while a
  maintainer's product answer is recorded, and the rule for a top-design
  parent: unchanged and checked before the new allowance.
- The design-tree check (`tools/scheduler/src/gates/design-tree.ts`), the
  spec-present gate, `splitParent`, the design-scope gate, the
  implement-track scope gate (`tools/scheduler/src/gates/scope.ts`), the
  sensitive-path routing (`isSensitive`, `pickProfile`, `securityPass`),
  `agents/sensitive-paths.txt` and the security review criteria and
  instructions: all unchanged. A spec PR that uses the new allowance touches
  a top design, which is a sensitive path, and still gets the security
  review.
- `docs/designs/` files: already allowed in full; unchanged.
- Restructuring row E again (spec 029 and spec 051 stay children of the top
  design): any regrouping is its own work.

## 3. Acceptance criteria

In this section the *parent* is the path on the new spec's `Parent:` line
(or, for a split, the parent `splitParent` returns, as today), and the
*top* of a parent under `docs/designs/` is found by following `Parent:`
lines from the parent, reading each file from the worktree, for as long as
the current path is under `docs/designs/`: the first path reached that is
one of the two top designs (`docs/product-spec.md`,
`docs/delivery-system-design.md`) is the top. When the walk reaches any
other path (the charter, a spec, a path outside `docs/`), a file that does
not exist or has no `Parent:` line, or a path it has already visited, there
is no top. A parent that is itself a top design has no top.

- AC-1. **The top's Children section is in scope.** Given a spec PR whose
  spec's parent is `docs/designs/new.md`, whose top is
  `docs/delivery-system-design.md`, and whose diff touches the spec,
  `docs/designs/new.md` and `docs/delivery-system-design.md`, when the
  top design differs from `origin/main` only inside its `## Children`
  section (`stripChildren` of the two texts is equal), then the spec-scope
  gate reports no violation and returns `ok: true`.
- AC-2. **Only the Children section, and only of the top.** Given the same
  PR:
  - when the top design also changes outside its `## Children` section,
    then the gate reports `docs/delivery-system-design.md: changes outside
    its Children section`;
  - when the diff touches the other top design (`docs/product-spec.md`),
    then the gate reports `docs/product-spec.md: outside spec PR scope`, as
    today;
  - when the spec's parent is a top design, then a top passed to the gate
    is ignored and the other top design is `outside spec PR scope`, as
    today;
  - when there is no top (the walk ends without reaching a top design),
    then a touched top design is `outside spec PR scope`, as today;
  - `docs/charter.md` in the diff is `docs/charter.md: the charter is never
    changed by a spec PR` whatever the top is, and a top path that is not
    one of the two top designs widens nothing;
  - with a maintainer's product answer being recorded, either top design is
    allowed in full, as today.
  Every existing `specScopeGate` test in `tools/scheduler/test/gates.test.ts`
  passes unchanged.
- AC-3. **Both gates pass on the issue's shape.** Given an in-memory tree
  (the form of `tools/scheduler/test/design-tree.test.ts`) holding the
  charter, both top designs, a new `docs/designs/new.md` with
  `Parent: docs/delivery-system-design.md` whose `## Children` lists the
  file child `` `specs/010-a/spec.md` `` and one planned child, the spec
  `specs/010-a/spec.md` with `Parent: docs/designs/new.md`, and the top
  design's `## Children` listing `` `docs/designs/new.md` ``, then
  `checkDesignTree` returns no errors, and `specScopeGate` over the diff
  `specs/010-a/spec.md`, `docs/designs/new.md`,
  `docs/delivery-system-design.md` (the top design's text before having no
  such line) returns `ok: true`. Given the same tree without the top
  design's line, `checkDesignTree` reports `docs/designs/new.md: not listed
  in the Children of its parent docs/delivery-system-design.md`.
- AC-4. **The driver finds the top.** Given the spec-track scope check runs
  (`specTrackScope` in `tools/scheduler/src/chain/driver.ts`) and the parent
  is under `docs/designs/`, then it finds the top by the walk above, over
  the worktree's files, and passes the gate the top's path, its text on
  `origin/main` (the empty string when absent there) and its text in the
  worktree. Given a parent two levels down (`docs/designs/inner.md` whose
  parent is `docs/designs/outer.md`, whose parent is a top design), then
  the top is that top design. Given a walk that loops
  (`docs/designs/a.md` and `docs/designs/b.md` naming each other), then the
  walk ends with no top and the check still returns. A driver test drives a
  spec run whose spec stage commits the spec, a new sub-design and the top
  design's Children line, and asserts the claim does not go to `fix` with a
  scope violation for the top design.
- AC-5. **The spec stage is told.** Given the spec stage prompt
  (`agents/stages/spec.md`), then its "Files you may change" list says that
  when the spec's parent is a file under `docs/designs/`, the `## Children`
  section of the top design it descends from may also change, to list a new
  sub-design; and its "A split" paragraph keeps saying to list the
  sub-design in its parent's `## Children`.
- AC-6. **The spec review knows the allowance.** Given criterion 5 of
  `agents/profiles/spec/review-criteria.md`, then its list of allowed paths
  includes the `## Children` section of the top design that a sub-design
  parent descends from. The rest of the criterion and criteria 6 to 8 are
  unchanged.
- AC-7. **Spec 006 AC-21 carries the amendment.** Given
  `specs/006-no-human-stops/spec.md` AC-21, then its paragraph beginning
  `**Scope.**` starts, after that bold title, with
  `Amended by [052-spec-pr-lists-its-new-sub-design](../052-spec-pr-lists-its-new-sub-design/spec.md) AC-1: when the parent is under docs/designs/, the list also allows the Children section of the top design it descends from.`
  followed by the existing spec 039 mark and the rest of the paragraph
  unchanged. This spec's own PR writes the mark.
- AC-8. **Nothing protected is weakened.** Given the implementation PR's
  diff, then: the charter check, the product-answer allowance and the
  top-design-parent check of `specScopeGate` run as today; the design-tree
  check, `splitParent`, `tools/scheduler/src/gates/scope.ts`,
  `tools/scheduler/src/gates/sensitive.ts`, `pickProfile`, `securityPass`,
  `agents/sensitive-paths.txt`, `agents/profiles/security/` and
  `docs/charter.md` are unchanged; no text marked
  `(maintainer answer, question #<id>)` changes; nothing under `docs/`
  changes; and `pnpm test` from the repository root passes, including the
  recorded end-to-end chain tests of `tools/scheduler/test/e2e.test.ts`
  without change.

## 4. Amendments to earlier specs

- **Spec 006 AC-21, "Scope."** The list of paths the scope check of AC-22
  holds the spec PR to gains: when the spec's parent is a file under
  `docs/designs/`, the `## Children` section of the top design that parent
  descends from (AC-1, AC-2). The mark is written in this spec's PR (AC-7).
  The charter remains never allowed; the top designs remain allowed in full
  only while a maintainer's product answer is recorded.
- **Spec 006 AC-22 and AC-24.** Unchanged: a violation of the widened scope
  is handled as AC-22 says, and the design-tree check is the same.
- **Spec 031 AC-9.** Unchanged; its parenthesis lists part of the scope and
  stays true.

## 5. Interfaces and files

The implementation PR edits exactly these files:

- `tools/scheduler/src/gates/spec-scope.ts`: `specScopeGate` takes the top
  (suggested: a trailing parameter
  `top: { path: string; before: string; after: string } | null = null`
  after `specText`, so existing callers and tests keep their argument
  order). In the top-design branch, after the product-answer allowance, a
  file equal to `top.path` is allowed when the parent is under
  `docs/designs/`, `top.path` is one of `TOP_DESIGNS`, and
  `stripChildren(top.before) === stripChildren(top.after)`; when the first
  two hold and the third does not, the violation is
  `<path>: changes outside its Children section`. Everything else in the
  function is unchanged. The doc comment names this spec.
- `tools/scheduler/src/chain/driver.ts`: a helper (suggested
  `designTop(worktree, parent)`) implementing the walk of section 3, with
  `parseSpec` for each `Parent:` line; `specTrackScope` calls it when the
  parent is under `docs/designs/`, reads the top's text from `origin/main`
  with `gitShow` and from the worktree, and passes the top to the gate
  (AC-4).
- `tools/scheduler/test/gates.test.ts`: tests for AC-1 and AC-2 in the
  `specScopeGate` block, and AC-3's test (it imports `checkDesignTree`).
- `tools/scheduler/test/driver.test.ts`: AC-4's tests (the walk two levels
  down and the loop may be tested on the helper if it is exported, or
  through `step`).
- `agents/stages/spec.md`: the "Files you may change" list (AC-5).
- `agents/profiles/spec/review-criteria.md`: criterion 5 (AC-6).

The spec PR itself adds this file, writes the mark of AC-7 in
`specs/006-no-human-stops/spec.md`, and lists this spec under `## Children`
in `docs/delivery-system-design.md`.

Sensitive paths this spec lists, so the implement-track scope gate accepts
the diff and the security review runs (spec 006 AC-9): `tools/scheduler/`
and `agents/`. Nothing here changes the sensitive-path list, the security
criteria or instructions, the charter rule of `spec-scope.ts` that security
criterion 5 names, or what routes a sensitive diff to the security review
and requires both reviews (AC-8). The allowance is limited to the
`## Children` section of a top design, a file the design-tree check already
requires the PR to change, and a spec PR that uses it touches a top design,
which is sensitive, so the security review still judges it.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass in the worktree, and `pnpm -F @panelator/scheduler typecheck` is
  clean (AC-2, AC-8).
- The new AC-1 and AC-3 cases in `gates.test.ts` fail on `main` before the
  change (`docs/delivery-system-design.md: outside spec PR scope`) and pass
  after it; the AC-4 driver test fails on `main` with the claim in `fix`.
- `git diff main --stat` lists only the files of section 5 (AC-8).
- Reading check: `agents/stages/spec.md` and criterion 5 of
  `agents/profiles/spec/review-criteria.md` name the top design's
  `## Children` section for a sub-design parent (AC-5, AC-6);
  `grep -n "Amended by \[052-" specs/006-no-human-stops/spec.md` finds the
  **Scope.** paragraph (AC-7).

## 7. Open decisions

None.
