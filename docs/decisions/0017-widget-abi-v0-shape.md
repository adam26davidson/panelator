# 0017. The shape of widget ABI 0.1 and of its conformance material

Status: accepted
Date: 2026-11-22
Decided by: the spec stage of issue #430 (design section 3: decisions of
structure with one clearly right answer under what the product spec already
fixes, recorded with their reasoning). Carried by
[specs/107-widget-abi-and-rust-sdk/spec.md](../../specs/107-widget-abi-and-rust-sdk/spec.md).

## Context

Product spec 3.2 and 3.3 fix the model: each placement owns a layer, a native
compositor blits the layers at 60 Hz with z-order and alpha, a widget draws
on its own layer through host calls and never sees the framebuffer, and it
declares its update rate. Product spec 13 requires the same module to produce
identical frames on the board, in the Rust test host and in the browser.
The v0 build design gives one child the ABI document and the golden frames,
and has the device runtime and the browser engine implement that document.

What the product spec leaves open is the shape of the interface: how a
module declares itself before a manifest exists, what a pixel of a layer is,
how time reaches a widget, what form config takes, and what a golden frame
is a frame of. Three hosts in three languages will be written against the
answers, so they are costly to change later, and each has one answer that
follows from the requirement of identical frames.

## Decision

1. **Declarations are exported functions** (`pn_abi_version`,
   `pn_update_hz`, `pn_width`, `pn_height`). Every engine in play (WAMR
   interpreter, WAMR AOT, the browser, wasmi) can call an export; custom
   sections are dropped or need build flags in some of them. The manifest
   (product spec 10) arrives with later children and is what the backend and
   the web app read; the exports stay what a host checks at load.
2. **A layer pixel is RGB with 8-bit alpha, and a draw call sets pixels.**
   The compositor's alpha has to come from somewhere. Overlap with z-order
   (product spec 7.2) is only useful if text can sit over an image, which
   needs transparency per pixel; a placement-wide opacity is kept as well.
   Draw calls replace pixels rather than blend into the layer, so a host has
   one blend, in the compositor, written as integer arithmetic. The spike
   then measures the heavier compositor, which is the honest number; if it
   is too slow, `runtime-spike-measurement` says so.
3. **`pn_update` receives the tick, and rates are defined in ticks.** At
   60 Hz a tick is 16.67 ms, so milliseconds round differently in different
   hosts. The tick counter is exact, lets a widget animate correctly after a
   skipped frame, and makes "N Hz" a rule on integers. Wall-clock time stays
   an import, for clocks.
4. **Config is one JSON document the widget reads as bytes.** Config is
   described by JSON Schema and feeds reach widgets as JSON (product spec
   3.3, 7.4), so one format serves both, the ABI needs two imports and no
   host has to implement key lookup three times. The SDK carries the reader.
5. **Everything a frame depends on is specified as integer rules or as
   committed bytes**: the line and circle algorithms, the composition
   formula, the fonts as upstream BDF files, the asset as raw RGB, and in the
   conformance profile a fixed clock and a specified random generator.
6. **A golden frame is a composed frame of a scene** (a panel size, placed
   modules, config, start time, captured ticks), committed as PNG for
   reviewers and as a SHA-256 of the raw bytes for hosts that cannot read
   PNG (the board prints a hash over serial). Single-widget scenes are scenes
   with one placement, so one mechanism covers layers and composition.
7. **Modules are built from source, not committed.** The local and CI
   toolchains ship different builds of the standard library, so committed
   bytes could not be checked byte for byte; the frames are the contract and
   hold for any conforming build.
8. **The test host runs modules with `wasmi`.** It needs repeatable
   execution, fuel metering and a small dependency tree; speed is the
   board's question, not the test host's.

## Alternatives considered

- **A custom section for the declarations**: readable without instantiating,
  but not uniformly available across the engines; the manifest will serve
  that purpose.
- **RGB layers with only a placement-wide opacity**: three bytes a pixel and
  a cheaper blend, but every overlapping widget is an opaque rectangle.
- **Blending inside the layer (source-over draw calls)**: a second blend in
  every host and more ways to differ, for little gain on an LED panel.
- **`pn_update` with milliseconds, or with no argument**: rounding
  differences across hosts, or animation that slows when a frame is skipped.
- **Host-side config lookup by key**: smaller modules, but JSON navigation
  written and kept identical in C, Rust and TypeScript.
- **Per-layer golden frames only**: would leave composition, the part all
  three hosts must also agree on, untested.
- **Committed `.wasm` with a rebuild check**: fails on any difference between
  toolchain builds, which says nothing about the ABI.
- **`wasmtime` for the test host**: a JIT and a large dependency tree for no
  benefit here.

## Consequences

- The document is version 0.1 and a draft: `first-builtin-widget` and
  `rest-of-v0` add to it (manifest, feeds, events, storage, logging, more
  fonts, host animations). An addition bumps the minor; a change that breaks
  a conforming module or host bumps the major, as product spec 3.4 says.
- A layer costs four bytes a pixel on the board.
- A widget needs a JSON reader; the Rust SDK provides one without an
  allocator.
- The firmware and the web app build the spike modules themselves or take
  them from the CI artifact.
