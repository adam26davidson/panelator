# 071. A spec PR can move its spec: the result names the new path and the scheduler rewrites the issue's `Spec:` line

Status: written 2026-11-17 from the delivery-system design for issue #133;
specs derived from that design need no maintainer approval (design section 11).
Amends [006-no-human-stops](../006-no-human-stops/spec.md) AC-21 (a spec
result's `spec_path` must equal the issue's `Spec:` line) and
[065-scheduler-reserves-spec-and-adr-numbers](../065-scheduler-reserves-spec-and-adr-numbers/spec.md)
AC-1 (no spec number is reserved when the issue has a `Spec:` line), each
marked as section 4 records. The fix result gains an optional `spec_path`
beside spec 060's `out_of_scope`. *(agent's call)*
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 ("every other blocker is resolved by agents"), section 6.2 (a
reviewed PR for every change to repository content; the scheduler's own
actions within limits that already exist) and section 11;
[006-no-human-stops](../006-no-human-stops/spec.md) AC-21 (the spec stage's
contract and the spec PR's scope, amended here) and AC-22 (the spec PR's
diff is gated, on a spec result and on a fix);
[065-scheduler-reserves-spec-and-adr-numbers](../065-scheduler-reserves-spec-and-adr-numbers/spec.md)
AC-1 (the reservation, amended here), AC-3 (the number checks this spec
reuses for a move) and section 2 (which leaves the renaming of a spec after
its `Spec:` line is written to this issue);
[060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
AC-5 (the fix result's last optional field, the precedent for this one);
[specs/README.md](../README.md) ("numbered sequentially"; "a number is not
reused"; the issue links its spec with a `Spec:` line).

## 1. Goal

Once a spec PR is open, a review that asks for another slug, or a number
that `main` or another PR took first, can be acted on: the stage moves the
spec directory in the PR, says where the spec now is, and the scheduler
checks the move, rewrites the issue's `Spec:` line and judges the PR's scope
at the new path. No stage edits the issue body.

### What is wrong today

- `specEvent` (`tools/scheduler/src/chain/driver.ts`) fails a spec result
  whose `spec_path` differs from the issue's `Spec:` line (spec 006 AC-21),
  and appends the line only when the issue has none, so the line, once
  written, never changes.
- The fix result (`schemas/scheduler/fix-result.json`) has no `spec_path`.
  `codeEvent` judges a spec-track fix with
  `specTrackScope(…, specPathFromIssueBody(issueBody))`, which reads the spec
  from the worktree at the issue's path; after a rename the read returns
  `""`, the parent is unknown, and `specScopeGate` reports
  `<old path>: no Parent line` and every other changed file as
  `outside spec PR scope`.
- Spec 065 AC-1 reserves no spec number for an issue that has a `Spec:`
  line, so a stage that must renumber has no number it may take.
- Issue #41 is the record: its spec PR took `specs/030-design-files-children`,
  `specs/030-beyond-github` merged first, the review required 031, the fix
  renamed the directory and the scope gate reported exactly the three
  violations above; the fix loop and the spec-track rescue were spent and
  the issue was abandoned. Its body now reads
  `Spec: specs/031-design-files-children/spec.md`, written by a stage.

### The fix

1. **The result names the path** (AC-2, AC-3). A spec result's `spec_path`,
   and a new optional `spec_path` on the fix result, may name a path other
   than the issue's `Spec:` line on the spec track, while the spec is not on
   `main`. The scheduler checks the move (AC-2): the old directory is gone
   from the branch, the new one holds the spec, the number is the old one or
   the reserved one, and nothing else holds it. Then it replaces the line in
   the issue body and judges scope at the new path.
2. **A held number gets a reservation** (AC-1). When the issue's spec is not
   on `main` and its number is held by `main`, another open PR or another
   claim, the driver reserves a spec number for the spec or spec-track fix
   run, as spec 065 does for an issue without a line, and the stage moves
   the spec to it.
3. **The prompts say so** (AC-5). The fix and spec prompts say how to move
   a spec, what to update with it, and that the issue body is the
   scheduler's.

*(agent's call)* The result names the path, rather than the scheduler
finding the move with git's rename detection, because a stage that moves a
spec knows where it put it, while rename detection is a similarity guess
that also fails when the move rewrites most of the spec (the heading's
number, the links). The scheduler still checks the branch, not the claim:
AC-2 reads the worktree. The number of a renumbering comes from a
reservation made only when the number is held, so a spec-track fix that
moves nothing reserves nothing and leaves no gap in the sequence, and two
chains renumbering at once get two numbers (spec 065's reason for
reserving at all). The spec stays fixed once it is on `main`: a landed
spec's number and slug are cited by other specs, ADRs and issues, and
`specs/README.md` says a number is not reused, so moving one is a new spec,
not a move. Every choice here is one PR to reverse; nothing is a design
section 3 question, so there is no ADR.

## 2. Out of scope

- Why numbers collide in the first place: spec 065 (issue #125).
- Moving a spec that is on `main` (a `revise` of a landed spec, the design
  stage's spec, an issue-track fix): refused as today (AC-3).
- The design stage's result: its `spec_path` must still equal the issue's
  line (spec 029 AC-2); a design PR runs after the spec has merged.
- Rewriting the PR's title or body after a move, and updating references to
  the old path outside the PR (comments, other issues): the old path never
  reached `main`.
- Detecting or reverting an issue body that a stage edited itself. The
  prompts say the body is the scheduler's (AC-5); the line is read from the
  body as today.
- Changing the sensitive-path list, the security review criteria or
  instructions, or what routes a sensitive diff to the security review.
  `tools/scheduler/`, `agents/`, `schemas/`, `docs/delivery-system-design.md`
  and the marked specs are sensitive paths, so the security review runs on
  this spec PR and on the implementation PR.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the recorded
worlds of `tools/scheduler/test/helpers/e2e-routes.ts`, where it says so;
otherwise the driver functions named in section 5 with the fake client and a
fixture repository.

Definitions. The *line path* is the path the issue body's `Spec:` line names
(`specPathFromIssueBody`). A spec is *on main* when `origin/main` holds any
file under its directory (`git ls-tree -r --name-only origin/main --
<dir>/` is not empty; a split's directory holds only `README.md`). A *move*
is a spec result with verdict `revised`, or a fix result with a `head_sha`,
whose `spec_path` is present and differs from the line path. The *holders*
and the *next free number* are spec 065's.

- AC-1. **A held number is reserved before a spec or spec-track fix run.**
  Given a claim entering the spec stage (any mode), or the fix stage on the
  spec track, for an issue whose line path is not on main and whose
  `reserved.spec` is null, when the driver prepares the run (spec 065
  AC-1's step, under the same lock), then given the line path's number is
  held by `origin/main`, an open PR other than the chain's own, or another
  claim's reservation, it reserves the next free spec number, writes it to
  `reserved.spec`, logs `{ kind: "number-reserved", issue, spec: NNN }` and
  gives it as `spec_number`; given the number is held by none of them, then
  nothing is reserved and `spec_number` is `(none)`. Given `reserved.spec`
  is already set, then it is given again. Given the line path is on main,
  then nothing is reserved, as today. A read of the open pull requests that
  fails postpones the run as spec 065 AC-1 says.
- AC-2. **The move checks.** Given a move, when the scheduler checks the
  result, then the run is a failed run with the first reason that applies,
  in this order, and the issue body is unchanged:
  1. the chain is not on the spec track: `result: spec_path differs from the
     issue's Spec: line` (today's reason);
  2. the line path is on main: `result: the spec at <line path> is on main
     and cannot move`;
  3. the worktree at HEAD holds a file under the line path's directory:
     `result: spec moved to <spec_path> but <old dir>/ still holds files`;
  4. the worktree at HEAD holds neither `spec.md` nor `README.md` (a split,
     spec 031 AC-9) in the directory of `spec_path`: `result: no spec at
     <spec_path>`;
  5. the number of `spec_path` is neither the line path's number nor
     `reserved.spec`: `result: spec number NNN is not the issue's MMM or the
     reserved RRR` (`(none)` when nothing is reserved);
  6. the directory of `spec_path` has a number held by `origin/main`,
     another open PR or another claim: spec 065 AC-3's `result: spec number
     NNN is held by <holder>`, from the same `heldNumberReason` check with
     the `spec` kind included.
  A `spec_path` outside `specs/NNN-<slug>/spec.md` is refused earlier by the
  result's schema (`result: invalid`), on both results.
- AC-3. **A spec result may move its spec** (spec 006 AC-21, amended).
  Given a spec result with verdict `revised` whose `spec_path` differs from
  the line path, when `specEvent` checks it, then in place of today's
  `spec_path differs` failure the AC-2 checks run (2 to 6; the spec stage is
  always on the spec track), after the `pr mismatch` and closing-keyword
  checks and before the marks and scope checks; given they pass, then after
  the other checks the scheduler replaces the line in the issue body (AC-4)
  and judges scope at `spec_path`. Given the issue has no line, then spec
  065 AC-3 applies unchanged. Given `spec_path` equals the line path, then
  nothing changes.
- AC-4. **The scheduler rewrites the line.** Given a move that passed AC-2
  and the result's other checks, then the scheduler replaces the `Spec:`
  line in the issue body with `Spec: <spec_path>` (`withSpecPath(body,
  path)`, which keeps every other byte of the body), writes it with
  `setIssueBody`, logs `{ kind: "spec-moved", issue, from: <line path>, to:
  <spec_path> }` and clears `reserved.spec`. This happens whether or not the
  scope check then passes: the branch holds the spec at the new path, and
  the fix for any violation is judged there. Given the write throws, then
  the step fails as any GitHub write does and the kept result is checked
  again (spec 015 AC-10); the second check finds either the old line (and
  writes again) or the new one (and finds no move).
- AC-5. **A fix result may move its spec.** Given a fix result with a
  `head_sha` and a `spec_path` (new, optional, the same pattern as the spec
  result's), when `codeEvent` checks it, then given `spec_path` is absent or
  equals the line path, nothing changes. Given it differs, then after the
  `pr mismatch` check and before the ADR check, the AC-2 checks run (1 to
  6); given they pass, then the remaining checks run as today, AC-4
  rewrites the line, and `specTrackScope` judges the PR at `spec_path`
  (with the spec's `Parent:` read from the new path), as does spec 060's
  `judgeOutOfScope` for any later out-of-scope verdict, which reads the
  rewritten line.
- AC-6. **The prompts.** Given `agents/stages/fix.md`, then it has a
  paragraph **Moving the spec.** saying: on a spec pull request whose spec
  must move (a review asks for another slug, or the spec's number is held
  elsewhere and the scheduler reserved `{{spec_number}}`), move the
  directory with `git mv` to `specs/<number>-<slug>/` (the spec's own
  number, or `{{spec_number}}` when it is not `(none)`; no other), update
  every reference to the old path inside the PR (the parent's `## Children`
  bullet, the spec's heading, ADRs and marks the PR adds), and add
  `"spec_path"` beside `head_sha` naming the new path; never edit the issue
  body, which the scheduler rewrites. Its result line shows the optional
  field. Given `agents/stages/spec.md`, then `write` mode says the spec lives
  at the `Spec:` line's path unless the scheduler reserved a number while
  the issue has a line, which it does only when that path's number is held
  elsewhere: then the spec moves to `specs/{{spec_number}}-<slug>/spec.md`;
  and the sentence after the result shapes says `spec_path` equals the
  issue's `Spec:` line unless the spec moved in this PR, when it names the
  new path and the scheduler rewrites the line. Neither prompt asks a stage
  to edit an issue body.
- AC-7. **Live cases end to end.** Recorded worlds drive and assert:
  - issue #41's sequence: an issue on the spec track with line
    `specs/030-x/spec.md` and an open spec PR adding it; `main` gains
    `specs/030-other/`; the next spec-track fix run's input has
    `spec_number: "031"` and the claim file carries the reservation; the
    fake fix moves the directory to `specs/031-x/`, updates the parent's
    Children bullet and returns `spec_path: "specs/031-x/spec.md"`; then the
    scope result is ok, the issue body's line reads `Spec:
    specs/031-x/spec.md` with the rest of the body unchanged, the log has
    the `spec-moved` line and `reserved.spec` is null;
  - a slug-only move on a free number (`specs/072-a` to `specs/072-b`, no
    reservation): the same outcome without a `number-reserved` line;
  - a fix that renames to `specs/033-x/` while the reservation is 031: the
    AC-2 item 5 failure, and the issue body still names `030-x`;
  - a fix that copies instead of moving (both directories at HEAD): the
    AC-2 item 3 failure;
  - a spec-stage `revise` whose result names a new path while the line path
    is on main: the AC-2 item 2 failure;
  - a spec-track fix on a spec whose number nothing else holds: no
    reservation, `spec_number` `(none)` in the input.
  The spec 006, 015, 031, 060 and 065 chain tests pass unchanged.

## 4. Marks on specs 006 and 065

- Spec 006 AC-21 is marked, after `AC-21.` and before spec 065's mark,
  `Amended by [071-spec-pr-moves-its-spec](../071-spec-pr-moves-its-spec/spec.md)
  AC-3: on the spec track a spec or fix result may name a spec_path other
  than the issue's Spec: line while the spec is not on main, and the
  scheduler then checks the move and rewrites the line.`
- Spec 065 AC-1 is marked, after `AC-1.`, `Amended by
  [071-spec-pr-moves-its-spec](../071-spec-pr-moves-its-spec/spec.md) AC-1:
  a spec or spec-track fix run also reserves a spec number when the issue's
  Spec: line names a spec not on main whose number another holder holds.`

The earlier text stays as the record.

## 5. Interfaces and files

- `tools/scheduler/src/spec/link.ts`: `withSpecPath(body, path)`, the body
  with its `Spec:` line replaced (the same `SPEC_LINE` match).
- `tools/scheduler/src/chain/driver.ts`:
  - `reserveNumbers`: the AC-1 condition for the spec number (the line
    path's number checked with `collisions` against `holders` excluding the
    chain's own PRs);
  - a `specMoveReason(deps, claim, linePath, specPath)` helper for AC-2,
    returning the first reason or null (the on-main read through `git
    ls-tree` in the scheduler's checkout, the worktree reads at HEAD);
  - `specEvent` (AC-3) and `codeEvent` (AC-5) call it, pass the result's
    path to `specTrackScope`, and call a shared `moveSpecLine` for AC-4;
  - `heldNumberReason` is called with the `spec` kind on a move.
- `tools/scheduler/src/types.ts`: `FixResult.spec_path?: string`.
- `schemas/scheduler/fix-result.json`: the optional `spec_path` property,
  with the spec result's pattern, allowed beside `head_sha` only.
- `agents/stages/fix.md`, `agents/stages/spec.md`: the wording of AC-6.
- Tests: `tools/scheduler/test/driver.test.ts` (AC-1 to AC-5 with the fake
  client), `spec.test.ts` (`withSpecPath`), `schema.test.ts` (the fix result
  with and without `spec_path`, a bad pattern refused), `stages.test.ts`
  (the prompt wording), `e2e.test.ts` (AC-7).
- `specs/006-no-human-stops/spec.md` AC-21 and
  `specs/065-scheduler-reserves-spec-and-adr-numbers/spec.md` AC-1: the
  marks of section 4 (this spec PR).
- `docs/delivery-system-design.md`: this spec under `## Children` (this spec
  PR).

`tools/scheduler/`, `agents/`, `schemas/`, `docs/delivery-system-design.md`
and `specs/006-no-human-stops/spec.md` are sensitive paths; the security
review applies to this spec PR and to the implementation PR (spec 006 AC-9).
Nothing here changes the sensitive-path list, the security criteria, what
routes a sensitive diff to the security review, that both reviews must
approve, or that a sensitive path must be listed in the spec. The spec PR's
scope (spec 006 AC-21) keeps its list; only the directory it is judged at
follows the move, and AC-2 refuses a move that leaves the old directory
behind, so a move cannot widen the PR's scope to two spec directories. The
issue body is still written by the scheduler alone.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the tests
  of section 5 added.
- A driver test replays issue #41's violation list on today's code path (a
  spec-track fix renaming `030-x` to `031-x` with no `spec_path`) and gets
  the three violations; with `spec_path` it gets an ok scope and the
  rewritten line (AC-5, AC-7).
- `grep -n "Moving the spec" agents/stages/fix.md` prints a line, and
  `grep -n "edit the issue body" agents/stages/fix.md agents/stages/spec.md`
  prints only the "never edit" wording (AC-6).
- Live check after deploy: the next spec PR whose review asks for a new
  slug or number ends with the service log's `spec-moved` line and the
  issue's `Spec:` line naming the new path; the implement stage's PR or the
  first such issue quotes the line.

## 7. Open decisions

None.
