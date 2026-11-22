# 070. Test board and automatic stable firmware promotion

Status: written 2026-11-17 for issue #132 from the delivery-system design (row
G of section 11); specs derived from that design need no maintainer approval
(design section 11). Recovered from the draft of issue #40 (commit 7768b8a,
then numbered 030) and brought up to `main`: the board pause is now spec
060's block, the maintainer's commands are action kinds as spec 069 made the
`cred` commands, and the maintainer is told over the Telegram channel
directly because the `Notifier` still only writes the service log. The order
of building and who builds the HIL workflow is [ADR
0013](../../docs/decisions/0013-test-board-gate-before-firmware.md): this
spec is built now; the HIL workflow, the serial harness, the HIL suite and
the beta publication are the firmware's own verification and build, written
with the firmware against section 8's contract. Amends
[060-out-of-scope-check-failure-blocks-on-main](../060-out-of-scope-check-failure-blocks-on-main/spec.md)
AC-4 (the actions of a block), AC-7 (the conditions the loop tests) and AC-8
(the resume), each marked as section 4 records. *(agent's call)* Revised
2026-11-18 after the first implementation: AC-9 derives a release's `hil`
and `soak` from every result read, so a HIL result read before its release
is recorded is not lost, and section 5 names `schema/validate.ts`,
`schemas/scheduler/claim.json` and the `firmware/` directory whole, which
the implementation needs. *(agent's call)*
Class: tooling. Domain: automation (sensitive path, process-spec section 5).
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 5 ("Firmware and the test board"), section 3 item 3 (recovering a
bricked test board is a physical action only the maintainer can do), section
11 (row G) and section 13 ("Promotion criteria for firmware stable" are left
to the builder); [process-spec](../../docs/process-spec.md) sections 3
(verify: HIL when firmware changes), 5 (firmware to beta automatically,
stable under spec G's criteria) and 6.1 (the laptop is the HIL rig and the
self-hosted runner); [product-spec](../../docs/product-spec.md) sections 3
(OTA: signed builds, stable and beta channels), 12 (milestone 1, the runtime
spike) and 13 (the end-to-end test on the HIL rig is a product testing
contract); [design-tree](../../docs/design-tree.md) R3.Q11 (channels, signed
builds), R5.Q5 (HIL on the existing self-hosted runner), R7.Q3 (firmware beta
automatic; its "stable human" is replaced by design section 5);
[ADR 0013](../../docs/decisions/0013-test-board-gate-before-firmware.md);
[spec 006](../006-no-human-stops/spec.md) AC-5 (the terminal step), AC-17 (a
required check that never reports); [spec 007](../007-telegram-channel/spec.md)
(the Telegram channel); [spec 008](../008-agent-registry/spec.md) AC-8, AC-9,
AC-11 and AC-17 (action kinds, the action log, parameters, the maintainer's
commands); [spec 026](../026-event-store/spec.md) AC-1 and AC-2 (events,
`ci.check`); [spec 056](../056-check-failure-history-keeps-the-failing-lines/spec.md)
(a failed check's lines in the fix input);
[spec 060](../060-out-of-scope-check-failure-blocks-on-main/spec.md) AC-4,
AC-7, AC-8 (a block is a pause without a question, resumed by the loop);
[spec 069](../069-github-app-key-check-signs-with-the-stored-key/spec.md)
section 1, "The commands are action kinds".

What the maintainer decided (design section 5 and issue #132), kept as it is
here: firmware is tested on a real test board attached to the laptop (the HIL
rig); promotion from beta to stable is automatic once the board's tests pass,
under criteria this spec sets; until this spec lands there is no promotion to
stable; if a test bricks the board, recovery is physical: the system tells the
maintainer and pauses firmware work until the maintainer confirms the board is
back. Connecting the board to the laptop and recovering it are the
maintainer's alone (design section 3, item 3).

## 1. Goal

Give the scheduler the firmware release path of design section 5, so that
from the first firmware PR on, firmware is tested on the board before it
merges, published builds are promoted without a human, and the one failure
that needs a human (a bricked or missing board) reaches the maintainer and
stops exactly the work that needs the board:

- **The board gate.** A PR that changes firmware passes verify only when the
  HIL check has passed on its head, beside `required_checks`. The HIL check
  is a check run that the firmware's HIL workflow posts from the laptop's
  self-hosted runner after flashing the board and running the HIL suite; its
  contract with the scheduler is section 8. A firmware PR whose head has no
  HIL workflow waits for `main` to gain one, with a finding that gets it
  built, so firmware never merges untested.
- **Beta, then stable.** A firmware build is published as a prerelease of a
  GitHub Release by the firmware's release workflow (section 8). The
  scheduler records it, follows its HIL results on the board, and promotes
  it to stable (clears the prerelease flag) when the criteria of AC-9 hold.
- **The brick and the pause.** When a HIL result reports the board bricked
  or absent, the scheduler records the board's state, tells the maintainer
  with the recovery steps, and holds every firmware PR at the gate until the
  maintainer confirms with `panelator-scheduler board back` on the laptop
  (for an absent board, a later HIL result that sees it also clears it).
  Non-firmware work continues.

With no `firmware` block configured, the scheduler runs exactly as it does
today.

## 2. Out of scope

- **The firmware side** (ADR 0013): the HIL workflow under
  `.github/workflows/`, the serial harness that flashes the board, the HIL
  suite (product-spec 13: provision, claim, push a screen, see the frame),
  the restore of the last-good image before a brick is declared, the
  firmware build, signing and the beta publication. They are the firmware's
  own verification and build, written with the firmware from milestone 1 on;
  section 8 is the contract they meet, which they may tighten, not loosen.
  This spec adds no workflow and changes no file under `.github/`.
- The firmware itself, the runtime spike (product-spec 12) and the backend's
  OTA distribution (product-spec 5). Nothing here serves firmware to a
  board; the backend reads the channels of AC-8 when it exists.
- Signing keys and the runner's credentials (specs 030, 068 and 069).
- Routing the `Notifier` over Telegram (spec 030 AC-9, spec 068); this spec
  sends its board messages through the Telegram channel directly (AC-5).
- The console's view of the board and the channels (spec 051's later
  screens). Until then `panelator-scheduler board` and `firmware` are the
  view (AC-12).
- Rollback on a user's board (product-spec 3) and telemetry from other
  boards. The soak of AC-9 is on the test board, the only device the system
  has; fleet evidence is a later criterion, added by a reviewed PR.
- Changing the sensitive-path list, the security review criteria, or what
  routes a sensitive diff to the security review. `tools/scheduler/` and
  `agents/` are sensitive, so the security review runs on the PR.

## 3. Acceptance criteria

"Given" states use the driver and loop tests' fakes, the fake harness and the
mocked GitHub of `tools/scheduler/test/helpers/e2e-routes.ts`. Definitions: a
*firmware PR* is a PR whose files include a path matching one of
`firmware.paths` (the matcher of `src/glob.ts`); *the HIL check* is the check
run named `firmware.hil_check` on a commit; *a HIL result* is the JSON of
section 8 read from a completed HIL check's `output.text`; *the board* is
the one test board, with its state in `board.json` (AC-4).

**Configuration**

- AC-1. **Firmware handling is configured, and off without its block.**
  The scheduler configuration gains an optional `firmware` block: `paths`
  (globs, default `["firmware/**"]`), `hil_check` (check run name, default
  `hil`), `hil_workflow` (workflow file name under `.github/workflows/`,
  default `hil.yml`), `release_tag_prefix` (default `firmware-v`), and
  `bounds.board_bricks` (positive integer, default 2, beside
  `bounds.design_revisions`). Given the block is absent, when the service
  starts, then the service log records `{ kind: "firmware", state: "off" }`
  once, no behaviour of this spec runs, and every existing recorded chain
  passes unchanged. An unknown key, an empty `paths`, an empty name or a
  non-positive bound fails config validation as other config errors do.
  `agents/scheduler.yaml` gains the block with its defaults, so firmware
  handling is on in the deployed service (ADR 0013). `agents/parameters.yaml`
  gains `firmware.soak_hours` (`duration`, default `72h`, min `12h`, max
  `30d`, `auto`) and `firmware.promotion_enabled` (`boolean`, default `true`,
  `auto`: a standing agent that sees a regression in a beta build may hold
  promotion with `set_parameter`, and the maintainer may lock it).

**The board gate** (process-spec 3 and 5)

- AC-2. **A firmware PR's verify requires the HIL check.** Given firmware on
  and a chain at verify whose PR is a firmware PR, then the HIL check is
  read beside `required_checks` on the head SHA: pending or absent, verify
  waits as for any required check (spec 006 AC-17's six-hour rule applies
  unchanged, so a runner that never reports reaches the maintainer as "a
  required check never reported"); concluded `success` with a HIL result
  whose `outcome` is `pass`, the check counts as passed; concluded
  `failure` with `outcome: fail`, the check counts as failed and the fix
  stage runs as for any failed check, counted against the existing fix
  bound, with the failed-check lines of spec 056 built from the HIL result:
  one line per test with `status: fail` (`<name>: <message>`), then the last
  200 lines of `log`. Given `outcome` is `bricked` or `absent`, then AC-5
  applies and the check counts as neither passed nor failed. Given a HIL
  check whose output does not validate against
  `schemas/scheduler/hil-result.json`, then it counts as failed with the
  single line `HIL result invalid: <first error>`. Given a PR that is not a
  firmware PR, then the HIL check is neither required nor read. Each final
  read of the HIL check is a `ci.check` event (spec 026 AC-2) and each HIL
  result read is one `hil.result` event whose payload is the result without
  `log`.
- AC-3. **A firmware PR without the HIL workflow waits for `main` to gain
  one.** Given firmware on and a chain reaching verify with a firmware PR
  whose head has no file `.github/workflows/<firmware.hil_workflow>`, then
  the chain blocks (spec 060 AC-4) with condition `{ kind: "paths", paths:
  [".github/workflows/<hil_workflow>"], main_sha }` and, in place of spec
  060's finding text, one finding with `what: "firmware PR #<n> cannot be
  tested on the board: .github/workflows/<hil_workflow> does not exist"`,
  `where` that path, `evidence` naming this spec's section 8 and the PR's
  firmware files (at most ten), `noticed_how: "verify of PR #<n>"`. The
  block resumes as spec 060 AC-7 and AC-8 say once `main` gains the file.
  Given the PR's head does contain the file, then no such block happens.

**The board** (design section 5, section 3 item 3)

- AC-4. **The board has a state that only the maintainer clears from
  bricked.** `board.json` in the state directory validates against
  `schemas/scheduler/board-state.json`: `{ status: "ok" | "absent" |
  "bricked" | "unknown", since, reason, check_run_id, pr, confirmed_at,
  confirmed_by }`. No file reads as `unknown`. Every HIL result read (from a
  PR, `main` or a soak run, AC-2 and AC-7) is applied to it before anything
  else is done with the result: `outcome: bricked` sets `bricked`; `outcome:
  absent` sets `absent` unless the status is `bricked`; a result with
  `board.status: ok` sets `ok` only from `unknown` or `absent`. Every change
  of status records one `board.changed` event `{ from, to, reason,
  check_run_id }`. From `bricked`, only the `board_back` action kind (AC-12)
  writes `ok`, with `confirmed_at` and `confirmed_by: "maintainer"`; its
  check refuses any actor but the maintainer. A test asserts that a second
  `bricked` result, a `pass` result, an `absent` result, and a request of
  every kind in `agents/actions.yaml` by a standing agent leave `bricked` in
  place.
- AC-5. **A bricked or absent board pauses firmware work.** Given a chain at
  verify whose HIL result is `bricked` or `absent`, or whose firmware PR
  reaches verify while `board.json` is `bricked` or `absent`, then the chain
  blocks (spec 060 AC-4) with condition `{ kind: "board", main_sha }`, its
  actions being one `comment` on the issue (no @-mention) saying the PR
  waits for the test board and why, and the `block`; no finding and no
  notification are emitted for it, and spec 060's `blocks` count is not
  increased. Given the result is `bricked` and came from this PR's head,
  then the ledger's `board_bricks` for the issue (a new counter beside
  `blocks`) is increased first; given it reaches `bounds.board_bricks`, then
  instead of blocking, the chain takes spec 006 AC-5's terminal step (the
  PR closed and its branch saved as a patch, the `abandoned` label, the
  finding, the information-only notice) with the reason `the PR's firmware
  bricked the test board <n> times`, so one issue cannot keep bricking the
  board. While `board.json` is `bricked` or `absent`, the shortlist skips an
  issue that has an open firmware PR or whose spec on `origin/main` names a
  path under a `firmware.paths` prefix in its interfaces section, and puts
  it back at its rank when the board is `ok` or `unknown`. A test asserts a
  non-firmware issue is claimed, verified and merged while the board is
  bricked.
- AC-6. **The board block resumes when the board is back.** Given a
  `blocked/<issue>.json` record with condition `kind: "board"`, then at each
  tick the loop's test of spec 060 AC-7 holds when `board.json` is `ok` or
  `unknown`, and the resume of spec 060 AC-8 applies; after its
  `rebase_push`, when the head did not change and the last HIL check on it
  concluded with a `bricked` or `absent` result, the driver re-runs that
  result's workflow run (`gh.rerunWorkflowRun(result.run_id)`, the chain's
  own step, logged `{ kind: "hil-rerun", issue, run_id }` in the service log;
  not the `rerun_workflow` action kind, whose once-a-day rule is for
  standing agents) before verify. The re-run's result is read as AC-2 says;
  a second `bricked` result counts as AC-5 says. `schemas/scheduler/blocked.json`
  gains the `board` condition (`{ kind: "board", main_sha }`).
- AC-7. **The maintainer is told, once per change, with the steps.** Given
  `board.json` changes to `bricked` or `absent`, then the scheduler sends one
  message over the Telegram channel of spec 007 (`sendReply` with no reply
  target) when the channel is configured, and in every case writes the same
  text to the service log as `{ kind: "board-alert", status, text }` and
  records one `maintainer.contact` event `{ channel, label: "board-<status>" }`.
  The text names the status, the `reason`, the PR (when there is one) and the
  check run's URL, the recovery steps of section 8 (for `absent`: connect the
  board's USB cable to the laptop), and ends: "When the board is back, run
  `panelator-scheduler board back` on the laptop. Firmware work waits until
  then; other work continues." Given the status is still `bricked` or
  `absent` 24 hours after the message, then one reminder with the same text
  is sent the same way, and no more. Given a further `bricked` or `absent`
  result while the status is already that, then nothing is sent.

**Beta and stable** (design section 5, product-spec 3)

- AC-8. **Published builds are recorded.** Given firmware on, then at most
  once every 600 seconds the tick lists the repository's releases with full
  pagination (process-spec 6.4) and records, for each release whose tag
  starts with `release_tag_prefix` and is not yet in
  `firmware/releases.json` in the state directory, an entry validating
  against `schemas/scheduler/firmware-release.json`: `{ tag, sha,
  published_at, channel: "beta" | "stable", hil: { conclusion, check_run_id,
  at } | null, soak: { started_at, results, last_at, resets, clean } | null,
  promoted_at, promoted_by: "scheduler" | "maintainer" | "superseded" |
  null, demoted_at, criteria }`, with `channel` from the prerelease flag
  (`true` is beta), `sha` the commit the tag points at (an annotated tag
  peeled), and one `firmware.published` event. A release whose `sha` is not
  an ancestor of `origin/main` in the scheduler's checkout is recorded with
  `hil: null`, is never promoted, and is named once in the service log as
  `{ kind: "firmware-release-off-main", tag }`. A release recorded as stable
  when first seen (published as stable by hand) is recorded, never edited.
- AC-9. **HIL results on the board are followed per build.** In the same
  step, for `origin/main`'s head and each beta release's `sha`, the tick
  lists the HIL check runs on that commit (all of them, not only the
  latest), reads each completed one not yet read, applies it to the board
  (AC-4), records the `hil.result` event, and appends to
  `firmware/hil-read.json` one entry for it, validating against
  `schemas/scheduler/firmware-release.json` `$defs/hil-read`: `{
  check_run_id, sha, kind, conclusion, completed_at, outcome, firmware_sha,
  resets }` (an invalid result is kept with `kind`, `outcome`,
  `firmware_sha` and `resets` null). The entry's id is what stops a result
  being applied to the board or recorded as an event twice; it does nothing
  else. A release's `hil` and `soak` are not set when a result is read:
  after reading, the step derives them for every beta release from all the
  entries of `hil-read.json`, so a result read before its release was
  recorded counts exactly as one read after it (the HIL run on a merge
  commit and the release workflow start together, and either may finish
  first). For a beta release, `hil` is the entry with `kind: "main"` on its
  own `sha` with the earliest `completed_at`; when it concluded `success`,
  `soak.started_at` is that `completed_at`. The entries completed after it
  (any `kind`) whose `firmware_sha` is the release's `sha` make `soak`:
  `results` counts them, `last_at` is the latest `completed_at`, `resets`
  is the latest one's `resets`, and `clean` is `false` when any of them has
  an `outcome` other than `pass`. Given `hil` concluded `failure`, then the
  release is never promoted (the failure on `main` is already spec 008's
  `ci_failure_main` event). A test publishes a release after its `main`
  HIL result has been read and asserts `hil` and `soak` are set from it.
  *(agent's call: derived, not accumulated, so the order of publication
  and result cannot lose a result; review of the first implementation.)*
- AC-10. **Promotion is automatic under these criteria, and only these.**
  Given `firmware.promotion_enabled` is true and a beta release for which
  all of the following hold at a tick, then the scheduler promotes it: it
  edits the release through the App to clear the prerelease flag, then
  writes `channel: "stable"`, `promoted_at` and `promoted_by: "scheduler"`,
  records one `firmware.promoted` event with the criteria as evaluated, and
  sends one Telegram message (as AC-7 sends, information only) naming the
  tag. The criteria, each written to `criteria` with its value at every
  evaluation:
  1. `hil_passed`: `hil.conclusion` is `success` (AC-9);
  2. `soaked`: `soak.last_at` is at least `firmware.soak_hours` after
     `soak.started_at`, and `soak.results` is at least 2;
  3. `soak_clean`: `soak.clean` is true and `soak.resets` is 0 (section 8:
     unexpected resets since the image was flashed);
  4. `board_ok`: `board.json` is `ok`, and no `board.changed` event away
     from `ok` was recorded since `soak.started_at`;
  5. `latest`: no other beta release with `hil.conclusion: success` has a
     `sha` that descends from this one's on `main`;
  6. `not_demoted`: `demoted_at` is null.

  Given a newer release is promoted, then every older beta release is
  recorded `promoted_by: "superseded"` with no release edit and is never
  promoted. Given any criterion false, then nothing is edited and the
  tick's service-log line carries `firmware: { stable: <tag|null>, next: {
  tag, waiting_on: [criterion names] } | null }`. Given
  `firmware.promotion_enabled` false, then the criteria are evaluated and
  logged, nothing is edited. At most one release is promoted per tick. A
  failed release edit is logged and tried again at the next tick; the record
  is written only after the edit succeeds. *(agent's call: the criteria;
  section 4 gives the reasons.)*

**The maintainer's view and commands**

- AC-11. **The tick shows the board.** Given firmware on, then each tick's
  service-log line carries `board: { status, since }` beside the `firmware`
  field of AC-10.
- AC-12. **The commands are action kinds.** `panelator-scheduler board`
  prints `board.json`, and `panelator-scheduler firmware` prints
  `releases.json` with each release's channel, HIL state, soak and criteria
  as last evaluated; neither writes anything. The commands that change state
  go through `applyAction` as level-1 kinds, each with an entry in
  `agents/actions.yaml` and a file under `src/actions/` registered in
  `KINDS`, each `check` returning `maintainer only` for any actor but the
  maintainer, `changesMode: false`, `undo: null`, and the `why` built by the
  command as the `cred` commands build theirs (spec 069 AC-10):
  - `board back` is `board_back` (`args: {}`): writes `ok` as AC-4 says;
    from `ok` or `unknown` it changes nothing and says so;
  - `board bricked <reason>` is `board_bricked` (`args: { reason }`): sets
    `bricked` by hand (the maintainer has unplugged the board, for
    instance), with AC-5 and AC-7 following as for a result;
  - `firmware promote <tag>` is `firmware_promote` (`args: { tag }`):
    promotes a recorded beta release as AC-10 does, whatever the criteria,
    with `promoted_by: "maintainer"` and the criteria recorded as evaluated;
  - `firmware demote <tag> <reason>` is `firmware_demote` (`args: { tag,
    reason }`): sets the prerelease flag back, writes `channel: "beta"` and
    `demoted_at`, records one `firmware.demoted` event; a demoted release is
    never promoted again by AC-10.

  A test asserts one action-log row per command with `agent: maintainer`
  and the args above, and that `board` and `firmware` added none.

## 4. Design notes (agent's calls)

- **The channel is the release's prerelease flag.** Product-spec 3 and
  R3.Q11 want stable and beta channels and signed builds; the backend that
  serves OTA does not exist. A GitHub Release per build, tagged
  `firmware-v<version>`, prerelease while beta, is a channel store that
  exists today, is readable by the backend later with one API call, and is
  reversible (demotion is the flag back). A manifest file in the repository
  would make each promotion a PR and each demotion a revert, the wrong
  weight for an operational, reversible action (design section 6.2, level
  1).
- **The soak device is the test board.** The board keeps running the last
  firmware flashed from `main`, and the HIL workflow's scheduled soak runs
  (section 8) read its uptime, resets and heap over serial. A build that
  cannot stay up for `firmware.soak_hours` on the one board the system has
  is not promoted; one that can has met the only evidence available before
  there are users. Twelve hours is the minimum because a soak run comes at
  least every 12 hours, so `soaked` always rests on two results at least.
  `soak_hours` is `auto` so reflection can tune it as evidence grows.
- **The gate is the suite's whole outcome.** Which tests the HIL suite holds
  is the firmware's; a firmware PR passes on a green HIL check and promotion
  wants the same check green on `main`. Naming tests here would make this
  spec change with every test added.
- **A brick blocks; it is not a question.** Design section 5 says the system
  *tells* the maintainer and pauses firmware work until the maintainer
  confirms. Spec 060's block is exactly a pause without a question: no claim,
  no slot, the state kept, resumed by the loop when a condition holds, with
  nothing counted. A question would instead pause one issue, while a brick
  stops every firmware PR and may come from a soak run with no issue at all;
  and an answer of any text would resume the issue whether or not the board
  was back (spec 062 is about that weakness). One confirmation, the `board
  back` command, serves every case, and the maintainer is at the laptop
  anyway, since the board is attached there. The message goes over the
  Telegram channel directly because the `Notifier` still writes only the
  service log (spec 007 section 2); when spec 068's `TelegramNotifier` lands,
  moving the message onto it is a small follow-up.
- **A missing workflow blocks rather than lets firmware through.** With the
  gate on and no HIL workflow, the first firmware PR would otherwise wait
  six hours and reach the maintainer as a check that never reported. The
  block of AC-3 says what is missing, files the finding that gets the
  workflow built, and resumes by itself when it lands (ADR 0013).
- **The re-run after a brick is the chain's step.** The `rerun_workflow`
  kind limits a standing agent to one re-run a day per run; the chain
  re-runs the HIL run of its own PR once per confirmation, bounded by
  `bounds.board_bricks`, as it already re-requests its own failed checks
  (spec 060 AC-3) without an action-log row.

## 5. Interfaces and files

This list is the implementation's file scope: the plan's tasks name these
files (a whole directory, written with a trailing slash, where the list
gives one) and no other.

- **The scheduler, under `tools/scheduler/src/`.** `firmware/`, a new
  directory named whole, holding at least: `board.ts` (`board.json`, AC-4;
  the board message and reminder, AC-7; the recovery steps text of section
  8), `hil.ts` (reading HIL check runs and their output, validation, the
  `hil.result` event, the fix lines of AC-2), `releases.ts`
  (`releases.json`, `hil-read.json`, the listing and the derivation of
  `hil` and `soak`, AC-8 and AC-9), `promote.ts` (the criteria, promotion
  and demotion, AC-10), `paths.ts` (the firmware PR match and the spec's
  interfaces match, AC-1 and AC-5); further modules the implementation
  splits out go in the same directory. `schema/validate.ts` (the three new
  schema names, `board-state`, `firmware-release` and `hil-result`, added
  to `SchemaName` and `NAMES`; the scheduler's one validator, not a second
  one under `firmware/`). `config.ts` (the `firmware` block and
  `bounds.board_bricks`); `chain/machine.ts`, `chain/driver.ts` and
  `chain/types.ts` (the HIL check in verify, the blocks of AC-3 and AC-5,
  `board_bricks`, the terminal step at the bound, the re-run of AC-6);
  `state/blocked.ts`, `state/ledger.ts` and `state/paths.ts`;
  `shortlist/select.ts` (the skip of AC-5); `service/loop.ts` (the `board`
  condition of AC-6, the release step of a tick, the tick-line fields);
  `github/client.ts` and `github/types.ts` (list check runs by name on a
  commit with their output, list releases, resolve a tag, edit a release's
  prerelease flag); `events/kinds.ts` (`hil.result`, `board.changed`,
  `firmware.published`, `firmware.promoted`, `firmware.demoted`);
  `actions/index.ts` and four new kind files under `actions/`
  (`board-back.ts`, `board-bricked.ts`, `firmware-promote.ts`,
  `firmware-demote.ts`); `parameters/` if the new definitions need code.
  `tools/scheduler/bin/scheduler.ts` (`board`, `board back`, `board
  bricked`, `firmware`, `firmware promote`, `firmware demote`).
- **Agents and schemas.** `agents/scheduler.yaml` (the `firmware` block,
  `bounds.board_bricks`); `agents/parameters.yaml` (`firmware.soak_hours`,
  `firmware.promotion_enabled`); `agents/actions.yaml` (the four kinds);
  `schemas/scheduler/`: `board-state.json`, `firmware-release.json`,
  `hil-result.json` (section 8), `blocked.json` (the `board` condition),
  `claim.json` (the chain state's `board` condition, its `board_bricks`
  count and the HIL run to re-run, AC-5 and AC-6),
  `escalation-ledger.json` (`board_bricks`), `event.json` (the five kinds).
- **Other specs.** `specs/060-out-of-scope-check-failure-blocks-on-main/spec.md`
  carries the marks of this spec's PR; the implementation does not change it.
- **Tests, under `tools/scheduler/test/`.** A new `firmware.test.ts` (path
  matching, the board state and its one-way rule, the criteria table with
  each criterion false in turn, promotion, superseding, demotion, the
  off-main release, an invalid HIL result); `config.test.ts`,
  `chain.test.ts`, `driver.test.ts`, `shortlist.test.ts`, `loop.test.ts`,
  `actions.test.ts`, `parameters.test.ts`, `schema.test.ts`, the recorded
  runs of section 6 in `e2e.test.ts` with `helpers/e2e-routes.ts`, and a
  firmware fixture spec under `fixtures/`.
- **Documents.** `tools/README.md` (the commands and the `firmware` block);
  `dev-logs/` as a directory for the implementation's log.

No file outside `tools/scheduler/`, `agents/`, `schemas/scheduler/`,
`tools/README.md` and `dev-logs/` is changed by the implementation; nothing
under `.github/` is added or changed.

## 6. Verification

- `pnpm test` passes and `pnpm -F @panelator/scheduler typecheck` is clean,
  including recorded end-to-end runs (fake adapter, mocked GitHub) for:
  - no `firmware` block: every earlier recorded chain unchanged, the
    `firmware: off` line once (AC-1);
  - a firmware PR: verify waits for the HIL check and passes on `pass`; a
    `fail` result runs fix with the failed tests' lines; a non-firmware PR
    merges with no HIL check present (AC-2);
  - a firmware PR whose head has no HIL workflow: blocked with the finding,
    resumed when `main` gains the file (AC-3);
  - a `bricked` result on a PR: `board.json` bricked, one Telegram message
    and one service-log alert, the chain blocked without a slot, a second
    firmware issue skipped by the shortlist, a non-firmware issue merged
    meanwhile; `board back`: the board ok, the block resumed, the HIL run
    re-run, verify passing on `pass`; a second brick on the same PR at
    `bounds.board_bricks` 2: the terminal step (AC-4 to AC-7);
  - an `absent` result, then a soak result that sees the board: ok again
    without a command (AC-4);
  - a beta release appearing: recorded, its `main` HIL check read, the soak
    followed; the same with the `main` HIL check completed and read at an
    earlier tick than the release first listed: `hil` and `soak` the same; after `soak_hours`: promoted, the release edited once, the
    event and the message; each criterion false in turn: not promoted and
    `waiting_on` names it; a newer build supersedes an older;
    `promotion_enabled` false: evaluated, not edited (AC-8 to AC-10);
  - `firmware demote` after a promotion: the flag back, never promoted
    again; each command's action-log row (AC-12).
- The first real HIL run, the first beta record and the first promotion are
  written up in `dev-logs/` by the firmware work that brings the HIL
  workflow (ADR 0013); until then the implementation PR quotes a tick's
  service-log line with firmware on, nothing to list, and the board
  `unknown`.

## 7. Open decisions

None.

## 8. The HIL job contract (what the firmware's workflows implement)

> Amended by [106-firmware-project-and-hil](../106-firmware-project-and-hil/spec.md) section 4: one run at a time on the board is kept by the single labelled runner and the harness's lock with a concurrency group per pull request or commit, and an image that gives no banner while no last-good image is cached is `fail` when download mode still answers.

The scheduler reads one check run per HIL run, named `firmware.hil_check`
(default `hil`), posted by the workflow `.github/workflows/<firmware.hil_workflow>`
(default `hil.yml`) running on the laptop's self-hosted runner:

- **Triggers.** `pull_request` and `push` to `main`, both filtered to
  `firmware.paths`; `schedule` for soak runs, at least every 12 hours, which
  flash nothing and only read the board; and `workflow_dispatch`.
- **Concurrency.** One run at a time on the board (one workflow concurrency
  group), so a soak read and a flash never interleave.
- **The check run.** The job (named anything but the check's name) creates
  the check run on the commit under test with status `in_progress` when it
  starts, and completes it with conclusion `success` only for `outcome:
  pass`, `failure` otherwise, using the job's token with `checks: write`.
  Its `output.text` is one JSON object validating against
  `schemas/scheduler/hil-result.json`: `{ outcome: "pass" | "fail" |
  "bricked" | "absent", kind: "pr" | "main" | "soak", sha, run_id, board: {
  status: "ok" | "bricked" | "absent", firmware_sha, uptime_s, resets,
  free_heap, free_psram }, tests: [{ name, status: "pass" | "fail" | "skip",
  duration_ms, message? }], reason?, log }`, where `run_id` is the workflow
  run's id, `firmware_sha` the commit whose build is on the board after the
  run, `resets` the count of unexpected resets since that image was flashed,
  and `log` the tail of the serial log, at most 32 KB so the whole object
  stays within the check output's limit.
- **What the outcomes mean.** `pass`: the suite passed on a board that
  boots. `fail`: a test failed on a board that boots. `absent`: no board was
  found on the runner at the start; nothing was flashed. `bricked`: after
  flashing, the board gave no boot banner within the job's timeout, and the
  job's own restore of the last-good image over USB, which it attempts
  before declaring anything, also failed, or download mode could not be
  entered.
- **The recovery steps** quoted in AC-7, kept in
  `tools/scheduler/src/firmware/board.ts` until the firmware work replaces
  them with the project's own: unplug and replug the board's USB cable;
  hold BOOT while pressing RESET to enter download mode; run the restore
  command the firmware work provides, which flashes the last-good image
  from the runner's cache; wait for the boot banner on the serial console;
  then run `panelator-scheduler board back`.
- **The release workflow.** A build merged to `main` is built, signed and
  published as a GitHub Release with tag `<release_tag_prefix><version>`
  pointing at the merged commit, marked prerelease. Nothing but AC-10 and
  the maintainer's commands of AC-12 clears or sets the flag afterwards.
