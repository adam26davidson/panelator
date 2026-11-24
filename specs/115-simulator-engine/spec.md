# 115. Simulator engine: the same WASM modules run in the browser against a canvas

Status: written 2026-11-23 for issue #435, the planned child
`simulator-engine` of the v0 build design; a spec derived from its parent
design needs no maintainer approval (delivery-system design section 11).
Marks [spec 112](../112-web-app-skeleton/spec.md) AC-1, AC-7 and AC-14
(amended: a workspace dependency, a link on Home, two more checks).
Class: product. Domain: web-ui (sensitive paths:
`.github/workflows/ci.yml`, under `.github/`; `pnpm-workspace.yaml`; and
`web/simulator/vitest.config.ts`, matched by `**/vitest.config.*`;
process-spec section 5).
Parent: docs/designs/product-v0-build.md
Derives from: [v0 build design](../../docs/designs/product-v0-build.md)
sections 3 and 4 ("One ABI, three hosts", "Geometry is configuration",
"Checks arrive with the layer") and its planned child `simulator-engine`;
[product spec](../../docs/product-spec.md) sections 3.2 (retained layers),
3.3 (host API), 7 (the simulator is a shared engine, `shared/` or its own
package, not a feature slice), 7.1 (the identical WASM modules in the
browser's engine; a raw-pixels view), 12 (milestone 1: "Run the identical
modules in the browser against a canvas") and 13 (the same module produces
identical frames on the board, in the Rust test host and in the browser);
[design-tree](../../docs/design-tree.md) R2.Q8 (runtime spike first), R3.Q1
(retained layers), R5.Q6 (ABI conformance and golden pixel tests);
[spec 107](../107-widget-abi-and-rust-sdk/spec.md) (the ABI document
`docs/widget-abi.md`, the spike widgets, the conformance directory and the
golden frames this engine is tested against) and
[ADR 0017](../../docs/decisions/0017-widget-abi-v0-shape.md) (modules are
built, not committed; a golden frame is a composed frame of a scene);
[spec 112](../112-web-app-skeleton/spec.md) (the web package, its checks,
its frame and tokens);
[ADR 0016](../../docs/decisions/0016-product-breakdown-is-one-ordered-design.md).

## 1. Goal

The widget ABI has one host, the Rust test host. The web app is a shell
with no panel in it. After this spec:

- `web/simulator/` is the workspace package `@panelator/simulator`: a host
  of widget ABI 0.1 written in TypeScript from `docs/widget-abi.md`. It
  loads a widget module with the browser's own WebAssembly engine, gives it
  the sixteen imports of the document, keeps one retained layer per
  placement, steps placements by the document's rule, composes the layers
  into an RGB frame with the document's integer formula, and draws that
  frame to a canvas. The panel's size is an argument everywhere.
- The engine is tested against the golden frames of `sdk/conformance/`
  twice: under Node, and inside Chromium. Both run the four scenes on the
  three spike modules as `sdk/rust/build-widgets.sh` built them and require
  every captured frame to equal its golden frame.
- The web app has one new page, `/simulator`, that shows the three spike
  widgets running live as scene `spike` places them, one canvas pixel per
  LED, enlarged without smoothing.

`runtime-spike-measurement` confirms from this spec's tests that the
browser runs the identical modules; `layout-editor` builds the draft screen
and the LED look on this engine.

## 2. Out of scope

- **The emulated LED look** (round LEDs, gaps, glow), the raw-pixels
  toggle, the draft screen and anything editable: `layout-editor`. The page
  here has raw pixels only.
- **Feeds, the backend, accounts.** The page calls no backend.
- **Any change to the ABI.** The engine implements `docs/widget-abi.md` as
  it stands and adds no import (parent design, "One ABI, three hosts").
  The document, the SDK, the widgets, the test host, the scenes and the
  golden frames are not changed; the engine never writes a golden file.
- **Budgets and isolation.** A browser has no fuel. A call that never
  returns blocks the page; the overrun rule is a later part of the ABI
  (the document, "Overrun"; `rest-of-v0`), and running the engine in a
  worker comes with it. The three modules run here are built from this
  repository. Nothing in the engine's core touches the DOM, so the move
  needs no rewrite (AC-1).
- **The WebAssembly feature list** of the document's "Module form and
  limits". The browser's engine cannot be told to refuse a feature, and
  finding one means validating every function body. The Rust test host's
  load check is the check of a module's form; the engine checks what it
  can read from the module's sections (AC-3).
- **Performance numbers.** The measurement is on the board
  (`runtime-spike-measurement`). The page must keep up (AC-16); nothing is
  published.
- **Primary navigation.** The page is reached from Home (AC-15); the
  frame's navigation arrives with boards and the editor (spec 112's
  design).
- The sensitive-path list, the security review and what routes a diff to
  it are unchanged.
- **Files this spec leaves unchanged:** docs/widget-abi.md, sdk/, widgets/,
  Cargo.toml, .cargo/, the root vitest config, the web vitest config, the
  root package.json, AGENTS.md, and everything this section names. A diff
  that touches one of them is outside the spec.

## 3. Acceptance criteria

Definitions. *The document* is `docs/widget-abi.md`; where this section and
the document differ, the document is right and the difference is a finding.
*The engine* is the package `@panelator/simulator` in `web/simulator/`.
*The app* is `@panelator/web`. *The suite* is `sdk/conformance/`. *The
modules* are `target/widgets/spike-clock.wasm`, `spike-scroll.wasm` and
`spike-image.wasm`, written by `sdk/rust/build-widgets.sh`. *A scene*, *a
tick*, *a placement* and *a layer* are the document's. *A frame* is
`width * height * 3` bytes, RGB, rows top to bottom. *The three viewports*
are spec 112's.

**The package and its inputs**

- AC-1. **The engine is its own package.** `web/simulator/package.json`
  names `@panelator/simulator`, private, `"type": "module"`, `engines.node`
  `>=26`, with the scripts `typecheck` and `test`. It has no runtime
  dependency: no React, no router, nothing from the app. Its development
  dependencies are `catalog:` (`@types/node` at the workspace's range).
  Its entry is its TypeScript source (`exports` points at
  `src/index.ts`; there is no build step and no `dist`), strict under the
  compiler options of `web/tsconfig.json`. `pnpm-workspace.yaml` gains the
  one `packages` entry `web/simulator` and nothing else (the catalog is
  not touched). The app declares
  it as `"@panelator/simulator": "workspace:*"` and imports it only through
  that name. The parts that step and compose (AC-3 to AC-8) use nothing
  but the language, `WebAssembly` and `crypto.subtle`, so they run
  unchanged under Node, in a page and in a worker; only the canvas
  presenter and the live driver (AC-9, AC-10) name browser types, and they
  take the context, the frame callback and the clock as arguments.
- AC-2. **The identical modules.** The modules are a build input, never
  committed and never transformed: no optimiser, no re-encoding, no
  wrapper. Every script that needs them (the engine's `test`; the app's
  `dev`, `build`, `build-storybook` and `e2e`) first runs
  `sdk/rust/build-widgets.sh`, which is incremental, and given the Rust
  toolchain or its `wasm32-unknown-unknown` target is missing, then that
  script fails with a message naming `rust-toolchain.toml` (no test is
  skipped for want of a module). The app serves each module's bytes as the
  script wrote them and loads them with `WebAssembly.compile` from those
  bytes. The fonts (`fonts/spleen-5x8.bdf`, `fonts/spleen-8x16.bdf`), the
  asset (`assets/spike-image.rgb`) and the scene (`scenes/spike.json`) are
  taken from the suite at build time, unmodified, with no copy committed
  under `web/`; `LICENSE-spleen` is in the app's build output beside the
  fonts.

**The host**

- AC-3. **Loading a module.** `loadModule(bytes)` returns a loaded module
  with its four declarations, or fails with an error that names the rule
  and the offending import, export or value. The browser's API reports
  neither signatures nor memory limits, so the engine reads the module's
  type, import, function, memory, export and start sections itself. The
  load fails when: the bytes are not a module the browser compiles; an
  import is not a function of the document's table from the import module
  `panelator`, or has another signature; an export of the document's table
  is missing or has another signature, or there is an export besides them
  and `memory`; there is no memory exported as `memory`, more than one
  memory, or an initial size over 4 pages; there is a start function; the
  major of `pn_abi_version` is not 0 or its minor is over 1 (the error
  names both versions, and no export but the four declarations has been
  called); `pn_update_hz` is outside 0 to 60; `pn_width` or `pn_height` is
  outside 1 to 4096. The declarations are called once, after instantiation
  and before `pn_init`. **Growth.** A module whose memory declares a
  maximum of at most 4 pages has `memory.grow` bounded by the browser, as
  the three modules do. A browser host cannot make `memory.grow` return -1
  for any other module without rewriting it, so for those the engine
  checks the memory's size after every call of an export and ends the run
  with an error naming the limit once it is over 4 pages *(agent's call:
  stricter than the document for a module that grows past the limit and
  identical for every module that stays inside it; section 4)*.
- AC-4. **The layer and the shape imports.** Each placement owns a layer of
  its own width and height, RGBA, every pixel `0x00000000` at the start,
  changed only by that placement's calls and kept between calls.
  `layer_width`, `layer_height`, `draw_fill`, `draw_pixel`, `draw_line`,
  `draw_rect` and `draw_circle` set exactly the pixels the document's rules
  and pseudo-code give, alpha included, clipped to the layer. An `i32`
  colour arrives in JavaScript as a signed number and is read as
  `0xRRGGBBAA`. Every intermediate value is an exact integer: where the
  document asks for 64-bit or 128-bit intermediates the engine uses
  `BigInt` or arithmetic it shows cannot leave the exact range of a
  double; no pixel is decided by a floating-point comparison. A call's
  cost is bounded by the layer's size, not by its arguments.
- AC-5. **Text.** `draw_text`, `text_width` and `font_height` follow the
  document's "Fonts and text" with fonts 1 and 2. The engine is given the
  two BDF files as text and parses them itself (`ENCODING`, `DWIDTH`,
  `BBX`, `BITMAP`, `FONT_ASCENT`, `FONTBOUNDINGBOX`); it holds no font
  data of its own. The string is decoded by the engine's own UTF-8
  decoder, well-formed as in RFC 3629, in which each byte that is not part
  of a well-formed sequence counts alone (`TextDecoder` is not used: it
  replaces by maximal subpart, which gives other advances). A missing
  glyph and a malformed byte draw nothing and advance by the font's
  bounding-box width; an unknown font id draws nothing and returns -1,
  from `font_height` too.
- AC-6. **Images, config, time, random, traps.** `draw_image` follows the
  document's "Assets": the name is compared as bytes with the names of the
  assets the scene was given; it returns -1 for no such asset and -2 for a
  frame that does not exist, drawing nothing; drawn pixels have alpha 255.
  `config_len` and `config_read` serve the placement's config as the UTF-8
  bytes of `JSON.stringify` of its object, `{}` when there is none, with
  the document's rule for `cap` and for the whole buffer lying in memory.
  `time_unix_ms` (an `i64`, so a `BigInt`), `time_utc_offset_s` and
  `random_u32` return what the scene's environment gives (AC-7).
  The module's memory is read afresh on every call, since growing it
  replaces the buffer. A string or buffer argument outside the memory is a
  trap: the import throws, the export call does not return, and the run
  ends (AC-7).
- AC-7. **A scene: stepping and composition.** `createScene` takes a panel
  (`width`, `height`, each any positive integer), the two fonts, the
  assets (name, width, height, frame count, bytes; the length must be
  their product times 3), the placements (a loaded module, `x`, `y`,
  `width`, `height`, `z`, `opacity`, `config`) and an environment (the
  time and offset for a tick, and each placement's random source). It
  instantiates every placement, gives it a layer of the placement's size
  (not the declared size) and calls `pn_init` in the given order.
  `step(tick?)` runs the next tick, from 0; given `tick`, an integer never
  lower than the next one, it runs that tick instead, the ticks between
  are not run, and the due rule below applies at that tick as written. It
  runs the updates the document's rule makes due, in ascending `z` with ties in the given order, each called
  with the tick as an `i64`; then the composition by the document's
  formula into the scene's frame. The scene exposes the tick last run, the
  frame, the panel and each placement's declarations. Given a trap, a
  JavaScript exception in an import or the memory limit of AC-3, then
  `step()` (or `createScene`, for `pn_init`) fails with an error naming
  the placement's index and module, the export and the tick, and the scene
  steps no further. Nothing in the package holds a panel width, a panel
  height or a chain length: given panels of 1 by 1, 96 by 16, 128 by 64
  and 200 by 3, then the frame has the panel's size and the layers are
  clipped to it.
- AC-8. **The conformance profile.** `readScene(json)` reads a scene file
  of the document's "The conformance profile" and rejects an unknown or
  missing field, naming it. `runConformance(scene, files)` (the caller
  supplies the bytes of each module by name, of each asset by file and of
  the two fonts) builds the scene with the profile's environment
  (`time_unix_ms` is `start_unix_ms + (t * 1000) / 60`, with `t = 0`
  during `pn_init`; the scene's offset; xorshift32 per placement from its
  `seed`), steps from tick 0 to the last captured tick, and returns for
  each captured tick a copy of the frame. `frameSha256(frame)` returns
  the SHA-256 of a frame's bytes in lowercase hex. Given the same scene
  and files, then two runs return equal frames.
- AC-9. **The canvas.** `presentFrame(context, frame, width, height)`
  writes a frame to a 2D canvas context: one canvas pixel per LED, each
  with the frame's red, green and blue and alpha 255, by `putImageData`,
  with no scaling, smoothing or colour conversion. The canvas's backing
  size is the panel's width and height exactly; enlarging is the page's,
  by CSS (AC-14). Given a frame presented in Chromium and read back with
  `getImageData`, then every pixel equals the frame's (AC-12).
- AC-10. **Running live.** `runLive` drives a scene at 60 ticks a second
  of the clock it is given, whatever the display's refresh rate: at each
  animation frame it runs every tick that has become due since the last
  one, in order, then presents the frame once. Given more than 30 ticks
  are due at once (a tab that was hidden), then it runs none of the
  missed ticks, calls `step(tick)` with the newest due tick, which moves the tick counter
  past them,
  so the next update a widget gets carries the true tick, as on a board
  that skipped a frame. The live environment gives `time_unix_ms` as the
  wall clock read once per tick, `time_utc_offset_s` as the browser's
  offset for that instant (east of UTC, in seconds), and `random_u32`
  from `crypto.getRandomValues`. It can be paused, resumed and stopped;
  paused, it steps nothing and time lost is not caught up on resume;
  stopped, it requests no further animation frame. Given an error from a
  step, then it stops and reports the error to its caller. The clock and
  the animation-frame function are arguments, so a test drives it with
  neither a browser nor a wait.

**The tests**

- AC-11. **Golden frames under Node.** The engine's `test` script runs
  Vitest in the Node environment over `web/simulator/src/**/*.test.ts`.
  One test per scene of the suite (`spike-clock`, `spike-scroll`,
  `spike-image`, `spike`) runs `runConformance` on the modules and requires,
  for every tick in the scene's `ticks`, that the frame's SHA-256 equals
  the one in `golden/<scene>/frames.json` and that its pixels equal
  `golden/<scene>/tick-<n>.png`. Given a difference, then the test fails
  naming the scene, the tick, the first differing pixel's coordinates and
  both colours. The PNG is decoded in the test with `node:zlib` (8-bit
  RGB, not interlaced); no image dependency is added. The test also fails
  when `frames.json` lists a tick the scene does not capture or lacks one
  it does. Its output states the SHA-256 of each module file it ran.
- AC-12. **Golden frames in Chromium.** A browser test of the app
  (`web/e2e/`, spec 112 AC-13) runs the same four scenes inside the page:
  the engine's source, built by Vite for the test, is loaded into a page
  of the preview server's origin, given the module, font, asset and scene
  bytes read from disk by the test, and runs `runConformance` there. Given
  any captured tick whose SHA-256, computed in the page, differs from
  `frames.json`, then the test fails naming the scene and the tick. For
  each scene's last captured tick the page also presents the frame to a
  canvas of the panel's size with `presentFrame`, reads it back, and the
  test requires the read pixels to equal the frame (AC-9). Nothing is
  added to the app's production bundle or its routes for this test, and
  nothing listens on a fixed port (spec 112 AC-15). How the built source
  reaches the page (Vite's build API into Playwright's output directory
  and `page.route`, or an equivalent) is the implementation's.
- AC-13. **Unit tests of the host.** Beside the code, in the Node
  environment, with small modules assembled as bytes by a test helper (no
  WAT toolchain is added). They cover:
  - each load failure of AC-3, by name, and the two growth cases;
  - the due rule: a counting module at rates 1, 7, 30 and 60 over ticks 0
    to 119 is called 2, 14, 60 and 120 times at the ticks the rule gives,
    and a rate of 0 once;
  - lines in all eight octants, horizontal, vertical and single-point;
    rectangles of sizes 0, 1, 2 and larger in both modes; circles of
    radius 0 to 8 in both modes, with the document's radius 3 and radius
    4 examples; each shape partly and wholly outside the layer, with
    negative coordinates and coordinates at `i32`'s limits, each such
    call finishing within a bound that does not grow with its arguments;
  - text: every printable ASCII character of both fonts against the BDF
    bitmaps, clipping at each edge, a missing glyph, an unknown font, and
    malformed input (a lone continuation byte, a truncated sequence, an
    overlong form, a surrogate) with the advance of each;
  - `draw_image` inside, across each edge and wholly outside the layer,
    the second frame of a two-frame asset, and both errors;
    `config_read` with a short buffer, a negative `cap` and a buffer
    reaching past the memory; a bad pointer for `draw_text` and
    `draw_image`;
  - the first three xorshift32 values for seeds 1, 2 and 3 as the document
    lists them; the profile's clock at ticks 0, 1, 59 and 60;
  - composition of two overlapping layers at alpha and opacity 0, 1, 127,
    128, 254 and 255 against values computed by hand; z-order and ties;
    a layer partly and wholly off the panel; the panels of AC-7;
  - `readScene` rejecting an unknown and a missing field;
  - `runLive` with a fake clock and frame function: one tick per frame at
    60 Hz, two per frame at 30 Hz, one per two frames at 120 Hz, the
    skip past 30 due ticks, pause, resume and stop, and an error stopping
    it;
  - the import table: the names and signatures the engine registers equal
    the document's import table, read from `docs/widget-abi.md` by the
    test.

**The page**

- AC-14. **`/simulator`.** The app gains the route `/simulator`, shown
  inside the frame, as the page slice `pages/simulator`; the document
  title is `Simulator · panelator`. The page fetches the three modules,
  the two fonts and the asset, builds the scene that `scenes/spike.json`
  describes (its panel, assets and placements; its start time, offset,
  captured ticks and seeds are the profile's and are not used) and runs it
  with `runLive`. It shows one `h1`; the panel, a `canvas` whose backing
  size is the scene's panel and which has an accessible name saying what
  it shows; the panel's size as read from the scene; the current tick;
  for each placement its module's name, declared rate and layer size, as
  read from the loaded modules and the scene; and one control that pauses
  and resumes. The canvas is enlarged by CSS by a whole number of CSS
  pixels per LED, the largest that fits the width the design gives it and
  at least 1, with `image-rendering: pixelated`; given a panel wider than
  that width at 1, then the panel's own container scrolls sideways and
  the page does not. No source file of the app holds the panel's width or
  height: given the page's view rendered with a scene of another panel
  size, then the canvas has that size. Its states:
  - `loading`: until every file is fetched and `pn_init` has returned;
  - `running`: ticks advance;
  - `paused`: by the control, and at the start when the browser reports
    `prefers-reduced-motion: reduce` (the frame of tick 0 is shown);
  - `failed`: a file could not be fetched, a module failed to load, or a
    run ended in an error. The page says so in the design's words, shows
    the engine's message (which placement, which rule), and offers a
    control that loads the simulator again; the stack goes to the browser
    console only. The frame and the rest of the app stay usable.

  Leaving the page stops the run. The page's view takes its state as
  properties, so each state renders with no WebAssembly and no canvas
  context.
- AC-15. **Home leads to it.** Home gains one link to `/simulator`, and
  its copy no longer says the simulator is absent; the words and the
  place are the design's (section 7). Home offers no other new link or
  control.
- AC-16. **The page's tests.** Unit tests (jsdom, spec 112 AC-11) render
  each state of AC-14 from its properties, the view with a second panel
  size, and Home's link. Each state has a story, and spec 112's story
  test renders them. Browser tests, in the three viewports:
  - `/simulator` reaches `running`: the canvas's `width` and `height`
    equal the panel of `scenes/spike.json` as the test reads it; within
    five seconds the tick shown has passed 120 and the canvas holds a
    pixel that is not black; no uncaught error and no console error
    occurred; the page does not scroll sideways; the canvas's CSS width
    is a whole multiple of its `width`;
  - the three `.wasm` responses the page received have the SHA-256 of the
    three files in `target/widgets/`, and there are exactly three;
  - the pause control stops the tick and resumes it, and with reduced
    motion emulated the page starts paused;
  - a module request answered with an error shows `failed`, and its
    control leads back to `running` once the request succeeds;
  - Home's link leads to `/simulator` without a page load;
  - on `mobile`, every link and button of the page is at least 44 CSS
    pixels in both dimensions.

**The wiring**

- AC-17. **`pnpm test` runs it.** `web/checks.test.ts` gains two tests,
  `simulator typecheck` and `simulator test`, which run those scripts of
  `@panelator/simulator` in the way the file runs the app's, placed after
  `knip` and before `test`. The file also writes the captured output of
  `simulator test` and of `e2e` to its own standard output when they pass
  (a failing check still shows it as the failure message), so that a
  passing `pnpm test` and CI's `test` job log show one line per scene
  under Node (the `simulator test` script runs vitest with the verbose
  reporter, one test per scene), one line per browser test, and the three
  module hashes of AC-11, which the engine's test prints with
  `console.log` as `module <file> sha256 <hex>`. The app's `lint` (Biome over `web/`, which
  holds `web/simulator/`) and `knip` (with the workspace `web/simulator`
  added to `web/knip.json`) cover the engine, and its browser tests are
  the app's `e2e`. The dependency test of that file accepts
  `workspace:*` for a package of this repository and nothing else new.
  The engine's tests run under `web/simulator/vitest.config.ts`, once.
  Two checkouts running `pnpm test` at once do not disturb each other
  (spec 112 AC-15): each builds the modules into its own `target/`.
- AC-18. **CI.** In the `test` job of `.github/workflows/ci.yml` the step
  that installs the pinned Rust toolchain and the step that restores the
  Cargo cache move before `pnpm test`, because `pnpm test` now builds the
  modules. No step is added, removed or otherwise changed;
  `sdk/rust/check.sh` still runs after it, builds the same modules and
  uploads them as `spike-widgets`. The required check stays `test`.
- AC-19. **The READMEs.** `web/simulator/README.md` says, in under a page:
  what the engine is and that `docs/widget-abi.md` is its specification;
  its public functions; how a host test uses the suite; that it never
  writes golden files; and the three known limits (no fuel, no feature
  check, growth of a module with no declared maximum: AC-3, section 2).
  `web/README.md` gains the two checks, the `/simulator` page, the
  package, and that `pnpm test` needs the toolchain of
  `rust-toolchain.toml`. `sdk/conformance/README.md` is not changed.

## 4. Design notes *(agent's calls)*

**A package, inside `web/`.** Product spec 7 allows `shared/` or a package;
the parent design's brief says a package. A package is right for a reason
beyond the wording: the engine must run under Node with no DOM for the
golden test, and must not be able to import React, the router or a slice.
A package boundary enforces that; a segment of `shared` would rely on
review. It sits at `web/simulator/` because the product spec's repository
layout has no other home for web code, and because the work then lies in
one domain, `web-ui`. It exports its source and has no build, so the app's
type check and bundler treat it as their own code.

**`pnpm test` builds the modules.** ADR 0017 keeps modules out of the
repository, and the page and both golden tests need them. Spec 112 put
every web check inside `pnpm test` so that a stage sees what CI will see;
a golden test in a step beside it would leave the stage blind to the one
test this spec exists for. The build takes under a second when nothing
changed and a few seconds from clean (three `no_std` crates and the SDK,
no registry download), and Cargo locks its own target directory. The cost
is that `pnpm test` now needs the pinned Rust toolchain: the pipeline's
machine and CI have it (specs 107 and 111 already build there), and CI
only needs it two steps earlier.

**Two golden tests.** Product spec 13 says "in the browser", so the test
that carries the contract runs in Chromium. The Node test is the one a
developer reads: it runs in the engine's own package in a second, and
names the pixel. Both run one function, `runConformance`.

**The browser test is not a page of the app.** A conformance page or a
query parameter that pins the clock would ship test machinery to users and
is not what the issue asks for. The test builds the engine's source and
injects it, so the product has exactly one new route.

**The page runs live.** It shows scene `spike`, the three widgets as the
board will run them, on the real clock: a clock that shows the time of the
golden frames would look broken. The scene file gives the panel and the
placements, so the page holds no geometry.

**Reading the module's sections.** `WebAssembly.Module.imports` and
`exports` give names and kinds only. Signatures, the memory's limits and
the start function are in the binary's sections, which are simple to read
(a few LEB128 fields each); without them a module with a wrong signature
would fail at some later call with a message that names nothing.

**Memory growth.** The document has the host answer `memory.grow` past 4
pages with -1. WAMR and wasmi can; a browser enforces only the maximum a
module declares. The SDK's build declares 4 pages
(`.cargo/config.toml`), so every module built with it behaves exactly as
the document says. For a module that declares no such maximum the engine
ends the run when it finds the memory over the limit, which never yields a
wrong frame. Refusing such a module at load was the alternative; it would
turn away modules the document accepts and that never grow.

**A trap ends the run**, as in the test host (spec 107 AC-11). What a
board does with one failed placement while the others go on is the
overrun and crash rule of `rest-of-v0`.

**A pause control.** Content that moves for more than five seconds needs a
way to stop it (WCAG 2.2.2), and reduced motion is a setting the app
should honour from its first moving page.

## 5. Interfaces and files

The implementation's file scope:

- `web/simulator/` whole (new): `web/simulator/package.json`,
  `web/simulator/tsconfig.json`, `web/simulator/vitest.config.ts` (a
  sensitive path: it decides what the engine's `test` runs),
  `web/simulator/README.md`, `web/simulator/src/index.ts`, and the host and
  its tests under `web/simulator/src/`.
- The app, each by its full path: `web/package.json` (the dependency; the
  scripts of AC-2), `web/checks.test.ts`, `web/knip.json`,
  `web/vite.config.ts`, `web/.storybook/`, `web/playwright.config.ts` only
  if the build of the modules needs it, `web/README.md`,
  `web/src/app/router.tsx`, `web/src/pages/simulator/` (new),
  `web/src/pages/home/`, `web/src/shared/` (new shared pieces the design
  maps), `web/src/app/styles.css` (tokens the design adds), `web/e2e/`.
- `pnpm-workspace.yaml` (a sensitive path): the one `packages` entry. The
  security review checks that the build approvals, the install-before-run
  setting and the catalog are as they were.
- `.github/workflows/ci.yml` (a sensitive path): the reordering of AC-18.
  The security review checks that every step of the job is still there
  and that `pnpm test` runs what it ran before, plus the checks of AC-17.
- `pnpm-lock.yaml`.

The engine's public surface, for `layout-editor` and later hosts' tests:

```
loadModule(bytes) -> Promise<Module>          declarations: abi, updateHz, width, height
parseFont(bdfText) -> Font
createScene({ panel, fonts, assets, placements, environment }) -> Promise<Scene>
Scene: step(tick?), tick, frame, panel, placements
readScene(json) -> ConformanceScene
runConformance(scene, files) -> Promise<{ tick, frame }[]>
frameSha256(frame) -> Promise<string>
presentFrame(context, frame, width, height)
runLive(scene, { context, clock, requestFrame, onTick, onError }) -> { pause(), resume(), stop() }
SimulatorError: rule or placement, module, export, tick
```

The names may differ where the implementation finds better ones; the parts
and what each takes may not.

## 6. Verification

- `pnpm test` passes at the repository root with `simulator typecheck`
  and `simulator test` among the tests of `web/checks.test.ts`, and the
  app's `e2e` running the tests of AC-12 and AC-16; its output is in the
  implementation's final message, which contains the per-scene lines and
  the module hashes that AC-17 has a passing run print.
- CI's `test` job passes on the implementation PR; the PR's description
  quotes, from that job's log, the lines showing the four scenes passed
  under Node and in Chromium and the three module hash lines. The spec
  does not claim the build is reproducible across machines, so the hashes
  are not compared with those of the uploaded `spike-widgets` files.
- The golden tests fail when they should: the PR's description records
  one deliberate break made locally and reverted (for example the
  rounding term of the composition formula dropped), with the scene, tick
  and pixel the Node test named and the scene and tick the browser test
  named.
- `pnpm -F @panelator/web dev` serves `/simulator` with the clock showing
  the local time, the text scrolling and the image moving; the review
  compares source and stories with the design's renders at the three
  viewports (spec 098).
- The implementing machine needs the toolchain of `rust-toolchain.toml`
  with the `wasm32-unknown-unknown` target, and the Chromium that
  `pnpm install` downloads.

## 7. UI design

Screens: simulator, home

The design uses spec 112's frame and token set, and adds tokens only where
the panel needs them (its surround, the readouts). The engine does not
exist on `main` when the design is made, so the stories draw the panel
from the golden frame `sdk/conformance/golden/spike/tick-0.png`, enlarged
without smoothing; the implementation draws the live canvas in its place.

- `simulator`: the frame; a heading; the panel; its size in LEDs; the
  tick; the three placements, each with its module's name, declared rate
  and layer size; the pause control. The design decides the main region's
  width (reading width or full width), the widest the panel may be drawn
  at each viewport (AC-14 then picks the whole-number scale that fits),
  what surrounds the panel so that black LEDs at its edge can be told from
  the page, how the readouts are arranged at the three viewports, and
  whether the placements are a list or a table. The panel is raw pixels:
  square, edge to edge, no gaps, no glow. States, each rendered:
  - `loading`: the panel's place is held at its size, so nothing moves
    when the first frame arrives;
  - `running`: the default render;
  - `paused`: the control reads as resume; the tick stands still;
  - `failed`: the message region with the design's sentence, a line for
    the engine's message (monospace, wrapping, never wider than the
    page), and the control that loads the simulator again.
- `home`: spec 112's Home with the one change of AC-15: the link to the
  simulator and the note's wording, which now says that the editor and
  board control are not here yet and that the simulator page runs the
  runtime spike's three widgets. Everything else on Home is as spec 112's
  design left it. No states.

Flow: Home's link leads to `simulator`; the name in the frame leads home;
`failed`'s control leads to `loading` and then `running` or `failed`.
`flow.md` records these, the focus order, what a screen reader is told
when the state changes (the tick is not announced as it changes), the
canvas's accessible name, the copy of every state, and the component
mapping: which pieces are `shared/ui` (the panel view, which
`layout-editor` reuses) and which belong to the page. The thresholds are
the design stage's own: tap targets at least 44 CSS pixels on mobile,
text at least 14 CSS pixels, WCAG AA contrast.

## 8. Open decisions

None.
