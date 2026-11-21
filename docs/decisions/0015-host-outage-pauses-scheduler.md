# 0015. A host that cannot work pauses the scheduler; only an issue's own failures spend its bounds

Status: accepted
Date: 2026-11-21
Decided by: the maintainer, as direction given on 2026-11-17 in an interactive
session and recorded in issue #251; carried by
[spec 100](../../specs/100-host-outage-pauses-scheduler/spec.md). Recorded here
by the spec stage because the delivery design's own text is edited by a spec
PR only while recording a product answer (spec 006 AC-21); design section 4
should gain a one-sentence pointer to this ADR in a reviewed PR.
Amends: the reading of design section 4's bounds that
[spec 015](../../specs/015-chain-keeps-its-work/spec.md) made as its own
("those bounds are meant to count failures of the work, not of the
infrastructure"), which is now the maintainer's decision.

## Context

The chain's bounds (two attempts per stage, a rescue, a re-plan, a spec
revision, then abandonment) protect the system from work that keeps failing.
Three mechanisms spent them, or dropped a claim, for failures no issue caused:
spec 015's 24-hour outage ceiling counted a laptop's network outage against
issue #101 and abandoned it (2026-11-12); the liveness gate read a 46-hour
sleep as an idle chain and released issue #15 (2026-10-31); the verify
pending bound would spend a fix run on checks that reported while the
scheduler was down. Each inferred a host-level condition from one issue's
record or from the wall clock.

## Decision

The scheduler must be robust to outages and recover from them efficiently.
There are two kinds of failure, and they get different treatment:

1. **The host cannot work**: no network, the subscription's limit reached,
   the disk full, the laptop off or asleep. Nothing is wrong with any issue.
   The scheduler pauses work, probes for the cause to clear, and resumes as
   soon as it has. No issue's escalation bounds, claim or chain-error release
   are touched, and the maintainer hears once if a pause lasts.
2. **One issue's work is failing**: checks, review, scope, the fix loop. The
   existing escalation path (rescue, re-plan, spec revision, abandonment, the
   filer's re-triage) applies, unchanged.

Only kind 2 may lead to abandonment.

The decision to pause is made by a host probe (resolve and reach GitHub's
hosts; the checked volumes have space), not inferred from one issue's
failures. While the probe fails the scheduler is paused globally: no claims,
no runs, no failure counting, re-probing on a backoff; when it passes, work
resumes. A long pause notifies the maintainer once. An issue that keeps
failing with a network-looking error while the probe passes is that issue's
failure, counted as today with spec 015's ceiling: the ceiling guards against
a revoked token or a bad URL retrying forever, and the probe keeps that guard
without abandoning issues during real outages.

Windows that judge (liveness, verify pending, the age of an outage) count
only time the scheduler was running and not paused. Wall-clock uses that
schedule (quota backoff, standing cadence, reminders, sweep ages) are
unchanged.

Instances of kind 1 that already exist and stay as they are: a quota limit
(specs 013 and 023: `waiting` until `resets_at`, nothing spent, automatic
resume); a transient failure inside a claim's first day (spec 015: not
counted); a run the host refused for want of space (spec 059: not the work's
failure). Spec 100 makes the full disk pause the scheduler through the probe
so that it, too, can never abandon.

## Consequences

- An outage of any length costs no issue its place: on resume every claim is
  where it was, with its PR open and its bounds unspent.
- The per-issue outage record and its ceiling remain for the kind-2 case
  only; the probe decides which case a failure is.
- Later specs that add a wall-clock window must say whether it judges (then
  it subtracts downtime) or schedules (then it does not).
- Failures no probe sees (a pipeline bug that fails every run the same way,
  such as the filer's `spawn E2BIG`) are not covered; reaching the maintainer
  for those is a separate issue.
