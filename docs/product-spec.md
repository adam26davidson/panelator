# Panelator product specification

Status: v0 requirements, settled 2026-10-02 in a requirements grilling session.
Every decision below has its question, alternatives and rationale recorded in
[design-tree.md](design-tree.md). Change a decision there first, then here.

## 1. What panelator is

An open-source, fully configurable LED dashboard system. A HUB75 LED panel is
driven by an ESP32-S3 that renders everything locally. A hosted companion web
app lets users configure widgets and screens with a drag-and-drop editor and a
realistic simulator, and control their board live. Users can write their own
widgets and share them on a marketplace.

Audience: anybody. The web app and backend are hosted by the maintainer and
are also self-hostable. Nothing depends on the hosted service for the board to
keep showing its last applied configuration.

### Non-goals for v0

- Physical input devices (buttons, encoders). Reserved for later.
- Other panel geometries, chained panels, other dev boards. Must not be blocked.
- Community-filed feature intake (see the process spec).
- Sound, shared multi-user households, web app localisation.
- Custom widget configuration UI (reserved manifest field, see 7.4).
- Screen transitions beyond cut and fade (see 8.4).
- Federated marketplaces (see 9.3).

## 2. Hardware target

v0 targets exactly the existing hardware:

| Item | Value |
|---|---|
| MCU | ESP32-S3-N16R8 devkit (16 MB flash, 8 MB octal PSRAM) |
| Panel | one 128×64 HUB75E, P2.5, 1/32 scan, RGB |
| Carrier | the custom carrier PCB from `hardware/` (level shifters, protection, keyed HUB75 header) |

Constraints carried forward from this choice:

- Panel geometry, chain length and driver chip are configuration, never constants.
- Nothing in the renderer, the relay protocol or the web app assumes 128×64.
- The dev board is replaceable by a future open-source PCB with the ESP32 on it.
  Keep board-specific pins and peripherals behind one firmware board definition.
- Hardware licence: CERN-OHL-S. Software licence: Apache-2.0.

## 3. Firmware

- Native ESP-IDF, pinned version, built in the official container. Fresh
  codebase; the UDP-receiver firmware is history, but its panel driver settings
  and the boot-at-USB-safe-brightness lesson carry over.
- Rendering on device. Full RGB framebuffer. Content frame rate 60 Hz. The HUB75
  DMA library refreshes the panel independently of content.
- Two cores: rendering pinned to one, networking to the other.
- OTA: two app slots with rollback, signed builds verified before swap, stable
  and beta channels, auto-update by default applied in the sleep window.
- Storage: NVS for identity and WiFi, LittleFS for configs and assets.

### 3.1 Widget runtime

Widgets are WebAssembly modules executed by WAMR. The execution mode
(fast interpreter vs. ahead-of-time compiled on the backend) is decided by the
runtime spike (section 12). Interpreter is preferred if it hits 60 Hz with
headroom, because it keeps the trust story simplest.

### 3.2 Drawing model: retained layers

- Each widget placement owns an RGB layer buffer of its own size.
- The widget declares its update rate: on data change only, N Hz, up to 60 Hz.
- A native compositor blits all layers at 60 Hz with z-order and alpha.
- The host provides animations (scroll, fade) so widgets rarely need per-frame
  code.
- Overrun policy: a widget exceeding its per-call budget has that frame skipped;
  repeated overruns disable the widget and raise a visible error in the web app.
- Inactive screens: widgets that declare they emit events get a background tick
  at about 1 Hz with no drawing. Others do not run while their screen is hidden.

### 3.3 Host API (widget imports), v0

Available: draw on own layer (fill, pixel, line, rect, circle, image blit from a
named asset, text with a host font); read config; read declared data feeds as
normalised JSON; time since each feed last refreshed; current time and
timezone; emit a named event; a small capped per-placement key-value store that
survives reboots; log to the web app; random.

Absent by design: network, filesystem, other widgets, the framebuffer.

Fonts: host-provided Spleen, Unifont and truffle-shuffle. Uploadable bitmap
fonts as board assets later. Widgets may draw raw pixels for their own glyphs.

### 3.4 ABI versioning

The manifest declares the ABI version. Firmware supports a range. The backend
refuses installs the board's firmware cannot run and tells the user to update.
Breaking changes bump the major; the previous major stays supported for at
least one firmware release cycle.

## 4. Connectivity and identity

- Board holds an outbound WebSocket over TLS to the backend. CBOR messages.
  Families: hello (firmware version, panel geometry), config push, asset push,
  feed update, live-edit patch, override, command (reboot, update), telemetry
  (heap, fps). Reconnect with backoff.
- Offline rule: the board keeps rendering its last applied configuration with
  no backend. Only data feeds go stale, and widgets can show staleness.
- Identity: on first boot the board generates a keypair in NVS and
  authenticates with it. No secrets in firmware. Claiming binds the key to an
  account via a short code shown on the panel. Re-claiming requires a factory
  reset (web action or physical hold) that wipes key and WiFi.

### 4.1 Provisioning

SoftAP captive portal. While unprovisioned the panel shows the AP name and a QR
code that joins it. After WiFi succeeds it shows the claim code until claimed,
then its name and a tick. The portal has a hidden advanced field for the
backend URL, defaulting to the hosted instance (this is what makes self-hosting
work).

Rejected: BLE provisioning (Web Bluetooth is Chromium-only and absent on iOS;
two provisioning paths cost too much for v0).

## 5. Backend

Rust: axum, tokio, sqlx with compile-time checked queries on Postgres, tower
middleware, a workers crate for feed polling and transcoding, the `image` crate
for decoding, `wamrc` as a subprocess if AOT wins the spike. One workspace,
crates split by domain.

Responsibilities: accounts, board ownership, screen configs, data feeds,
marketplace, OTA distribution, asset transcoding and storage, relay, telemetry,
process metrics (see process spec), budget page.

### 5.1 Accounts and integrations

- Login: email magic link, Google OAuth, GitHub OAuth. Passkeys welcome later.
- Connected integrations are a separate subsystem from login: per-integration
  consent, encrypted token storage, refresh, revoke. Google Calendar is the
  first consumer. Start Google's scope verification early.
- An account owns multiple boards. Screens belong to a board; "duplicate to
  another board" instead of sharing.

### 5.2 Data feeds

All upstream fetching happens on the backend. The board never parses protobuf
or holds a user's private calendar URL.

- Transit: NYC (MTA GTFS-realtime) and Munich (MVG). Each city is a backend
  plugin with a stop importer (GTFS static on a schedule, indexed by name and
  coordinates) and a normaliser to a tiny "next departures at stop" shape.
  Feeds are keyed by stop and shared across all users: one upstream poll per
  stop. Updates are pushed over the relay.
- Calendar: ICS URL in v0 with RRULE expansion and real timezone handling on
  the backend. Google Calendar via connected integration. Source model is
  pluggable.
- Arbitrary URLs (weather, RSS, JSON): allowed, with constraints. The URL is
  entered by the board owner in the widget config, never baked into a widget.
  Response size cap, rate limit, private IP ranges blocked, body delivered only
  to that owner's boards.

### 5.3 Assets

Uploaded images and gifs are transcoded by the backend to raw RGB frame
sequences at the placement's size; the board only blits. 3 MB cap per asset,
per-board asset budget shown in the web app. Compressed frame formats are a
later optimisation.

### 5.4 Hosting

One Graviton EC2 instance running the same Docker Compose shipped to
self-hosters, Postgres included, Litestream or snapshots to S3 for backup.
S3 for assets, SES for email, CloudFront optional. Nothing else AWS-specific.

Observability: `tracing` structured logs, a handful of Prometheus-style
metrics, uptime check, error alerts to the maintainer. No third-party APM.

### 5.5 Shared budget

The hosted instance is funded by a public shared budget. The budget page reads
AWS Cost Explorer daily (about one cent per call) and shows balance, burn rate,
projected runway and a published degradation ladder: notice on boards and web
app, then non-essential services stop (publishing, transcoding), then data
feeds, then the relay last. Contributions carry no entitlements. Self-hosters
are unaffected.

### 5.6 Privacy floor

Minimal retention. Calendar URLs and integration tokens encrypted at rest.
Delete-account wipes everything including board claims. Short privacy page.
EU users are certain.

## 6. Type sharing

Rust types are the source of truth, annotated with `schemars` to emit JSON
Schema into `schemas/`. TypeScript types are generated from those schemas.
Firmware uses hand-written CBOR decoders tested against fixtures generated from
the same schemas. CI fails if committed schemas differ from what Rust emits.

## 7. Web app

React, Vite, TypeScript strict, Feature-Sliced Design enforced by steiger,
Biome, TanStack Router and Query, Zustand for editor state, Tailwind, Vitest
with Testing Library, Playwright, Storybook, knip. The simulator is a shared
engine (`shared/` or its own package), not a feature slice.

### 7.1 Simulator

Runs the identical WASM modules as the board, in the browser's engine, against
the same normalised feeds from the backend. Emulated LED look by default (round
LEDs, gaps, glow as a canvas shader over the framebuffer) with a raw-pixels
toggle.

### 7.2 Layout editor

Free placement at LED granularity (no coarser grid), overlaps allowed with
z-order. Widgets declare min, max and default size and whether they resize.
Widget config values are stored per placement.

### 7.3 Live editing

Draft by default; the simulator shows the draft. A "live" toggle streams
debounced patches (a few hundred ms) to the board over the relay. Explicit
apply finalises. An unfinished screen never replaces a working one by accident.

### 7.4 Widget configuration forms

Generated from the manifest's JSON Schema. Named picker types: `transit-stop`,
`calendar-source`, `image-asset`, `font`, `color`. A raw JSON editor is the
fallback for anything the form cannot express. Author-supplied custom UI is
not in v0; if added it runs in a sandboxed iframe on a separate origin with
postMessage only, and the manifest reserves a field for it now.

### 7.5 Live control

Switch screen, brightness, on/off and sleep schedule, pause/resume, push an
override (message or gif for N seconds), reboot, trigger update, live edit.

## 8. Screens and events

### 8.1 Switching

Manual; rotation with per-screen dwell; schedule by time of day; event-driven.
Physical input is reserved for later.

### 8.2 Events and rules

A widget emits named events. A rule: "when placement X emits event E, show
screen Y for N seconds, with cooldown". Events are local to the board and work
offline. Backend-evaluated rules may be added later.

### 8.3 Overrides

Overrides (message, gif) use the same mechanism at top priority. Replace, not
queue; newest wins. Pushable from the web app by the owner, or via a
token-authenticated HTTP endpoint with per-board tokens the owner can revoke
(for scripts, Home Assistant, phone shortcuts).

### 8.4 Transitions

Hard cut and fade in v0, host features selected per screen. Full-framebuffer
effects (e.g. the fish-swim from the predecessor project) become a host plugin
type later, not widgets.

## 9. Marketplace

### 9.1 Trust model

- Publishing requires an account and a claimed namespace (`@owner/widget`).
- The backend validates each module on upload: valid WASM, only host API
  imports, size and memory caps, manifest present and schema-valid.
- The install screen is a permission sheet: declared feeds, update rate,
  storage use.
- Installed widgets pin a version; the owner chooses auto-update or manual per
  widget. Report and takedown. No manual review before publish.
- The WASM sandbox is the security boundary; widgets cannot reach the network,
  so a marketplace widget cannot exfiltrate anything.
- Widgets must declare an OSI-approved licence of the author's choice.

### 9.2 SDKs

Rust is the primary SDK and the language of the built-in widgets.
AssemblyScript is a documented second SDK. The ABI specification is published
so any language works. A template repo per SDK.

### 9.3 Self-hosters

Self-hosted backends fetch from the maintainer's marketplace, URL configurable.
Publishing stays on the hosted instance so there is one trust root. Federation
(multiple sources) is a later addition.

## 10. Widget manifest

name, version, author/namespace, licence, ABI version, size constraints
(min, max, default, resizable), requested update rate, declared data feeds,
whether it emits events (and which), storage use, JSON Schema for config,
reserved field for custom config UI.

## 11. Built-in widgets (v0)

All written as WASM widgets in `widgets/` using the Rust SDK, so the API is
dogfooded.

1. Clock, configurable format and timezone.
2. Plain text.
3. Image or gif.
4. Transit departures: NYC or Munich, pick a stop, see upcoming departures.
5. Calendar: upcoming events from a configured calendar source.

## 12. Milestones

1. **Runtime spike.** WAMR in ESP-IDF on the S3. Three Rust widgets: a clock at
   1 Hz, scrolling text at 60 Hz, a 24 KB image blit at 30 Hz. Native 60 Hz
   compositor. Relay traffic running concurrently. Measure frame time, free
   heap and PSRAM, interpreter vs. AOT. Pass: stable 60 Hz with headroom for at
   least five more layers. Run the identical modules in the browser against a
   canvas. Record the numbers in `dev-logs/`; they become the published widget
   budget.
2. **Board-side layout.** JSON screen config in flash, one built-in widget,
   web app edits and pushes it through the relay, simulator parity.
3. **Provisioning.** Captive portal, claim code, board appears in the account.

## 13. Testing contracts

- Widget ABI conformance suite and golden pixel tests: the same WASM module
  must produce identical frames on the board, in the Rust test host and in the
  browser. First tests to write.
- Relay message round-trip tests against fixtures from `schemas/`.
- One transit normaliser test per city against recorded upstream responses.
- End-to-end "provision, claim, push a screen, see the frame" on the
  hardware-in-the-loop rig (the maintainer's laptop, which already runs a
  GitHub self-hosted runner).
- Per layer: rustfmt, clippy pedantic as errors, cargo-deny, cargo-nextest,
  sqlx offline; clang-format, clang-tidy, host-side unit tests for compositor
  and CBOR; Biome, steiger, knip, Vitest, Playwright.

## 14. Repository layout

```
firmware/            ESP-IDF project
backend/             Rust workspace
web/                 React app (FSD)
sdk/rust/            Widget SDK + template
sdk/assemblyscript/  Widget SDK + template
widgets/             Built-in widgets
schemas/             Generated JSON Schema (CI-checked)
hardware/            Carrier PCB (moves here from char-matrix-dashboard), CERN-OHL-S
docs/                Architecture, user docs, SDK guide, decisions/ (ADRs)
specs/               One spec per feature
dev-logs/            Dated measured findings
```

The predecessor repo `char-matrix-dashboard` is frozen with a pointer here.
