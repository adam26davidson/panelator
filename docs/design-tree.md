# Design tree

The requirements grilling session of 2026-09-30 to 2026-10-02 that produced
[product-spec.md](product-spec.md) and [process-spec.md](process-spec.md).
Each entry: the question, the options considered, the decision, and why the
alternatives lost. Future agents: do not re-litigate a decision here without a
new ADR that references it.

Facts gathered before and during the session, so nothing below was assumed:

- Predecessor firmware is a UDP 1-bit frame receiver on an ESP32-S3-N16R8
  (16 MB flash, 8 MB PSRAM), Arduino/PlatformIO, no BLE, no HTTP server,
  credentials compiled in. Panel is RGB hardware driven mono. Carrier PCB is
  built for this exact devkit and panel; prototype order paid 2026-09-30.
- Predecessor automation system (kari-website): systemd timer on the laptop
  runs Claude Code headless; Fable for judgment, Opus for implementation;
  autonomous squash merge; human gate only at production deploy; cadence
  changed seven times in two months because of token quota; two thirds of
  merged agent PRs were machinery; Telegram polled only on the 15-minute tick.

## Round 1: roots

**R1.Q1 Who is this for?** Options: me only; hobbyists with the same hardware;
sellable device with hosted service. **Decision:** anybody, maintainer hosts
the web app and backend. Open source is fine for security: security comes from
secrets, board auth and the sandbox, not from hidden code.

**R1.Q2 Cloud backend?** Options: static app talking to board on LAN; hosted
app plus backend the board also talks to; hybrid. **Decision:** a backend is
needed and designed fresh (none existed).

**R1.Q3 What carries over?** Options: nothing; TS renderer becomes simulator
and firmware reimplements; one core on both targets. **Decision:** hardware and
knowledge carry; widgets and firmware start fresh. One core on both targets
achieved via WASM (R2.Q3).

**R1.Q4 Why BLE?** Options: BLE via Web Bluetooth; dedicated app; SoftAP
captive portal. **Decision:** SoftAP captive portal. Rejected BLE: Web
Bluetooth is Chromium-only, absent on iOS; two paths too costly for v0.

**R1.Q5 "Control live" means:** switch screen, brightness, on/off and sleep,
pause, override message or gif for N seconds, reboot, OTA, live edit.
**Decision:** all of them, including live edit.

**R1.Q6 Screen switching model.** **Decision:** manual, rotation, schedule and
event-driven in v0; physical input device later.

**R1.Q7 Hardware generality.** **Decision:** v0 scoped to current hardware;
nothing blocking other panels, chaining or a replacement dev board (future
own PCB). Geometry and driver are configuration.

**R1.Q8 First milestone.** Deferred to R2.Q8.

## Round 2: topology and runtime

**R2.Q1 How does a hosted app reach a LAN board?** Mixed content and Private
Network Access block https page → http board. Options: (a) board holds
outbound WebSocket to backend, backend relays; (b) board serves the web app
itself over http, no hosted app; (c) both. Side question answered: the board
*can* serve a SPA from its 7.9 MB LittleFS, but only over plain http, the UI
version becomes pinned to firmware, and remote access is lost. **Decision:**
(a), with the offline rule that the board keeps rendering without the backend.
(c) deferred.

**R2.Q2 Backend responsibilities and accounts.** **Decision:** backend owns
accounts, board ownership, configs, data proxy, marketplace, OTA. Login via
email magic link plus Google and GitHub OAuth. Claim by code on the panel.

**R2.Q3 Widget runtime.** Options: WASM (WAMR/wasm3 on board, native engine in
browser); JavaScript via QuickJS; Lua; declarative JSON only. **Decision:**
WASM. It is the only option where the marketplace security claim is true by
construction and the simulator runs the identical bytes. Cost: SDK toolchain.

**R2.Q4 Colour.** Options: mono; small palette; full RGB. **Decision:** full
RGB in API and framebuffer from day one, 60 Hz content rate is a requirement.
Framebuffer format is the hardest thing to change later.

**R2.Q5 Where is data fetched?** Options: board fetches upstream; backend
normalises to tiny JSON; widgets fetch arbitrary URLs. **Decision:** backend
normalises. Board never parses protobuf or holds a private calendar URL.

**R2.Q6 Event model.** Options: widgets emit events and screen rules react;
backend-side rules; both. **Decision:** widget events, local, offline-capable.
Backend rules later.

**R2.Q7 Who can push an override?** **Decision:** owner from the web app and a
token-authenticated endpoint with revocable per-board tokens.

**R2.Q8 First milestone.** Options: board-side layout; provisioning; runtime
spike. **Decision:** runtime spike first; if WASM cannot hit 60 Hz the runtime
decision changes and everything downstream moves. Then layout, then
provisioning.

## Round 3: drawing model, SDK, layout, infra

**R3.Q1 Drawing model.** Options: immediate mode every frame; retained layers
with declared update rates and a native 60 Hz compositor; retained layers plus
host-provided animations. **Decision:** retained layers plus host animations.
Overrun: skip frame, then disable with visible error.

**R3.Q2 SDK language.** Options: AssemblyScript; Rust; C/C++; Zig.
**Decision:** Rust primary (built-ins written in it), AssemblyScript second,
ABI published.

**R3.Q3 Fonts.** Options: bundled in each module; host font API.
**Decision:** host API with Spleen, Unifont, truffle-shuffle; uploadable fonts
later; raw pixel drawing always allowed.

**R3.Q4 Layout model.** Options: free pixel placement with z-order; grid
snap; fixed bands. **Decision:** free placement. Maintainer note: at this
resolution the LED itself is the snap, so no 8 px grid.

**R3.Q5 Manifest and config.** **Decision:** manifest with JSON Schema config,
named picker types (transit-stop, calendar-source, image-asset, font, color),
config stored per placement. Follow-up: raw JSON fallback editor yes;
author-supplied custom UI is a security risk in the app origin, only viable in
a sandboxed iframe, deferred with a reserved manifest field.

**R3.Q6 Arbitrary URLs.** Options: no; yes with constraints. **Decision:** yes:
owner-entered URL, size cap, rate limit, no private ranges, body only to that
owner's boards. Weather alone justifies it.

**R3.Q7 Live editing.** Options: immediate apply; draft plus explicit apply;
draft with a live toggle streaming debounced patches. **Decision:** draft with
live toggle and explicit apply.

**R3.Q8 Board settings.** **Decision:** name, timezone, geometry and driver,
brightness with day/night schedule, sleep schedule, screen mode and dwell,
auto-update policy. Multiple boards per account; screens per board with
duplicate-to-board rather than sharing.

**R3.Q9 Firmware framework.** Options: Arduino/PlatformIO; ESP-IDF.
**Decision:** ESP-IDF. WAMR ships as an IDF component; proper task pinning,
TLS, OTA with rollback.

**R3.Q10 Images and gifs.** Options: board decodes; backend transcodes to raw
frames. **Decision:** backend transcodes, 3 MB per asset cap, per-board budget.

**R3.Q11 OTA policy.** **Decision:** auto-update default in sleep window,
stable and beta channels, signed builds.

**R3.Q12 Who pays?** Options: free; free with limits and donations;
self-hostable; paid tier. **Decision:** self-hostable from day one and a
public shared budget anyone can contribute to. Refinements: a degradation
ladder instead of a hard shutdown; contributions carry no entitlements; the
budget page must be live from the billing API.

**R3.Q13 Board identity.** **Decision:** self-generated keypair in NVS, claim
code, factory reset wipes key and WiFi.

## Round 4: APIs, marketplace, stacks

**R4.Q1 Host API v0.** **Decision:** drawing, config, feeds, time, events,
capped KV, log, random, plus feed staleness. No network, filesystem, or
cross-widget access.

**R4.Q2 Inactive screens.** Options: only active screen runs; everything runs;
event-emitting widgets get a low-rate background tick. **Decision:** background
tick at about 1 Hz for event emitters. Rules: placement X emits E → show
screen Y for N seconds with cooldown. Overrides replace, newest wins.

**R4.Q3 Marketplace trust.** **Decision:** account to publish, automated module
validation, permission-sheet install, pinned versions with per-widget
auto-update choice, report and takedown, claimed namespaces. No pre-publish
manual review.

**R4.Q4 Data feeds and stop pickers.** **Decision:** GTFS static import per
city, per-city backend plugin, feeds keyed by stop shared across users, pushed
over relay.

**R4.Q5 Calendar sources.** Options: ICS only; plus Google via OAuth.
**Decision:** both in v0. Maintainer reasoning: token handling is a reusable
connected-integrations subsystem. Pushback recorded: login OAuth and
integration OAuth are different subsystems; Google scope verification takes
weeks, start early.

**R4.Q6 Simulator fidelity.** **Decision:** emulated LED look by default, raw
toggle.

**R4.Q7 WASM execution mode.** Options: interpreter; backend AOT; decide from
spike. **Decision:** spike measures both; interpreter preferred if it hits
60 Hz with headroom.

**R4.Q8 Spike criteria.** **Decision:** three Rust widgets (1 Hz clock, 60 Hz
scroll, 30 Hz 24 KB blit), 60 Hz compositor, relay traffic concurrent, measure
frame time and memory, pass with headroom for five more layers, same modules in
browser, numbers in a dev-log.

**R4.Q9 Backend and web stack.** Proposed TypeScript throughout.
**Decision (maintainer override):** frontend TypeScript, backend Rust, for AWS
efficiency. Feature-Sliced Design on the frontend. Tooling must enforce
cleanliness.

**R4.Q10 Relay protocol.** **Decision:** WebSocket over TLS, CBOR, keypair
auth, message families listed in the product spec, plus a hello with firmware
version and geometry.

**R4.Q11 Privacy.** **Decision:** minimal retention, encrypted calendar URLs,
full delete, privacy page.

**R4.Q12 Repo shape.** **Decision:** firmware, backend, web, sdk/rust,
sdk/assemblyscript, widgets, schemas, hardware, docs, specs, dev-logs.
Hardware moves here; predecessor repo frozen. Maintainer additions: `docs/`
for high-level and user docs, `specs/` for feature specs, and deep research
into AI-driven repo methods.

## Round 5: tooling and infrastructure

**R5.Q1 AWS compute.** Options: Fargate plus RDS; one Graviton EC2 running the
self-host Compose; Lambda plus API Gateway WebSockets plus DynamoDB.
**Decision:** single EC2. Cheapest, exercises the self-host path on every
deploy. Rejected serverless: breaks self-hosting and budget legibility.

**R5.Q2 Rust stack.** **Decision:** axum, tokio, sqlx, tower, workers crate,
`image`, `wamrc` subprocess if AOT; crates by domain.

**R5.Q3 Type sharing.** Options: Rust source of truth with schemars → JSON
Schema → TS; hand-written JSON Schema; protobuf. **Decision:** Rust source of
truth, CI checks committed schemas.

**R5.Q4 Frontend tooling.** **Decision:** React, Vite, TS strict, FSD via
steiger, Biome, TanStack Router and Query, Zustand, Tailwind, Vitest,
Playwright, Storybook, knip. Simulator is a shared engine, not a slice.

**R5.Q5 Rust and firmware tooling.** **Decision:** rustfmt, clippy pedantic as
errors, cargo-deny, nextest, sqlx offline; pinned IDF container, clang-format,
clang-tidy, host unit tests, HIL on the existing self-hosted runner.

**R5.Q6 Cross-cutting tests.** **Decision:** ABI conformance and golden pixel
tests first; relay round-trips from fixtures; normaliser tests per city; HIL
end-to-end.

**R5.Q7 / Q8 Specs workflow and research scope.** Maintainer: keep the
workflow open pending research; the research is where the most thinking is
needed; include token efficiency, the kari-website system, harness selection
(pi a candidate), and the end-to-end feature flow. Maintainer noted several
pieces were being conflated, which led to round 6's decomposition.

**R5.Q9 Observability and budget page.** **Decision:** tracing, few metrics,
uptime, alerts; Cost Explorer daily; ladder published.

## Round 6: decomposition and agent runtime

**R6.Q1 Decomposition into six pieces.** **Decision:** accepted. Grilling is a
stage of the lifecycle. Maintainer: lifecycle deserves further decomposition;
measurement is very important.

**R6.Q2 Human gates.** Options from every gate to spec-approval-only.
**Decision:** maintainer in the loop only at grilling. Autonomy ladder driven
by metrics.

**R6.Q3 Who can request?** **Decision:** anyone files; cheap triage only;
nothing expensive until the maintainer labels; grilling only with a maintainer
answering. Later superseded by R8 intake tracks.

**R6.Q4 Where grilling happens.** **Decision:** CLI and issue thread, issue as
system of record. Later refined by R8.Q1 to chat (CLI or Telegram) posting to
the issue.

**R6.Q5 Harness constraints.** **Decision:** open source, headless on own
runner, model-agnostic (wide variety of models), skills, cost controls,
coexists with Claude Code. Candidates pi, Claude Code headless, Codex CLI,
OpenCode; real task through each.

**R6.Q6 Autonomy north star.** Options: agents as fast hands; small changes
flow untouched; project runs itself. **Decision:** project runs itself, with
the maintainer as reviewer of last resort.

**R6.Q7 Where the research lands.** **Decision:** create the new repo now;
research runs immediately after, in parallel, synthesis separates what others
do from what is new.

**R6.Q8 Session output.** **Decision:** product spec, process spec, and this
design tree.

**R6.Q9 Where agents run.** Options: laptop timer; ThinkPad; GitHub-hosted;
cloud box. Fact correction by maintainer: the laptop and the ThinkPad are the
same machine. **Decision:** this laptop. Predecessor failure modes must be
addressed explicitly.

**R6.Q10 Event-driven or polling.** Maintainer pushback: the queue is never
empty, so event-driven assumes something false. **Decision:** pull on
completion into a concurrency slot, woken by events, watchdog timer only.

**R6.Q11 What carries from kari-website.** **Decision:** defer to research,
except model tiering, cost-capped fallback, usage records and brief templates.

**R6.Q12 Machinery crowding out product.** **Decision:** measure as a
first-class metric; automation changes need a human-approved spec. Maintainer
added the completeness principle after a predecessor pagination bug.

## Round 7: lifecycle, metrics, release safety, research plan

**R7.Q1 Stage list.** Maintainer reshaped intake into two tracks (maintainer
via chat, agent findings validated before filing), community deferred, product
direction only through the maintainer, Telegram for escalation. See R8.

**R7.Q2 Metrics.** **Decision:** candidate list accepted including spec churn;
final set open pending research.

**R7.Q3 Release safety.** **Decision:** backend canary with auto rollback; web
auto; firmware beta auto, stable human; sensitive-path security review blocks
on findings.

**R7.Q4 Research run then thinking run.** **Decision:** accepted; thinking run
is a grilling session.

**R7.Q5 Providers for harness evaluation.** **Decision:** Anthropic and OpenAI
(existing subscriptions).

**R7.Q6 Repo basics.** **Decision:** public from day one; Apache-2.0 software;
CERN-OHL-S hardware; marketplace widgets declare any OSI licence.

**R7.Q7 Provisioning UX.** **Decision:** QR to join AP, claim code, name and
tick; hidden backend URL field.

**R7.Q8 Transitions.** **Decision:** cut and fade in v0 as host features;
full-framebuffer effects as a later host plugin type.

## Round 8: intake design

**R8.Q1 Maintainer chat surface.** Options: CLI plus Telegram bot; Telegram
only; Claude mobile app with Claude Code web. **Decision:** CLI plus Telegram
bot on the laptop, issue as system of record. Fact found: the predecessor
bot's sluggishness was its 15-minute tick, so a persistent long-poller fixes
it and no AWS receiver is needed.

**R8.Q2 Capturing agent findings.** Options: synchronous subagent dialogue;
asynchronous structured finding record with independent investigation; file
directly with a needs-validation label. **Decision:** asynchronous record plus
filing agent. Direct filing is what gave issues too much authority.

**R8.Q3 Issue authority.** Maintainer asked where unvalidated issues come from
under R8.Q2. Answer: the public tracker (community, direct maintainer entries,
Renovate, CI reporters, future producers). **Decision:** shortlist works only
bot-authored issues, enforced in script.

**R8.Q4 Escalation ladder.** **Decision:** not-an-issue / issue / design flaw;
strongest-model review; Telegram to maintainer; ADR. In-flight task continues
unless blocked. Maintainer requested a flow diagram of the whole agent design
(process spec section 8).

**R8.Q5 Security findings.** **Decision:** private vulnerability reporting
plus Telegram, never public.

**R8.Q6 Prioritisation.** **Decision:** priority label wins, else 2:1
feature to debt, ratio measured.

**R8.Q7 Ops as a source.** **Decision:** reserved slot through the same
findings queue. Maintainer: do not lose this, it finds real bugs.

**R8.Q8 Name.** Checked GitHub, npm and crates.io for 19 candidates across
three batches. Rejected for collisions: panelkit (3.7k-star iOS framework),
pixelboard (114 repos, a plan44 LED project), pixelpanel (an ESP32 LED
driver), paneltime (an existing org), openmatrix and dotcanvas (npm taken).
Clean: dotwall, widgetwall, pixpanel, panelator, panelpixels, buildaboard,
panelbuilder. **Decision:** panelator, "for now".

## Round 9: closing

**R9.Q1 Name.** See R8.Q8.

**R9.Q2 Marketplace for self-hosters.** Options: central marketplace with
configurable URL; per-backend marketplaces; federation. **Decision:** central,
URL configurable; one trust root; federation later.

**R9.Q3 ABI versioning.** **Decision:** manifest declares ABI version,
firmware supports a range, backend refuses unsupported installs, previous
major kept one release cycle.

**R9.Q4 Anything missed?** Considered and deferred: physical input devices,
other connected integrations, sound, shared households, localisation.
**Decision:** nothing more for v0.
