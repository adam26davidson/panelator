# 109. The firmware and widget profiles: implement, fix and review instructions for `firmware/`, `widgets/` and `sdk/`

Status: written 2026-11-22 by the maintainer's interactive session for issue
#459, outside the chain: every slot was held by claims waiting on this work
(#428 and #430 stop at plan without it), so it was claimed by hand with the
`blocked` label. A tooling spec under the delivery-system design needs no
maintainer approval (design section 11). Marks no earlier spec: spec 001
section 9 already names `firmware` and `widget` among the v0 profiles, and
spec 098 section 2 leaves each to its own spec; this is that spec for both.
Class: tooling. Domain: backend.
Parent: docs/delivery-system-design.md
Derives from: [delivery-system design](../../docs/delivery-system-design.md)
section 4 (the chain has no human stops: a stage must be told every rule it
is held to);
[001-scheduler-core](../001-scheduler-core/spec.md) section 9 (a profile is
`profile.yaml`, `instructions.md` and `skills/`; review for a domain uses the
same profile as implement);
[017-read-only-stages-not-told-to-run-tests](../017-read-only-stages-not-told-to-run-tests/spec.md)
AC-1 and AC-3 (the conditional `pnpm test` sentence and its guard test);
[077-plan-names-its-implementation-profiles](../077-plan-names-its-implementation-profiles/spec.md)
AC-1 to AC-4 (the plan prompt names the domains with an implementation
profile and a test ties that sentence to the profile directory);
[098-web-ui-profile](../098-web-ui-profile/spec.md) (the shape this spec
copies); [099-beyond-github-rest-on-the-credential-store](../099-beyond-github-rest-on-the-credential-store/spec.md)
AC-1 (`credentials: []` in place of `credential_hook`);
[product spec](../../docs/product-spec.md) sections 3 (firmware, the widget
runtime and the host API), 9 to 11 (SDKs, licences, built-in widgets) and 13
(testing contracts);
[106-firmware-project-and-hil](../106-firmware-project-and-hil/spec.md)
(the pinned ESP-IDF image, `build.sh`, `check-host.sh`, the host tests, the
console lines, the HIL workflow);
[107-widget-abi-and-rust-sdk](../107-widget-abi-and-rust-sdk/spec.md)
(`docs/widget-abi.md`, `rust-toolchain.toml`, `build-widgets.sh`,
`check.sh`, the golden frames and `PANELATOR_BLESS`);
[070-test-board](../070-test-board/spec.md) section 8 (the HIL contract).

## 1. Goal

A `firmware` or `widget` issue can run the chain. The plan stage classifies
work in `firmware/` as `firmware` and work in `widgets/` and `sdk/` as
`widget` (spec 077 AC-1), and the chain driver then fails the plan with
`profile not available` because neither directory exists under
`agents/profiles/` (the I4 check in `tools/scheduler/src/chain/driver.ts`).
That stops #428 (spec 106) and #430 (spec 107), and through them every later
child of the v0 build design that waits on the runtime spike.

After this spec, `agents/profiles/firmware/` and `agents/profiles/widget/`
each hold `profile.yaml` (the backend profile's shell tools, no credentials,
`review_criteria: review-criteria.md`), `instructions.md`,
`review-criteria.md` and an empty `skills/` with `.gitkeep`. The plan
prompt's implementation-profile sentence names both, and the tests that
spell out the profile list are updated.

**What the instructions hold a stage to.** *(maintainer session's call)*
Only rules that already have a source: product spec sections 3, 9 to 11 and
13, and the interfaces specs 106 and 107 define (the image pin and
`build.sh`, the host tests and `check-host.sh`, the console lines, the HIL
workflow; the ABI document, the pinned toolchain, `check.sh`, the golden
frames and `PANELATOR_BLESS`). Where a stage could do lasting harm the
instructions say so outright: the firmware stage never touches the board
(the HIL workflow owns it, one job at a time) and never writes eFuses or
enables flash encryption or secure boot unless the spec says so, because
that cannot be undone over USB; the widget stage never blesses a golden
frame to make a failing test pass. A file the instructions name that does
not exist yet (both specs are unimplemented when this merges) is named as
"when it exists", so the first issue of each domain is not told to run a
script it is about to write.

**Missing tools.** *(maintainer session's call)* On 2026-11-22 the laptop
that runs the stages had Docker, `gcc` and `rustup`, but not CMake, the
clang 18 tools, `cargo-nextest` or `cargo-deny`, and no
`wasm32-unknown-unknown` target installed. The instructions let an
implement or fix stage install what a check needs without root, or run the
check in a container, and require it to name in its result any check it
could not run; they never let a stage skip a check silently or report it as
passed. The review stage has no shell (spec 017 AC-2) and judges by
reading, as the web-ui profile's does.

## 2. Out of scope

- An `infra` profile: its own spec's work (spec 001 section 9). The tests
  that need a domain with no profile use `infra` from now on.
- The plan prompt's offered domains, their areas and the
  `profile not available` paragraph (spec 077 AC-1): unchanged apart from
  the two names added to the implementation-profile sentence (AC-5).
- Skills under either profile's `skills/`: both ship empty, as the others do.
- Any change to `pickProfile`, the I4 check, the security-review selection,
  `STAGE_PROFILES`, `implementationProfiles` or the UI-design gate (which
  already treats `widget` as a UI domain): the code lists whatever profile
  directories exist.
- Installing tools on the laptop: the instructions say what a stage does
  when one is missing; provisioning the machine is not this spec's work.
- Specs 106 and 107 and their implementations: unchanged.

## 3. Acceptance criteria

- AC-1. **The profiles exist and resolve.** Given `agents/profiles/firmware/`
  and `agents/profiles/widget/` on `main`, when `resolveProfile(agentsDir,
  name)` runs for either, then it returns a profile whose `tools` equal the
  backend profile's (`[Read, Edit, Write, Bash, Glob, Grep]`), whose
  `credentials` are `[]`, whose `reviewCriteria` is the text of that
  directory's `review-criteria.md`, whose `instructions` is the text of its
  `instructions.md`, and whose `skillsDir` is its `skills/`, a committed
  directory holding `.gitkeep`. Each `profile.yaml` reads, word for word,
  with `<name>` the directory's name:

  ```yaml
  name: <name>
  tools: [Read, Edit, Write, Bash, Glob, Grep]
  credentials: []
  review_criteria: review-criteria.md
  ```

  Given a plan result with `domain: firmware` or `domain: widget` and no
  `escalation`, when the chain driver handles it, then the I4 check passes
  and the implement, fix and review stages of that issue run under that
  profile, with `profile_instructions` the instructions followed by a blank
  line and the review criteria, as `tools/scheduler/src/runner/run.ts` joins
  them.

- AC-2. **The instructions.** Given each `instructions.md`, when it is read,
  then it is this text, word for word (line breaks may differ).

  `agents/profiles/firmware/instructions.md`:

  > Firmware profile. The ESP-IDF C project under `firmware/` for the
  > ESP32-S3-N16R8 board (16 MB flash, 8 MB octal PSRAM), and the code that
  > builds, flashes and tests it on the hardware-in-the-loop runner when the
  > spec puts that work in the same issue (`tools/hil/`, `.github/workflows/hil.yml`).
  > Product spec section 3 and the firmware's own specs (from spec 106 on) are
  > the contract.
  >
  > Build only through `firmware/scripts/build.sh`, which runs `idf.py` inside
  > the one container image pinned in `firmware/idf-image.txt`; do not install
  > or call any other ESP-IDF, and change the pin only when the spec says so.
  > Put logic in portable components that include no ESP-IDF header and test it
  > on the host under `firmware/test/host/` (Unity under `ctest`, with the
  > address and undefined-behaviour sanitizers); keep the code that includes
  > ESP-IDF headers (`main/` and thin glue) small. The project compiles with
  > warnings as errors, and `firmware/.clang-format` and `firmware/.clang-tidy`
  > hold every source outside `build/` and `third_party/`: fix what they report
  > instead of loosening them, and put any suppression on the smallest scope
  > with its reason. Bound every buffer write, check every `esp_err_t`, and keep
  > what the firmware prints on its console (the boot banner and status lines
  > of spec 106) stable: a later change may add fields at the end of a line,
  > never reorder or remove one.
  >
  > The board belongs to the HIL workflow, which runs one job at a time on the
  > laptop's runner: do not flash it, reset it or open its serial port from your
  > stage, and read the `hil` check on the PR's head when the spec asks for the
  > board's result. Never write eFuses, enable flash encryption or secure boot,
  > or change the bootloader or partition table unless the spec says so: a
  > mistake there cannot be undone over USB. Code that drives the panel boots at
  > the USB-safe brightness product spec section 3 carries over.
  >
  > When your stage has a shell (implement and fix), run `pnpm test` from the
  > repo root before writing your result, and `firmware/scripts/check-host.sh`
  > and `firmware/scripts/build.sh` when they exist and your change touches
  > `firmware/`. If a tool those scripts need is missing on this machine (CMake,
  > the clang 18 tools, Docker), install it without root into your user's
  > directories at the version CI uses, or run the script in a container, and
  > say how in your result; a check you could not run is named in your result
  > with the reason, never skipped silently or reported as passed. A stage
  > without a shell (plan and review) judges by reading: do not try to run the
  > suite, and a command you could not run is not a missing verification. Do
  > not touch files outside the plan's file scope; lockfiles and `schemas/` are
  > the only exceptions. Record anything you notice but must not fix as a
  > finding in your result, then continue with your task.

  `agents/profiles/widget/instructions.md`:

  > Widget profile. The WebAssembly widgets under `widgets/` and the SDKs and
  > hosts under `sdk/`: the Rust SDK and the Rust test host in `sdk/rust/`, the
  > conformance suite in `sdk/conformance/`, and the AssemblyScript SDK in
  > `sdk/assemblyscript/`. `docs/widget-abi.md` is the contract every host and
  > SDK implements: a widget imports only what it lists, from the module it
  > names, and exports exactly what it requires; nothing reaches the network,
  > a filesystem, another widget or the framebuffer (product spec 3.3). A
  > change to the ABI is a change the spec makes, with the version moved as
  > the document's versioning rule says.
  >
  > Build with the toolchain `rust-toolchain.toml` pins and its
  > `wasm32-unknown-unknown` target, through `sdk/rust/build-widgets.sh`; the
  > SDK and the widgets are `no_std`. Built-in widgets use the Rust SDK
  > (product spec 11). A frame depends only on what the host gives the widget
  > (time, timezone, config, data, its random sequence), so the same module
  > gives identical frames in every host (product spec 13). The golden frames
  > under `sdk/conformance/golden/` are that contract: change one only when the
  > spec changes what the frame shows, write it with `PANELATOR_BLESS=1` and say
  > in your result which frames changed and why; never bless a frame to make a
  > failing test pass. When the spec has a merged `design/`, its renders are
  > what the frames show; where the design is silent, follow the nearest render
  > and record the gap as a finding. Add no dependency the spec does not name,
  > and do not loosen `deny.toml`, the clippy settings or a module's size and
  > memory caps. Each widget declares an OSI-approved licence (product spec
  > 9.1).
  >
  > When your stage has a shell (implement and fix), run `pnpm test` from the
  > repo root before writing your result, and `sdk/rust/check.sh` when it exists
  > and your change touches `sdk/` or `widgets/`. If a tool it needs is missing
  > on this machine (the pinned toolchain or its target, `cargo-nextest`,
  > `cargo-deny`), install it without root (`rustup` reads
  > `rust-toolchain.toml`; `cargo install --locked` at the version CI pins) and
  > say how in your result; a check you could not run is named in your result
  > with the reason, never skipped silently or reported as passed. A stage
  > without a shell (plan and review) judges by reading: do not try to run the
  > suite, and a command you could not run is not a missing verification. Do
  > not touch files outside the plan's file scope; lockfiles and `schemas/` are
  > the only exceptions. Record anything you notice but must not fix as a
  > finding in your result, then continue with your task.

  In each, the one sentence containing `pnpm test` contains `shell`, so
  spec 017 AC-3's guard test passes.

- AC-3. **The review criteria.** Given each `review-criteria.md`, when it is
  read, then it is this text, word for word (line breaks may differ).

  `agents/profiles/firmware/review-criteria.md`:

  > # Review criteria for firmware implementation PRs (spec 109 AC-3)
  >
  > Read the spec, then the diff's sources, scripts, configs and tests. You have
  > no shell and no board: you build, flash and run nothing, and a build log,
  > check result or board output the PR description quotes is a claim, not
  > evidence. Judge from what you can read, and name what you could not judge in
  > `declined_to_judge`.
  >
  > 1. The firmware is built only by `firmware/scripts/build.sh` in the image
  >    pinned in `firmware/idf-image.txt`; the pin changes only where the spec
  >    changes it, and no workflow or other script names another ESP-IDF.
  > 2. Logic that needs no ESP-IDF header lives in a portable component and has
  >    host-side tests under `firmware/test/host/` that cover the spec's
  >    acceptance criteria for it; the ESP-IDF glue stays thin.
  > 3. Every buffer write is bounded, every `esp_err_t` is checked or
  >    deliberately handled, nothing blocks in an interrupt handler, and no
  >    warning is silenced: `-Werror`, `firmware/.clang-format` and
  >    `firmware/.clang-tidy` are not loosened, and any suppression sits on the
  >    smallest scope with its reason.
  > 4. Nothing can leave the board unrecoverable over USB: no eFuse write, flash
  >    encryption, secure boot, bootloader or partition-table change that the
  >    spec does not ask for, and code that drives the panel boots at the
  >    USB-safe brightness of product spec section 3.
  > 5. The console lines other work parses (spec 106's boot banner and status
  >    line) keep their fields and order; a change only adds fields at the end.
  > 6. The HIL harness, its suite, its outcomes and `.github/workflows/hil.yml`
  >    change only as the spec says, and no step of the required `test` job is
  >    removed or weakened.
  > 7. The PR edits nothing outside the plan's file scope (lockfiles and
  >    `schemas/` excepted). A change under `firmware/**/provisioning/**` or
  >    `firmware/**/wasm/**` is a sensitive path and also gets the security
  >    review.
  >
  > Judge only against these criteria and the spec's acceptance criteria. Every
  > finding cites the criterion and the file and line.

  `agents/profiles/widget/review-criteria.md`:

  > # Review criteria for widget implementation PRs (spec 109 AC-3)
  >
  > Read the spec and `docs/widget-abi.md`, then the diff's sources, tests and
  > golden frames (the PNGs, with Read), and the spec's merged `design/` renders
  > when it has them. You have no shell: you build and run nothing, and a test
  > run or frame the PR description quotes is a claim, not evidence. Judge from
  > what you can read, and name what you could not judge in `declined_to_judge`.
  >
  > 1. ABI: every module imports only what `docs/widget-abi.md` lists, from the
  >    module it names, and exports exactly what it requires, with the ABI
  >    version it declares; a change to the document, the SDK's bindings or a
  >    host's import table is one the spec makes, with the version moved by the
  >    document's rule.
  > 2. Golden frames: a PNG under `sdk/conformance/golden/` changes only where
  >    the spec changes what the frame shows, its hash in `frames.json` changes
  >    with it, and no script, test or workflow sets `PANELATOR_BLESS`. Open
  >    each changed frame and check it shows what the spec says.
  > 3. Design: when the spec has a merged `design/`, the golden frames show what
  >    its renders show for each widget and scene.
  > 4. Determinism: a frame depends only on what the host provides (time,
  >    timezone, config, data, the random sequence), so the same module gives
  >    the same frames in every host.
  > 5. Rust: the SDK and the widgets are `no_std`; every `unsafe` block is in
  >    the SDK's binding layer with a `SAFETY:` comment; malformed config or
  >    data does not panic or trap where the ABI says the widget handles it;
  >    any `allow` of a pedantic lint sits on the smallest item with its
  >    reason; `deny.toml` and the size and memory caps are not loosened.
  > 6. Dependencies: nothing the spec does not name is added, and each widget
  >    declares an OSI-approved licence (product spec 9.1).
  > 7. Tests: each acceptance criterion has a test, and the golden tests fail
  >    rather than skip when the modules are not built.
  > 8. The PR edits nothing outside the plan's file scope (lockfiles and
  >    `schemas/` excepted) and changes nothing under the spec's `design/`.
  >
  > Judge only against these criteria and the spec's acceptance criteria. Every
  > finding cites the criterion, the widget or scene, and the file and line.

- AC-4. **The tests name the new profiles.** Given `pnpm test`, then:
  - `tools/scheduler/test/profiles.test.ts` expects `listProfiles(agentsDir)`
    to equal `["backend", "design", "firmware", "security", "spec", "web-ui", "widget"]`
    and `implementationProfiles(agentsDir)` to equal
    `["backend", "firmware", "web-ui", "widget"]`;
  - the same file has a test per new profile that resolves it, expects its
    `tools` to equal the backend profile's and its `credentials` to be `[]`,
    and expects its criteria and instructions to contain the key strings of
    AC-2 and AC-3 (for `firmware`: `firmware/scripts/build.sh`,
    `firmware/idf-image.txt`, `firmware/test/host/`, `esp_err_t`, `eFuse`,
    `USB-safe brightness`, `hil.yml`, `declined_to_judge`, and in the
    instructions `firmware/scripts/check-host.sh`, `hil`, `pnpm test`; for
    `widget`: `docs/widget-abi.md`, `sdk/conformance/golden/`,
    `frames.json`, `PANELATOR_BLESS`, `no_std`, `SAFETY:`, `deny.toml`,
    `OSI-approved`, `declined_to_judge`, and in the instructions
    `rust-toolchain.toml`, `sdk/rust/check.sh`, `PANELATOR_BLESS=1`,
    `pnpm test`);
  - the existing guard tests of that file hold without change (every
    profile has a committed `skills/.gitkeep`; no `pnpm test` sentence
    lacks `shell`; every profile's credentials are `[]`);
  - `tools/scheduler/test/driver-2.test.ts`'s test "fails a plan whose
    domain names a profile that does not exist" uses the domain `infra` and
    expects `profile not available: infra (implementation profiles: backend, firmware, web-ui, widget)`,
    and `tools/scheduler/test/driver-1.test.ts`'s test "sends a plan
    escalation to the question check even when its domain has no profile"
    uses `infra`, since `firmware` now has one;
  - `tools/scheduler/test/stages.test.ts`'s test of spec 077 AC-4 passes
    unchanged.

- AC-5. **The plan prompt names the new profiles.** Given
  `agents/stages/plan.md`, then the sentence "The domains with an
  implementation profile today are: `` `backend` ``, `` `web-ui` ``." reads
  "The domains with an implementation profile today are: `` `backend` ``,
  `` `firmware` ``, `` `web-ui` ``, `` `widget` ``." and nothing else in the
  file changes.

- AC-6. **Nothing else changes.** Given the PR, then it edits only the files
  of section 4; no stage definition, gate, bound, label rule, other profile,
  sensitive-path list, security criterion or other profile's review
  criteria changes.

## 4. Interfaces and files

No schema, config key, state file or event changes. The PR adds or edits:

- `agents/profiles/firmware/profile.yaml`, `instructions.md`,
  `review-criteria.md`, `skills/.gitkeep`;
- `agents/profiles/widget/profile.yaml`, `instructions.md`,
  `review-criteria.md`, `skills/.gitkeep`;
- `agents/stages/plan.md`: the two names of AC-5;
- `tools/scheduler/test/profiles.test.ts`,
  `tools/scheduler/test/driver-1.test.ts`,
  `tools/scheduler/test/driver-2.test.ts`: AC-4;
- this spec, and its entry under `## Children` in
  `docs/delivery-system-design.md`.

`agents/`, `tools/scheduler/` and `docs/delivery-system-design.md` are
sensitive paths (`agents/sensitive-paths.txt`), so the security review
applies. The change adds two profile directories whose tool allowlist
copies the backend profile's (no new tool, credential or permission), adds
two names to a prompt sentence a test already ties to the profile
directory, and changes four test expectations; it adds no network listener,
outbound call or shell execution beyond what the backend profile allows,
touches no gate, bound, label rule or the sensitive-path list, and drops,
skips or narrows nothing `pnpm test` runs.

## 5. Verification

- `pnpm test` passes from the repository root, including the new and
  changed tests of AC-4.
- As a negative check, with the two directories added and `plan.md`
  unchanged, the spec 077 AC-4 stages test and the profiles list test fail.
- Live: the next plan for #428 with `domain: firmware` and for #430 with
  `domain: widget` is not failed with `profile not available`, and their
  implement runs carry these instructions and criteria (the run's events
  under the state directory).

## 6. Open decisions

None.
