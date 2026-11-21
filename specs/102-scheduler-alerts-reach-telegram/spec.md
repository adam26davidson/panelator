# 102. Scheduler alerts reach the maintainer on Telegram, not only the service log

Status: written 2026-11-21 from the delivery-system design for issue #253;
specs derived from that design need no maintainer approval (design section
11). Amends [001-scheduler-core](../001-scheduler-core/spec.md) AC-27,
[030-beyond-github](../030-beyond-github/spec.md) AC-9, [068-beyond-github-aws-and-events](../068-beyond-github-aws-and-events/spec.md)
AC-4, [099-beyond-github-rest-on-the-credential-store](../099-beyond-github-rest-on-the-credential-store/spec.md)
AC-6 and [100-host-outage-pauses-scheduler](../100-host-outage-pauses-scheduler/spec.md)
AC-4, marked as section 4 records.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Telegram carries questions, credential and fund requests,
first-contact requests, alerts and reminders") and section 3 (what reaches
the maintainer is a question only when it is one of the three kinds; an
alert asks nothing); [001-scheduler-core](../001-scheduler-core/spec.md)
AC-27 and section 15 (the notification interface, its identity and its v0
log implementation); [007-telegram-channel](../007-telegram-channel/spec.md)
AC-5 and AC-11 (the question and the reminder already reach the chat by
their own path, with their own retry); [043-telegram-connects-with-backoff](../043-telegram-connects-with-backoff/spec.md)
AC-3 and [090-telegram-attach-failure-and-pause-test](../090-telegram-attach-failure-and-pause-test/spec.md)
AC-1 (the channel is attached once the poller connects, and not before);
[099-beyond-github-rest-on-the-credential-store](../099-beyond-github-rest-on-the-credential-store/spec.md)
AC-6 and AC-7 (the sink this spec builds on: one chat message per
notification, the alert ids, a reply to an alert is not an answer; its
section 2 leaves holding, collapsing and the choice of gates to this issue);
[068-beyond-github-aws-and-events](../068-beyond-github-aws-and-events/spec.md)
AC-4 (the `maintainer.contact` event names the channel that carried the
notification); [072-plain-credential-file-reminder](../072-plain-credential-file-reminder/spec.md)
AC-4 (a reminder that sends its own chat message before it notifies);
[100-host-outage-pauses-scheduler](../100-host-outage-pauses-scheduler/spec.md)
AC-5 (the long pause's one `infra` notification); [086-scheduler-records-use-their-schemas](../086-scheduler-records-use-their-schemas/spec.md)
(a new state file has a schema and is validated on read and write).

## 1. Goal

Every scheduler alert that matters reaches the maintainer's phone, once, and
is not lost while Telegram is down.

### What is wrong today (spec agent's reading of the code and the live log, 2026-11-21)

Spec 099 AC-6 made the service's notifier
`rateLimited(recordedNotifier(TelegramNotifier(LogNotifier)))`
(`tools/scheduler/bin/scheduler.ts`): every notification that passes the
four-hour limiter is written to `log/service.jsonl` and sent to the chat as
one message. Three gaps remain, two of which the issue lists and one it
causes:

- **A notification is dropped when the chat cannot take it.** The
  `TelegramNotifier` (`tools/scheduler/src/notify/telegram.ts`) sends only
  while the poller has attached the channel (`attachedTelegram` is `null`
  for the first seconds of every process, and for the whole process when
  `getMe` fails with the authorization error of spec 043 AC-2, which issue
  #186 showed a captive portal can cause). A send that fails is logged once
  per outage and never retried (spec 099 AC-6: "nothing is retried"). The
  filer's 32 identical `spawn E2BIG` failures between 2026-11-12T07:18Z and
  2026-11-17, and the abandonments of #101, #103 and #116, were raised
  before spec 099 landed and reached only the log; under spec 099 an alert
  raised during a network outage, or in the seconds after a restart (the
  service restarts on every merge that touches `tools/scheduler/`), still
  does.
- **Repeats are collapsed for four hours only, and the record is lost on
  restart.** `rateLimited` (`tools/scheduler/src/notify/rate-limit.ts`)
  keeps its `sent` map in memory, so every restart forgets it, and lets an
  identical notification through every `notify_rate_limit_hours` (4). An
  agent that fails on every run of a four-hour schedule sends a message
  every run.
- **Two paths now deliver the same thing twice.** The question (spec 007
  AC-5), the 24-hour reminder (spec 007 AC-11) and the plain-file reminder
  (spec 072 AC-4) each send their own chat message and then call the
  notifier, which since spec 099 sends a second one.

### The fix

One notifier chain, the same shape as today, with three changes:

1. **Which gates reach the chat.** Every notification goes to the chat
   except one whose delivery to the chat another path already makes: gates
   `question` and `question-reminder` (spec 007 AC-5 and AC-11, with their
   own retry from the paused record) and gate `credential` with label
   `plain-files` (spec 072 AC-4, which retries hourly). The log line and the
   `maintainer.contact` event are written for those as today. This covers
   what the issue asks for (`abandoned`, `standing`, `chain_error`, `infra`
   including spec 100 AC-5's long pause, label `host`) and everything the
   code sends later, with no list to keep current.
2. **A held queue.** A notification the chat should carry but cannot take
   now (the channel not attached, or the send failing) is appended to a
   persistent queue and sent, oldest first, by the first tick that finds the
   channel attached and the send working. With Telegram not configured at
   all nothing is queued: the log is the channel, as today.
3. **Collapse until cleared, with a daily repeat.** The limiter becomes a
   persistent collapser keyed by spec 001 AC-27's identity
   (`issue:gate:label`): the first notification of an identity is sent, the
   next ones are suppressed until the condition clears or
   `notify_reminder_hours` (24) pass, and a repeat says that it is one. The
   code that knows a condition has cleared says so through a new
   `Notifier.clear` call: a standing agent's successful run, the host
   monitor's resume, a chain's end, and the AWS forecast dropping back under
   its cap.

*(agent's call)* The exclusion is by the delivering path, not an allow-list
of gates: spec 030 AC-9's rule that every gate reaches the chat stands, so a
gate added later needs nothing, and the only question is whether some other
path already sent it. The queue holds notifications only while Telegram is
configured: with no credentials nothing will ever drain it in this process,
and spec 099 AC-6's "today's chain" is the right reading of "Telegram off".
The collapser replaces the four-hour window rather than sitting beside it:
two windows on the same identity are one window with the longer bound, and
the issue's "once, then not again until the condition clears or a long
interval passes" is that bound. Clearing is explicit because the notifier
cannot tell from a notification that its condition ended, and the senders
that repeat already have the state that says so (`failures`, `paused`,
`notices`). Nothing here is costly to reverse; no ADR.

## 2. Out of scope

- The question path itself: what spec 007 sends, its one retry from the
  paused record (loop.ts `send_failures`), and a question whose Telegram
  send failed twice (it stands on the issue comment, as spec 007 AC-5 says).
- Spec 072 AC-4's own message, its hourly retry and its state file.
- The service log's `telegram-send-failed` line for a question (spec 007
  AC-5) and the poller's connect, attach and recovery logging (specs 043,
  090). Issue #186's classification of a non-JSON 401 or 404 (spec 089).
- Spec 022's AWS ledger window (`AwsContext.notifyHours` from
  `notify_rate_limit_hours`), which is that spec's own.
- A Telegram command that lists held or collapsed alerts; the console's view
  of them.
- The text of any notification other than the lines this spec appends to a
  late or repeated one. The senders' own once-per-condition flags (spec 015
  AC-8's and spec 045 AC-5's `outage.notified`, spec 100 AC-5's `notified`,
  spec 022's `notices`) stay; the collapser is the backstop behind them.
- A `maintainer.contact` event for the later delivery of a held
  notification: one notification is one contact, recorded when it is
  raised, with `channel: queued`.

## 3. Acceptance criteria

"Given" states use the fake Telegram server of
`tools/scheduler/test/helpers/fake-telegram.ts` and the notify tests'
recorder, as spec 099 AC-6's tests do. *Telegram configured* means
`startTelegram` returned a channel (credentials present): the notifier's
`deps.configured` is true. *Attached* means the poller's hook has set the
channel (`deps.telegram()` non-null; spec 043 AC-3, spec 090 AC-1). The
*identity* of a notification is `issue:gate:label` (spec 001 AC-27,
`identity()` in `rate-limit.ts`).

- AC-1. **A gate another path delivers is not sent twice.** `sentByOwnPath(n)`
  in `tools/scheduler/src/notify/telegram.ts` returns true for gate
  `question`, gate `question-reminder`, and gate `credential` with label
  `plain-files`, else false. Given Telegram configured and attached, when
  such a notification is notified, then no chat message is sent and nothing
  is queued; the log line is written with `channel: log` and `notify`
  resolves `{ channel: "log" }`, so the recorder's event says `log` as
  today. Given any other gate (`abandoned`, `standing`, `chain_error`,
  `infra` with label `host` and with `contact-scope`, `credential-expiry`,
  `aws`, `spec-present`), then it is sent as spec 099 AC-6 says. Tests
  cover the three excluded cases and `infra`/`host`.
- AC-2. **A notification the chat cannot take is held, then delivered.**
  Given Telegram configured and not attached, or attached and the send
  rejecting, when a notification that AC-1 does not exclude is notified,
  then it is appended to `state/notify/queue.json` (schema
  `schemas/scheduler/notify-queue.json`, validated on read and write as spec
  086 requires; an entry is `{ id, at, issue, gate, label, text, repeat? }`
  with `at` the time it was raised and `id` a UUID), the log line is written
  with `channel: queued`, `notify` resolves `{ channel: "queued" }`, and on a
  rejected send `telegram-send-failed` is logged once per outage as today.
  `flush()` on the notifier sends the queue oldest first through
  `channel.sendReply`, each as spec 099 AC-6's message with the line `Raised
  <at>, delivered late.` appended; each sent entry is removed from the file
  before the next is tried, its message id joins `telegram/alerts.json`
  (spec 099 AC-7), and `{ kind: "notify-flushed", id, gate, label, at }` is
  logged; the first rejected send stops the flush and leaves the entry. The
  scheduler's tick calls `flush()` once, after its Telegram-reply audit and
  before any claim is read, when the channel is attached and the file is
  non-empty; a paused tick (spec 100 AC-3) does not. Given Telegram not
  configured (`configured` false), then nothing is queued and the chain is
  spec 099 AC-6's "Telegram off" case, `channel: log`. The file keeps at
  most `QUEUE_KEPT` (200) entries: appending the 201st drops the oldest with
  `{ kind: "notify-queue-dropped", id, gate, label, at }` logged. The queue
  survives a restart: given a file with two entries written by another
  process, when the first tick with the channel attached runs, then both
  are sent in order. Tests: not attached then attached (two ticks); attached
  with the send failing twice then working (one `telegram-send-failed`, both
  entries sent on the tick after recovery, in order); not configured; the
  cap.
- AC-3. **Repeats collapse until cleared or a day passes.** `collapsed(inner,
  { path, reminderHours, clock })` in `tools/scheduler/src/notify/rate-limit.ts`
  replaces `rateLimited` (removed, its tests rewritten). It keeps
  `state/notify/sent.json` (schema `schemas/scheduler/notify-sent.json`): a
  map from identity to `{ first_at, last_at, suppressed }`. Given an identity
  with no entry, when notified, then the inner is called and the entry is
  written after it resolves (a crash in between repeats the notification
  rather than losing it). Given an entry whose `last_at` is less than
  `reminderHours` ago, then the inner is not called, `suppressed` is one
  more, and `notify` resolves `{ channel: "suppressed" }` (no log line, no
  event, as today's limiter). Given an entry `reminderHours` or more old,
  then the inner is called with `repeat: { first_at, suppressed }` set on
  the notification, `last_at` becomes now and `suppressed` 0; the
  `TelegramNotifier` appends the line `Repeat: first raised <first_at>,
  <suppressed> more since.` to the chat text (and to a queued entry's text
  when it is held) and the log line carries `repeat`. `reminderHours` is
  the new config key `notify_reminder_hours` (default 24, `agents/scheduler.yaml`);
  `notify_rate_limit_hours` stays for spec 022's ledger only. Entries older
  than 30 days are dropped on write. Tests: the filer's case (one identity
  notified eight times across 30 hours of fake clock: two inner calls, the
  second with `repeat.suppressed` 6, the chat text ending with the repeat
  line); a different issue, gate or label is a different identity; the
  entry survives a new `collapsed` over the same file (a restart within the
  day sends nothing).
- AC-4. **Clearing.** `Notifier` gains `clear(selector): Promise<void>`
  with `selector` `{ issue?: number; gate?: string; label?: string;
  labelPrefix?: string }`: the collapser removes every entry whose identity
  matches every field given (`labelPrefix` by prefix), and logs nothing;
  `recordedNotifier`, `TelegramNotifier` and `LogNotifier` forward or ignore
  it. Given an identity cleared, when it is notified again, then it is sent
  as a first notification (no `repeat`). The callers:
  - the standing runner (`tools/scheduler/src/standing/run.ts`), on a run
    whose outcome is `ok`, clears `{ issue: 0, gate: "standing", labelPrefix:
    "<name>:" }` and `{ issue: 0, gate: "infra", label: "<name>:outage" }`;
  - the host monitor (`tools/scheduler/src/service/host.ts`), when the probe
    passes and the pause ends (spec 100 AC-4), clears `{ issue: 0, gate:
    "infra", label: "host" }` before the `host-resumed` line;
  - the driver's `done` action (`tools/scheduler/src/chain/driver.ts`), for a
    chain that merged and for one that was abandoned, clears `{ issue:
    claim.issue }` after the release is recorded, so a later chain of the
    same issue (re-triage, a new claim) notifies afresh;
  - the AWS judge (`tools/scheduler/src/aws/cost.ts`), before the "back under
    the cap" `aws-forecast` notification, clears `{ issue: 0, gate: "aws",
    label: "aws-forecast" }`, so the recovery is not collapsed into the
    alarm it ends.
  Tests: the standing runner's ok run clears both identities and a later
  failure notifies; the host resume clears `host` and a second pause two
  hours later notifies (spec 100 AC-5's `notified` is per pause and already
  sends; the test asserts the collapser does not suppress it); a chain's
  `done` clears its `chain_error`; the AWS recovery message is sent one hour
  after the alarm.
- AC-5. **The wiring and the record.** `tools/scheduler/bin/scheduler.ts`
  builds `collapsed(recordedNotifier(TelegramNotifier(LogNotifier)))` with
  `TelegramNotifier`'s deps gaining `configured: telegram !== null`,
  `queuePath: paths.notifyQueue` and `now`, and `collapsed` taking
  `paths.notifySent` and `cfg.notify_reminder_hours`. `NotifyResult.channel`
  is `"telegram" | "log" | "queued" | "suppressed"`; the `maintainer.contact`
  event's `channel` records `queued` for a held notification (spec 068
  AC-4's hook, the enum of `schemas/scheduler/event.json` if it has one
  gains the value); `Notification` gains the optional `repeat`. The
  `AwsContext` notifier and the sweep's, driver's, host monitor's and
  standing runner's `notifier` are the same chain. `paths.notifyQueue`
  (`notify/queue.json`) and `paths.notifySent` (`notify/sent.json`) are
  added to `StatePaths` and their directory to `ensureStateDirs`.
- AC-6. **Live case end to end.** A recorded world of
  `tools/scheduler/test/helpers/e2e-routes.ts` with Telegram configured:
  the poller attaches on the second tick; a standing agent fails twice on
  the first tick (its `standing` notification is queued, `channel: queued`
  in the log line and the event), fails again on three later ticks within a
  day (three `suppressed`, nothing sent, nothing queued), the second tick
  flushes the one held message with its `Raised ... delivered late.` line,
  the agent succeeds on the fifth tick (cleared), fails twice again on the
  sixth (sent at once, no `repeat`, one chat message); across the whole run
  the chat holds exactly two alert messages from this agent, and a paused
  question in the same world produces one question message and no alert
  message for its `question` notification.

## 4. Amendments to earlier specs

- Spec 001 AC-27 is marked `Amended by [102-scheduler-alerts-reach-telegram](../102-scheduler-alerts-reach-telegram/spec.md)
  AC-3`: identical notifications are collapsed to one until the condition
  clears or `notify_reminder_hours` pass, the record persisted across
  restarts.
- Spec 030 AC-9 is marked `Amended by [102] AC-1`: a notification whose
  delivery to the chat another path already makes is not sent again.
- Spec 068 AC-4 is marked `Amended by [102] AC-2 and AC-5`: `notify` also
  resolves `queued` for a held notification, and the outer wrapper is the
  collapser.
- Spec 099 AC-6 is marked `Amended by [102] AC-1, AC-2 and AC-3`: the gates
  of AC-1 are not sent to the chat; a notification the chat cannot take is
  held and delivered when it can; the four-hour limiter is the collapser.
- Spec 100 AC-4 is marked `Amended by [102] AC-4`: the resume also clears
  the pause's notification identity.
- Spec 007 AC-5 and AC-11 and spec 072 AC-4 are not changed: their own
  sends stand, and this spec only stops the second message.

## 5. Interfaces and files

- `tools/scheduler/src/notify/types.ts`: `Notification.repeat?`,
  `NotifyResult.channel` with `queued`, `Notifier.clear(selector)` and
  `Notifier.flush?()` (AC-2 to AC-5).
- `tools/scheduler/src/notify/telegram.ts`: `sentByOwnPath`, `QUEUE_KEPT`,
  the queue (`readQueue`, `appendQueued`), `flush`, the late and repeat
  lines, `configured` (AC-1, AC-2, AC-3).
- `tools/scheduler/src/notify/rate-limit.ts`: `collapsed` replacing
  `rateLimited`; `identity` kept (AC-3, AC-4).
- `tools/scheduler/src/notify/recorded.ts`, `log.ts`: forward `clear` and
  `flush`; the log line's `repeat` (AC-3, AC-4).
- `schemas/scheduler/notify-queue.json`, `schemas/scheduler/notify-sent.json`
  (new); `schemas/scheduler/event.json` only if `channel` is enumerated
  (AC-2, AC-3, AC-5).
- `tools/scheduler/src/state/paths.ts`: `notifyQueue`, `notifySent` (AC-5).
- `tools/scheduler/src/config.ts`, `agents/scheduler.yaml`:
  `notify_reminder_hours` (AC-3).
- `tools/scheduler/src/service/loop.ts`: the tick's `flush()` call (AC-2).
- `tools/scheduler/src/standing/run.ts`, `tools/scheduler/src/service/host.ts`,
  `tools/scheduler/src/chain/driver.ts`, `tools/scheduler/src/aws/cost.ts`:
  the `clear` calls (AC-4).
- `tools/scheduler/bin/scheduler.ts`: the wiring (AC-5).
- Tests: `tools/scheduler/test/notify.test.ts` (AC-1 to AC-4),
  `standing.test.ts`, `host.test.ts` or `loop.test.ts`, `driver.test.ts`,
  `aws.test.ts` (AC-4's callers), `schema.test.ts` (the new schemas),
  `e2e.test.ts` (AC-6).
- Marks of section 4 on `specs/001-scheduler-core/spec.md`,
  `specs/030-beyond-github/spec.md`,
  `specs/068-beyond-github-aws-and-events/spec.md`,
  `specs/099-beyond-github-rest-on-the-credential-store/spec.md` and
  `specs/100-host-outage-pauses-scheduler/spec.md`.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `docs/delivery-system-design.md` are
sensitive paths; the security review applies to the implementation PR (spec
006 AC-9). Nothing here changes the sensitive-path list, the security
criteria, or what routes a sensitive diff to the security review. No stage
prompt or stage definition changes. The chat messages carry the
notification's own text to the configured chat, as spec 099 AC-6's do; no
new outside party is contacted and no secret is written to the queue (a
notification's text never holds one today, and the queue is a file in the
state directory beside the service log that already holds the same text).

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the tests
  of section 5 added.
- AC-3's filer case fails on `main` before the change (eight inner calls
  with a restart between any two, or two with none) and passes after it;
  AC-2's not-attached case fails on `main` (the notification resolves `log`
  and is never sent) and passes after it; AC-1's `question` case fails on
  `main` (two chat messages) and passes after it.
- A grep of `tools/scheduler/src` and `bin` shows no `rateLimited` and one
  construction of the notifier chain.
- Live check after deploy: stop the network, run `panelator-scheduler agent
  run findings-filer` against a prompt that fails, restore the network; the
  chat gets one message with `Raised ... delivered late.` on the next tick,
  and the service log shows one `notify` line with `channel: queued`, one
  `telegram-send-failed` or none, and one `notify-flushed`. Let the agent
  fail on its next scheduled run: nothing in the chat, `suppressed` in the
  log's tick summary is not required, and `state/notify/sent.json` shows the
  entry with `suppressed` 1.

## 7. Open decisions

None.
