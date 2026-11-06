# 034. The claim record drops its `slot` field

Status: written 2026-11-06 from the delivery-system design for issue #55;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (agents resolve their own blockers; a flaw the
filer records is fixed through an ordinary spec);
[ADR 0007](../../docs/decisions/0007-claim-record-has-no-slot-field.md)
(remove the field rather than define a slot identity);
[009-postponed-chain-holds-slot](../009-postponed-chain-holds-slot/spec.md)
section 3 (held slots are counted from the set of claims on disk, never
from a field of one claim) and section 2 (which named the field as out of
scope there); amends [001-scheduler-core](../001-scheduler-core/spec.md)
section 11 (the state-directory table) as section 4 records.

## 1. Goal

A claim file says only what the scheduler uses. Anyone reading
`claims/<issue>.json` to see how slots are held is not misled by a field
that looks like a slot number and is not one.

### What is wrong today

Every claim the scheduler writes carries `slot`, set to the size of the
in-process active set at the moment the claim is written
(`tools/scheduler/src/service/loop.ts`, the claim write in the start step
and the one in the resume of a paused issue). That number is not a slot: two
claims written while one chain runs both get `slot: 1`, a claim written on
an idle tick gets `slot: 0`, and the value never changes afterwards. Nothing
reads it: the `Claim` type declares it, `schemas/scheduler/claim.json`
requires it, thirty-odd test fixtures set it to `0`, and no code path
consults it. Since spec 009 the scheduler counts held slots from the set of
claims on disk plus the running standing agents, so the field has no job.
Three stages of issue #17 each stopped on it while working out how held
slots are counted, which is the cost it imposes.

### The fix

Remove the field: from the `Claim` type, from both writes, from the schema
and from the fixtures. A claim file already on disk that carries `slot` is
still read, and the field is dropped when that claim is next written, so no
migration step and no restart ordering is needed. ADR 0007 records why the
field is removed rather than turned into a real slot identity.

## 2. Out of scope

- How slots are counted and granted (spec 009, spec 016, spec 023): no
  change. The tests of those specs pass before and after.
- A slot identity of any kind. ADR 0007 records that none is wanted today;
  if one is ever wanted, a new spec defines it from its reader's needs.
- Every other field of the claim record, the chain state inside it, and the
  `paused` record: unchanged.
- Any other state file under the state directory, and the service log.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states use a temporary state directory and a mocked GitHub client,
as in `tools/scheduler/test/loop.test.ts`, except where an AC says it reads
files as text.

- AC-1. **A new claim has no `slot`.** Given a free slot and a shortlisted
  issue, when a tick claims it, then the claim file written under `claims/`
  parses as JSON with no `slot` key, and its other fields are as before
  (`issue`, `state`, `worktree`, `started_at`, `last_activity_at`,
  `run_id`).
- AC-2. **A resumed claim has no `slot`.** Given a paused record whose
  question is answered and a free slot, when a tick resumes the issue into a
  claim, then that claim file has no `slot` key.
- AC-3. **The schema does not know the field.** Given an object with every
  required claim field and `slot: 0`, when it is validated as `claim`, then
  validation fails (the schema keeps `additionalProperties: false`, and
  `slot` is neither required nor a property). Given the same object without
  `slot`, then validation passes.
- AC-4. **An older claim file is still read and is cleaned on its next
  write.** Given a claim file on disk written before this spec, carrying
  `slot: 1`, when the scheduler lists or reads claims, then the claim is
  returned with no `slot` property and nothing else changed; when that claim
  is next written (`touchClaim`, or any write through `writeClaim`), then
  the write succeeds and the file on disk has no `slot` key.
- AC-5. **Slot accounting is unchanged.** Given the tests of spec 009 (AC-1
  to AC-6), spec 016 (AC-1 to AC-8) and spec 023 AC-3, when they run after
  the change, then they pass without changes to their expectations, their
  fixtures differing only by the removed `slot` key.
- AC-6. **The type has no field and the code compiles.** Given
  `tools/scheduler/src/state/claims.ts`, then the `Claim` interface declares
  no `slot`; given `pnpm -F @panelator/scheduler typecheck` (or the
  equivalent `tsc --noEmit` in `tools/scheduler/`), then it passes, which
  means no source or test still sets or reads `slot` on a claim.
- AC-7. **The landed text follows.** Given the implementation PR's diff,
  then the `claims/<issue>.json` row of spec 001 section 11 no longer lists
  `slot` and carries a note pointing here, and the spec 009 section 2 bullet
  that names the field carries a note that spec 034 removed it. No other
  line of either spec changes, and no text marked
  `(maintainer answer, question #<id>)` changes anywhere.

## 4. Amendments to earlier specs

- **Spec 001 section 11.** The `claims/<issue>.json` row reads "issue,
  chain state, fixes, worktree, started" (the `slot` entry is gone), with a
  one-line note that spec 034 removed the field.
- **Spec 009 section 2.** The bullet "The `slot` field of the claim record,
  which today stores the size of the active set at claim time rather than a
  slot number; nothing reads it" gains "(removed by spec 034)". The bullet
  stays, as the record of what spec 009 left alone.

## 5. Interfaces and files

- `tools/scheduler/src/state/claims.ts`: the `Claim` interface loses
  `slot`; `parse` drops a `slot` property found in a file read from disk
  (beside the `normalizeChainState` call that already brings older files up
  to date), so `listClaims`, `readClaim` and therefore `touchClaim` satisfy
  AC-4.
- `tools/scheduler/src/service/loop.ts`: the two claim writes (the start
  step's and the paused-resume's) no longer set `slot`. Nothing else in the
  file changes; in particular the held-slot count of spec 009 and the turn
  taking of spec 016 are untouched.
- `schemas/scheduler/claim.json`: `slot` removed from `required` and from
  `properties`; `additionalProperties: false` kept (AC-3).
- `tools/scheduler/test/`: every fixture that sets `slot: 0` on a claim
  (`loop.test.ts`, `state.test.ts`, `schema.test.ts`, `chain.test.ts`,
  `driver.test.ts`) drops it. New tests for AC-1, AC-2 (in `loop.test.ts`),
  AC-3 (in `schema.test.ts`) and AC-4 (in `state.test.ts`: a file with
  `slot` written directly to the claims directory, then read and touched).
- `specs/001-scheduler-core/spec.md` section 11 and
  `specs/009-postponed-chain-holds-slot/spec.md` section 2: the amendments
  of section 4 (AC-7).

The spec PR itself adds `specs/034-claim-drops-slot-field/spec.md` and
`docs/decisions/0007-claim-record-has-no-slot-field.md`, and lists this spec
under `## Children` in `docs/delivery-system-design.md`.

`tools/scheduler/` and `specs/001-scheduler-core/spec.md` are sensitive
paths (`agents/sensitive-paths.txt`); the security review applies to the
implementation PR (spec 006 AC-9). The change touches no gate, bound, label
rule or permission: it removes an unread field from a state file and the
schema that describes it.

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-1, AC-2 and AC-4 tests fail on `main` (the written file carries
  `slot`; a claim read from disk still has it) and pass after the change.
  The AC-3 test fails on `main` (the schema accepts `slot`) and passes after.
- `grep -rn "slot:" tools/scheduler/src tools/scheduler/test` finds no claim
  field named `slot` (the `slots` configuration and parameter keep their
  name and are not matched by `slot:`).
- `grep -n "slot" schemas/scheduler/claim.json` finds nothing.
- `git diff main -- specs/001-scheduler-core/spec.md specs/009-postponed-chain-holds-slot/spec.md`
  shows only the two amended passages of section 4 (AC-7).
- Live check after deploy: the first claim the deployed scheduler writes has
  no `slot` key, and a claim that predates the deploy is touched by a later
  step without a validation error in the service log.

## 7. Open decisions

None.
