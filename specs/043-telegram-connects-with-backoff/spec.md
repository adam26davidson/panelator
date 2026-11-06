# 043. Telegram connects with the poller's backoff; only an authorization error turns it off

Status: written 2026-11-06 from the delivery-system design for issue #75;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Telegram": the scheduler holds a long-poll connection open at all
times) and section 10 ("Small work skips layers": a bug spec hangs directly
off a top design); [design-tree](../../docs/design-tree.md) R8.Q1 (a
persistent long-poller on the laptop is what makes the channel immediate);
[007-telegram-channel](../007-telegram-channel/spec.md), whose AC-1 and AC-2
this spec amends (marked as section 4 records) and whose AC-5 (a failed send
is retried once from the record, then the question waits on the issue
comment) and AC-11 (a question with no Telegram message is handled as
Telegram off until answered) it relies on and leaves alone;
[042-poller-handler-failure-is-not-an-outage](../042-poller-handler-failure-is-not-an-outage/spec.md),
whose `getUpdates` outage branch and handler branch it keeps.

## 1. Goal

A Telegram API that is not reachable at the moment the service starts does
not leave Telegram off for the service's lifetime. The connection check
retries with the backoff spec 007 AC-2 already gives the poller, and only an
authorization error turns Telegram off.

### What is wrong today

`startTelegram` (`tools/scheduler/src/service/telegram-start.ts`) reads the
credentials file, builds the client and calls `getMe` once. Any failure
returns null and logs `telegram: off`; the reason distinguishes an
authorization error (`getMe: unauthorized`) from everything else (`getMe:
connection failed`), but the effect is the same: `bin/scheduler.ts` builds
the `Scheduler` with `telegram: null` and never constructs the poller.
Nothing re-enters this path. Spec 007 AC-1 asks for "off" on an
authorization error only; AC-2's backoff from 1 to 60 s lives in the poller,
which is never started when `startTelegram` returned null.

So, with a valid credentials file, a service start while the network is
still coming up (the unit orders itself after `network-online.target`, which
does not promise that `api.telegram.org` resolves or answers), a short DNS or
Wi-Fi dropout, or a stop/start during one, runs the whole service with
Telegram off: every question goes to the issue only, the maintainer gets no
Telegram message, and nothing retries until someone restarts the service.

### The fix

The connection check moves into the poller, in front of its `getUpdates`
loop, where the backoff already is. `startTelegram` reads the credentials
and builds the channel but calls no Bot API method. The poller's loop
begins with a connect step: `getMe`, retried with the 1 s to 60 s backoff of
spec 007 AC-2 until it succeeds or returns an authorization error. Success
writes the `telegram: connected` line and starts the `getUpdates` loop; an
authorization error writes the `telegram: off` line once and ends the loop,
as spec 007 AC-1 promises; any other failure writes one `telegram:
connecting` line and keeps trying for as long as the service runs.

Until the connect step succeeds the scheduler has no channel: the
`Scheduler` is built with `telegram: null`, and the poller attaches the
channel when `getMe` succeeds. So a question raised before the connection is
made is a spec 006 question (issue comment with the mention), handled as
Telegram off until it is answered exactly as spec 007 AC-11 already says
for a question with no Telegram message. There is no half-state in which
the scheduler sends to a channel that is known not to work.

*(agent's call)* The check lives in the poller rather than in a retry loop
inside `startTelegram` because `startTelegram` is awaited before the
`Scheduler` is built: a backoff there would hold the GitHub tick and the
whole service hostage to Telegram's reachability, which spec 007 section 1
rules out ("without credentials, nothing changes"). Starting the channel
blind and leaving the first `getUpdates` to discover the outage was the
other direction the issue suggests; it loses the authorization check (a bad
token would be retried for ever as an outage), loses the `connected` line
with the bot's username that spec 007 section 8 step 5 tells the maintainer
to look for, and sends questions to a channel that is not yet known to
work. One `getMe` round trip per start is what the code does today. The
change is one loop and one attach hook, cheap to reverse; no ADR (design
section 3, item 2).

## 2. Out of scope

- A token that becomes invalid after the connection is made (a `getUpdates`
  or `sendMessage` authorization error mid-run): as today, the poller treats
  a `getUpdates` rejection as an outage with backoff (spec 007 AC-2, spec
  042 AC-3) and a failed send follows spec 007 AC-5. Turning the channel off
  on a later authorization error is a separate change.
- The credentials file missing or unreadable (spec 007 AC-1, first case):
  unchanged, `startTelegram` logs `telegram: off` with the reason and the
  poller is not constructed.
- `panelator-scheduler telegram-check` (spec 007 AC-4): unchanged, one
  `getMe` and one `sendMessage`, exit status by the result.
- Re-checking the connection after it has been made, or re-sending a
  question that was raised before the connection as a Telegram message:
  spec 007 AC-11's rule for a question with no Telegram message stands.
- The systemd unit (`tools/scheduler/systemd/panelator-scheduler.service`):
  its `After=`/`Wants=network-online.target` lines stay; they narrow the
  window and this spec closes it.
- How the handler branch, the outage branch and the offset of spec 007 AC-3
  and spec 042 work once the loop runs: unchanged.

## 3. Acceptance criteria

"Given" states use the fake Telegram Bot API server of spec 007 section 6
and the fake harness and mocked GitHub API of spec 001. The service log is
the `log` callback the poller and `startTelegram` are given; a *line* is one
record. "Telegram on" in spec 007 now means: the credentials file is present
and readable and the connect step of AC-1 has succeeded.

- AC-1. **The connection check runs in the poller and retries.** Given the
  credentials file is present and readable, when the service starts, then
  `startTelegram` returns the channel without calling any Bot API method
  (the fake server records no request), the `Scheduler` is built with
  `telegram: null`, and the poller is constructed and started. The poller's
  loop begins with a connect step before its first `getUpdates`: it calls
  `getMe`. Given `getMe` succeeds, then the poller writes one line
  `{ kind: "telegram", status: "connected", username: <bot username> }`,
  attaches the channel to the scheduler (AC-3), and enters the `getUpdates`
  loop of spec 007 AC-2 with its backoff at 1 s. Given `getMe` rejects with
  an error that is not an authorization error (a network, DNS, timeout or
  5xx failure), then the poller writes one line
  `{ kind: "telegram", status: "connecting", reason: "getMe: connection failed" }`
  on the first failure only (later failures before the connection is made
  write nothing), waits the backoff (1 s, doubling to a ceiling of 60 s,
  through the injected `sleep` when one is given so the test asserts the
  waits), and calls `getMe` again, for as long as the service runs; the
  connected line follows the success, and the waits are not counted toward
  the `getUpdates` backoff, which starts at 1 s. No `telegram-outage` and no
  `telegram-recovered` line is written for a `getMe` failure. The token is
  never written to the service log (the lines above carry no error text;
  the client's errors do not contain it, as spec 007 AC-1 asserts). Given
  the service stops during a wait, then the wait ends and the loop exits,
  as the backoff sleep does today, with no `getUpdates` issued.
- AC-2. **Only an authorization error turns Telegram off.** Given `getMe`
  rejects with an authorization error (`isAuthError` in
  `tools/scheduler/src/telegram/client.ts`: a Bot API error with code 401
  or 404), whether on the first call or after any number of connecting
  retries, then the poller writes one line
  `{ kind: "telegram", status: "off", reason: "getMe: unauthorized" }`,
  issues no `getUpdates`, and its loop ends (`stop()` resolves at once; the
  process is not exited). The channel is never attached, so every behaviour
  of spec 006 stays as it is for the rest of the service's life, as spec
  007 AC-1 promises. The log line is written once per service start.
- AC-3. **The channel is attached when connected, and not before.** Given
  the poller is still connecting (AC-1, no connected line yet) and a pause
  completes (spec 006 AC-13), then the question is sent as with Telegram
  off: the spec 006 issue comment with the mention, `channel: issue` in the
  questions log, no Telegram send attempted and no `telegram-send-failed`
  line; its paused record has `telegram: null`, so it is handled as
  Telegram off until it is answered (spec 007 AC-11), including its
  reminder. Given the connected line has been written and a pause then
  completes, then the question is sent to Telegram as spec 007 AC-5 says.
  The attach is the poller's doing (a hook called once after `getMe`
  succeeds; the exact signature is the plan's) and the e2e and loop tests
  that set the channel directly on the scheduler's deps keep working
  unchanged.
- AC-4. **The service does not wait for Telegram.** Given the credentials
  file is present and `getMe` is failing, when the service starts, then the
  `Scheduler` is constructed and its first tick runs without waiting for the
  connect step: in a test with the fake server failing `getMe`, `tick()`
  completes while the poller is still connecting. The `--once` command
  behaves as today (the poller is started with the service and stopped
  after the tick; whether it connected in that time changes nothing about
  the tick's output).

## 4. Amendments to earlier specs

- Spec 007 AC-1 is marked `Amended by
  [043-telegram-connects-with-backoff](../043-telegram-connects-with-backoff/spec.md)
  AC-1`: the `getMe` check runs in the poller, retried with the AC-2
  backoff; only an authorization error turns Telegram off, as its text
  says, and a connection failure is logged once as `telegram: connecting`
  and retried. Its sentences about the missing or unreadable file and
  about the token never being logged are unchanged in effect.
- Spec 007 AC-2 is marked `Amended by
  [043-telegram-connects-with-backoff](../043-telegram-connects-with-backoff/spec.md)
  AC-1`: the poller's loop starts with the `getMe` connect step, and the
  1 s to 60 s backoff it describes also paces that step; the "Telegram on"
  it is given now includes that the connect step has succeeded (section 3
  preamble). The outage and recovery lines stay for a `getUpdates` error
  only (spec 042 AC-3).

The text of both criteria stays as the record. Nothing else in spec 007
changes: AC-3 to AC-15 and section 8 (the maintainer's setup steps, whose
step 5 still ends with the `telegram: connected` line) hold as written.

## 5. Interfaces and files

- `tools/scheduler/src/telegram/poller.ts`: `loop()` gains the connect step
  of AC-1 and AC-2 before the `while` loop: `getMe` in a loop of its own,
  with the same `pause` and doubling backoff as the outage branch, writing
  the `connected`, `connecting` and `off` lines of kind `telegram`, calling
  the attach hook on success and returning (ending the loop) on an
  authorization error. The constructor gains an optional hook invoked once
  after `getMe` succeeds (the plan chooses its exact form; an options object
  is acceptable given the constructor's seven positional parameters, as long
  as the existing call sites and tests need no change beyond the new hook).
  The `getUpdates` loop, its outage branch and the handler branch of spec
  042 are unchanged.
- `tools/scheduler/src/service/telegram-start.ts`: `startTelegram` reads the
  credentials, logs `telegram: off` with the reason when they are missing or
  unreadable, and otherwise returns `telegramChannel(client)` without calling
  `getMe`; `isAuthError` is no longer imported here. `telegramCheck` is
  unchanged.
- `tools/scheduler/bin/scheduler.ts`: builds the `Scheduler` with
  `telegram: null`; when `startTelegram` returned a channel, constructs the
  poller with a hook that attaches that channel to the scheduler (AC-3) and
  starts it. Stop and restart handling of the poller unchanged.
- `tools/scheduler/src/service/loop.ts`: a way to attach the channel after
  construction (for example a `setTelegram(channel)` method that sets
  `deps.telegram`, which every use already reads at call time); nothing
  else changes.
- `tools/scheduler/test/service-helpers.test.ts`: the startup test asserts
  that `startTelegram` makes no Bot API request for a readable credentials
  file and returns a channel, keeps the missing-file case, and keeps the
  no-token-in-the-log assertion; the `getMe` 401 case moves to the poller
  test.
- `tools/scheduler/test/telegram.test.ts`: tests for AC-1 (`getMe` rejected
  twice, then succeeds: the one `connecting` line, waits `[1000, 2000]`,
  then the `connected` line with `test_bot`, the attach hook called once,
  then the first `getUpdates`; the request order on the fake server is
  `getMe`, `getMe`, `getMe`, `getUpdates`; no outage or recovered line),
  AC-2 (`getMe` 401: the one `off` line, no `getUpdates` request, `stop()`
  resolves; the same after a connecting retry), and the AC-1 stop case (a
  stop during the connecting wait issues no `getUpdates`). The existing
  outage and handler tests are updated for the connect step (one `getMe`
  request before the first `getUpdates`, the `connected` line first in the
  log) and otherwise keep their assertions.
- `tools/scheduler/test/loop.test.ts` or `e2e.test.ts`: AC-3 (a pause that
  completes with no channel attached is a spec 006 question with
  `channel: issue` and `telegram: null` in its record; after the attach the
  next question is sent to Telegram) and AC-4 (a tick completes while
  `getMe` is failing).
- `specs/007-telegram-channel/spec.md`: the two marks of section 4.

No file outside `tools/scheduler/` and `specs/` is changed. `tools/scheduler/`
is a sensitive path, so the security review runs on the implementation PR as
spec 006 AC-9 says. No schema, config key, stage prompt, state file format or
systemd unit changes: `telegram/offset.json` keeps its shape, and the three
`kind: "telegram"` status lines are the service-log records
`telegram-start.ts` writes today plus one new `status` value, `connecting`.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  with the tests of section 5 added.
- A grep of `tools/scheduler/src/service/telegram-start.ts` shows `getMe`
  only inside `telegramCheck`; a grep of
  `tools/scheduler/src/telegram/poller.ts` shows the strings
  `telegram-outage` and `telegram-recovered` only in the branch that handles
  a `getUpdates` rejection (spec 042 section 6).
- Every recorded end-to-end chain of spec 007 section 6 passes unchanged:
  they attach the channel directly on the scheduler's deps, which is the
  state the connect step reaches.
- After the service is restarted on the merged code with the credentials in
  place, the service log shows the `telegram: connected` line (spec 007
  section 8 step 5); the implement stage quotes it in the PR, or, where the
  laptop is not available to the stage, says so.

## 7. Open decisions

None.
