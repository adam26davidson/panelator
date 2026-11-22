# 107. Widget ABI v0 draft, the Rust SDK, the three spike widgets and a Rust test host with golden frames

Status: written 2026-11-22 for issue #430, the planned child
`widget-abi-and-rust-sdk` of the v0 build design; a spec derived from its
parent design needs no maintainer approval (delivery-system design section
11). It marks no other spec.
Class: product. Domain: widget (sensitive path: `.github/workflows/ci.yml`,
under `.github/`; process-spec section 5).
Parent: docs/designs/product-v0-build.md
Derives from: [v0 build design](../../docs/designs/product-v0-build.md)
sections 3 and 4 ("Geometry is configuration", "One ABI, three hosts",
"Checks arrive with the layer") and its planned child
`widget-abi-and-rust-sdk`; [product spec](../../docs/product-spec.md) sections
3.1, 3.2, 3.3, 3.4, 9.2, 12 (milestone 1) and 13;
[design-tree](../../docs/design-tree.md) R2.Q3 (WASM), R2.Q4 (full RGB),
R3.Q1 (retained layers), R3.Q2 (Rust primary, ABI published), R3.Q3 (host
fonts), R4.Q1 (host API v0), R4.Q8 (spike criteria), R5.Q5 (Rust tooling),
R5.Q6 (ABI conformance and golden pixel tests first), R9.Q3 (ABI versioning);
[ADR 0020](../../docs/decisions/0020-widget-abi-core-wasm-host-owned-layers.md)
(the ABI's shape);
[ADR 0016](../../docs/decisions/0016-product-breakdown-is-one-ordered-design.md).

## 1. Goal

`sdk/rust/` and `widgets/` hold only `.gitkeep`, and nothing says what a
widget module is. After this spec the repository has:

- `docs/widget-abi.md`, the published widget ABI, version 0.1 (a draft: the
  runtime spike may still change it): what a module exports, how it declares
  its update rate and size, the host imports for drawing, config, time and
  random, and the exact pixel rules that make three hosts produce the same
  frames;
- the Rust SDK crate, on which a widget is a few lines of safe Rust;
- the three spike widgets of product spec 12.1 (a clock at 1 Hz, scrolling
  text at 60 Hz, a 24 KB image blit at 30 Hz), built to WASM in CI, with the
  built modules committed so the firmware and the browser engine load the
  same bytes without a Rust toolchain;
- a Rust test host that runs modules against the retained-layer model and
  writes frames, and the start of the conformance suite: scenes, a probe
  module that exercises every import, and committed golden frames that the
  device runtime (`firmware-wasm-runtime`) and the browser engine
  (`simulator-engine`) are tested against;
- the Rust checks of product spec 13 for this layer, held by the required
  `test` check.

## 2. Out of scope

- Feeds, feed staleness, events, the key-value store, logging, host
  animations (scroll, fade), blit from a named asset, Unifont,
  truffle-shuffle and further Spleen sizes: later children add each import
  to the ABI document by its change rule (AC-2).
- The manifest file and its format (`screen-config-and-type-sharing`,
  `first-builtin-widget`), the widget's size constraints beyond a default
  size, and timezones other than the board's own.
- The per-call time budget, the overrun and disable rules and the background
  tick (product spec 3.2): `firmware-wasm-runtime` and `rest-of-v0`. The ABI
  range a firmware supports and the backend's refusal of installs (3.4):
  `rest-of-v0`. Module size and memory caps (9.1) come from the spike's
  numbers.
- The device runtime, the browser engine, the relay, and anything under
  `firmware/`, `web/` or `backend/`.
- The AssemblyScript SDK and the SDK templates (9.2).
- The `widget` implementation profile under `agents/` (issue #459). Until it
  exists the plan stage stops this issue with `profile not available`; this
  spec changes nothing under `agents/` or `tools/scheduler/`.

## 3. Acceptance criteria

Definitions. *The ABI document* is `docs/widget-abi.md`. *The SDK* is the
crate `panelator-widget` in `sdk/rust/widget/`. *The host* is the crate
`panelator-widget-host` in `sdk/rust/host/`, with its binary `pn-host`. *The
probe* is the module built from `sdk/rust/probe/`. *The modules* are the four
files `spike_clock.wasm`, `spike_scroll.wasm`, `spike_image.wasm` and
`abi_probe.wasm` in `sdk/abi/modules/`. *A scene* is a JSON file in
`sdk/abi/scenes/` (AC-15). *The check script* is `sdk/rust/scripts/check.sh`.
All integers in the ABI are 32-bit unless stated; a colour is
`0xAARRGGBB`; a *page* is 64 KiB. Sections 3.1 to 3.4 below are the content
the ABI document must carry; where this spec gives a rule, the document
states the same rule, and the document, not this spec, is what later
children cite and change.

### 3.1 The ABI document

- AC-1. **The document exists and is normative.** Given the implementation
  is merged, then `docs/widget-abi.md` states its version (`0.1`, draft),
  and has one section for each of: the module format (AC-3), the exports
  (AC-4), the call sequence and the update schedule (AC-5), the layer and
  the compositor (AC-6), each import with its signature and exact behaviour
  (AC-7 to AC-11), the fonts (AC-10), the conformance mode (AC-12), the
  version rule and the change rule (AC-2), and a list of what product spec
  3.3 names that the draft does not yet have. It gives the line algorithm as
  pseudo-code and the circle and blend rules as formulas, exactly as AC-6
  and AC-8 give them. `sdk/rust/README.md` and `sdk/abi/README.md` link to
  it. Nothing in the document names 128×64 except as an example.
- AC-2. **Version and change rule.** The ABI version is a pair
  `major.minor`; this draft is `0.1`. Adding an import, an export or an
  accepted value is a minor bump; any other change to what an existing
  module observes is breaking and bumps the major, and the previous major
  stays supported for at least one firmware release cycle (product spec
  3.4; no firmware has been released, so nothing is owed to a version
  before the first release). A host that supports `M.n` accepts a module
  declaring `M.m` with `m ≤ n` and refuses every other. A change to the ABI
  is one PR that changes the document, the SDK, the host, the probe and the
  golden frames together with the hosts that need it (the design's "One
  ABI, three hosts"). The document says that the manifest, once it exists,
  also declares the ABI version, update rate and sizes, and that the child
  which adds the manifest states which declaration the backend reads.
- AC-3. **Module format.** A module is a core WebAssembly binary (no
  component model). It imports only functions from the import module
  `panelator`, each with the name and signature the document lists; it
  exports its linear memory as `memory` and the five functions of AC-4.
  The document lists the WebAssembly features a module may use: the
  smallest set the pinned Rust toolchain can be made to emit for the four
  modules, found by the implementation and written down as a list
  *(agent's call: the precompiled `core` library fixes part of the set, so
  it is measured, not chosen; `firmware-wasm-runtime` enables exactly this
  list in WAMR, and a feature WAMR lacks is a change to this document in
  that child's PR)*. Given a module that is not valid under exactly that
  list, or imports anything else, or lacks an export, or has an export of
  another signature, when a host loads it, then the host refuses it with
  an error naming the import, export or feature.
- AC-4. **Exports.** `pn_abi_version() -> i32` returns
  `(major << 16) | minor`. `pn_update_hz() -> i32` returns the requested
  update rate: `0` for "on data change only", `1` to `60` for that many
  calls a second; any other value is refused at load.
  `pn_default_size() -> i32` returns `(width << 16) | height`, each from 1
  to 32767; anything else is refused at load. `pn_init(width, height)` and
  `pn_update(frame)` return nothing. The three declaration exports take no
  argument, return the same value on every call and call no import; an
  import called from inside one traps.
- AC-5. **Call sequence and schedule.** A *placement* is one instance of a
  module with a position, a z value, a size and a config; instances share
  nothing. Given a placement, then the host instantiates the module, reads
  the three declarations, creates the layer (AC-6) and calls
  `pn_init(width, height)` once with the layer's size, which is the
  placement's size and need not be the declared default. The compositor
  counts frames at 60 Hz from 0 at the screen's start. On frame `f` the host
  first calls `pn_update(f)` on every placement that is *due*, in ascending
  z and, within one z, in the screen's placement order, then composites
  (AC-6). With `N = pn_update_hz()`: for `N = 0` the placement is due on
  frame 0 and after its config changes; for `N ≥ 1` it is due when `f = 0`
  or `floor(f·N/60) > floor((f−1)·N/60)`. `frame` is `f` modulo 2³², so a
  widget sees a skipped call as a gap. A trap ends the placement: its layer
  stays as it was and it is not called again. A module may import and call
  any listed function during `pn_init` and `pn_update`.
- AC-6. **Layer and compositor.** Each placement owns one layer of its own
  size; each layer pixel is four 8-bit values R, G, B, A; a new layer is all
  zero. A drawing import writes the given colour, alpha included, over the
  pixels it covers, with no blending inside the layer, and the layer keeps
  its content between calls. Coordinates have their origin at the layer's
  top-left pixel, x to the right, y down; every drawing import clips to the
  layer and never traps. A drawing call in which any coordinate, size or
  radius argument lies outside −32768 to 32767 draws nothing. The frame is
  the panel-sized RGB image made by starting from black and, for each
  placement in ascending z (ties in placement order), for each layer pixel
  that falls on the panel, setting each channel to
  `(t + (t >> 8)) >> 8` with `t = s·a + d·(255 − a) + 128`, where `s` is the
  layer's channel, `a` its alpha and `d` the frame's channel so far (this
  equals `s·a/255 + d·(255−a)/255` rounded to nearest). Layers have
  per-pixel alpha *(agent's call, ADR 0020: product spec 3.2 composites
  "with z-order and alpha"; a widget that draws only opaque colours behaves
  as a plain RGB layer)*. Panel width and height are parameters of every
  host.
- AC-7. **`fill`, `pixel`.** `fill(color)` sets every layer pixel.
  `pixel(x, y, color)` sets one.
- AC-8. **`line`, `rect`, `circle`.** `line(x0, y0, x1, y1, color)` sets
  the pixels of this loop, both ends included: `dx = |x1−x0|`,
  `sx = x0<x1 ? 1 : −1`, `dy = −|y1−y0|`, `sy = y0<y1 ? 1 : −1`,
  `err = dx+dy`; repeat: set `(x0, y0)`; stop when `x0 = x1` and `y0 = y1`;
  `e2 = 2·err`; if `e2 ≥ dy` then `err += dy`, `x0 += sx`; if `e2 ≤ dx` then
  `err += dx`, `y0 += sy`. `rect(x, y, w, h, color, filled)` sets, for
  `filled ≠ 0`, every pixel with `x ≤ px < x+w` and `y ≤ py < y+h`, and for
  `filled = 0` those of them on the rectangle's one-pixel border; `w ≤ 0` or
  `h ≤ 0` draws nothing. `circle(cx, cy, r, color, filled)`: the *disc* is
  every pixel with `(px−cx)² + (py−cy)² ≤ r² + r`; `filled ≠ 0` sets the
  disc, `filled = 0` sets the disc pixels that have at least one of their
  four edge neighbours outside the disc; `r < 0` draws nothing. A host may
  use any algorithm that sets the same pixels.
- AC-9. **`blit`.** `blit(x, y, w, h, ptr, len, format) -> i32` copies a
  `w`×`h` image from the module's memory, rows top to bottom, pixels left
  to right, to the layer with its top-left at `(x, y)`, clipped. Format `0`
  is three bytes R, G, B per pixel, written with alpha 255; format `1` is
  four bytes R, G, B, A, written as they are. It returns `0` on success. It
  draws nothing and returns `−1` when the format is unknown, `w` or `h` is
  below 1, a coordinate is out of range (AC-6) or `len` is not `w·h` times
  the format's bytes per pixel, and `−2` when `ptr` to `ptr+len` is not
  inside the memory at the time of the call (both read as unsigned; the
  same memory rule holds for every pointer argument of every import). The
  image comes from the module's own memory in this draft *(agent's call:
  the board has no asset store before milestone 2, and the spike's blit
  must run in milestone 1; "blit from a named asset" of product spec 3.3
  arrives with assets and is listed in the document as not yet present)*.
- AC-10. **Text and fonts.** Font ids are `1` for Spleen 5×8 and `2` for
  Spleen 8×16; every glyph of a font fills one cell of the font's size. The
  glyphs are those of the files `sdk/abi/fonts/spleen-5x8.bdf` and
  `spleen-8x16.bdf`, copied unchanged from one named Spleen release with
  its BSD-2-Clause licence text beside them and the release and each file's
  SHA-256 in `sdk/abi/README.md`; every host takes its glyphs from these
  files. `text(x, y, ptr, len, font, color) -> i32` reads `len` bytes of
  UTF-8 and draws one cell per Unicode scalar value, left to right, the
  first cell's top-left at `(x, y)`: the glyph's set pixels in `color`, its
  unset pixels untouched; a scalar value with no glyph in the font
  (controls included) draws the one-pixel border of the rectangle
  `(cellx, y, cellw−1, cellh−1)`. It returns the width drawn in pixels,
  clipped or not (cells times cell width). `text_width(ptr, len, font) ->
  i32` returns the same number and draws nothing. `font_height(font) ->
  i32` returns the cell height. All three return `−1` for an unknown font,
  bytes that are not valid UTF-8 or an out-of-range coordinate, and `−2`
  for a bad memory range, and then draw nothing. The other fonts of
  product spec 3.3 take the next ids when their child adds them
  *(agent's call: two sizes are what the spike widgets use; Spleen's
  licence needs no question)*.
- AC-11. **Config, time, random.** `config_read(ptr, cap) -> i32` copies
  the first `min(cap, n)` bytes of the placement's config to `ptr` and
  returns `n`, the config's full length, or `−2` for a bad memory range. In
  this draft the config is the UTF-8 text of one JSON value, and has length
  0 when the placement has none *(agent's call: the config is validated by
  a JSON Schema and feeds are JSON, product spec 3.3 and 10; the child that
  stores configs may keep them in any form and hands the widget this
  text)*. `time_now_ms() -> i64` returns milliseconds since the Unix epoch,
  UTC. `time_utc_offset_s() -> i32` returns the board timezone's offset
  from UTC at that moment, in seconds, east positive. `random() -> i32`
  returns 32 uniformly random bits.
- AC-12. **Conformance mode.** A host under test runs a scene with these
  values and no others, so that frames are reproducible: during frame `f`
  (and during `pn_init`, with `f = 0`) `time_now_ms()` returns
  `start_ms + floor(f·1000/60)` and `time_utc_offset_s()` the scene's
  `utc_offset_s`; `random()` returns successive values of one generator per
  scene, shared by all placements in call order, whose 32-bit state starts
  at the scene's `seed` (never 0) and steps by `x ^= x << 13`,
  `x ^= x >> 17`, `x ^= x << 5`, returning `x` after each step. Outside
  conformance mode time is the board's clock and random is the platform's
  entropy source.

### 3.2 The Rust SDK

- AC-13. **A widget is safe Rust on the SDK.** `panelator-widget` is a
  `#![no_std]` crate that needs no allocator. It gives: a `Widget` trait
  (the update rate and default size as associated constants,
  `fn init(size: Size) -> Self`, `fn update(&mut self, frame: u32)`); an
  `export!` macro that generates the five exports of AC-4 and the panic
  handler (a panic traps) for one type; safe functions for every import of
  AC-7 to AC-11 over a `Color` type (with constructors from RGB and RGBA),
  a `Font` enum, slices for image data and `&str` for text; typed readers
  for a config that is a JSON object (`str`, `i32` and `bool` values by
  top-level key, and the raw bytes); and the local time of day from
  `time_now_ms` and the offset (hours, minutes, seconds; correct for
  negative and non-hour offsets). The raw imports are in a public `sys`
  module whose items carry the ABI document's names. Given the three spike
  widgets and the probe, then none of them contains `unsafe` outside what
  the macro expands to, and every public item of the SDK has a doc comment
  (`missing_docs` is denied). The SDK's version constant equals the ABI
  version the document states, and a test fails when they differ.
- AC-14. **Lean modules.** Given the four modules as built by AC-19, then
  each declares an initial memory of at most 2 pages; `spike_clock.wasm`
  and `spike_scroll.wasm` are each at most 16 KiB and `spike_image.wasm`
  at most 40 KiB (its image is 24 KiB); a test in the host asserts all of
  it, so that the spike measures the runtime and not the SDK's overhead.

### 3.3 The test host and the conformance suite

- AC-15. **Scenes.** A scene is a JSON object with exactly: `panel`
  (`width`, `height`), `start_ms`, `utc_offset_s`, `seed`, `placements`
  (each with `module`, a file name in `sdk/abi/modules/`; `x`, `y`, `z`;
  optional `width` and `height`, defaulting to the module's declared size;
  optional `config`, a string holding the exact config bytes), `frames`
  (ascending frame numbers to capture) and optional `fuel_per_call`. An
  unknown key is an error. `sdk/abi/README.md` describes the format, the
  golden files and how another host runs the suite.
- AC-16. **The host runs a scene.** Given a scene, when
  `pn-host render <scene> --out <dir>` runs, then it loads each placement
  by AC-3 to AC-5 in conformance mode, runs frames 0 to the last listed
  frame and writes `<dir>/frame-<n>.png` for each listed frame: the AC-6
  frame as an 8-bit RGB, non-interlaced PNG of the panel's size.
  `pn-host check <scene> --golden <dir> [--out <dir>]` renders the same
  frames and compares decoded pixels with `<golden>/frame-<n>.png`: exit 0
  when all are equal; otherwise exit 1, naming each differing frame with
  its first differing pixel and both values, and writing the actual frames
  under `--out`. `pn-host inspect <module>` prints the module's
  declarations, imports, initial memory and size as JSON. A refused module
  (AC-3, AC-4), a trap, or a call that uses more than `fuel_per_call`
  (default 10,000,000 units of the engine's fuel) ends `render` and `check`
  with exit 2 and a message naming the placement and the cause. The host
  executes modules with the `wasmi` interpreter *(agent's call: pure Rust,
  deterministic, fuel-metered, quick to build; speed does not matter
  here)*, and the same functions are a library API (load a scene, step a
  frame, read a frame) for later children.
- AC-17. **The host's rules are tested against hand-written expectations,
  not only against its own output.** Unit tests in the host, run by
  cargo-nextest, assert literal expected pixels for: each drawing import on
  a small layer, with clipping at all four edges, negative coordinates and
  the out-of-range no-op; lines in all eight octants, horizontal, vertical
  and a single point; circles of radius 0, 1, 2 and 5, outlined and filled;
  both blit formats and each error return; text with an ASCII string, a
  multi-byte character, a missing glyph, invalid UTF-8 and clipping, with
  `text_width` and `font_height`; `config_read` with a buffer shorter than
  the config; the schedule of AC-5 for rates 0, 1, 7, 30 and 60 over 120
  frames; the blend of AC-6 against the rounded fraction for every `s`, `a`
  and `d` in {0, 1, 127, 128, 254, 255} and z ties; the conformance clock
  and the first five values of the generator for seed 1; every load
  refusal of AC-3 and AC-4 (modules written as text in the tests); a trap;
  and the fuel limit.
- AC-18. **The probe, the scenes and the golden frames.** The probe is a
  60 Hz widget that, over its first frames, calls every import of AC-7 to
  AC-11 with the cases AC-17 lists (showing each returned status, the time,
  the offset and random values as pixels), and draws areas with alpha 0, 1,
  127, 128, 254 and 255. Committed scenes, each with its golden frames in
  `sdk/abi/golden/<scene>/`: `clock`, `scroll` and `image` (one spike widget
  each); `spike` (the three together as section 4 places them); `probe`
  (two overlapping probes of different sizes over a third placement, one z
  tie); and `wide` (a 256×64 panel with the image widget placed twice and a
  scroller at a non-default size). The scenes use at least three different
  panel sizes, one negative `utc_offset_s` that is not a whole hour, a
  `clock` scene that crosses local midnight, placements partly off the
  panel, and frame lists that include 0, 1, 2, 59, 60, 61 and 3600. Given
  the committed modules, when `pn-host check` runs each scene, then it
  exits 0. Golden frames are written only by `sdk/rust/scripts/bless.sh`,
  and the implementation PR's description shows each scene's frame 60
  enlarged, for the reviewer to compare with the UI design.

### 3.4 Build and checks

- AC-19. **One pinned toolchain, reproducible modules.**
  `sdk/rust/rust-image.txt` holds one line, the official `rust` image
  pinned by tag and digest (the newest stable release when the
  implementation is written); the cargo-deny and cargo-nextest versions
  are pinned beside it. `sdk/rust/scripts/build-modules.sh` builds the four
  modules for `wasm32-unknown-unknown` in release mode inside exactly that
  image, with locked dependencies, and writes them to `sdk/abi/modules/`.
  Given two builds from clean checkouts at different paths, then the four
  files are byte-identical. The committed modules are that build's output
  *(agent's call: the firmware build and the browser tests need the bytes
  without a Rust toolchain, and "identical modules" is then checked by a
  file comparison; the same pattern as the generated files in
  `schemas/`)*. `sdk/rust/` and `widgets/` are two Cargo workspaces, each
  with a committed `Cargo.lock`; the widgets depend on the SDK by path.
- AC-20. **The Rust checks.** Given a checkout and Docker, when the check
  script runs, then inside the pinned image and for both workspaces it
  runs `cargo fmt --check`; clippy with `clippy::all` and
  `clippy::pedantic` as errors, for the native target and for
  `wasm32-unknown-unknown`; `cargo deny check` with a committed
  `deny.toml` (advisories, licences limited to ones compatible with
  Apache-2.0, bans, sources limited to crates.io); `cargo nextest run`;
  then builds the modules (AC-19) and fails when a built module differs
  from the committed file; then runs `pn-host check` on every scene. It
  exits non-zero when any step fails and prints which. It keeps its caches
  in `$PANELATOR_RUST_CACHE` (default `~/.cache/panelator-rust`), leaves no
  root-owned file, and needs no Rust installation on the machine.
- AC-21. **CI holds them in `test`.** Given a pull request or a push to
  `main`, when the `test` job of `.github/workflows/ci.yml` runs, then it
  runs the check script whenever the change touches `sdk/`, `widgets/`,
  `docs/widget-abi.md` or `.github/`, and on every push to `main`, and the
  job fails when the script does; no existing step of the job is removed
  or weakened, and `pnpm test` is unchanged *(agent's call: the scheduler
  requires the one check `test`; a second required check would strand open
  PRs, as spec 106 found for the firmware)*.

## 4. UI design

Screens: spike-widgets

The spike widgets are test loads, not built-in widgets (the built-in clock
is `first-builtin-widget`, with its own design). Their look is fixed here so
that the golden frames are decided, not accidental. The one screen shows the
`spike` scene on a 128×64 panel as LEDs, enlarged, and beside it each widget
alone at its default size; no interaction, no states. The design's renders
show layout, colour and proportion; the committed golden frames are the
pixel truth, and the review compares the two for layout and colour only
(the story has no host font rasteriser to match pixel for pixel).

- **Image** (`spike-image`, 30 Hz, default 128×64, z 0 at (0, 0)): a 128×64
  RGB image of 24,576 bytes with pixel (x, y) = (R 2x, G 4y, B 255−2x),
  committed as `widgets/spike-image/assets/image.rgb` and checked against
  that formula by a test. On each call with frame `f` it blits the whole
  image twice, at x = −s and x = 128−s with s = floor(f/2) mod 128, so the
  picture slides left one pixel per call and wraps.
- **Clock** (`spike-clock`, 1 Hz, default 64×16, z 2 at (32, 24), centred):
  on each call it fills its layer with `0xA0000000` (black at alpha 160, so
  the image shows through dimmed) and draws the local time `HH:MM:SS`,
  24-hour, in Spleen 8×16, colour `0xFFFFFFFF`, at (0, 0); eight cells fill
  the 64 pixels exactly.
- **Scrolling text** (`spike-scroll`, 60 Hz, default 128×8, z 1 at (0, 56),
  the bottom rows): on each call it fills its layer with `0x00000000` and
  draws its text in Spleen 5×8 at x = −(f mod W) and again at x = W −
  (f mod W), where W is the text's width, so the text moves left one pixel
  per frame and repeats without a gap. The text is the config's `text`
  (default `panelator runtime spike - 60 Hz - `), the colour the config's
  `color` as an integer (default `0xFFFFB000`, amber). A text narrower than
  the layer is repeated until it covers it.

Component mapping: none; nothing here is a web component. Flow: one screen.

## 5. Design notes (agent's calls)

- **Where things live.** `sdk/abi/` holds what all three hosts share and no
  one language owns: the modules, fonts, scenes and golden frames. The
  ABI document is in `docs/` as the issue asks. The probe is part of the
  SDK's workspace, not of `widgets/`, because it is a test instrument and
  `widgets/` is for widgets a board shows.
- **Declarations are exports.** No manifest exists yet, an exported
  function reads the same way in WAMR (interpreter and AOT), wasmi and a
  browser, and a custom section does not survive every toolchain. ADR 0020.
- **`frame` is the widget's clock for animation.** A widget that counts its
  own calls drifts when a call is skipped; one that derives position from
  the frame number does not, and conformance needs no separate monotonic
  import.
- **Set-wise rules for shapes.** The circle is defined by which pixels it
  contains and the line by one fixed loop, because "Bresenham" and
  "midpoint" name families whose members differ in tie-breaking, and three
  hosts in three languages must agree to the pixel.
- **Errors are return values, traps are for bugs.** A bad pointer from a
  widget returns `−2` and draws nothing on every host; a host never reads
  outside the module's memory.
- **Golden PNGs.** PNG is lossless, a reviewer sees it in the PR, and every
  host's test language decodes it; comparison is on decoded pixels, so the
  encoder does not matter.

## 6. Interfaces and files

The implementation's file scope:

- `docs/widget-abi.md` (new).
- `sdk/rust/` whole: `Cargo.toml` (workspace), `Cargo.lock`, `deny.toml`,
  `rust-image.txt`, `README.md`, `widget/` (the SDK), `host/` (the library,
  `pn-host` and its tests), `probe/`, `scripts/check.sh`,
  `scripts/build-modules.sh`, `scripts/bless.sh`. `sdk/rust/.gitkeep` is
  removed.
- `widgets/` whole: `Cargo.toml` (workspace), `Cargo.lock`, `deny.toml`,
  `README.md`, `spike-clock/`, `spike-scroll/`, `spike-image/` (with
  `assets/image.rgb`). `widgets/.gitkeep` is removed.
- `sdk/abi/` whole (new): `README.md`, `fonts/` (the two BDF files and the
  Spleen licence), `modules/` (the four `.wasm` files), `scenes/` (six
  scene files), `golden/` (one directory of PNGs per scene).
- `.github/workflows/ci.yml` (the step of AC-21). A sensitive path: the
  security review checks that no step of `test` is removed or weakened.
- `dev-logs/` (the implementation's log: the toolchain and feature list
  found for AC-3, module sizes, the check script's run time).

Interfaces other work builds on: the ABI document (`firmware-wasm-runtime`
and `simulator-engine` implement it and add no import it lacks); the files
under `sdk/abi/` (both run every scene against the golden frames and load
the committed modules; the firmware's compiled-in placement table follows
the `spike` scene); the SDK's public API (`first-builtin-widget`); the
host's library API and `pn-host` (`layout-editor`'s parity test); the check
script (later widget children add their modules and scenes to it).

## 7. Verification

- The check script exits 0 on the implementation PR's head, run by the
  implement stage on the laptop and by CI's `test` job; the PR description
  quotes its summary lines (each step and its result) and the output of
  `pnpm test`, which still passes.
- The reproducibility of AC-19 is shown once by the implement stage (two
  clean builds at different paths, equal SHA-256 for each module) and on
  every CI run by the comparison with the committed modules.
- A deliberate break is tried and reverted before the PR is opened, and the
  dev-log records each result: one pixel changed in a golden frame makes
  `pn-host check` exit 1 naming that frame and pixel; a committed module
  replaced by another build flag's output fails the check script; an import
  renamed in a test module is refused at load.
- The reviewer reads `docs/widget-abi.md` against section 3.1 rule by rule,
  and looks at the golden frames of `spike` and `probe` in the PR against
  section 4.
- The design stage's renders of `spike-widgets` are on `main` before the
  implementation is planned (the UI design gate).

## 8. Open decisions

None.
