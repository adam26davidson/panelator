# Widget ABI

Version 0.1 (draft). This is the contract between a widget module and a host. A host (the
board's runtime, the browser engine, the Rust test host) and an SDK are written from this
document and tested against the conformance suite in `sdk/conformance/`. The shape and its
reasons are in [ADR 0017](decisions/0017-widget-abi-v0-shape.md); the product rules are in
[product spec](product-spec.md) sections 3.2, 3.3 and 3.4. Where this document and a host
differ, the document is right.

Words: **MUST** and **MAY** are used in their usual sense. A *tick* is one step of the 60 Hz
compositor, numbered from 0 for each scene. All arithmetic in the drawing and composition rules
is on integers; integer division rounds toward zero.

## Version

The ABI version is `major.minor`; this document is **0.1**. A change that makes a conforming
module or host stop conforming bumps the major (product spec 3.4); an addition bumps the minor.
A module states the version it was built for through the export `pn_abi_version` as
`(major << 16) | minor`; for 0.1 that is `0x00000001`.

A host loads a module only when the module's major equals the host's and the module's minor is
not greater than the host's. Otherwise the load fails with an error naming both versions, and no
export other than the four declarations (see Exports) has been called. How long a previous major
stays supported is not part of 0.1.

## Module form and limits

A widget is one core WebAssembly module (no component model). It

- imports nothing but the functions of the import table, from the import module `panelator`;
- exports its one linear memory as `memory`, and no other memory exists;
- has no start function;
- has a linear memory of at most **4 pages (256 KiB)** at any time: a module declaring a larger
  initial memory is refused, and `memory.grow` past the limit returns -1. This is a draft limit;
  the published widget budget comes from the runtime measurement;
- uses only these WebAssembly features, the ones the stable Rust `wasm32-unknown-unknown` target
  enables by default: mutable globals, sign extension, non-trapping float-to-int conversion, bulk
  memory, multi-value and reference types (as tables of functions; no `externref` value appears
  in an import or export signature). Threads, SIMD, exception handling, tail calls, GC, memory64,
  multiple memories and extended constants are never used.

A host that loads a module breaking any of these fails the load with an error that names the
rule and the offending import, export or feature.

## Exports

Besides `memory`, a module exports exactly these functions. A missing one, an extra one or a
wrong signature fails the load, naming it.

| Export | Signature | Meaning |
|---|---|---|
| `pn_abi_version` | `() -> i32` | the ABI version, `(major << 16) \| minor` |
| `pn_update_hz` | `() -> i32` | the declared update rate: 0 for "on data change only", 1 to 60 for that many updates a second; any other value fails the load |
| `pn_width` | `() -> i32` | the declared width in LEDs, 1 to 4096; any other value fails the load |
| `pn_height` | `() -> i32` | the declared height in LEDs, 1 to 4096; any other value fails the load |
| `pn_init` | `()` | called once, after the declarations and before any update; it may draw |
| `pn_update` | `(tick: i64)` | called when an update is due with the current tick; it may draw |

The four declarations are constant, take no host state and call no import. A host calls them once,
after instantiation and before `pn_init`. Until the manifest exists they are the only declaration
of rate and size; a placement's actual size is its layer's.

## Imports

Import module `panelator`. Every parameter and result is `i32` unless shown. A colour is
`0xRRGGBBAA` in one `i32`. A string or buffer is a pointer and a length in bytes into the
module's memory.

| Module | Function | Parameters | Result | Meaning |
|---|---|---|---|---|
| `panelator` | `layer_width` | | `i32` | the layer's width |
| `panelator` | `layer_height` | | `i32` | the layer's height |
| `panelator` | `draw_fill` | `color: i32` | | set every pixel |
| `panelator` | `draw_pixel` | `x: i32, y: i32, color: i32` | | set one pixel |
| `panelator` | `draw_line` | `x0: i32, y0: i32, x1: i32, y1: i32, color: i32` | | Bresenham's line, both ends included |
| `panelator` | `draw_rect` | `x: i32, y: i32, w: i32, h: i32, color: i32, filled: i32` | | a rectangle, filled or its one-pixel border |
| `panelator` | `draw_circle` | `cx: i32, cy: i32, r: i32, color: i32, filled: i32` | | the midpoint circle, outlined or filled |
| `panelator` | `draw_text` | `font: i32, x: i32, y: i32, ptr: i32, len: i32, color: i32` | `i32` | draw UTF-8 text in a host font, returns the advance |
| `panelator` | `text_width` | `font: i32, ptr: i32, len: i32` | `i32` | the advance of a string without drawing |
| `panelator` | `font_height` | `font: i32` | `i32` | the font's cell height |
| `panelator` | `draw_image` | `name_ptr: i32, name_len: i32, frame: i32, x: i32, y: i32` | `i32` | blit a frame of a named asset |
| `panelator` | `config_len` | | `i32` | the length of the placement's config in bytes |
| `panelator` | `config_read` | `ptr: i32, cap: i32` | `i32` | copy the config's first bytes, returns the count |
| `panelator` | `time_unix_ms` | | `i64` | milliseconds since the Unix epoch, UTC |
| `panelator` | `time_utc_offset_s` | | `i32` | the timezone's offset east of UTC in seconds |
| `panelator` | `random_u32` | | `i32` | 32 random bits |

A string or buffer argument of any import that does not lie inside the module's memory is a
trap: the call does not return and the placement's run ends in an error.

## The layer and the drawing rules

Each placement owns a layer of its own width and height: one RGBA pixel of 8 bits a channel per
LED, every pixel `0x00000000` when the placement starts. Nothing but the placement's own calls
changes it, and it keeps its content between calls (retained layers, product spec 3.2).

A draw call **sets** the pixels it covers to the colour, alpha included; nothing is blended inside
a layer. Coordinates are layer pixels: origin top-left, x to the right, y down. Every call clips
to the layer, and any `i32` coordinate or size is legal. A call's cost MUST be bounded by the
layer's size, not by its arguments: the pseudo-code below defines the *set of pixels*, and a host
produces exactly that set by any method that does not overflow and does not walk pixels outside
the layer (clip analytically).

The intermediate integers in the pseudo-code are **64-bit signed**; with 32-bit inputs none of
them overflows.

**Fill, pixel.** `draw_fill` sets every pixel. `draw_pixel` sets `(x, y)` when it is inside.

**Line.** `draw_line(x0, y0, x1, y1)` sets the pixels of this loop, both ends included:

```
dx = abs(x1 - x0);  dy = -abs(y1 - y0)
sx = 1 if x0 < x1 else -1;  sy = 1 if y0 < y1 else -1
err = dx + dy;  x = x0;  y = y0
loop:
    set(x, y)
    if x == x1 and y == y1: stop
    e2 = 2 * err
    if e2 >= dy: err += dy; x += sx
    if e2 <= dx: err += dx; y += sy
```

A host may use this closed form for the same pixels: with `d` the larger of `|x1 - x0|` and
`|y1 - y0|` and `m` the smaller, the pixel at step `i` (0 to `d`) along the larger axis is `m_i =
(2 * i * m + d) / (2 * d)` steps along the smaller one (ties round up; `d == 0` is one pixel). Use
128-bit integers for `2 * i * m`.

**Rectangle.** Nothing when `w <= 0` or `h <= 0`. With `filled != 0` the `w` by `h` pixels from
`(x, y)`; otherwise the pixels of that rectangle with `i == 0` or `i == w - 1` or `j == 0` or
`j == h - 1` (`i`, `j` the offsets from `(x, y)`). A rectangle of width or height 1 or 2 is
therefore the same in both modes.

**Circle.** Nothing when `r < 0`; one pixel when `r == 0`. Otherwise the integer midpoint circle:

```
x = r;  y = 0;  d = 1 - r
while x >= y:
    row(cy + y, x);  row(cy - y, x);  row(cy + x, y);  row(cy - x, y)
    y += 1
    if d < 0: d += 2 * y + 1
    else:     x -= 1;  d += 2 * (y - x) + 1
row(py, h):  filled: set every (px, py) with cx - h <= px <= cx + h
             outline: set (cx - h, py) and (cx + h, py)
```

Radius 3 outlined is 16 pixels: `(±3, 0)`, `(±3, ±1)`, `(±2, ±2)`, `(±1, ±3)`, `(0, ±3)` from the
centre. Radius 4 filled has rows of 9, 9, 7, 7 and 3 pixels from the centre row outward. A filled
circle sets every pixel between the outline's leftmost and rightmost pixel of each row.

## Fonts and text

`draw_text(font, x, y, ptr, len, color)` draws the UTF-8 string of `len` bytes at `ptr` with its
first cell's top-left at `(x, y)`, on one line, setting only the pixels the glyphs have set (the
rest of each cell is untouched), and returns the advance in pixels. `text_width` returns the same
advance without drawing. `font_height` returns the font's cell height.

Version 0.1 has two fonts, both Spleen release 2.3.0 (BSD 2-Clause, product spec 3.3): font **1** is
Spleen 5x8 (cell height 8), font **2** is Spleen 8x16 (cell height 16). The ids are part of the
ABI. Their glyphs are the BDF files `sdk/conformance/fonts/spleen-5x8.bdf` and
`spleen-8x16.bdf`, unmodified from that release, with its licence beside them. A glyph's set
pixels are the BDF bitmap's one bits (most significant bit first, each row padded to a byte)
placed at `x_pen + BBX.x + column`, and `y + (FONT_ASCENT - BBX.y - BBX.height) + row`. A glyph's
advance is its `DWIDTH` x. The pen starts at `x` and moves by the advance after each code point.

A code point with no glyph in the font, and each byte that is not part of a well-formed UTF-8
sequence, draws nothing and advances by the font's bounding-box width (`FONTBOUNDINGBOX`, 5 and 8).
Well-formed is as in RFC 3629 (no overlong forms, no surrogates, nothing above U+10FFFF). An
unknown font id draws nothing and returns -1 (from `font_height` too).

## Assets

`draw_image(name_ptr, name_len, frame, x, y)` sets the layer's pixels from frame `frame` (from 0)
of the asset whose name is the UTF-8 string given, its top-left at `(x, y)`, each pixel with alpha
255, clipped, and returns 0. It returns -1 and draws nothing when the host has no asset of that
name, and -2 when the frame does not exist (negative or at least the frame count).

An asset is frames of raw RGB, 3 bytes a pixel, rows top to bottom, frames one after another.
Its name, width, height and frame count are the host's metadata (in a scene, below). The module
never holds the image bytes: the board only blits (product spec 5.3).

## Config

A placement's config is one JSON document in UTF-8 whose top level is an object; a placement with
no config has `{}`. `config_len` returns its length in bytes; `config_read(ptr, cap)` copies its
first `min(cap, length)` bytes to `ptr` and returns that count (a negative `cap` copies nothing and
returns 0). The document does not change during a placement's life in 0.1.

## Time, timezone and random

`time_unix_ms` is the current time in milliseconds since the Unix epoch, UTC.
`time_utc_offset_s` is the offset of the board's timezone in effect at that time, in seconds east
of UTC. `random_u32` returns 32 random bits. A widget takes local time as
`time_unix_ms / 1000 + time_utc_offset_s`. In the conformance profile all three are fixed by the
scene (below) so that frames repeat.

## Stepping and composition

**When a widget is called.** For a placement with declared rate `hz`, an update is due at tick `t`
when `t == 0`, or when `hz > 0` and `(t * hz) / 60 != ((t - 1) * hz) / 60`. So 60 Hz is every
tick, 30 Hz every second tick, 1 Hz every 60th, and a widget whose update was skipped on a device
still sees the true tick. With `hz == 0` the only update of version 0.1 is the one at tick 0.
Within a tick, due placements are updated in ascending z, ties by their order in the scene; all
updates of a tick come before its composition.

**Composition.** The frame is the panel's width by height, RGB, 8 bits a channel, black. Layers are
applied in ascending z, ties in scene order, each at its `(x, y)`, clipped to the panel. For a
layer pixel with channels `s` and alpha `pa`, and the placement's `opacity` (0 to 255),
`a = (pa * opacity + 127) / 255`, and each channel becomes
`(s * a + d * (255 - a) + 127) / 255`, where `d` is the frame's value under it.

**Overrun.** A trap, or a call that uses more than the host's fuel limit, ends the placement's
run in an error naming the placement, the export and the tick. (Fuel is the test host's;
what a board does on an overrun is a later part of the ABI.)

## The conformance profile

`sdk/conformance/` holds the scenes, fonts, assets and golden frames; its `README.md` says how a
host uses them. A scene is a JSON file with: `abi` (`"0.1"`); `panel` (`width`, `height`);
`start_unix_ms`; `utc_offset_s`; `ticks`, the ascending list of ticks to capture; `assets` (each
`name`, `file` relative to `sdk/conformance/assets/`, `width`, `height`, `frames`; the file's length
is their product times 3); and `placements`, each with `module` (a spike module's name), `x`, `y`,
`width`, `height`, `z`, `opacity`, `config` (a JSON object) and `seed` (a non-zero 32-bit number).
A host rejects a scene with an unknown or missing field, naming it.

Running a scene: every placement is loaded, given a layer of its `width` by `height`, and `pn_init`
is called in scene order; then for each tick from 0 to the last captured one, the due updates run
and the frame is composed. During `pn_init` and tick `t`, `time_unix_ms` is
`start_unix_ms + (t * 1000) / 60` (with `t = 0` for `pn_init`), `time_utc_offset_s` is the scene's,
and each placement's `random_u32` is xorshift32 on its own state, starting at its `seed`
(`x ^= x << 13; x ^= x >> 17; x ^= x << 5`, on 32 bits, the new `x` returned). The first three
values for seed 1 are 270369, 67634689 and 2647435461; for seed 2, 540738, 134253570 and 697882754;
for seed 3, 811107, 201886211 and 3025432647 (as `i32` they are the same bits).

A golden frame is a composed frame: `golden/<scene>/tick-<n>.png` (8-bit RGB PNG) and
`golden/<scene>/frames.json` with the scene's name, the panel size and, per captured tick, the
SHA-256 in hex of the frame's raw bytes (RGB, rows top to bottom). A host that cannot read PNG
compares the hashes.

## Not in 0.1

Left to later versions of the ABI (product spec 3.2 and 3.3): data feeds and feed age, events,
the key-value store, logging, host animations (scroll, fade), Unifont, truffle-shuffle and uploaded
fonts, the overrun and inactive-screen rules, the manifest file, ABI range enforcement and how
long a previous major is supported, and placements whose size differs from the declared size
beyond the layer's own size.
