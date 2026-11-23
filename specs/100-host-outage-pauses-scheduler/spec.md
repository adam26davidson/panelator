# 100. A host that cannot work pauses the scheduler; only an issue's own failures spend its bounds

Status: written 2026-11-21 from the delivery-system design for issue #251;
specs derived from that design need no maintainer approval (design section
11). Carries the maintainer's direction of 2026-11-17 recorded in
[ADR 0015](../../docs/decisions/0015-host-outage-pauses-scheduler.md).
Amends [015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md) AC-8
and AC-13, [045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
AC-2 and AC-6, [059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md)
AC-3 and AC-4, [001-scheduler-core](../001-scheduler-core/spec.md) AC-15 and
[006-no-human-stops](../006-no-human-stops/spec.md) AC-17, marked as section
4 records.
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain's bounds: a rescue, a re-plan and a spec revision are
counted per issue; the terminal state is abandonment) and section 6.1 (infra
health is woken by alarms); [ADR 0015](../../docs/decisions/0015-host-outage-pauses-scheduler.md)
(the two kinds of failure, the maintainer's direction); spec 015's reading,
now the maintainer's decision, that the bounds count failures of the work and
not of the infrastructure; [013-quota-planning](../013-quota-planning/spec.md)
AC-6 and AC-7 and [023](../023-waiting-claim-is-not-stalled/spec.md) (the quota `waiting`
stage, an instance of the model, unchanged); [092-chain-stage-waits-out-network-outage](../092-chain-stage-waits-out-network-outage/spec.md)
AC-1 (a stage run that lost the API rejects the step transiently, which is
one of this spec's triggers); [064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
AC-1 (the sweep that frees space, which keeps running while the scheduler is
paused); [050-infra-alarm-kind-and-aws-cap-zero](../050-infra-alarm-kind-and-aws-cap-zero/spec.md)
AC-3 (the list of alarm kinds, which gains `host_outage` by its own rule).

## 1. Goal

Two kinds of failure, treated differently (ADR 0015, the maintainer's
direction of 2026-11-17):

1. **The host cannot work**: no network, the model subscription's limit, a
   full disk, the laptop off or asleep. Nothing is wrong with any issue. The
   scheduler pauses, probes for the cause to clear, and resumes as soon as it
   has. No issue's bounds, claim or chain-error release are touched, and the
   maintainer hears once if a pause lasts.
2. **One issue's work is failing**: checks, review, scope, the fix loop. The
   existing escalation path applies, unchanged. Only this kind may end in
   abandonment.

### What is wrong today (spec agent's reading of the code and the live log, 2026-11-21)

Three places infer a host failure from one issue's record, or measure a
window on the wall clock while the scheduler was not running:

- **The outage ceiling.** `#countTransient` in
  `tools/scheduler/src/service/loop.ts` records each transient failure on the
  claim's `outage`; once `since` is `OUTAGE_CEILING_MS` (24 h) old each
  failure counts toward `MAX_CHAIN_FAILURES`, the `chain_error` release
  follows, the re-claim fails at once in the same outage and the second
  release abandons the issue. The standing runner
  (`tools/scheduler/src/standing/run.ts`) does the same with the agent's
  `failures`. Issue #101 was released on 2026-11-12T07:17:26Z with `outage
  past ceiling: ... Could not resolve host: github.com` and abandoned 56
  minutes later with `chain-error release 1/1`, during an outage of the
  laptop's network that no issue caused.
- **Liveness.** `livenessGate` (`tools/scheduler/src/gates/liveness.ts`)
  compares `last_activity_at` with the wall clock. A scheduler that was not
  running for longer than `liveness_hours` wakes and reads the gap as a chain
  left idle: on 2026-10-31T12:18:30Z the service logged `resumed` after
  165,076,291 ms asleep and released #15 by liveness 18 s later, closing its
  open PR and dropping the claim. The loop already tells a sleep from running
  time (`run()` compares `d.now()` with `d.monotonic()` and logs `resumed`),
  and uses it only to refresh the token.
- **Verify pending.** `verifyChecks` in `tools/scheduler/src/chain/machine.ts`
  compares the `checks` event's `at` with `pendingSince` against
  `VERIFY_PENDING_MAX_H` (6 h) on the wall clock, so a scheduler down for six
  hours while CI ran wakes, re-runs the checks and spends a fix run on
  "investigate why they never report".

What already fits the model stays as it is: a quota limit makes the claim
wait until `resets_at` with nothing spent (specs 013 and 023); a transient
failure inside a claim's first day is not counted (spec 015); a run the host
refused for want of space is not the work's failure (spec 059).

### The fix

One new module, `tools/scheduler/src/service/host.ts`, holds the **host
monitor**: the probe, the pause and the **downtime log**.

- **The host probe** says whether the host can work: its checked volumes
  have space (spec 059's reader and floors, on the state root and the
  harness's temporary directory) and it can resolve and reach `github.com`
  and `api.github.com`. Any HTTP response, whatever its status, is reached: a
  revoked token or a 403 is GitHub answering, which is an issue's problem or
  the maintainer's, not the host's.
- **The pause.** The probe runs when something fails in a way that looks like
  the host (a transient driver step, a transient standing run, a transient
  freshness fetch), never on a healthy tick. While it fails the scheduler is
  paused: no claim, no run, no release, no failure counted, no probe of
  GitHub for answers; the sweep that frees space still runs. It re-probes on
  spec 015's backoff and resumes on the tick that finds the probe passing.
  A pause two hours old (at once for a full disk) tells the maintainer once.
- **The downtime log** records every interval the scheduler was not running
  or was paused: a pause, a sleep the loop detects, a gap between the last
  tick of one process and the first of the next. Every window that *judges*
  (liveness, verify pending, the age of a claim's or a standing agent's
  outage) subtracts the downtime inside it; every wall-clock use that merely
  *schedules* is unchanged.
- A transient failure while the probe passes is the issue's own (kind 2) and
  takes spec 015's path exactly as today, the ceiling included: that is what
  the ceiling guards (a host that never resolves for one URL, a port that
  always refuses), and the probe keeps the guard without abandoning issues
  during real outages.

*(agent's call)* The probe decides the pause; a per-claim record cannot,
because one claim's failures are the same whether the network is down or its
token is revoked, and the live record shows both. The probe includes the
disk because the maintainer lists a full disk as a host failure that never
abandons, and spec 059's per-claim ceiling could. Downtime is kept as a log
of intervals rather than by rewriting stamps or keeping a second clock: the
existing stamps (`last_activity_at`, `outage.since`, `pendingSince`) keep
their meaning, the comparisons stay where they are with one subtraction, and
the three windows share one definition. The probe reaches the GitHub hosts
and not the model provider's: a model API unreachable while GitHub answers is
rare, spec 092 already makes such a run transient, and it takes the kind-2
path with its ceiling. Nothing here is costly to reverse; the ADR records the
maintainer's model, not a technical choice of this spec.

## 2. Out of scope

- Wall-clock uses that schedule rather than judge: the quota backoff and
  `MAX_WAIT_MS`, `retry_at` and `postponed_until`, standing-agent cadence and
  `next_run`, the filer's seven-day re-review, the 24-hour question reminder,
  the sweep's stale-file age, the debounce of spec 025. A reset or a due time
  that passes during a pause is simply due when the pause ends.
- Pipeline bugs no host probe sees (the filer's five days of `spawn E2BIG`,
  issue #250): a separate issue.
- The Telegram poller's own connect retry (spec 089) and the harness's
  behaviour inside a run.
- Probing the model provider's hosts, or reading the quota book in the probe:
  a quota limit already pauses the work it blocks (specs 013 and 023).
- A genuine failure (a 4xx, `exit 1`, a merge conflict, a `stage_failed`)
  that arrives while the scheduler is paused, from a run that was in flight
  when the pause began: counted as today. Spec 092 already makes a run that
  lost the API transient, so a host outage reaches a run as a transient
  failure.
- Rewriting the ledger of #101 or any issue an earlier ceiling released.
- New parameters: the probe's hosts, timeout, backoff and notice age are
  module constants, as spec 059's floors are.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the recorded
worlds of `tools/scheduler/test/helpers/e2e-routes.ts`, as specs 015, 045 and
059 do. *Transient error*, *outage* and *transient run* are spec 015's and
spec 092's definitions. The *downtime between* two instants is the length of
the union of the downtime log's intervals clipped to them. The *active age*
of a stamp is now minus the stamp minus the downtime between them.

- AC-1. **The probe.** `probeHost(deps)` in `tools/scheduler/src/service/host.ts`
  returns `null` when the host can work, else a cause label. It checks, in
  this order, stopping at the first failure: the free space of the state root
  and of the harness's temporary directory (spec 059 AC-3's `freeSpace`
  reader and floors, `host-space-unknown` passing as there), cause `ENOSPC`;
  then, for each of `PROBE_HOSTS` (`github.com`, `api.github.com`), a `HEAD`
  request to `https://<host>/` through `deps.fetch` (default the global
  `fetch`) with `redirect: "manual"` and `AbortSignal.timeout(PROBE_TIMEOUT_MS)`
  (10 s). A response of any status is reached. A request that throws fails
  the probe with `transientCause(error)` as the cause, else the error's
  `code` or first line (spec 093's `failureCause`). Tests cover: all pass;
  space low (`ENOSPC`, no request made); `EAI_AGAIN` on the first host; a 403
  and a 500 response (pass); a `TimeoutError`.
- AC-2. Amended by [114-full-state-volume-does-not-stop-scheduler](../114-full-state-volume-does-not-stop-scheduler/spec.md) AC-2: the scheduler also pauses, without a failed step, when the state volume is under the write floor, and the pause holds in memory when `host.json` cannot be saved (its AC-3). **A host failure pauses the scheduler and counts nothing.** The
  monitor's `onTransient(cause, error)` runs the probe at most once per tick
  (later calls in the same tick reuse the result). Given a driver step that
  rejects with a transient error (spec 015 AC-5's path, spec 059 AC-3's
  pre-flight error, spec 059 AC-4's host-refused run and spec 092 AC-1's
  transient run included), when the probe fails, then: the claim is written
  with no `outage` and `chainFailures` and the ledger unchanged (an `outage`
  already on the claim stays as it was, neither counted nor cleared); the
  host state `paused: { since, cause, probes: 1, next_probe_at, notified:
  false }` is written to `paths.host` (`state/host.json`, schema
  `schemas/scheduler/host.json`), with `next_probe_at` `outageBackoffS(1)`
  after now; the service log gets one `{ kind: "host-paused", cause, error }`
  per pause; no `transient-outage` line, no finding, no notification, no
  `infra_alarm`. Given a standing run that fails transiently (spec 045 AC-1's
  classification) when the probe fails, then the agent's state keeps
  `failures`, `pending_events`, `next_run` and `last_run`, gets neither
  `outage` nor `postponed_until`, `running` is cleared and the worktree
  removed as today, the `agent.run` record is written as today, and the log
  gets `standing-host-paused` with agent, cause and error in place of
  `standing-outage` and `standing-postponed`. Given the tick's freshness
  fetch fails with a transient cause when the probe fails, then the tick
  pauses the same way before any claim is read. Given the probe passes in
  each of these cases, then everything happens exactly as today (spec 015
  AC-5 to AC-8, spec 045 AC-2 to AC-5, spec 059 AC-3 and AC-4).
- AC-3. **A paused tick waits.** Given `paused` set, then a tick does only:
  the probe when now is at or after `next_probe_at` (AC-4); the volume sweep
  of spec 064 AC-1; the stop and restart handling; the usage prune; and its
  service-log line, which carries `host: { paused_since, cause, probes,
  next_probe_at }`. It does not refresh the token, fetch origin, scan
  children, watch main's checks, audit Telegram replies, handle paused
  records, check liveness, hand out a `chain_error`, start a claim's chain,
  claim an issue or start a standing agent; `info.eligible` is 0 and
  `claimed`, `released` and `standing` are empty. A chain or standing run in
  flight when the pause began runs to its end; its result is applied as
  today (a transient rejection takes AC-2 and keeps the pause).
- AC-4. **Re-probe on a backoff, resume on the tick that passes.** Given a
  paused tick with `next_probe_at` reached, when the probe fails again, then
  `probes` is one more and `next_probe_at` is `outageBackoffS(probes)` after
  now (60 s doubling, capped at 1800 s); the cause recorded is the first
  failure's. When the probe passes, then `paused` is cleared, the downtime
  log gains `{ from: since, to: now, reason: "host" }`, the log gets `{ kind:
  "host-resumed", since, cause, probes, paused_ms }`, and the same tick goes
  on with its ordinary work: a claim whose step rejected during the pause is
  startable at once (no `retry_at`), a standing agent that failed during it
  is due as its events and schedule say, and the liveness check in that tick
  already sees the interval (AC-6).
- AC-5. Amended by [114-full-state-volume-does-not-stop-scheduler](../114-full-state-volume-does-not-stop-scheduler/spec.md) AC-4: the notification is sent first, and each part of the notice is retried by itself after a failure for want of space. **One notice for a long pause.** Given a paused tick whose pause is
  `HOST_NOTICE_MS` (2 h, wall clock: a pause that spans a sleep is still a
  pause) or more old and `notified` false, or whose cause is `ENOSPC` on the
  first paused tick, then the monitor sets `notified`, logs `{ kind:
  "host-paused-notice", since, cause, probes }`, appends one finding (`what:
  "host outage pauses the scheduler: <cause>"`, `where: "scheduler host"`,
  `evidence` naming `since`, `probes` and the last error, `noticed_how:
  "scheduler host probe"`, `stops_pipeline: true`), sends one notification
  (gate `infra`, issue 0, label `host`, text naming the cause and how long
  the scheduler has been paused, and that it resumes by itself) and emits one
  `infra_alarm` with payload `{ kind, since, probes, cause }` where `kind` is
  `disk_full` for `ENOSPC` (spec 059's kind, so spec 064's infra health
  wakes as today) and `host_outage` otherwise (added to spec 050 AC-3's list
  by its own rule; infra health treats it as spec 050 AC-3 says for a kind
  it does not act on). Nothing more is sent for the same pause, and nothing
  on resume.
- AC-6. Amended by [104-pending-restart-is-downtime](../104-pending-restart-is-downtime/spec.md) AC-2: the reasons gain `restart`, the interval a previous process spent with a self-restart pending. **The downtime log, and liveness counts running time only.**
  `recordDowntime(paths, { from, to, reason })` appends to `host.json`'s
  `downtime` array (reasons `host`, `sleep`, `stopped`), dropping entries
  older than `DOWNTIME_KEEP_MS` (90 days). `downtimeBetween(log, from, to)`
  returns the union length of the intervals clipped to `[from, to]`, so
  overlapping entries count once. The loop records: on the `resumed`
  detection in `run()`, `{ from: now - slept_ms, to: now, reason: "sleep" }`
  (paused or not); on the first tick of a process, when `host.json`'s
  `last_seen_at` is more than twice `poll_interval_s` before now, `{ from:
  last_seen_at, to: now, reason: "stopped" }` with a `{ kind: "downtime",
  from, to, ms, reason }` log line; `last_seen_at` is written at the end of
  every tick. A `paused` left by a stopped process continues (its `since`
  kept, so the whole gap is one interval on resume). `livenessGate(last,
  runInFlight, now, hours, downtimeMs)` expires a claim only when `now - last
  - downtimeMs` exceeds the window, and the loop passes `downtimeBetween(log,
  last, now)`. Tests: a claim last active 10 h ago with a `stopped` interval
  of 9 h 50 min inside is not released, and is released once the interval is
  shorter than 8 h; a claim idle through a 165,076,291 ms sleep (the #15
  case) is not released by the first tick after `resumed`; a claim idle
  through a pause of 30 h is not released on the resuming tick; the existing
  AC-15 test (no downtime) still releases.
- AC-7. **Verify pending counts running time only.** The `checks` event gains
  the optional `downtime_ms`; the driver sets it to `downtimeBetween(log,
  state.pendingSince, now)` when `pendingSince` is set, else 0;
  `verifyChecks` compares `Date.parse(event.at) - Date.parse(since) -
  (event.downtime_ms ?? 0)` with the six-hour bound. Given checks pending
  since 7 h ago with `downtime_ms` 6 h, then verify waits (`pendingSince`
  kept, `wait` action); given `downtime_ms` 0, then the re-run and fix of
  spec 006 AC-17 follow as today. Spec 097's `conflicts` path is unchanged.
- AC-8. **An outage's age counts running time only.** In `#countTransient`
  and in the standing runner, the outage's age (for spec 015 AC-8's and spec
  045 AC-5's two-hour alarm and for spec 015 AC-13's and spec 045 AC-6's
  ceiling) is the active age of `outage.since`; `CEILING_MIN_FAILURES` and
  `CEILING_MIN_SPAN_MS` are unchanged. Given a claim whose outage began 30 h
  ago with a `host` interval of 29 h inside, when its step rejects
  transiently and the probe passes, then the failure is recorded with
  `count` one more, no `past_ceiling`, nothing counted; given no downtime,
  then AC-13 applies as today. The `transient-outage-ceiling` finding's
  `what` becomes `transient failures outlast the retry ceiling while the host
  probe passes: <cause>`; the rest of AC-13 (the counted failures, the
  `(counted)` history entry, the release) is unchanged, and spec 015 AC-11
  still never forgives it.
- AC-9. **An issue's own failure is still counted.** Given the probe passes
  (the default of every existing test), then: spec 015 AC-12's third chain
  (a genuine error thrown three times) ends in `chain_error` and a release as
  today; spec 015 AC-13's loop test (an outage past the ceiling, with no
  downtime) counts as today; spec 045 AC-6's standing test counts as today;
  spec 092 AC-6's and spec 059 AC-6's recorded chains pass with the probe
  passing, except spec 059 AC-6's first chain, whose world now reports the
  low temporary volume to the probe too and asserts AC-10's second case
  instead. No existing test's assertions change otherwise: the test deps'
  `probeHost` defaults to passing and the worlds' `host` option defaults to
  reachable.
- AC-10. **Live cases end to end.** Recorded worlds drive and assert:
  - an issue-track chain at `implement` whose GitHub calls fail with
    `EAI_AGAIN` and whose `host` option fails the probe for ten ticks spanning
    30 h of fake clock (longer than `OUTAGE_CEILING_MS` and `liveness_hours`),
    then recovers: during the ten ticks no stage runs after the first
    rejection, the claim carries no `outage`, `chainFailures` is null, the
    ledger is as before, no `chain-error`, no `issue.released`, no
    `transient-outage`; the log has one `host-paused`, one
    `host-paused-notice` at the first tick two hours in, one `infra`
    notification, one `infra_alarm` of kind `host_outage`; on the first tick
    after recovery `host-resumed` is logged with a `host` downtime interval,
    implement runs with `attempt` 1, and the chain merges;
  - a spec-track chain whose `freeSpace` reports 100 MiB on the temporary
    directory for three ticks, then 20 GiB (spec 059 AC-6's first world): the
    pre-flight error pauses the scheduler with cause `ENOSPC`, the notice,
    finding (`stops_pipeline: true`), notification and `infra_alarm` of kind
    `disk_full` are raised on the first paused tick, the sweep's log lines
    appear on each paused tick, the claim carries no `outage`, and on the
    fourth tick the spec stage runs with `specRescues`, `attempt` and
    `history` as before;
  - a standing agent (the findings filer) whose run fails with
    `NETWORK_DOWN` while the probe fails: `standing-host-paused`, no
    `outage`, no `postponed_until`, `failures` 0; after the probe passes it
    runs on the next due tick;
  - a chain whose step rejects with `EAI_AGAIN` four times while the probe
    passes, then recovers (spec 015 AC-12's second chain): unchanged, with no
    `host-paused` line.

## 4. Amendments to earlier specs

- Spec 015 AC-8 and spec 045 AC-6 are marked `Amended by
  [100-host-outage-pauses-scheduler](../100-host-outage-pauses-scheduler/spec.md)
  AC-8`: the outage's age is its active age, and AC-13's finding names the
  passing probe. Spec 015 AC-13 is marked the same way with AC-2 and AC-8: a
  failure that the host probe refuses is not recorded on the outage at all.
- Spec 045 AC-2 is marked `Amended by [100] AC-2`: a transient failure that
  the host probe refuses pauses the scheduler instead of postponing the
  agent.
- Spec 059 AC-3 and AC-4 are marked `Amended by [100] AC-2 and AC-5`: the
  pre-flight error and the host-refused run pause the scheduler when the
  probe finds the space low, with the notice at once; the claim's outage and
  its alarm are recorded only when the probe passes.
- Spec 001 AC-15 is marked `Amended by [100] AC-6`: the two hours count only
  time the scheduler was running and not paused.
- Spec 006 AC-17 is marked `Amended by [100] AC-7`: the six hours count only
  time the scheduler was running and not paused.
- Spec 050 AC-3's list of kinds gains `host_outage` by its own rule; it is
  not marked. Specs 013 and 023 are not amended: the `waiting` stage is an
  instance of the model as it stands.

## 5. Interfaces and files

- `tools/scheduler/src/service/host.ts` (new): `PROBE_HOSTS`,
  `PROBE_TIMEOUT_MS`, `HOST_NOTICE_MS`, `DOWNTIME_KEEP_MS`, `probeHost`,
  `HostState` (`{ paused, last_seen_at, downtime }`), `readHostState`,
  `writeHostState`, `recordDowntime`, `downtimeBetween`, and the `HostMonitor`
  class (`onTransient`, `paused`, `probeIfDue`, `noticeIfDue`, `resume`,
  `recordSleep`, `markSeen`, `downtimeMs(from, to)`) used by the loop, the
  driver and the standing runner (AC-1 to AC-6).
- `schemas/scheduler/host.json` (new): the host state, validated on read and
  write as spec 086 requires.
- `tools/scheduler/src/state/paths.ts`: `paths.host`.
- `tools/scheduler/src/service/loop.ts`: `SchedulerDeps.probeHost?` and
  `fetch?` (test seams) and `host` (the monitor); the tick's pause branch
  (AC-3, AC-4, AC-5), the freshness-fetch trigger (AC-2), `#countTransient`
  probing first and using the active age (AC-2, AC-8), liveness with
  downtime (AC-6), `last_seen_at` and the startup gap (AC-6), `run()`
  recording sleeps (AC-6); the tick line's `host` field.
- `tools/scheduler/src/service/log.ts`: no change expected (`tick` takes a
  record); listed in case the field needs a type.
- `tools/scheduler/src/standing/run.ts`: the transient branch asks the
  monitor first (AC-2) and uses the active age (AC-8); `standing-host-paused`.
- `tools/scheduler/src/gates/liveness.ts`: the `downtimeMs` parameter (AC-6).
- `tools/scheduler/src/chain/types.ts`: `checks` event `downtime_ms?`;
  `tools/scheduler/src/chain/machine.ts`: `verifyChecks` subtracts it (AC-7);
  `tools/scheduler/src/chain/driver.ts`: `DriverDeps.host`, the `checks`
  event's `downtime_ms` (AC-7).
- `tools/scheduler/src/chain/transient.ts`: `outageAgeMs(since, now,
  downtimeMs)` and the doc comments of `OUTAGE_CEILING_MS`,
  `CEILING_MIN_FAILURES` and `CEILING_MIN_SPAN_MS` (AC-8).
- `tools/scheduler/bin/scheduler.ts`: builds the monitor with the real probe
  (global `fetch`, `fs.promises.statfs`).
- `agents/standing/infra-health.md`: one line on `host_outage` (AC-5), if
  the prompt lists the kinds.
- `tools/scheduler/test/helpers/e2e-routes.ts`: a `host` option on the worlds
  (a function of the tick returning the probe's cause or `null`, default
  `null`) and `probeHost` on the deps, default passing.
- Tests: `tools/scheduler/test/host.test.ts` (new, AC-1, AC-6's log
  functions), `loop.test.ts` (AC-2 to AC-6, AC-8), `standing.test.ts` (AC-2,
  AC-8), `gates.test.ts` (AC-6), `chain.test.ts` (AC-7), `driver.test.ts`
  (AC-7's `downtime_ms`), `schema.test.ts` (the new schema), `e2e.test.ts`
  (AC-9, AC-10).
- Marks of section 4 on `specs/015-chain-keeps-its-work/spec.md`,
  `spe../045-standing-agent-waits-out-network-outage/spec.md`,
  `spe../059-full-disk-postpones-runs/spec.md`,
  `specs/001-scheduler-core/spec.md` and `specs/006-no-human-stops/spec.md`.
- `docs/decisions/0015-host-outage-pauses-scheduler.md` (new): the
  maintainer's model, recorded. `docs/delivery-system-design.md`: this spec
  under `## Children`. The design's own text is not edited by this PR (the
  spec-scope gate allows a top design in full only while recording a
  maintainer's product answer); the ADR is the record the issue asks for,
  and a finding asks for the one-sentence pointer in section 4.

`tools/scheduler/` and `docs/delivery-system-design.md` are sensitive paths;
the security review applies to the implementation PR (spec 006 AC-9).
Nothing here changes the sensitive-path list, the security criteria, or what
routes a sensitive diff to the security review. No parameter, stage prompt or
stage definition changes. The probe sends two unauthenticated `HEAD`
requests to GitHub's own hosts, carries no token and no data, and reads
`statfs`; it is not a contact with any outside party.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the tests
  of section 5 added.
- AC-10's first chain fails on `main` before the change (the claim is
  released past the ceiling and the re-claim's release abandons it) and
  passes after it; AC-6's #15 case fails on `main` (released by liveness) and
  passes after it.
- A grep of `tools/scheduler/src` shows `OUTAGE_CEILING_MS` and
  `liveness_hours` compared only against an active age or with a downtime
  subtracted, and `probeHost` called only from `service/host.ts`.
- Live check after deploy: disconnect the laptop's network while a stage is
  due; the service log shows `host-paused`, tick lines with `host`, no
  `stage` line and no `transient-outage`; reconnect and the next probe tick
  logs `host-resumed` and the stage runs with its attempt and ledger as
  before. Suspend the laptop for three hours with a claim idle; after
  `resumed` no `liveness_expired` transition follows.

## 7. Open decisions

None.
