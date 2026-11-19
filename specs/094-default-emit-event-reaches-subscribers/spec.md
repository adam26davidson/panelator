# 094. The `Scheduler` constructor's default `emitEvent` is driven to a subscriber's `pending_events` by the suite

Status: written 2026-11-19 from the delivery-system design for issue #198;
specs derived from that design need no maintainer approval (design section 11).
Marks [048-bin-drops-dead-finding-queued-listener](../048-bin-drops-dead-finding-queued-listener/spec.md)
AC-2 (amended by AC-1 to AC-4 here: the tests that reach a subscriber's
`pending_events` through the default are the ones this spec names).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (standing agents are woken by the events the scheduler emits)
and section 10 ("Small work skips layers": a tooling spec hangs directly off
a top design); [008-agent-registry](../008-agent-registry/spec.md) AC-4 (an
event is appended to the pending events of every subscriber);
[020-failure-finding-does-not-wake-its-agent](../020-failure-finding-does-not-wake-its-agent/spec.md)
AC-1 (`emit` skips the excluded agent; the default carries the name through);
[048-bin-drops-dead-finding-queued-listener](../048-bin-drops-dead-finding-queued-listener/spec.md)
AC-2 (the constructor's default is the service's only event path, and its
claim of test coverage, amended here);
[045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
AC-5 and [059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md)
AC-6 (the two alarm tests whose stubs this spec replaces);
[064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
AC-7 (the sweep test that already reaches infra health through the default).

## 1. Goal

A regression in the `Scheduler` constructor's default `emitEvent`
(`tools/scheduler/src/service/loop.ts`, `deps.emitEvent ??= ...`) fails the
suite: for each event the service emits through it, at least one test leaves
`deps.emitEvent` to the constructor and asserts the event in a subscriber's
`pending_events`, and one test checks the default's own contract (delivery,
the excluded name, the clock, an unknown name, no replacement of a supplied
`emitEvent`).

### What is wrong today

Since spec 048 removed bin's wrapper, the constructor's default is the only
path by which `merge` (`chain/driver.ts`, `mergeEvent`), `issue_abandoned`
(`chain/driver.ts`, `applyActions`), `infra_alarm` (`service/loop.ts`, the
chain outage alarm; `standing/run.ts`, the standing outage alarm;
`service/sweep.ts` through the `emitEvent` the loop passes it),
`maintainer_reply` and `capability_answered` (`service/loop.ts`, the paused
issue's answer) reach a subscriber. Spec 048 AC-2 says the existing tests
cover that delivery. They do not: every test that asserts one of these events
injects its own `emitEvent` stub and asserts on the stub
(`test/e2e.test.ts`, the spec 045 AC-5 and spec 059 AC-6 tests;
`test/loop.test.ts`, the capability close and `outageSetup` tests) or calls
`emit` directly (`test/standing.test.ts`, `test/standing-wakes.test.ts`). The
one exception is the spec 064 AC-7 sweep test in `test/e2e-sweep.test.ts`,
which reads infra health's `pending_events` for the sweep's `disk_full`
alarm after a tick on a world that supplied no `emitEvent`; it covers the
sweep's two-argument call only. A default that dropped the excluded name,
read the wrong registry, used the wrong clock or forgot its `await` would
pass the suite for every chain and standing event.

### The fix

Test changes only. Four recorded tests that already drive the production
call sites stop stubbing `emitEvent` and assert the subscriber's state
instead (AC-1 to AC-4), one of them with a test-only subscriber for the two
events no built-in agent subscribes to, and one new unit test pins the
default's contract (AC-5). No source file changes (AC-6).

*(agent's call)* The events `merge` and `maintainer_reply` have no
subscriber in `agents/standing/`, so AC-4 adds a paused test-only agent to the
world's registry rather than changing a real agent's trigger: the recorded
chains must keep running as on `main`, and a paused agent keeps its events
without taking the slot (the same device chainWorld uses for the filer and
infra health). `capability_answered` is emitted only on the capability-hold
close path, whose test world (`test/loop.test.ts`) has no registry; this spec
covers that name through AC-5's direct call rather than build a capability
issue into a chain world, because the close path's own ordering test keeps
its stub (it checks that the events follow the close), and the default does
not branch on the event name.

## 2. Out of scope

- `emit`, `onFindingsQueued`, the constructor's `finding_queued` listener, the
  exclusion of spec 020 and the debounce of spec 025: unchanged, and not
  re-tested here.
- The call sites' payloads: unchanged. The payload assertions of AC-2 and
  AC-3 are the ones the replaced stubs made, moved to the subscriber's state.
- The tests that keep their stubs: `test/loop.test.ts`'s capability close
  test (it asserts the events follow the close, which a state read cannot
  show) and its `outageSetup` tests (their world has no registry);
  `test/e2e.test.ts`'s spec 020 two-parameter test (it must inject one);
  `test/sweep.test.ts` (a unit of `sweepVolumes`, which takes `emitEvent` as
  a parameter).
- Adding a `merge` or `maintainer_reply` subscriber to `agents/standing/`.
- `bin/scheduler.ts` and `docs/delivery-system-design.md` beyond its
  `## Children` section: not touched.

## 3. Acceptance criteria

"Given" states name the recorded worlds of `tools/scheduler/test/helpers/e2e-routes.ts`:
the chain world (`chainWorld`) and the standing world (`standingWorld`), both
of which construct the `Scheduler` with the real `agents/standing/` registry
and no `emitEvent`, with `findings-filer` (chain world) and `infra-health`
(both) paused. "Leaves `deps.emitEvent` to the constructor" means the test
assigns nothing to `w.deps.emitEvent` at any point; the constructor has set it.

- AC-1. **An abandonment reaches the filer through the default.** Given the
  chain world of the test `abandonment (spec 006 AC-28)` in
  `test/e2e.test.ts`, which leaves `deps.emitEvent` to the constructor, when
  the chain has settled, then the test asserts that `findings-filer`'s
  `pending_events` (read with `readAgentState`) equals one entry `{ event:
  "issue_abandoned", payload: { issue: 7 }, at: <ISO instant> }` and that
  `infra-health`'s `pending_events` is `[]`. Every assertion the test makes
  on `main` is kept.
- AC-2. **A standing outage alarm reaches infra health through the default.**
  Given the standing world of the test `an outage two hours old raises one
  alarm: a finding, an infra notification and an infra_alarm event (spec 045
  AC-5, AC-7)`, then the test no longer assigns `w.deps.emitEvent` and no
  longer asserts on a stub; after the tick at `T0` it asserts that
  `infra-health`'s `pending_events` equals `[{ event: "infra_alarm", payload:
  { kind: "network_outage", agent: "operator", since, failures: 4, cause:
  "EAI_AGAIN" }, at: T0 }]` (the same payload the stub assertion checked on
  `main`; `at` is `deps.now()` at the emit, which the world holds at `T0`),
  and after the second tick (`00:20`) that it still has exactly one
  `infra_alarm`. Every other assertion is kept.
- AC-3. **A chain outage alarm reaches infra health through the default.**
  Given the chain world of the test `a spec-track chain waits three ticks on a
  full temp volume, then runs with its bounds untouched` (spec 059 AC-6),
  then the test no longer assigns `w.deps.emitEvent` and no longer collects
  events in a stub; after the three ticks it asserts that `infra-health`'s
  `pending_events` filtered to `infra_alarm` equals one entry whose `payload`
  matches `expect.objectContaining({ kind: "disk_full", issue: 7, cause:
  "ENOSPC" })` (the stub assertion's matcher on `main`). Every other
  assertion is kept.
- AC-4. **`merge` and `maintainer_reply` reach a subscriber through the
  default.** Given the chain world of the test `question paused, answered,
  recorded, merged (spec 006 AC-28)`, where before its first tick the test
  adds a subscriber to `w.deps.registry` under the name `watcher`: the
  `action-audit` definition with `name: "watcher"` and `trigger: { events:
  ["merge", "maintainer_reply"] }` (no schedule), and writes its state with
  `writeAgentState` as `{ last_run: null, next_run: null, pending_events: [],
  paused: true, paused_by: "maintainer", failures: 0 }`; when the chain has
  settled, then the test asserts that `watcher`'s `pending_events` equals, in
  order, `{ event: "maintainer_reply", payload: { issue: 7, question_id:
  <the question comment's id> } }` and `{ event: "merge", payload: { issue:
  7, pr: 9, sha: <a 40-hex string> } }`, each with an ISO `at`, and nothing
  else. Every assertion the test makes on `main` is kept, so the added agent
  changes nothing the chain does (`adapter.ran`, labels, comments, the
  questions log).
- AC-5. **The default's contract.** Given a `Scheduler` constructed in
  `test/loop.test.ts` from `setup(...)`'s deps with `deps.registry` the real
  registry (loaded as the spec 036 and spec 008 tests there load it),
  `deps.parameters` a `ParameterStore` over it and the agents initialised
  with `initializeAgents`, and `deps.emitEvent` undefined before
  construction, then after `new Scheduler(deps)`:
  - `deps.emitEvent` is a function;
  - `await deps.emitEvent("issue_abandoned", { issue: 3 })` leaves
    `findings-filer`'s `pending_events` equal to `[{ event:
    "issue_abandoned", payload: { issue: 3 }, at: deps.now().toISOString()
    }]` and `infra-health`'s unchanged;
  - `await deps.emitEvent("issue_abandoned", { issue: 4 }, "findings-filer")`
    adds nothing to `findings-filer`'s `pending_events` (spec 020 AC-1: the
    third argument reaches `emit`);
  - `await deps.emitEvent("infra_alarm", { kind: "network_outage" })`
    appends one `infra_alarm` to `infra-health`'s `pending_events` and
    nothing to `findings-filer`'s;
  - `deps.emitEvent("nope", {})` rejects with an error whose message
    contains `unknown event nope`.
  Given the same deps with `emitEvent` set to a stub before construction,
  then after construction `deps.emitEvent` is that stub. Given deps with no
  `registry`, then after construction `deps.emitEvent` is `undefined`.
- AC-6. **Nothing else changes.** Given the implementation PR's diff, then it
  changes only `tools/scheduler/test/e2e.test.ts` and
  `tools/scheduler/test/loop.test.ts`; `tools/scheduler/src/` and
  `tools/scheduler/bin/` are as on `main`; the tests listed in section 2 keep
  their stubs; and `pnpm test` and `pnpm -F @panelator/scheduler typecheck`
  pass.

## 4. Interfaces and files

No schema, config key, stage prompt, state file format, log kind or source
change. The implementation PR edits two files:

- `tools/scheduler/test/e2e.test.ts`: the four tests of AC-1 to AC-4, each
  citing `spec 094 AC-n` in its name or a comment. AC-2 and AC-3 drop their
  `emitted`/`events` stubs; AC-4 adds the `watcher` registration before the
  first tick (`writeAgentState` is already imported there).
- `tools/scheduler/test/loop.test.ts`: a `describe` block
  `the constructor's default emitEvent (spec 094 AC-5)` with the cases of
  AC-5, next to the spec 036 main-check-watcher block, which shows how that
  file loads the registry.

The spec PR itself adds
`specs/094-default-emit-event-reaches-subscribers/spec.md`, marks spec 048
AC-2 as amended by it, and lists this spec under `## Children` in
`docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`), so the
security review applies to the implementation PR (spec 006 AC-9). The change
is tests only; it touches no gate, bound, label rule, permission or token
handling, and plans no change to the charter, to a protected maintainer
decision, to the sensitive-path list, to the security review criteria or
instructions, or to what decides that a sensitive diff gets the security
review, that both reviews must approve, or that a sensitive path must be
listed in the spec.

## 5. Verification

- `pnpm test` from the repository root passes and
  `pnpm -F @panelator/scheduler typecheck` is clean (AC-6).
- Checked by hand once while writing the tests, not committed: with the
  default's `exclude` argument dropped (`emit(..., deps.now())`), AC-5's
  excluded case fails; with the default's `emit` call not awaited, AC-5's
  first case fails or AC-1 reads an empty list; with the default removed
  (`deps.emitEvent` left undefined), AC-1 to AC-5 all fail.
- `git diff main -- tools/scheduler/src tools/scheduler/bin` is empty (AC-6).
- `grep -n "deps.emitEvent *=" tools/scheduler/test/e2e.test.ts` matches
  only the spec 020 two-parameter test (AC-2, AC-3).

## 6. Open decisions

None.
