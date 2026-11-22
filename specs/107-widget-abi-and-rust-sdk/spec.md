# 107. Widget ABI v0 draft, the Rust SDK, the three spike widgets and a Rust test host with golden frames

Status: written 2026-11-22 for issue #430, the planned child
`widget-abi-and-rust-sdk` of the v0 build design; a spec derived from its
parent design needs no maintainer approval (delivery-system design section
11). *(agent's call)* Revised 2026-11-22 after the plan stage kept failing
with `profile not available: widget`: section 2 now says why that
failure changes nothing in this spec; no criterion changed.
Class: product. Domain: widget (sensitive path: `.github/workflows/ci.yml`,
under `.github/`; process-spec section 5).
Parent: docs/designs/product-v0-build.md
Derives from: [v0 build design](../../docs/designs/product-v0-build.md)
sections 3 and 4 ("One ABI, three hosts", "Geometry is configuration",
"Checks arrive with the layer") and its planned child
`widget-abi-and-rust-sdk`; [product spec](../../docs/product-spec.md)
sections 3.2 (retained layers), 3.3 (host API), 3.4 (ABI versioning), 9.2
(Rust is the primary SDK, the ABI is published), 12 (milestone 1) and 13
(conformance suite and golden pixel tests; rustfmt, clippy pedantic as
errors, cargo-deny, cargo-nextest); [design-tree](../../docs/design-tree.md)
R2.Q8 (runtime spike first), R3.Q1 (retained layers), R3.Q2 (Rust primary,
ABI published), R3.Q3 (host fonts), R5.Q6 (ABI conformance and golden pixel
tests), R9.Q3 (ABI versioning);
[ADR 0016](../../docs/decisions/0016-product-breakdown-is-one-ordered-design.md);
[ADR 0017](../../docs/decisions/0017-widget-abi-v0-shape.md) (the shape of
the ABI and of the conformance material).

## 1. Goal

`sdk/rust/` and `widgets/` hold only `.gitkeep`, and nothing says what a
widget module is. After this spec:

- `docs/widget-abi.md` is the widget ABI, version 0.1: what a module exports,
  what it may import, how a host steps it and composes its layer, exactly
  enough that three hosts written from it produce the same pixels.
- `sdk/rust/panelator-widget` is the Rust SDK on that ABI.
- `widgets/` holds the three spike widgets of product spec 12.1 (a clock at
  1 Hz, scrolling text at 60 Hz, a 24 KB image blit at 30 Hz), compiled to
  WASM in CI.
- `sdk/rust/test-host` is a Rust test host: the reference implementation of
  the retained-layer model, which runs modules as a *scene* and writes
  frames.
- `sdk/conformance/` holds the scenes, the font and asset bytes and the
  golden frames of the three widgets. It is the start of the conformance
  suite of product spec 13: `firmware-wasm-runtime` and `simulator-engine`
  implement the document and are tested against these frames.

## 2. Out of scope

- **The rest of the host API**: data feeds, feed age, events, the key-value
  store, logging, host animations (scroll, fade), Unifont, truffle-shuffle
  and uploaded fonts, the overrun and inactive-screen rules (product spec
  3.2, 3.3): `rest-of-v0`. The scrolling text here moves by its own per-frame
  code on purpose; it is the spike's 60 Hz load.
- **The manifest file** (product spec 10), size constraints beyond one
  declared size, and whatever config reading the built-in clock needs beyond
  AC-9: `screen-config-and-type-sharing` and `first-builtin-widget`.
- **ABI range enforcement** and how long a previous major stays supported
  (product spec 3.4): `rest-of-v0`. This spec fixes how the version is
  written and what the test host accepts.
- **The asset pipeline** (upload, transcoding, storage, gifs' timing;
  product spec 5.3). AC-8 fixes only the bytes a host blits.
- **The device runtime, the browser engine and the measurement**:
  `firmware-wasm-runtime`, `simulator-engine`, `runtime-spike-measurement`.
  The memory limit of AC-3 is a draft; the published widget budget is the
  measurement's.
- **The AssemblyScript SDK, the SDK template and SDK guide** (product spec
  9.2, 14): `rest-of-v0`.
- **The widget implementation profile.** `agents/profiles/` has no `widget`
  directory, so a plan whose domain is `widget` stops with
  `profile not available` (`agents/stages/plan.md`). Adding it is
  delivery-system work tracked by issue #459; this spec's implementation
  starts once it exists and changes nothing under `agents/`. That failure
  is not a gap in this spec, and no revision of it is the remedy. The work
  lies in `sdk/` and `widgets/` because the issue and the parent design put
  it there, so its domain is `widget`, and the plan prompt rules out
  planning it under `backend` to get past the check: the implementation
  and its review need the widget profile's tools and criteria (the pinned
  toolchain with the WASM target, the golden frames). Nothing here is to be
  moved to another directory, split off or reworded so that a plan passes
  before the profile exists. A plan or spec run that meets
  `profile not available: widget` has found issue #459 still open; the
  remedy is that issue, and until it merges this issue waits or is taken
  up again afterwards. *(agent's call, revision of 2026-11-22: the spec was
  sent back to be changed so the plan stops failing; the only changes that
  would do that are the ones this paragraph rules out.)*
- Any change to the sensitive-path list, the security review criteria or
  what routes a diff to the security review.

## 3. Acceptance criteria

Definitions. *The document* is `docs/widget-abi.md`. *The workspace* is the
Cargo workspace whose root is the repository root (section 4). *The host* is
the crate `panelator-test-host` in `sdk/rust/test-host/`. *The SDK* is the
crate `panelator-widget` in `sdk/rust/panelator-widget/`. *A spike module*
is the `.wasm` file built from one of the three widget crates by AC-13's
build. *A tick* is one 60 Hz step of the compositor, numbered from 0 for
each scene. Integer division rounds toward zero; all arithmetic in the
drawing and composition rules is on integers. Everything this section says
of the ABI is written in the document (AC-1); the document is the normative
text for the other hosts and this section is what the document must say.

**The document and the module**

- AC-1. **The document.** Given `docs/widget-abi.md`, then it states, each
  under its own heading: the version (AC-2); the module's form and limits
  (AC-3); the exports (AC-4); the imports as one table with module name,
  function name, parameter types, result type and meaning (AC-6 to AC-10);
  the layer and the drawing rules with the line and circle algorithms as
  pseudo-code (AC-6, AC-7); fonts and text (AC-7); assets (AC-8); the
  stepping and composition rules (AC-5, AC-11); the conformance profile and
  where its files are (AC-11, AC-12); and a list "Not in 0.1" naming the
  parts of product spec 3.2 and 3.3 this version leaves out. Given the
  import table in the document, the functions the host registers and the
  `extern` block of the SDK, then the three name the same functions with the
  same signatures (a test in the host reads the document's table and the
  SDK's source and fails on any difference), and the union of the imports of
  the three spike modules is exactly that list.
- AC-2. **Version.** The ABI version is `major.minor`, here `0.1`. A change
  that makes a conforming module or host stop conforming bumps the major
  (product spec 3.4); an addition bumps the minor. A module states the
  version it was built for through `pn_abi_version` (AC-4) as
  `(major << 16) | minor`. Given a module whose major differs from the
  host's, or whose minor is greater than the host's, when the host loads it,
  then the load fails with an error naming both versions and no export other
  than the declarations has been called. The host's version is 0.1.
- AC-3. **Module form.** A widget is one core WebAssembly module (no
  component model). It imports nothing but functions of AC-6 to AC-10 from
  the import module `panelator`; it exports its one linear memory as
  `memory`; it has no start function. It uses only the WebAssembly features
  the document lists, which are the ones the stable Rust
  `wasm32-unknown-unknown` target enables by default at the pinned toolchain
  (AC-13) and never threads, SIMD, exception handling, tail calls, GC,
  memory64, multiple memories or `externref` values. Its memory is at most 4
  pages (256 KiB) at any time: a module declaring a larger initial memory is
  refused, and `memory.grow` past the limit returns -1 *(agent's call: a
  draft limit so that a default Rust build, which reserves 1 MiB of stack,
  is caught here and not on the board; the published budget comes from
  `runtime-spike-measurement`)*. Given a module that breaks any of these,
  when the host loads it, then the load fails with an error naming the rule
  and the offending import, export or feature.
- AC-4. **Exports.** Besides `memory`, a module exports exactly these
  functions; a missing one or a wrong signature fails the load, naming it.

  | Export | Signature | Meaning |
  |---|---|---|
  | `pn_abi_version` | `() -> i32` | AC-2 |
  | `pn_update_hz` | `() -> i32` | the declared update rate: 0 for "on data change only", 1 to 60 for that many updates a second; any other value fails the load |
  | `pn_width`, `pn_height` | `() -> i32` | the declared size in LEDs, each 1 to 4096; any other value fails the load |
  | `pn_init` | `()` | called once, after the declarations and before any update; it may draw |
  | `pn_update` | `(tick: i64)` | called when an update is due (AC-5) with the current tick; it may draw |

  The four declarations are constant, take no host state and call no import;
  a host calls them once, after instantiation and before `pn_init`. Until
  the manifest exists they are the only declaration of rate and size; a
  placement's actual size is the layer's (AC-6).
- AC-5. **When a widget is called.** For a placement with declared rate
  `hz`, an update is due at tick `t` when `t == 0`, or when `hz > 0` and
  `(t * hz) / 60 != ((t - 1) * hz) / 60`. So 60 Hz is every tick, 30 Hz
  every second tick, 1 Hz every 60th, and a widget whose update was skipped
  on a device still sees the true tick. With `hz == 0` the only update of
  version 0.1 is the one at tick 0. Within a tick, due placements are
  updated in ascending z, ties by their order in the scene; all updates of a
  tick come before its composition (AC-11). Given a module that returns from
  `pn_update` at ticks 0 to 119 with `hz` 1, 7, 30 and 60, then it was
  called 2, 14, 60 and 120 times, at exactly the ticks the rule gives (a
  host test with a counting module written in WAT).

**The imports** (import module `panelator`; every parameter and result is
`i32` unless shown; a colour is `0xRRGGBBAA` in one `i32`)

- AC-6. **The layer and the shape calls.** Each placement owns a layer of
  its own width and height, one RGBA pixel of 8 bits a channel per LED,
  every pixel `0x00000000` when the placement starts. Nothing but the
  placement's own calls changes it, and it keeps its content between calls.
  A draw call **sets** the pixels it covers to the colour, alpha included;
  nothing is blended inside a layer. Coordinates are layer pixels, origin
  top-left, x to the right, y down; every call clips to the layer, and any
  coordinate or size is legal.

  | Import | Meaning |
  |---|---|
  | `layer_width() -> i32`, `layer_height() -> i32` | the layer's size |
  | `draw_fill(color)` | every pixel |
  | `draw_pixel(x, y, color)` | one pixel |
  | `draw_line(x0, y0, x1, y1, color)` | Bresenham's line, both ends included, by the document's pseudo-code |
  | `draw_rect(x, y, w, h, color, filled)` | `filled != 0`: the `w` by `h` pixels from `(x, y)`; else their one-pixel border; nothing when `w <= 0` or `h <= 0` |
  | `draw_circle(cx, cy, r, color, filled)` | the midpoint circle of radius `r` by the document's pseudo-code; `filled != 0` also sets every pixel between the outline's leftmost and rightmost pixel of each row; `r == 0` is one pixel, `r < 0` nothing |

  Given the document's pseudo-code and the host's rasteriser, then host unit
  tests pin, as pixel lists or small committed images: lines in all eight
  octants, horizontal, vertical and single-point lines; rectangles of sizes
  0, 1, 2 and larger in both modes; circles of radius 0 to 8 in both modes;
  each shape partly and wholly outside the layer, with negative coordinates
  and with coordinates near `i32::MAX` (no overflow, no panic, bounded
  time: a call's cost is bounded by the layer's size, not by its
  arguments).
- AC-7. **Text with a host font.** `draw_text(font, x, y, ptr, len, color)
  -> i32` draws the UTF-8 string of `len` bytes at `ptr` in the module's
  memory with its first cell's top-left at `(x, y)`, on one line, setting
  only the pixels the glyphs have set (the rest of each cell is untouched),
  and returns the advance in pixels. `text_width(font, ptr, len) -> i32`
  returns the same advance without drawing. `font_height(font) -> i32`
  returns the font's cell height. Version 0.1 has two fonts, both Spleen
  (product spec 3.3): font 1 is Spleen 5x8, font 2 is Spleen 8x16; the ids
  are part of the ABI. Their glyphs are the BDF files under
  `sdk/conformance/fonts/` (AC-12): a glyph's set pixels are the BDF
  bitmap's one bits placed by its `BBX` and the font's ascent, and its
  advance is its `DWIDTH`. A code point with no glyph in the font, and each
  byte that is not part of a well-formed UTF-8 sequence, draws nothing and
  advances by the font's bounding-box width. An unknown font id draws
  nothing and returns -1. Host tests cover: every printable ASCII character
  in both fonts against the BDF bitmaps, a string clipped at each edge, a
  missing glyph, a malformed byte and an unknown font.
- AC-8. **Image blit from a named asset.** `draw_image(name_ptr, name_len,
  frame, x, y) -> i32` sets the layer's pixels from frame `frame` (from 0)
  of the asset whose name is the UTF-8 string given, top-left at `(x, y)`,
  each with alpha 255, clipped, and returns 0. It returns -1 and draws
  nothing when the host has no asset of that name, -2 when the frame does
  not exist. An asset is frames of raw RGB, 3 bytes a pixel, rows top to
  bottom, frames one after another; its name, width, height and frame count
  are the host's metadata (in a scene, AC-11; how a board stores them is the
  asset children's). The module never holds the image bytes (product spec
  5.3: the board only blits). Host tests cover a blit inside, across each
  edge and wholly outside the layer, the second frame of a two-frame asset,
  and both errors.
- AC-9. **Read config.** A placement's config is one JSON document in UTF-8
  whose top level is an object; a placement with no config has `{}`.
  `config_len() -> i32` returns its length in bytes; `config_read(ptr, cap)
  -> i32` copies its first `min(cap, length)` bytes to `ptr` and returns
  that count. The document does not change during a placement's life in
  version 0.1.
- AC-10. **Time, timezone and random.** `time_unix_ms() -> i64` returns the
  current time as milliseconds since the Unix epoch, UTC.
  `time_utc_offset_s() -> i32` returns the offset of the board's timezone in
  effect at that time, in seconds east of UTC. `random_u32() -> i32` returns
  32 random bits. In the conformance profile (AC-11) all three are fixed by
  the scene so that frames repeat. A string or buffer argument of any import
  that does not lie inside the module's memory is a trap: the call does not
  return and the placement's run ends in an error (host tests cover a bad
  pointer for `draw_text`, `draw_image` and `config_read`).

**The test host and the conformance material**

- AC-11. **Scenes, stepping and composition.** A scene is a JSON file under
  `sdk/conformance/scenes/` with: `abi` (`"0.1"`); `panel` (`width`,
  `height`: any size, product spec 2); `start_unix_ms`; `utc_offset_s`;
  `ticks`, the ascending list of ticks to capture; `assets` (each `name`,
  `file` relative to `sdk/conformance/assets/`, `width`, `height`,
  `frames`; the file's length must be their product times 3); and
  `placements`, each with `module` (a spike module's name), `x`, `y`,
  `width`, `height`, `z`, `opacity` (0 to 255), `config` (a JSON object)
  and `seed` (a non-zero 32-bit number). The host rejects a scene with an
  unknown or missing field, naming it. Running a scene: every placement is
  loaded (AC-2 to AC-4), given a layer of its `width` by `height`, and
  `pn_init` is called in scene order; then for each tick from 0 to the last
  captured one, the due updates run (AC-5) and the frame is composed. During
  `pn_init` and tick `t`, `time_unix_ms` is `start_unix_ms + (t * 1000) /
  60` (with `t = 0` for `pn_init`), `time_utc_offset_s` is the scene's, and
  each placement's `random_u32` is xorshift32 on its own state, starting at
  its `seed`: `x ^= x << 13; x ^= x >> 17; x ^= x << 5` on 32 bits, the new
  `x` returned. Composition: the frame is `panel.width` by `panel.height`
  RGB, 8 bits a channel, black; layers are applied in ascending z, ties in
  scene order, each at its `(x, y)`, clipped to the panel; for a layer pixel
  with channels `s` and alpha `pa`, `a = (pa * opacity + 127) / 255`, and
  each channel becomes `(s * a + d * (255 - a) + 127) / 255` where `d` is
  the frame's value under it. A trap, or a call that uses more than the
  host's fuel limit (default 10,000,000 units of the engine's fuel, settable
  per run), ends the run with an error naming the placement, the export and
  the tick; no frame is written for that tick or later. Given the same
  scene and modules, then two runs produce byte-identical output.
- AC-12. **The conformance directory.** `sdk/conformance/` holds
  `README.md` (what each part is, how another host uses it, how frames are
  regenerated); `fonts/spleen-5x8.bdf` and `fonts/spleen-8x16.bdf`,
  unmodified from one named upstream Spleen release, with its licence file
  beside them; `assets/spike-image.rgb`, 24,576 bytes (128 by 64, one
  frame), whose pixel at `(x, y)` is `R = (x * 255) / 127`, `G = (y * 255) /
  63`, `B = 255` when `(x / 8 + y / 8)` is even and 0 otherwise (a host test
  recomputes it); the four scenes of AC-17; and for each scene
  `golden/<scene>/tick-<n>.png` (the frame as an 8-bit RGB PNG, one per
  captured tick) and `golden/<scene>/frames.json`: the scene's name, the
  panel size and, per captured tick, the SHA-256 in hex of the frame's raw
  bytes (RGB, rows top to bottom). The hashes are what a host that cannot
  read PNG compares against. A host test fails when a PNG's pixels and its
  hash disagree, when a golden file exists for a tick the scene does not
  capture, or when one is missing.
- AC-13. **Building the modules.** `rust-toolchain.toml` at the repository
  root pins one stable Rust release by full version with the components
  `rustfmt` and `clippy` and the target `wasm32-unknown-unknown` (given the
  file already exists when this is implemented, then it is kept and the
  target and components added). `sdk/rust/build-widgets.sh` builds the three
  widget crates for that target in release mode with a stack small enough
  for AC-3 and writes `target/widgets/spike-clock.wasm`,
  `spike-scroll.wasm` and `spike-image.wasm`. Each passes the host's load
  checks and is at most 64 KiB. Modules are not committed: the frames are
  the contract, and a module built by another toolchain build must still
  produce them (ADR 0017).
- AC-14. **The host's commands.** `panelator-test-host run <scene>
  --modules <dir> --out <dir>` writes `tick-<n>.png` and `frames.json` in
  AC-12's form for that scene. `panelator-test-host check <scene> --modules
  <dir> --golden <dir>` runs the scene and exits 0 when every captured frame
  equals its golden frame; otherwise it exits 1, prints for the first
  differing tick the tick, the first differing pixel's coordinates and both
  colours, and, given `--actual <dir>`, writes the frames it produced there.
  `panelator-test-host inspect <module>` prints the module's declarations,
  imports and memory size, or the load error. Both `run` and `check` take
  `--fuel <n>`. The host is also a library: loading, stepping, the
  rasteriser and composition are public functions the tests use. The engine
  is `wasmi` *(agent's call: an interpreter in pure Rust with fuel metering;
  the host needs repeatability and a small dependency tree, not speed)*.
- AC-15. **The golden test.** Given the built spike modules, when the
  workspace's tests run, then one test per scene runs the scene and requires
  every frame to equal its golden PNG and its hash; a difference fails with
  AC-14's report. Given the environment variable `PANELATOR_BLESS=1`, then
  the same tests write the golden files instead of comparing; CI never sets
  it. Given the modules are not built, the tests fail saying so (they are
  not skipped).

**The SDK and the widgets**

- AC-16. **The SDK.** `panelator-widget` is `no_std`, depends on no crate
  that needs an allocator, and is the only crate here that contains
  `unsafe`. It offers: a `Color` type (RGBA, with constants for transparent,
  black and white); `layer::size()`; `draw::{fill, pixel, line, rect,
  fill_rect, circle, fill_circle}`; `Font` (the two fonts) with
  `draw::text`, `text::width` and `Font::height`; `image::blit(name, frame,
  x, y)` returning a `Result` whose error distinguishes AC-8's two cases;
  `config::read(&mut [u8])` and typed readers of a top-level member by key
  (`config::str`, `config::i64`, `config::bool`, each returning `None` for a
  missing key or another type; a string is returned unescaped into a
  caller's buffer); `time::now()` (Unix milliseconds) and
  `time::utc_offset()` (seconds), with a function turning the two into
  local year, month, day, hour, minute and second; `random::u32()`; and a
  `Widget` trait (`const UPDATE_HZ: u8`, `const SIZE: (u16, u16)`, `fn
  init() -> Self`, `fn update(&mut self, tick: u64)`) with a `widget!`
  macro that, given a type implementing it, emits every export of AC-4 and
  the panic handler (a panic is a trap). A widget crate that uses the macro
  contains no `unsafe` (`#![forbid(unsafe_code)]`) and no `extern` block.
  The SDK's pure parts (the config readers, the date arithmetic) have unit
  tests that run on the build machine's own target: the config readers
  against nested values, escapes, a truncated document and a non-object;
  the date function against 1970-01-01, a leap day, a year's last second
  and a negative offset. Every public item is documented, and the crate's
  README shows a complete widget.
- AC-17. **The three spike widgets and their scenes.** Each is a crate in
  `widgets/` on the SDK, licensed Apache-2.0. What each draws is below; the
  pixel positions and colours are the design's (section 6).

  | Crate | Rate | Declared size | Each update |
  |---|---|---|---|
  | `spike-clock` | 1 Hz | 64 by 32 | clears the layer to transparent, then draws the local time `HH:MM:SS` in font 2, the local date `YYYY-MM-DD` in font 1, a seconds bar (an outlined rectangle, inside it a filled rectangle whose width grows with the second, and single-pixel marks at 0, 15, 30 and 45), a line separating time from date, and a circle that is filled on even seconds and outlined on odd ones |
  | `spike-scroll` | 60 Hz | 128 by 16 | fills the layer with a background colour, then draws the config's `text` (default `panelator`) in font 2 at `x = W - (tick % (W + text width))`, `W` the layer's width, so it enters at the right edge and leaves at the left; the text colour is one of six, chosen by `random_u32() % 6` at `pn_init` and again at each tick where `tick % (W + text width) == 0` and `tick > 0` |
  | `spike-image` | 30 Hz | 128 by 64 | blits the asset named by the config's `asset` (default `spike-image`) twice, at `x = -o` and `x = W - o` with `o = (tick / 2) % W`, so the whole image is drawn each update and it wraps; when the blit fails it fills the layer with opaque magenta |

  Between them the three call every import of AC-6 to AC-10 (AC-1). The
  scenes, all with `start_unix_ms` 1798757998000 and `utc_offset_s` 3600
  (two seconds before midnight, 1 January 2027, local time, so the frames
  cross a minute, a day and a year):

  | Scene | Panel | Placements (module at x, y, size, z, opacity; config; seed) | Captured ticks |
  |---|---|---|---|
  | `spike-clock` | 64 by 32 | clock at 0, 0, 64 by 32, z 0, 255; `{}`; 1 | 0, 59, 60, 119, 120, 180 |
  | `spike-scroll` | 96 by 16 | scroll at 0, 0, 96 by 16 (not its declared size), z 0, 255; `{"text": "panelator 60 Hz"}`; 2 | 0, 1, 2, 48, 95, 215, 216, 217, 500 |
  | `spike-image` | 128 by 64 | image at 0, 0, 128 by 64, z 0, 255; `{}`; 3 | 0, 1, 2, 3, 128, 254, 255, 256 |
  | `spike` | 128 by 64 | image at 0, 0, 128 by 64, z 0, 255, `{}`, 3; clock at 0, 0, 64 by 32, z 1, 200, `{}`, 1; scroll at 0, 48, 128 by 16, z 2, 255, `{"text": "panelator 60 Hz"}`, 2 | 0, 1, 2, 60, 120, 248, 256, 599 |

  `spike` is the three together as the board will run them: overlap, z-order,
  a transparent layer over an image and a layer opacity below 255. Golden
  frames for all four are committed, produced by the host from the built
  modules. Given the `spike-clock` scene, then the frame at tick 0 shows
  `23:59:58` and `2026-12-31` and the frame at tick 120 shows `00:00:00`
  and `2027-01-01` (a test reads these from the widget's formatting
  function, not from pixels). Given the `spike-image` scene, then the frame
  at tick 0 equals the asset and the frame at tick 256 equals the frame at
  tick 0.

**Checks**

- AC-18. **The Rust checks of product spec 13.** `sdk/rust/check.sh` runs,
  and fails when any fails: `cargo fmt --all --check`; clippy with
  `clippy::pedantic` and all warnings as errors over the host and the SDK
  with all targets on the build machine's target, and over the SDK and the
  three widgets on `wasm32-unknown-unknown`; `cargo deny check` with a
  committed `deny.toml` (advisories, bans, sources limited to crates.io,
  and a licence allow-list of OSI-approved licences); AC-13's build; and
  `cargo nextest run` over the workspace, which includes AC-15. Any
  `allow` of a pedantic lint is on the smallest item it applies to, with
  its reason.
- AC-19. **CI.** The `test` job of `.github/workflows/ci.yml` installs the
  toolchain `rust-toolchain.toml` names and `cargo-nextest` and `cargo-deny`
  at pinned versions, caches Cargo's registry and `target/`, runs
  `sdk/rust/check.sh`, and uploads the three spike modules as the artifact
  `spike-widgets`. Its existing steps stay as they are and `pnpm test` runs
  what it ran before; the required check stays `test`, so a failing Rust
  check blocks a merge. Any third-party action it adds is pinned by commit
  SHA.

## 4. Interfaces and files

New:

- `docs/widget-abi.md`: the document (AC-1).
- `Cargo.toml`, `Cargo.lock`: the workspace at the repository root, with
  the members `sdk/rust/panelator-widget`, `sdk/rust/test-host`,
  `widgets/spike-clock`, `widgets/spike-scroll` and `widgets/spike-image`,
  `backend` and `firmware` excluded, shared lint settings, and a release
  profile for the widgets (size-optimised, `panic = "abort"`). *(agent's
  call: the SDK and the widgets are siblings under the root, so the root is
  the one directory a single workspace, lockfile and `target/` can sit in;
  the backend keeps its own workspace, product spec 5.)*
- `rust-toolchain.toml`, `deny.toml`, `.cargo/config.toml` (the
  `wasm32-unknown-unknown` link arguments, the stack size among them).
- `sdk/rust/panelator-widget/` (the SDK), `sdk/rust/test-host/` (the host,
  library and binary, with its tests and test modules in WAT),
  `sdk/rust/build-widgets.sh`, `sdk/rust/check.sh`, `sdk/rust/README.md`.
- `widgets/spike-clock/`, `widgets/spike-scroll/`, `widgets/spike-image/`.
- `sdk/conformance/`: `README.md`, `fonts/`, `assets/`, `scenes/`,
  `golden/` (AC-12).

Changed:

- `.github/workflows/ci.yml` (sensitive path): AC-19.
- `sdk/rust/.gitkeep`, `widgets/.gitkeep`: removed.
- `README.md`: one line pointing to the document.

The ABI's surface, for the hosts that follow:

```
exports   memory, pn_abi_version, pn_update_hz, pn_width, pn_height, pn_init, pn_update(i64)
imports   panelator.{layer_width, layer_height, draw_fill, draw_pixel, draw_line, draw_rect,
          draw_circle, draw_text, text_width, font_height, draw_image, config_len, config_read,
          time_unix_ms -> i64, time_utc_offset_s, random_u32}
```

## 5. Verification

- `sdk/rust/check.sh` passes locally and in CI (AC-18, AC-19); its output is
  in the implementation's final message beside `pnpm test`'s.
- The host's tests: load rules with small modules written in WAT, one per
  rule of AC-2 to AC-4; the due rule (AC-5); the rasteriser, text, blit,
  config and trap tests of AC-6 to AC-10; scene parsing, the clock, the
  random sequence (its first values for a seed, written in the document),
  composition (two overlapping layers with alpha and opacity at 0, 1, 127,
  128, 254 and 255 against values computed by hand) and repeatability
  (AC-11); the conformance directory's consistency (AC-12); the three-way
  import list (AC-1).
- The golden tests (AC-15) and the named frames of AC-17.
- The SDK's unit tests (AC-16).
- A reviewer can open the golden PNGs in the PR and compare them with the
  design's renders (section 6).
- The machine that implements this needs the pinned toolchain with the
  `wasm32-unknown-unknown` target, `cargo-nextest` and `cargo-deny`; a
  distribution's `rust` package without that target cannot build the
  modules or produce the golden frames.

## 6. UI design

Screens: spike-clock, spike-scroll, spike-image, spike-scene

The three spike widgets are measuring loads, not the product's built-in
widgets (the built-in clock and its design are `first-builtin-widget`), so
the design is small: it fixes where each element of AC-17 sits and its
colour. Each screen shows the layer as raw pixels, one square per LED,
enlarged, on black, with no emulated LED look (that is `layout-editor`).

- `spike-clock`: the 64 by 32 layer. States: `even-second` (`23:59:58`,
  `2026-12-31`, the circle filled) and `odd-second` (`23:59:59`, the circle
  outlined). Font 2 is 8 by 16 a cell, so the time is exactly 64 wide; font
  1 is 5 by 8, so the date is 50 wide.
- `spike-scroll`: the 128 by 16 layer with the text `panelator 60 Hz`.
  States: `entering` (the text partly in at the right edge) and `leaving`
  (partly out at the left). The design names the background colour and the
  six text colours, in order.
- `spike-image`: the 128 by 64 layer showing AC-12's image. States:
  `offset-0` and `offset-40` (the wrap visible).
- `spike-scene`: the 128 by 64 panel of scene `spike`: the image, the clock
  over it at the top-left at opacity 200 with the image showing through its
  transparent pixels, the scroll along the bottom.

`flow.md` gives, for every element, its rectangle in layer pixels and its
colour as `0xRRGGBBAA`; the implementation takes those values. The stories
may approximate glyph shapes; cell sizes, positions and colours are binding,
and the glyphs are the BDF files'. Every colour is readable on black and on
the image. There is no interaction and no flow between screens.

## 7. Open decisions

None.
