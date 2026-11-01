# 030. A merged design files issues for its children

Status: written 2026-11-01 for issue #41; specs derived from the
delivery-system design need no maintainer approval (design section 11).
Needs spec 006 on `main` (it is). Amends spec 006 AC-24 (the design-tree
check learns planned children) and spec 028 AC-5 (the `design_tree` input
gains planned children, AC-9 below).
Class: tooling. Domain: automation (sensitive path, process-spec section 5).
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
sections 4 (the spec agent), 6.2 (level 2: repository content changes by
reviewed PR), 10 (design hierarchy: a design lists its children; staleness;
reflection flags designs with children missing a spec) and 11 (the table of
specs A to G, which this spec migrates); [charter](../../docs/charter.md)
(the system delivers on its own; nothing on the path to `main` waits on a
human); [process-spec](../../docs/process-spec.md) 4.3 (issue authority:
only App-authored issues are worked); [spec 006](../006-no-human-stops/spec.md)
AC-19 (an issue without a `Spec:` line starts at the spec stage), AC-21 (the
spec PR's scope includes the parent's `## Children` section), AC-23 to AC-25
(the parent and children checks); [spec 008](../008-agent-registry/spec.md)
AC-5 and AC-18 (issues are filed by the scheduler as the App, `validated`,
with a hidden marker searched for before creating);
[spec 026](../026-event-store/spec.md) AC-2 (`createIssueRecorded`);
[spec 028](../028-reflection-agents/spec.md) AC-1 and AC-5 (delivery
reflection walks the design tree); [ADR 0004](../../docs/decisions/0004-split-metrics-reflection-spec.md)
(order between sibling specs carried by the `blocked` label).

What the maintainer decided, kept as it is here: designs split into
sub-designs or specs and every artifact has exactly one parent (design
section 10); the system writes the specs and builds them through the pipeline
without approving them individually (design section 11); only issues
authored by the pipeline's bot are worked (process-spec 4.3).

## 1. Goal

Make a design's breakdown part of the design, and make filing it work the
scheduler does in code:

- A design (a top design, or a sub-design under `docs/designs/`) can list
  **planned children** under `## Children`: children that do not exist as
  files yet, each with a slug, a title, a one-paragraph brief and optional
  `after:` dependencies on sibling children. The spec stage writes them when
  it authors or revises a design, and the spec review checks the breakdown
  against the design.
- Whenever `main` moves, the scheduler walks every design on `main` and
  files one App-authored `validated` issue per planned child that has no
  issue yet, with the brief as its body and a link to the design. A child
  whose `after:` siblings are not done is filed with `blocked`, and loses the
  label when they are. Filing is idempotent: a state record and a hidden
  marker per child, as the findings filer's.
- The issue filed for a child carries that child's spec and its
  implementation through the same chain as any issue today: spec stage,
  then plan, implement, review and merge. No separate implementation issue
  exists.
- The design-tree check accepts planned children, counts them toward a
  sub-design's two children, and rejects malformed or dangling entries.
- Section 11 of the delivery-system design is migrated to the new form, with
  the existing issue numbers recorded, so nothing is filed twice.
- Reflection (spec 028) stays the backstop and sees planned children in its
  input.

## 2. Out of scope

- Deciding what a design's children are: that is the spec stage's authoring
  judgement, checked by the spec review. This spec gives the form and the
  filing.
- Issues filed by hand by the maintainer: they stay as they are, and the
  migration records their numbers so the sweep leaves them alone.
- Changing the shortlist's `blocked` skip, the authority or validated gates,
  the chain's stages, bounds or transitions, the findings filer, or the
  reflection agents beyond the `design_tree` field of AC-9.
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review. `tools/scheduler/`,
  `agents/` and `docs/delivery-system-design.md` are sensitive, so the
  security review runs on this PR and on the implementation's.
- Rewriting a design's existing children into planned form where the child
  file exists: an existing child stays a path entry.
- The product spec's children: it has none planned today and this spec adds
  none; the form applies to it from now on.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
A *design* is `docs/product-spec.md`, `docs/delivery-system-design.md` or a
file under `docs/designs/`. A *path entry* is today's `## Children` bullet
naming a file. A *planned entry* is the form of AC-1. A child's *slug* is,
for a planned entry, its `planned:` value and, for a path entry, the spec
directory's name after its number (`specs/029-design-stage/spec.md` has slug
`design-stage`; a sub-design `docs/designs/<slug>.md` has that slug).

**The form**

- AC-1. **A design can list children that do not exist yet.** Under
  `## Children`, beside path entries, a bullet of the form

  ```
  - planned: <slug>
    title: <one line>
    after: <slug>, <slug>
    issue: #<n>
    class: <label>
    <the brief: one paragraph on indented lines>
  ```

  is a planned entry. `planned:` and `title:` are required; `after:`,
  `issue:` and `class:` are optional and come in any order before the brief;
  the brief is every remaining indented line, joined, and must be at least
  200 characters *(agent's call: the bound spec 028 AC-7 uses for a plan
  item, so a brief says enough to write a spec from)*. A slug matches
  `^[a-z0-9]+(-[a-z0-9]+)*$`. `parseChildren` in `tools/scheduler/src/spec/parse.ts`
  keeps returning the paths of path entries only, so the spec-present gate
  and every existing caller are unchanged; a new `parseChildEntries` returns
  both kinds with their fields. Given a bullet that starts with `planned:`
  and is not well formed (no title, a bad slug, a brief under the bound, an
  unknown key), then it is a malformed entry for AC-2.
- AC-2. **The design-tree check knows planned children.** Spec 006 AC-24's
  check (`tools/scheduler/src/gates/design-tree.ts`), in addition to its
  rules, fails on:
  - a malformed planned entry (AC-1), naming the design and the bullet;
  - two children of one design with the same slug, whether planned or path;
  - a planned entry whose slug equals the slug of a spec directory that
    exists under `specs/` (the child exists: the entry must be a path);
  - an `after:` slug that names no sibling child of the same design, or the
    entry itself;
  - a cycle through `after:` links.

  A planned entry counts as a child for the two-children rule, so a
  sub-design with two planned children passes. A planned entry is never a
  dangling link: the check does not require its file. The check still runs
  over the real repository in `pnpm test` (spec 006 AC-24), so a design
  merged with a bad entry fails CI on `main` as well as in its PR.

**Filing**

- AC-3. **A merged design files its planned children.** The scheduler keeps
  `children/swept.json` in the state directory with the `origin/main` commit
  it last swept. Given a tick on which `origin/main` differs from it (the
  service's existing fetch; at service start it always differs), then,
  before the shortlist is read, the **children sweep** runs over every
  design on `origin/main` (the files `loadDesignTree` reads) and, for every
  planned entry in `## Children` order, resolves its issue (AC-5) and:
  - given no issue, files one (AC-4) and records the number;
  - given an open issue labelled `blocked` whose `after:` siblings are all
    done (AC-5), removes `blocked` and posts one comment saying which
    siblings closed; the removal is recorded so a crash after the comment
    does not comment twice;
  - otherwise does nothing.

  Then `children/swept.json` is written. Given the sweep throws on one
  entry (a GitHub error), then the rest of the entries are still swept, one
  finding naming the design, the slug and the error is appended to the
  findings queue (spec 001 AC-28), and `swept.json` is not advanced, so the
  next tick tries again. Given a merge by the chain (either track), then
  the next tick's sweep sees the new `main`; no code path files from the
  merging run itself. The sweep also runs on the command
  `panelator-scheduler children sweep`, which prints what it did and what
  it would do with `--dry-run` *(agent's call: the command, so the
  migration of AC-10 can be checked by hand before the service runs it)*.
- AC-4. **What is filed.** The issue is created as the App through
  `createIssueRecorded` (spec 026 AC-2) when `tools/scheduler/src/events/filed.ts`
  exists on `main`, otherwise through the client's `createIssue`, which
  spec 026 then routes; with:
  - title: the entry's `title:`;
  - labels: `validated`, the entry's `class:` resolved as the filer resolves
    a class (spec 018 `resolveClass`), or, without `class:`, `class:tooling`
    for a design whose chain of parents reaches `docs/delivery-system-design.md`
    and `class:feature` for one that reaches `docs/product-spec.md`; and
    `blocked` when any `after:` sibling is not done (AC-5);
  - body: the brief; a blank line; `Design: <design path>` with a link to
    the design file on `main` and the words `planned child <slug>`; given
    `after:` siblings, a line `After: <slug> (#<n>), ...` naming each
    sibling and its issue when known; then the hidden marker
    `<!-- panelator-child:<design path>:<slug> -->`. Every line of the brief
    matching `^\s*Spec:` is removed first, as the filer does (spec 008
    AC-18), so the issue has no `Spec:` line and its chain starts at the
    spec stage (spec 006 AC-19).

  Given the entry's `issue:` field is present, then nothing is filed for
  it, whatever GitHub holds: the field is the record that the issue exists.
  Given no `issue:` field, then before creating, the sweep reads
  `children/issues.json` (the state record, `<design path>:<slug>` to
  issue number) and, when it has no entry, searches open issues for the
  marker (spec 008 AC-18); a hit is recorded and not filed again. A crash
  between the creation and the record is covered by the marker search on
  the next tick. A test drives the same design through two sweeps and
  asserts one `createIssue` call; another deletes `children/issues.json`
  between them and asserts the same.
- AC-5. **Resolving a child's issue, and "done".** A child's issue is, in
  this order: the `issue:` field of its planned entry; the entry of
  `children/issues.json` for `<design path>:<slug>`; for a path entry, the
  issue (open or closed, any author) whose body carries
  `Spec: <that path>` (the line spec 006 AC-21 appends, and hand-filed
  issues carry), read through a client method that lists issues in every
  state with full pagination (process-spec 6.4), lowest number first; or
  none. A child is **done** when its issue is resolved and closed. A child
  with no resolvable issue is not done. An issue the maintainer closes by
  hand therefore counts as done *(agent's call: the maintainer closing an
  issue is a decision that its dependants need not wait, whether the work
  merged or was dropped; the alternative, reading the merge record, misses
  everything merged before that record existed)*. The resolution is one
  function, `resolveChild`, in `tools/scheduler/src/design/children.ts`,
  used by the sweep and by AC-9.

**The chain on a child's issue**

- AC-6. **The issue carries the spec and the implementation.** Given a
  filed child issue is shortlisted, then its chain starts at the spec stage
  in `write` mode (spec 006 AC-19) with the issue body, so the brief and
  the design link are the stage's input as today; the spec stage names the
  spec directory `specs/NNN-<slug>/` with the entry's slug and, in the same
  spec PR, replaces the planned entry in the parent's `## Children` with
  the path entry (the section is already in the spec PR's scope, spec 006
  AC-21). The design-tree check passes on that PR because the path exists
  and names its parent. After the spec PR merges the chain continues at
  plan as today (spec 006 AC-4); no second issue is filed for the
  implementation. Given a spec stage result whose `spec_path` directory
  slug differs from the child's slug on an issue carrying a child marker,
  then the scheduler fails the run with the reason, as it fails a
  `spec_path` that differs from the `Spec:` line (spec 006 AC-21); the
  stage prompt says so.
- AC-7. **The spec stage writes the breakdown.** `agents/stages/spec.md`
  tells the stage that whenever it authors a sub-design under
  `docs/designs/`, or revises one, or records a product answer that adds a
  part to a top design, it lists under `## Children` every child the design
  needs: existing ones as paths, the rest as planned entries of AC-1 with
  `after:` wherever one child needs another on `main` first; and that it
  never writes an `issue:` field (only the migration of AC-10 and a hand
  edit do). It also tells the stage the slug rule of AC-6 for a child
  issue. `agents/profiles/spec/review-criteria.md` gains one criterion: a
  design's children, planned and existing together, cover every part the
  design describes, no two overlap, every planned entry has a title and a
  brief a spec can be written from, and `after:` names each order the
  design states. `tools/README.md` describes the form and the sweep.

**Backstops and the record**

- AC-8. **A filing that cannot happen is a finding.** Given the sweep's
  issue creation fails three ticks in a row for one entry, then one finding
  is appended (not one per tick) and one notification is sent; the finding
  names the design, the slug and the last error. The attempts are counted
  in `children/issues.json` beside the slug and cleared on success.
- AC-9. **Reflection sees planned children.** Spec 028 AC-5's `design_tree`
  input, per design, lists its planned entries as `planned: [{ slug, title,
  after, issue, blocked }]` where `issue` is the resolved number or `null`
  and `blocked` whether that issue is open with the label; delivery
  reflection's prompt (spec 028 AC-1) treats a planned child with `issue:
  null`, and a blocked child whose `after:` siblings are all done, as the
  design-section-10 staleness it already files a plan item for. Given spec
  028's `tools/scheduler/src/reflection/input.ts` exists on `main` when
  this spec is implemented, then this implementation adds the field;
  otherwise `tools/scheduler/src/design/children.ts` exports
  `plannedChildrenReport(root)` and spec 028's implementation calls it.
  Either way a test over a fixture repository with one planned child and
  no issue asserts the field.
- AC-10. **Section 11 is migrated.** `docs/delivery-system-design.md`
  section 11's table is replaced by a short paragraph pointing at
  `## Children` (the order, the "B first by hand" history and the F split
  stay as prose), and `## Children` lists, for every row, its children:
  - path entries for what exists: B is spec 006, A is spec 007, C is spec
    008, D is `docs/designs/metrics-reflection.md`, F1 is spec 022, E's
    design stage is spec 029 (all listed today);
  - planned entries for the rest of E (the console, `after: design-stage`
    and the slug of spec 022), F2 (reach beyond GitHub) and G (test board
    and stable promotion), each with the brief distilled from the row and
    the sections it cites, and an `issue:` field naming the issue filed by
    hand for it: the implementation reads the open issues #39 and #40 and
    the console issue spec 029 names ("filed as its own issue, blocked"),
    matches each by title, and records the numbers. Given no issue exists
    for a row, then the entry has no `issue:` field and the sweep files it.
  The paragraph in section 10 that lists "specs A to G below" is left as
  it is (it is not marked *(author's call)*). The section 11 table and the
  `## Children` section are editorial and tracking parts that an ordinary
  reviewed PR changes (design section 5, spec 006 AC-10), and this
  migration changes no statement design section 5 protects. After the
  migration the sweep's `--dry-run` on `main` reports nothing to file.
- AC-11. **Everything else is unchanged.** Given a repository whose designs
  have only path entries (every recorded chain of specs 006, 007, 008,
  011, 013, 015, 025 and 029), then the sweep files nothing and those
  chains pass unchanged.

## 4. Design notes (agent's calls)

- **A sweep of `main`, not a hook on the merge.** The merge that matters
  may be the chain's, a hand merge from the maintainer's session, or a
  revert; the one thing they share is that `main` moved. Walking the
  designs on each new head is a few file reads, is idempotent by
  construction, and needs no list of the PR's files.
- **Three keys against a double filing.** The `issue:` field records what
  was filed before this spec and lets a hand edit pin an issue; the state
  record is the fast path; the marker is the recovery when the record is
  lost. The findings filer uses the last two for the same reason.
- **Done means closed.** The chain closes an issue when its implementation
  merges (the implement stage's `Closes #<issue>`); a closed issue is also
  what the maintainer leaves when a child is dropped. One GitHub read, no
  dependence on when the merge record began.
- **The brief is the issue, the spec stage does the rest.** The chain today
  turns an App-authored issue without a `Spec:` line into a spec, then a
  plan and a PR, so a planned child needs nothing new after filing. The
  slug rule is the only coupling: it lets the sweep match a child to its
  spec without a registry.
- **The spec stage lists children because it writes the design.** The
  breakdown is a judgement about the design's parts; the author knows them
  and the reviewer can check them against the text. Code only checks the
  form.

## 5. Interfaces and files

This list is the implementation's file scope: the plan's tasks name these
files (a whole directory, written with a trailing slash, where the list
gives one) and no other. A sensitive file in the diff passes the scope gate
only if it is listed here.

- **Parsing and the tree.** `tools/scheduler/src/spec/parse.ts`
  (`parseChildEntries`, the planned entry form of AC-1; `parseChildren`
  unchanged in result); `tools/scheduler/src/gates/design-tree.ts` (AC-2).
- **The sweep.** `tools/scheduler/src/design/` as a directory:
  `children.ts` (`resolveChild`, done, `plannedChildrenReport`, AC-5 and
  AC-9) and `sweep.ts` (AC-3, AC-4, AC-8). `tools/scheduler/src/service/loop.ts`
  (the sweep on a new `origin/main` head, before the shortlist);
  `tools/scheduler/bin/scheduler.ts` (`children sweep [--dry-run]`);
  `tools/scheduler/src/state/paths.ts` (`children/swept.json`,
  `children/issues.json`); `tools/scheduler/src/github/client.ts` and
  `tools/scheduler/src/github/types.ts` (list issues in every state with
  pagination, AC-5); `tools/scheduler/src/chain/driver.ts` (the slug check
  of AC-6); `tools/scheduler/src/filer/apply.ts` only if `resolveClass`
  moves to a shared module for AC-4 (otherwise it is imported as it is).
- **Reflection.** `tools/scheduler/src/reflection/input.ts` when it exists
  on `main` (AC-9).
- **Agents.** `agents/stages/spec.md` (AC-6, AC-7);
  `agents/profiles/spec/review-criteria.md` (AC-7).
- **Schemas.** `schemas/scheduler/` as a directory: `children-issues.json`
  for the state record (AC-4, AC-8).
- **Documents.** `docs/delivery-system-design.md`: section 11 and
  `## Children` (AC-10) and nothing else in it. `specs/README.md`: the
  planned entry form in the design-hierarchy paragraph. `tools/README.md`
  (AC-7). `dev-logs/` as a directory for the implementation's log.
- **Tests, under `tools/scheduler/test/`.** `spec-parse.test.ts` or the
  existing parse test (AC-1), `gates.test.ts` (AC-2 cases and the real
  repository), `children.test.ts` (AC-3 to AC-5, AC-8: two sweeps file
  once, record deleted, marker hit, `blocked` removed once, the error path,
  the class default by top design), `driver.test.ts` (AC-6 slug check),
  `loop.test.ts` (the sweep on a moved head), `stages.test.ts` and
  `profiles.test.ts` (AC-7 text present), `reflection.test.ts` when AC-9
  applies, `state.test.ts` (the new paths), the recorded runs of section 6
  in `e2e.test.ts` with `helpers/e2e-routes.ts` (issue listing in every
  state, label removal) and a fixture design with planned children under
  `fixtures/`.

No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/`,
`docs/delivery-system-design.md`, `specs/README.md` and `dev-logs/` is
changed by the implementation. `tools/scheduler/`, `agents/` and
`docs/delivery-system-design.md` are sensitive paths, so the security review
runs on the PR (spec 006 AC-9); the design's change is confined to the
unprotected section 11 table and `## Children` (spec 006 AC-10).

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including the design-tree check over the real repository after the
  migration (AC-2, AC-10), and recorded end-to-end runs (fake adapter,
  mocked GitHub) for:
  - a sub-design with two planned children, one `after:` the other, merged
    to `main`: the next tick files two issues, the second `blocked`; a
    second tick files nothing (AC-3, AC-4);
  - the first child's issue closed: the next tick removes `blocked` from
    the second with one comment, and a restart comments nothing (AC-3,
    AC-5);
  - a planned entry with `issue:`: nothing filed (AC-4);
  - a filed child issue shortlisted: the spec stage runs in `write` mode,
    its spec PR replaces the planned entry with the path, the chain
    continues at plan (AC-6); a `spec_path` with the wrong slug fails the
    run (AC-6);
  - `createIssue` failing three ticks running: one finding, one
    notification, then success on the fourth (AC-8);
  - every earlier recorded chain unchanged (AC-11).
- `panelator-scheduler children sweep --dry-run` on the migrated `main`
  reports nothing to file (AC-10); its output is kept in the
  implementation's `dev-logs/` entry with the issue numbers it recorded.

## 7. Open decisions

None.
