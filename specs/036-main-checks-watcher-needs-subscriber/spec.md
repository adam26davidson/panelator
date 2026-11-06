# 036. The `main` check watcher runs only when an agent subscribes to `ci_failure_main`

Status: written 2026-11-06 from the delivery-system design for issue #57;
specs derived from that design need no maintainer approval (design section 11).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (agents resolve their own blockers; a flaw the
filer records is fixed through an ordinary spec);
[008-agent-registry](../008-agent-registry/spec.md) AC-4 (the
`ci_failure_main` event and its watcher) and AC-7 (a tick with no due
standing agent behaves exactly as before spec 008); amends spec 008
section 5 (the `loop.ts` bullet) as section 4 records.

## 1. Goal

A tick pays for the `main` check-run watcher only when some standing agent
can receive what it produces. With the registry as it stands today (no
agent subscribes to `ci_failure_main`), a tick makes no `git rev-parse
origin/main` call and no check-run request for the watcher, which is what
spec 008 AC-7 promises: nothing subscribed, so the tick behaves as before.

### What is wrong today

`tools/scheduler/src/service/loop.ts` runs the watcher whenever the
registry has at least one agent (`Object.keys(d.registry).length`). The
watcher (`watchMainChecks` in `tools/scheduler/src/standing/events.ts`)
resolves `origin/main`, lists the check runs of that SHA through
`gh.checks` (one paginated request) and calls `emit('ci_failure_main', …)`
for each new failure. `emit` delivers only to agents whose
`trigger.events` includes the event; no agent in `agents/standing/` does
(`findings-filer` subscribes to `finding_queued`, `issue_abandoned` and
`capability_answered`; `action-audit` has only a schedule). The watcher's
`main-checks.json` de-duplicates the emission, not the request, so every
tick spends one git call and one GitHub request on an event nobody reads.
The review stage of issue #10 noticed it while counting the GitHub calls a
tick makes (findings queue ref 24).

### The fix

Gate the watcher on a subscriber: the loop calls it only when at least one
registered agent's `trigger.events` includes `ci_failure_main`. The
registry already parses triggers (spec 008 AC-1), so the check is a scan
of `d.registry`. The watcher itself, its state file and its emission are
unchanged: the moment an agent subscribes, the next tick resumes watching,
with the stored last-seen state as before. No ADR: the fix has one
clearly right answer (the event's own delivery rule already says who it is
for), and removing the watcher or the event is out of scope.

## 2. Out of scope

- The `ci_failure_main` event itself, its payload and `watchMainChecks`:
  unchanged. The event stays a valid name (spec 008 AC-4) and the watcher
  stays its producer.
- Any new subscriber. Whether an agent should react to `main` failing is a
  question for that agent's definition, not this spec.
- The other GitHub calls a tick makes (shortlist fetch, labels, the chain's
  own check-run reads in `driver.ts`): unchanged.
- The `main-checks.json` state file and its path: unchanged, including a
  stale file left over from before an agent unsubscribed (it is harmless
  and is overwritten when the watcher next runs).
- `docs/delivery-system-design.md` beyond its `## Children` section, and
  `docs/charter.md`: not touched.

## 3. Acceptance criteria

"Given" states use a temporary state directory and a mocked GitHub client,
as in `tools/scheduler/test/loop.test.ts`. "Subscribes" means the agent's
`trigger.events` includes `ci_failure_main`; the registry fixtures are
built as the existing tests build them (`loadRegistry` over
`agents/standing`, with an event pushed onto a copy's `trigger.events`
where an AC needs a subscriber).

- AC-1. **No subscriber, no call.** Given a registry with at least one
  agent and none that subscribes (the registry loaded from
  `agents/standing/` as of this spec is such a registry), when a tick runs,
  then `gh.checks` is not called, no `main-checks.json` is written, and
  the tick's `errors` carries no `main checks:` entry.
- AC-2. **A subscriber turns the watcher on.** Given a registry in which
  one agent subscribes, when a tick runs, then `gh.checks` is called once
  with the SHA of `origin/main` and the configured `required_checks`, and
  a failed required check appends one `ci_failure_main` event to that
  agent's `pending_events` (as spec 008 AC-4 and the existing watcher test
  describe).
- AC-3. **Subscribing later resumes from the stored state.** Given a
  `main-checks.json` written by an earlier tick recording check `test` as
  `failed` for SHA `s`, and a registry with no subscriber, when a tick runs,
  then the file is unchanged (AC-1); when an agent then subscribes and a
  tick runs with `origin/main` still at `s` and `test` still failed, then no
  event is emitted (the stored state already records it), as the watcher
  behaves today.
- AC-4. **The empty registry is unchanged.** Given `registry` is undefined
  or `{}`, when a tick runs, then `gh.checks` is not called, as before this
  spec.
- AC-5. **The recorded chains still pass.** Given the recorded chains of
  spec 006 AC-28 and spec 007, when they run with the registry loaded, then
  they pass unchanged (spec 008 AC-7).
- AC-6. **The landed text follows.** Given the implementation PR's diff,
  then the `loop.ts` bullet of spec 008 section 5 reads "the
  `ci_failure_main` watcher, run only when an agent subscribes (spec 036)",
  no other line of spec 008 changes, and no text marked
  `(maintainer answer, question #<id>)` changes anywhere.

## 4. Amendments to earlier specs

- **Spec 008 section 5**, the `tools/scheduler/src/service/loop.ts`
  bullet: "the `ci_failure_main` watcher" becomes "the `ci_failure_main`
  watcher, run only when an agent subscribes (spec 036)". Nothing else in
  spec 008 changes; AC-4 and AC-7 there already describe the behaviour this
  spec restores.

## 5. Interfaces and files

- `tools/scheduler/src/service/loop.ts`: the watcher step's condition
  changes from "the registry is non-empty" to "some registered agent's
  `trigger.events` includes `ci_failure_main`". The `git rev-parse
  origin/main` call sits inside that condition, so a tick without a
  subscriber makes neither call. A helper of a few lines, in `loop.ts` or
  exported from `tools/scheduler/src/standing/events.ts` beside
  `watchMainChecks` (for example `hasSubscriber(registry, event)`), is the
  implementer's choice; the test of AC-1 drives the loop, not the helper.
- `tools/scheduler/src/standing/events.ts`: `watchMainChecks` is
  unchanged.
- `tools/scheduler/test/loop.test.ts`: new tests for AC-1 (the existing
  registry-loaded harness with a `checks` spy on the mocked client: zero
  calls after a tick), AC-2 (a copy of an agent definition with
  `ci_failure_main` pushed onto `trigger.events`: one `checks` call, one
  pending event on a failure), AC-3 (a pre-written `main-checks.json`) and
  AC-4 (an empty registry). The AC-2 test needs a `rev-parse origin/main`
  that resolves: the harness's repository fixture already has `origin/main`
  (the freshness step fetches it); if the test repository lacks it, the test
  creates the ref in the fixture rather than mocking git.
- `tools/scheduler/test/standing.test.ts`: the existing watcher test stays
  as it is (it calls `watchMainChecks` directly with a subscriber pushed in,
  which this spec does not change).
- `specs/008-agent-registry/spec.md` section 5: the amendment of section 4
  (AC-6).

The spec PR itself adds
`specs/036-main-checks-watcher-needs-subscriber/spec.md` and lists this
spec under `## Children` in `docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`); the
security review applies to the implementation PR (spec 006 AC-9). The
change touches no gate, bound, label rule or permission: it narrows the
condition under which a read-only GitHub request is made.

## 6. Verification

- `pnpm test` from the repository root passes.
- The AC-1 test fails on `main` (the mocked `checks` is called once per
  tick with the registry loaded) and passes after the change. The AC-2 and
  AC-3 tests pass before and after (they pin the behaviour that must not
  change).
- `grep -n "Object.keys(d.registry).length" tools/scheduler/src/service/loop.ts`
  finds no line guarding the watcher.
- `git diff main -- specs/008-agent-registry/spec.md` shows only the one
  amended bullet of section 4 (AC-6).
- Live check after deploy: with the registry as checked in, the service
  log and the GitHub request count over several ticks show no check-run
  listing for `main` outside a chain's own verify step, and
  `main-checks.json` is not rewritten.

## 7. Open decisions

None.
