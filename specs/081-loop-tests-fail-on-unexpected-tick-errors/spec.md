# 081. A loop test fails on a tick error it did not expect

Status: written 2026-11-18 from the delivery-system design for issue #159;
specs derived from that design need no maintainer approval (design section 11).
Supersedes and amends no earlier spec's text.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 10 ("Small work skips layers": a tooling spec hangs directly off a
top design) and section 4 (agents resolve their own blockers; a flaw the
filer records is fixed through an ordinary spec);
[036-main-checks-watcher-needs-subscriber](../036-main-checks-watcher-needs-subscriber/spec.md)
(the `main checks:` error this harness let pass unseen, and the spec that
removed it for a registry with no subscriber);
[008-agent-registry](../008-agent-registry/spec.md) AC-4 (the
`ci_failure_main` watcher and its check-run listing).

## 1. Goal

`Scheduler.tick()` never throws for a failing step. It catches the failure and
pushes a line onto the tick result's `errors` (`freshness: ...`,
`children scan: ...`, `main checks: ...`, `sweep: ...`, `claim <n>: ...` and
the rest, `tools/scheduler/src/service/loop.ts`). The harness in
`tools/scheduler/test/loop.test.ts` (`setup()`) returns that result and
leaves it to each test to read `errors`, and only the tests that expect an
error read it. A step that fails on every tick therefore passes the suite
as long as no test happens to look.

That happened. `routes()` has no route for
`GET /repos/o/r/commits/<sha>/check-runs`. From spec 008 to spec 036, every
loop test that loaded the standing-agent registry made that request
unmatched, the watcher threw, the tick recorded `main checks: ...`, and
nothing failed. Spec 036 removed the request for a registry with no
`ci_failure_main` subscriber, which made the error go away without
surfacing it. The checked-in infra health agent
(`agents/standing/infra-health.md`, spec 064) now subscribes to
`ci_failure_main`, so a loop test that loads the checked-in registry with
`setup()`'s routes would make the request again. Today the spec 036 tests
avoid this by editing the subscription out, and the other registry-loaded
tests either bring their own route or load `action-audit` alone.

This spec closes the blind spot in two parts:

- Every tick the harness drives is watched. An error that the test did not
  declare as expected fails the test, with the error's text in the failure.
- `setup()` answers the check-run listing by default, so a test that loads
  the checked-in registry does not fail for a route the harness lacks.

A measurement on `main` at `5b7f8f4` (every tick of every `setup()`
scheduler, recorded during the full `loop.test.ts` run) found seven tests
whose ticks report errors. All seven are failures they cause on purpose:
`issue list incomplete`, `freshness:` (two tests), `children scan:`,
`claim 1:` (two tests) and `sweep:`. Six of them assert the error. One,
"does not scan when the fast-forward failed (spec 031 AC-3)", does not. No
test today has an error it did not cause, so the guard turns on clean once
those seven declare their errors.

## 2. Out of scope

- Any change to `tools/scheduler/src/`. `loop.ts` keeps catching step
  failures into `errors`. That the service survives a failing step is the
  behaviour under test, not the flaw.
- The other harnesses: `test/e2e.test.ts` and its
  `test/helpers/e2e-routes.ts`, which already answer the check-run
  listing, and the scheduler's other test files. A later spec may reuse
  the helper of AC-1 there.
- Failing a test on `gh.unmatched` (an unmatched request). Several tests
  rely on the mock's 404 on purpose. An unmatched request that breaks a
  step shows up as a tick error under AC-1, and that is the case the issue
  asks about.
- Any change to the stub that the "wake interrupts the watchdog sleep" test
  assigns over `s.tick`. A test that replaces `tick` outright runs no real
  tick and so has no errors to watch.

## 3. Acceptance criteria

AC-1. **The guard.** Given a new helper `tools/scheduler/test/helpers/tick-errors.ts`
exporting `watchTickErrors(scheduler)`, when it is called on a `Scheduler`,
then it replaces that instance's `tick` with a wrapper that:

- calls the original;
- appends every string in the result's `errors` to a list kept for that
  scheduler;
- returns the result unchanged.

It returns `{ allow(pattern: RegExp): void; unexpected(): string[]; check(): void }`:

- `unexpected()` lists, in tick order, each recorded error that matches no
  pattern passed to `allow`, including errors recorded before the `allow`
  call.
- `check()` throws an `Error` when `unexpected()` is non-empty. The message
  starts `unexpected tick errors:` and contains every unexpected error's
  text.

A `run()` loop that calls `this.tick()` goes through the wrapper, because
the wrapper is an instance property. A test that later wraps or replaces
`s.tick` itself (as two tests do today, by wrapping the original) keeps
working on top of it.

AC-2. **`setup()` fails a test on an unexpected error.** Given `setup()` in
`loop.test.ts`, when it builds its `Scheduler`, then it:

- calls `watchTickErrors` on the scheduler;
- registers the watcher's `check` with vitest's `onTestFinished`;
- returns `allowErrors(pattern)` (the watcher's `allow`) and
  `watch(scheduler)` with the rest of the harness.

`watch(scheduler)` applies `watchTickErrors` to another `Scheduler` that the
test builds from the harness's `deps`, registers its `check` the same way,
and returns the scheduler. So a test whose tick reports an error it did not
`allowErrors` fails, and the failure names the error. A throwing
`onTestFinished` callback fails the test in vitest 3; this was checked when
the spec was written. Every `new Scheduler(deps, ...)` in `loop.test.ts`
whose `tick` the test calls goes through `watch`.

AC-3. **Every existing test declares the errors it causes.** Given the
guard of AC-2, when `loop.test.ts` runs, then each test whose ticks report
errors calls `allowErrors` with a pattern that matches only the error the
test provokes. The pattern is anchored on the step's prefix, for example
`/^freshness: /`, `/^children scan: /`, `/^claim 1: /`, `/^sweep: /` or
`/^issue list incomplete/`, never a catch-all such as `/./`. Each existing
assertion on `errors` stays. The test "does not scan when the fast-forward
failed (spec 031 AC-3)" also gains an assertion that its tick's errors are
exactly one `freshness: ` line. If the implementer finds a test whose tick
reports an error the test did not mean to cause, they fix the test (a
missing route or fixture), not the pattern, and say so in the PR body.

AC-4. **`setup()` answers the check-run listing.** Given `setup(rs, ...)`,
when it builds the mocked client, then it appends a fallback route after
`rs`:
`GET /repos/o/r/commits/<sha>/check-runs` answers one completed, successful
check run named `test`. Because the mock takes the first route that
matches, a test that passes its own check-runs route (the spec 008 restart
test, the spec 036 harness, the spec 060 blocked-on-main tests) still gets its
own reply. With the checked-in registry loaded (infra health subscribed to
`ci_failure_main`) and `routes([])`, a tick then:

- reports no error;
- makes exactly one check-runs call, for `origin/main`'s sha;
- leaves no `/check-runs` entry in `gh.unmatched`.

A new test in `loop.test.ts` drives that tick and asserts all three.

AC-5. **The guard is proved.** Given a new test file
`tools/scheduler/test/tick-errors.test.ts`, when it runs `watchTickErrors`
over a stub object whose `tick` returns scripted results, then it shows:

- (a) two ticks reporting `main checks: boom` and nothing allowed make
  `unexpected()` return that error twice, and `check()` throw a message
  containing `main checks: boom`;
- (b) after `allow(/^main checks: /)`, `unexpected()` is empty and `check()`
  does not throw, including for an error recorded before the `allow` call;
- (c) an allowed pattern does not hide a different error (`sweep: x` stays
  unexpected under `allow(/^main checks: /)`);
- (d) a tick with no errors records nothing, and the wrapped `tick`
  returns the original's result unchanged.

AC-6. **The issue's scenario fails the suite.** Given the AC-4 test with
the fallback route removed (the implementer runs this once by hand and
reports it in the PR body, not as a committed test), when `loop.test.ts`
runs, then that test fails with `unexpected tick errors:` and the
`main checks:` line. On `main` before this change, the same tick passes
unseen.

## 4. Interfaces and files

- `tools/scheduler/test/helpers/tick-errors.ts` (new): `watchTickErrors`
  (AC-1). Its type parameter accepts any object with an async `tick()`
  returning `{ errors: string[] }`, so the AC-5 stub needs no `Scheduler`.
- `tools/scheduler/test/tick-errors.test.ts` (new): AC-5.
- `tools/scheduler/test/loop.test.ts`:
  - `setup()` watches its scheduler, registers the check, returns
    `allowErrors` and `watch`, and appends the fallback check-runs route
    (AC-2, AC-4).
  - The seven tests listed in section 1 call `allowErrors` (AC-3).
  - The tests that build their own `Scheduler` from `deps` and call its
    `tick` use `watch` (AC-2). Today these are the restart test in
    "Scheduler.tick", the `again` scheduler, and the C7 failure-count tests.
    The chain driver runs outside the tick, so the C7 tests' thrown `boom`
    should not appear among the tick's errors. If it does, the test allows
    it with a pattern for the driver's message.
  - One new test (AC-4).
  - `routes()` itself is unchanged; the fallback lives in `setup()`, after
    the caller's routes.
- No file under `tools/scheduler/src/` changes.

The spec PR adds this file and lists it under `## Children` in
`docs/delivery-system-design.md`.

`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`), so
the security review applies to the implementation PR (spec 006 AC-9). The
change only adds checks to the test suite. It removes and weakens no
assertion, and `pnpm test` runs the same files plus one.

## 5. Verification

- `pnpm test` from the repository root passes.
- `tick-errors.test.ts` covers AC-5 (a) to (d).
- `grep -n "allowErrors(/\.\/)\|allowErrors(/\.\*/)" tools/scheduler/test/loop.test.ts`
  finds nothing (AC-3: no catch-all pattern).
- The PR body reports the AC-6 manual run: the AC-4 test with the fallback
  route deleted fails, naming `main checks:`.
- `git diff main --stat` touches only `tools/scheduler/test/`.

## 6. Open decisions

None.
