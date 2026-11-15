# 064. The scheduler sweeps the temp and state volumes itself, and infra health is its own agent ahead of the rest of F2

Status: written 2026-11-14 from the delivery-system design for issue #124;
specs derived from that design need no maintainer approval (design section 11).
Supersedes [030-beyond-github](../030-beyond-github/spec.md) AC-15 and AC-17
(the infra health agent moves here, marked as section 4 records) and amends its
section 6 (its infra health runs are verified here).
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 6.1 (infra health on the roster: "alarms, plus a periodic sweep",
producing "direct actions, findings"; the `infra_alarm` trigger), section 6.2
(level 1: operational and reversible, within limits that already exist; every
direct action recorded with what, why, which agent and how to undo it; the
action audit moves a kind that goes wrong to level 2), section 11 (row F2) and
section 10 ("Small work skips layers"); [process-spec](../../docs/process-spec.md)
4.4 (the ops-watcher slot); [008-agent-registry](../008-agent-registry/spec.md)
AC-4, AC-5, AC-8 and AC-9 (events, results, actions, the action log);
[030-beyond-github](../030-beyond-github/spec.md), whose section 2 leaves the
disk-space sweep to this issue and whose AC-15 and AC-17 this spec takes over;
[059-full-disk-postpones-runs](../059-full-disk-postpones-runs/spec.md), whose
pre-flight check, `ENOSPC` cause, `disk_full` alarm and `freeSpace` seam this
spec builds on and leaves as they are; and
[050-infra-alarm-kind-and-aws-cap-zero](../050-infra-alarm-kind-and-aws-cap-zero/spec.md)
AC-3 (the alarm kinds; `disk_full` gains a second producer here).

## 1. Goal

The host is watched by the one process that kept running through both
outages: the scheduler itself. Every hour, and at once when a volume runs low,
the service process measures the temp and state volumes, removes what the
system itself left behind, and only when that is not enough raises an alarm
that reaches the maintainer, files a finding that puts the condition ahead of
ordinary work, and wakes the infra health agent to judge the cause. No shell
and no agent run is needed for the measurement or the recovery, so they work
while Claude Code refuses every command.

The infra health agent (design section 6.1) lands with this spec as
`agents/standing/infra-health.md`, taking over spec 030 AC-15 and AC-17
unchanged in substance and adding the disk case, so that it does not wait for
the credential store, the request objects and the first-contact gate of spec
030, whose issue (#39) is abandoned and whose implementation has twice failed.

### What is wrong today

- `/tmp` on the laptop is a tmpfs with 4,093,671 inodes. Its inodes reached
  100% on 2026-10-29 and again on 2026-11-01 (issue #124). On 2026-11-01 every
  agent's shell was refused from 08:42Z to 09:35Z while the scheduler kept
  ticking, launching runs that could not run a command (spec 059's record);
  the maintainer freed the volume by hand because no agent could.
- What filled it was the system's own test fixtures. Until PR #118 (merged
  2026-11-01) every scheduler test wrote its fixtures straight under `/tmp`
  and nothing removed them. Since then `tools/scheduler/test/helpers/test-tmpdir.ts`
  gives each `pnpm test` run one root `panelator-test-<random>` and removes it
  at teardown; a run that is killed (a stage hitting its timeout, a session
  ended mid-suite) never reaches teardown, and the helper removes such roots
  only when the next run starts and only when they are a day old. On
  2026-11-14 five leaked roots held 228,613 inodes between them (the largest,
  69,703); sixty in a day fill the volume.
- Nothing in `tools/scheduler/src` deletes anything under the temp directory
  or removes a worktree the chain forgot. `pruneUsage` (180-day retention of
  usage records) is the only sweep the service has. Spec 059's pre-flight check
  refuses launches below its floors and alarms, but recovers nothing: the
  maintainer is still the only first responder.
- The infra health agent of spec 030 AC-15 does not exist: `agents/standing/`
  holds `action-audit.md` and `findings-filer.md`. Its GitHub-side half needs
  nothing that is not on `main` (spec 030 section 4), yet it waits in an
  abandoned issue behind the credential store.

### The fix

1. **A sweep in the service process** (AC-1 to AC-4). Each tick the loop reads
   the free bytes and inodes of the temp directory and the state root with spec
   059's reader. Once an hour it removes the *stale leftovers* (a closed list:
   leaked test roots and orphaned worktrees), and when a volume is under the
   *sweep floors* it removes them at once with a shorter age. Every removal is a
   level-1 action, `sweep_volume`, written to the action log as the scheduler's
   own, so the action audit watches it like any other kind. When a volume is
   still under spec 059's launch floors after an urgent sweep, the loop alarms
   once per episode: an `infra` notification naming the volume, the numbers and
   the largest holders; a finding with `stops_pipeline: true`; and an
   `infra_alarm` of kind `disk_full`.
2. **The infra health agent** (AC-5, AC-6). `agents/standing/infra-health.md`
   wakes on `infra_alarm` and `ci_failure_main` and sweeps every six hours. Its
   limits and inputs are spec 030 AC-15's, plus the sweep's reports: on a
   `disk_full` alarm it judges what held the volume and files a finding naming
   the source, and may request one more `sweep_volume`. It runs only once the
   volume has room (spec 059 AC-3 refuses its launch before that), which is the
   point: the process is the first responder, the agent the judge.

*(agent's call)* The sweep is code in the loop, not an agent, because the
issue's evidence is that no agent could run; a standing agent with `worktree:
none` still needs the harness's temp directory. Its deletions are a closed list
of things the system created and can recreate, which is design 6.2's "within
limits that already exist"; a worktree with work not on the remote is patched
before it goes, which is the recorded undo. The floors, ages and interval are
module constants like spec 059's floors: they change with the host, by a
reviewed PR. Taking spec 030 AC-15 and AC-17 into this spec rather than
extending a spec whose agent does not exist is a cut of the same kind spec 030
section 4 made for its AWS half: the dependency runs one way (the agent needs
the actions and events that exist on `main`; nothing in spec 030 needs the
agent), and spec 030's follow-up extends this definition as AC-16 already
says. Every change is cheap to reverse; no ADR (design section 3, item 2).

## 2. Out of scope

- Deleting records: `runs/`, `usage/` (beyond `pruneUsage` as it is),
  `patches/`, `events/`, `log/`, the findings queue, claims, ledgers. Design
  section 7 keeps raw events for ever; a retention policy for run records is
  its own decision and is not made here. The sweep reports when records are
  what holds a volume, and deletes none of them.
- Anything under the temp directory the system did not create: Claude Code's
  own `claude-<uid>/` tree, Node's compile cache, other users' and programs'
  files. The sweep names the largest holders in its alarm so the maintainer
  or the agent can judge them; it does not touch them.
- Moving the harness's temp directory (`CLAUDE_CODE_TMPDIR`, `TMPDIR`) or
  resizing the tmpfs. The sweep reads where the harness writes, as spec 059
  does.
- Changing the test helper's own stale rule or the floors of spec 059. The
  helper's `PREFIX` is the contract the sweep relies on (AC-1); its 24-hour
  rule stays for machines that run tests without the service.
- Spec 059's claim-level alarm (its AC-4): a chain whose launch is refused
  still alarms there, naming its issue; the sweep's alarm names the volume.
  The two are not merged.
- The AWS half of infra health (spec 030 section 2: `aws_scale`, the `scale`
  descriptor, the ledger input), the credential check, the credential store,
  requests, the first-contact gate and the Telegram notifier: spec 030, as it
  is. The follow-up spec extends `agents/standing/infra-health.md` as spec 030
  AC-16 says, now the definition this spec creates.
- A console view of the sweep: its action-log entries and `infra_alarm`
  events appear where spec 051 already shows actions and alarms; a view of
  volume headroom is left to a finding if the console's reviewers want one.

## 3. Acceptance criteria

"Given" states use the fake harness, the mocked GitHub API and the recorded
worlds of `tools/scheduler/test/helpers/e2e-routes.ts`, with the worlds'
`freeSpace` option of spec 059 AC-6 and a fixture directory set as
`CLAUDE_CODE_TMPDIR` for the sweep's temp directory.

Definitions. The *checked volumes* are spec 059's checked paths for a run
without a worktree: the harness's temp directory and the state root
(`checkedPaths(paths, null)`). The *launch floors* are spec 059's
`MIN_FREE_BYTES` and `MIN_FREE_INODES`. The *sweep floors* are
`SWEEP_FREE_BYTES` (2 GiB) and `SWEEP_FREE_INODES` (100,000): under them a
volume has room for one more test run at most, so the sweep acts before the
launch floors are reached. The *stale age* is `STALE_MS` (2 hours), the
*urgent age* `URGENT_STALE_MS` (15 minutes), the *interval* `SWEEP_INTERVAL_MS`
(1 hour). A volume reporting no inodes (btrfs, `files` 0) is judged on bytes
only, as in spec 059. The *stale leftovers* of a volume at an age are:

- on the volume holding the temp directory: each direct entry of the temp
  directory whose name starts with `panelator-test-` (the `PREFIX` of
  `tools/scheduler/test/helpers/test-tmpdir.ts`; a test asserts the two
  constants are equal) and whose `mtime` is older than the age. The root's
  `mtime` moves whenever a test creates a fixture under it, so a root quiet
  for the urgent age has no suite running in it (the longest stage timeout
  is 90 minutes, the suite itself minutes);
- on the volume holding the state root: each directory under
  `paths.worktrees` that is not a standing agent's (`standing-<name>` whose
  agent state has `running`), has no claim, paused record or blocked record
  for its issue (`issue-<n>`), is not the chain's active worktree in this
  process, and whose `mtime` is older than the age; and each path `git
  worktree list --porcelain` names under `paths.worktrees` that no longer
  exists on disk (pruned with `git worktree prune`, no action needed).

- AC-1. **The routine sweep.** Given a tick at least `SWEEP_INTERVAL_MS` after
  the last sweep recorded in `disk-sweep.json` (or the first tick after
  start), when the loop reaches the step after `pruneUsage`, then for each
  checked volume it lists the stale leftovers at the stale age and, given at
  least one, requests one `sweep_volume { path, age: "stale" }` action (AC-3)
  with `agent: "scheduler"`, `run_id: "tick"`, `why` naming the count and the
  interval; given none, nothing is requested and nothing logged. The sweep
  writes `disk-sweep.json` in the state root: `last_at`, and per checked
  volume `path`, `free_bytes`, `free_inodes`, `removed` (count), `freed_inodes`
  (count, from a walk of each removed entry before deletion), `episode`
  (AC-2) and `holders` (AC-2). Given a volume whose free space cannot be read,
  then it is logged as spec 059's `host-space-unknown` and skipped. A failure
  of the sweep is pushed to the tick's `errors` and never stops the tick, as
  the children scan's is.
- AC-2. **The urgent sweep and its alarm.** Given a tick on which a checked
  volume is under a sweep floor, then whatever the time of the last sweep the
  loop requests `sweep_volume { path, age: "urgent" }` for that volume, logs
  `{ kind: "disk-sweep-urgent", path, free_bytes, free_inodes }`, re-reads the
  free space and writes `disk-sweep.json`. Given it is still under a launch
  floor after that and the volume's `episode` is absent or has `alarmed`
  false, then once: `episode` becomes `{ since, alarmed: true }`; the loop
  logs `{ kind: "disk-sweep-alarm", path, free_bytes, free_inodes, removed,
  holders }`; sends one notification (gate `infra`, label `disk_full`, text
  naming the path, the free MiB and inodes, what the sweep removed and freed,
  and the five largest holders); appends one finding (`what: "host volume low
  after sweep"`, `where: <path>`, `evidence` the same numbers and holders,
  `noticed_how: "scheduler disk sweep"`, `stops_pipeline: true`); and emits
  one `infra_alarm` with payload `{ kind: "disk_full", path, since,
  free_bytes, free_inodes, removed, holders }` (no `issue`: the volume, not a
  claim, is the subject; spec 050 AC-3's `disk_full` kind thereby has this
  second producer). `holders` are the direct entries of the volume's checked
  directory (the temp directory, or the state root's `runs`, `worktrees`,
  `patches`, `usage` and `events`) ranked by inode count from a walk bounded
  by `HOLDER_WALK_MAX` (500,000 entries in total; an entry cut short is
  reported with `>=`), at most five, each `{ name, inodes, mtime }`. Given a
  later tick finds the volume above both launch floors, then `episode` is
  removed and `{ kind: "disk-sweep-recovered", path, since }` is logged;
  until then nothing more is sent for that volume, and spec 059's pre-flight
  check keeps refusing launches as it does today. Given a volume under a
  sweep floor but above the launch floors after the urgent sweep, then
  nothing is sent: the sweep logs its line and the next tick measures again.
- AC-3. **`sweep_volume` is a level-1 action.** `agents/actions.yaml` gains
  `sweep_volume` (level 1, "Remove stale leftovers the system created on a
  checked volume: leaked test roots and orphaned worktrees"), with a handler
  in `KINDS` so `registryActionsCheck` passes. Its `check` refuses (reason)
  a `path` that is not one of the checked volumes or an `age` that is not
  `stale` or `urgent`, and `exact(args, ["path", "age"])`. Its `apply` lists
  the volume's stale leftovers at that age and removes each: a test root with
  `rm -rf` semantics (`fs.rm` recursive, force); a worktree first with its
  work saved (given it has uncommitted changes or commits not on
  `origin/<its branch>`, then `uncommittedPatch` and `commitsPatch` of
  `runner/worktree.ts` are written to `patches/sweep/<name>-<time>.patch`
  before removal, and the patch path is in the log line), then
  `removeWorktree` and `git worktree prune`. It returns `undo: null`: a
  deleted test root cannot be restored and a worktree's work is in its patch;
  the service log line `{ kind: "disk-sweep", path, age, agent, removed:
  [names], freed_inodes, patches: [paths] }` says so. The action-log entry is
  spec 008 AC-9's, with `agent` `scheduler` when the loop requests it (the
  loop's `allowed` list is `["sweep_volume"]`; `scheduler` is not a reserved
  identity, and `applyAction` assigns the actor as today) or the requesting
  agent's name when infra health does (AC-5). The audit input of spec 008
  groups it by kind like any other, so a `sweep_volume` that goes wrong
  repeatedly is moved to level 2 by the action audit's finding.
- AC-4. **The sweep deletes nothing else.** Given a fixture temp directory
  holding a stale test root, a fresh test root (`mtime` now), a directory
  `claude-1000/` with entries, a directory `node-compile-cache/`, an unrelated
  file, and a state root with a worktree `issue-7` registered with git and
  holding a claim, a worktree `issue-8` with no claim and an old `mtime`
  whose branch has one commit not on the remote, `runs/` with records,
  `patches/` and `usage/` with files, when a `sweep_volume` runs at the stale
  age on each volume, then only the stale test root and `issue-8` are gone,
  `patches/sweep/` holds `issue-8`'s commits as a patch, and every other
  entry is byte-for-byte as before; the action log has two `applied` entries
  with `undo: null`. Given `age: "urgent"` with the fresh root's `mtime` 20
  minutes old, then it goes too; given it is 10 minutes old, it stays. A
  grep of `tools/scheduler/src` shows `fs.rm` with `recursive` on a temp-dir
  path only in `actions/sweep-volume.ts`.
- AC-5. Amended by [068-beyond-github-aws-and-events](../068-beyond-github-aws-and-events/spec.md) AC-8: the definition gains credentials `aws-sso` and the action `aws_scale`, the input gains `aws`, and the prompt handles the `aws_forecast_over_cap` alarm. **Infra health is a standing agent** (spec 030 AC-15, taken over).
  `agents/standing/infra-health.md`: standard tier (`model:
  claude-sonnet-5-5`, as the standard-tier stages), Claude, `worktree: none`,
  `profile: none`, `permission: no-prompt`, schedule `6h`, events
  `infra_alarm` and `ci_failure_main`, actions `rerun_workflow`,
  `run_agent`, `pause_agent` and `sweep_volume`, bounds `{ timeout_min: 20,
  max_turns: 50, max_cost_usd: 4 }`, input `infra-health-input`, output
  `standing-result`. `schemas/scheduler/infra-health-input.json` and
  `src/standing/infra-health-input.ts` (wired in `standing/run.ts` beside
  `audit-input`) give it: the pending events with their payloads; the
  `disk-sweep.json` report and the current free space of the checked
  volumes; the standing agents' state files (consecutive failures, paused,
  by whom); the last 24 hours of the service log's tick summaries, restarts
  and `disk-sweep*` lines; and the action log of the last 7 days. The agent
  reads only; the scheduler applies its result (spec 008 AC-5). Its prompt
  sets the limits: it may re-run a failed `main` workflow once per run id
  (the kind's own bound); pause a standing agent with three consecutive
  failures that the maintainer has not paused or resumed since; mark an
  agent due with `run_agent` when an alarm names it; on an alarm of kind
  `disk_full`, judge the holders in the report (a leaked test root is a
  killed run; a worktree with no claim is a chain that did not clean up; an
  entry the sweep may not touch is the maintainer's) and file one finding
  naming the holder and the likely source (`noticed_how: "infra health
  sweep"`, `stops_pipeline: true` while the volume is under a launch floor),
  requesting at most one `sweep_volume { path, age: "urgent" }` when the
  report is older than the interval; read an alarm of kind `network_outage`
  as the outage alarm it acts on; and report in the summary and file one
  finding, not acting, for a payload whose `kind` it does not know or that
  has none (spec 050 AC-3). It must file a finding, not act, for an outage
  past the `infra` alarm, a `main` failure a re-run did not clear, and
  anything needing a reviewed PR, funds, a credential or a first contact.
  Given nothing is wrong, then the summary says so and no action is
  requested. Given the volume is under a launch floor when the agent is due,
  then spec 059 AC-3 postpones it; the agent runs when there is room, which
  is after the sweep or the maintainer has freed the volume. The follow-up
  spec of spec 030 section 2 extends this definition and prompt (spec 030
  AC-16), not replacing them.
- AC-6. **The scheduler's own service is a resource too** (spec 030 AC-17,
  taken over). `restart_service` is not an action kind: the scheduler is the
  only service and restarts itself after merges (spec 008 AC-2). Infra health
  files a finding when the tick summaries show the service restarting more
  than three times in 24 hours, with the log lines as evidence.
- AC-7. **Live cases end to end.** Recorded worlds drive and assert:
  - a fixture temp directory with two stale test roots and one fresh, and a
    `freeSpace` reporting 50,000 free inodes on the temp directory until the
    stale roots are gone and 3,000,000 after: on the first tick the log has
    `disk-sweep-urgent`, one `sweep_volume` action `applied` by `scheduler`
    removing the two roots, no `disk-sweep-alarm`, no notification, no
    finding; `disk-sweep.json` has `removed: 2` and no `episode`; the fresh
    root stands;
  - the same with `freeSpace` reporting 500 free inodes before and after
    the sweep: one `disk-sweep-alarm`, one `infra` notification with label
    `disk_full` whose text names the path, the inodes and the fresh root as a
    holder, one finding with `stops_pipeline: true`, one `infra_alarm` of
    kind `disk_full` with `path` and no `issue`, and infra health's state
    carrying the event; on the next tick, nothing more; after `freeSpace`
    reports 3,000,000, `disk-sweep-recovered` and `episode` gone; a due stage
    during the episode is postponed by spec 059 AC-3 as today, with its own
    `transient-outage` line;
  - a world with a worktree `issue-8` (no claim, old `mtime`, one unpushed
    commit) and ample space, one hour after the last sweep: the routine
    sweep removes it, `patches/sweep/` holds the commit, the action log has
    one `applied` entry with `undo: null`, and the chain of another issue
    whose worktree is live is untouched;
  - infra health woken by `ci_failure_main`, re-running the failed `main`
    workflow once; pausing a standing agent with three consecutive failures;
    filing a finding for an `infra_alarm` payload whose `kind` it does not
    know; and, woken by the `disk_full` alarm above with the fixture report
    in its input, returning one finding naming the fresh test root (spec 030
    section 6's infra health runs, carried here).
  The existing spec 015, 045 and 059 tests pass unchanged: the worlds'
  default `freeSpace` reports ample space, so no sweep acts and no alarm is
  raised.

## 4. Marks on spec 030

- Spec 030 AC-15 is marked `Superseded by
  [064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
  AC-5:`. Its text stays as the record; its definition, inputs, limits and
  the follow-up's rule of extension are AC-5's, with the disk case added.
- Spec 030 AC-17 is marked `Superseded by
  [064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
  AC-6:`. The text is AC-6's unchanged.
- Spec 030 section 6 is marked `Amended by
  [064-disk-sweep-and-infra-health](../064-disk-sweep-and-infra-health/spec.md)
  AC-7: the infra health runs (the ci_failure_main re-run, the pause and the
  unknown-kind finding) are verified by spec 064.` Its other items stay.

Spec 030 AC-16 is not marked: it still says the follow-up adds the AWS half
by extending the definition, and the definition is now this spec's. Spec 030
section 2's and spec 059's references to "the infra health agent of AC-15"
resolve through the mark. Spec 050 AC-3's kind list already has `disk_full`;
AC-2 here adds the producer, as that criterion's rule provides.

## 5. Interfaces and files

- `tools/scheduler/src/service/sweep.ts` (new): the constants
  (`SWEEP_FREE_BYTES`, `SWEEP_FREE_INODES`, `STALE_MS`, `URGENT_STALE_MS`,
  `SWEEP_INTERVAL_MS`, `HOLDER_WALK_MAX`, `TEST_ROOT_PREFIX`),
  `staleLeftovers(volume, age, deps)`, `holders(volume, deps)`,
  `sweepVolumes(deps)` (the tick step of AC-1 and AC-2), `disk-sweep.json`
  read and write; `freeSpace` through `DriverDeps.freeSpace` as spec 059.
- `tools/scheduler/src/actions/sweep-volume.ts` (new): `sweepVolumeKind`
  (AC-3); `actions/index.ts`: `KINDS.sweep_volume`; `agents/actions.yaml`:
  the entry; `schemas/scheduler/action.json` unchanged (the kind is a string).
- `tools/scheduler/src/service/loop.ts`: the sweep step after `pruneUsage`
  in `tick()`, its errors pushed to `info.errors` (AC-1, AC-2); the alarm's
  notification, finding and `infra_alarm` (AC-2).
- `tools/scheduler/src/state/paths.ts`: `diskSweep` (`disk-sweep.json`) and
  `patchesSweep` (`patches/sweep/`).
- `tools/scheduler/src/standing/infra-health-input.ts` (new) and
  `schemas/scheduler/infra-health-input.json` (new); `standing/run.ts`: the
  builder wired beside `audit-input` (AC-5); `src/schema/validate.ts`: the
  schema name.
- `agents/standing/infra-health.md` (new, AC-5, AC-6).
- `tools/scheduler/test/helpers/test-tmpdir.ts`: unchanged; a test imports
  its `PREFIX` and asserts it equals `TEST_ROOT_PREFIX`.
- Tests: `tools/scheduler/test/sweep.test.ts` (new: AC-1's listing and
  interval, AC-2's floors, episode and holders, AC-4's fixture),
  `actions.test.ts` (AC-3's checks, the patch, `undo: null`),
  `loop.test.ts` (the tick step and its error handling), the registry test
  over the new agent and the input schema (AC-5), `e2e.test.ts` (AC-7).
- `specs/030-beyond-github/spec.md` AC-15, AC-17 and section 6: the marks of
  section 4.
- `docs/delivery-system-design.md`: this spec under `## Children`.

`tools/scheduler/`, `agents/` and `docs/delivery-system-design.md` are
sensitive paths; the security review applies to the implementation PR (spec
006 AC-9). Nothing here changes the sensitive-path list, the security
criteria, or what routes a sensitive diff to the security review. The sweep
deletes only the closed list of AC-3 and AC-4, reads no file contents, and
runs no shell beyond `git worktree` through the existing `runner/worktree.ts`
helpers. The new agent has no write tool and no GitHub tool, as every standing
agent (spec 008). No parameter changes hands: `schedule.infra-health` is
created from the frontmatter by `initializeAgents` as for every scheduled
agent.

## 6. Verification

- `pnpm install --frozen-lockfile` then `pnpm test` from the repository root
  pass, and `pnpm -F @panelator/scheduler typecheck` is clean, with the tests
  of section 5 added; `registryActionsCheck` passes with `sweep_volume`
  present in both `agents/actions.yaml` and `KINDS`.
- The AC-4 fixture test fails on `main` before the change (no `sweep_volume`
  kind) and passes after it; the spec 059 tests pass without edits.
- Live check after deploy, in the implement stage's PR: with the service
  running, create a directory `panelator-test-live` under the temp directory
  with an `mtime` three hours old (`touch -d`) and one `issue-999` directory
  under the state's `worktrees/` with an old `mtime` and no claim; within the
  next sweep both are gone, the action log has two `applied` `sweep_volume`
  entries by `scheduler`, and the service log has the `disk-sweep` lines.
  Then, with a stage due, report a low volume by filling the tmpfs's inodes
  under `panelator-test-fill` with `mtime` now until under 100,000 remain:
  the next tick logs `disk-sweep-urgent`, then `disk-sweep-alarm`, one
  Telegram message with label `disk_full` naming `panelator-test-fill` as a
  holder, one finding and one `infra_alarm`; remove the directory; the next
  tick logs `disk-sweep-recovered`, the stage runs, and infra health runs on
  the alarm and returns a finding naming the directory. The PR quotes the
  log lines.
- The first live `infra_alarm` of kind `disk_full` handled by infra health
  is written up in `dev-logs/` with its run record.

## 7. Open decisions

None.
