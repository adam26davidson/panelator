# 065. The scheduler reserves spec and ADR numbers, and a duplicate number fails the result and the test suite

Status: written 2026-11-15 from the delivery-system design for issue #125;
specs derived from that design need no maintainer approval (design section 11).
Amends [006-no-human-stops](../006-no-human-stops/spec.md) AC-21 (the spec
stage's contract: the number of `spec_path` is the one the scheduler reserved
and collides with nothing before the `Spec:` line is written), marked as
section 4 records. Decision recorded in
[ADR 0011](../../docs/decisions/0011-scheduler-reserves-spec-and-adr-numbers.md).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 ("every other blocker is resolved by agents"), section 6.2 (a
reviewed PR for every change to repository content; the scheduler's own
actions within limits that already exist), section 10 (the design hierarchy
the design-tree check enforces; "Small work skips layers") and section 11;
[process-spec](../../docs/process-spec.md) 4.2 step 3 (an agent's decision
recorded as an ADR); [001-scheduler-core](../001-scheduler-core/spec.md)
section 6 (the stage prompt and its placeholders) and section 8 (the gates
`pnpm test` runs); [006-no-human-stops](../006-no-human-stops/spec.md) AC-21
(the spec stage's contract, amended here) and AC-22 (the spec PR's scope);
[031-design-files-children](../031-design-files-children/spec.md) section 2
("a child's spec takes the next free number when its spec stage runs", which
this spec keeps: the number is taken when the stage runs, by the scheduler);
[specs/README.md](../README.md) ("numbered sequentially"; a split's number
"is not reused").

## 1. Goal

Two chains that write specs at the same time land two different spec numbers,
and two runs that record ADRs at the same time land two different ADR
numbers, without any agent reading another agent's branch. The one process
that sees every chain, the scheduler, hands out the numbers; a result that
takes a number the scheduler did not reserve, or one that another open PR or
`main` already holds, is a failed run before anything is pinned; and a
duplicate that still reaches a branch fails `pnpm test`, so it cannot merge.

### What is wrong today

- `agents/stages/spec.md` line 50 tells the spec stage to create
  `specs/NNN-<slug>/spec.md` "with the next free number". The stage reads
  `specs/` in its worktree, which is `origin/main`'s listing (spec 006 AC-21:
  `spec-<issue>` is created from `origin/main`). Chains running in parallel
  before any of them merges all read the same listing and all pick the same
  number: issues #39, #40 and #41 each created a `specs/030-*` directory
  within two hours (findings refs 790, 792, 798 and 814). Issue #49 took 031.
- Once two merge, every "spec 030" reference in specs, ADRs, issue bodies and
  the design's `## Children` lines is ambiguous, and the third branch
  conflicts on rebase or lands a third 030. Issue #41's review required a
  renumbering, which the chain could not carry out (issue #133), and the
  issue was abandoned.
- Nothing checks the number. `specTrackScope`
  (`tools/scheduler/src/chain/driver.ts`) checks paths against the spec PR's
  allowed list, not whether the number is held elsewhere; the spec review
  criteria (`agents/profiles/spec/review-criteria.md`) say nothing about
  numbering, and a reviewer cannot see other open branches anyway;
  `checkDesignTree` (`tools/scheduler/src/gates/design-tree.ts`) accepts two
  `specs/030-*` directories as two children.
- ADR numbers have the same flaw. `docs/decisions/` is numbered `NNNN`, the
  spec, implement and fix stages each add ADRs (`agents/stages/spec.md`,
  `implement.md` lines 42 to 43, `fix.md` lines 46 and 53), and issue #40's
  branch added `0006` while `main` ended at 0005 and another branch was
  adding 0006 too.

### The fix

1. **The scheduler reserves the number before the run** (AC-1, AC-2). When
   the driver prepares a spec stage run for an issue whose body has no
   `Spec:` line, it reserves the next spec number: one more than the largest
   number among `specs/` on `origin/main`, the `specs/NNN-*` directories any
   open pull request adds, and the spec numbers the other live claims hold.
   When it prepares any spec, implement or fix run, it reserves the next ADR
   number the same way (`docs/decisions/NNNN-*.md`). The reservations are in
   the claim, so every claim sees every other claim's; the scheduler is one
   process and prepares runs one at a time, so two claims never hold the
   same number. The stage input carries them and the prompts say: the spec
   is `specs/{{spec_number}}-<slug>/spec.md`; an ADR you add is
   `docs/decisions/{{adr_number}}-<slug>.md`.
2. **A result that takes a wrong or held number fails** (AC-3, AC-4). When a
   spec result's `spec_path` has a number other than the reserved one, or
   the branch adds a `specs/NNN-*` or `docs/decisions/NNNN-*` whose number
   `origin/main`, another open PR or another claim holds, the run is a
   failed run with a reason naming the number and the holder, before the
   `Spec:` line is written. The same check runs on implement and fix results
   for ADRs. The retry (spec 006 AC-21's second attempt in the same mode,
   with the reason in its history) picks the number the input gives it.
3. **A duplicate on a branch fails the suite** (AC-5). `pnpm test` fails
   when two directories under `specs/` share a number or two files under
   `docs/decisions/` share one. A chain's PR is rebased onto `main` before
   verify (spec 024), so a duplicate created by a PR the scheduler did not
   make, or by a race the first two layers did not see, fails the PR's
   required check and goes to the fix stage as any failed check does.

*(agent's call)* The number comes from the scheduler, not from the agent
checking origin's branches, because a check by the agent is a read of shared
state with no lock: two stages reading within the same minute still agree on
the same number, which is exactly the two-hour window the evidence shows. The
scheduler already serialises every chain's preparation, already reads the
issue body and `origin/main` before each run (`runAgentStage`), and already
appends the `Spec:` line (spec 006 AC-21), so it is the one place a
reservation is both race-free and durable (the claim survives a restart; the
open PR carries the number once it exists; `main` carries it after the
merge). Deriving the number from the issue number was weighed and rejected:
`specs/README.md` and spec 001 section 10 make the numbers sequential, every
landed spec and ADR cites "spec NNN", and a split's directory keeps its
number (README) so the sequence is also the record of what was planned. The
rule is small and one PR reverses it; the ADR records it because it changes
who assigns identifiers that every spec, ADR and issue body cites.

## 2. Out of scope

- Renaming or renumbering a spec after its `Spec:` line is written: issue
  #133. This spec fails a wrong number before the line is written, so the
  renumbering #133 describes is not needed for a collision the pipeline
  itself creates; a collision with a hand-authored PR that lands after the
  chain's result check still reaches the fix stage through AC-5's failing
  check and, when the colliding path is the spec directory, meets #133's
  limit as today.
- A criterion on numbering in `agents/profiles/spec/review-criteria.md`. The
  review runs in the spec PR's worktree and cannot see other open branches;
  AC-3 and AC-5 check what the review cannot.
- Pre-assigning numbers to planned children at design time: spec 031 section
  2 rules it out and this spec keeps that rule. The number is reserved when
  the child's spec stage runs.
- Renumbering the existing specs or ADRs, or the numbers held by abandoned
  branches on origin (`spec-40`'s `030-test-board` is behind `main`'s
  `030-beyond-github`; a retry of that work starts from `origin/main` and
  takes a fresh reservation).
- Numbers for anything else (dev-logs, research files): nothing else in the
  repository is numbered by agents in parallel.
- Changing the sensitive-path list, the security review criteria or
  instructions, or what routes a sensitive diff to the security review.
  `tools/scheduler/`, `agents/`, `docs/delivery-system-design.md` and
  `specs/006-no-human-stops/spec.md` are sensitive paths, so the security
  review runs on this spec PR (for the mark on spec 006) and on the
  implementation PR.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the recorded
worlds of `tools/scheduler/test/helpers/e2e-routes.ts`, where it says so;
otherwise the pure functions named in section 5 with fixture inputs.

Definitions. A *numbered path* is a directory `specs/NNN-<slug>/` (three
digits) or a file `docs/decisions/NNNN-<slug>.md` (four digits). The *holders*
of a number, for a kind (spec or ADR), are: the numbered paths of that kind on
`origin/main`; the numbered paths of that kind added (`status: added`) by any
open pull request of the repository, read from the GitHub pull request files
API; and the reservation of that kind in every claim other than the one being
prepared or checked. The *next free number* of a kind is one more than the
largest number among its holders (the largest, not the smallest gap: a split's
directory keeps its number, README). A reservation is `{ spec: number | null,
adr: number | null }` on the claim state (`ChainState.reserved`), kept in the
claim file like every other field.

- AC-1. **The spec number is reserved before the spec stage runs.** Given a
  claim entering the spec stage (any mode) for an issue whose body has no
  `Spec:` line and whose `reserved.spec` is null, when the driver prepares the
  run, then it computes the next free spec number, writes it to
  `reserved.spec`, logs `{ kind: "number-reserved", issue, spec: NNN }` and
  gives it to the stage as `spec_number` (`"065"`, zero-padded to three
  digits) in the stage input and the `{{spec_number}}` placeholder. Given
  `reserved.spec` is already set (a retry, a resumed question, a `revise`),
  then the same number is given again and nothing new is reserved. Given the
  issue body has a `Spec:` line, then no spec number is reserved and
  `spec_number` is `(none)`: the path is the line's. Given two claims are
  prepared in the same tick, then the second sees the first's reservation
  and takes the next number. Given a read of the open pull requests fails,
  then the run is postponed as a transient failure (spec 045's rule for a
  GitHub read, `postpone: true`) and nothing is reserved: a number guessed
  without the open PRs is the fault this spec removes.
- AC-2. **An ADR number is reserved before every run that may add one.**
  Given a claim entering the spec, implement or fix stage, when the driver
  prepares the run, then it computes the next free ADR number, writes it to
  `reserved.adr`, logs `{ kind: "number-reserved", issue, adr: NNNN }` and
  gives it as `adr_number` (`"0011"`, four digits) and `{{adr_number}}`.
  Given `reserved.adr` is already set, then it is given again. Given the
  run's result is handled (`stage_ok` or `stage_failed`, any stage), then
  `reserved.adr` is cleared unless the branch adds a `docs/decisions/` file
  and the claim has no open PR yet (a spec stage's question with held work):
  then it is kept until the PR exists. An unused ADR number is therefore
  free again for the next run, and the ADR sequence has no gaps from
  reservations alone.
- AC-3. **A spec result with a wrong or held number fails before the `Spec:`
  line is written** (spec 006 AC-21, amended). Given a spec result with
  verdict `revised` for an issue without a `Spec:` line, when `specEvent`
  checks it, then after the `pr mismatch` and closing-keyword checks and
  before the scope check and the `setIssueBody` call: given the number in
  `spec_path` is not `reserved.spec`, then the run fails with
  `result: spec number NNN is not the reserved MMM`; given any numbered path
  the branch adds (`git diff --diff-filter=A --name-only origin/main...HEAD`,
  directories of added `specs/*/spec.md` and `specs/*/README.md`, files
  under `docs/decisions/`) has a number held by `origin/main`, another open
  PR or another claim, then the run fails with `result: spec number NNN is
  held by <holder>` or `result: ADR NNNN is held by <holder>`, where the
  holder is the path on `main`, `PR #<n>` or `issue #<n>`'s reservation. The
  issue body is unchanged in both cases, so the retry (spec 006 AC-21's
  second attempt) runs in the same mode with the reason in its history and
  the reservation in its input. Given the numbers agree and collide with
  nothing, then the `Spec:` line is appended as today and `reserved.spec`
  is cleared (the issue body and the open PR now hold the number).
- AC-4. **An implement or fix result that adds a held ADR number fails.**
  Given an implement or fix result with a PR, when `codeEvent` checks it,
  then after the `pr mismatch` check and before the scope check, an added
  `docs/decisions/NNNN-*.md` whose number is held by `origin/main`, another
  open PR or another claim's reservation fails the run with `result: ADR NNNN
  is held by <holder>`; the fix stage's failure follows spec 006's fix rule
  as any failed fix does, with the reason. Given the added ADR's number is
  the reserved one or free, then nothing changes in the result's handling.
- AC-5. **A duplicate number fails `pnpm test`.** Given a repository root,
  when `checkUniqueNumbers(root)` runs (new, in
  `tools/scheduler/src/gates/design-tree.ts`), then it returns one error per
  number held by two or more directories under `specs/` (`specs: number 030
  is held by 030-beyond-github and 030-test-board`) and per number held by
  two or more `.md` files under `docs/decisions/` (`docs/decisions: number
  0006 is held by ...`), and an empty list otherwise; a directory or file
  that does not start with the digits is ignored (README.md). The repository
  test that runs `checkDesignTree` over the repository
  (`tools/scheduler/test/design-tree.test.ts`) also asserts
  `checkUniqueNumbers(repoRoot)` is empty, so the required check fails on a
  PR whose rebase onto `main` produces a duplicate.
- AC-6. **The prompts give the number, not the rule to find one.** Given
  `agents/stages/spec.md`, then its `write` mode says the spec lives at the
  issue's `Spec:` path when there is one, otherwise at
  `specs/{{spec_number}}-<slug>/spec.md`, "the number the scheduler reserved
  for this issue; take no other", and the words "the next free number" are
  gone; its ADR guidance, and that of `agents/stages/implement.md` and
  `agents/stages/fix.md`, says an ADR the run adds is
  `docs/decisions/{{adr_number}}-<slug>.md`. `renderPrompt` renders both
  placeholders (`(none)` when the input has none), the stage-input schema
  allows `spec_number` and `adr_number` as strings, and `specs/README.md`
  says the number is reserved by the scheduler when the spec stage runs.
- AC-7. **Live cases end to end.** Recorded worlds drive and assert:
  - two issues without `Spec:` lines claimed in one tick with two slots,
    `main` ending at `specs/064-*`: the first spec run's input has
    `spec_number: "065"`, the second's `"066"`, each claim file carries its
    reservation, and both results (each creating its directory with the
    given number) pass AC-3, append their `Spec:` lines and clear
    `reserved.spec`;
  - a world where an open PR not of the scheduler's making adds
    `specs/065-hand/spec.md`: the next spec run's input has `"066"`;
  - a spec result whose `spec_path` is `specs/065-x/spec.md` while the
    reservation is 066: the run fails with the AC-3 reason, the issue body
    has no `Spec:` line, and the second attempt's input still says `"066"`;
  - a spec run that adds `docs/decisions/0011-*.md` while another open PR
    adds `docs/decisions/0011-other.md`: the AC-3 ADR failure, naming the PR;
  - an implement run adding `docs/decisions/0011-*.md` with the reservation
    0011 and no other holder: the result is handled as today, and
    `reserved.adr` is cleared.
  The spec 006, 015 and 031 chain tests pass unchanged, with the mocked
  pull request files route returning no files by default.

## 4. Mark on spec 006

Spec 006 AC-21 is marked `Amended by
[065-scheduler-reserves-spec-and-adr-numbers](../065-scheduler-reserves-spec-and-adr-numbers/spec.md)
AC-3: before the Spec: line is appended, the number of spec_path must be the
one the scheduler reserved and no numbered path the PR adds may be held by
main, another open PR or another claim; otherwise the result is a failed
run.` Its text stays as the record: "Given it has none, then the scheduler
appends `Spec: <spec_path>` to the issue body" now holds after AC-3's check.

## 5. Interfaces and files

- `tools/scheduler/src/chain/numbers.ts` (new): `numberedPaths(files)` (the
  numbered paths among a file list, by kind), `holders(deps, claims,
  except)` (main's listing via `git ls-tree origin/main`, open PRs' added
  files, other claims' reservations), `nextFree(holders, kind)`,
  `collisions(added, holders)`; all pure but for the two reads, which come
  through `DriverDeps`.
- `tools/scheduler/src/github/client.ts`: `openPullRequestsAddedFiles():
  Promise<{ number: number; added: string[] }[]>` (`GET /pulls?state=open`
  then `GET /pulls/{n}/files`, `status: "added"`), on `DriverDeps.gh`; the
  e2e routes gain the files route, empty by default (AC-7).
- `tools/scheduler/src/chain/types.ts`: `ChainState.reserved: { spec: number
  | null; adr: number | null }` (default both null; `newChain` sets it; the
  claim schema `schemas/scheduler/claim.json` allows it).
- `tools/scheduler/src/chain/driver.ts`: the reservation step in
  `runAgentStage` after `fetchIssue` (AC-1, AC-2); `specEvent`'s checks
  before `setIssueBody` and the clearing of `reserved.spec` (AC-3);
  `codeEvent`'s ADR check (AC-4); clearing `reserved.adr` when a result is
  handled (AC-2). `buildInput` passes `spec_number` and `adr_number`.
- `tools/scheduler/src/stages/prompt.ts`: `StageInput.spec_number`,
  `StageInput.adr_number`, the two placeholders;
  `schemas/scheduler/stage-input.json`: the two string properties.
- `tools/scheduler/src/gates/design-tree.ts`: `checkUniqueNumbers(root)`
  (AC-5); `tools/scheduler/test/design-tree.test.ts`: the repository
  assertion and unit cases.
- `agents/stages/spec.md`, `agents/stages/implement.md`,
  `agents/stages/fix.md`: the wording of AC-6; `specs/README.md`: the
  numbering sentence.
- Tests: `tools/scheduler/test/numbers.test.ts` (new: `nextFree`,
  `collisions`, `numberedPaths`), `driver.test.ts` (AC-1 to AC-4 with the
  fake client), `stages.test.ts` (the placeholders), `schema.test.ts` (the
  input and claim schemas), `e2e.test.ts` (AC-7).
- `specs/006-no-human-stops/spec.md` AC-21: the mark of section 4 (this spec
  PR).
- `docs/decisions/0011-scheduler-reserves-spec-and-adr-numbers.md` (this spec
  PR).
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/`, `docs/delivery-system-design.md` and
`specs/006-no-human-stops/spec.md` are sensitive paths; the security review
applies to this spec PR and to the implementation PR (spec 006 AC-9). Nothing
here changes the sensitive-path list, the security criteria, what routes a
sensitive diff to the security review, that both reviews must approve, or
that a sensitive path must be listed in the spec. The new client call reads
pull requests the App can already read; no permission changes. The issue
body is written where it is written today, by the scheduler alone, and only
after the checks of AC-3.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the tests
  of section 5 added. `checkUniqueNumbers` over the repository is empty on
  the implementation branch (`specs/` has one 065, `docs/decisions/` one
  0011).
- A unit test with two `specs/030-*` fixture directories fails
  `checkUniqueNumbers` with the AC-5 message; a fixture with `030-a` and
  `031-b` passes.
- `grep -n "next free number" agents/stages/spec.md` prints nothing;
  `grep -n "{{spec_number}}" agents/stages/spec.md` and `grep -n
  "{{adr_number}}" agents/stages/spec.md agents/stages/implement.md
  agents/stages/fix.md` each print a line (AC-6).
- Live check after deploy, in the implement stage's PR: with two spec-less
  issues due and two slots, the service log has two `number-reserved` lines
  with consecutive spec numbers, the two spec PRs create different
  directories, and both issues gain `Spec:` lines naming them. The PR quotes
  the lines.

## 7. Open decisions

None.
