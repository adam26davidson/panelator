# 102. Scheduler alerts reach the maintainer on Telegram: queued through an outage, collapsed per condition, and never sent twice

Status: written 2026-11-21 from the delivery-system design for issue #253;
specs derived from that design need no maintainer approval (design section
11). Builds on the `TelegramNotifier` that spec 099 landed on `main` on
2026-11-21 (spec 030 AC-9 as spec 068 AC-4 amended it), which was not there
when the issue was filed. Amends [030-beyond-github](../030-beyond-github/spec.md)
AC-9 (a notice the chat cannot take is queued and delivered later, and the
question gates do not go to the chat), [001-scheduler-core](../001-scheduler-core/spec.md)
AC-27 (the collapsing of identical notifications: the window, the reminder,
the record that survives a restart, and the clearing of a condition) and
[072-plain-credential-file-reminder](../072-plain-credential-file-reminder/spec.md)
AC-4 (the reminder reaches the chat through the notifier alone), each marked
as section 4 records. *(agent's call)*
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Telegram carries questions, credential and fund requests,
first-contact requests, alerts and reminders"; "The maintainer is reached on
Telegram"), section 6.1 (the standing agents and the scheduler as the thing
that notices them failing), section 3 item 2 (a decision with one clearly
right answer is the agent's) and section 10 ("Small work skips layers");
[001-scheduler-core](../001-scheduler-core/spec.md) AC-27 (one notification
per gate failure, identical ones rate-limited) and section 15 (the
`notify` interface, "v0 implementation appends to the service log");
[030-beyond-github](../030-beyond-github/spec.md) AC-9 (every notification
reaches the chat as one message headed by gate and label; a failed send is
logged once per outage and nothing is retried) and AC-10 (a reply to an
alert is not an answer); [068-beyond-github-aws-and-events](../068-beyond-github-aws-and-events/spec.md)
AC-4 (`notify` resolves to the carrying channel; the wiring order
`rateLimited(recordedNotifier(TelegramNotifier(LogNotifier)))`);
[099-beyond-github-rest-on-the-credential-store](../099-beyond-github-rest-on-the-credential-store/spec.md)
section 1 (built the `TelegramNotifier`, `telegram/alerts.json` and the
alert-reply handling); [007-telegram-channel](../007-telegram-channel/spec.md)
AC-1 and AC-2 as [043-telegram-connects-with-backoff](../043-telegram-connects-with-backoff/spec.md),
[089-non-json-auth-status-is-not-auth-error](../089-non-json-auth-status-is-not-auth-error/spec.md)
and [090-telegram-attach-failure-and-pause-test](../090-telegram-attach-failure-and-pause-test/spec.md)
amended them (Telegram off, `connecting`, and the attach hook that makes
the channel available to the scheduler); [100-host-outage-pauses-scheduler](../100-host-outage-pauses-scheduler/spec.md)
AC-5 (one notice for a long pause, gate `infra`, label `host`, nothing on
resume); [072-plain-credential-file-reminder](../072-plain-credential-file-reminder/spec.md)
AC-4 (the weekly reminder, sent on Telegram and then through the notifier:
issue #139's one notice that should reach the chat once);
[026-event-store](../026-event-store/spec.md) AC-2 (the `maintainer.contact`
event beside each send); [020-failure-finding-does-not-wake-its-agent](../020-failure-finding-does-not-wake-its-agent/spec.md)
and [093-scheduler-failure-findings-name-their-cause](../093-scheduler-failure-findings-name-their-cause/spec.md)
(the `standing agent <name> failed twice` finding and its notification);
[019-filer-collapses-identical-records](../019-filer-collapses-identical-records/spec.md)
(the precedent: identical records collapse into one with a count).

## 1. Goal

An alert the scheduler raises reaches the maintainer. Since spec 099 every
notification is sent to the Telegram chat when the channel is up; this spec
closes the three gaps the issue names, each of which would have silenced the
filer outage of 2026-11-12 to 2026-11-17 again:

- a notice raised while Telegram is off, connecting or failing is written to
  the service log and then lost to the chat (spec 030 AC-9: "nothing is
  retried"). It is now queued and delivered when the channel is back;
- a condition that recurs, such as a standing agent failing on every run,
  notifies once per 4 hours for as long as it lasts, and again after every
  restart of the service, with a label that carries the whole error text so
  that two failures with different wording are two conditions. It now
  notifies once, then once a day as a reminder that names the repeats, until
  it clears, and the record survives a restart;
- a question, a question reminder and the plain-file reminder reach the
  chat on their own path and then again as a notification. Each now reaches
  the chat once.

A notice stays informational: it asks nothing of the maintainer, carries no
buttons, and a reply to it is handled as spec 030 AC-10 says. The service
log line is written for every notification as it is today, so the log stays
the record.

### What the code does today (spec agent's reading, 2026-11-21)

`tools/scheduler/bin/scheduler.ts` wires
`rateLimited(recordedNotifier(TelegramNotifier(LogNotifier)))` with
`notify_rate_limit_hours: 4` from `agents/scheduler.yaml`. The
`TelegramNotifier` (`src/notify/telegram.ts`) reads the attached channel
through a getter that the poller's attach hook sets after `getMe`
succeeds; with no channel, or a send that throws, it writes the log line
with `channel: log` and returns. `rateLimited` (`src/notify/rate-limit.ts`)
keys on `issue:gate:label` in a `Map` that lives in the process.
`src/standing/run.ts` notifies a standing agent's second failure through
`filer.notify(text)` with no key, so the label is
`<agent>:Standing agent <agent> failed twice: <error>`. The question path
sends the question (`sendPausedQuestion`) and the reminder
(`telegram.sendReply` in `src/service/loop.ts`) itself and then calls
`notifier.notify` with gates `question` and `question-reminder`;
`src/credentials/plain-files.ts` sends its reminder with
`telegram.sendReply` and then notifies with gate `credential`.

## 2. Out of scope

- The content of any notification, which gates notify, and the chain
  effects that raise them (spec 001 AC-27, spec 006, spec 100 AC-5): this
  spec changes one label (AC-3) and nothing else about what is said.
- The question path (spec 007): how a question or a reminder is sent,
  retried or acknowledged on Telegram is unchanged; this spec only stops
  the notifier from sending them a second time.
- The poller's connect, backoff, off and attach behaviour (specs 043, 089,
  090). A Telegram turned off for the life of the process by a
  misclassified error (#186) is the poller's bug; here it only means the
  queue is delivered after the next restart that connects.
- The `maintainer.contact` event and its schema (spec 026 AC-2, spec 068
  AC-4): a queued notice is recorded once, when it is raised, with the
  channel that carried it then; its later delivery is a service-log line,
  not a second event.
- A digest, a daily summary, or any message the scheduler sends without a
  notification behind it. A "recovered" message when a condition clears:
  the issue does not ask for one, and a notice is for something that needs
  the maintainer's attention.
- The findings filer, infra health and the `failed twice` finding (specs
  019, 064, 093): unchanged.
- The console (spec 005) and the question log.

## 3. Acceptance criteria

**A notice the chat cannot take is kept** (design section 8; the issue's
first expectation)

- AC-1. **A notice is queued, not dropped.** Given a notification reaches
  the `TelegramNotifier` and the chat cannot take it: no channel is attached
  (Telegram off per spec 007 AC-1, still `connecting` per spec 043, or the
  poller has not yet called its attach hook), or `sendReply` throws; then
  the notifier writes the service log line as today with `channel: log` and
  the added field `pending: true`, appends the notice to
  `telegram/alerts-pending.json` (section 5) as `{ at, issue, gate, label,
  text, repeats: 1 }` where `at` is the time it was raised, returns
  `{ channel: "log" }` so the `maintainer.contact` event of spec 026 is
  recorded as it is today, and logs `telegram-send-failed` once per outage
  as spec 030 AC-9 says (a missing channel logs nothing). Given a pending
  notice already has the same identity (`issue:gate:label`, spec 001
  AC-27), then the new one replaces it in place, keeping the earlier `at`
  and adding one to `repeats`: a condition that recurs during an outage is
  one pending notice. The file holds at most `PENDING_ALERTS_KEPT` (200)
  notices; when a new one would exceed that, the oldest is dropped and
  `{ kind: "telegram-alerts-dropped", dropped: <n> }` is logged. The file
  is written atomically (`writeJsonAtomic`), and a file that is absent or
  does not parse reads as empty. Given the service runs without a
  `telegram` section in its config, then `bin/scheduler.ts` wires
  `rateLimited(recordedNotifier(LogNotifier))` without the
  `TelegramNotifier` and nothing is ever queued.
- AC-2. **The queue is delivered when the channel is back.** The
  `Notifier` interface gains an optional `deliverPending(): Promise<{ sent:
  number; left: number }>`; the `TelegramNotifier` implements it,
  `rateLimited` and `recordedNotifier` forward it to their inner, and the
  `LogNotifier` has none. The scheduler calls it, with errors caught and
  never failing the caller, in two places: `Scheduler.setTelegram` right
  after it stores the channel (the attach hook), and at the start of every
  `tick()` while `SchedulerDeps.telegram` is set. Delivery sends the
  pending notices oldest first, each as one message with no buttons whose
  text is spec 030 AC-9's `<gate>: <label> #<issue>` heading and the
  notice's text, followed by a last line `(queued <at>; Telegram was
  unreachable)`, with `, repeated <repeats> times` before the semicolon
  when `repeats` is above 1. After each successful send the message id is
  appended to `telegram/alerts.json` (spec 099's `ALERT_IDS_KEPT` ring, so
  spec 030 AC-10 treats a reply to a late notice as a reply to an alert),
  the notice is removed from the pending file before the next is sent (a
  crash between the send and the write resends at most one), and
  `{ kind: "telegram-alert-delivered", at, issue, gate, label, message_id
  }` is logged. The first send that throws ends the delivery for that call
  (the rest stay queued, in order), logs `telegram-send-failed` once per
  outage through the same flag as a failed `notify`, and the next tick
  tries again. No `maintainer.contact` event is recorded for a delivery.
  Given Telegram was off for the life of a process (#186) or the laptop
  was asleep, then the notices are delivered by the next process whose
  poller attaches: the queue is a file, not process memory.

**Repeats are collapsed** (spec 001 AC-27; the issue's third expectation)

- AC-3. **A condition notifies once, then daily until it clears.** The
  rate limiter keeps spec 001 AC-27's identity `issue:gate:label` and
  changes in four ways.
  - *The window.* `notify_rate_limit_hours` in `agents/scheduler.yaml`
    becomes 24 and the config default (`src/config.ts`) follows; the key
    keeps its name and meaning. A repeat within the window is suppressed
    (`{ channel: "suppressed" }`, no log line, no event, as today).
  - *The reminder.* The limiter's entry is `{ at, suppressed }`: `at` the
    last send, `suppressed` the repeats dropped since it. When a repeat
    arrives past the window with `suppressed` above 0, the limiter passes
    the notification on with its text followed by `\n\n(<suppressed>
    repeats since <at> collapsed into this reminder)` and resets
    `suppressed`; the inner notifier sees one notification, so the log line,
    the event and the chat message all carry the count. The filer's 32
    identical failures over five days would have been one message and four
    reminders.
  - *The record survives a restart.* The limiter is constructed with a
    state path, `notify/sent.json` (section 5): entries are loaded on the
    first `notify` after construction (an absent or unparsable file reads
    as empty), written atomically after every change, and pruned of
    entries older than the window on write. A test construction without a
    path keeps the map in memory, as the existing tests do. A restart of
    the service within the window sends nothing for a condition already
    notified.
  - *The condition clears.* The `Notifier` interface gains an optional
    `clear(id: { issue, gate, label }): Promise<void>`; `rateLimited`
    implements it (the entry is deleted and the file written; an absent
    entry is a no-op) and `recordedNotifier` forwards it. Two callers:
    `src/standing/run.ts`, after a run whose outcome is `ok` for an agent
    whose previous state recorded a failure (`failures` above 0 or a
    `last_run.outcome` other than `ok`), clears `{ issue: 0, gate:
    "standing", label: "<name>:failed" }` and `{ issue: 0, gate: "infra",
    label: "<name>:outage" }`; `HostMonitor` (`src/service/host.ts`), when a
    pause ends, clears `{ issue: 0, gate: "infra", label: "host" }`, so the
    next long pause's notice (spec 100 AC-5) is not suppressed by the last
    one. The next failure of a cleared condition notifies at once.

  The standing agent's second-failure notification (the `Standing agent
  <name> failed twice: <error>` call in `src/standing/run.ts`) passes the key
  `failed`, so its label is `<name>:failed` and the error stays in the text:
  a condition is the agent failing, whatever the error says. The filer's
  own calls through `FilerDeps.notify` with a key are unchanged.

**Nothing reaches the chat twice** (the issue's second expectation; #139)

- AC-4. **The question gates and the plain-file reminder go to the chat
  once.** Given a notification with gate `question` or `question-reminder`,
  then the `TelegramNotifier` writes the log line with `channel: log`,
  returns `{ channel: "log" }`, sends nothing and queues nothing, whatever
  the channel's state: the question and its reminder reach the chat on the
  question path (spec 007; `sendPausedQuestion` and the reminder send in
  `src/service/loop.ts`), which has its own retry and its own record in the
  question log. Given the plain-file reminder of spec 072 AC-4 is due, then
  `checkPlainFiles` no longer calls `telegram.sendReply` itself: it calls
  `notifier.notify` with the same `{ issue: 0, gate: "credential", label:
  "plain-files", text }` and then writes its state file; the
  `TelegramNotifier` carries the text to the chat, or queues it under AC-1
  when the chat cannot take it, and `plain-files-reminder-failed` is no
  longer logged (`CheckPlainFilesDeps.telegram` is removed). The reminder's
  text and weekly cadence are unchanged.
- AC-5. **Every other gate reaches the chat, as a notice.** Given a
  notification with any gate but the two of AC-4 (today: `abandoned`,
  `standing`, `chain_error`, `infra` including spec 100 AC-5's long pause
  with label `host`, `credential`, `credential-expiry`, `aws`,
  `spec-present`, `ui-design`, `eligible`, and every gate a chain effect
  of type `notify` names), then it is sent as spec 030 AC-9 says or queued
  under AC-1; the text is the notification's own with the AC-2 or AC-3
  trailer when one applies, no buttons, no mention, no request. A reply to
  any of these, late or not, is answered as spec 030 AC-10 says.

## 4. Amendments to earlier specs

- Spec 030 AC-9 is marked `Amended by
  [102-scheduler-alerts-reach-telegram](../102-scheduler-alerts-reach-telegram/spec.md)
  AC-1, AC-2 and AC-4`: a notice the chat cannot take is queued in
  `telegram/alerts-pending.json` and delivered when the channel is back,
  and the `question` and `question-reminder` gates are not sent to the chat
  by the notifier. The rest of AC-9 (the message's shape, the log line's
  `channel`, the wiring order, the one `telegram-send-failed` line per
  outage) stands; "nothing is retried" is what changes. Spec 068 AC-4 is not
  marked: the `TelegramNotifier` still returns `log` when the chat did not
  carry the notice, and the event records that.
- Spec 001 AC-27 is marked `Amended by [102] AC-3`: identical notifications
  collapse to one per `notify_rate_limit_hours` (24), a repeat past the
  window names the repeats collapsed, the record survives a restart, and a
  condition that clears notifies again at once.
- Spec 072 AC-4 is marked `Amended by [102] AC-4`: the reminder is the
  notification alone; the direct `telegram.sendReply` and the
  `plain-files-reminder-failed` line go. Spec 072 AC-6 (the deps) is read
  with `telegram` gone and is not marked separately.
- Spec 100 AC-5 is not marked: it sends one notice per pause as it says;
  AC-3 only clears the limiter's entry when the pause ends, so the next
  pause's notice is not suppressed.
- Spec 099 is not marked: it built the `TelegramNotifier`; its tests that
  assert "retrying nothing" change to assert the queue (section 6).

## 5. Interfaces and files

- `tools/scheduler/src/notify/types.ts`: `Notifier` gains the optional
  `deliverPending()` (AC-2) and `clear(id)` (AC-3); `Notification` and
  `NotifyResult` are unchanged.
- `tools/scheduler/src/notify/telegram.ts`: the pending queue of AC-1
  (`PENDING_ALERTS_KEPT = 200`, `readPendingAlerts(path)`), the gate skip of
  AC-4, `deliverPending` of AC-2, and the one `failing` flag shared by
  `notify` and `deliverPending`. Deps gain `pendingPath: string`.
- `tools/scheduler/src/notify/rate-limit.ts`: `rateLimited(inner, hours,
  clock?, statePath?)` with the persisted `{ [identity]: { at, suppressed }
  }` map, the reminder trailer and `clear` (AC-3); `sent` stays exposed for
  the tests, now holding the entries.
- `tools/scheduler/src/notify/recorded.ts`: forwards `deliverPending` and
  `clear`.
- `tools/scheduler/src/state/paths.ts`: `telegramAlertsPending`
  (`telegram/alerts-pending.json`) and `notifySent` (`notify/sent.json`);
  `notify/` is created with the other state directories.
- `tools/scheduler/bin/scheduler.ts`: the chain with the two new paths;
  the `TelegramNotifier` only when `cfg.telegram` is set (AC-1).
- `tools/scheduler/src/service/loop.ts`: `setTelegram` and `tick()` call
  `deliverPending` (AC-2).
- `tools/scheduler/src/service/host.ts`: `clear` on resume (AC-3).
- `tools/scheduler/src/standing/run.ts`: the `failed` key and `clear` after
  a recovery (AC-3).
- `tools/scheduler/src/credentials/plain-files.ts`: the notifier alone
  (AC-4); `CheckPlainFilesDeps.telegram` removed, and its caller in
  `loop.ts` stops passing it.
- `agents/scheduler.yaml` and `tools/scheduler/src/config.ts`:
  `notify_rate_limit_hours: 24` (AC-3).
- `tools/scheduler/README.md`: the state files and the queue, in the
  section that documents the service log and Telegram.
- No schema changes: the service-log lines are free-form records, the
  `maintainer.contact` event is unchanged, and the two state files are the
  scheduler's own.

## 6. Verification

Unit tests in `tools/scheduler/test/notify.test.ts`, with the fake
`TelegramChannel` the file already uses:

- AC-1: a notification with no channel attached leaves the log line with
  `channel: log` and `pending: true`, one entry in the pending file and the
  `log` result; a refused send does the same plus one
  `telegram-send-failed` line for two refusals; a second notification with
  the same identity leaves one entry with `repeats: 2` and the first `at`;
  201 distinct notices leave 200 entries and one `telegram-alerts-dropped`
  line; the spec 099 test "falls back to the log on a refused send, once per
  outage, retrying nothing" becomes this.
- AC-2: `deliverPending` with the channel back sends the entries oldest
  first with the `(queued <at>; Telegram was unreachable)` line and the
  repeat count, records each id in `alerts.json`, empties the file and
  logs one `telegram-alert-delivered` per notice; a channel that refuses
  the second send leaves the second and third entries in order and returns
  `{ sent: 1, left: 2 }`; a call with the file empty sends nothing;
  `rateLimited` and `recordedNotifier` forward the call and record no event.
- AC-3: a repeat within 24 h is suppressed and counted; a repeat after 24 h
  with three suppressed is passed on with the `(3 repeats since <at>
  collapsed into this reminder)` trailer and the count reset; a limiter
  constructed on a state path, after one send, is rebuilt on the same path
  and suppresses the repeat; `clear` on the identity lets the next repeat
  through at once, and `clear` on an unknown identity does nothing; a
  limiter without a path keeps the existing tests passing.
- AC-4: gates `question` and `question-reminder` with the channel attached
  send nothing and queue nothing; with no channel they queue nothing.
- AC-1, no config: `bin.test.ts` (or the test that drives
  `bin/scheduler.ts`) asserts that a service without a `telegram` section
  writes no pending file after a notification.

Elsewhere:

- `tools/scheduler/test/standing.test.ts`: the second-failure notification
  carries label `<name>:failed`; a run that succeeds after a recorded
  failure calls `clear` for `standing` and `infra` with that agent's labels.
- `tools/scheduler/test/host.test.ts`: the end of a pause calls `clear`
  with `{ issue: 0, gate: "infra", label: "host" }`; the spec 100 AC-5 test
  stays as it is.
- `tools/scheduler/test/loop.test.ts`: `setTelegram` triggers
  `deliverPending` once, and a tick with `telegram` set calls it; a tick
  with `telegram: null` does not (the spec 090 pause test is unchanged).
- `tools/scheduler/test/plain-files.test.ts`: a due reminder calls the
  notifier once and `sendReply` never; the state file is written after the
  notify; the test for `plain-files-reminder-failed` is removed.
- `pnpm test` from the repo root passes, including the design-tree check
  for this spec's `Parent:` line and the Children entry.

## 7. Open decisions

None.
