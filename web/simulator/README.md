# @panelator/simulator

The simulator engine (spec 115): a host of [widget ABI 0.1](../../docs/widget-abi.md) written in
TypeScript. It loads the identical WASM modules with the browser's own WebAssembly engine, gives them
the sixteen imports, keeps one retained RGBA layer per placement, steps placements by the document's
due rule and composes the layers into an RGB frame with its integer formula. **`docs/widget-abi.md` is
the specification**; where this package and the document differ, the document is right. The panel's
size is an argument everywhere. The core runs unchanged under Node, in a page and in a worker; only
`presentFrame` and `runLive` name browser types, and they take the canvas context, the frame function
and the clock as arguments.

## Public functions

- `loadModule(bytes)`: checks the module's form (signatures, memory, start function, version, declarations).
- `parseFont(bdfText)`: the engine holds no font data; it parses the two BDF files it is given.
- `createScene({ panel, fonts, assets, placements, environment })`, then `scene.step(tick?)`,
  `scene.tick`, `scene.frame`, `scene.panel`, `scene.placements`.
- `readScene(json)`, `runConformance(scene, files)`, `frameSha256(frame)`: the conformance profile.
- `presentFrame(context, frame, width, height)`: one canvas pixel per LED.
- `runLive(scene, { context, clock, requestFrame, onTick, onError })` and `liveEnvironment()`.
- `SimulatorError`: carries the rule, or the placement, module, export and tick.

## Testing a host against the suite

`runConformance(readScene(sceneJson), { modules, assets, fonts })` runs a scene of
`sdk/conformance/` as the document's profile says and returns a copy of the frame at each captured
tick; compare each with `golden/<scene>/tick-<n>.png` or its hash in `frames.json`. `pnpm test` in
this package builds the modules (`sdk/rust/build-widgets.sh`, which needs the toolchain of
`rust-toolchain.toml`) and runs the four scenes under Node. The same function runs in Chromium in the
app's `e2e`. The engine never writes a golden file.

## Known limits

- **No fuel.** A browser cannot stop a call that never returns; it blocks the page. The overrun rule
  and running the engine in a worker come with the later part of the ABI.
- **No feature check.** The browser cannot be told to refuse a WebAssembly feature; the Rust test
  host's load check is the check of a module's form.
- **Growth of a module with no declared maximum.** `memory.grow` cannot be made to return -1 for such
  a module; the engine checks the memory after every call and ends the run, naming the 4-page limit,
  once it is over. A module declaring a maximum of at most 4 pages is bounded by the browser.
