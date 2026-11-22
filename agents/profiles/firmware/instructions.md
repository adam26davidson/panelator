Firmware profile. The ESP-IDF C project under `firmware/` for the
ESP32-S3-N16R8 board (16 MB flash, 8 MB octal PSRAM), and the code that
builds, flashes and tests it on the hardware-in-the-loop runner when the
spec puts that work in the same issue (`tools/hil/`, `.github/workflows/hil.yml`).
Product spec section 3 and the firmware's own specs (from spec 106 on) are
the contract.

Build only through `firmware/scripts/build.sh`, which runs `idf.py` inside
the one container image pinned in `firmware/idf-image.txt`; do not install
or call any other ESP-IDF, and change the pin only when the spec says so.
Put logic in portable components that include no ESP-IDF header and test it
on the host under `firmware/test/host/` (Unity under `ctest`, with the
address and undefined-behaviour sanitizers); keep the code that includes
ESP-IDF headers (`main/` and thin glue) small. The project compiles with
warnings as errors, and `firmware/.clang-format` and `firmware/.clang-tidy`
hold every source outside `build/` and `third_party/`: fix what they report
instead of loosening them, and put any suppression on the smallest scope
with its reason. Bound every buffer write, check every `esp_err_t`, and keep
what the firmware prints on its console (the boot banner and status lines
of spec 106) stable: a later change may add fields at the end of a line,
never reorder or remove one.

The board belongs to the HIL workflow, which runs one job at a time on the
laptop's runner: do not flash it, reset it or open its serial port from your
stage, and read the `hil` check on the PR's head when the spec asks for the
board's result. Never write eFuses, enable flash encryption or secure boot,
or change the bootloader or partition table unless the spec says so: a
mistake there cannot be undone over USB. Code that drives the panel boots at
the USB-safe brightness product spec section 3 carries over.

When your stage has a shell (implement and fix), run `pnpm test` from the
repo root before writing your result, and `firmware/scripts/check-host.sh`
and `firmware/scripts/build.sh` when they exist and your change touches
`firmware/`. If a tool those scripts need is missing on this machine (CMake,
the clang 18 tools, Docker), install it without root into your user's
directories at the version CI uses, or run the script in a container, and
say how in your result; a check you could not run is named in your result
with the reason, never skipped silently or reported as passed. A stage
without a shell (plan and review) judges by reading: do not try to run the
suite, and a command you could not run is not a missing verification. Do
not touch files outside the plan's file scope; lockfiles and `schemas/` are
the only exceptions. Record anything you notice but must not fix as a
finding in your result, then continue with your task.
