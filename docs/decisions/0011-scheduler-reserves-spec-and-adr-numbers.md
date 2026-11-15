# 0011. The scheduler reserves spec and ADR numbers; agents take the number they are given

Status: accepted
Date: 2026-11-15
Amends: [specs/006-no-human-stops](../../specs/006-no-human-stops/spec.md)
AC-21 (the spec stage's contract: the number of `spec_path`)
Decided by: the spec stage of issue #125 (an agent's call: a technical
decision about who assigns the repository's identifiers, reversed by one PR;
delivery-system design section 3 and process-spec 4.2 step 3); carried by
[specs/065-scheduler-reserves-spec-and-adr-numbers](../../specs/065-scheduler-reserves-spec-and-adr-numbers/spec.md)

## Context

Specs are `specs/NNN-<slug>/` and ADRs `docs/decisions/NNNN-<slug>.md`,
numbered sequentially (`specs/README.md`). Until now the agent writing one
picked "the next free number" by reading its worktree, which is
`origin/main`'s listing. Chains run in parallel; three spec PRs created
`specs/030-*` within two hours (issue #125), and a branch added ADR 0006
while another did the same. Once one merged, the others were wrong, and the
chain cannot renumber a spec after its `Spec:` line is written (issue #133).
Issue #41 was abandoned for exactly this.

## Options

1. **The agent checks origin's branches and open PRs before choosing.** A
   read of shared state without a lock: two stages reading within the same
   minute still agree on one number, which is the window the evidence shows.
2. **A number derived from the issue number.** Unique, but the sequence is
   the record (`specs/README.md`: a split's directory keeps its number; every
   spec and ADR cites "spec NNN"), and ADRs have no issue to derive from.
3. **The scheduler reserves the number before the run and checks the
   result.** One process prepares every run in turn, already reads the issue
   body and `origin/main` before each one, and already appends the `Spec:`
   line. The reservation lives in the claim (so a restart keeps it), the
   open PR carries the number once it exists, `main` after the merge. A
   result with another number, or a number another open PR or claim holds,
   fails before the `Spec:` line is written; `pnpm test` fails on a
   duplicate that reaches a branch anyway.

## Decision

Option 3. The scheduler reserves the next free spec number when it prepares
a spec stage run for an issue without a `Spec:` line, and the next free ADR
number when it prepares any spec, implement or fix run, and gives them to the
stage as `{{spec_number}}` and `{{adr_number}}`. The stage takes the number
it is given. A spec result whose number is not the reserved one, or any
result that adds a numbered path another holder has, is a failed run; the
retry gets the same reservation. A duplicate number under `specs/` or
`docs/decisions/` fails the test suite.

## Consequences

- Spec numbers are unique across parallel chains without any agent reading
  another agent's branch; the "next free number" rule leaves the prompts.
- An ADR reservation not used by its run is released when the result is
  handled, so the ADR sequence has no gaps from reservations alone. A spec
  reservation of an abandoned chain is released with its claim.
- A PR the scheduler did not make is seen while it is open; one that opens
  after a chain's result check and lands first is caught by the suite on the
  chain's rebased branch, and reaches the fix stage as a failed check. When
  the colliding path is the spec directory itself the fix still cannot
  rename it until issue #133 lands.
- Spec 006 AC-21 is amended: the `Spec:` line is appended only after the
  number checks pass.
