# 048. `bin/scheduler.ts` registers no `finding_queued` listener; the `Scheduler` constructor's is the one that runs

Status: written 2026-11-06 from the delivery-system design for issue #83;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design), section 6.1 (standing agents are woken by events the scheduler
emits) and section 4 (agents resolve their own blockers; a flaw the filer
records is fixed through an ordinary spec);
[008-agent-registry](../008-agent-registry/spec.md) AC-4 (`finding_queued`
is appended to the pending events of every subscriber);
[020-failure-finding-does-not-wake-its-agent](../020-failure-finding-does-not-wake-its-agent/spec.md)
AC-1 and section 6 (the `finding_queued` emit skips the agent a failure
finding names; the listener in `loop.ts` carries that name through to
`emit`). This spec marks no earlier text: spec 020 section 6 names the
`loop.ts` listener as the one that carries the exclusion, which stays true.

## 1. Goal

The service has one registered `finding_queued` listener, the one the
`Scheduler` constructor installs, and the code reads that way: no second
registration in the entry point that is silently replaced, and no comment
that justifies the constructor's listener by a wrapper that no longer
exists.

### What is wrong today

`tools/scheduler/src/state/findings.ts` keeps one listener per state root
(`listeners.set(p.root, fn)` in `onFindingsQueued`), so the last
registration for a root wins. Two places register for the service's root:

1. `tools/scheduler/bin/scheduler.ts` (lines 61 to 62 on `main`) builds a
   two-parameter `emitEvent` wrapper over `emit` and registers
   `onFindingsQueued(paths, (count, offset) => emitEvent('finding_queued',
   {count, offset}))`.
2. The `Scheduler` constructor in `tools/scheduler/src/service/loop.ts`
   (line 134 on `main`) registers
   `onFindingsQueued(deps.paths, (count, offset, exclude) => emit(..., exclude))`
   for the same root. `new Scheduler(...)` runs at line 131 of `bin`, after
   its own registration, so the constructor's listener replaces bin's.

bin's registration therefore delivers nothing in the running service. It
reads as if it did, and if it ever ran it would drop the excluded agent
name that spec 020 AC-1 requires, because its wrapper takes two
parameters. The constructor's comment (lines 131 to 133 of `loop.ts`)
still says the listener delivers through `emit` because "bin/scheduler.ts
passes a two-parameter wrapper that would drop it", describing the dead
registration as the reason for the live one. The spec 020 e2e test "the
exclusion holds with the service's two-parameter emitEvent, as
bin/scheduler.ts supplies it" passes with bin unchanged, which is the
evidence that bin's listener never runs. The fix of spec 020 (commit
d28504b) left bin as it was because bin was outside that plan's file
scope; the fix and review stages of issue #62 noticed it while tracing how
the excluded name reaches `emit`, and the filer verified it on `main` and
opened issue #83.

The CLI paths of bin (`telegram-check`, `quota`, `param`, `agent`,
`action`) exit before the `Scheduler` is constructed and append no
findings, so no path in bin ever relies on bin's own registration.

### The fix

Remove the dead registration and the wrapper it was built on, and reword
the constructor's comment so it states the rule on its own terms: the
queue's listener delivers through `emit` itself so the excluded agent is
honoured whatever `emitEvent` a caller supplied. The two-parameter wrapper
bin passes as `deps.emitEvent` goes too *(agent's call)*: the constructor
already defaults `emitEvent` to the same call on `emit` with `deps.now()`
and the third parameter, bin passes `now: () => new Date()`, and every
event bin's wrapper carried takes no exclusion, so the default is the same
delivery through one fewer piece of code that reads as if it configured
event delivery. No ADR: the change removes code with no effect and has one
clearly right answer.

## 2. Out of scope

- `onFindingsQueued` keeping one listener per root, and whether a second
  registration for the same root should be refused or chained. The issue
  asks for the dead registration to go, not for the registry to change;
  the tests construct a `Scheduler` per temporary state root and rely on
  the current replace-on-register behaviour.
- The `finding_queued` event, its payload, `emit`, the exclusion of spec
  020 and the debounce of spec 025: unchanged. The listener the constructor
  installs is unchanged in what it does.
- The events bin's wrapper carried for the chain driver and the loop
  (`merge`, `issue_abandoned`, `infra_alarm`, `maintainer_reply`,
  `capability_answered`): still emitted, through the constructor's default,
  with the same payloads and to the same subscribers.
- The CLI commands of bin and the order of its start-up checks: unchanged.
- The spec 020 e2e tests' assertions: unchanged. One test's name and
  comment are reworded because they cite bin (AC-4); what it checks stays.
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states are the files on the implementation PR's branch, read as
text, and the test world of `tools/scheduler/test/e2e.test.ts` (the standing
world) where a criterion names it.

- AC-1. **bin registers no `finding_queued` listener.** Given
  `tools/scheduler/bin/scheduler.ts`, when an agent reads it, then it
  neither imports nor calls `onFindingsQueued`, and the only registration
  of a `finding_queued` listener in `tools/scheduler/src/` and
  `tools/scheduler/bin/` is the one in the `Scheduler` constructor.
- AC-2. **bin supplies no `emitEvent`; the constructor's default is the
  service's.** Given `tools/scheduler/bin/scheduler.ts`, then it defines
  no `emitEvent` wrapper, does not import `emit` from
  `src/standing/events.ts` (it still imports `EVENT_NAMES` from there for
  the registry), and the `Scheduler` it constructs receives no `emitEvent`
  in its deps, so the constructor's default (`emit` with `deps.paths`,
  `deps.registry`, `deps.now()` and the excluded name) is what the service
  uses for every event. Given the standing world with `deps.emitEvent`
  left undefined, when a chain abandons an issue or a standing agent trips
  the `infra_alarm` path, then the subscribers' `pending_events` gain the
  same events with the same payloads as on `main` (the existing tests that
  check these events still pass without change).
- AC-3. **The constructor's comment names no wrapper in bin.** Given
  `tools/scheduler/src/service/loop.ts`, then the comment above the
  `onFindingsQueued` call in the `Scheduler` constructor cites spec 020
  AC-1, says that the queue's listener delivers through `emit` itself so
  the agent a failure finding names is excluded whatever `emitEvent` a
  caller (the service or a test) supplied, and mentions neither
  `bin/scheduler.ts` nor a two-parameter wrapper that it passes. The
  `onFindingsQueued` call itself is as on `main`.
- AC-4. **The spec 020 test that cites bin is reworded, not weakened.**
  Given `tools/scheduler/test/e2e.test.ts`, then the test on `main` named
  "the exclusion holds with the service's two-parameter emitEvent, as
  bin/scheduler.ts supplies it (spec 020 AC-1, AC-2)" keeps its body and
  assertions, including the two-parameter `emitEvent` it injects, and its
  name and inline comment say that the exclusion holds whatever
  `emitEvent` a caller supplies, a two-parameter one included, without
  saying that bin supplies such a wrapper. Every other test in the file is
  as on `main`.
- AC-5. **Nothing else moves.** Given the implementation PR's diff, then
  the only files it changes are `tools/scheduler/bin/scheduler.ts`,
  `tools/scheduler/src/service/loop.ts` and
  `tools/scheduler/test/e2e.test.ts`; `tools/scheduler/src/state/findings.ts`,
  `tools/scheduler/src/standing/events.ts`, `tools/scheduler/src/standing/run.ts`
  and `tools/scheduler/src/chain/driver.ts` are unchanged; no text marked
  `(maintainer answer, question #<id>)` changes anywhere; and no gate,
  bound, label rule or permission of specs 001 and 006 changes (security
  criterion 5).
- AC-6. **The test suite still passes.** Given the change, when `pnpm test`
  runs from the repository root and `pnpm -F @panelator/scheduler typecheck`
  runs, then both pass, including every spec 020 and spec 025 test in
  `test/e2e.test.ts`, `test/standing.test.ts` and `test/standing-wakes.test.ts`.

## 4. Interfaces and files

No schema, prompt or interface change. `SchedulerDeps`, `DriverDeps.emitEvent`
and `onFindingsQueued` keep their signatures. The implementation PR edits
three files:

- `tools/scheduler/bin/scheduler.ts`: delete the line defining `emitEvent`
  and the line calling `onFindingsQueued` (lines 61 to 62 on `main`);
  delete the `onFindingsQueued` import (line 31) and narrow the
  `src/standing/events.ts` import (line 23) to `EVENT_NAMES`; remove
  `emitEvent` from the deps object passed to `new Scheduler` (line 132).
  Nothing else in the file changes (AC-1, AC-2).
- `tools/scheduler/src/service/loop.ts`: the comment above the
  constructor's `onFindingsQueued` call (lines 131 to 133 on `main`) is
  reworded as AC-3 says; for example "Spec 020 AC-1: the queue's listener
  delivers through `emit` itself, so the excluded agent (the one a failure
  finding names) is honoured whatever `emitEvent` the service or a test
  supplied." The `deps.emitEvent ??=` default and the registration are
  unchanged (AC-3).
- `tools/scheduler/test/e2e.test.ts`: the name and comment of the test
  named in AC-4 are reworded; for example "the exclusion holds whatever
  emitEvent a caller supplies, a two-parameter one included (spec 020 AC-1,
  AC-2)" with the comment "An injected emitEvent that never sees a third
  argument must not defeat the exclusion: the queue's listener does not go
  through it." Its body is unchanged (AC-4).

The spec PR itself adds
`specs/048-bin-drops-dead-finding-queued-listener/spec.md` and lists it
under `## Children` in `docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`); the
security review applies to the implementation PR (spec 006 AC-9). The
change removes code with no effect and rewords two comments and a test
name; it touches no gate, bound, label rule, permission or token handling.
This spec plans no change to the charter, to a protected maintainer
decision, to the sensitive-path list, to the security review criteria or
instructions, or to what decides that a sensitive diff gets the security
review, that both reviews must approve, or that a sensitive path must be
listed in the spec.

## 5. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean (AC-6).
- `grep -n "onFindingsQueued\|emitEvent\|import {EVENT_NAMES,emit}" tools/scheduler/bin/scheduler.ts`
  prints nothing (AC-1, AC-2);
  `grep -rn "onFindingsQueued(" tools/scheduler/src tools/scheduler/bin`
  prints the definition in `src/state/findings.ts` and the one call in
  `src/service/loop.ts` only (AC-1).
- `grep -n "bin/scheduler\|two-parameter wrapper" tools/scheduler/src/service/loop.ts`
  prints nothing (AC-3); `grep -n "bin/scheduler.ts" tools/scheduler/test/e2e.test.ts`
  prints nothing (AC-4).
- `git diff main --stat` lists the three files of section 4 and no other
  (AC-5); `git diff main -- tools/scheduler/test/e2e.test.ts` shows changes
  only to the `it(` line and the comment line of the one test (AC-4).
- Live check after deploy: a standing agent's second failure still
  produces one `finding_queued` for every other subscriber and none for
  the failed agent (spec 020 section 7's live check), and an abandonment
  still appends `issue_abandoned` to the filer's `pending_events`.

## 6. Open decisions

None.
