# 0020. The widget ABI is plain core-WASM imports over host-owned RGBA layers, declared by exports

Status: accepted
Date: 2026-11-22
Decided by: the spec stage of issue #430 (design section 3: a large technical
decision with one clearly right answer under the decisions that exist,
recorded with its reasoning). Carried by
[spec 107](../../specs/107-widget-abi-and-rust-sdk/spec.md).

## Context

The maintainer decided that widgets are WebAssembly modules run by WAMR on
the board and by the browser's engine in the simulator, the identical bytes
in both (design-tree R2.Q3, product spec 3.1, 7.1); that each placement owns
a retained layer which a native compositor blends at 60 Hz "with z-order and
alpha" (R3.Q1, product spec 3.2); that the host API is a fixed list of
drawing, config, time and random calls, with the framebuffer absent by design
(R4.Q1, product spec 3.3); and that the ABI is published and versioned
(R3.Q2, R9.Q3). What a module looks like at the binary level was open, and
it is costly to change once widgets are published.

## Decision

1. **Core WebAssembly, function imports and exports with integer
   arguments.** No component model and no WIT bindings: WAMR's interpreter
   and AOT on the ESP32-S3 run core modules, and a browser runs a component
   only after a transpile step, which would end "the identical bytes".
   Strings and images cross as a pointer and a length into the module's
   exported memory; the host checks every range and returns an error
   instead of trapping.
2. **The host owns the layer; the widget draws by calls.** The alternative,
   a pixel buffer inside the module's memory that the host copies out, would
   put a layer's bytes in every module's memory, make host fonts a copy into
   the widget, and hand the widget what product spec 3.3 lists as absent.
   A bulk `blit` from the module's memory covers images and hand-drawn
   glyphs.
3. **Layers are 8-bit RGBA and drawing overwrites.** Alpha has to come from
   somewhere for the compositor to blend with it; per-pixel alpha is the
   general case (a widget with a transparent background over another), an
   opaque widget pays one byte a pixel, and the spike then measures the
   costlier compositor. Blending happens in one place, the compositor, by
   one integer formula, so three hosts agree to the bit.
4. **The module declares its ABI version, update rate and default size by
   exported functions.** There is no manifest yet; an export reads the same
   way in every engine and survives AOT compilation, which a custom section
   need not. The manifest child states which declaration the backend reads
   once both exist.
5. **Exact pixel rules, and conformance by golden frames.** Shapes are
   defined by which pixels they set, time and random have a conformance
   mode, and the built modules are committed, so "identical frames on the
   board, in the Rust test host and in the browser" (product spec 13) is a
   file comparison.

## Consequences

- The ABI document, the SDK, the test host, the probe module and the golden
  frames change together, in the PR of the host that needs the change.
- An opaque layer costs four bytes a pixel instead of three (32 KiB for a
  full 128×64 layer).
- A later per-layer opacity (the host's fade) multiplies in the compositor
  and needs no change to modules.
- If the spike shows per-call import overhead is too high for 60 Hz, the
  remedy is a coarser import (as `blit` already is), a minor version bump.
