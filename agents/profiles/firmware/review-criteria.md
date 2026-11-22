# Review criteria for firmware implementation PRs (spec 109 AC-3)

Read the spec, then the diff's sources, scripts, configs and tests. You have
no shell and no board: you build, flash and run nothing, and a build log,
check result or board output the PR description quotes is a claim, not
evidence. Judge from what you can read, and name what you could not judge in
`declined_to_judge`.

1. The firmware is built only by `firmware/scripts/build.sh` in the image
   pinned in `firmware/idf-image.txt`; the pin changes only where the spec
   changes it, and no workflow or other script names another ESP-IDF.
2. Logic that needs no ESP-IDF header lives in a portable component and has
   host-side tests under `firmware/test/host/` that cover the spec's
   acceptance criteria for it; the ESP-IDF glue stays thin.
3. Every buffer write is bounded, every `esp_err_t` is checked or
   deliberately handled, nothing blocks in an interrupt handler, and no
   warning is silenced: `-Werror`, `firmware/.clang-format` and
   `firmware/.clang-tidy` are not loosened, and any suppression sits on the
   smallest scope with its reason.
4. Nothing can leave the board unrecoverable over USB: no eFuse write, flash
   encryption, secure boot, bootloader or partition-table change that the
   spec does not ask for, and code that drives the panel boots at the
   USB-safe brightness of product spec section 3.
5. The console lines other work parses (spec 106's boot banner and status
   line) keep their fields and order; a change only adds fields at the end.
6. The HIL harness, its suite, its outcomes and `.github/workflows/hil.yml`
   change only as the spec says, and no step of the required `test` job is
   removed or weakened.
7. The PR edits nothing outside the plan's file scope (lockfiles and
   `schemas/` excepted). A change under `firmware/**/provisioning/**` or
   `firmware/**/wasm/**` is a sensitive path and also gets the security
   review.

Judge only against these criteria and the spec's acceptance criteria. Every
finding cites the criterion and the file and line.
