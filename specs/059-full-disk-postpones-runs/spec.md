# 059. A full temp or state volume postpones runs; it is not the work's failure

Status: written 2026-11-14 from the delivery-system design for issue #114;
specs derived from that design need no maintainer approval (design section 11).
Class: bug. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain's bounds count failures of the work: a rescue, a re-plan
and a spec revision are each counted per issue), section 6.1 (infra health is
woken by alarms and sweeps periodically) and section 10 ("Small work skips
layers": a bug spec hangs directly off a top design);
[015-chain-keeps-its-work](../015-chain-keeps-its-work/spec.md), whose
reading that the bounds count failures of the work and not of the
infrastructure, and whose transient-outage machinery (AC-4 to AC-9, AC-13)
this spec applies to a full disk, amending AC-1, AC-4, AC-8 and AC-10 (marked as section 4
records); [050-infra-alarm-kind-and-aws-cap-zero](../050-infra-alarm-kind-and-aws-cap-zero/spec.md),
whose AC-1 this spec amends (marked as section 4 records) and whose AC-3
lists the alarm kinds this spec extends;
[045-standing-agent-waits-out-network-outage](../045-standing-agent-waits-out-network-outage/spec.md)
AC-1, whose classification of errors thrown around a standing run this spec
relies on and leaves as it is; and
[030-beyond-github](../030-beyond-github/spec.md) section 2, which leaves the
disk-space sweep to issue #124 and the chain side to this issue.

## 1. Goal

A stage run is not launched into a full disk, and a run whose every shell
command the host refused for want of space counts toward no bound. The chain
waits with the backoff, alarm and ceiling of spec 015 instead of spending its
attempts, rescue and escalation path on runs that could not execute a command.

### What is wrong today

Nothing under `tools/scheduler/src` reads free space, and nothing judges a
run by whether its commands could start. Observed live on 2026-11-01
(`log/service.jsonl`, runs under `runs/`):

- From 08:42Z to 09:35Z the volume holding `/tmp/claude-1000` (Claude Code's
  temporary directory) was full. In runs `39-fix-1-20261101T084232-rescue`,
  `40-spec-1-20261101T084503`, `41-spec-1-20261101T085334`,
  `39-fix-1-20261101T090136` and `39-spec-1-20261101T091550` every `Bash`
  call was answered by the harness with `The command was not started: this
  computer's disk is full (ENOSPC) on the volume holding /tmp/claude-1000
  ... nothing ran`. Reads and writes under the state directory succeeded,
  so each run ended `ok` with a capability question asking the maintainer
  to free the volume.
- The chain judged those runs as the work's. Issue #39's record: its
  decide-mode fix (`39-fix-1-20261101T084223`) failed with `result:
  invalid`, which spent the spec-track rescue (`spec-track rescue 1/1`) on
  `39-fix-1-20261101T084232-rescue`, a run that could not run a command; its
  question went to the maintainer (question #6555684883, answered at
  09:01Z); the resumed run `39-fix-1-20261101T090136` was refused the same
  way, asked again, the question check sent that back as already settled,
  and at 09:03Z the issue was abandoned with the full escalation path
  recorded as spent. Issues #40 and #41 each spent a question-check run and
  a maintainer question on the same condition.
- The scheduler went on launching runs into the full volume: five stage
  runs and five question-check runs in under an hour, each costing tokens
  and producing nothing.

Spec 015 fixed the same shape for the network: a driver step that fails on a
transient infrastructure error postpones the chain with backoff and counts
toward no bound. Spec 045 did the same for standing agents. Neither mentions
disk space: `transientCause` knows DNS and socket codes, HTTP 5xx and git's
transport messages, not `ENOSPC`, and no step checks the host before a run.

### The fix

Two changes, both on the chain side (the sweep that frees space is issue
#124's, for the infra health agent of spec 030 AC-15).

1. **A pre-flight check.** Before a stage run's worktree is prepared, and
   before a standing run's worktree is added, the runner reads the free
   space and free inodes of the volumes a run writes to: the harness's
   temporary directory, the state directory and the worktree. When any is
   below the floor the launch is refused with an error whose `code` is
   `ENOSPC`. That error is a transient infrastructure error (AC-1), so the
   chain's service loop postpones the claim (spec 015 AC-5) and the standing
   runner postpones the agent (spec 045 AC-2); nothing is counted.
2. **A refused run is not the work's failure.** A run whose every shell
   command the harness refused for `ENOSPC` is classified as *host-refused*
   whatever result it returned. Its result is not applied (no question
   check, no attempt counted); the driver step rejects with the same
   `ENOSPC` error, and the postponement follows.

A disk-space outage raises its alarm at once rather than after two hours
(AC-4), under a kind of its own, `disk_full`: a full volume does not clear
itself the way a resolver blip does, and the alarm is what wakes infra
health and tells the maintainer.

*(agent's call)* The spec reuses spec 015's classifier, backoff, ceiling and
claim fields rather than adding a second postponement path: a full disk and
a dead network are the same judgement (the host, not the work, failed) and
one `outage` record keeps the two from disagreeing on a claim. The floors
are module constants, not parameters: they change when the host changes,
which is a code change with a review. The pre-flight error carries the
`ENOSPC` code so that one entry in `transientCause` covers the check, a
`mkdir` or `writeFile` that fails on a full state volume, and a git command
that fails the same way. The alarm's timing is per cause, not a new alarm:
one condition in the loop's existing alarm rule. Every change is cheap to
reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- Freeing space: deleting files under the temporary directory, pruning
  `runs/`, `patches/` or stale worktrees, or any periodic sweep. That is
  issue #124's spec, extending infra health (spec 030 AC-15); this spec
  gives it the `disk_full` alarm to wake on and the log lines to read.
- Setting `CLAUDE_CODE_TMPDIR` or `TMPDIR` for the harness, or moving the
  temporary directory to another volume. The check reads where the harness
  writes today.
- Network failures inside an agent's own run (issue #49): a run whose API
  connection dropped or whose own `git push` failed is judged by the adapter
  as today. Only the harness's own refusal of a shell command for `ENOSPC`
  is classified here.
- A run in which some shell commands ran and a later one was refused (the
  disk filled during the run). It is judged as today: the agent that saw
  the refusal commits or asks as it can, and the pre-flight check stops the
  next launch.
- The pi harness's refusal message. `hostRefusal` returns `null` for pi
  (AC-2); the pre-flight check covers pi runs since it reads the host, not
  the events.
- The standing runner's alarm (spec 045 AC-5): a standing agent postponed by
  the pre-flight check takes spec 045's outage path unchanged, with its
  alarm after two hours under kind `network_outage`. The chain's alarm (AC-4)
  is the one that fires at once; the two are not merged here.
- The quota postponement (spec 013 AC-6 to AC-9), which still runs first:
  a stage the quota book defers is not checked for space until it is due.
- Rewriting issue #39's, #40's or #41's ledgers or records by hand.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the recorded
worlds of `tools/scheduler/test/helpers/e2e-routes.ts`, as specs 015 and 045
do. *Transient error* and *outage* are spec 015's definitions (its section 3,
"Definitions") as extended by AC-1. The *floors* are `MIN_FREE_BYTES` (512
MiB) and `MIN_FREE_INODES` (1,000). The *checked paths* of a run are: the
harness's temporary directory (`CLAUDE_CODE_TMPDIR` from the scheduler's
environment when set, else `os.tmpdir()`), the state root (`paths.root`) and
the run's worktree (for a standing agent with `worktree: none`, the state
root only).

- AC-1. **`ENOSPC` is a transient cause.** `transientCause(error)` returns
  `ENOSPC` for an error whose `code` is `ENOSPC`, or whose message or
  `stderr` names `ENOSPC` or `No space left on device` (any case), looking
  through `cause` as today; an error with an HTTP status from 400 to 499
  stays genuine whatever its message says. `forgiveTransientChainErrors`
  therefore also forgives a `chain error in <stage>: ... ENOSPC ...` entry
  recorded before this spec, as spec 015 AC-11 says. Tests cover Node's
  `ENOSPC` error (`code: "ENOSPC"`), git's `fatal: ... No space left on
  device` in `stderr`, the pre-flight error of AC-3, and as genuine a GitHub
  422 whose message names `ENOSPC`.
- AC-2. **A host-refused run is recognised.** `Adapter` gains the optional
  `hostRefusal(events): string | null`. The Claude adapter returns `ENOSPC`
  when the events hold at least one `tool_use` named `Bash` and, for every
  such call, the `tool_result` with its `tool_use_id` has text that starts
  `The command was not started:` and contains `ENOSPC`; it returns `null`
  when there is no `Bash` call, when any `Bash` call's result is not that
  refusal, or when a `Bash` call has no result. The pi adapter does not
  define it. `runStage` calls it for every run that spawned (every outcome,
  `ok` included) and returns the label as `StageOutcome.hostRefusal`
  (`null` when the adapter does not define it); `outcome.json` persists it
  as `hostRefusal`. Tests pin the Claude adapter on the recorded events of
  `40-spec-1-20261101T084503` (a fixture of its `assistant` and `user`
  records: three refused `Bash` calls, label `ENOSPC`), on the same events
  with one `Bash` result replaced by command output (`null`), and on a run
  with no `Bash` call (`null`).
- AC-3. **The pre-flight check refuses a launch into a full volume.** Given
  a due stage whose quota check passes, when `runAgentStage` reaches the
  point before `syncWorktree` (before the worktree is fetched, reset or
  rebased), then it calls `checkHostSpace(paths, worktree)`; given any
  checked path's volume has fewer free bytes than `MIN_FREE_BYTES`, or
  fewer free inodes than `MIN_FREE_INODES` on a volume that reports inodes
  (`files` greater than 0; btrfs reports 0 and is not judged on inodes),
  then the check throws an error with `code: "ENOSPC"` and message `host
  space low: <path> has <n> MiB free and <m> free inodes (floor <MiB> MiB,
  <inodes> inodes)`, no run directory, usage record or claim `run_id` is
  written, the worktree is untouched, and the step rejects with that error,
  so the loop records the outage on the claim (spec 015 AC-5: `retry_at`
  the backoff after now, `chainFailures` and the ledger unchanged) and
  writes `{ kind: "transient-outage", issue, cause: "ENOSPC", error }` once
  per outage (AC-6). Given every checked path is above both floors, the
  stage runs as today and nothing is logged. Given `statfs` itself fails
  for a checked path (a missing directory), the check logs `{ kind:
  "host-space-unknown", path, error }` and passes: the check never blocks a
  run on its own failure. The reader is `RunnerContext.freeSpace?(path)`
  (test seam) defaulting to `fs.promises.statfs`: free bytes are `bavail *
  bsize`, free inodes `ffree`. The standing runner calls the same check
  before `git worktree add` (and before the run for `worktree: none`), so a
  refused standing launch takes spec 045 AC-1's path for an error thrown
  around the run: postponed, counted toward nothing.
- AC-4. **A host-refused run is postponed, not counted, and alarms at
  once.** Given a stage run that spawned and whose `StageOutcome.hostRefusal`
  is not `null`, whatever its outcome and result, then the driver undoes its
  own rebase (spec 015 AC-1), logs `{ kind: "stage-host-refused", issue,
  stage, attempt, run_id, cause }` beside the usual `stage` line, does not
  record `stageRun`, does not apply the result (no `stage_ok`, no
  `stage_failed`, no question check, no held work), and the step rejects
  with an error `code: "ENOSPC"`, message `host refused every shell command
  in run <run_id>`. The usage record and `outcome.json` are written as
  today (the tokens were spent). The loop then takes spec 015 AC-5's path.
  Given a transient failure whose `cause` is `ENOSPC` and whose outage has
  `alarmed` false, then the loop raises the alarm of spec 015 AC-8 on that
  failure, however young the outage is: `alarmed` true, the
  `transient-outage-alarm` line, one finding (`what: "disk space blocks the
  chain"`, `where: "issue #<n>, stage <stage>"`, `evidence` naming the
  checked path and numbers from the error, `noticed_how: "scheduler
  transient error"`), one notification (gate `infra`, text naming the path
  and free space) and one `infra_alarm` event with payload `{ kind:
  "disk_full", issue, since, failures, cause }`. Later failures of the same
  outage raise nothing more; a cause other than `ENOSPC` alarms after two
  hours under `network_outage` as today. The ceiling of spec 015 AC-13
  applies unchanged, so a volume nobody frees for a day ends in a counted
  failure, not in retries for ever.
- AC-5. **The two pass each other.** Given an outage of cause `ENOSPC` on a
  claim whose next step runs a stage that ends `ok` with `hostRefusal`
  `null`, then the outage is cleared with `transient-outage-over` (spec 015
  AC-6) and the result is applied as today. Given a claim in a `network_outage`
  outage whose next failure is `ENOSPC`, then the outage continues (`count`
  one more) and, `alarmed` being false, alarms at once under `disk_full`;
  the cause recorded on the outage line is the first failure's, as today.
- AC-6. **Live cases end to end.** Recorded worlds drive and assert:
  - a spec-track chain whose `freeSpace` reports 100 MiB free on the
    temporary directory for three ticks, then 20 GiB: no agent runs during
    the three ticks, the claim carries `outage` with `count` 3 and
    `retry_at` set, the service log holds one `transient-outage` with cause
    `ENOSPC`, one `transient-outage-alarm`, one `infra` notification whose
    text names the path, one `infra_alarm` of kind `disk_full`, no `stage`
    line and no `stage_failed` transition; on the fourth tick the spec stage
    runs, the ledger's `specRescues`, `attempt` and `history` are as before
    the outage, and the chain goes on to `verify`;
  - an issue-track chain at `fix` on a rescue run (`rescueRun` true) whose
    scripted fix run is `HOST_REFUSED` (the fake harness writes a result
    carrying a capability escalation and events the fake adapter's
    `hostRefusal` labels `ENOSPC`), then a normal fix: after the first run
    the state is still `fix` with `rescueRun` true, `rescues` unchanged, no
    question check ran, no `paused` record, the history has no `fix attempt
    ... failed` entry, and the log has `stage-host-refused`; after the wait
    the second run is applied and the chain reaches `verify`. This test
    fails on `main` before the change (the escalation goes to the question
    check);
  - a standing agent (the findings filer) due while `freeSpace` reports a
    low state volume: postponed as spec 045 AC-2 says (`postponed_until` 60
    s ahead, `failures` unchanged, no finding, no notification), the
    `standing-outage` line carries cause `ENOSPC`, and the next attempt
    after the wait runs.
  The existing spec 015 and 045 tests pass unchanged: `freeSpace` defaults
  to a reader reporting ample space in the test helpers, and no scripted
  run has a `hostRefusal` unless its script says `HOST_REFUSED`.

## 4. Amendments to earlier specs

- Spec 015 AC-1 is marked `Amended by
  [059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md)
  AC-4: the rebase is also undone for a host-refused run, whatever its
  outcome.`
- Spec 015 AC-10 is marked `Amended by
  [059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md)
  AC-4: a host-refused run that ended ok does not record stageRun.`

- Spec 015 AC-4 is marked `Amended by
  [059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md)
  AC-1: the code ENOSPC and the message "No space left on device" are
  transient causes too.` The definition in its section 3 and the text of
  AC-4 stay as the record.
- Spec 015 AC-8 is marked `Amended by
  [059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md)
  AC-4: an outage whose cause is ENOSPC alarms on its first failure, with
  kind disk_full.` The two-hour rule stands for every other cause.
- Spec 050 AC-1 is marked `Amended by
  [059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md)
  AC-4: the payload's kind is disk_full when the outage's cause is ENOSPC.`
  Spec 050 AC-3's list of kinds gains `disk_full` by its own rule ("a later
  spec that adds a producer adds its kind to this list in its own text"); it
  is not marked. Infra health (spec 030 AC-15) files a finding for a kind it
  does not know until issue #124 teaches it this one, which spec 050 AC-3
  already provides for.

Spec 045 is not amended: its AC-1 already classifies an error thrown around
the run by `transientCause`, which is how the pre-flight error reaches its
outage path. Spec 015 section 2's exclusion of "network failures inside an
agent's own run" is left as it is: a host refusal is not a network failure,
and issue #49 keeps that scope.

## 5. Interfaces and files

- `tools/scheduler/src/chain/transient.ts`: `CODES` gains `ENOSPC`;
  `labelOf` matches `No space left on device` (any case) with label
  `ENOSPC`; `DISK_FULL = "ENOSPC"` exported for the loop and the adapter
  (AC-1).
- `tools/scheduler/src/runner/host-space.ts` (new): `MIN_FREE_BYTES`,
  `MIN_FREE_INODES`, `checkedPaths(paths, worktree)`,
  `checkHostSpace(paths, worktree, { freeSpace?, log })` throwing the
  `ENOSPC` error of AC-3 or logging `host-space-unknown`; `FreeSpace`
  type `{ bytes: number; inodes: number | null }` (`null` when the volume
  reports no inodes).
- `tools/scheduler/src/adapters/types.ts`: `Adapter.hostRefusal?(events):
  string | null` (AC-2). `tools/scheduler/src/adapters/claude.ts`: the
  implementation over `assistant` `tool_use` and `user` `tool_result`
  records.
- `tools/scheduler/src/runner/run.ts`: `StageOutcome.hostRefusal` and its
  line in `outcome.json` (AC-2); `RunnerContext.freeSpace?` is passed
  through to the check by the callers (AC-3).
- `tools/scheduler/src/chain/driver.ts`: `DriverDeps.freeSpace?`;
  `runAgentStage` calls `checkHostSpace` after the quota check and before
  `syncWorktree` (AC-3), and after `exec` handles a run with `hostRefusal`
  as AC-4 says (undo the rebase, log `stage-host-refused`, throw).
- `tools/scheduler/src/service/loop.ts`: the alarm condition of the
  transient-failure handler gains `|| cause === DISK_FULL`; the finding
  text, notification text and `infra_alarm` kind branch on the cause
  (AC-4, AC-5).
- `tools/scheduler/src/standing/run.ts`: `checkHostSpace` before `git
  worktree add` (or before the run for `worktree: none`) inside the `try`
  whose `catch` classifies with `transientCause` (AC-3).
- `tools/scheduler/test/helpers/e2e-routes.ts`: `HOST_REFUSED` script
  value (the fake harness exits 0 with a result file and the fake adapter's
  `hostRefusal` returns `ENOSPC` for that run's events); a `freeSpace`
  option on the worlds, defaulting to ample space.
- Tests: `tools/scheduler/test/transient.test.ts` (AC-1),
  `adapters-claude.test.ts` with a fixture
  `tools/scheduler/test/fixtures/enospc-events.jsonl` cut from the live
  run (AC-2), `host-space.test.ts` (new, AC-3's floors, inode rule and
  `statfs` failure), `driver.test.ts` (AC-3's ordering before
  `syncWorktree`, AC-4's throw and rebase undo), `loop.test.ts` (AC-4's
  alarm at once, AC-5), `e2e.test.ts` (AC-6).
- `specs/015-chain-keeps-its-work/spec.md` AC-4 and AC-8,
  `specs/050-infra-alarm-kind-and-aws-cap-zero/spec.md` AC-1: the marks of
  section 4.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/` and `docs/delivery-system-design.md` are sensitive
paths; the security review applies to the implementation PR (spec 006
AC-9). Nothing here changes the sensitive-path list, the security criteria,
or what routes a sensitive diff to the security review. No schema changes:
`outage` keeps spec 015's shape (`cause` is a string already), `outcome.json`
has no schema, and no parameter, stage prompt or standing definition
changes. The check reads `statfs` and the scheduler's own environment; it
deletes nothing and reads no file contents.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the
  tests of section 5 added.
- The second AC-6 chain fails on `main` before the change (the rescue run's
  escalation reaches the question check) and passes after it. The spec 015
  loop tests and the spec 045 standing tests pass without edits.
- A grep of `tools/scheduler/src` shows `statfs` used only in
  `runner/host-space.ts`, and `hostRefusal` read in `runner/run.ts` and
  `chain/driver.ts` only.
- Live check after deploy: fill the temporary volume on the laptop with a
  sparse-free file until under 512 MiB remain while a stage is due; the
  service log shows `transient-outage` with cause `ENOSPC`, one
  `transient-outage-alarm`, one Telegram message naming the path, and no
  `stage` line; remove the file and the next tick after `retry_at` runs the
  stage with its attempt and bounds unchanged.

## 7. Open decisions

None.
