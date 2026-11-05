# 031. A merged design files issues for its children

Status: written 2026-11-05 for issue #41 from the delivery-system design's
section 10 (the design hierarchy); specs derived from that design need no
maintainer approval (design section 11). Needs spec 006 on `main` (it is).
Needs nothing else on `main`: specs 026 to 028 are not built, so this spec
records no events and names them only where it leaves a seam for them.
Class: tooling. Domain: automation (sensitive path, process-spec section 5).
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("A design states its parent and lists its children", "Reflection
flags designs with children missing a spec and specs with no implementation",
"Enforced in code"), section 11 (the table this spec migrates), section 4
(the spec agent writes and completes specs), section 5 (the section 11 table
and the `## Children` sections are tracking text, not protected decisions)
and section 2 (anti-goal: the maintainer is asked things an agent could have
decided); [charter](../../docs/charter.md) (the system delivers on its own and
needs the maintainer only for direction); [spec 006](../006-no-human-stops/spec.md)
AC-21 to AC-25 (the spec PR's scope, the spec-present gate, the design-tree
check, the `## Children` section), AC-4 (what happens after a spec PR merges)
and AC-19 (a gate failure routes to the spec stage); [spec 008](../008-agent-registry/spec.md)
and [spec 014](../014-filer-batch-integrity/spec.md) AC-6 (the findings
filer's App-authored `validated` issues and its body marker, which this
spec's filing copies); [spec 028](../028-reflection-agents/spec.md) AC-1 and
AC-5 (the reflection backstop and its `design_tree` input); [ADR 0004](../../docs/decisions/0004-split-metrics-reflection-spec.md)
(a split design's children are ordered by the `blocked` label; the issue that
carried the split keeps a `README.md` pointer); [ADR 0005](../../docs/decisions/0005-console-static-site-small-api.md)
(the console is row E's second child).

What the maintainer decided (design section 10), kept as it is here: every
artifact has exactly one parent; a design lists its children and each child
names its parent; a design has at least two children; the rules are enforced
in code; staleness is handled with findings, not automatic rewrites. The issue
adds the maintainer's direction that the stage authoring a design is
responsible for its breakdown and that filing the children is deterministic
code.

## 1. Goal

Make a design's breakdown part of the design, and make the scheduler turn it
into work:

- **Planned children.** A design (a top design or a sub-design under
  `docs/designs/`) may list children that do not exist as files yet, each
  with a slug, a title, a one-paragraph brief, and optional `after:`
  dependencies on siblings. They live in the design's `## Children` section
  beside the children that are files, so the one parser, the one design-tree
  check and the one spec-PR scope rule cover both. The spec stage writes them
  when it authors or revises a design; the spec review checks the breakdown
  against the design.
- **Deterministic filing.** Whenever `main` moves (a merge, however it was
  made, or the service's first tick), the scheduler reads every design on
  `main` and files one App-authored `validated` issue for each planned child
  that has no issue yet, with the brief as its body and a link to the design.
  A child whose `after:` siblings are not done is filed with `blocked`, and
  the scheduler removes the label when they are. Every step is idempotent
  through a marker per child in the issue body and in the scheduler's
  comments, as the findings filer's are, so a lost state directory or a
  restart files nothing twice.
- **One issue per spec.** A filed child's issue carries its spec and then its
  implementation through the one chain, as every issue does today. An issue
  whose spec stage authored a sub-design instead (the split of ADR 0004) is
  closed when the design merges: its work continues in its children's issues.
- **The migration.** The table of the delivery-system design's section 11
  becomes planned-children entries in that document's `## Children` section,
  with the existing issue numbers recorded, so nothing is filed twice.

## 2. Out of scope

- Writing the specs of any planned child (the console, issue #101; the test
  board, issue #132): their own issues carry them.
- Blocking or unblocking issues the scheduler did not block: the `blocked`
  labels set by hand on issues #37, #94 and #95 stay as they are until a
  person or the chain that owns them removes them. `after:` acts when a
  child is filed, and the scheduler removes only a `blocked` it added.
- Deriving a spec's issue from git history, or deciding whether a spec that
  is a file is implemented: that is spec 028 AC-5's `design_tree` input, not
  built yet. This spec gives that input a parser for planned children
  (AC-10) and changes nothing in spec 028.
- Recording `issue.filed` or any other event: spec 026 is not on `main`.
  When it lands, the filing of AC-4 goes through its recorded wrapper as the
  findings filer's does, which is that spec's change, not this one's.
- Rewriting a design or a spec when its parent changes (design section 10,
  staleness): findings, by reflection, as the design says.
- Pre-assigning spec numbers to planned children. Issue #40 collided on a
  number assigned early; a child's spec takes the next free number when its
  spec stage runs (spec 006 AC-21 appends the `Spec:` line then).
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review. `tools/scheduler/`,
  `agents/` and `docs/delivery-system-design.md` are sensitive, so the
  security review runs on the implementation PR.
- Any change to the delivery-system design other than its section 11 table
  (and the paragraph that replaces it, marked *(author's call)*) and its
  `## Children` section (the parts security criterion 7 exempts). Section
  10's sentence about specs A to G stays as it is; issue #103 or a
  maintainer answer owns it.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
A *design* is `docs/product-spec.md`, `docs/delivery-system-design.md` or a
file under `docs/designs/`. A *child entry* is one bullet of a design's
`## Children` section. A child is *done* when its recorded issue is closed
and does not carry the `abandoned` label *(agent's call: an abandoned issue
is re-triaged by the filer into a new issue, so it is not finished work)*.

**The form**

- AC-1. **A design may list planned children.** The `## Children` section
  of a design holds two kinds of bullet. A *file child* is today's form,
  `` - `specs/NNN-<slug>/spec.md` `` or `` - `docs/designs/<slug>.md` ``,
  optionally followed by free text; when that text contains `issue #<n>`,
  `<n>` is the child's recorded issue. A *planned child* is a bullet
  `- planned: <slug>` followed by indented key lines, two spaces in, in any
  order:
  - `title:` one line, the issue title (required);
  - `brief:` one paragraph, which may continue on further indented lines
    until the next key or bullet (required): what the child covers, in
    enough detail that a spec stage can write the spec from it and the
    design;
  - `after:` a comma-separated list of sibling references, each a planned
    sibling's slug or a file sibling's path (optional);
  - `class:` one of the class labels of `agents/scheduler.yaml`
    (`feature_classes` and `debt_classes`); default `class:product` under
    `docs/product-spec.md` and `class:tooling` under
    `docs/delivery-system-design.md`, by the design's top ancestor
    (optional);
  - `issue:` `#<n>`, the issue that already carries this child, written by
    hand when an issue was filed before this spec or outside it (optional).

  A slug matches `[a-z0-9][a-z0-9-]*`; the child's spec, when written, is
  `specs/NNN-<slug>/spec.md` with the next free number, and its spec PR
  replaces the planned bullet with the file bullet, keeping `(issue #<n>)`.
  `parseChildren` in `tools/scheduler/src/spec/parse.ts` keeps returning the
  file children's paths, so the spec-present gate and the scope gate are
  unchanged; a new `parseChildEntries` returns every entry with its kind,
  slug or path, title, brief, `after`, class and issue. Given the sample
  section in the test fixture, then both functions return what this
  criterion says, and a planned bullet missing `title:` or `brief:` is
  returned with an `error` naming the key.
- AC-2. **The design-tree check reads the breakdown.** `checkDesignTree`
  (spec 006 AC-24) counts planned children toward the two-children rule and
  rejects, each with a reason naming the design and the slug:
  - a planned child missing `title:` or `brief:`, or with a slug that does
    not match the pattern;
  - two children with the same slug, or a planned slug equal to the slug of
    a file sibling `specs/NNN-<slug>/spec.md` (the planned bullet was not
    replaced when the spec was written);
  - an `after:` reference that names no sibling, or names the entry itself,
    or forms a cycle among the siblings;
  - a `class:` not in the configured class labels;
  - an `issue:` that is not `#<n>`.

  Given the real repository, then the check passes (the migration of AC-11
  is valid). `specs/README.md` documents the form in its design-hierarchy
  paragraph.

**The filing**

- AC-3. **The scan runs when `main` moves.** Given the service's first tick
  after start, or a tick on which `fastForward` reports that `origin/main`
  moved, then after the fast-forward and before the shortlist the service
  runs `fileDesignChildren` over the designs of the checked-out `main`
  (`loadDesignTree`). The scan lists the repository's issues in every state
  once (a new `listIssues({ state: "all" })` on the GitHub client, paged like
  `listOpenIssues`; `IssueData` gains `state: "open" | "closed"`), and uses
  that one listing for everything below. Given the tick did not move `main`
  and is not the first, then no scan runs and GitHub is not called for it. A
  failure of the scan is an entry in the tick's `errors` and the service log
  (`kind: "children-scan-failed"`), and the next scan runs on the next move
  of `main`; it never stops the tick.
- AC-4. **One issue per planned child, once.** For every planned child of
  every design, in file order then bullet order, the scan resolves the
  child's issue: the entry's `issue:` when present, else the issue whose body
  carries the marker `<!-- panelator-child:<design path>:<slug> -->`
  (open or closed). Given none, then it files one issue with the App's
  credentials: title the entry's `title:`; body the `brief:`, a blank line,
  `Parent design: \`<design path>\` (planned child \`<slug>\`).`, one
  sentence saying that the spec for this work names that design on its
  `Parent:` line, lives at `specs/NNN-<slug>/spec.md` with the next free
  number, and replaces the planned entry with the spec's path in the
  design's `## Children` section; when the entry has `after:`, a line
  `After: #<a>, #<b>` naming the siblings' issues; and the marker on its own
  last line. Labels: the entry's class (AC-1's default when absent) and
  `validated`, exactly as the findings filer labels its issues, so the
  authority gate and the shortlist accept it. The body carries no `Spec:`
  line. The text of the brief has every `<!-- panelator-child` sequence
  neutralised as the filer does for its markers (spec 014 AC-6), so no text
  but the scan's own carries the marker. The service log records
  `{ kind: "child-filed", design, slug, issue }`. Given the same design on
  `main` on the next scan, then nothing is filed: the marker is found.
  Given two scans race (a restart mid-scan), then the second finds the first's
  issue by marker and files nothing; given the first crashed between
  `createIssue` and the log line, the same holds. Given `createIssue` fails,
  then the error is logged (`kind: "child-filing-failed"`, with the design
  and slug), the scan continues with the next child, and the child is tried
  again on the next scan; given it has failed on three scans in a row (counted
  in `children/failures.json` in the state directory), then one finding is
  appended to the findings queue through `appendFindings` (`what`: the child
  cannot be filed, `where`: the design path and slug, `evidence`: the last
  error) and the counter resets, so the filer carries it to the maintainer
  as any failure finding (spec 020).
- AC-5. **`after:` is the `blocked` label.** Given a planned child being filed
  whose `after:` names at least one sibling that is not done (a planned
  sibling's issue, which the same scan filed just before when it had none;
  a file sibling's `issue #<n>`), then the issue is filed with `blocked` as a
  third label, and the scan posts one comment `Blocked until <#a, #b> are
  done (after: <refs> in <design path>).` ending with the marker
  `<!-- panelator-child-blocked:<design path>:<slug> -->`. Given every
  `after:` sibling is done, or the entry has no `after:`, then no `blocked`
  and no comment. Given an `after:` reference to a file sibling with no
  `issue #<n>` in its bullet, then the sibling cannot be judged: the scan
  logs `{ kind: "child-after-unknown", design, slug, ref }`, treats it as
  done (the file exists on `main`, so its spec at least is done) and files
  the child unblocked *(agent's call: a wrongly early issue is cheaper than
  an issue blocked for ever)*. The design-tree check does not require the
  issue number, so a design can be written before the number is known.
- AC-6. **Unblocking is the scan's too.** On every scan, for every planned
  child whose issue is open, carries `blocked`, has the blocked marker
  comment of AC-5 and no comment with
  `<!-- panelator-child-unblocked:<design path>:<slug> -->`: given every
  `after:` sibling is now done, then the scan removes `blocked`, posts one
  comment `Unblocked: <#a, #b> are done.` ending with the unblocked marker,
  and logs `{ kind: "child-unblocked", design, slug, issue }`. Given a
  sibling is still open, or closed with `abandoned`, then nothing changes
  and the issue waits for the next scan (an abandoned sibling is re-triaged
  by the filer into a new issue; when a person records that issue in the
  sibling's bullet, the next scan sees it). Given the issue has `blocked`
  but no blocked marker comment (set by hand, as on #37), then the scan
  never removes it. Given the unblocked marker is present, then the scan
  never touches the label again, however it was set since.
- AC-7. **Issue numbers recorded by hand are the record.** Given a planned
  child with `issue: #<n>`, then the scan files nothing for it and judges
  it done by that issue, whether or not the issue's body carries the marker.
  Given `#<n>` is closed with `abandoned` or does not exist, then the child
  is neither filed nor done, and the scan logs
  `{ kind: "child-issue-dead", design, slug, issue }` once per scan; a
  person (or the filer's re-triage, which names the superseding issue in
  its body) updates the bullet through a reviewed PR. *(agent's call: the
  recorded number wins over the marker so the migration cannot double-file,
  and a dead number is visible, not silently refiled)*

**The chain**

- AC-8. **A spec issue is still one issue.** Given a child issue filed by
  AC-4, when it is shortlisted, then spec-present fails with "issue body has
  no `Spec:` line"-class reason as for any issue without a spec on `main`,
  the chain runs the spec stage in `write` mode, and spec 006 AC-21 appends
  the `Spec:` line; the spec, plan, implement, review and merge follow as
  today. No second issue is filed for the implementation by any code path;
  a test asserts that a recorded chain from a child issue to a merged
  implementation creates no issue.
- AC-9. **An issue whose spec stage authored a design is closed when the
  design merges.** Given a spec-track PR merges and the post-merge
  spec-present gate fails because the issue's `Spec:` path does not exist on
  `main`, and the directory of that path holds a `README.md` on `main` (the
  split form of `specs/README.md`), and the merged PR's diff added or changed
  a file under `docs/designs/` whose `## Children` lists at least two
  entries, then instead of spec 006's "escalate (stuck: spec, `write` mode)"
  row the chain posts one comment naming the design and saying its children
  are filed by the scheduler from the design's `## Children` section, closes
  the issue, removes the claim label, and ends `done`; `spec-<issue>` is
  deleted as after any spec-track merge; the merge is appended to
  `merges.jsonl` as a `debt`-class system merge like any other merge of the
  chain. The children themselves are filed by AC-3's scan on the same tick
  that sees `main` move, not by the chain. Given the directory holds no
  `README.md`, or the diff touched no design, then spec 006's row applies
  unchanged. The spec stage's instructions (`agents/stages/spec.md`) say,
  for a split, to write the sub-design with its planned children, the
  `README.md` pointer in the spec's directory, and the ADR when the split is
  a decision, all in the one spec PR (spec 006 AC-21's scope already allows
  the spec directory, `docs/designs/` and `docs/decisions/`).

**The authoring and the review**

- AC-10. **The spec stage writes the breakdown; the spec review checks it.**
  `agents/stages/spec.md` and `agents/profiles/spec/instructions.md` tell
  the stage: when it authors a design or revises one, every part of the
  design is covered by exactly one child, existing or planned, in the form
  of AC-1; a planned child's brief says what that child covers and what it
  leaves to its siblings; `after:` is set when a child cannot be built
  before a sibling merges; and a child whose spec already exists is a file
  bullet, never both. `agents/profiles/spec/review-criteria.md` gains
  criterion 8: when the PR adds or changes a design's `## Children`, the
  breakdown fits the design (every part covered by one child, no two
  children covering the same part, each brief enough to write a spec from,
  each `after:` justified by the design). The spec-PR review input is
  unchanged (the reviewer reads the diff). `tools/scheduler/src/gates/design-tree.ts`
  exports `designTreeReport(root)`: per design, its entries from
  `parseChildEntries` with, for each planned child, the recorded `issue`
  (from `issue:` or the marker, when the caller passes the issue list) and
  `done`; it is the seam spec 028 AC-5's `design_tree` input takes planned
  children from when that spec is built, and the delivery reflection's
  "designs with children missing a spec" then reads planned children with no
  issue from it.

**The migration**

- AC-11. **Section 11's table becomes planned children.** In
  `docs/delivery-system-design.md`:
  - the `## Children` section's bullets for rows A, C, D, E, F1 and F2 gain
    `(row <letter>, issue #<n>)`: `specs/007-telegram-channel/spec.md`
    (row A, issue #9); `specs/008-agent-registry/spec.md` (row C, issue #10);
    `docs/designs/metrics-reflection.md` (row D, issue #15, abandoned; its
    children's issues are #93, #94 and #95); `specs/029-design-stage/spec.md`
    (row E, issue #38); `specs/022-delivery-aws-account/spec.md` (row F1,
    issue #37); `specs/030-beyond-github/spec.md` (row F2, issue #39);
    `specs/006-no-human-stops/spec.md` (row B, built by hand). Every other
    file bullet stays as it is, this spec's included;
  - two planned children are added at the end: `console` (`title:
    Specify and build the maintainer console (row E, second part)`,
    `after: specs/029-design-stage/spec.md, specs/022-delivery-aws-account/spec.md`,
    `issue: #101`, brief from design section 9 and ADR 0005) and
    `test-board` (`title: Test board and automatic stable firmware promotion
    (design spec G)`, `issue: #132` (its first issue, #40, was abandoned),
    brief from row G and design section 5's firmware paragraphs);
  - section 11's table is replaced by a paragraph saying that the
    breakdown is the `## Children` section, where each child's row letter
    and issue are recorded, and that the scheduler files planned children
    from it (this spec); the paragraph is marked *(author's call)*, so it is
    not an added unmarked decision; the "Order" paragraph and the paragraph
    after the table stay;
  No statement marked as a maintainer decision or unmarked design decision
  is changed: the section 11 table and the `## Children` section are the
  editorial parts security criterion 7 leaves unprotected. Section 10's
  sentence "This document's own children are specs A to G below ..." is not
  touched; it is left to issue #103 or a maintainer answer. Given the migrated document on `main`, then the first
  scan files nothing (both planned children carry `issue:`) and unblocks
  nothing (#101 has no blocked marker comment).
- AC-12. **Everything else is unchanged.** Given no design on `main` has a
  planned child, then the scan files nothing and the recorded chains of
  specs 006, 007, 008, 011, 013, 015, 025 and 029 pass unchanged.

## 4. Design notes (agent's calls)

- **The breakdown lives in `## Children`.** Spec 006 AC-21 lets a spec PR
  edit a top design's `## Children` section and nothing else of it, and
  security criterion 7 leaves that section unprotected. Putting planned
  children there means the spec stage can author a breakdown of either top
  design through the ordinary spec PR, the design-tree check validates it
  with the one parser, and no new section or file type is introduced. A
  planned child is a bullet with key lines rather than a table so that a
  brief can be a paragraph.
- **GitHub is the record, as for the filer.** The marker in the issue body
  is the idempotency key (spec 014's pattern); the blocked and unblocked
  marker comments are the record of what the scheduler did to the label.
  The state directory holds only the failure counter, so a lost state
  directory files nothing twice and unblocks nothing it did not block.
- **A scan, not a hook on the chain's merge.** Designs also change through
  PRs the maintainer merges by hand and through implementation PRs (this
  spec's own migration is one). Running on every move of `main` covers all
  of them and the restart case, and it is idempotent, so running it more
  often costs one issue listing and nothing else.
- **`after:` acts once, when filing.** The `blocked` label is already how the
  shortlist defers work (spec 008's `BLOCKED`, ADR 0004); the scan adds and
  removes it and touches no label it did not set. Dependencies of an issue
  that already exists when the design is written are the author's to carry
  in the issue (as issue #101's status-line convention does).
- **Why the split issue is closed, not escalated.** Spec 006's row for a
  failed post-merge spec-present gate assumes the spec stage failed to write
  a spec. A split is the stage doing its job: the issue's work now lives in
  the children's issues, and spec 029's note (section 4) and issue #15's
  abandonment show the row otherwise ends in abandonment. Closing with a
  comment is the smallest change that makes authoring a design through the
  pipeline possible.
- **Spec 028's `design_tree` is left to spec 028.** It is not built; its text
  says `## Children` paths each with `exists`. The report of AC-10 is the
  function it will call; the change to its wording is a finding on this spec,
  not an edit (this spec may not change spec 028).

## 5. Interfaces and files

This list is the implementation's file scope: the plan's tasks name these
files (a whole directory, written with a trailing slash, where the list
gives one) and no other. A file is listed even when its change is one line,
because the scope gate of spec 006 holds the implementation to the plan's
list and a fix cannot widen it. An existing test that asserts the previous
shape of a file changed here changes with it and is listed.

- **Parsing and the check, under `tools/scheduler/src/`.** `spec/parse.ts`
  (`parseChildEntries`, the `ChildEntry` type; `parseChildren` unchanged in
  behaviour); `gates/design-tree.ts` (planned children in `checkDesignTree`,
  AC-2; `designTreeReport`, AC-10); `gates/index.ts` (the exports).
- **The scan.** `tools/scheduler/src/children/` as a directory: `scan.ts`
  (`fileDesignChildren(deps)`: resolve, file, block, unblock, the failure
  counter, AC-3 to AC-7), `markers.ts` (the three marker strings, their
  neutralising, `isChildIssue`). `tools/scheduler/src/state/paths.ts`
  (`childrenFailures`: `children/failures.json`, AC-4).
- **The service and GitHub.** `tools/scheduler/src/service/loop.ts` (the
  scan after the fast-forward on the first tick and on a move, AC-3);
  `tools/scheduler/src/github/client.ts` (`listIssues({ state: "all" })`,
  `state` on `IssueData`); `tools/scheduler/src/types.ts` (`IssueData.state`).
- **The chain.** `tools/scheduler/src/chain/machine.ts` (the split row of
  AC-9: close, comment, `done`); `tools/scheduler/src/chain/driver.ts`
  (`specGateOnMain` reports whether the spec directory holds a `README.md`
  and whether the merged diff touched `docs/designs/`; the `merges.jsonl`
  append for the split merge); `tools/scheduler/src/chain/types.ts` (the
  two fields on the post-merge gate result).
- **The stage and the profile.** `agents/stages/spec.md` (AC-9's split
  instructions, AC-10's breakdown instructions);
  `agents/profiles/spec/instructions.md` (the form of AC-1 in brief);
  `agents/profiles/spec/review-criteria.md` (criterion 8, AC-10).
- **Documents.** `docs/delivery-system-design.md` (AC-11: section 11's
  table, the `## Children` section, and nothing else); `specs/README.md` (the planned-child form, AC-2); `tools/README.md`
  (the scan, the markers and the state file). `dev-logs/` as a directory
  for the implementation's log.
- **Tests, under `tools/scheduler/test/`.** `spec.test.ts` (AC-1);
  `design-tree.test.ts` (AC-2 cases and the real repository);
  `children.test.ts` (new: AC-4 to AC-7 over a mocked GitHub client and a
  fixture tree, including the race, the failure counter and the finding);
  `loop.test.ts` (AC-3: first tick, moved, not moved); `client.test.ts`
  (`listIssues`); `chain.test.ts` and `driver.test.ts` (AC-9);
  `e2e.test.ts` with `helpers/e2e-routes.ts` and `helpers/repo-pair.ts`
  (the recorded runs of section 6) and fixtures under `fixtures/` (a design
  with planned children; a split spec directory with a `README.md`).

No file outside `tools/scheduler/`, `agents/`, `docs/delivery-system-design.md`,
`specs/README.md`, `tools/README.md` and `dev-logs/` is changed by the
implementation. `tools/scheduler/`, `agents/` and
`docs/delivery-system-design.md` are sensitive paths, so the security review
runs on the PR as spec 006 AC-9 says; the diff to the design touches only the
unprotected tracking text named in AC-11.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including:
  - the parser and design-tree cases of AC-1 and AC-2, and the design-tree
    check over the real repository with the migrated design;
  - `children.test.ts`: a design with three planned children, the second
    `after:` the first and the third with `issue:`: two issues filed, the
    second `blocked` with its comment, the third untouched; a second scan
    files nothing; the first issue closed, a third scan unblocks the second
    once and a fourth scan does nothing; a hand-set `blocked` is never
    removed; `createIssue` failing three scans running appends one finding;
  - recorded end-to-end runs (fake adapter, mocked GitHub) for: `main`
    moving with a merged design that lists two planned children, then the
    child issue shortlisted and carried to a merged implementation with no
    second issue filed (AC-3, AC-4, AC-8); a spec stage that authors a
    sub-design with a `README.md` pointer, merged, the issue closed `done`
    (AC-9); every earlier recorded chain unchanged (AC-12).
- After the merge, the first scan on `main` is checked in the service log:
  no `child-filed` entry for the migrated design, and the log is written up
  in `dev-logs/`.

## 7. Open decisions

None.
