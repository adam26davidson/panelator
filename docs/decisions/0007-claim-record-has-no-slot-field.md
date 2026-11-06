# 0007. The claim record has no `slot` field

Status: accepted
Date: 2026-11-06
Amends: [specs/001-scheduler-core](../../specs/001-scheduler-core/spec.md)
section 11 (the state-directory table lists `slot` among the claim's fields)
Decided by: the spec stage of issue #55 (an agent's call: a decision with one
clearly right answer, delivery-system design section 3); carried by
[specs/034-claim-drops-slot-field](../../specs/034-claim-drops-slot-field/spec.md)

## Context

Spec 001 listed `slot` among the fields of `claims/<issue>.json`, and the
scheduler has written it since: the claim's `slot` is set to the size of the
in-process active set at the moment the claim is written. That value is not
a slot number (two claims written while one chain runs both carry `slot: 1`)
and it is never updated. No code reads it. Since spec 009 the scheduler
counts held slots from the set of claims on disk plus the running standing
agents, so the field describes nothing the scheduler does.

Issue #55 (filed from findings of three stages of issue #17, each of which
stopped on the field while working out how held slots are counted) offers
two fixes: remove the field, or define a slot identity properly.

## Decision

Remove the field. The claim record has no `slot`; spec 034 carries the
change. A claim file that already carries the field is read as before and
loses it on its next write.

## Reasons

- Nothing wants a slot identity. Slots are a count (`slots` in the
  configuration and parameters) that chains and standing agents fill by
  taking turns (specs 009, 016); no reader, log line or screen names which
  slot a chain holds, and the maintainer console design (delivery-system
  design section 9) shows chains and agents, not slots.
- Defining an identity would add state to keep consistent (assignment at
  claim time, release at claim removal, repair after a crash) for no
  reader, and a wrong definition would mislead in the same way the present
  one does.
- Removal is the smaller change and leaves the record saying only what the
  scheduler uses. If a slot identity is ever wanted, a spec written from its
  reader's needs defines it then.
