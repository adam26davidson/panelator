# 079. Spec 033's re-run proof cancels a run of an earlier commit, not the PR head's

Status: written 2026-11-18 from the delivery-system design for issue #149;
specs derived from that design need no maintainer approval (design section 11).
Amends [033-rerun-workflow-permission](../033-rerun-workflow-permission/spec.md)
AC-3 (the re-run and cancel proof on "a completed workflow run of the PR's own
branch") and section 5 (its last bullet, the run left cancelled); the
implementation PR writes the two marks, as section 4 says. Records what PR #147
already did; no behaviour changes.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (agents resolve every blocker that is not a section
3 question); [033-rerun-workflow-permission](../033-rerun-workflow-permission/spec.md)
AC-3 and section 5 (the text amended);
[039-spec-pr-marks-superseded-text](../039-spec-pr-marks-superseded-text/spec.md)
and [ADR 0009](../../docs/decisions/0009-spec-pr-marks-superseded-text.md)
(the marks, and spec 039 section 2: "a spec may still choose to carry a mark
that way", through its implementation PR).

## 1. Goal

Spec 033's proof of the `actions: write` grant, read as written, cannot leave
the PR it is made on unable to merge.

### What is wrong today

Spec 033 AC-3 has the implementation PR re-run (`201`) and then cancel (`202`)
"a completed workflow run of the PR's own branch", and section 5 checks that
`gh run view <run_id>` shows the run cancelled afterwards. Re-running a run
starts a new attempt of the same run id on the same commit; cancelling it
leaves the run's conclusion `cancelled`, and the check runs of that commit with
it. When the run chosen is the one for the PR's head commit:

- `GitHubClient.checks` (`tools/scheduler/src/github/client.ts`) counts a
  completed check whose conclusion is not `success`, `skipped` or `neutral` as
  failed, so the required `test` check of the head is failed;
- the review stage's CI summary is built from the head sha's check runs
  (`tools/scheduler/src/chain/driver.ts`), and the chain turns a failed required
  check into "A required check failed" fix input
  (`tools/scheduler/src/chain/machine.ts`);
- the PR cannot merge until a further push produces a fresh run.

Nothing in AC-3 says to pick a run of an earlier commit, or to push again
after the proof.

### Where it stands

Spec 033 is implemented: PR #147 merged on 2026-11-05, and issue #53, its
implementation issue, is no longer open (the issue's report that it is open
predates the merge). Its proof avoided the
flaw by chance of order: the run it used, 42104785369, is the `ci` run of the
branch's first commit `0ba6a3ff`, and the PR's head `fe613dfc` kept its own
green `test` run (`gh api /repos/{owner}/{repo}/actions/runs/42104785369`
reports `head_sha` `0ba6a3ff…`, `conclusion` `cancelled`, `run_attempt` 2).
So nothing shipped is wrong and nothing needs undoing. The text still reads as
current and is what an agent would follow if the proof were made again (a
re-grant after the permission is withdrawn, or a later permission proved the
same way), so it is corrected to say what #147 did.

### The fix

Two marks on spec 033, saying which run the proof uses and that the PR head
keeps a run of its own:

- the run re-run and cancelled is a completed run of a commit of the PR's
  branch other than the head the PR is reviewed and merged at;
- when the branch has only the head's run, the stage pushes one further
  commit after the proof, so the head the PR is reviewed at has a fresh run;
- section 5 checks both: the cancelled run's `head_sha` is not the PR head,
  and the head's required `test` check is green.

## 2. Out of scope

- Spec 033's other criteria and sections, PR #147, ADR 0006, spec 001 section
  12 and `agents/actions.yaml`: unchanged. The grant is live and recorded.
- How the review stage builds its CI summary, which conclusions count as
  failed, and the fix input a failed required check produces (specs 001 and
  006): unchanged. A cancelled required check is a failed one, rightly.
- The order in AC-3's 403 branch ("the PR is not opened"): `ci.yml` runs on
  `pull_request`, so a branch has a run only once its PR is open. PR #147
  opened the PR first; with spec 033 implemented the point is moot and this
  spec does not reword it.
- The `rerun_workflow` action itself (spec 008 AC-8) and its undo, which
  cancels the run it re-ran: an agent that re-runs a run means to, and the
  infra health agent's use of it is its own spec.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the PR branch, read as text; "then" clauses
are checked by reading them and by `pnpm test` where it says so.

- AC-1. **AC-3 of spec 033 names a run that is not the head's.** Given
  `specs/033-rerun-workflow-permission/spec.md` after the implementation PR,
  then AC-3 carries, after `AC-3.` and before its bold title, the mark
  `Amended by [079-rerun-proof-spares-head-run](../079-rerun-proof-spares-head-run/spec.md) AC-1:`
  followed by one clause stating that the run re-run and cancelled is of a
  commit of the PR's branch other than its head, and that when only the
  head has a run the stage pushes one further commit after the proof; the
  clause ends with a full stop. The rest of AC-3 follows the mark unchanged.
  In this spec, that clause is what applies: the proof's run is a completed
  run of an earlier commit of the PR branch, and the head the PR is reviewed
  and merged at has a run of its own that the proof did not touch.
- AC-2. **Section 5 of spec 033 checks the head's run.** Given the same file,
  then directly under the heading `## 5. Verification` there is a block quote
  reading `Amended by [079-rerun-proof-spares-head-run](../079-rerun-proof-spares-head-run/spec.md) AC-2:`
  followed by one clause stating that the cancelled run's `head_sha` is not
  the PR head and that the head's required `test` check is green; the
  section's bullets follow unchanged. In this spec, that is what applies:
  besides the two quoted responses, `gh api /repos/{owner}/{repo}/actions/runs/<run_id>`
  shows a `head_sha` other than the PR's head and `gh pr checks <pr>` shows
  `test` passing on the head.
- AC-3. **Nothing else changes.** Given the implementation PR's diff, then it
  touches `specs/033-rerun-workflow-permission/spec.md` only, and in it adds
  the two marks of AC-1 and AC-2 and nothing else: no other line of the file
  differs from `main`. It changes no text marked `(maintainer answer,
  question #<id>)` (spec 033's status line keeps its mark), nothing under
  `docs/`, `tools/`, `agents/`, `.github/` or `schemas/`, and no gate, bound
  or label rule of specs 001 and 006 (security criterion 5).
- AC-4. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root, then it passes: the spec-present gate and the
  design-tree check accept spec 033 and this spec.

## 4. Interfaces and files

No code, schema or prompt changes.

The spec PR adds `specs/079-rerun-proof-spares-head-run/spec.md` and lists it
under `## Children` in `docs/delivery-system-design.md`.

The implementation PR edits exactly one file:

- `specs/033-rerun-workflow-permission/spec.md`: the mark of AC-1 on AC-3 and
  the block quote of AC-2 under section 5's heading.

The marks are written by the implementation PR, not the spec PR, which spec
039 section 2 allows: the amendment is text only, so the marks are the whole
of the change, and carrying them in the spec PR would leave the implementation
chain of issue #149 with no diff to open its PR from.

Suggested wording (the implementer may tighten it, keeping AC-1's and AC-2's
content):

> - AC-3. Amended by [079-rerun-proof-spares-head-run](../079-rerun-proof-spares-head-run/spec.md) AC-1: the run is a completed run of a commit of the PR's branch other than its head, and when only the head has a run the stage pushes one further commit after the proof. **The grant is proven on a real run.** Given the implementation PR, ...

> ## 5. Verification
>
> > Amended by [079-rerun-proof-spares-head-run](../079-rerun-proof-spares-head-run/spec.md) AC-2: the cancelled run's `head_sha` is not the PR head, and the head's required `test` check is green.

`specs/033-rerun-workflow-permission/spec.md` is not a sensitive path
(`agents/sensitive-paths.txt` lists specs 001 and 006 only), so the ordinary
review applies to the implementation PR. This spec plans no change to the
charter, to a protected maintainer decision, to the sensitive-path list, to
the security review criteria or instructions, or to what decides that a
sensitive diff gets the security review, that both reviews must approve, or
that a sensitive path must be listed in the spec.

## 5. Verification

- `pnpm test` from the repository root passes (AC-4).
- `git diff main --stat` on the implementation PR lists
  `specs/033-rerun-workflow-permission/spec.md` and no other file, and
  `git diff main -- specs/033-rerun-workflow-permission/spec.md` shows only
  added text: the mark inside the AC-3 line and the block quote with its
  blank line under `## 5. Verification` (AC-3).
- Reading check: `grep -n "079-rerun-proof-spares-head-run" specs/033-rerun-workflow-permission/spec.md`
  finds exactly two lines, one starting `- AC-3. Amended by` and one starting
  `> Amended by` directly under the section 5 heading (AC-1, AC-2); each link
  points to this file.

## 6. Open decisions

None.
