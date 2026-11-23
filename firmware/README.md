# Firmware

The ESP-IDF project for the ESP32-S3-N16R8 (16 MB flash, 8 MB octal PSRAM), and the way it is built, checked and tested on the board (spec 106). Today the image only boots, prints a banner and reports its health.

## Build

`firmware/scripts/build.sh` is the only way firmware is built. It runs `idf.py reconfigure build` inside the container image of `firmware/idf-image.txt` (ESP-IDF v5.5.6, pinned by tag and digest), with the repository mounted and as the calling user. It needs Docker.

```sh
PANELATOR_COMMIT=$(git rev-parse HEAD) firmware/scripts/build.sh
```

`PANELATOR_COMMIT` (40 hex digits) is the commit the image carries. Unset, CMake asks `git rev-parse HEAD` and appends `-dirty` when the work tree differs; inside a git worktree whose `.git` lies outside the mounted tree, set it yourself. The result is in `firmware/build/`: `panelator.bin`, `bootloader/bootloader.bin`, `partition_table/partition-table.bin` and `flasher_args.json`. To change the ESP-IDF version, change the one line of `idf-image.txt` in its own PR.

## Host checks

`firmware/scripts/check-host.sh` needs `cmake`, a C compiler, `clang-format-18` and `clang-tidy-18`. It runs clang-format over every `.c` and `.h` (outside `build/` and `third_party/`), builds `test/host/` with `-Wall -Wextra -Werror` and the address and undefined-behaviour sanitizers, runs clang-tidy over the portable components and their tests, and runs `ctest` (Unity, vendored under `test/host/third_party/unity/`). Logic goes in components that include no ESP-IDF header (`components/panelator_core/`), where this covers it; `main/` stays thin glue.

## What the board prints

Once per boot, before any status line:

```
panelator boot sha=<commit> idf=<IDF version> flash_mb=<n> psram_mb=<n> reset=<reason>
```

then every 5 seconds:

```
panelator status sha=<commit> uptime_s=<n> resets=<n> free_heap=<bytes> free_psram=<bytes>
```

`reset` is `poweron`, `ext`, `sw`, `panic`, `int_wdt`, `task_wdt`, `wdt`, `deepsleep`, `brownout`, `sdio`, `usb`, `jtag` or `unknown`. `resets` counts the unexpected resets (`panic`, `int_wdt`, `task_wdt`, `wdt`, `brownout`, `unknown`) since this image was flashed, kept in NVS (`diag`/`sha`, `diag`/`resets`); it is `-1` when NVS fails. The console is UART0 with USB Serial/JTAG as secondary output; the firmware reads no console input. Later work may add fields at the end of the status line, never reorder or remove one.

## The HIL workflow

`.github/workflows/hil.yml` tests the image on the board attached to the laptop's self-hosted runner. Its `build` job builds with `build.sh`; its `board` job runs the harness of `tools/hil/` and posts the check run `hil` with one `hil-result.json` (uploaded as the artifact `hil-result`).

- **On a pull request** that touches `firmware/`, `tools/hil/` or the workflow, from this repository (a fork's run never reaches the laptop): the build is flashed, the board is reset and the suite runs (today one test, `boot-banner`: the banner with the commit under test, 16 MB flash and 8 MB PSRAM, then a status line). The last-good image is then flashed back, so between runs the board runs `main`'s last passing image.
- **On a push to `main`**: the same; a passing run stores the flashed image as the last-good image.
- **On a schedule** (every six hours, and by `workflow_dispatch` with `soak`): a soak run reads one status line from the board without flashing, resetting or touching download mode.
- **`workflow_dispatch` without `soak`** flashes the dispatched ref like a pull request (like `main` when the ref is `main`).

Outcomes: `pass` (the suite passed on a board that boots), `fail` (a test failed, or the image did not boot and the last-good image was restored, or no last-good image exists yet and download mode still answers), `absent` (no board found; nothing flashed), `bricked` (download mode could not be entered, or the image did not boot and the restore did not either).

Runs go one at a time: the one runner labelled `panelator-hil` runs one job at a time, and the harness holds `<cache>/board.lock` while it touches the port.

## The last-good image and the restore

The last-good image is in `$PANELATOR_HIL_CACHE/last-good/` (default `~/.cache/panelator-hil/last-good/`): the flashed files, their `flasher_args.json` and `commit.txt`. To put it back on the board by hand:

```sh
pnpm -F @panelator/hil run restore
```

It finds the board, flashes the image, waits for the banner, prints the banner's commit and exits 0; otherwise it prints one line saying what failed and exits 1. The same function is the harness's own restore.

## What the runner and the board need

- The runner `adam-t480-hil`, registered for `adam26davidson/panelator` with the labels `self-hosted` and `panelator-hil`, running as a user that can run `docker` and open the serial device (group `uucp`), with Node on it. Nothing else: `esptool` and the serial reader run from the pinned image.
- The test board attached by its UART bridge port (labelled TTL, a CH34x bridge), `/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0`, and left attached. The harness reaches the board through the bridge only: reset and download mode are its DTR and RTS lines. `PANELATOR_HIL_PORT` overrides the port.
- The repository's fork pull request approval policy `all_external_contributors`, beside the workflow's own fork rule.
