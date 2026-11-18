# 073. Delivery reflection reads planned children from `designTreeReport`

Status: written 2026-11-18 from the delivery-system design for issue #141;
specs derived from that design need no maintainer approval (design section 11).
Amends [028-reflection-agents](../028-reflection-agents/spec.md) AC-1 and AC-5
(marks in this spec's PR, spec 039). Needs spec 031 on `main` (it is); spec 028
is not built, so its amendment is to text only.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Staleness": reflection flags designs with children missing a
spec and specs with no implementation; "Small work skips layers");
[031-design-files-children](../031-design-files-children/spec.md) AC-1 (planned
children), AC-4 and AC-7 (how a planned child's issue is resolved, and a dead
`issue:` that the scan neither files nor counts as done), AC-10 (the
`designTreeReport` seam) and section 4, last bullet (the change to spec 028's
wording is a finding on spec 031, not an edit there);
[028-reflection-agents](../028-reflection-agents/spec.md) AC-1 and AC-5 (the
text this spec amends); [039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md)
and [ADR 0009](../../docs/decisions/0009-spec-pr-marks-superseded-text.md) (the
marks).

## 1. Goal

When spec 028 is built, the delivery reflection sees every child a design
lists, planned children included, and files a plan item for each planned
child that nothing is working on.

### What is wrong today

Spec 028 AC-5 defines the delivery reflection's `design_tree` input as, per
design, its `## Children` paths each with `exists`, and AC-1 asks the agent to
file a plan item for every `docs/designs/<slug>.md` child path that has no
file. Spec 031, merged after spec 028 was written, added planned children
(`- planned: <slug>` bullets) to `## Children`. A planned child is a child
missing a spec by definition, and the scan of spec 031 files its issue; the
case the design's backstop is for is the planned child whose filing did not
happen or whose issue died: no issue at all, or an `issue: #<n>` that does not
exist or is closed with `abandoned`, which spec 031 AC-7 neither refiles nor
counts as done (it logs `child-issue-dead` and waits for a person). Spec 028's
input, built from its own text, carries no planned children, so the
reflection cannot see either case.

Spec 031 AC-10 left the seam: `designTreeReport(root, { issues, botLogin })`
in `tools/scheduler/src/gates/design-tree.ts` returns every design's child
entries with, for a planned child, its recorded issue and `done`. Two things
are missing from it for spec 028's use: a file child's `exists`, which spec
028's input has today, and whether a planned child's issue is dead, which the
report folds into `done: false` beside a live open issue.

### The fix

1. `designTreeReport` reports `exists` for a file child and `dead` for a
   planned child (AC-1).
2. Spec 028 AC-5's `design_tree` is built from that report (AC-2) and AC-1's
   walk files an item for a planned child with no issue or a dead one (AC-3),
   recorded as marks on spec 028 in this spec's PR (AC-4).

## 2. Out of scope

- Building spec 028: its input builder, schemas and agents stay unbuilt. This
  spec changes what its `design_tree` input and its delivery reflection
  prompt say, not when they are built.
- The scan of spec 031 (`tools/scheduler/src/children/`): it still files
  nothing for a dead `issue:` and logs `child-issue-dead` as AC-7 says, and
  `resolveChildIssue` is unchanged. The reflection is the backstop, not a
  second filer.
- Spec 031's text, including its section 4 bullet that leaves this change to
  spec 028: it stays true as the record of what spec 031 did.
- The other cases of the design's staleness rule (a merged spec with no
  implementation, a design whose descendants no longer fit): unchanged in
  spec 028 AC-1.
- The design-tree check and the spec-present gate: unchanged.

## 3. Acceptance criteria

"Given" states are fixture repositories built by the test in a temporary
directory and `IssueData` lists, as in the existing `designTreeReport` test;
AC-4 is checked by reading the PR's diff.

- AC-1. **The report says whether a file exists and whether an issue is
  dead.** `designTreeReport(root, opts)` keeps its signature and its current
  fields, and adds two to `ReportEntry`:
  - `exists` (file children only, always set): `true` when the child's path
    exists under `root`, else `false`.
  - `dead` (planned children only, set when `opts.issues` is passed, beside
    `done`): `true` when the child has a recorded issue (`recordedIssue`, from
    `issue:` or from the App-authored marker as today) and that issue is not
    in `opts.issues` or is closed with the `abandoned` label; else `false`.
    `done` is unchanged: a dead child is never done.

  Given a design whose `## Children` holds a file child whose path exists, a
  file child whose path does not, and planned children `a` (App-authored
  marker issue, open), `b` (no issue), `c` (`issue: #7`, absent from the
  list), `d` (`issue: #8`, closed with `abandoned`), `e` (App-authored marker
  issue, closed with `abandoned`) and `f` (`issue: #9`, closed without
  `abandoned`), when the report is built with the issue list, then the file
  children carry `exists: true` and `exists: false`, and the planned children
  carry, in order: `a` `recordedIssue` set, `done: false`, `dead: false`; `b`
  no `recordedIssue`, `done: false`, `dead: false`; `c` `recordedIssue: 7`,
  `dead: true`; `d` `recordedIssue: 8`, `dead: true`, `done: false`; `e`
  `dead: true`, `done: false`; `f` `recordedIssue: 9`, `done: true`, `dead:
  false`. Given the same repository and no issue list, then no planned child
  carries `done` or `dead`, and the file children still carry `exists`.
  *(agent's call: an abandoned issue found by the marker counts as dead too.
  Spec 031's scan treats it as the child's issue and never refiles, so it is
  the same stuck state as a dead `issue:`, and the reflection is where either
  is noticed)*
- AC-2. **Spec 028's `design_tree` is built from the report.** Spec 028
  AC-5's `design_tree` bullet reads, as amended: built by the scheduler from
  the repository at the period's end by calling `designTreeReport(<worktree
  root>, { issues, botLogin })`, with `issues` the repository's issues in
  every state (the listing spec 031's scan uses, `listIssues({ state: "all"
  })`) and `botLogin` the App's bot login; per design (each key of the report:
  the two top designs and every `docs/designs/*.md`), its children in bullet
  order, each a file child `{ kind: "file", path, exists }` or a planned
  child `{ kind: "planned", slug, title, issue, done, dead }`, with `issue`
  the report's `recordedIssue` or `null`. A planned entry the design-tree
  check would reject (the report's `error` set, a missing title or brief) is carried with
  `issue: null` and its `error`, so the reflection sees it rather than the
  input dropping it. The per-spec part of the bullet (path, status line,
  `issue`, `implemented`) is unchanged. Spec 028's input schema
  (`schemas/scheduler/reflection-input.json`) carries these fields, and spec
  028's `design_tree` fixture test adds one planned child with no issue and
  one with a dead `issue:` and asserts their `issue`, `done` and `dead`.
- AC-3. **The delivery reflection files an item for a planned child nothing
  is working on.** Spec 028 AC-1's design-tree walk reads, as amended: from
  the input's `design_tree`, for every planned child with `issue: null`,
  every planned child with `dead: true`, every `docs/designs/<slug>.md` child
  path with `exists: false`, and every merged spec whose issue has no merged
  implementation PR, it files one plan item (a finding, never an automatic
  rewrite), or states why not. The item names the design and the child's
  slug and, for a dead issue, the issue number, so the item's spec stage can
  update the bullet through a reviewed PR as spec 031 AC-7 asks. A planned
  child with a live issue (`issue` set, `dead: false`) is the chain's work
  and needs no item.
- AC-4. **The amendment is marked on spec 028.** This spec's PR prepends to
  `specs/028-reflection-agents/spec.md` AC-1, after `AC-1.` and before its
  bold title, `Amended by [073-reflection-reads-planned-children](../073-reflection-reads-planned-children/spec.md) AC-3:`
  followed by one clause, and to AC-5, in the same place, the same link with
  `AC-2:` and one clause, and changes nothing else in spec 028 (spec 039,
  review criterion 5). The `design_tree` bullet is not a titled paragraph,
  so its criterion carries the mark.

## 4. Design notes (agent's calls)

- **The report, not the input, decides `dead`.** Spec 031 already resolves a
  planned child's issue in one place (`resolveChildIssue`, shared by the scan
  and the report); deciding "dead" next to it keeps one definition, and the
  scan's own `dead` (a recorded `issue:` only) is left as the scan's.
- **`exists` moves into the report.** Spec 028's input then maps the report's
  entries one to one instead of re-reading the file system beside it; it is
  one `existsSync` per file child.
- **Marks, not a reading in this spec.** Spec 028 is a landed spec that will
  be built from its text; spec 039 makes the amending spec's PR mark it so
  the implementer of spec 028 is pointed here from the criteria it builds.

## 5. Interfaces and files

The paths in backticks are what the scope gate reads: a sensitive file in the
diff passes only if it is listed here in full (exactly, or under a listed
entry ending in `/`).

- `tools/scheduler/src/gates/design-tree.ts`: `ReportEntry` gains `exists?:
  boolean` and `dead?: boolean`; `designTreeReport` sets them (AC-1). The
  export list of `tools/scheduler/src/gates/index.ts` is unchanged.
- `tools/scheduler/test/design-tree.test.ts`: the fixture test of AC-1 in the
  `designTreeReport` block, beside the existing marker test, which keeps
  passing.
- `specs/028-reflection-agents/spec.md`: the two marks of AC-4, written in
  this spec's PR.
- `docs/delivery-system-design.md`: this spec's line in `## Children`, in
  this spec's PR.

No other file is changed by the implementation. `tools/scheduler/` is a
sensitive path, so the security review runs on the implementation PR as spec
006 AC-9 says. Nothing here changes the sensitive-path list, the security
criteria, or what routes a sensitive diff to the security review.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including the AC-1 fixture test (file children's `exists`, the six planned
  children's `recordedIssue`, `done` and `dead`, and the no-issue-list case)
  and the existing `designTreeReport` marker test unchanged.
- The design-tree check and the spec-present gate pass on this spec's PR:
  `Parent:` names `docs/delivery-system-design.md`, which lists this spec.
- Reading the spec PR's diff: spec 028 changes only by the two marks of AC-4.

## 7. Open decisions

None.
