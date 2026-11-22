# 107. Widget ABI 0.1, the Rust SDK, the three spike widgets and a Rust test host with golden frames

Status: written 2026-11-22 from `docs/designs/product-v0-build.md` for issue
#430 (planned child `widget-abi-and-rust-sdk`); a spec derived from its parent
design needs no maintainer approval (delivery-system design section 11).
Class: product. Domain: backend.
Parent: docs/designs/product-v0-build.md
Derives from: [product spec](../../docs/product-spec.md) sections 2 (geometry
is configuration), 3.1, 3.2, 3.3, 3.4, 9.2, 12 item 1, 13 and 14;
[design-tree](../../docs/design-tree.md) R2.Q3 (WASM), R3.Q1 (retained
layers), R3.Q2 (Rust primary, ABI published), R3.Q3 (host fonts), R4.Q1 (host
API v0), R4.Q8 (spike criteria), R5.Q5 (Rust tooling), R5.Q6 (ABI conformance
and golden pixel tests first), R9.Q3 (ABI versioning);
[product-v0-build](../../docs/designs/product-v0-build.md) section 4 ("One
ABI, three hosts", "Geometry is configuration", "Checks arrive with the
layer"); [ADR 0016](../../docs/decisions/0016-product-breakdown-is-one-ordered-design.md).

`Domain:` here is the spec's own vocabulary (spec 077, out of scope): it only
decides whether a UI design is drawn first. The work lies in `sdk/`, `widgets/`
and `docs/`, so the plan stage's `domain` is `widget` by its own rule; that
profile is issue #459's work.

## 1. Goal

Milestone 1 needs one written contract between a widget module and whatever
runs it, before the device runtime and the browser engine are built against
it. After this spec:

- `docs/widget-abi.md` is the widget ABI, version 0.1: what a module exports
  and imports, what every drawing call does to which pixel, how layers are
  composed, when a widget is called, and the deterministic mode all hosts are
  tested in. Section 4 of this spec fixes its content.
- `sdk/rust/` holds the Rust SDK on that ABI and a Rust test host that runs
  modules against the retained-layer model and writes frames.
- `widgets/` holds the three spike widgets of product spec 12 (a clock at
  1 Hz, scrolling text at 60 Hz, a 24 KB image blit at 30 Hz) and one probe
  module that exercises every import.
- `sdk/conformance/` holds the start of the conformance suite: the built
  modules, scenarios, the image asset, the font sources and golden frames.
  `firmware-wasm-runtime` and `simulator-engine` run the same files and must
  produce the same frames.
- CI builds the modules and runs the Rust checks of product spec 13 on all of
  it, inside the required `test` job.

Everything that follows marked *(agent's call)* is this spec's technical
choice. The ABI is a draft at major 0; the spike may change it, by a change to
these files in the same PR as the hosts that need it (parent design section 4).

## 2. Out of scope

- Feeds and feed staleness, events, the key-value store, logging, host
  animations (scroll, fade), the overrun and inactive-screen rules, the fonts
  beyond the two below and uploadable fonts, the manifest file, size and
  memory caps (they come from the spike's numbers), the backend's refusal of
  an unsupported ABI version, the AssemblyScript SDK and the SDK templates:
  later children (`first-builtin-widget`, `rest-of-v0`).
- The device runtime, the browser engine and the measurement:
  `firmware-wasm-runtime`, `simulator-engine`, `runtime-spike-measurement`.
  This spec adds no file under `firmware/`, `web/` or `backend/`.
- An asset container format and asset storage. A scenario states an asset's
  width, height and frame count beside a file of raw pixels (section 4.9).
- A UI design. The four modules are measurement loads and test fixtures with
  no manifest; what each draws is fixed pixel for pixel by AC-6 to AC-9 and
  the golden frames. The first widget a user installs, and its UI design, is
  `first-builtin-widget`.
- An implementation profile for the `widget` domain (issue #459), and
  installing a toolchain on the maintainer's laptop beyond what AC-12 says.
- Any change to `package.json`, `pnpm-workspace.yaml`, `vitest.config.ts` or
  `AGENTS.md`. `pnpm test` keeps running what it runs today.

## 3. Acceptance criteria

- AC-1. **The ABI document exists and is complete.** Given the merged PR, then
  `docs/widget-abi.md` states everything in section 4 of this spec as
  normative text (it may reword and add examples, and changes no rule), names
  its version `0.1`, and says that the files in `sdk/conformance/` are the
  test of a host. A reader with only that document and `sdk/conformance/` can
  implement a host; nothing in it refers to Rust, the SDK or WAMR for a rule.

- AC-2. **The SDK.** Given `sdk/rust/panelator-widget/`, then it is a
  `no_std` library crate needing no allocator, with no dependency outside the
  repository in a widget's build, that gives a widget author: a colour type; a
  safe function for each import of section 4.4 to 4.7 (outline and filled
  forms of `rect` and `circle` as separate functions); the two fonts with
  their cell sizes as constants; access to the config bytes and to a
  top-level string, integer or boolean member of the config object by key; a
  trait with the declared rate, the three sizes, `init` and `update`; and one
  macro that turns a type implementing the trait into the exports of
  section 4.2, with `pn_abi_version` returning the SDK's version. A widget
  crate using the SDK contains no `unsafe` and no `extern` block of its own.
  The crate's public items carry doc comments, and its `README.md` shows a
  complete widget. The ABI's numbers (version, font ids, the rate limit) are
  defined once, in this crate, and the test host takes them from it.

- AC-3. **The modules are WebAssembly 1.0.** Given each of the four modules in
  `sdk/conformance/modules/`, then it validates with every proposal after
  WebAssembly 1.0 disabled except mutable-globals, imports only functions of
  module `panelator` named in section 4, exports what section 4.2 requires,
  and declares an initial memory of one page (64 KiB). The widgets are built
  for the Rust target `wasm32v1-none` with a 16 KiB stack *(agent's call:
  that target emits exactly this feature set from a stable toolchain, and
  Rust's default 1 MiB stack would cost every placement on the board seventeen
  pages)*.

- AC-4. **The committed modules are what the source builds.** Given a clean
  checkout, when `sdk/check.sh` builds the four widget crates, then each
  output equals the committed file of the same name in
  `sdk/conformance/modules/` byte for byte, and the script fails naming the
  file otherwise. The build is made reproducible for that: the toolchain is
  pinned exactly, `Cargo.lock` is committed, the release profile has one
  codegen unit, LTO, `panic = "abort"`, `opt-level = "s"` and stripped
  symbols, and absolute paths are remapped. *(agent's call: the modules are
  committed so that the board, the test host and the browser load the same
  bytes, which is what product spec 12 means by "identical modules", and so
  that the firmware and web builds need no Rust toolchain; the same rule as
  `schemas/` in product spec 6.)* `sdk/check.sh --bless` rewrites the
  committed modules and the golden frames from the source.

- AC-5. **The test host.** Given `sdk/rust/panelator-host/`, then it is a
  library and a binary. The library holds the layer, every drawing rule of
  section 4, the compositor and the scheduler as code usable without a WASM
  engine, and runs modules in a pure-Rust interpreter (`wasmi`) *(agent's
  call: small to build in CI, deterministic, and it has a fuel limit; the
  engine is behind the library and can be changed)*. The binary:
  - `panelator-host run <scenario.json> --out <dir>` writes one PNG (8-bit
    RGB, the scenario's geometry) per captured frame, named by the frame
    index in five digits;
  - `panelator-host check <scenario.json> --golden <dir>` runs the same and
    exits non-zero naming the first frame and pixel whose decoded value
    differs, or a missing or surplus golden file;
  - refuses, before running, with a message naming the cause: a module that
    fails AC-3's validation, an import outside section 4 (named), a missing
    or wrongly typed export (named), an ABI version it does not support, a
    rate outside 0 to 60, a placement size outside the module's declared
    minimum and maximum;
  - fails the run, naming the placement, when a module traps or a call
    exceeds the fuel limit (a default that the spike widgets stay well under,
    settable on the command line).

- AC-6. **The spike clock.** Given `widgets/spike-clock`, then it declares
  1 Hz and the fixed size 40×8, and each update fills its layer with
  transparent black and draws the local time (`time_now` plus
  `time_offset`) as `HH:MM:SS` in opaque white, Spleen 5×8, at (0, 0).

- AC-7. **The spike scroll.** Given `widgets/spike-scroll`, then it declares
  60 Hz, default size 128×16, minimum 16×16 and maximum 4096×16. It reads the
  string member `text` of its config (default `panelator` when absent). On
  its n-th update (n from 0) it fills its layer with `0x80000000` (half
  transparent black) and draws the text in opaque amber `0xFFFFB000`, Spleen
  8×16, at x = W − (n mod (W + T)), y = 0, where W is the layer width and T
  the text's width in pixels: the text enters at the right edge, leaves at
  the left and starts again.

- AC-8. **The spike image.** Given `widgets/spike-image`, then it declares
  30 Hz, default size 128×64, minimum 1×1 and maximum 4096×4096. It reads the
  string member `asset` of its config (default `spike`). On its n-th update it
  blits frame 0 of that asset at (0, 0) and then sets the pixel
  (n mod W, H − 1) to opaque white, so consecutive updates differ. The asset
  of the suite, `sdk/conformance/assets/spike-128x64.rgb`, is 24,576 bytes,
  one 128×64 RGB888 frame whose pixel (x, y) is (2x, 4y, 2·(x xor y)); a test
  regenerates it from that formula and compares.

- AC-9. **The probe.** Given `widgets/abi-probe`, then it declares rate 0 and
  one fixed size, and its single update draws a picture that uses every
  import of section 4 at least once and, among them: pixels inside and
  outside the layer; lines in all eight octants, horizontal, vertical, of one
  pixel, and running off each edge; outline and filled rectangles, among them
  zero and negative sizes and one crossing a corner; outline and filled
  circles of radius 0, 1, 2 and larger, one crossing an edge, one with a
  negative radius; colours with alpha 0, 128 and 255 over earlier drawing;
  text in both fonts, clipped at the right and bottom, with a code point the
  font lacks and an invalid UTF-8 byte, and the returned advance shown as a
  bar of that length; a font id and an asset name that do not exist, each
  shown as one green pixel when the call returned −1 and red otherwise; the
  image blitted at a negative offset; a config string drawn as text; sixteen
  pixels at positions taken from `random`; and the time and offset drawn as
  text. *(agent's call: the three spike widgets use only fill, text, pixel
  and image blit; without the probe, line, rect, circle, random and the
  error returns would have no golden frame, and the other two hosts no test
  for them. It is a fixture of the suite the issue starts, not a fourth
  widget.)*

- AC-10. **Scenarios and golden frames.** Given `sdk/conformance/`, then it
  holds these scenarios in the format of section 4.9, each with a directory of
  golden PNGs of the same name under `golden/`, written by the test host:
  - `clock`: the clock alone on 128×64, starting at local time 23:59:58 with
    a non-zero offset; frames 0, 59, 60, 119, 120 (59 equals 0; 120 shows
    `00:00:00`);
  - `scroll`: the scroll alone on 128×64 with a config text; frames 0, 1, 2,
    the last frame before it wraps and the first after;
  - `scroll-64x32`: the scroll at 64×16 on a 64×32 panel, frames 0, 1 and 80
    (no file of this spec assumes 128×64);
  - `image`: the image alone on 128×64; frames 0, 1, 2, 3 (1 equals 0, 3
    equals 2, 2 differs from 0);
  - `spike`: the three together on 128×64, the image at z 0 filling the
    panel, the scroll at z 1 over its lower rows, the clock at z 2 over its
    upper rows, so both alpha cases are composed; frames 0, 1, 2, 60, 120.
    This is the screen `firmware-wasm-runtime` places by its compiled-in
    table;
  - `probe`: the probe alone on a panel larger than its layer, placed partly
    off the panel's left and top edges; frames 0 and 1 (equal).
  `panelator-host check` passes for every scenario against the committed
  modules. A `README.md` there says how another host runs the suite.

- AC-11. **Tests of the host.** Given `cargo nextest run` in `sdk/rust/`,
  then tests cover at least: each scenario against its golden frames; the
  circle rule of section 4.5 against a brute-force evaluation of its
  definition for radii 0 to 20; the line rule for both endpoints and all
  octants; the blend formula of section 4.8 at alpha 0, 1, 127, 128, 254 and
  255; the due rule of section 4.3 for every rate 0 to 60 (R calls in frames 0
  to 59 and R in each 60 frames after them; exactly one call for rate 0); the
  deterministic random sequence for one seed, with the first four values
  written in the ABI document; each refusal of AC-5 with a module built in
  the test (from text format or hand-assembled bytes); a trap; and a
  memory range outside the module's memory passed to `text`,
  `image` and `config_read`.

- AC-12. **The Rust checks, one script, in the required job.** Given
  `sdk/check.sh`, then it runs, and fails if any fails: `cargo fmt --check`,
  `cargo clippy` with `clippy::pedantic` and all warnings as errors, and
  `cargo deny check` in both workspaces (`sdk/rust/` for the host target,
  `widgets/` for `wasm32v1-none`); the build and comparison of AC-4;
  `cargo nextest run` in `sdk/rust/`. It uses the toolchain that
  `rust-toolchain.toml` at the repository root pins (an exact stable version,
  with `rustfmt`, `clippy` and the target `wasm32v1-none`) through `rustup`,
  looks for `rustup` in `$CARGO_HOME/bin` and `$HOME/.cargo/bin` as well as
  `PATH`, and when `rustup`, `cargo-nextest` or `cargo-deny` is missing it
  fails with a message naming the tool and the command that installs it; it
  never skips a check. `.github/workflows/ci.yml` gains, in the job `test`
  after the existing steps, the installation of that toolchain and of pinned
  versions of `cargo-nextest` and `cargo-deny`, a cache of the cargo
  directories, and one step that runs `sdk/check.sh`; no existing step
  changes. If `main` already has a root `rust-toolchain.toml` when this is
  built (the backend workspace's child may add one), the target and
  components are added to it and its version is kept.
  The implement stage runs `sdk/check.sh` as well as `pnpm test` before it
  reports, and includes both outputs. The maintainer's laptop has a
  distribution Rust without `rustup` or a wasm target today: the implement
  stage installs `rustup` for its own user under `$HOME` with the official
  installer (no `sudo`, the distribution's Rust left in place) and the two
  cargo tools with `cargo install --locked`, and says so in its result
  *(agent's call: it needs no privilege and no credential, so it is not a
  question for the maintainer)*.

- AC-13. **Licences.** Given the PR, then the two Spleen BDF files in
  `sdk/conformance/fonts/` are unmodified files of one named upstream Spleen
  release, with its BSD 2-Clause licence text beside them and the release
  named in the `README.md`; every crate of this spec declares
  `license = "Apache-2.0"`; `sdk/deny.toml` allows only OSI-approved
  permissive licences and denies yanked crates and known advisories.

## 4. Interfaces and files

Sections 4.1 to 4.9 are the content of `docs/widget-abi.md`.

### 4.1 The module

A widget is one WebAssembly 1.0 binary module. It may use mutable-globals and
no other later proposal. It imports only functions, only from the import
module `panelator`, only those listed here; it has no start function. A host
refuses a module that breaks any of this. A host may refuse a module whose
initial memory exceeds a cap the host states; the caps are not part of 0.1.

All integers are little-endian in memory. `i32` arguments holding a pointer
or a length are unsigned.

### 4.2 Exports

| Export | Type | Meaning |
|---|---|---|
| `memory` | memory | the module's linear memory |
| `pn_abi_version` | `() -> i32` | `major << 16 \| minor`; `0x00000001` for 0.1 |
| `pn_update_hz` | `() -> i32` | the declared update rate: 0 for "on data change only", or 1 to 60 |
| `pn_size_default` | `() -> i32` | `width << 16 \| height`, each 1 to 4096 |
| `pn_size_min` | `() -> i32` | the same packing; each axis at most the default's |
| `pn_size_max` | `() -> i32` | the same packing; each axis at least the default's |
| `pn_init` | `(width: i32, height: i32)` | called once, with the placement's layer size, before any update |
| `pn_update` | `()` | draw; called as section 4.3 says |

The five declaring exports return constants, are called once by the host
before `pn_init`, and must not call an import. A widget is resizable on an
axis when its minimum and maximum differ there. A host places a module only
at a size within its minimum and maximum. One instance serves one placement.

Versions (product spec 3.4): a breaking change raises the major, an addition
raises the minor. A host states the versions it supports and refuses a module
whose major it does not support or whose minor is above the host's for that
major. The manifest's declaration of the version is the manifest child's; the
export must then agree with it.

A trap in any export ends the instance: the host calls it no more and its
layer keeps its content. What the user is shown is each host's own matter.

### 4.3 Layers and calls

Each placement owns a layer of its own width and height, of RGBA pixels with
8 bits per channel and straight (not premultiplied) alpha, all zero
(transparent) at `pn_init` *(agent's call: product spec 3.2's RGB layer plus
the alpha its compositor uses, per pixel, so that a widget with a transparent
background can lie over another; overlaps are allowed by product spec 7.2)*.
A widget draws only on its own layer and only by the imports, during
`pn_init` or `pn_update`. The layer is retained between calls.

The host composes frames 0, 1, 2, … at 60 per second. Before frame 0 it calls
`pn_init` of every placement, in placement order. At each frame f it calls
`pn_update` of every placement that is due, in placement order, then composes
(section 4.8). A placement with rate R is due at frame 0, and for R ≥ 1 at
every later frame f where ⌊f·R/60⌋ > ⌊(f−1)·R/60⌋. With rate 0 nothing after
frame 0 causes a call in 0.1; a changed config is applied by instantiating
the module anew. A host that skips a call (the overrun rule, a later child)
changes nothing else in this schedule.

### 4.4 Colours, coordinates, memory

A colour is an `i32` read as `0xAARRGGBB`. Every drawing call replaces the
pixels it covers with that colour, alpha included; nothing is blended inside
a layer. Coordinates, sizes and radii are signed; the origin is the layer's
top-left pixel, x grows right, y down. Each such argument is first saturated
to −32768…32767. Every call is clipped to the layer; no coordinate makes a
call fail.

A pointer and length that do not lie inside the module's memory make the
import trap. Strings are UTF-8, not terminated.

### 4.5 Drawing imports

- `fill(c: i32)`: every pixel of the layer becomes c.
- `pixel(x, y, c)`: the pixel (x, y).
- `line(x0, y0, x1, y1, c)`: both end points and the pixels this loop plots.
  With dx = |x1 − x0|, dy = −|y1 − y0|, sx = sign(x1 − x0), sy =
  sign(y1 − y0), err = dx + dy: plot (x0, y0); stop if it is the end point;
  e2 = 2·err; if e2 ≥ dy then err += dy, x0 += sx; if e2 ≤ dx then err += dx,
  y0 += sy; repeat. (Both tests use the same e2.)
- `rect(x, y, w, h, c, filled)`: nothing when w ≤ 0 or h ≤ 0. Otherwise the
  rectangle is columns x…x+w−1 and rows y…y+h−1; `filled` ≠ 0 covers all of
  it, `filled` = 0 its outermost rows and columns.
- `circle(cx, cy, r, c, filled)`: nothing when r < 0. The disc is every
  pixel with (x − cx)² + (y − cy)² ≤ r² + r. `filled` ≠ 0 covers the disc;
  `filled` = 0 covers the pixels of the disc that have at least one of their
  four edge neighbours outside it. A host may use any algorithm that yields
  exactly these pixels.

All arguments are `i32`; none returns a value.

### 4.6 Text and images

- `text(x, y, font, ptr, len, c) -> i32`: draws the string with the host
  font `font`. Fonts are cells of fixed size; the i-th code point's cell has
  its top-left at (x + i·cell width, y). The set bits of the glyph become c;
  the other pixels of the cell are left as they were. A code point the font
  lacks draws nothing and takes one cell; so does each byte that is not part
  of valid UTF-8. There is no line breaking. Returns the advance in pixels
  (code points × cell width), or −1 with nothing drawn when the font id is
  unknown.
- Fonts of 0.1 *(agent's call: two sizes of the first of product spec 3.3's
  three fonts, enough for the spike; the rest is the fonts work of
  `rest-of-v0`)*: id 1 is Spleen 5×8, id 2 is Spleen 8×16, each with the
  glyphs U+0020 to U+007E. The glyphs are those of `spleen-5x8.bdf` and
  `spleen-8x16.bdf` in `sdk/conformance/fonts/`: bitmap rows top to bottom,
  the most significant bit leftmost, each glyph filling its cell.
- `image(name_ptr, name_len, frame, x, y) -> i32`: copies frame `frame` of
  the asset of that name with its top-left at (x, y), every copied pixel
  opaque. An asset is a sequence of frames of one width and height in RGB888,
  rows top to bottom. Returns 0, or −1 with nothing drawn when the host has
  no asset of that name for this placement or the frame does not exist. How
  assets are named, stored and delivered is not part of 0.1.

### 4.7 Config, time, random

- `config_read(ptr, cap) -> i32`: the placement's config is one JSON object
  encoded in UTF-8 (`{}` when it has none). Copies its first min(length, cap)
  bytes to `ptr` and returns the full length. *(agent's call: JSON because
  the config's schema is JSON Schema and the screen config is JSON, product
  spec 7.4 and 12.)*
- `time_now() -> i64`: milliseconds since the Unix epoch, UTC.
- `time_offset() -> i32`: the offset of the board's timezone from UTC at this
  moment, in seconds, east positive, daylight saving included.
- `random() -> i32`: 32 random bits.

### 4.8 The compositor

The framebuffer is RGB888 at the panel's geometry, which is configuration.
Each frame starts black. Placements are taken in ascending z, equal z in
placement order; a placement's layer has its top-left at the placement's
(x, y), which may lie outside the panel, and is clipped to the panel. For
each layer pixel with alpha a and each channel with layer value s and
framebuffer value d, the framebuffer value becomes
⌊(s·a + d·(255 − a) + 127) / 255⌋.

### 4.9 The deterministic mode and the suite

A host is tested in a mode where, for a scenario: frame f happens at
`start_ms` + ⌊f·1000/60⌋ milliseconds, which `time_now` returns for every
call made at that frame (calls of `pn_init` see frame 0); `time_offset`
returns `utc_offset_s`; and each placement has its own generator whose 32-bit
state starts as `seed` plus the placement's index (wrapping; `0x9E3779B9` if
that is 0), each `random` call doing x ^= x << 13, x ^= x >> 17, x ^= x << 5
and returning x. No call is skipped.

A scenario is a JSON file; paths are relative to it:

```json
{
  "geometry": { "width": 128, "height": 64 },
  "start_ms": 1767311998000,
  "utc_offset_s": 3600,
  "seed": 1,
  "assets": [{ "name": "spike", "file": "../assets/spike-128x64.rgb", "width": 128, "height": 64, "frames": 1 }],
  "placements": [{ "module": "../modules/spike-image.wasm", "x": 0, "y": 0, "width": 128, "height": 64, "z": 0, "config": {} }],
  "capture": [0, 1, 2, 3]
}
```

`assets` and a placement's `config` may be omitted. Placement order is the
array's order. Every asset is visible to every placement. The host runs
frames 0 to the largest captured index and records the framebuffer of each
captured frame after it is composed. A golden frame is a PNG of that
framebuffer; hosts compare decoded pixels, never file bytes.

### 4.10 Files

Created (the plan may add files inside these directories):

- `docs/widget-abi.md`
- `rust-toolchain.toml`
- `sdk/check.sh`, `sdk/deny.toml`
- `sdk/rust/Cargo.toml`, `sdk/rust/Cargo.lock`, `sdk/rust/panelator-widget/`,
  `sdk/rust/panelator-host/` (`sdk/rust/.gitkeep` removed)
- `widgets/Cargo.toml`, `widgets/Cargo.lock`, `widgets/.cargo/config.toml`,
  `widgets/spike-clock/`, `widgets/spike-scroll/`, `widgets/spike-image/`,
  `widgets/abi-probe/` (`widgets/.gitkeep` removed)
- `sdk/conformance/README.md`, `sdk/conformance/modules/*.wasm`,
  `sdk/conformance/scenarios/*.json`, `sdk/conformance/golden/`,
  `sdk/conformance/assets/spike-128x64.rgb`, `sdk/conformance/fonts/`

Changed:

- `.github/workflows/ci.yml` (sensitive path): the steps of AC-12 added to
  the job `test`, nothing else.

Network and shell: `sdk/check.sh` is a shell script run by CI and by the
implement stage; it and the CI steps download the pinned Rust toolchain
(`static.rust-lang.org`), crates (`crates.io`) and the two cargo tools. The
implementer downloads one Spleen release once to vendor two files, and the
`rustup` installer (`sh.rustup.rs`) where AC-12 says so. The test
host opens no socket and runs no process; it reads the scenario's files and
writes PNGs to the directory it is given. No secret is involved.

## 5. Verification

1. `sdk/check.sh` exits 0 on a clean checkout, in CI's `test` job and on the
   implementer's machine; its output shows the format, clippy and deny checks
   for both workspaces, the four module comparisons, and the nextest run with
   the tests of AC-11.
2. Change one byte of a committed module, then of a golden PNG's pixel, then
   one drawing rule in the host (for example the circle's `≤` to `<`): the
   script fails each time, naming the module, or the scenario, frame and
   pixel. Revert.
3. Read the golden frames as pictures: the clock shows `23:59:58`, the same,
   `23:59:59`, the same, `00:00:00`; the scroll's text moves one pixel left
   per frame and re-enters after the wrap; the image shows the gradient with
   the white pixel advancing every second frame; `spike` shows the clock's
   digits directly on the image and the scroll's band darkening it by half;
   the probe shows each case of AC-9.
4. `panelator-host run` on a scenario edited to a 64×32 geometry writes
   64×32 frames, and `grep -rn "128" sdk/rust widgets --include=*.rs` finds
   the number only in the spike widgets' declared default sizes and in tests.
5. A reviewer checks `docs/widget-abi.md` against section 4 rule by rule, and
   that the ABI document, the SDK's constants and the host agree on every
   name and number.
6. `pnpm test` passes unchanged.

## 6. Open decisions

None.
