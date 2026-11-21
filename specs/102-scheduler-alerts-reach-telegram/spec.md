# 102. Scheduler alerts reach the maintainer on Telegram: a notice the chat cannot take waits for the channel, repeats collapse per condition, and the question gates are not sent twice

Status: written 2026-11-21 from the delivery-system design for issue #253;
specs derived from that design need no maintainer approval (design section
11). Spec 099 AC-6 (merged 2026-11-21, after the issue was filed) already
sends every notification to the chat; this spec finishes what the issue asks
beyond it. Amends
[099-beyond-github-rest-on-the-credential-store](../099-beyond-github-rest-on-the-credential-store/spec.md)
AC-6 (a failed or impossible send is queued for the channel's return instead
of retried nothing, and the `question` and `question-reminder` gates are not
sent by the notifier), [068-beyond-github-aws-and-events](../068-beyond-github-aws-and-events/spec.md)
AC-4 (`channel` may also be `queued`) and
[001-scheduler-core](../001-scheduler-core/spec.md) AC-27 (the collapse
window is per gate, survives a restart and is re-armed when the condition
clears), each marked as section 4 records. *(agent's call)* Corrected
2026-11-21 on the plan stage's three questions: section 4 lists the test
directory, so the scope gate admits the tests section 5 requires; clearing a
condition never removes a queued notice (AC-6, which had contradicted AC-2
and AC-4); and the standing clear matches only the failure condition's
`<name>:failed:` labels (AC-6). *(agent's call)*
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 8 ("Telegram carries questions, credential and fund requests,
first-contact requests, alerts and reminders") and section 10 ("Small work
skips layers": a tooling spec hangs directly off a top design);
[design-tree](../../docs/design-tree.md) R8.Q1 (CLI plus Telegram bot, the
issue as system of record) and R8.Q4 (the escalation ladder ends in "Telegram
to maintainer"); [001-scheduler-core](../001-scheduler-core/spec.md) section
15 (the notification interface, its v0 log line) and AC-27 (one call per gate
failure, identical notifications rate-limited);
[099-beyond-github-rest-on-the-credential-store](../099-beyond-github-rest-on-the-credential-store/spec.md)
AC-6 (the `TelegramNotifier`, the chain
`rateLimited(recordedNotifier(TelegramNotifier(LogNotifier)))`, `channel` on
the log line) and AC-7 (`telegram/alerts.json`, a reply to an alert is not an
answer); [068-beyond-github-aws-and-events](../068-beyond-github-aws-and-events/spec.md)
AC-4 (`notify` resolves to the channel that carried it);
[026-event-store](../026-event-store/spec.md) AC-2 (the `maintainer.contact`
event beside each send); [007-telegram-channel](../007-telegram-channel/spec.md)
AC-2 (the poller's outage, recovery and backoff) and AC-5 (a question is
sent with buttons by the question path);
[043-telegram-connects-with-backoff](../043-telegram-connects-with-backoff/spec.md)
and [090-telegram-attach-failure-and-pause-test](../090-telegram-attach-failure-and-pause-test/spec.md)
(the poller attaches the channel after its connect step; the service starts
with `telegram: null`); [100-host-outage-pauses-scheduler](../100-host-outage-pauses-scheduler/spec.md)
AC-5 (the one notice of a long host pause, gate `infra`, label `host`);
[093-scheduler-failure-findings-name-their-cause](../093-scheduler-failure-findings-name-their-cause/spec.md)
(the short cause label of a standing agent's failure).

## 1. Goal

Every scheduler alert reaches the maintainer, once per condition, and none is
lost to the channel being down. The issue's evidence: the findings filer
failed on `spawn E2BIG` on every run from 2026-11-12 to 2026-11-17, the
scheduler raised the `standing` notification about it 10 times and abandoned
three issues with a notification each, and nothing reached the maintainer
because the only notifier wrote to `log/service.jsonl`. A pipeline bug that
no outage probe can detect is caught only by an alert that arrives.

Spec 099 AC-6 (PR #385, merged 2026-11-21) built the `TelegramNotifier`: the
service's chain is now `rateLimited(recordedNotifier(TelegramNotifier(LogNotifier)))`
and every notification is sent to the chat as one message with no buttons.
Three things the issue asks for are still missing, and they are what this
spec adds:

- **A notice the chat cannot take is not dropped.** Spec 099 says "nothing is
  retried": a notification raised while Telegram is off (the service starts
  with `telegram: null` until the poller attaches the channel, spec 043) or
  while a send fails is written to the log only. A host outage of spec 100 is
  exactly when sends fail, so its one notice would be lost. This spec keeps an
  outbox and sends it, oldest first, once the channel takes messages again.
  A notice whose condition cleared in the meantime is still sent, marked as
  cleared: the outbox delivers what the chat would have shown had it been
  reachable.
- **Repeats are collapsed per condition.** The rate limiter keys on
  `issue:gate:label` with one window (`notify_rate_limit_hours`, 4) held in
  memory, so a condition that lasts days is re-notified every four hours and
  again after every restart; the filer's one condition produced 10 messages
  in five days. This spec gives the gates that describe a lasting condition a
  long window (a daily reminder), persists the sent map across restarts, and
  re-arms a condition when it clears (a standing agent's next successful run,
  the host probe passing), so the next failure after a recovery notifies at
  once. The standing failure's label becomes its cause label (spec 093), so
  the identity does not carry an error's variable detail.
- **The question gates are not sent twice.** Spec 099 sends every gate, and
  the question path already sends the question (spec 007 AC-5) and its
  reminder (spec 007 AC-11) with buttons; the `question` and
  `question-reminder` notifications are the record of that and go to the log
  only.

Which gates reach Telegram: every gate the scheduler notifies except
`question` and `question-reminder`, which covers the issue's list
(`abandoned`, `standing`, `chain_error`, `infra` including the host pause of
spec 100 AC-5, and the rest: `aws`, `credential`, `credential-expiry`,
`eligible`, `liveness`, `plan`, `sensitive-path`, `spec-present`,
`ui-design`). A notice stays informational: no buttons, no mention, nothing
asked of the maintainer (spec 006 AC-5's rule for abandonment applies to all
of them); a reply to one is handled by spec 099 AC-7.

## 2. Out of scope

- How Telegram is turned on, connected and reattached (specs 007, 043, 090)
  and the classification of its errors (spec 089, issue #186). The outbox
  waits for whatever channel those give it; it does not reconnect.
- The question path: how a question and its reminder are sent and retried
  (spec 007 AC-5, AC-11), and the `maintainer_reply` events.
- Spec 072's weekly plain-file reminder, which keeps its own cadence; it goes
  through the notifier like any other gate and is collapsed by it only within
  its window.
- Text or wording of any notification other than the standing failure's
  label (AC-7), and any new gate.
- A digest or summary message. Each queued notice is sent as its own message;
  the per-condition collapse bounds their number.
- Delivery anywhere but the Telegram chat and the service log (no email, no
  push notification).

## 3. Acceptance criteria

**Which gates** (spec 099 AC-6, amended)

- AC-1. **The question gates go to the log only.** Given Telegram on and a
  notification whose gate is `question` or `question-reminder`, then the
  `TelegramNotifier` sends nothing and queues nothing: the inner notifier's
  log line is written with `channel: "log"`, `notify` resolves to
  `{ channel: "log" }`, and the chat holds only the question path's message
  (spec 007 AC-5) or reminder (spec 007 AC-11). Every other gate is sent as
  spec 099 AC-6 says. A test asserts a `question` notification with a channel
  that would accept it makes no `sendReply` call and that an `abandoned` one
  does.

**The outbox** (spec 099 AC-6, amended; spec 068 AC-4, amended)

- AC-2. **A notice the chat cannot take is queued, not dropped.** Given a
  notification for a gate AC-1 sends, when Telegram is off (`deps.telegram()`
  returns null) or the send throws, then the notice is appended to the outbox
  `telegram/outbox.json` (`StatePaths.telegramOutbox`, a JSON array written
  with `writeJsonAtomic`) as
  `{ identity, issue, gate, label, text, queued_at, repeats: 1 }`, where
  `identity` is `rate-limit.ts`'s `identity(n)` and `queued_at` the clock's
  ISO time (AC-6 may later add `cleared_at` to an entry); the inner
  notifier's log line is written with `channel: "queued"`, and `notify` resolves to `{ channel: "queued" }`, so
  the `maintainer.contact` event of spec 026 AC-2 records `queued`. A notice
  whose identity is already queued updates that entry (`repeats` + 1, `text`
  replaced, `queued_at` kept, `cleared_at` removed because the condition
  holds again) instead of adding one. Only two things take an entry out of
  the outbox: its send resolving in a flush (AC-3) and the cap below; no
  clear does (AC-6). The outbox holds at most
  100 entries; a 101st drops the oldest and logs
  `{ kind: "telegram-outbox-dropped", identity, queued_at }`. The
  `telegram-send-failed` line stays once per outage, as spec 099 AC-6 says,
  and the `failing` flag is reset by the first send that succeeds, a flush's
  or a fresh notice's.
- AC-3. **The outbox is sent when the channel is back.** `TelegramNotifier`
  gains `flush(): Promise<number>` (the number sent), forwarded unchanged by
  `recordedNotifier` and `rateLimited`, so `Notifier` gains an optional
  `flush`. Given the outbox is non-empty and `deps.telegram()` returns a
  channel, when `flush` runs, then each entry is sent oldest first as one
  message with no reply markup: spec 099's heading `<gate>: <label> #<issue>`,
  then a line `queued <queued_at>` followed by `, repeated <n> times` when
  `repeats` is above 1 and then by `, cleared <cleared_at>` when the entry
  has `cleared_at` (AC-6), then a blank line and the text; its message id goes to
  `telegram/alerts.json` (spec 099 AC-7, so a reply to it takes no answer);
  the entry is removed from the outbox after its send resolves (a crash
  between the two repeats the message, which is preferred to losing it); and
  `{ kind: "telegram-outbox-sent", identity, queued_at, message_id }` is
  logged. No second `maintainer.contact` event is recorded: the notice's
  contact is the `queued` one of AC-2. Given a send in the flush throws, then
  the flush stops at that entry, it and the later ones stay queued, and
  `telegram-send-failed` is logged once per outage (AC-2). The service calls
  `flush` once on every tick, paused or not, right after the tick's host
  step: in `Scheduler`'s paused tick after `host.noticeIfDue`, and in an
  ordinary tick after the `host.probeIfDue` check, so the tick that finds
  the host back is the first to try the outbox *(agent's call)*; and
  `notify` itself flushes before sending a new
  notice when the outbox is non-empty, so the chat sees notices in the order
  they were raised; a flush that throws is caught and logged, never failing
  the tick. `flush` with Telegram off or an empty outbox returns 0 and does
  nothing.
- AC-4. **A notice raised during a host outage arrives when the host is back.**
  Given the host is paused (spec 100) and the chat is unreachable, when spec
  100 AC-5's notice is raised (gate `infra`, label `host`), then it is queued
  (AC-2); when the host probe then passes, the host clear of AC-6 leaves it
  in the outbox and stamps it `cleared_at`; and the first flush after the
  channel takes messages again (the resuming tick's own when the chat is
  reachable by then, else a later tick's) sends it once (AC-3), so the chat
  shows `infra: host`, the line `queued <at>, cleared <at>`, and the pause's
  cause, its start and its age as spec 100 wrote them. The notice is not
  withdrawn because the pause ended: a pause long enough to be notified is
  what the maintainer needs to hear about, and the `cleared` time says it is
  over. *(agent's call)* Likewise an
  `abandoned`, `standing` or `chain_error` notice raised before the poller
  has attached the channel at start-up (spec 043, spec 090) is sent on the
  first tick after the attach.

**Collapsing repeats** (spec 001 AC-27, amended)

- AC-5. **Each condition notifies once, then at most daily while it lasts.**
  `rateLimited(inner, hours, clock)` becomes
  `rateLimited(inner, { hours, repeatHours, path }, clock)`: the window for
  an identity is `repeatHours` when its gate is one of the lasting-condition
  gates `standing`, `infra`, `chain_error`, `aws` and `credential-expiry`
  (the constant `LASTING_GATES` in `rate-limit.ts`), else `hours`.
  `agents/scheduler.yaml` gains `notify_repeat_hours`, default 24, read by
  `config.ts` beside `notify_rate_limit_hours` (unchanged, 4). The sent map
  is persisted at `notify/sent.json` (`StatePaths.notifySent`, an object of
  identity to ISO time, written with `writeJsonAtomic` after each send and
  pruned of entries older than the longer window), and loaded on the first
  call, so a restart within a window sends nothing. Given the filer fails on
  the same cause on every run for five days with Telegram on, then the chat
  receives one message at once and one a day after it while it lasts, and
  the log holds `channel: "suppressed"` for the rest.
- AC-6. **A condition that clears is re-armed.** `Notifier` gains an optional
  `clear(sel: { issue: number; gate: string; label?: string; labelPrefix?: string }): Promise<void>`,
  implemented by `rateLimited` (it removes every sent entry whose identity
  matches: the issue and gate, and the label exactly when `label` is given,
  or by prefix when `labelPrefix` is given; it writes `notify/sent.json`
  only when something matched) and forwarded by `recordedNotifier` to
  `TelegramNotifier`. **A clear never removes a queued notice.**
  `TelegramNotifier.clear` sets `cleared_at` (the clock's ISO time) on each
  outbox entry the selector matches that has none, and writes the outbox
  only when it changed one; the entry stays queued and AC-3's flush sends it
  with `, cleared <cleared_at>` on its `queued` line. The selector has no
  flag to keep or drop queued notices, so every call site behaves the same.
  *(agent's call: the issue says a notice the chat could not take "is not
  dropped", and a clear that deleted queued notices could never deliver
  AC-4's host notice, since the host clear runs in `probeIfDue` before any
  flush can reach the chat, nor the `<name>:outage` notice, which is raised
  exactly when the network is down; the rule is that the outbox delivers
  what the chat would have shown had it been reachable, and a clear only
  re-arms the next notice.)* Given a standing agent's run ends with
  outcome `ok`, then `standing/run.ts` calls
  `clear({ issue: 0, gate: "standing", labelPrefix: "<name>:failed:" })` and
  `clear({ issue: 0, gate: "infra", label: "<name>:outage" })`; given the host
  probe passes after a pause (spec 100 AC-4, `host-resumed`), then `host.ts`
  calls `clear({ issue: 0, gate: "infra", label: "host" })`; a clear that
  throws is caught and logged and fails neither the run nor the tick. Given
  the agent then fails again on the same cause, then the notification is
  sent at once rather than after the window. **The standing clear matches
  only the failure condition of AC-7.** The findings filer's own
  notifications share the gate and the `<name>:` prefix
  (`findings-filer:<ref>`, raised inside the run that then ends `ok`), and
  are not a condition the run's success clears: the prefix
  `<name>:failed:` leaves their sent entries (so a ref's notice is not
  re-sent on every run inside its window) and their outbox entries (which
  get no `cleared_at`) as they are. *(agent's call)* No other call site
  clears anything in this spec; a gate without a clear signal relies on
  AC-5's window.
- AC-7. **The standing failure's label is its cause.** Given a standing agent
  has failed twice (spec 020, spec 093), then its notification is
  `{ issue: 0, gate: "standing", label: "<name>:failed:<cause>", text }`
  with `<cause>` the cause label spec 093 gives the finding (the transient
  label past the ceiling, else the error's first line, at most 60 characters)
  and the text unchanged (`Standing agent <name> failed twice: <error>`), so
  that the 32 `spawn E2BIG` failures share one identity and a different
  cause is a new one. The filer's own notifications (`filer/apply.ts`,
  keyed by the decision's ref) are unchanged.

**Informational** (spec 006 AC-5)

- AC-8. **A notice asks nothing.** Given any message the `TelegramNotifier`
  sends, at once or from the outbox, then it has no reply markup and no
  @-mention of the maintainer, it names no action the maintainer must take
  beyond what the notification text already says, and a reply to it is
  answered as spec 099 AC-7 says (alerts take no reply). A test asserts the
  flushed message's `reply_markup` is undefined.

## 4. Interfaces and files

- `tools/scheduler/src/notify/types.ts`: `NotifyResult.channel` is
  `"telegram" | "log" | "queued" | "suppressed"`; `Notifier` gains optional
  `flush(): Promise<number>` and `clear(sel): Promise<void>` (AC-3, AC-6).
- `tools/scheduler/src/notify/telegram.ts`: the gate filter (AC-1), the
  outbox and its cap (AC-2), `flush` and the flush-before-send (AC-3), the
  outbox half of `clear`, which stamps `cleared_at` and removes nothing
  (AC-6); `readOutbox(path)` beside `readAlertIds`.
- `tools/scheduler/src/notify/rate-limit.ts`: `LASTING_GATES`, the
  per-gate window, the persisted sent map, `clear` (AC-5, AC-6); `identity`
  unchanged.
- `tools/scheduler/src/notify/recorded.ts`: forwards `flush` and `clear`.
- `tools/scheduler/src/notify/log.ts`: unchanged except that `extra.channel`
  accepts `queued`.
- `tools/scheduler/src/state/paths.ts`: `telegramOutbox`
  (`telegram/outbox.json`) and `notifySent` (`notify/sent.json`); the
  `notify/` directory is created with the others.
- `tools/scheduler/src/config.ts`, `agents/scheduler.yaml`:
  `notify_repeat_hours` (AC-5).
- `tools/scheduler/bin/scheduler.ts`: the chain is unchanged; `rateLimited`
  receives the new options.
- `tools/scheduler/src/service/loop.ts`: the paused tick and the ordinary
  tick each call `notifier.flush?.()` once (AC-3).
- `tools/scheduler/src/service/host.ts`: `clear` on resume (AC-6).
- `tools/scheduler/src/standing/run.ts`: the `failed:<cause>` key (AC-7) and
  the two clears on a successful run (AC-6).
- Marks (section 4 of the process): spec 099 AC-6, spec 068 AC-4 and spec 001
  AC-27 carry `Amended by` marks naming this spec's AC-2, AC-2 and AC-5.
- `tools/scheduler/test/`: the tests, listed as the directory, as spec 099
  and other landed specs list it, because every path under
  `tools/scheduler/` is sensitive and the scope gate admits a changed
  sensitive file only when this section names it or a directory above it;
  the plan still names each test file it changes. *(agent's call)* The files
  expected to change: `tools/scheduler/test/notify.test.ts` (AC-1, AC-2,
  AC-3, AC-5, AC-6, AC-8); `tools/scheduler/test/e2e.test.ts` and
  `tools/scheduler/test/standing-wakes.test.ts`, where the standing runner's
  tests are (AC-7 and the standing clears), with their harness
  `tools/scheduler/test/helpers/e2e-routes.ts` (its notifier stub records
  `clear` calls); `tools/scheduler/test/host.test.ts` (the host clear);
  `tools/scheduler/test/loop.test.ts` (AC-4 and the per-tick flush, built on
  spec 100's host test harness); `tools/scheduler/test/config.test.ts`
  (`notify_repeat_hours`); `tools/scheduler/test/state.test.ts` (the two new
  `StatePaths`). The directory entry also covers any other test or helper
  under it that must change to keep compiling or passing, such as a notifier
  stub or a `rateLimited` call with the old signature.

## 5. Verification

`pnpm test` from the repository root passes with these tests added:

- AC-1: a `question` and a `question-reminder` notification with a channel
  that would accept them make no `sendReply` call and log `channel: "log"`;
  an `abandoned` one makes one call.
- AC-2: with `telegram()` returning null, a notice lands in the outbox with
  `channel: "queued"` on the log line and the result; with a channel that
  throws, the same, plus one `telegram-send-failed`; a second notice of the
  same identity leaves one entry with `repeats: 2`; the 101st entry drops the
  oldest with `telegram-outbox-dropped`.
- AC-3: with two entries queued and a channel that accepts, `flush` sends
  them oldest first with the `queued <at>` line, returns 2, empties the
  outbox, records both ids in `alerts.json`, logs two
  `telegram-outbox-sent`, and records no `maintainer.contact`; with two
  entries queued and a channel stub whose `sendReply` resolves on its first
  call and throws on its second, `flush` returns 1, the outbox holds only
  the second entry, and a later `flush` with an accepting channel sends that
  one and returns 1 (a test in which the first send fails does not cover
  this); a new notice with a non-empty outbox is sent after the queued ones.
- AC-4: the spec 100 host test's long-pause notice with the channel
  rejecting while paused and accepting once the probe passes: the outbox
  holds the notice through the paused ticks; the tick that logs
  `host-resumed` sends exactly one message, with `infra: host`, a
  `queued <at>, cleared <at>` line and the pause's cause and start; the
  outbox is then empty and later ticks send nothing more.
- AC-5: with `repeatHours: 24` and `hours: 4`, a `standing` identity at
  hour 0, 5 and 23 sends once and suppresses twice, and sends at hour 25; an
  `abandoned` identity sends at hour 0 and 5; a second `rateLimited` built on
  the same `path` after the first sent suppresses within the window.
- AC-6: after a send, `clear` with the matching prefix makes the next notice
  send at once; `clear` with another gate does not; a queued entry matching a
  `clear` stays in the outbox with `cleared_at` set and is flushed with
  `, cleared <at>` on its `queued` line; a second notice of that identity
  raised before the flush leaves one entry with `repeats: 2` and no
  `cleared_at`; after an `ok` run the standing runner calls exactly
  `clear({ issue: 0, gate: "standing", labelPrefix: "<name>:failed:" })` and
  `clear({ issue: 0, gate: "infra", label: "<name>:outage" })`, and the host
  monitor calls its clear on resume. The filer's notices survive the
  standing clear: on the full chain with Telegram off, a notice
  `{ issue: 0, gate: "standing", label: "findings-filer:<ref>" }` is queued,
  `clear({ issue: 0, gate: "standing", labelPrefix: "findings-filer:failed:" })`
  runs, and then the outbox entry is unchanged (no `cleared_at`), a second
  notice of the same ref inside the window is `suppressed`, and a flush with
  an accepting channel sends the notice with no `cleared` on its line.
- AC-7: the standing failure notification's label for a run that failed on
  `spawn: spawn E2BIG` is `findings-filer:failed:spawn: spawn E2BIG`, and for
  an outage past the ceiling labelled `EAI_AGAIN` it is
  `findings-filer:failed:EAI_AGAIN`.
- AC-8: a flushed message has `reply_markup` undefined and no `@`.

The spec 099 AC-6 tests change only where this spec says: "retrying nothing"
becomes "queuing it".

## 6. Open decisions

None.
