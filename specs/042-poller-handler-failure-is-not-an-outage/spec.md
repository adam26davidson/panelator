# 042. A Telegram handler failure is not logged as a Telegram outage

Status: written 2026-11-06 from the delivery-system design for issue #74;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Telegram": the maintainer's channel) and section 10 ("Small work
skips layers": a bug spec hangs directly off a top design);
[007-telegram-channel](../007-telegram-channel/spec.md), whose AC-2 this spec
amends (marked as section 4 records) and whose AC-3 (an update is confirmed
only after it is acted on) it keeps; consistent with
[012-metrics-reflection](../012-metrics-reflection/spec.md) section 2 (the
service log is the maintainer's only view of the channel until the console
lands).

## 1. Goal

A failure inside the update handler is written to the service log as what it
is, and the Telegram outage and recovery lines are written only when
`getUpdates` itself fails.

### What is wrong today

The poller's loop (`tools/scheduler/src/telegram/poller.ts`) has one `try`
around both the `getUpdates` call and `await this.onUpdate(u)` for each
update. Its `catch` logs `telegram-outage` once, sleeps with a backoff that
doubles from 1 s to 60 s, and on the next `getUpdates` that returns logs
`telegram-recovered`. Spec 007 AC-2 asks for exactly that for "a network or
server error". But the handler (`TelegramAnswers.handle` in
`tools/scheduler/src/telegram/answers.ts`) throws in two cases that are not
Telegram errors:

- on purpose, `question send still completing`, while a paused record is in
  phase `pausing`, so that the update stays unconfirmed and is redelivered
  once the pause has completed (spec 007 AC-3, AC-6);
- on any GitHub error while it lists the issue's comments or posts the
  answer comment (spec 007 AC-9, first step).

Both are written as `telegram-outage` and then `telegram-recovered`, although
the connection never failed, and the GitHub error is attributed to the wrong
service. The redelivery of the deliberate throw also waits through the
doubling backoff, so a maintainer who presses a button while a question is
still being sent waits for the next backoff step, not for the pause to
finish. The test at `tools/scheduler/test/telegram.test.ts` pins the two
lines for a `getUpdates` failure only; no test covers a handler throw.

### The fix

The handler gets its own `try` inside the loop. A throw from it leaves the
offset where it is (the update is not confirmed, so Telegram redelivers it,
as AC-3 wants), is logged under its own kind, and the loop continues after a
short fixed delay. The outage and recovery lines, and the doubling backoff,
belong to `getUpdates` alone. The deliberate wait for a completing pause is
told apart from a failure: the handler signals it with a dedicated error,
and the poller logs it under a kind of its own rather than as a failure.

*(agent's call)* A fixed short delay (2 s) rather than a backoff for the
handler: the two causes are a pause that completes within the current tick
and a GitHub call that the next tick's watchdog will retry anyway, and the
Bot API's own long poll bounds how fast the same update comes back. The
delay keeps a persistent handler fault from busy-looping against Telegram,
and doubling it would only make the maintainer's redelivered answer wait
longer. A dedicated error class rather than matching the message text, so
the signal cannot be broken by a reworded message. The change is one loop
and one error type, cheap to reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- What the handler does with an update (spec 007 AC-7, AC-9) and why it
  throws while a record is `pausing`: unchanged. Only how the poller
  classifies and logs the throw changes.
- The `getUpdates` outage behaviour: the backoff from 1 to 60 s, one outage
  line and one recovery line stay exactly as spec 007 AC-2 says.
- Confirming an update whose handler failed, or skipping it after some
  number of failures. The update stays unconfirmed, as spec 007 AC-3 asks;
  a handler that fails for ever on one update blocks the channel at that
  update, as it does today, and is visible in the log by this spec's kind.
- Routing the new log lines anywhere other than the service log (spec 030's
  alerts, the console).
- The `afterConfirm` hook (`confirmed` in `answers.ts`): it runs after the
  offset has moved and is not inside the handler's `try` today; a throw from
  it keeps reaching the outer `catch`. This spec moves it under the same
  handler `try` as section 3 AC-1 says, since it is part of acting on an
  update, but changes nothing else about it.

## 3. Acceptance criteria

"Given" states use the fake Telegram Bot API server of spec 007 section 6
and the fake harness and mocked GitHub API of spec 001. The service log is
the `log` callback the poller is constructed with; a *line* is one record.

- AC-1. **A handler throw is logged as a handler failure and leaves the
  offset.** Given Telegram on and an update from the configured chat, when
  `onUpdate` (or `afterConfirm`) rejects with any error other than the one
  of AC-2, then the poller writes one line
  `{ kind: "telegram-handler-failed", update_id: <id>, error: <message> }`,
  where `error` is the error's `message` (or `String(error)` when it has
  none), and never the update's text, the caller's chat id or any Telegram
  URL; `telegram/offset.json` is not written and the in-memory offset stays
  at the failed update's id, so the next `getUpdates` asks for it again; no
  `telegram-outage` and no `telegram-recovered` line is written; the loop
  waits a fixed 2 s (through the injected `sleep` when one is given, so the
  test asserts the wait) and issues the next `getUpdates`, without
  processing the remaining updates of the same batch (they are redelivered
  with it, in order, as today). The `getUpdates` backoff is unaffected: it
  is reset to 1 s by the successful `getUpdates` and is not advanced by the
  handler failure. Given the service stops during the 2 s wait, then the
  wait ends and the loop exits, as the backoff sleep does today.
- AC-2. **Waiting for a completing pause is not a failure.** `answers.ts`
  exports a class `UpdateDeferred extends Error` (message `question send
  still completing`), and `handle` throws it, instead of a plain `Error`,
  when a paused record is in phase `pausing`. Given `onUpdate` rejects with
  an `UpdateDeferred`, then the poller behaves as in AC-1 except that the
  line is `{ kind: "telegram-update-deferred", update_id: <id> }` with no
  `error` field, written at most once per `update_id` per service start
  (the second and later deferrals of the same update write nothing). Given
  the pause then completes and the redelivered update is handled, then the
  answer flow of spec 007 AC-9 runs as today and the offset moves past the
  update.
- AC-3. **The outage lines are for `getUpdates` only.** Given `getUpdates`
  rejects (network or server error), then the poller behaves exactly as spec
  007 AC-2 says: one `telegram-outage` line, backoff from 1 s doubling to
  60 s, one `telegram-recovered` line when a `getUpdates` next returns. Given
  `getUpdates` returns and the handler then throws (AC-1), then no outage
  line is written and no backoff step is taken. Given an outage is in
  progress (the `telegram-outage` line was written, no recovery yet) and
  `getUpdates` returns a batch whose first update's handler throws, then the
  `telegram-recovered` line is written (the connection did recover) and then
  the AC-1 line, in that order. The existing test for the outage path keeps
  passing unchanged.
- AC-4. **The GitHub error is attributed to GitHub.** Given an answer update
  whose `listComments` or `comment` call rejects with an error whose message
  names the GitHub failure (the mocked API's message, as today), then the
  service log holds one `telegram-handler-failed` line whose `error` is that
  message and no `telegram-outage` line; when the GitHub call succeeds on
  the redelivery, the answer comment is posted once (the marker of spec 007
  AC-9 is the guard, as today), the offset moves past the update and the
  acknowledgement is sent once.

## 4. Amendments to earlier specs

- Spec 007 AC-2 is marked `Amended by
  [042-poller-handler-failure-is-not-an-outage](../042-poller-handler-failure-is-not-an-outage/spec.md)
  AC-1`: the "never crashes the service" promise now covers a handler throw by the handler `try`, and the
  outage, recovery and backoff behaviour it describes is for a `getUpdates`
  error only; a handler throw is logged as AC-1 and AC-2 say. The text of
  AC-2 stays as the record.

Nothing else in spec 007 changes. AC-3's rule that an update's effect is
written before the offset moves, and that a redelivered update does nothing
twice, is what this spec relies on and leaves alone.

## 5. Interfaces and files

- `tools/scheduler/src/telegram/poller.ts`: the loop gains an inner `try`
  around `this.onUpdate(u)`, the offset write and `this.afterConfirm?.(u)`
  (AC-1); on a throw it logs `telegram-handler-failed` (or
  `telegram-update-deferred` for an `UpdateDeferred`, once per `update_id`),
  breaks out of the batch, waits 2 s (the injected `sleep` or `delay` with
  the abort signal, as the backoff sleep does) and continues the outer
  loop. The outer `catch` is reached only by `getUpdates` (AC-3). The
  constructor signature is unchanged. The 2 s is a module constant
  (`HANDLER_RETRY_MS`), not configuration.
- `tools/scheduler/src/telegram/answers.ts`: `export class UpdateDeferred
  extends Error` and the one `throw` site using it (AC-2). `poller.ts`
  imports the class; nothing else in `answers.ts` changes.
- `tools/scheduler/test/telegram.test.ts`: tests for AC-1 (a handler that
  rejects once, then succeeds: the one line with `error` and `update_id` and
  nothing secret, the 2 s wait, the offset file unchanged until the
  redelivery is handled, no outage lines), AC-2 (an `UpdateDeferred` twice,
  then success: one `telegram-update-deferred` line), AC-3 (an outage
  followed by a batch whose handler throws: the recovered line precedes the
  handler line, and the existing outage test is unchanged) and the AC-1
  rule that the remaining updates of a failed batch are not handled before
  the redelivery. `tools/scheduler/test/loop.test.ts` or `e2e.test.ts`: AC-4
  through `Scheduler.handleTelegramUpdate` with the mocked GitHub rejecting
  once.
- `specs/007-telegram-channel/spec.md`: the mark of section 4.

No file outside `tools/scheduler/` and `specs/` is changed. `tools/scheduler/`
is a sensitive path, so the security review runs on the implementation PR as
spec 006 AC-9 says. No schema, config key, stage prompt or state file format
changes: `telegram/offset.json` keeps its shape and the new log kinds are
service-log records like `telegram-foreign-chat`.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  with the tests of section 5 added. The existing outage test
  (`backs off network/server failures, logs one outage and recovery, and
  stop preserves the offset`) passes without edits.
- A grep of `tools/scheduler/src/telegram/poller.ts` shows the strings
  `telegram-outage` and `telegram-recovered` only in the branch that handles
  a `getUpdates` rejection.
- Every recorded end-to-end chain of spec 007 section 6 passes unchanged, in
  particular "a crash after the issue comment and before the offset moved:
  redelivery does nothing twice".

## 7. Open decisions

None.
