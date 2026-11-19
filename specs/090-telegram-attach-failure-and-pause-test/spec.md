# 090. A rejecting Telegram attach hook is retried on its own, and the spec 043 AC-3 test goes through the driver's pause

Status: written 2026-11-19 from the delivery-system design for issue #187;
specs derived from that design need no maintainer approval (design section 11).
Marks [043-telegram-connects-with-backoff](../043-telegram-connects-with-backoff/spec.md)
AC-3 and section 5 as amended (section 4 below).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Telegram": the scheduler holds a long-poll connection open at all
times) and section 10 ("Small work skips layers": a bug spec hangs directly
off a top design);
[043-telegram-connects-with-backoff](../043-telegram-connects-with-backoff/spec.md)
AC-1 (the connect step and its backoff), AC-3 (the channel is attached when
connected, and a pause before that is a spec 006 question) and section 5
(the attach hook, and the loop test AC-3 asks for);
[042-poller-handler-failure-is-not-an-outage](../042-poller-handler-failure-is-not-an-outage/spec.md)
AC-1 (a failure on the scheduler's side of the poller is logged under its own
kind, not as a Telegram failure, and retried);
[007-telegram-channel](../007-telegram-channel/spec.md) AC-11 (a question with
no Telegram message is handled as Telegram off until answered), which this
spec leaves alone.

## 1. Goal

Two leftovers of spec 043, fixed in one small change.

1. A rejecting attach hook does not re-enter the `getMe` retry path. The
   poller calls `getMe` until it succeeds, writes one `connected` line, and
   then calls the hook until it resolves; a rejection is logged under its
   own kind and retried with the connect backoff, without another `getMe`,
   `connecting` or `connected` line.
2. The loop test for spec 043 AC-3 checks what spec 043 section 5 lists: a
   pause made through the driver while no channel is attached leaves a
   paused record with `telegram: null`, an issue comment carrying the
   mention, a questions-log `sent` line with `channel: "issue"`, and no
   `telegram-send-failed` line.

### What is wrong today

`TelegramPoller.loop()` (`tools/scheduler/src/telegram/poller.ts`, the connect
step before the `getUpdates` loop) awaits the hook inside the `try` whose
`catch` is the `getMe` retry path:

```ts
try {
  const me = await this.client.getMe(this.controller.signal);
  this.log({ kind: "telegram", status: "connected", username: me.username });
  await this.onConnected?.();
  break;
} catch (e) { ... "connecting" ... backoff ... }
```

A hook that rejects (or throws) is handled as a `getMe` connection failure:
the `connected` line already written is followed by a `connecting` line,
`getMe` is called again and, on success, a second `connected` line is written
and the hook is called again. Spec 043 section 5 says the hook is "invoked
once after `getMe` succeeds". The production hook (`Scheduler.setTelegram`, a
field assignment) cannot throw, so this cannot happen today; a hook that does
I/O would hit it, and an authorization error thrown by such a hook would turn
Telegram off after it had connected.

The loop test `AC-3: a pause before the connection is an issue question;
after it, a Telegram one` (`tools/scheduler/test/loop.test.ts`, describe
`Telegram attaches when connected (spec 043)`) calls `completePause` with a
record that already carries `emptyTelegram()`. `pauseIssue`
(`tools/scheduler/src/chain/driver.ts`), the only place a paused record with
`telegram: null` is produced, is never run with the channel unattached, and
the test asserts `r.telegram` matches `{ sent: false, message_id: null }`,
which the supplied record already had. It asserts neither the mention in the
issue comment, nor the questions log's `channel`, nor the absence of a
`telegram-send-failed` line. The behaviour is correct by reading
(`sendPausedQuestion` returns at once when `deps.telegram` is null); the test
does not hold it.

### The fix

1. **The hook is called after the `getMe` loop, in a loop of its own**
   *(agent's call)*. Once `getMe` succeeds and the `connected` line is
   written, the `getMe` loop ends. The poller then calls the hook; when it
   resolves, the `getUpdates` loop starts as today. When it rejects or
   throws, the poller writes one line
   `{ kind: "telegram-attach-failed", error: <message> }` on the first
   failure only, waits the backoff (1 s doubling to 60 s, through the
   injected `sleep` when one is given) and calls the hook again, until it
   resolves or the service stops. No `getUpdates` is issued before the hook
   has resolved.

   Reasons, against the two other directions the issue leaves open:
   - *Log the rejection and go on to `getUpdates` without the channel.* That
     is the half-state spec 043 section 1 rules out ("There is no
     half-state"): the poller would confirm answer updates while the
     scheduler sends questions to the issue only, and a transient failure of
     an I/O hook would leave Telegram detached for the service's lifetime,
     the failure spec 043 was written to remove.
   - *Log the rejection and end the loop, as an authorization error does.*
     Same lifetime loss, for a failure that is not Telegram's.
   - Calling `getMe` again proves nothing new: the connection was just made.
     Retrying the hook alone, with the connect step's backoff and a line of
     its own kind, is what spec 042 did for the update handler (logged under
     its own kind, retried, not counted as a Telegram failure).
   Holding `getUpdates` until the hook resolves loses nothing: updates stay
   on Telegram's side, unconfirmed, until the loop reads them. The change is
   a few lines in one method, cheap to reverse; no ADR (design section 3,
   item 2).
2. **The AC-3 loop test runs the driver's pause.** Its first half pauses
   through `applyActions` with a `pause` action (which calls `pauseIssue`) on
   a claim while the poller is still connecting, and asserts the four
   outcomes of goal item 2. Its second half pauses through the same path
   after the hook has attached the channel and asserts the Telegram send.

## 2. Out of scope

- Any change to `getMe`'s retry, the `connecting`, `connected` and `off`
  lines, the `getUpdates` loop, its outage branch or the handler branch of
  spec 042.
- The production hook (`Scheduler.setTelegram` in
  `tools/scheduler/src/service/loop.ts` and its wiring in
  `tools/scheduler/bin/scheduler.ts`): unchanged; it cannot reject, so the
  service's behaviour today does not change.
- `pauseIssue`, `completePause` and `sendPausedQuestion`: the behaviour the
  test checks is correct today. If AC-3 or AC-4 fails against today's
  driver, the implementation fixes the driver within those functions.
- The reminder of a question paused before the connection (spec 043 AC-3's
  "including its reminder"): the issue does not ask for its test, and the
  reminder path reads `rec.telegram` the same way for a record with
  `telegram: null` as for one with no message.
- Re-sending to Telegram a question that was paused before the attach: spec
  007 AC-11 stands, as spec 043 section 2 says.
- The e2e tests of spec 007 that set the channel directly on the scheduler's
  deps: unchanged.

## 3. Acceptance criteria

"Given" states use the fake Telegram Bot API server of spec 007 section 6 and
the loop test harness of `tools/scheduler/test/loop.test.ts` (the mocked
GitHub API of spec 001). A *line* is one record passed to the poller's or the
driver's `log` callback.

- AC-1. **A rejecting hook is retried alone.** Given `getMe` succeeds and the
  attach hook rejects (or throws) on its first two calls and resolves on the
  third, when the poller runs, then the log holds exactly, in order, one
  `{ kind: "telegram", status: "connected", username: "test_bot" }` line and
  one `{ kind: "telegram-attach-failed", error: <the first rejection's
  message> }` line, and no `connecting`, `off`, `telegram-outage` or
  `telegram-recovered` line; the injected `sleep` is called with
  `[1000, 2000]`; the hook is called three times; the fake server's requests
  begin `getMe`, `getUpdates` (one `getMe` in all), with the `getUpdates`
  issued after the third hook call; and the `getUpdates` backoff starts at
  1 s as spec 043 AC-1 says.
- AC-2. **A stop while the hook is failing ends the loop.** Given `getMe`
  succeeds and the hook always rejects, when the poller is stopped during the
  wait after a rejection, then the wait ends, `stop()` resolves, the hook is
  not called again and no `getUpdates` request is made. A hook that keeps
  rejecting writes the `telegram-attach-failed` line once, however many times
  it is retried.
- AC-3. **A pause before the attach is a spec 006 question with
  `telegram: null`.** Given the loop harness with `deps.telegram` null and a
  poller whose `getMe` fails (at least one `connecting` line written, the
  hook not yet called), and a claim for an issue on disk, when the driver
  applies a `pause` action for that claim (`applyActions(deps, claim,
  [{ type: "pause", question, asking }])`, which runs `pauseIssue`), then:
  - the paused record for the issue has `telegram` strictly `null`
    (asserted with `toBeNull`, not a match on fields);
  - the question comment the mocked GitHub API received contains
    `@<cfg.maintainer>` and the spec 006 line `Reply in a comment on this
    issue; the scheduler resumes on your reply.`;
  - the questions log (`paths.questionsLog`) holds one `event: "sent"` entry
    for the issue, with `channel: "issue"` and no `telegram_message_id`;
  - no line of kind `telegram-send-failed` was passed to `deps.log`, and the
    fake server recorded no `sendMessage` request.
- AC-4. **A pause after the attach is a Telegram question.** Given the same
  harness after a poller whose `getMe` succeeds has called the hook (which
  sets the channel with `Scheduler.setTelegram`), when the driver applies a
  `pause` action for a second issue's claim the same way, then the fake
  server records one `sendMessage`, the second issue's paused record has
  `telegram.sent` true and a `message_id`, and the questions log holds a
  `sent` entry for that issue with `channel: "telegram"`. The first issue's
  record still has `telegram: null`.

## 4. Amendments to earlier specs

- Spec 043 AC-3 is marked `Amended by
  [090-telegram-attach-failure-and-pause-test](../090-telegram-attach-failure-and-pause-test/spec.md)
  AC-1: a hook that rejects is logged as `telegram-attach-failed` and called
  again with the connect backoff, without another getMe, and the channel
  counts as attached only once it resolves.`
- Spec 043 section 5 is marked, as a block quote under its heading, `Amended
  by [090-telegram-attach-failure-and-pause-test](../090-telegram-attach-failure-and-pause-test/spec.md)
  AC-1: the hook is called after the getMe loop, and retried alone until it
  resolves rather than invoked exactly once.`

The text of both stays as the record. Spec 043's other criteria hold as
written; its section 5 list for the loop test is what AC-3 and AC-4 here
check.

## 5. Interfaces and files

- `tools/scheduler/src/telegram/poller.ts`: in `loop()`, the `getMe` loop's
  `try` ends after the `connected` line (the hook call leaves it); a second
  loop after it calls `this.onConnected` (when one was given), catching a
  rejection or a synchronous throw, writing the `telegram-attach-failed`
  line on the first failure only (`error` is the `Error`'s message, or
  `String(e)` for a non-`Error`, as spec 042's handler line does), pausing
  with `this.pause` and a backoff of its own from 1 s doubling to 60 s, and
  returning when the service stops. The constructor's signature, the
  `getUpdates` loop and its branches are unchanged.
- `tools/scheduler/test/telegram.test.ts`, describe `Telegram poller connect
  step (spec 043)`: tests for AC-1 and AC-2; the `rig` helper gains a way to
  pass a hook that rejects. The existing connect-step tests keep their
  assertions.
- `tools/scheduler/test/loop.test.ts`, describe `Telegram attaches when
  connected (spec 043)`: the AC-3 test is rewritten to AC-3 and AC-4 above
  (one test or two), pausing through `applyActions` on claims written with
  `writeClaim`, with the harness's `deps.log` capturing lines; `pausing()` is
  kept only if another test still uses it. The AC-4 test of spec 043 (a tick
  completes while `getMe` is failing) is unchanged.
- `specs/043-telegram-connects-with-backoff/spec.md`: the two marks of
  section 4.

No file outside `tools/scheduler/` and `specs/` changes. No schema, config
key, state file format or stage prompt changes; the service log gains one
record kind, `telegram-attach-failed`, which only a failing hook writes.
`tools/scheduler/` is a sensitive path (`agents/sensitive-paths.txt`), so the
security review applies to the implementation PR (spec 006 AC-9).

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  with the tests of section 5.
- A grep of `tools/scheduler/src/telegram/poller.ts` shows the
  `onConnected` call outside any `try` whose `catch` mentions `getMe`.
- Manual mutations show the tests bite: moving the hook call back inside the
  `getMe` `try` fails AC-1 (a second `getMe` request and a `connecting`
  line); changing `pauseIssue`'s `telegram` field to build a record when
  `deps.telegram` is null fails AC-3's `toBeNull`; making
  `sendPausedQuestion` log `telegram-send-failed` when `deps.telegram` is
  null fails AC-3.

## 7. Open decisions

None.
