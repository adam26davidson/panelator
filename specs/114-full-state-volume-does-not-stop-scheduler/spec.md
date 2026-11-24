# 114. A full state volume pauses the scheduler and tells the maintainer; it does not kill the process

Status: written 2026-11-23 from the delivery-system design for issue #509;
specs derived from that design need no maintainer approval (design section 11).
Amends [100-host-outage-pauses-scheduler](../100-host-outage-pauses-scheduler/spec.md)
AC-2 and AC-5 and [064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
AC-2 (marked as section 4 records).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain's bounds count failures of the work, not of the host),
section 6.1 (infra health is woken by alarms) and section 10 ("Small work
skips layers": a bug spec hangs directly off a top design);
[ADR 0015](../../docs/decisions/0015-host-outage-pauses-scheduler.md) (a host
that cannot work pauses the scheduler, which resumes by itself);
[100-host-outage-pauses-scheduler](../100-host-outage-pauses-scheduler/spec.md),
whose pause, probe, notice and downtime log this spec makes work when the
state volume itself takes no writes;
[059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md), whose
`ENOSPC` cause, launch floors and `freeSpace` reader it uses and leaves as they
are; [064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md),
whose sweep and alarm it leaves as they are except for AC-2's order;
[102-scheduler-alerts-reach-telegram](../102-scheduler-alerts-reach-telegram/spec.md)
(the `TelegramNotifier` an alarm is sent through); and
[103-torn-jsonl-line-is-skipped](../103-torn-jsonl-line-is-skipped/spec.md)
(the reader that skips the torn line a failed append leaves).

## 1. Goal

When the volume holding the state root is full, the scheduler stays up: it
pauses as spec 100 says, sends the maintainer a Telegram message at once
(the host notice, and the sweep's disk-full alarm when it is the state volume),
keeps what it could not write and writes it when the volume has room, and
resumes by itself. A scheduler started on a full state volume waits before its
first write instead of dying, so systemd is not restarting it every thirty
seconds. Afterwards the service log and the findings queue say what happened.

### What happened on 2026-11-22 (settled by this spec's investigation)

The issue lists five things as not determined. The service's journal
(`journalctl --user -u panelator-scheduler.service`), the service log and the
code settle them:

- **Bytes, not inodes, and not the temp volume.** The full device was the
  laptop's root filesystem, which holds the state root. At 22:48:33Z it had
  1,207,582,720 bytes and 6,379,370 inodes free (`disk-sweep-urgent`); 59
  seconds later a write failed. Other programs on the same filesystem failed
  the same way for the whole gap (the HIL runner's `cp: ... No space left on
  device`, 400 restarts). `/tmp` is a separate tmpfs. The six
  `panelator-test-*` roots removed at 04:37:53Z were on that tmpfs: they held
  inodes there and no byte of the full device, and they were removed by the
  first routine sweep after the service came back, as spec 064 AC-1 says. They
  did not cause the outage and no sweep rule failed on them.
- **The process exited; it did not run on.** At 22:51:02Z the tick's
  service-log line failed with `ENOSPC`, the loop's own handler for a failed
  tick called the same log (`run()` in `service/loop.ts`), that write threw
  too, and the process exited with status 1. `ServiceLog.write` is a bare
  `appendFileSync`.
- **A crash loop, 669 restarts.** systemd (`Restart=on-failure`,
  `RestartSec=10`) started the scheduler again each time. Every start died
  within 30 seconds on its first state write, the lock file of
  `withStateLock` (`parameters/store.ts`), 647 times between 23:13Z and
  04:36Z, after reading the App key and calling GitHub each time. Twice
  (22:52Z and 23:07Z) the volume had room for a few minutes, the service ran
  ticks, and died again; the second death, at 23:13:21Z, was Node's fatal
  `A FileHandle object was closed during garbage collection` for
  `parameters.json.lock`: the handle `withStateLock` leaks when the write
  after its `open` fails.
- **Who started it at 04:37.** systemd did, on restart 669. At 04:36:47Z the
  maintainer freed space by hand (`paccache -rk1`); the start at 04:36:51Z
  was the first whose writes succeeded.
- **Why the urgent sweep and spec 059 did not help.** The urgent sweep at
  22:48 ran and found nothing of the system's own to remove on the state
  volume; the volume was above the launch floors, so spec 064 AC-2 sent
  nothing. Spec 059 postpones launches; nothing in it or in spec 100 covers
  the scheduler's own writes failing.
- **No alarm was sent.** Both alarm paths write before they send: the
  sweep's alarm writes its service-log line first (which threw), and the
  host monitor saves `host.json` before it logs the pause, files the finding
  or notifies (`#save` in `service/host.ts`, which threw). The log has no
  `host-paused`, `disk-sweep-alarm` or `notify` record for the outage. Had a
  send been reached, it would have worked: `TelegramNotifier` sends before it
  writes.

What filled the device within a minute is not established: the state root
holds about 1.5 GiB of a 115 GiB filesystem today, and the space came back
from the package cache. Judging holders outside the state root is the infra
health agent's (spec 064 AC-5), not this spec's.

### The fix

1. **The service log never throws** (AC-1). A record that cannot be appended
   goes to stderr, which is the journal, and waits in memory; the next append
   that succeeds writes the waiting records first, with their own times.
2. **A state volume under the write floor pauses the scheduler** (AC-2,
   AC-3). The tick reads the state root's free space right after
   `host.beginTick()`, before the sample, the backfill and `initializeAgents`
   (which write), and pauses with cause `ENOSPC` when it is under the *write floor*, without
   waiting for some step to fail. The pause holds in memory when `host.json`
   cannot be saved.
3. **The notice goes out first and each part stands alone** (AC-4, AC-5). The
   Telegram message is sent before anything is written; the finding, the
   `infra_alarm` and the saved state are each tried again until they land.
   A message that could be neither sent nor queued is reported as not
   delivered and sent again on the next paused tick; the record of one that
   was sent (its `maintainer.contact` event) waits in memory for room.
4. **A start on a full state volume waits** (AC-6, AC-7), with one Telegram
   message, and leaves a log record and a finding once it can write.
5. **`withStateLock` cleans up a lock it could not write** (AC-8).

*(agent's call)* The pause is spec 100's, not a new state: a full state volume
is a host that cannot work, ADR 0015's case, and one `paused` record keeps the
loop, the driver and the standing runner agreeing. The write floor is a module
constant like spec 059's floors. The process waits in place at start rather
than exiting for systemd to retry, because a waiting process can send the
notice once and costs nothing, while 669 restarts each read the App key and
called GitHub. No space is reserved in advance (a ballast file): whatever
fills a device at 20 MiB a second takes the ballast in seconds, and the notice
needs the network, not the disk. Every change is cheap to reverse; no ADR
(design section 3, item 2).

## 2. Out of scope

- Finding or removing what filled the device. The sweep's closed list (spec
  064 AC-1 to AC-4), its floors, ages and interval, and the test helper's
  rule for `panelator-test-*` roots are unchanged; the investigation above
  found no fault in them.
- A retention policy for `runs/`, `patches/` or any record (spec 064 section
  2 leaves it; so does this spec).
- The temp volume. A full temp directory is specs 059 and 064's case and the
  scheduler keeps running through it today; the write floor and the start
  gate read the state root only, so a start during a temp-volume episode
  still reaches the sweep that ends it.
- The systemd unit. `Restart=on-failure` and `RestartSec=10` stay; with AC-6
  and AC-7 a restart on a full volume waits at the gate.
- Counting or reporting restarts in the infra health input: issue #345.
- A volume that reports free space above the write floor and still refuses
  writes (a quota). AC-1, AC-3 and AC-7 keep the process alive and the trace
  in the journal; the pause then comes from spec 100 AC-2 as today.
- Sweeping while the process waits at the start gate. The sweep needs the
  action log, which is a write; the gate's notice tells the maintainer.
- Rewriting the records of 2026-11-22 by hand.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the recorded
worlds of `tools/scheduler/test/helpers/e2e-routes.ts` with their `freeSpace`
option (spec 059 AC-6). The *write floor* is `STATE_WRITE_FLOOR_BYTES` (64
MiB) and `STATE_WRITE_FLOOR_INODES` (100; a volume reporting no inodes is
judged on bytes only, as in spec 059), read for the state root (`paths.root`)
with spec 059's reader. The *launch floors* are spec 059's. A *space failure*
is an error for which `transientCause` returns `ENOSPC` (spec 059 AC-1).

- AC-1. **The service log never throws and loses no record while the process
  lives.** `ServiceLog` takes an optional `append(path, text)` (test seam,
  default `appendFileSync`) and an optional `stderr(line)` (default
  `process.stderr.write`). Given `write(rec)` whose append throws any error,
  then `write` returns normally, the record (with the `at` it was given) is
  kept in an in-memory queue, and its JSON line is written to stderr prefixed
  `service-log unwritten: `. Given a later `write` while the queue is not
  empty, then the queued records and the new one are appended in one call, in
  order, each with its original `at`; given that append throws, all of them
  stay queued. The first append after a failure starts with a newline, so a
  fragment the failed append left (spec 103's torn line) does not swallow the
  record after it. The queue holds at most `LOG_QUEUE_MAX` (2,000) records;
  given one more, the oldest is dropped and the next successful append is
  followed by `{ kind: "service-log-dropped", count, from, to }` naming how
  many were dropped and the `at` of the first and last. `stopped()` goes
  through `write`. Tests: an append that fails three times then succeeds
  leaves the file holding all four records in order with their original
  times; a fragment without a newline followed by a successful append reads
  back, through `readJsonl`, as one skipped line and the record; the queue's
  bound and its `service-log-dropped` record; `run()` on a `Scheduler` whose
  tick rejects and whose log append throws does not reject (the failure of
  22:51:02Z).
- AC-2. **A state volume under the write floor pauses the scheduler.** Given a
  tick, when the loop has called `host.beginTick()` (which only reads the host
  state) and before anything else in the tick (before the `slots` read, the
  events backfill, `#sample()`, `initializeAgents` and the read of
  `host.paused`), then it reads the state root's free space; given it is under
  the write floor and the host is not paused, then the monitor's
  `pauseFor("ENOSPC", error)` records the pause exactly as spec 100 AC-2 does
  for a failed probe (`paused: { since, cause: "ENOSPC", probes: 1,
  next_probe_at, notified: false }`, one `{ kind: "host-paused", cause, error
  }` line), with `error` `state volume under the write floor: <path> has <n>
  MiB free and <m> free inodes (floor 64 MiB, 100 inodes)`, and the tick is a
  paused tick (spec 100 AC-3) returned at once, without the probe (which
  needs the launch floors, which the volume does not meet): the sample, the
  events backfill and `initializeAgents` (each of which writes, the last one
  `parameters.json.lock`) do not run on a tick under the write floor, so
  none of them can stop the tick before the pause is recorded and its notice
  is due (spec 100 AC-5, cause `ENOSPC`). The same holds for a tick that finds
  the host already paused with cause `ENOSPC` and the volume still under the
  write floor. No claim, ledger or agent state is touched. Given the read
  itself fails, then `host-space-unknown` is logged as in spec 059 AC-3 and
  the tick goes on. Given the volume is at or above the write floor, nothing
  changes: between the write floor and the launch floors the scheduler runs,
  sweeps and pauses as specs 059, 064 and 100 say today. The pause ends as
  spec 100 AC-4 says, when the probe passes, which needs the launch floors:
  a volume that climbs back above 64 MiB but not above 512 MiB stays paused.
- AC-3. **A pause, and everything else in the host state, holds when
  `host.json` cannot be saved.** The monitor's in-memory state is what the
  process acts on. Given a save of the host state that rejects with a space
  failure, then the method that asked for it (`pauseFor`, `onTransient`,
  `probeIfDue`, `noticeIfDue`, `markSeen`, `recordSleep`,
  `markRestartPending`) completes as if the save had succeeded: `onTransient`
  returns true, the `host-paused` line is logged, the tick is paused. The
  failed save is logged once per pause as `{ kind: "error", error: "host
  state: <message>" }`, and the current state is saved again by the next
  method that saves; the save that follows a resume therefore writes the
  `host` downtime interval of the whole pause. A save that rejects with any
  other error rejects as today. `markSeen`'s space failure is not logged per
  tick while paused. Tests: with the state write failing, `onTransient`
  returns true and `paused` is set; a resume after the write works leaves
  `host.json` with `paused: null` and one `host` interval from the pause's
  `since`.
- AC-4. **The notice sends first, and each part stands alone.** For spec 100
  AC-5's notice the monitor does, in this order: the notification; the
  `host-paused-notice` log line; the finding; the `infra_alarm`; the save of
  `notified: true`. Given a part that rejects with a space failure, then the
  later parts are still attempted, and the failed part is attempted again on
  each paused tick and on the tick that resumes until it succeeds; a part
  that succeeded is not repeated (the monitor keeps which parts are done in
  memory; `notified` in `host.json` means the notification part is done).
  The notification part is done when `notify` resolves (`telegram`, `queued`
  or `suppressed`); a notification that was neither sent nor queued rejects
  with a space failure (AC-5, "Not delivered"), so the part is not done,
  `notified` stays false and the send is tried again on the next paused
  tick.
  Given a part that rejects with any other error, then it is logged as an
  `error` and not retried, and the later parts are attempted. The finding's
  `timestamp` is the time the notice became due, not the time it was
  appended. The sweep's alarm (spec 064 AC-2) follows the same rule: the
  notification first, then the `disk-sweep-alarm` line, the finding and the
  `infra_alarm`; `episode: { since, alarmed: true }` is held in the process's
  memory when `disk-sweep.json` cannot be written, so each part happens once
  per episode, and a part that rejected with a space failure (the
  notification not delivered, AC-5, included) is attempted again by each
  later sweep of that episode until it succeeds. When the full volume is the state volume, a paused tick's volume sweep
  (spec 100 AC-3) reaches that alarm too, and the maintainer gets both
  messages, one per label: the host notice (label `host`) and the sweep's
  alarm (label `disk_full`); the rate limiter suppresses neither, as their
  identities differ, and each is sent once (the alarm's episode is held in
  memory). Spec 064 AC-2 is marked for this. Tests: with every state write
  failing, one paused tick sends exactly one notification of label `host` (gate `infra`) and appends nothing;
  ten more such ticks send nothing more of that label; the first tick whose writes work
  appends exactly one finding (`stops_pipeline: true`, `timestamp` the due
  time) and emits exactly one `infra_alarm` of kind `disk_full`; and, with every
  state write failing and a Telegram channel whose `sendReply` throws on the
  first paused tick only (the chain of AC-5), that tick delivers nothing and
  the next paused tick delivers exactly one message of label `host` and one
  of label `disk_full`, with no more on the ticks after it.
- AC-5. **A sent message is a delivered notification; one neither sent nor
  queued is not, and is tried again.** The chain is the one the bin builds,
  `rateLimited(recordedNotifier(TelegramNotifier(new LogNotifier(...))))`,
  which moves unchanged into `notifierChain(deps)` of
  `tools/scheduler/src/notify/chain.ts` so that the bin and the tests build
  the same one. A notification ends in one of three ways.
  - **Sent.** Given `TelegramNotifier.notify` whose send to the chat
    succeeded, then the chain's `notify` resolves `{ channel: "telegram" }`
    whatever happens to the four writes that record the send, none of which
    rejects it: the alert ids (a failed write of them is ignored, as today); the inner
    `LogNotifier`'s `notify` line (`TelegramNotifier` catches its rejection
    and writes the line's record through `deps.log`, the service log, which
    AC-1 keeps); the rate limiter's sent map (kept in memory, as today); and
    `recordedNotifier`'s `maintainer.contact` event (spec 026 AC-2). Given
    that event's `record` rejects with a space failure, then
    `recordedNotifier` keeps the event in memory with the time and channel of
    the send (at most `CONTACTS_KEPT`, 100; one more drops the oldest), and
    writes the kept events, oldest first and each with its own time, before
    the next event it records and on every `flush()` (the loop calls it once
    per tick, paused ticks included, spec 102 AC-3); a write that fails
    leaves them kept and rejects nothing. Given `record` rejects with any
    other error, the event is dropped. Either failure is logged once as `{
    kind: "error", error: "notify record: <message>" }` through the optional
    `log` that `recordedNotifier` now takes. The rate limiter's in-memory
    map suppresses a repeat within its window.
  - **Queued.** Given no channel or a failed send, and the outbox write
    succeeds, then `{ channel: "queued" }` as spec 102 AC-2 says; the same
    rules hold for the inner line and the contact event.
  - **Not delivered.** Given no channel or a failed send, when the outbox
    write rejects with a space failure, then nothing holds the notice, and
    `TelegramNotifier.notify` rejects with that write's error (today it
    resolves `{ channel: "log" }`; it still does for an outbox failure that
    is not a space failure). It logs `{ kind: "error", error: "notify
    undelivered: <identity>: <message>" }` once per identity until a `notify`
    for that identity resolves. `recordedNotifier` passes the rejection on
    and records no contact. `rateLimited`, given the inner `notify` rejects
    with any error, puts the identity's entry in its map back to what it was
    before the call (removed when there was none), saves the map as it does
    today and rejects with the same error: an identity that was not
    delivered is not held, so the next call for it is sent. The caller sees
    a space failure. The host monitor and the sweep's alarm (AC-4) treat it
    as their notification part not done and try again on the next paused
    tick, so the notice reaches the maintainer on the first tick whose send
    works, without any write. Any other caller's tick step fails with a
    space failure, which pauses the scheduler as spec 100 AC-2 says.

  Tests, each on `notifierChain` with every write under the state root
  throwing `ENOSPC`: a channel that accepts sends once, the call resolves `{
  channel: "telegram" }`, a second call resolves `{ channel: "suppressed" }`,
  and once writes work the next `flush()` appends exactly one
  `maintainer.contact` event with channel `telegram` and the time of the
  send; a channel whose `sendReply` throws once makes the first call reject
  with a space failure and the second call, inside the window, send and
  resolve `{ channel: "telegram" }` (one message delivered, one contact
  event after the volume has room); the same with `telegram()` returning
  null on the first call.
- AC-6. **A start on a full state volume waits before its first write.** In
  the service path of `bin/scheduler.ts` (no subcommand; `--check-auth`
  excluded), after the configuration and the registry are loaded and the
  Telegram credentials are read, and before `await initializeAgents(...)`
  (`bin/scheduler.ts`, which runs before every subcommand branch and writes
  `parameters.json.lock` through `parameters.initialize()`: the first state
  write of every start), the bin awaits `waitForStateSpace(deps)` of `src/service/start-gate.ts`. Given the
  state root at or above the write floor, it returns `null` at once and
  writes nothing. Given it is under the write floor, then it writes one
  stderr line `panelator-scheduler: state volume full, waiting to start:
  <path> has <n> MiB free and <m> free inodes`, sends one Telegram message
  through `deps.send` (the bin builds it before the gate from the Telegram
  credentials, read with `telegramCredentials` and the credential store and
  sent with `TelegramClient`, which write nothing; absent when Telegram is
  off or its credentials cannot be read, and a send that fails is retried at
  each re-read until one succeeds). What moves before the gate is only that
  read of the credentials and the building of the sender; `startTelegram`,
  the App key read, `app.refreshTokenFile` (which writes the token file),
  `actionLog.markStalePending()` and every other step stay where they are,
  after the gate. The message says that the scheduler cannot start because
  the state volume is full, gives the path and the numbers, and says that it
  starts by itself when there is room. The gate then re-reads the space
  after `outageBackoffS(n)` for the n-th read (spec 015's backoff, 60 s
  doubling to 1800 s) until the volume is at or above the launch floors,
  and returns `{ since, waited_ms, free_bytes, free_inodes }` (the first
  reading's numbers). A read that fails counts as room: the gate never blocks
  a start on its own failure. Given a non-null return, then once the service
  log exists the bin writes `{ kind: "start-waited", cause: "ENOSPC", since,
  waited_ms, free_bytes, free_inodes }` and appends one finding (`what:
  "state volume full: the scheduler waited to start"`, `where: <path>`,
  `evidence` naming `since`, the wait and the numbers, `noticed_how:
  "scheduler start gate"`, `stops_pipeline: true`, issue 0, stage
  `scheduler`, run id `start-gate`). The start then goes on as today; the
  interval since the last tick is `stopped` downtime as spec 100 AC-6
  records it. `SIGTERM` during the wait exits 0. A
  start-order test over the bin's source order or a bin run with a state
  root whose every write fails `ENOSPC` asserts that no file is created under
  the state root before the gate returns. Tests drive
  `waitForStateSpace` with a fake clock: room at once (null, nothing sent);
  full for three reads then room (one stderr line, one message, the
  returned record, the read times); a send that fails twice then succeeds
  (one delivered message); a read that throws (null).
- AC-7. **A space failure during start is not a crash loop.** Given the
  service path of the bin, when any step after the gate and before the first tick
  rejects or throws with a space failure, then the process writes one stderr
  line `panelator-scheduler: state volume full during start: <message>` (no
  stack) and exits 75, so systemd starts it again and the new process waits
  at the gate. Any other start failure exits as today (1, or 78 for a config
  error). Given the running service, when a promise nobody awaits rejects
  with a space failure, then the bin's `unhandledRejection` handler logs `{
  kind: "error", error: "unhandled: <message>" }` and the process goes on;
  any other unhandled rejection ends the process as today. Tests: the bin's
  exit test (spec 088's harness) with a state root whose first write fails
  `ENOSPC` exits 75 with that line; the handler function is unit-tested for
  both kinds of error.
- AC-8. **`withStateLock` leaves nothing behind when it cannot write its
  lock.** Given `open(lock, "wx")` succeeded and the write of the pid
  rejects, then the handle is closed, the lock file is removed (a failure to
  remove is ignored), and the call rejects with the write's error; no handle
  is left for the garbage collector. The 30-second age rule for a lock
  that cannot be read as a live pid stays as it is: an empty lock is the
  window between the `open` and the pid write of a live owner, shared with
  command-line processes, and is not reclaimed earlier. Tests: a write that
  rejects `ENOSPC` leaves no lock file and no open handle and a second call
  takes the lock at once; an empty lock younger than 30 seconds is not
  taken.
- AC-9. **The outage of 2026-11-22, end to end.** A recorded world with one
  claim in flight and Telegram attached; from tick 2 the state root reads 0
  bytes free and every write under it (the service log's append, the event
  store's sample, the events backfill and `parameters.json.lock` in
  `initializeAgents` included) throws `ENOSPC`; from tick 8 it reads 30 GiB and writes succeed. Then:
  `run()` never rejects; tick 2 is a paused tick and exactly one Telegram
  message of label `host` and one of label `disk_full` (the sweep's alarm,
  AC-4) are sent in ticks 2 to 7, and no other; nothing is counted on the claim; on tick
  8 or the first tick whose probe is due the scheduler resumes; afterwards
  `service.jsonl` holds, in time order with their original times, the
  `host-paused`, `host-paused-notice` and `host-resumed` records and every
  tick line of ticks 2 to 7 (each carrying `host`), the findings queue holds
  exactly one `host outage pauses the scheduler: ENOSPC` finding with
  `stops_pipeline: true`, `host.json` has `paused: null` and one `host`
  interval covering ticks 2 to 8, and the claim is startable at once.

## 4. Amendments to earlier specs

- Spec 100 AC-2 is marked `Amended by [114] AC-2`: the scheduler also pauses,
  without a failed step, when the state volume is under the write floor, and
  the pause holds when `host.json` cannot be saved (AC-3).
- Spec 100 AC-5 is marked `Amended by [114] AC-4`: the notification is sent
  first and each part of the notice is retried by itself after a space
  failure.
- Spec 064 AC-2 is marked `Amended by [114] AC-4`: the alarm's notification is
  sent first, each part stands alone, and the episode is held in memory when
  `disk-sweep.json` cannot be written.

## 5. Interfaces and files

- `tools/scheduler/src/service/log.ts`: `ServiceLog` with the queue, the
  `append` and `stderr` seams, `LOG_QUEUE_MAX` (AC-1).
- `tools/scheduler/src/runner/host-space.ts`: `STATE_WRITE_FLOOR_BYTES`,
  `STATE_WRITE_FLOOR_INODES`, `underWriteFloor(free)` (AC-2, AC-6).
- `tools/scheduler/src/service/host.ts`: `HostMonitor.pauseFor(cause,
  error)`; saves that survive a space failure; the notice's ordered,
  separately retried parts (AC-2 to AC-4).
- `tools/scheduler/src/service/loop.ts`: the write-floor read after
  `host.beginTick()` and before the `slots` read, the backfill, `#sample()` and
  `initializeAgents`, with the paused return (AC-2); `SchedulerDeps.freeSpace` is the reader, as for the sweep.
- `tools/scheduler/src/service/sweep.ts`: the alarm's order and its
  in-memory episode (AC-4).
- `tools/scheduler/src/notify/telegram.ts`: a failed write after a send does
  not reject; a notice neither sent nor queued on a space failure rejects
  (AC-5).
- `tools/scheduler/src/notify/recorded.ts`: `recordedNotifier(inner, paths,
  clock, log?)` keeps a `maintainer.contact` event it could not write and
  writes it later; `CONTACTS_KEPT` (AC-5).
- `tools/scheduler/src/notify/rate-limit.ts`: an identity whose inner
  `notify` rejected is not held (AC-5).
- `tools/scheduler/src/notify/log.ts`: as AC-5 needs; its rejection is
  caught by `TelegramNotifier`.
- `tools/scheduler/src/notify/chain.ts` (new): `notifierChain(deps)`, the
  chain `bin/scheduler.ts` builds today, moved unchanged (AC-5).
- `tools/scheduler/src/service/start-gate.ts` (new): `waitForStateSpace`
  (AC-6).
- `tools/scheduler/bin/scheduler.ts`: the notifier built with
  `notifierChain` (AC-5); the gate, the `start-waited` record and
  finding, exit 75 on a space failure during start, the `unhandledRejection`
  handler (AC-6, AC-7).
- `tools/scheduler/src/parameters/store.ts`: `withStateLock` (AC-8).
- `schemas/scheduler/`: no change; `host.json`, the finding and the
  `infra_alarm` payloads keep their shapes.
- Tests: `tools/scheduler/test/service-log.test.ts` (new, AC-1),
  `tools/scheduler/test/host.test.ts` (AC-2 to AC-4),
  `tools/scheduler/test/sweep.test.ts` (AC-4),
  `tools/scheduler/test/telegram.test.ts` and
  `tools/scheduler/test/notify.test.ts` (AC-5),
  `tools/scheduler/test/start-gate.test.ts` (new, AC-6),
  `tools/scheduler/test/bin.test.ts` (AC-7),
  `tools/scheduler/test/parameters.test.ts` (AC-8),
  `tools/scheduler/test/loop-1.test.ts`,
  `tools/scheduler/test/loop-2.test.ts`,
  `tools/scheduler/test/loop-3.test.ts`,
  `tools/scheduler/test/loop-4.test.ts`,
  `tools/scheduler/test/loop-5.test.ts` and
  `tools/scheduler/test/loop-6.test.ts` (AC-1, AC-2, AC-4, AC-9; spec 100's
  pause and notice tests are in `loop-4`, and any of the six may take a
  test), and `tools/scheduler/test/helpers/e2e-routes.ts` and
  `tools/scheduler/test/helpers/loop-harness.ts` (the AC-9 world whose every
  write under the state root throws `ENOSPC`).
- New outbound call: the start gate (AC-6) sends one `sendMessage` to the
  Telegram Bot API (`api.telegram.org`) through `TelegramClient`, directly and
  not through `startTelegram`, the notifier, the outbox or the rate limiter,
  with the `telegram-bot` credential that the bin now reads before the gate.
  It is sent once the gate finds the volume full and again at each backoff
  re-read (`outageBackoffS(n)`, 60 s doubling to 1800 s) until one send
  succeeds. The text carries only the state root path and the free-space
  numbers. A failed send's error is logged without the token. No new network
  listener and no new shell execution is added.

`tools/scheduler/` is a sensitive path (the whole directory), so the
implementation PR gets the security review; `docs/delivery-system-design.md`
is one too, and this spec's PR changes only its `## Children` list. Nothing
here changes the sensitive-path list, the security criteria or instructions,
what routes a sensitive diff to the security review, that both reviews must
approve, or that a sensitive path must be listed in the spec. No parameter,
stage prompt, agent definition or action kind is added or changed, and the
systemd unit is untouched.

## 6. Verification

- `pnpm test` from the repo root passes, with the tests each criterion names.
- AC-9's world is the regression test for the outage: it fails on `main`
  today (`run()` rejects on the first failed log append).
- After the merge and the scheduler's self-restart, the next infra health
  sweep reads a service log with no `ENOSPC` `error` record outside a
  `host-paused` to `host-resumed` interval.

## 7. Open decisions

None.
