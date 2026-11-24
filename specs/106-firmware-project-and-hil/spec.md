# 106. Firmware: an ESP-IDF project that builds in CI and boots, with the HIL workflow that tests it on the board

Status: written 2026-11-22 for issue #428, the planned child
`firmware-project-and-hil` of the v0 build design; a spec derived from its
parent design needs no maintainer approval (delivery-system design section
11). Amends [070-test-board](../070-test-board/spec.md) section 8 (the
concurrency group, and the outcome of a non-booting image when no last-good
image is cached), marked there as section 4 of this spec records.
*(agent's call)* Section 6 records the maintainer's answer to question
#7079534758: the runner, the board and its port, the approval setting.
Class: product. Domain: firmware (sensitive paths: `.github/workflows/ci.yml`
and `.github/workflows/hil.yml`, under `.github/`; process-spec section 5).
Parent: docs/designs/product-v0-build.md
Derives from: [v0 build design](../../docs/designs/product-v0-build.md)
sections 3 and 4 ("Firmware is tested on the board", "Checks arrive with the
layer", "Credentials, the board and outside parties") and its planned child
`firmware-project-and-hil`; [product spec](../../docs/product-spec.md)
sections 2 (the ESP32-S3-N16R8), 3 (native ESP-IDF, pinned version, built in
the official container), 12 (milestone 1) and 13 (the HIL rig; clang-format,
clang-tidy, host-side unit tests); [design-tree](../../docs/design-tree.md)
R2.Q8 (runtime spike first), R5.Q5 (HIL on the existing self-hosted runner);
[spec 070](../070-test-board/spec.md) section 8 (the HIL job contract) and
[ADR 0013](../../docs/decisions/0013-test-board-gate-before-firmware.md) (the
HIL workflow is the firmware's own);
[ADR 0016](../../docs/decisions/0016-product-breakdown-is-one-ordered-design.md);
[delivery-system design](../../docs/delivery-system-design.md) section 3
item 3 (attaching and recovering the board are the maintainer's) and section
5 (firmware and the test board).

## 1. Goal

`firmware/` holds only `.gitkeep`. After this spec it holds an ESP-IDF
project for the ESP32-S3-N16R8 that builds reproducibly in the official
container at one pinned version, is formatted, linted and unit-tested on the
host in CI, and does one thing on the board: boot, print a banner naming the
commit it was built from, and report its health once every few seconds.

The same PR brings the firmware's own verification on real hardware (ADR
0013): `.github/workflows/hil.yml` and a serial harness, `tools/hil/`, that
meet spec 070 section 8. Every firmware PR and every firmware push to `main`
is built, flashed onto the test board attached to the laptop's self-hosted
runner and checked there; a scheduled soak run reads the board without
flashing; each run posts the `hil` check run carrying one `hil-result.json`;
a board left without a booting image is restored to the last-good image
before anything is declared. The first suite is one test: flash, see the
banner. Every later firmware child adds its tests to that suite.

## 2. Out of scope

- **The panel, WASM, WiFi, the relay, provisioning, OTA.** No HUB75 driver,
  board definition or task layout (`firmware-panel-driver`), no partition
  table of the product's (two app slots and LittleFS arrive with the children
  that need them; this spec uses ESP-IDF's default single-app table), no
  signing.
- **The release workflow** of spec 070 section 8 (build, sign, publish a
  prerelease): `rest-of-v0`, with OTA. Nothing here creates a tag or a
  release.
- **The scheduler's side of the gate** (spec 070 AC-1 to AC-12). Spec 070's
  implementation is not on `main` (issue #132), so today the scheduler does
  not read the `hil` check; this spec changes nothing under
  `tools/scheduler/` or `agents/`, and `required_checks` stays `[test]`. The
  workflow meets the contract so that the gate works from the day it lands.
  The recovery steps text of `tools/scheduler/src/firmware/board.ts` does not
  exist yet; this spec provides the restore command it will quote (AC-13).
- **The product's end-to-end test** (provision, claim, push a screen, see the
  frame): `hil-provision-claim-push`. Frame-rate and boot-time tests:
  `firmware-panel-driver`.
- **clang-tidy over code that includes ESP-IDF headers** (section 5, "What
  clang-tidy covers").
- Registering the runner, attaching the board and recovering it by hand: the
  maintainer's (section 6).
- **The firmware implementation profile.** `agents/profiles/` has no
  `firmware` directory, so a plan whose domain is `firmware` stops with
  `profile not available` (`agents/stages/plan.md`). Adding the profile is
  delivery-system work under `agents/`, tracked by issue #459; this spec's
  implementation starts once it exists and changes nothing under `agents/`.
- Any change to the sensitive-path list, the security review criteria or
  what routes a diff to the security review.

## 3. Acceptance criteria

Definitions. *The image file* is `firmware/idf-image.txt`. *The commit under
test* is the PR's head commit on `pull_request`, the pushed commit on `push`,
and the dispatched ref's head on a flashing `workflow_dispatch`. *The cache*
is the directory `$PANELATOR_HIL_CACHE`, default `~/.cache/panelator-hil`, on
the runner. *The harness* is the package `@panelator/hil` in `tools/hil/`.
Harness criteria are tested in vitest with a fake flasher, a fake serial
source, a fake clock and a fake GitHub; none of them needs a board.

**The project**

- AC-1. **One pinned ESP-IDF, in the official container.** The image file
  holds one line, `espressif/idf:v5.5.6@sha256:<64 hex>`: ESP-IDF v5.5.6
  (section 5, "ESP-IDF v5.5.6"), pinned by tag and by the digest Docker Hub
  gives that tag when the implementation is written. Given a checkout and
  Docker, when `firmware/scripts/build.sh` runs, then it builds the project
  with `idf.py build` inside exactly that image (the repository mounted, the
  build run as the calling user so no root-owned files are left) and leaves
  in `firmware/build/` the application `panelator.bin`, the bootloader, the
  partition table and `flasher_args.json`. The script is the only way the
  workflows build firmware; no workflow file and no other script contains the
  text `espressif/idf` (a vitest test reads `.github/workflows/` and
  `firmware/scripts/` and asserts it, and asserts the image file's format).
  `sdkconfig.defaults` sets the target `esp32s3`, 16 MB flash and octal PSRAM
  enabled with a missing PSRAM being a boot failure; `sdkconfig` and `build/`
  are git-ignored. The project's own code compiles with warnings as errors.
- AC-2. **The image knows its commit.** Given `PANELATOR_COMMIT` is set to 40
  hex digits when the build is configured, then the image carries that value;
  given it is unset, the build uses `git rev-parse HEAD`, with `-dirty`
  appended when the work tree differs from it; given neither is available,
  configuration fails with a message naming `PANELATOR_COMMIT`. `build.sh`
  passes its `PANELATOR_COMMIT` through, and the workflows always set it to
  the commit under test.
- AC-3. **The boot banner.** Given the image flashed on the board, when the
  board resets, then it prints on its console, once per boot and before any
  status line, exactly one line
  `panelator boot sha=<commit> idf=<IDF version> flash_mb=<n> psram_mb=<n> reset=<reason>`,
  where `<commit>` is AC-2's value, `flash_mb` and `psram_mb` are the sizes
  the chip reports at run time, and `<reason>` is a lower-case name for
  `esp_reset_reason()` (`poweron`, `ext`, `sw`, `panic`, `int_wdt`,
  `task_wdt`, `wdt`, `deepsleep`, `brownout`, `sdio`, `usb`, `jtag`,
  `unknown`). The console is UART0 with the USB Serial/JTAG port as secondary
  output, so the line appears on whichever of the devkit's two USB ports is
  connected; the firmware reads no console input.
- AC-4. **The status line and the reset count.** Given the image running,
  then every 5 seconds it prints one line
  `panelator status sha=<commit> uptime_s=<n> resets=<n> free_heap=<bytes> free_psram=<bytes>`.
  `resets` is the number of unexpected resets since this image was flashed,
  kept in NVS (namespace `diag`, keys `sha` and `resets`): at boot, given the
  stored `sha` differs from the image's commit or is missing, then `sha` is
  written and `resets` set to 0; otherwise, given the reset reason is one of
  `panic`, `int_wdt`, `task_wdt`, `wdt`, `brownout` or `unknown`, then
  `resets` is increased by one; any other reason leaves it. Given NVS cannot
  be read or written, then the firmware still boots and prints `resets=-1`.
  The rule (stored sha, stored count, image sha, reason → new sha, new count)
  and the text of both lines are pure functions in a component that includes
  no ESP-IDF header.

**Checks in CI** (product spec 13; the design's "Checks arrive with the layer")

- AC-5. **Host-side unit tests.** `firmware/test/host/` is a plain CMake
  project that compiles the firmware's portable components (those that
  include no ESP-IDF header) with the host compiler, `-Wall -Wextra -Werror`
  and the address and undefined-behaviour sanitizers, and runs their tests
  under `ctest` with Unity, vendored at a pinned release with its licence
  under `firmware/test/host/third_party/unity/`. The first tests cover AC-3's
  and AC-4's line text for fixed inputs (the exact strings; a commit of
  maximal length and extreme counters never write past the buffer) and AC-4's
  rule as a table with every reset reason.
- AC-6. **clang-format and clang-tidy.** `firmware/.clang-format` and
  `firmware/.clang-tidy` (with `WarningsAsErrors: '*'`) are committed. Given
  `firmware/scripts/check-host.sh` runs where `cmake`, a C compiler,
  `clang-format-18` and `clang-tidy-18` exist, then it fails when
  `clang-format-18 --dry-run --Werror` reports any `.c` or `.h` file under
  `firmware/` outside `build/` and `third_party/`, when the host project of
  AC-5 does not build, when `clang-tidy-18`, run with the host project's
  compile database over every source of the portable components and their
  tests, reports anything, or when `ctest` fails; otherwise it exits 0.
- AC-7. **The required check covers the firmware.** `.github/workflows/ci.yml`'s
  `test` job, pinned to `ubuntu-24.04`, gains steps that install the two
  clang tools when missing, run `firmware/scripts/check-host.sh` on every
  run, and run `firmware/scripts/build.sh` with `PANELATOR_COMMIT` set on
  every push to `main` and on every pull request whose changed files include
  a path under `firmware/` or `.github/workflows/`. A failure of any of them
  fails `test`. The job's name, its existing steps and
  `agents/scheduler.yaml`'s `required_checks` are unchanged, so `pnpm test`
  is not weakened and a PR open when this merges needs no new check. The
  harness's vitest tests and the static tests of AC-1 and AC-8 run in
  `pnpm test`.

**The HIL workflow** (spec 070 section 8)

- AC-8. **The workflow file.** `.github/workflows/hil.yml` exists with:
  triggers `pull_request` and `push` to `main`, both with `paths` holding
  `firmware/**` (spec 070's `firmware.paths` default) and, beyond the
  contract, `tools/hil/**` and the workflow file itself; `schedule` every six
  hours (`17 */6 * * *`), a soak run; and `workflow_dispatch` with a boolean
  input `soak` (false: a flashing run of the dispatched ref). Two jobs,
  neither named `hil`: `build` (on `ubuntu-24.04`; skipped for a soak run;
  checks out the commit under test, runs `build.sh` with `PANELATOR_COMMIT`,
  uploads `firmware/build/`'s flash files and `flasher_args.json` as the
  artifact `firmware-<sha>`) and `board` (`runs-on: [self-hosted, panelator-hil]`,
  `needs: build`, `if: always()` joined with the fork rule below,
  `timeout-minutes: 20`, permissions `checks: write`, `contents: read`,
  `actions: read` and no other). Given a pull request whose head repository
  is not this repository, then `board` does not run: nothing from a fork
  executes on the laptop and no `hil` check is posted for it. Top-level
  `concurrency` is `group: hil-${{ github.event_name }}-${{ github.event.pull_request.number || github.sha }}`
  with `cancel-in-progress: false` (section 4). A vitest test parses the file
  and asserts each fact of this criterion.
- AC-9. **One run at a time on the board.** The `board` job runs only on the
  runner labelled `panelator-hil`, of which there is one, and a runner runs
  one job at a time; in addition the harness holds an exclusive lock on
  `<cache>/board.lock` from before it first touches the port until it has
  written its result, waiting for the lock up to 15 minutes. Given the lock
  is not obtained in that time, then the run ends `fail` with the test
  `board-lock` failed and nothing flashed. So a soak read and a flash never
  interleave, and no queued run is cancelled to achieve it.
- AC-10. **The check run and `hil-result.json`.** Given a `board` job starts,
  then its first harness step creates a check run named `hil` (the
  `--check-name` argument, default `hil`) with status `in_progress` on the
  commit under test (for a soak run, the workflow's `github.sha`, `main`'s
  head), using the job's token. Given the harness finishes, then it writes
  `hil-result.json`, one object validating against
  `schemas/scheduler/hil-result.json`: `{ outcome, kind, sha, run_id, board:
  { status, firmware_sha, uptime_s, resets, free_heap, free_psram }, tests: [{
  name, status, duration_ms, message? }], reason?, log }` with the values and
  meanings of spec 070 section 8 (`kind` is `pr` for `pull_request` and for a
  dispatch of a ref other than `main`, `main` for `push` and a dispatch of
  `main`, `soak` for `schedule` and a dispatch with `soak`; `sha` the commit
  the check is on; `run_id` the workflow run's id; `log` the tail of
  everything read from the serial port and of the flasher's output, cut to at
  most 32 KB at a line boundary); completes the check run with conclusion
  `success` only when `outcome` is `pass`, `failure` otherwise, its
  `output.text` being exactly that JSON, `output.title` `hil: <outcome>` and
  `output.summary` one line per test; and the workflow uploads the file as
  the artifact `hil-result`. This spec adds the schema file, written from
  section 8 with `additionalProperties: false`, since spec 070's
  implementation has not; a board field the run could not read is `null`,
  which the schema allows for the five fields after `status`. Given spec
  070's implementation (issue #132) has reached `main` first and the file
  exists, then the harness validates against that file, and the only change
  this spec's implementation may make to it is allowing `null` for those
  five fields if it does not already. The harness's
  exit code is 0 for `pass` and 1 otherwise, after the check run is
  completed.
- AC-11. **The check is always completed.** Given the `build` job failed or
  was cancelled, then `board` still runs, flashes nothing, reads the board as
  a soak run does (AC-15) and posts `outcome: fail` with one test `build`
  failed, its message naming the run's URL. Given the harness throws at any
  point after creating the check run, then it completes the check run with
  `outcome: fail`, one test `harness` failed with the error's message, and
  the board fields it has read so far; a last workflow step with
  `if: always()` does the same through the harness's `complete-failed`
  command when no `hil-result.json` was written. Only a runner that is
  offline or a cancelled job leaves a commit without a completed `hil` check,
  which is spec 070 AC-2's "never reported" case.
- AC-12. **A flashing run, and what each outcome means.** Given a run of kind
  `pr` or `main`, the harness, in order:
  1. finds the board's port (AC-14). Given none, then `outcome: absent`,
     `board.status: absent`, nothing flashed, `reason` saying what was looked
     for.
  2. enters download mode (the flasher's chip query). Given it fails twice,
     then `outcome: bricked`, `board.status: bricked`, `reason: download mode
     could not be entered`.
  3. flashes the artifact with the offsets and flash arguments of its
     `flasher_args.json`, resets the board, and runs the suite (AC-16).
  4. Given the suite's `boot-banner` test saw no banner within its timeout,
     then the restore of AC-13 is attempted before anything is declared:
     given a last-good image exists and the board prints its banner after it
     is flashed, then `outcome: fail`, `board.status: ok`, `firmware_sha` the
     last-good commit, and `boot-banner`'s message says the image under test
     did not boot and which commit was restored; given the restore's flash
     fails or the last-good image prints no banner either, then `outcome:
     bricked`; given no last-good image exists, then download mode is queried
     again: answering, `outcome: fail`, `board.status: ok`, `firmware_sha`
     the commit under test, the message saying no last-good image exists yet;
     not answering, `outcome: bricked` (section 4).
  5. Given the board booted: `outcome` is `pass` when every test passed or
     was skipped, `fail` otherwise, and `board` holds the values of the last
     status line read.
  6. Given a `main` run that passed, then the flashed files, their
     `flasher_args.json` and the commit are stored as the last-good image
     (written to a new directory, then renamed over `<cache>/last-good/`).
     Given a `pr` run, or a `main` run that failed, on a board that booted,
     and a last-good image exists, then the last-good image is flashed back
     and its banner awaited, so that between runs the board runs `main`'s
     last passing image and soak runs measure that; `board.firmware_sha`,
     `uptime_s` and the rest are read after it. Given that flash-back gives
     no banner, then the outcome is `bricked`.
- AC-13. **The restore command.** `pnpm -F @panelator/hil run restore` (the
  command the recovery steps of spec 070 section 8 call "the restore command
  the firmware work provides") finds the port, flashes `<cache>/last-good/`,
  waits for the banner, prints the banner's commit and exits 0; given no
  last-good image, no port, a failed flash or no banner, it exits 1 with one
  line saying which. The harness's own restore in AC-12 is the same function.
- AC-14. **Finding the board.** Given `PANELATOR_HIL_PORT` is set, then that
  path is the port, and absent when it does not exist. Otherwise the port is
  the one entry of `/dev/serial/by-id/` whose name starts with one of the
  configured prefixes (default `usb-Espressif_`, `usb-Silicon_Labs_CP21`,
  `usb-1a86_`, the devkit's native port and its two usual UART bridges);
  given no entry, then absent; given more than one, then absent with a
  `reason` listing them and naming `PANELATOR_HIL_PORT`. The laptop's other
  serial devices (its LTE modem is `usb-FIBOCOM_…`) are never touched.
- AC-15. **A soak run flashes nothing and resets nothing.** Given a run of
  kind `soak`, then the harness finds the port (absent as in AC-12), opens it
  without asserting the lines that reset the board, and reads until a status
  line arrives or 20 seconds pass. Given a status line, then `outcome: pass`,
  `board.status: ok`, the board fields from the line and one test
  `status-line` passed. Given none, then `outcome: fail`, `board.status: ok`,
  the other board fields `null`, and `status-line` failed; a soak run never
  declares `bricked` and never enters download mode. A harness test asserts
  that the fake flasher was not called at all in a soak run.
- AC-16. **The suite, and its first test.** The suite is a list of tests in
  `tools/hil/src/suite/`, one module per test, each `{ name, run(board) }`
  where `board` gives the lines read so far, `waitForLine(pattern, timeout)`
  and the commit under test; a test returns pass, fail with a message, or
  skip, and its duration is measured by the harness. A test that throws is a
  failed test, not a failed harness. The first suite holds one test,
  `boot-banner`: after the flash and reset, a banner line (AC-3) arrives
  within 30 seconds whose `sha` equals the commit under test, with `flash_mb`
  16 and `psram_mb` 8, followed within 10 seconds by a status line (AC-4)
  with the same `sha`; any difference fails the test with the line seen. The
  expected sizes are the suite's configuration (`tools/hil/board.json`), not
  constants in the test (product spec 2).
- AC-17. **The tools come from the pinned image.** The real flasher and the
  real serial source run `esptool` and a serial reader of pyserial from the
  image of the image file, with `docker run --rm --device <port>`; the
  harness opens no device node itself and has no native dependency. So the
  runner needs Docker, Node and nothing else, and its user needs no group on
  the serial device. Both are behind the two interfaces the tests fake.

**The record**

- AC-18. **Documents.** `firmware/README.md` says how to build
  (`build.sh`), run the host checks, read the banner and status line, what
  the HIL workflow does on a PR, on `main` and on its schedule, where the
  last-good image lives, how to run the restore by hand, and what the runner
  needs (section 6). `tools/README.md` gains the harness's commands. The
  implementation's dev-log in `dev-logs/` records, with the check runs' URLs
  and the `hil-result.json` of each: the first real HIL run on the
  implementation PR's head, and, taken on the board from a dispatched run of
  the PR's branch, a `boot-banner` pass; it says which of the devkit's USB
  ports the board is attached by. Given the `hil` check did not report on
  the PR's head within 30 minutes of the push, the dev-log and the PR
  description say so and name the run, and do not claim a board result.

## 4. Amendments to spec 070 section 8 *(agent's calls)*

Section 8 lets the firmware's specs tighten its contract, not loosen it. Two
points of it cannot be built as written; both are marked on section 8.

- **The concurrency group.** Section 8 asks for "one workflow concurrency
  group" so that a soak read and a flash never interleave. A GitHub
  concurrency group keeps one run and one pending run: a third run entering
  the group cancels the pending one. With one group for the board, a firmware
  PR's queued HIL run would be cancelled by a push to another PR or by the
  schedule, its `hil` check would never report, and spec 070 AC-2 would hold
  that PR for six hours and then tell the maintainer. The purpose is kept by
  other means (AC-9): the one runner that carries the label runs one job at
  a time and queues the rest without cancelling, and the harness's lock
  covers the case of a second runner. The workflow's group is per pull
  request, or per commit for the other events (AC-8), so that only a
  superseded head of the same PR, which no one waits for, loses its queued
  run; `cancel-in-progress` is false so a flash is never interrupted.
- **A non-booting image when no last-good image exists.** Section 8 declares
  `bricked` when the image under test gives no banner and the restore of the
  last-good image failed. Before the first passing `main` run there is no
  last-good image, so nothing can be restored; read literally, the first
  faulty image of the first firmware PR would be a brick, the maintainer
  would be asked for a physical recovery whose one step is flashing an image
  that does not exist, and all firmware work would pause. A board whose
  download mode answers is not bricked: the next run flashes it. AC-12
  therefore reports `fail` in exactly that case, which sends the PR to the
  fix stage under the existing fix bound, and `bricked` whenever download
  mode does not answer or an existing last-good image fails to boot.

The fork rule of AC-8, the six-hour schedule, the extra trigger paths and
the always-completed check of AC-11 tighten the contract and need no mark.

## 5. Design notes (agent's calls)

- **ESP-IDF v5.5.6.** Docker Hub's `espressif/idf` carried, on 2026-11-22,
  v5.5.6 (October 2026) as the newest release of the v5 line and v6.1.1 as
  the newest of v6. The pin is v5.5.6: the HUB75 DMA library and WAMR that
  milestone 1 needs next are known to build against v5, v6 removed legacy
  driver APIs and nothing here has shown those two libraries building on it,
  and v5.5 is the last v5 minor, still receiving patch releases. The digest
  beside the tag makes the container the same bytes on CI, on the runner and
  on a developer's machine. A move to v6 is a one-line PR that CI builds and
  the HIL run tests, made by the child that needs something v6 has or once
  the two libraries are seen to build on it; with only a banner in the image
  it costs nothing to reverse.
- **The harness is a Node package.** AGENTS.md makes `tools/<name>/` a
  TypeScript workspace package tested by vitest, which puts the harness's
  logic (outcomes, restore, the result's shape) under `pnpm test`, the
  required check, with fakes. The two things that touch hardware are small
  and injected, and run from the pinned image (AC-17), so the runner has no
  toolchain of its own to drift.
- **No console input.** The health values arrive as a periodic line instead
  of a command's reply, so the harness works over either USB port, a soak
  read is passive, and the firmware has no command parser to secure.
- **What clang-tidy covers.** clang-tidy needs a clang compile database;
  ESP-IDF builds with GCC and the official container carries no clang
  toolchain. Logic therefore lives in portable components that compile on
  the host, where clang-tidy and the sanitizers see all of it, and the code
  that includes ESP-IDF headers (`main/` and thin glue) stays small and is
  held by `-Werror`, clang-format and the board. A later child that finds the
  glue growing adds `idf.py clang-check` in the same script.
- **The firmware checks sit in the `test` job.** The scheduler requires the
  check `test` (design section 4). A second required check would have to be
  added to `agents/scheduler.yaml`, and every PR already open would lack it
  and wait out the six-hour rule. Steps in the job that is already required
  cost nothing on a PR that leaves `firmware/` alone except the host checks,
  which take seconds.
- **`reset` reasons that count.** A reset the harness causes (`poweron`,
  `ext`, `usb`, `jtag`) or the firmware asks for (`sw`) is expected; the ones
  counted are those the firmware did not choose.
- **The board runs `main` between runs.** Spec 070 section 4 soaks the last
  firmware flashed from `main`. A PR's run would otherwise leave the PR's
  image on the board until the next push to `main`, and soak results would
  describe unmerged code; AC-12 step 6 puts `main`'s image back.

## 6. What the runner and the board need (the maintainer's)

The harness and the workflow assume the following, which only the maintainer
can provide (delivery-system design section 3 item 3) and which was asked as
a capability question from this spec's issue:

- a GitHub Actions self-hosted runner on the laptop registered for the
  `panelator` repository, carrying the label `panelator-hil`, running as a
  user that can run `docker`;
- the test board, an ESP32-S3-N16R8 devkit, attached to the laptop by one of
  its USB ports and left attached;
- on a public repository, the Actions setting that holds workflows from
  outside contributors for approval, beside AC-8's fork rule.

The maintainer did all three on 2026-11-22 (maintainer answer, question
#7079534758):

- **The runner** is `adam-t480-hil`, registered for
  `adam26davidson/panelator` in its own directory
  `~/actions-runner-panelator`, beside `~/actions-runner`, which stays on
  `char-matrix-dashboard`. Its labels are `self-hosted`, `panelator-hil`,
  `Linux` and `X64`. It runs as the user systemd service
  `panelator-hil-runner.service` as `adamd`, who is in the `docker` group
  and in the `uucp` group, which owns the serial device, and it is online.
- **The board** is an ESP32-S3-N16R8 devkit attached on its UART bridge
  port (labelled TTL on the board, a CH34x bridge), not on native USB. Its
  port is `/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0` (`/dev/ttyUSB0`),
  the only `usb-1a86_` entry; the LTE modem (`usb-FIBOCOM_…`) is the only
  other serial device. A reset over the port shows the ROM banner
  `ESP-ROM:esp32s3-20210327`. The board runs older firmware that is not
  panelator's, which the HIL flash may overwrite.
- **The approval setting.** The repository is public, and its fork pull
  request approval policy is `all_external_contributors`: every workflow
  run from an outside contributor waits for approval.

What follows from the answer for the criteria above *(agent's call)*:

- AC-8's `runs-on: [self-hosted, panelator-hil]` names two of that runner's
  labels and no other runner carries the second, so AC-9 holds as written.
- AC-14 finds the board with its default prefixes (`usb-1a86_` matches one
  entry) and `PANELATOR_HIL_PORT` stays unset on the runner. The harness
  reaches the board through the bridge only: reset and download mode are
  the bridge's DTR and RTS lines, driven by `esptool`, and the banner and
  status lines arrive on UART0, the primary console of AC-3. Nothing in the
  harness or the suite may need the native USB port.
- AC-15's soak read must leave DTR and RTS unasserted when it opens the
  port, since on this bridge asserting them resets the board.
- Until the first flashing run, the board holds the older firmware and
  prints no status line, so a soak run before then is `fail` (AC-15), never
  `bricked`. The first run of the implementation PR overwrites that
  firmware; no last-good image exists until the first `main` run passes,
  which is the case AC-12 step 4 and section 4 cover.

## 7. Interfaces and files

The implementation's file scope:

- `firmware/` whole: `CMakeLists.txt`, `sdkconfig.defaults`, `.gitignore`,
  `idf-image.txt`, `.clang-format`, `.clang-tidy`, `README.md`,
  `main/` (`app_main`, the NVS glue, the status task), `components/` (the
  portable component with the line text and the reset rule),
  `scripts/build.sh`, `scripts/check-host.sh`, `test/host/` (CMake project,
  tests, `third_party/unity/`). `firmware/.gitkeep` is removed.
- `tools/hil/` whole, the package `@panelator/hil`: `package.json` (scripts
  `hil`, `restore`, `typecheck`), `tsconfig.json`, `board.json` (expected
  flash and PSRAM sizes, port prefixes, timeouts), `src/` (`cli.ts`;
  `run.ts`, the sequence of AC-12 and AC-15; `result.ts`, the result and its
  log cut; `check.ts`, the check run over the REST API with `fetch`;
  `port.ts`; `lock.ts`; `last-good.ts`; `flasher.ts` and `serial.ts`, the
  interfaces and their Docker implementations; `lines.ts`, the banner and
  status parsers; `suite/index.ts`, `suite/boot-banner.ts`), `test/`
  (one file per criterion group, the fakes, and `workflows.test.ts` for
  AC-1, AC-7 and AC-8).
- `schemas/scheduler/hil-result.json` (new; spec 070 section 8's shape).
- `.github/workflows/hil.yml` (new) and `.github/workflows/ci.yml` (the
  `test` job's `runs-on` and the firmware steps). Both are sensitive paths:
  the security review checks that no gate or step of `test` is removed or
  weakened and that the `board` job's permissions are those of AC-8.
- `pnpm-lock.yaml` (the new package's entries); `tools/README.md`;
  `dev-logs/` (the implementation's log).

Interfaces other work builds on: the two serial lines of AC-3 and AC-4 (a
later child may add fields at the end of the status line, never reorder or
remove); `tools/hil/src/suite/` (one module per test); `build.sh` and the
image file (every firmware build); `<cache>/last-good/` and the `restore`
command (spec 070's recovery steps); `hil-result.json` (spec 070 AC-2, AC-9).

## 8. Verification

- `pnpm test` passes, including the harness's tests with fakes for: each
  outcome of AC-12 (absent; download mode failing twice; pass with last-good
  written on `main` only; a failed test; no banner with a restore that
  boots, with a restore that does not, and with no last-good image and
  download mode answering or not; the flash-back after a `pr` run), the soak
  run of AC-15 with the flasher never called, the lock of AC-9, the port
  rules of AC-14, the build-failed and thrown-error results of AC-11, the
  check run's two requests and its conclusion for each outcome, every result
  validating against the schema with a log cut to 32 KB, the `restore`
  command's exits, and the static tests of the workflow files and the image
  file.
- CI's `test` job passes on the implementation PR with the host checks and
  the container build run (AC-7); the PR's description quotes the lines of
  the job's log that show `check-host.sh` and `build.sh` succeeding, and the
  output of `pnpm test`.
- On the board: the `hil` check on the implementation PR's head concludes
  `success` with `outcome: pass`, and the dev-log of AC-18 records it. This
  is the firmware's first real HIL run (spec 070 section 6). Until spec
  070's implementation is on `main` the scheduler does not wait for that
  check, so the implement stage reads it itself as AC-18 says.

## 9. Open decisions

None.
