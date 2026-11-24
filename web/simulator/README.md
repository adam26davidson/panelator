# @panelator/simulator

The engine that runs widget modules in a browser's WebAssembly engine and draws their frames to a canvas (spec 115). It
is a host of widget ABI 0.1, written from [`docs/widget-abi.md`](../../docs/widget-abi.md), which is its specification:
where this package and the document differ, the document is right. It has no runtime dependency and no build step; its
entry is `src/index.ts`. The stepping and composing parts use only the language, `WebAssembly` and `crypto.subtle`, so
they run under Node, in a page and in a worker. Only `presentFrame` and `runLive` are made for a browser, and they take
the context, the frame function and the clock as arguments. The panel's size is an argument everywhere.

## Public functions

- `loadModule(bytes, name?)` — compiles a module, checks it against the document's load rules, calls the four
  declarations; a `SimulatorError` names the rule and the offending import, export or value.
- `parseFont(bdfText)` — a Spleen BDF file as text; the package holds no font data.
- `createScene({ panel, fonts, assets, placements, environment })` — instantiates each placement with a layer of its size
  and calls `pn_init`; the scene has `step(tick?)`, `tick`, `frame`, `panel` and `placements`.
- `readScene(json)`, `runConformance(scene, files)`, `frameSha256(frame)` — the conformance profile.
- `presentFrame(context, frame, width, height)` — one canvas pixel per LED.
- `runLive(scene, { context, clock, requestFrame, onTick, onError })` and `liveEnvironment()` — 60 ticks a second of the
  given clock; returns `{ pause, resume, stop }`.
- `SimulatorError` — `rule`, `placement`, `module`, `export`, `tick`.

## Testing a host against the suite

`sdk/conformance/` holds the scenes, fonts, assets and golden frames. A host reads a scene with `readScene`, gives
`runConformance` the bytes of each module (by name), asset (by file) and the two fonts, and compares each returned frame
with `golden/<scene>/frames.json` and `tick-<n>.png`. `src/conformance.test.ts` does this under Node; the app's `e2e` does
it in Chromium. The modules are built by `sdk/rust/build-widgets.sh` (`pnpm test` runs it first, and fails naming
`rust-toolchain.toml` when the toolchain is missing).

The engine never writes a golden file.

## Known limits

- **No fuel.** A browser has no fuel: a call that never returns blocks the page. The overrun rule is a later part of the
  ABI; running the engine in a worker comes with it.
- **No feature check.** The browser cannot be told to refuse a WebAssembly feature; the Rust test host's load check is the
  check of a module's form. The engine checks what the module's sections show.
- **Growth.** A module that declares a memory maximum of at most 4 pages has `memory.grow` bounded by the browser. For a
  module with no such maximum the engine checks the memory after every call and ends the run with an error once it is over
  4 pages.
