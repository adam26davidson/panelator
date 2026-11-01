# 030. Test board and automatic stable firmware promotion

Status: written 2026-11-01 for issue #40 from the delivery-system design (row
G of section 11); specs derived from that design need no maintainer approval
(design section 11). The order of building is ADR 0006: the scheduler side
(this spec's acceptance criteria) is built now against the HIL job contract
of section 8; the firmware side (the HIL job, the firmware build and release
workflow) is its own spec, written when product milestone 1 has put firmware
on `main`, and is listed in section 2.
Class: tooling. Domain: automation (sensitive path, process-spec section 5).
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 5 ("Firmware and the test board"), section 3 item 3 (recovering a
bricked test board is a physical action only the maintainer can do), section
11 (row G) and section 13 ("promotion criteria for firmware stable" are left
to the builder); [process-spec](../../docs/process-spec.md) sections 3
(verify: HIL when firmware changes), 5 (release safety: firmware to beta
automatically, stable under G's criteria) and 6.1 (the laptop is the HIL rig
and the self-hosted runner); [product-spec](../../docs/product-spec.md)
sections 3 (OTA: two slots with rollback, signed builds, stable and beta
channels), 12 (milestone 1, the runtime spike) and 13 (end-to-end on the HIL
rig); [design-tree](../../docs/design-tree.md) R3.Q11 (channels, signed
builds), R5.Q5 (HIL on the existing self-hosted runner), R7.Q3 (firmware beta
auto; stable was human, now superseded by design section 5);
[ADR 0006](../../docs/decisions/0006-test-board-spec-before-firmware.md)
(the order); [spec 008](../008-agent-registry/spec.md) AC-4 (events wake
agents, `ci_failure_main`), AC-8 (`rerun_workflow`), AC-11 and AC-17
(parameters and the maintainer's commands); [spec 006](../006-no-human-stops/spec.md)
AC-13 to AC-18 (a question pauses an issue, the reply resumes it, answers are
logged); [spec 007](../007-telegram-channel/spec.md) AC-5 (questions with
buttons); [spec 015](../015-chain-keeps-its-work/spec.md) (held work);
[spec 026](../026-event-store/spec.md) AC-1 and AC-2 (events, `ci.check`).

What the maintainer decided (design section 5 and the issue), kept as it is
here: firmware is tested on a real test board attached to the laptop (the HIL
rig); promotion from beta to stable is automatic once the board's tests pass,
under criteria this spec sets; until this spec lands there is no promotion to
stable; if a test bricks the board, recovery is physical: the system tells the
maintainer and pauses firmware work until the maintainer confirms the board is
back. Connecting the board to the laptop and recovering it are the
maintainer's alone (design section 3, item 3).

## 1. Goal

Give the scheduler the firmware release path the design describes, in code,
so that when firmware exists it is tested, published and promoted without a
human on the path, and the one failure that needs a human (a bricked board)
reaches the maintainer and stops exactly the work that needs the board:

- **The board gate.** A PR that changes firmware merges only when the HIL
  check has passed on its head, beside the `required_checks` of today. The
  HIL check is a GitHub Actions job on the laptop's self-hosted runner that
  flashes the board and runs the firmware's HIL suite; its contract with the
  scheduler is section 8.
- **Beta, then stable.** A merged firmware build is published to the beta
  channel by the firmware CI (the firmware-side spec); the scheduler records
  it, keeps the test board running it as the soak device, and promotes it to
  stable when the criteria of AC-6 hold. The channels are the prerelease flag
  of a GitHub Release (section 4), which the backend's OTA distribution reads
  when it exists.
- **The brick and the pause.** When the HIL job reports the board bricked,
  the scheduler records it, pauses firmware work, and asks the maintainer, as
  a capability question on the issue whose run did it, to recover the board.
  The maintainer's confirmation (a Telegram button, or a command on the
  laptop) is the only thing that resumes firmware work.

Nothing in this spec runs the board. With no `firmware` block configured, the
scheduler runs exactly as it does today.

## 2. Out of scope

- **The firmware side**, which is its own spec under the same parent, written
  when milestone 1 has put a buildable ESP-IDF project under `firmware/` (ADR
  0006): the HIL workflow `.github/workflows/hil.yml` and its runner labels,
  the serial harness that flashes the board and drives the suite, the HIL
  test suite itself (product-spec 13: provision, claim, push a screen, see
  the frame), the automatic restore of the last-good image before a brick is
  declared, the firmware build and signing, and the beta publication as a
  prerelease. Section 8 is the contract that spec implements; that spec may
  tighten it, not loosen it.
- The firmware itself, the runtime spike (product-spec 12) and the backend's
  OTA distribution (product-spec 5). The channel representation of section 4
  is what the backend reads later; nothing here serves firmware to a board.
- Signing keys and the runner's credentials: the credential store of spec F2.
- The console's view of the board and the channels (spec E's second part).
  Until it exists, `panelator-scheduler board` and `firmware` on the laptop
  are the view (AC-9).
- Rollback on a user's board (product-spec 3: two slots with rollback) and
  any telemetry from strangers' boards. The soak of AC-6 is on the test board
  only; fleet telemetry is a later criterion, added through the parameter and
  the criteria list of AC-6 by a reviewed PR.
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review. `tools/scheduler/` and
  `agents/` are sensitive, so the security review runs on the PR.

## 3. Acceptance criteria

"Given" states use the fake harness and a mocked GitHub API, as in spec 001.
Definitions: a *firmware PR* is a PR whose diff touches a path matching
`firmware.paths`; a *firmware issue* is a claimed issue whose spec on
`origin/main` lists a path under `firmware/` in its interfaces section, or
whose open PR is a firmware PR; *the HIL check* is the check run named
`firmware.hil_check`; *the HIL result* is the artifact of section 8 read from
that check's workflow run; *the board* is the one test board the HIL job
drives, with its state in `board.json` (AC-7).

**Configuration**

- AC-1. **Firmware handling is configured, and off by default.**
  `agents/scheduler.yaml` gains a `firmware` block: `paths` (globs, default
  `["firmware/**"]`), `hil_check` (the check run name, default `hil`),
  `hil_workflow` (the workflow file name, default `hil.yml`),
  `release_tag_prefix` (default `firmware-v`). Given the block is absent,
  when the service starts, then firmware handling is off: the service log
  records `firmware: off` once, no behaviour of this spec runs, and the
  recorded chains of specs 006, 007, 008, 013, 015, 022, 025, 026 and 029
  pass unchanged. An unknown key, an empty `paths` or an empty check name
  fails config validation (spec 001 AC-1 rules). `agents/parameters.yaml`
  gains `firmware.soak_hours`: `duration`, default `72h`, min `1h`, max
  `30d`, `auto` (the system may shorten or lengthen the soak; the
  maintainer may lock it), and `firmware.promotion_enabled`: `boolean`,
  default `true`, `auto` (a reversible switch the system or the maintainer
  can flip to hold promotion without a code change).

**The board gate** (process-spec 3 and 5)

- AC-2. **A firmware PR waits for the HIL check.** Given firmware on and a
  chain at the merge step whose PR is a firmware PR, then the HIL check is
  required on the head SHA beside `required_checks`: given it is not yet
  reported, the chain waits as it waits for any required check; given it
  passed, the merge proceeds; given it failed with a HIL result whose
  `outcome` is `fail`, then the failure goes to the fix stage as a CI
  failure does today, with the HIL result's `tests` and `log` in the fix
  input, counted against the existing fix bound. Given a PR that is not a
  firmware PR, then the HIL check is not required and not read, whether or
  not it exists. Every read of the HIL check's final state is a `ci.check`
  event (spec 026 AC-2) and every HIL result read is one `hil.result` event
  with the artifact as payload.
- AC-3. **A firmware PR is not merged while the board is bricked or
  missing.** Given a firmware issue reaching the merge step, or the point
  where the HIL check would be awaited, while `board.json` is not `ok`
  (AC-7), then the claim is released with `issue.released` reason
  `postponed` and `why: board_<status>`, its work held (spec 015), and the
  issue is not shortlisted again until the board is `ok`; the same skip
  applies in the shortlist to any firmware issue not yet claimed. Given the
  board returns to `ok`, then those issues are eligible again at their
  former rank. Non-firmware issues are never affected: a test asserts a
  backend issue is claimed and merged while the board is bricked.

**Beta and stable** (design section 5, product-spec 3)

- AC-4. **A beta build is recorded when it appears.** Given firmware on, then
  the tick lists releases whose tag starts with `release_tag_prefix` (full
  pagination, process-spec 6.4). Given a release not yet in
  `firmware/releases.json` in the state directory, then it is recorded as
  `{ tag, version, sha, published_at, channel: "beta" | "stable", hil: {
  status, run_id, at } | null, soak_started_at, promoted_at, demoted_at,
  promoted_by }` with `channel` read from the release's prerelease flag
  (`true` is beta, `false` is stable), and one `firmware.published` event
  is recorded. A release with no `sha` the scheduler can resolve (the tag
  does not point at a commit on `main`) is recorded with `hil: null` and
  never promoted; a notification with label `firmware-release` says why,
  once per tag.
- AC-5. **The merged build is the tested build.** Given a beta release whose
  `sha` is on `main`, then `hil` is the final state of the HIL check on that
  SHA on `main` (the firmware-side workflow also runs on `push` to `main`
  for firmware paths, section 8), read as AC-2 reads a PR's; the soak
  (`soak_started_at`) starts when that check passed, not at publication.
  Given the HIL check on `main` fails for that SHA, then the release is
  never promoted, the failure is the `ci_failure_main` event spec 008
  already emits, and `firmware-release` is notified once.
- AC-6. **Promotion is automatic under these criteria, and only these.**
  Given `firmware.promotion_enabled` true and a beta release for which all of
  the following hold at a tick, then the scheduler promotes it: it edits the
  release to clear the prerelease flag (through the App, the one way a
  release becomes stable), writes `channel: "stable"`, `promoted_at` and
  `promoted_by: "scheduler"`, records one `firmware.promoted` event with the
  criteria as evaluated, and sends one notification with label
  `firmware-promoted`. The criteria, each named in the event payload with
  its value:
  1. `hil_passed`: `hil.status` is `pass` on the release's SHA on `main`
     (AC-5);
  2. `soaked`: `firmware.soak_hours` have elapsed since `soak_started_at`;
  3. `soak_clean`: every HIL result on `main` since `soak_started_at`,
     including the scheduled soak runs of section 8, has `outcome: pass`
     and `board.status: ok`, and the board has not been `bricked` in that
     time (AC-7);
  4. `latest`: no newer beta release exists whose SHA is on `main` after
     this one's (an older build is not promoted over a newer one; the newer
     one is promoted when it qualifies, and the older is then skipped and
     recorded `promoted_by: "superseded"` with no release edit);
  5. `board_ok`: `board.json` is `ok` at the tick;
  6. `no_open_firmware_regression`: no open bot-authored issue carries the
     label `firmware-regression` (the label the findings filer applies when
     a finding names a beta build; the label is added to
     `agents/scheduler.yaml`'s label list and `agents/standing/findings-filer.md`
     says when to use it).

  Given any criterion false, then nothing is edited and the release stays
  beta; the tick's service-log line carries `firmware: { beta: [tag...],
  stable: tag, next: { tag, waiting_on: [criteria] } }`. Given
  `firmware.promotion_enabled` false, then criteria are evaluated and logged
  but no release is edited. Promotion edits exactly one release per tick.
  The release edit's failure is logged and retried at the next tick; the
  record is written only after the edit succeeds. *(agent's call: the
  criteria. The design leaves "which HIL tests, any soak time" to this
  spec; the HIL suite is the firmware-side spec's, so the gate here is its
  whole outcome, and the soak is the test board itself running the beta
  build between HIL runs, which is the only beta device the system has.)*

**The brick** (design section 5, section 3 item 3)

- AC-7. **The board has a state only the maintainer can set to ok.**
  `board.json` in the state directory is `{ status: "ok" | "bricked" |
  "unknown", since, reason, run_id, issue, pr, confirmed_at, confirmed_by
  }`. Given no file, then the status is `unknown` until the first HIL result
  with `board.status: ok` is read, which sets `ok` (so a board that was
  never seen does not block the first firmware PR from being tested, only
  from merging before its HIL check ran). Given a HIL result with `outcome:
  bricked`, then `status: bricked` is written with the result's `reason`,
  the run, issue and PR, before anything else is done with the result, and
  one `board.bricked` event is recorded. Given `status: bricked`, then no
  HIL result, no action and no agent can set it to `ok`: only
  `panelator-scheduler board back` (run on the laptop as the maintainer)
  or the maintainer's answer of AC-8 writes `ok` with `confirmed_at` and
  `confirmed_by: "maintainer"`, and records one `board.back` event. A test
  asserts that a second `bricked` result, a `pass` result, and every action
  kind in `agents/actions.yaml` leave `bricked` in place.
- AC-8. **The maintainer is told, as a capability question, and firmware
  work pauses.** Given a HIL result with `outcome: bricked` for a PR of a
  claimed issue, then the scheduler writes the question itself into the
  questions log on that issue (spec 006 AC-18), of kind `capability`, with
  the text: the board is bricked, the PR and run that did it, the result's
  `reason` and `log` tail, the recovery steps of section 8 ("hold BOOT,
  press RESET, run the restore command, confirm"), one option labelled
  "Board is back", and the recommendation that the maintainer confirms only
  once the restore succeeded. The question skips the question-check stage:
  design section 3 item 3 names this case, so there is nothing for the check
  to judge *(agent's call)*. The issue pauses as any sent question pauses it
  (spec 006 AC-13), the question goes over Telegram with its button (spec
  007 AC-5) and the 24-hour reminder applies (spec 006 AC-16). Firmware work
  pauses as AC-3 says; non-firmware work continues. Given the maintainer's
  answer, then the resume path (spec 006 AC-15) first writes `board.json`
  to `ok` as AC-7 says, then re-runs the HIL workflow run on the PR head
  (`rerun_workflow`'s code path, logged in the action log with `agent:
  scheduler`), and the chain continues at the merge step awaiting the HIL
  check as in AC-2; given the re-run bricks the board again, then AC-7 and
  this criterion apply again, counted per issue in the escalation ledger as
  `board_bricks`; given it reaches `bounds.board_bricks` (chain
  configuration, default 2), then the PR is closed with its branch saved as
  a patch and the issue follows spec 006 AC-5's abandonment path with the
  record, so one issue cannot keep bricking the board. Given a `bricked`
  result from a `main` or soak run (no claimed issue), then the question is
  written on no issue: the notification with label `board-bricked` carries
  the same text and steps, the `maintainer.contact` event is recorded, and
  `board back` is the confirmation. Given `board.json` already `bricked`
  when a second `bricked` result arrives, then nothing is sent again.
- AC-9. **The state is visible and the maintainer has the commands.**
  `panelator-scheduler board` prints `board.json`; `board back` is AC-7;
  `board bricked <reason>` lets the maintainer mark it by hand (the board is
  unplugged, for instance) and pauses firmware work as AC-3 says.
  `panelator-scheduler firmware` prints `releases.json` with each release's
  channel, HIL state, soak start and the criteria of AC-6 as last
  evaluated; `firmware demote <tag> <reason>` sets the release's prerelease
  flag back, writes `channel: "beta"`, `demoted_at` and records one
  `firmware.demoted` event; it is the undo of a promotion and is logged in
  the action log with `agent: maintainer`; a demoted release is never
  promoted again by AC-6 (`promoted_by` keeps `"scheduler"` and
  `demoted_at` is set). `firmware promote <tag>` promotes by hand, logged
  likewise, with the criteria recorded as evaluated even when not all hold.
  Given a tick while firmware is on, then the tick's service-log line
  carries `board: { status, since }` beside the `firmware` field of AC-6.

## 4. Design notes (agent's calls)

- **The channel is the release's prerelease flag.** Product-spec 3 and
  R3.Q11 want stable and beta channels and signed builds; the backend owns
  OTA distribution and does not exist. A GitHub Release per firmware build,
  tagged `firmware-v<version>`, prerelease while beta, is a channel store
  that exists today, is readable by the backend later with one API call, is
  reversible (demotion is the flag back), and is edited through the App so
  every change is attributable. A manifest file in the repository would make
  each promotion a PR and each demotion a revert, which is the wrong weight
  for an operational, reversible action (design section 6.2, level 1).
- **The soak device is the test board.** Between HIL runs the board keeps
  running the last merged build, and the scheduled soak runs of section 8
  read its uptime, resets and heap over serial. A build that cannot stay up
  on the one board the system has is not promoted; a build that can has met
  the only evidence available before there are users. `firmware.soak_hours`
  is `auto` so reflection can tune it as the fleet and the metrics grow.
- **The gate is the suite's whole outcome.** Which tests the HIL suite
  contains is the firmware-side spec's; here a firmware PR merges on a green
  HIL check and promotion wants the same check green on `main`. Naming
  individual tests here would make this spec change with every test added.
- **The brick is a capability question without the check.** Design section
  3 item 3 names "recovering a bricked test board" as what agents cannot do.
  Sending it through the question-check stage would spend a strong-tier run
  to confirm what the design states, and the resume, Telegram button,
  reminder and recording machinery keyed on an issue is reused as it is.
  When there is no issue (a soak run bricked the board), the notification
  and the command are the path, as spec 022 handles setup it cannot do.
- **Firmware work is postponed, not failed.** A bricked board is not the
  issue's fault once it is recorded, and the design says to pause firmware
  work. Releasing the claim with held work is what spec 015 built for exactly
  this; the slot goes to non-firmware work.
- **Why now, with no firmware.** ADR 0006: the scheduler side has a fixed
  contract (section 8), is testable with the fake harness and a mocked
  GitHub, and lands the pause and the promotion criteria before the first
  firmware PR exists, so milestone 1's first firmware PR is tested on the
  board from day one rather than merged untested.

## 5. Interfaces and files

This list is the implementation's file scope: the plan's tasks name these
files (a whole directory, written with a trailing slash, where the list
gives one) and no other.

- **The scheduler, under `tools/scheduler/src/`.** `firmware/` as a
  directory: `board.ts` (`board.json`, AC-7; the brick handling and the
  question of AC-8), `releases.ts` (`releases.json`, the release listing,
  AC-4 and AC-5), `promote.ts` (the criteria, the promotion, demotion,
  AC-6 and AC-9), `hil.ts` (reading the HIL check and its result artifact,
  the `hil.result` event, section 8's schema), `paths.ts` (the firmware
  path match of AC-1 over a PR's files and a spec's interfaces section).
  `config.ts` (the `firmware` block and `bounds.board_bricks`, AC-1, AC-8);
  `chain/machine.ts` and `chain/driver.ts` (the HIL check beside
  `required_checks` at the merge step, the fix input for a HIL failure, the
  postponement of AC-3, the resume step of AC-8); `chain/types.ts` and
  `schemas/scheduler/escalation-ledger.json` (`board_bricks`);
  `shortlist/select.ts` (the firmware skip of AC-3); `service/loop.ts` (the
  release listing and promotion step of a tick, after the AWS pull and
  before the standing agents; the tick line's `firmware` and `board`
  fields); `state/paths.ts` (`board.json`, `firmware/releases.json`);
  `state/questions.ts` (the capability question written by the scheduler,
  AC-8); `github/client.ts` (list releases with pagination, edit a
  release's prerelease flag, list a workflow run's artifacts and download
  one, re-run a workflow run on a head SHA); the events kinds module under
  `events/` and `schemas/scheduler/event.json` (`hil.result`,
  `firmware.published`, `firmware.promoted`, `firmware.demoted`,
  `board.bricked`, `board.back`); `bin/scheduler.ts` (`board`, `board
  back`, `board bricked`, `firmware`, `firmware promote`, `firmware
  demote`, AC-9).
- **Agents and schemas.** `agents/scheduler.yaml` (the `firmware` block,
  `bounds.board_bricks`, the `firmware-regression` label);
  `agents/parameters.yaml` (`firmware.soak_hours`,
  `firmware.promotion_enabled`); `agents/standing/findings-filer.md` (when
  to label a filed issue `firmware-regression`: a finding whose evidence
  names a firmware release tag or a HIL result); `agents/stages/fix.md`
  (the HIL result's `tests` and `log` in the fix input, AC-2);
  `schemas/scheduler/`: `board-state.json`, `firmware-release.json`,
  `hil-result.json` (section 8), `stage-input.json` (the HIL fields for
  fix), `scheduler-config.json` if the config has a schema.
- **Tests, under `tools/scheduler/test/`.** `firmware.test.ts` (path
  matching, the board state and its one-way rule, the criteria table of
  AC-6 with each criterion false in turn, promotion and demotion, the
  superseded case, the release with no SHA), `config.test.ts` (AC-1),
  `chain.test.ts` (AC-2, AC-3, AC-8), `shortlist.test.ts` (AC-3),
  `loop.test.ts` (the tick step and fields), `parameters.test.ts`, the
  recorded runs of section 6 in `e2e.test.ts` with `helpers/e2e-routes.ts`
  (releases, artifacts, workflow re-run) and a firmware fixture spec under
  `fixtures/specs/`.
- **Documents.** `tools/README.md` (the commands and the `firmware` block).
  `dev-logs/` as a directory for the implementation's log.

No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/`,
`tools/README.md` and `dev-logs/` is changed by the implementation.
`tools/scheduler/` and `agents/` are sensitive paths, so the security review
runs on the PR as spec 006 AC-9 says. `.github/workflows/hil.yml` is the
firmware-side spec's and is not added here.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including recorded end-to-end runs (fake adapter, mocked GitHub) for:
  - no `firmware` block: every earlier recorded chain unchanged,
    `firmware: off` once (AC-1);
  - a firmware PR: merge waits for the HIL check, merges on `pass`; a
    `fail` result goes to fix with the tests and log (AC-2); a backend PR
    merges with no HIL check present (AC-2);
  - a beta release appearing: recorded, HIL on `main` read, soak started;
    after `soak_hours` with clean soak results: promoted, release edited
    once, `firmware.promoted` event, one notification; each criterion false
    in turn: not promoted and `waiting_on` names it; a newer beta
    supersedes an older; `promotion_enabled` false: evaluated, not edited
    (AC-4 to AC-6);
  - a `bricked` result on an issue's PR: `board.json` bricked, the
    capability question on the issue without a question-check run, the
    issue paused, a second firmware issue postponed with held work, a
    backend issue merged meanwhile; `board back` (and, separately, the
    Telegram answer): board ok, HIL re-run, merge on pass; two bricks on
    one issue: abandonment path (AC-3, AC-7, AC-8);
  - a `bricked` result from a soak run: notification only, `board back`
    clears it (AC-8);
  - `firmware demote` after a promotion: flag back, never re-promoted
    (AC-9).
- With the firmware-side spec merged and the board attached, the first real
  HIL run, the first beta release record and the first promotion are
  written up in `dev-logs/` with the events and the release edits; until
  then the service runs with firmware on and nothing to list, and that
  tick's log line is quoted in the implementation PR.

## 7. Open decisions

None.

## 8. The HIL job contract (what the firmware-side spec implements)

The scheduler reads one GitHub Actions check run, `firmware.hil_check`
(default `hil`), produced by the workflow `firmware.hil_workflow` (default
`.github/workflows/hil.yml`) on the laptop's self-hosted runner, with:

- **Triggers.** `pull_request` and `push` to `main`, both filtered to
  `firmware.paths`; and `schedule` for the soak runs, at least every 12
  hours, which flash nothing and only read the board.
- **Concurrency.** One run at a time on the board (a workflow concurrency
  group), so a soak read and a flash never interleave.
- **The artifact** `hil-result`, one JSON file validating against
  `schemas/scheduler/hil-result.json`: `{ outcome: "pass" | "fail" |
  "bricked", sha, kind: "pr" | "main" | "soak", board: { status: "ok" |
  "bricked", firmware_sha, uptime_s, resets, free_heap, free_psram },
  tests: [{ name, status: "pass" | "fail" | "skip", duration_ms, message? }],
  reason?, log }`, where `log` is the tail of the serial log (at most 64 KB).
- **What `bricked` means.** After flashing, the board gives no boot banner
  or no `hello` within the job's timeout, and the job's own restore of the
  last-good image over USB (which it attempts before declaring anything)
  also fails, or the download mode cannot be entered. `fail` is a suite
  failure on a board that boots. The job never reports `bricked` for a
  board that is simply absent at start: that is `fail` with `reason:
  "board not found"`, and the check is red, so a firmware PR does not merge
  untested.
- **The recovery steps** the scheduler quotes in AC-8, kept in
  `tools/scheduler/src/firmware/board.ts` as text until the firmware-side
  spec replaces them with the project's own: unplug and replug the board,
  hold BOOT while pressing RESET to enter download mode, run the restore
  command the firmware-side spec provides (which flashes the last-good
  image from the runner's cache), wait for the boot banner, then confirm
  with the "Board is back" button or `panelator-scheduler board back`.
- **The check on `main`** is what AC-5 and AC-6 read; the soak runs' results
  are read as `hil.result` events with `kind: "soak"` and count in
  `soak_clean`.
