# Building v0: the product spec as ordered work

Status: written 2026-11-22 for issue #422 (delivery plan #419, item 4). The
product spec had no children, so the pipeline had no product work to claim.
This design is the product spec's breakdown into spec-sized children, in the
maintainer's milestone order. It adds no product decision and changes none.
Parent: docs/product-spec.md
Derives from: [product spec](../product-spec.md) sections 2 to 14, section 12
above all; [design-tree](../design-tree.md) R2.Q8 (the first milestone and
the order after it), R6.Q12 (machinery crowding out product is measured);
[charter](../charter.md) (delivery speed and value to users for the product;
the ratio of system work to product work is a parameter);
[delivery-system design](../delivery-system-design.md) sections 3, 10 and 11;
[spec 031](../../specs/031-design-files-children/spec.md) (planned children
and their filing); [spec 070](../../specs/070-test-board/spec.md) section 8
and [ADR 0013](../decisions/0013-test-board-gate-before-firmware.md) (the HIL
workflow is the firmware's own);
[ADR 0016](../decisions/0016-product-breakdown-is-one-ordered-design.md) (why
one flat design).

## 1. Intent

Turn `docs/product-spec.md` into issues the chain can build, starting with
milestone 1. Each child below is one spec, one issue and one chain, lies in
one domain (`firmware`, `widget`, `web-ui` or `backend`, as the plan stage
assigns them), and leaves `main` working when it merges. The scheduler files
the children when this design merges (spec 031); the ones with no `after:`
are eligible at once.

## 2. What the maintainer decided

Nothing here is new direction. The order comes from the product spec, section
12, and from the design tree, quoted as written there:

> **R2.Q8 First milestone.** Options: board-side layout; provisioning; runtime
> spike. **Decision:** runtime spike first; if WASM cannot hit 60 Hz the runtime
> decision changes and everything downstream moves. Then layout, then
> provisioning.

The product spec's stacks, promises and non-goals bind every child as they
stand. A child's spec that would contradict the product spec is a change to
the product spec first, and that is the maintainer's (delivery-system design
section 10).

## 3. The breakdown

| Milestone (product spec 12) | Children, in build order | Product spec sections they build |
|---|---|---|
| 1. Runtime spike | `firmware-project-and-hil`, `firmware-panel-driver`, `widget-abi-and-rust-sdk`, `firmware-wasm-runtime`, `backend-workspace-and-relay-stub`, `firmware-relay-client`, `web-app-skeleton`, `simulator-engine`, `runtime-spike-measurement` | 2 (the board), 3 (toolchain, cores), 3.1, 3.2, the drawing part of 3.3, 4 (the socket only), 7 (toolchain), 7.1 (the engine), 9.2 (the Rust SDK), 12.1, 13 (ABI conformance and golden frames, per-layer checks) |
| 2. Board-side layout | `screen-config-and-type-sharing`, `first-builtin-widget`, `backend-screen-store-and-relay`, `firmware-screen-config`, `layout-editor` | 3 (LittleFS), 4 (hello, config push, the offline rule), 5 (Postgres, relay, screen configs), 6, 7.1 (the LED look), 7.2, 7.3 (draft and apply), 7.4 (generated forms), 10, 11 (the clock), 13 (relay round-trips) |
| 3. Provisioning | `backend-accounts-and-login`, `board-identity-and-claiming`, `firmware-provisioning`, `web-login-and-boards`, `hil-provision-claim-push` | 4 (identity), 4.1, 5.1 (login, ownership), 13 (the end-to-end test) |
| None set yet | `rest-of-v0` | everything else: see section 5 |

The carrier PCB's move into `hardware/` (product spec 2 and 14) depends on no
milestone and is a child of the product spec itself, beside this design.

Milestone 1 has four starting points that need nothing from one another: the
firmware project, the widget ABI and SDK, the backend workspace and the web
app's skeleton. They are filed unblocked, so product work can start in every
domain at once. Everything of milestones 2 and 3 waits for
`runtime-spike-measurement`, because the maintainer's decision says the
spike's result can move all of it.

## 4. Rules the children share *(agent's calls)*

- **Order is the `after:` line, and only siblings can be named.** A child
  that turns out to be larger than one chain does not become a nested
  sub-design: its spec PR replaces its planned bullet in this document with
  several planned bullets, each with its own `after:`, and leaves a
  `README.md` in its spec directory. A nested design's issue closes when the
  design merges, which would release every sibling waiting on it before any
  of its work exists (ADR 0016).
- **Geometry is configuration.** No child hard-codes 128×64, a chain length
  or a driver chip in the renderer, the relay messages, the simulator or the
  web app (product spec 2). Board pins and peripherals stay behind the one
  board definition `firmware-panel-driver` creates.
- **One ABI, three hosts.** `widget-abi-and-rust-sdk` owns the ABI document,
  the host-import list and the golden frames. The device runtime
  (`firmware-wasm-runtime`) and the browser engine (`simulator-engine`)
  implement that document and are tested against those frames; neither adds
  an import the document lacks. A change to the ABI is a change to that
  child's files, in the same PR as the hosts that need it.
- **Rust types are the source of the wire format** from
  `screen-config-and-type-sharing` on (product spec 6). Milestone 1's relay
  traffic is a stub and fixes no message shape.
- **Firmware is tested on the board.** `firmware-project-and-hil` brings the
  HIL workflow that spec 070 section 8 describes; every later firmware child
  adds its tests to that suite. Until the workflow is on `main`, no other
  firmware child is unblocked.
- **Checks arrive with the layer.** Each skeleton child adds its layer's
  checks from product spec 13 to CI and to `pnpm test` or a job beside it
  (the required check is `test`), and later children keep them green.
- **Credentials, the board and outside parties** are asked for by the child
  that first needs them, as a capability question with its request
  (delivery-system design section 3). A brief names the ones already known.

## 5. What is left open

- **Milestones after 3.** The product spec sets three milestones and no order
  for the rest of v0 (OTA, the remaining host API, data feeds, assets,
  integrations, hosting, the budget page, privacy, live control, events and
  overrides, the marketplace, the second SDK, four built-in widgets).
  Milestones are a product decision. `rest-of-v0` asks the maintainer for
  that order once the spike's numbers exist, and then adds its breakdown to
  this document; no child here assumes an answer.
- **A failed spike.** If neither execution mode meets the pass rule of
  product spec 12.1, `runtime-spike-measurement` returns the question to the
  maintainer and nothing waiting on it is unblocked.
- **The built-in widget of milestone 2** is the clock *(agent's call: the
  spike already runs a clock, and it needs no feed, asset or account)*. Which
  widgets are built in is the product spec's section 11, unchanged.

## Children

- `specs/106-firmware-project-and-hil/spec.md` (issue #428)
- planned: firmware-panel-driver
  title: Firmware: board definition, HUB75 panel driver and a full RGB framebuffer showing a test pattern
  brief: Milestone 1 (product spec 2, 3). On the project of `firmware-project-and-hil`, add the one board
    definition that holds every pin and peripheral of the devkit and the carrier PCB, the HUB75 DMA panel
    driver with panel geometry, chain length and driver chip as configuration (128×64 HUB75E, 1/32 scan
    is the configured value, never a constant), boot at USB-safe brightness, a full RGB framebuffer the
    panel refreshes independently of content, and the two-core task layout (rendering pinned to one core,
    networking to the other) with a 60 Hz content loop that draws a test pattern. Add HIL tests for boot
    and frame rate. The pin mapping, the panel driver settings and the brightness lesson come from the
    predecessor firmware in `char-matrix-dashboard` (or from `hardware/` once the carrier is there); the
    App's token cannot read that repository, so ask for the files or the access as a capability question.
    WASM, layers and the compositor are `firmware-wasm-runtime`.
  after: specs/106-firmware-project-and-hil/spec.md
  class: class:product
- `specs/107-widget-abi-and-rust-sdk/spec.md` (issue #430)
- planned: firmware-wasm-runtime
  title: Firmware: WAMR runs the spike widgets on retained layers under a native 60 Hz compositor
  brief: Milestone 1 (product spec 3.1, 3.2, 3.3, 12.1). Embed WAMR in the firmware, buildable in both
    execution modes (fast interpreter, and AOT with modules compiled by `wamrc` at build time), and
    implement the host imports of the ABI document of `widget-abi-and-rust-sdk`. Each placement owns an
    RGB layer buffer of its own size; a native compositor blits all layers at 60 Hz with z-order and
    alpha; a widget is called at its declared rate; a call over its budget has that frame skipped. The
    three spike modules are embedded in the image and placed by a compiled-in table (stored screen configs
    are milestone 2). Record frame time, fps, free heap and free PSRAM where a HIL test can read them, and
    add HIL tests that the board's frames equal the golden frames. The measurement and the choice of mode
    are `runtime-spike-measurement`.
  after: firmware-panel-driver, specs/107-widget-abi-and-rust-sdk/spec.md
  class: class:product
- `specs/111-backend-workspace-and-relay-stub/spec.md` (issue #432)
- planned: firmware-relay-client
  title: Firmware: an outbound WebSocket over TLS on the networking core, with reconnect and backoff
  brief: Milestone 1 (product spec 4, 12.1). On the networking core, join WiFi with credentials given at
    build or flash time (provisioning is milestone 3), hold an outbound WebSocket over TLS to a configured
    backend URL, exchange CBOR messages with the stub of `backend-workspace-and-relay-stub`, and reconnect
    with backoff. Rendering keeps its rate while traffic flows and while the connection is down. HIL tests
    cover connect, traffic and reconnect; the rig's WiFi credentials are a capability request if the
    runner does not have them. Message families and their decoders are `firmware-screen-config`.
  after: firmware-panel-driver, specs/111-backend-workspace-and-relay-stub/spec.md
  class: class:product
- `specs/112-web-app-skeleton/spec.md` (issue #434)
- planned: simulator-engine
  title: Simulator engine: the same WASM modules run in the browser against a canvas
  brief: Milestone 1 (product spec 7.1, 12.1, 13). A shared engine package (not a feature slice) that
    loads the identical WASM modules in the browser's engine, implements the host imports of the ABI
    document of `widget-abi-and-rust-sdk` with the same retained layers and compositor rules, and draws
    the framebuffer to a canvas at any configured geometry. A test runs the three spike modules and
    requires frames equal to the golden frames. One page in the app shows the three widgets running, with
    raw pixels. The emulated LED look and the draft screen are `layout-editor`.
  after: specs/112-web-app-skeleton/spec.md, specs/107-widget-abi-and-rust-sdk/spec.md
  class: class:product
- planned: runtime-spike-measurement
  title: Runtime spike: measure interpreter and AOT on the board, record the numbers and the execution mode
  brief: Milestone 1's result (product spec 3.1, 12.1; design-tree R2.Q8). A HIL job runs the three spike
    widgets with relay traffic flowing, in each execution mode, with five more layers added, and reports
    frame time, free heap and free PSRAM. Record the numbers in `dev-logs/`, publish them as the widget
    budget in the SDK documentation, and record the execution mode as an ADR by the product spec's rule
    (the interpreter if it holds a stable 60 Hz with headroom for at least five more layers; AOT if only
    AOT does). Confirm the browser engine runs the identical modules. If neither mode passes, change
    nothing downstream and return the question to the maintainer: R2.Q8 says the runtime decision then
    changes. The firmware keeps only the chosen mode as its default after this child.
  after: firmware-wasm-runtime, firmware-relay-client, simulator-engine
  class: class:product
- planned: screen-config-and-type-sharing
  title: Screen config and relay message types in Rust, emitted as JSON Schema, TypeScript types and CBOR fixtures
  brief: Milestone 2 (product spec 6, 4, 10, 13). Define in a backend crate the Rust types for a screen
    config (placements with widget, position and size at LED granularity, z-order and per-placement config
    values), the widget manifest of product spec 10, and the relay message families milestone 2 needs
    (hello with firmware version and panel geometry, config push), annotated with `schemars`. Emit JSON
    Schema into `schemas/`, generate TypeScript types from it for `web/`, generate CBOR fixtures for the
    firmware's decoders, and fail CI when the committed schemas differ from what Rust emits. Round-trip
    tests run against the fixtures. Storage and the relay service are `backend-screen-store-and-relay`.
  after: runtime-spike-measurement
  class: class:product
- planned: first-builtin-widget
  title: Built-in widget: the clock, with its manifest and config schema
  brief: Milestone 2's one built-in widget (product spec 10, 11, 9.2). Turn the spike's clock into the
    built-in clock in `widgets/` on the Rust SDK: configurable format and timezone, a manifest with the
    fields of product spec 10 (the custom config UI field reserved), a JSON Schema for its config, size
    constraints and update rate, and golden frames. The manifest validates against the JSON Schema that
    `screen-config-and-type-sharing` emits from its Rust types, which own the manifest's format; this
    child writes the clock's manifest to that format and does not define it. Add to the SDK and the ABI document what the manifest
    and config reading need. Its UI design covers the widget at its default and minimum sizes. The other
    four built-in widgets wait for feeds and assets in `rest-of-v0`.
  after: runtime-spike-measurement, screen-config-and-type-sharing
  class: class:product
- planned: backend-screen-store-and-relay
  title: Backend: Postgres, the screen store and the relay that pushes a screen config to a board
  brief: Milestone 2 (product spec 5, 4, 5.4). Add Postgres with sqlx compile-time checked queries and
    sqlx offline in CI, a Docker Compose file that runs the backend and Postgres (the one later shipped
    to self-hosters), boards and their screens (screens belong to a board), an HTTP API the web app uses
    to read and write a screen and apply it, and the relay proper in place of the stub: a board's hello,
    config push on apply and on reconnect, built on the types of `screen-config-and-type-sharing`. There
    are no accounts yet, so every connected board belongs to the one local user until
    `backend-accounts-and-login`; nothing is deployed to the hosted instance.
  after: screen-config-and-type-sharing
  class: class:product
- planned: firmware-screen-config
  title: Firmware: screen configs stored in flash, applied from the relay and rendered with no backend
  brief: Milestone 2 (product spec 3, 4, 13). LittleFS for configs and assets, hand-written CBOR decoders
    for hello and config push tested against the fixtures from `schemas/`, a hello carrying firmware
    version and panel geometry, and a config push that is validated, stored and applied by building the
    placements and layers it names. The built-in clock module ships in the image. After a reboot with no
    backend the board renders its last applied config (the offline rule). Host-side unit tests for the
    decoders and the compositor, HIL tests for push, apply and offline boot. Identity, WiFi provisioning
    and claiming are `firmware-provisioning`.
  after: screen-config-and-type-sharing, first-builtin-widget
  class: class:product
- planned: layout-editor
  title: Web app: the layout editor with the simulator showing the draft, and apply pushing it to the board
  brief: Milestone 2 (product spec 7.1, 7.2, 7.3, 7.4, 12.2). A screen editor with free placement at LED
    granularity, overlaps with z-order, and resize within the widget's declared sizes; a config form
    generated from the manifest's JSON Schema with a raw JSON editor as fallback; the simulator showing
    the draft with the emulated LED look (round LEDs, gaps, glow) and a raw-pixels toggle; and an explicit
    apply that saves the screen through the backend, which pushes it over the relay. A draft never
    replaces the applied screen. Parity is tested: the applied screen's frame in the simulator equals the
    Rust test host's. The live toggle, the named pickers and live control are in `rest-of-v0`.
  after: first-builtin-widget, backend-screen-store-and-relay
  class: class:product
- planned: backend-accounts-and-login
  title: Backend: accounts with email magic link, Google and GitHub login
  brief: Milestone 3 (product spec 5.1, 5.6). Accounts and sessions with the three login methods of
    product spec 5.1, the API of `backend-screen-store-and-relay` put behind a session, and delete-account
    wiping everything the account owns. Sending mail and the two OAuth clients need credentials: ask for
    each as a capability question with its request, and keep a local mode that needs none for tests and
    self-hosters' first run. Connected integrations (Google Calendar) are a separate subsystem left to
    `rest-of-v0`. Boards and claiming are `board-identity-and-claiming`.
  after: backend-screen-store-and-relay
  class: class:product
- planned: board-identity-and-claiming
  title: Backend: boards authenticate with their own key and are claimed into an account by a short code
  brief: Milestone 3 (product spec 4, 5.1). The relay authenticates a board by the public key it presents
    and a signature, with no secret in firmware; an unclaimed board is given a short claim code; an
    account that enters the code owns the board; an account owns several boards and screens stay with
    their board; a factory reset started from the web releases the claim. Delete-account of `backend-accounts-and-login` also removes the account's claims
    and what its boards hold, per product spec 5.6. The message types are added in
    the crate of `screen-config-and-type-sharing` with their schemas and fixtures. The one-local-user
    rule of milestone 2 ends here. The board's side is `firmware-provisioning`, the screens are
    `web-login-and-boards`.
  after: backend-accounts-and-login
  class: class:product
- planned: firmware-provisioning
  title: Firmware: first-boot identity, the SoftAP captive portal and the claim code on the panel
  brief: Milestone 3 (product spec 4, 4.1, 3). On first boot generate a keypair in NVS and authenticate
    to the relay with it. While unprovisioned, run a SoftAP captive portal and show the AP name and a QR
    code that joins it; the portal takes WiFi credentials and, in a hidden advanced field, the backend
    URL, defaulting to the hosted instance. After WiFi succeeds show the claim code until claimed, then
    the board's name and a tick. A factory reset (from the web, or a physical hold) wipes key and WiFi.
    NVS holds identity and WiFi. HIL tests cover what the rig can drive without a person.
  after: firmware-screen-config, board-identity-and-claiming
  class: class:product
- planned: web-login-and-boards
  title: Web app: login, claiming a board by its code, and the account's boards
  brief: Milestone 3 (product spec 5.1, 4, 12.3). Login screens for the three methods, a claim flow that
    takes the code shown on the panel, a list of the account's boards with name, firmware version and
    connection state, the editor of `layout-editor` opened per board, a factory-reset action and
    delete-account. Its UI design covers these screens at the three viewports.
  after: board-identity-and-claiming, layout-editor
  class: class:product
- planned: hil-provision-claim-push
  title: End-to-end on the rig: provision, claim, push a screen, see the frame
  brief: Milestone 3's proof (product spec 13). A HIL test that starts from a factory-reset board, drives
    the captive portal, claims the board into a test account on a backend running on the laptop, pushes a
    screen with the clock, and checks the board's frame against the golden frame. It adds what the
    harness needs to drive the portal and read a frame, and writes the first full run up in `dev-logs/`.
    It changes no product behaviour; a defect it finds is a finding for the child that owns it.
  after: firmware-provisioning, web-login-and-boards
  class: class:product
- planned: rest-of-v0
  title: Break down the rest of v0 after the runtime spike: ask for the milestones after 3 and add the children
  brief: Everything in the product spec that milestones 1 to 3 do not build - OTA with the release
    workflow of spec 070 section 8 and the stable and beta channels (3); the rest of the host API, fonts
    and the overrun and inactive-screen rules (3.2, 3.3); ABI range enforcement (3.4); the remaining
    relay families (asset push, feed update, live-edit patch, override, command, telemetry); connected
    integrations (5.1); data feeds (5.2); assets (5.3); hosting and observability (5.4); the shared
    budget page (5.5); the privacy floor and page (5.6); live editing, the named pickers and live control
    (7.3, 7.4, 7.5); screens, events, overrides and transitions (8); the marketplace and the second SDK
    with its templates (9); the image, text, transit and calendar widgets (11); the remaining testing
    contracts (13); user and SDK documentation (14). The product spec sets no milestone for any of it,
    and milestones are the maintainer's decision: with the spike's numbers in `dev-logs/`, ask the
    maintainer for the milestones after provisioning as a product question, record the answer in
    `docs/product-spec.md` section 12, then replace this bullet with planned children in this document,
    each one spec in one domain with the `after:` lines that hold it behind the milestone 2 and 3
    children it stands on, and leave a `README.md` in this child's spec directory (design section 4).
  after: runtime-spike-measurement
  class: class:product
