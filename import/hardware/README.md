# LED panel carrier PCB

Design brief and hardware evidence collected through 2026-09-19.
An initial [KiCad schematic review draft](kicad/carrier/README.md) now exists,
with a [PDF](kicad/carrier/review/carrier.pdf) and checked netlist. Power/USB,
startup and connector decisions remain open. No PCB layout or manufacturing
release has been produced.

## Objective and agreed architecture

Build a carrier connected to the LED panel's HUB75E input by a short, preassembled
16-conductor ribbon cable, accepting the existing ESP32 dev board in sockets.
**All connectors and other components go on the same (top) side of the carrier.**
Order it fully assembled from an online PCBA service, including all connectors,
so no user soldering is required. This supersedes the original direct-plug design.

Use a keyed/shrouded 2 × 8 male HUB75 output header on the carrier and a
female-to-female IDC ribbon cable to the panel's male input header. Confirm pitch,
key orientation and pin-for-pin continuity before selecting exact parts; clearly
mark pin 1 and PANEL OUT. Keep the cable short, select its length after mounting
is chosen, and validate display operation with that cable.

Single-side component placement is a design choice to simplify assembly, not a
universal PCBA limitation: [JLCPCB capabilities](https://jlcpcb.com/capabilities/pcb-assembly-capabilities)
list single-side Economic placement and single/double-side Standard placement.
Exact connector eligibility still needs checking. A two-copper-layer PCB remains
appropriate; through-hole leads/solder joints may extend underneath even when
all component bodies are on top.

The supplied power harness splits into two panel-style plugs. Keep one connected
to the panel; connect the spare to a matching header on the carrier to supply the
dev board and buffers. Panel load current stays in the existing harness rather
than passing through the carrier. Grounds are common through the harness and
HUB75E. Verify the spare branch's actual wiring and polarity before finalising.

**USB requirement confirmed:** external 5 V and USB must be supported connected
simultaneously, including USB programming. No manual unplugging or power-link
selection as the normal workflow. USB-only must not energize the LED panel.
The A1 schematic replaces JP1 with a carrier-side reverse-current blocker;
dev-board USB-host isolation still requires verification. See
the [power operating cases and design gates](kicad/carrier/README.md).

User preference, updated 2026-09-19: use programmatic/file and CLI operations
where possible to reduce image/token overhead; use desktop control for tasks
that need it. KiCad 10.0.6 and its CLI/libraries are installed. Desktop MCP
0.7.1 is connected; screenshot, keyboard and mouse interaction were verified
on KDE/Wayland. JLCAPI application is still under review and does not block design.

## Assembly cost decision — 2026-09-19

Keep **single-side component placement with a ribbon cable** as the baseline.
[JLCPCB's price table](https://jlcpcb.com/help/article/pcb-assembly-price),
updated 2026-09-09 and checked during planning, lists these USD fees per order:

| Service | Setup | Stencil | Combined |
|---|---:|---:|---:|
| Economic, single side | $8.18 | $1.53 | $9.71 |
| Standard, single side | $25.56 | $8.21 | $33.77 |
| Standard, double side | $51.12 | $16.42 | $67.54 |

Double-sided Standard therefore adds $33.77 over single-sided Standard or
$57.83 over Economic in setup/stencil fees alone. For five boards, that is
$6.75 or $11.57 per board respectively. These are **not complete quotes**:
boards, parts, placement/manual soldering, applicable fixtures, shipping and
tax are additional. Exact connector choices may require Standard even with
single-side placement. An underside through-hole connector needs an actual
process quote; do not assume it incurs a full second SMT pass. Recheck prices
when quoting. No purchase or assembler commitment has been made.

See [connector research and schematic preparation](design-preparation.md) for
candidate parts, remaining fit checks and the draft socket-to-panel net map.

## Panel

- Exact user-provided listing: https://de.aliexpress.com/item/1005007746526615.html
- The live listing could not be opened. An [archive of that product ID](https://www.pricearchive.org/aliexpress.com/item/1005007746526615)
  describes P2.5 indoor RGB, 128 × 64 pixels, 320 × 160 mm, 1/32 scan.
  Treat these as listing specifications, not a mechanical drawing.
- Actual panel photo confirms INPUT / HUB75E lettering and a shrouded 2 × 8
  male connector. Connector pitch, mating part, orientation and pin 1 still need
  verification before footprint selection.
- Chips in the input close-up appear marked **SM16208SF**. This is a photo
  reading, not a verified datasheet identification. Firmware uses the FM6126A
  configuration; that setting does not prove the physical chip is FM6126A.
- Power connector JP1 has four positions labelled **VCC, VCC, GND, GND**.
  These labels do not assign carrier footprint pin numbers or viewing direction.
- Raised plastic ribs matter if mounting the carrier on the panel, but no longer
  constrain a direct-mating carrier. Threaded inserts are visible; their thread
  size and locations have not been measured. Provide independent carrier support
  and clearance under through-hole leads; do not support it by the ribbon cable.
- Full manufacturer/model/revision identification remains unresolved.

Photos: [input and nearby chips](reference/panel-input.jpeg),
[power connector, harness and frame](reference/panel-power.jpeg).

## Dev board

[Actual board photo](reference/dev-board.jpeg)

User-provided product link: https://de.aliexpress.com/item/1005007184856577.html
The live page could not be opened on 2026-09-19. An
[archived listing](https://ms.pricearchive.org/aliexpress.com/item/1005007184856577)
describes N16R8, CH340C, Type-C and **42PIN**. The user confirms the physical
board has 42 pins, and the supplied pinout shows 21 positions per side. Earlier
assistant claims of 44 pins were a counting error, not a listing discrepancy.

| Property | Evidence / working value |
|---|---|
| Module marking | ESP32-S3-N16R8; shield also reads UICPAL |
| Firmware target | esp32-s3-devkitc-1; 16 MB flash, 8 MB PSRAM |
| Header positions | **Two rows of 21 (42 total)**, user-confirmed and shown in seller pinout |
| Along-row pitch | 2.54 mm, user measured |
| Row centre spacing | **25.4 mm assumed and explicitly accepted by user on 2026-09-19** |
| Board width | Approximately 27.8 mm, user measured |
| Overall length | Approximately 65 mm including module protrusion, user measured |
| Access | Two USB-C ports, BOOT and reset buttons |

User initially measured row spacing at about 25 mm with a ruler that cannot
reliably distinguish 25.0 from 25.4 mm. Use 25.4 mm for preliminary design;
verify with a drawing or a scale-checked 1:1 footprint before manufacturing.
Do not assume an official DevKitC-1 footprint matches this variant.

Provide antenna clearance and access to USB/buttons. Header underside, pin
length and socket mating height still need checking. The board schematic is
not yet available; verify USB/external-power interaction
for this particular board before deciding its power circuit.

## Dev-board header layout

[Saved seller pinout](reference/dev-board-pinout.png) ([original AVIF](reference/dev-board-pinout.avif)).
[Source image](https://ae-pic-a1.aliexpress-media.com/kf/Se0bcbcfdc2db4b03b0596ef2ce6e7a1bx.jpg_960x960q75.jpg_.avif),
supplied and checked on 2026-09-19.

**View from the component side, antenna at the top and USB ports at the bottom**,
matching the seller diagram. This is rotated 180 degrees relative to our saved
physical-board photo. Positions run top to bottom independently on each row;
these are positional labels, not ESP32 package numbers or assigned KiCad pad IDs.
The carrier mating view must be checked explicitly to avoid mirroring errors.

| Position | Left row | Right row |
|---|---|---|
| 1 | GND | GND |
| 2 | 3V3 | GPIO1 |
| 3 | RST / EN | GPIO2 |
| 4 | GPIO4 | GPIO43 / TX |
| 5 | GPIO5 | GPIO44 / RX |
| 6 | GPIO6 | GPIO42 |
| 7 | GPIO7 | GPIO41 |
| 8 | GPIO15 | GPIO40 |
| 9 | GPIO16 | GPIO39 |
| 10 | GPIO17 | GPIO38 |
| 11 | GPIO18 | GPIO37 |
| 12 | GPIO8 | GPIO36 |
| 13 | GPIO19 | GPIO35 |
| 14 | GPIO20 | GPIO0 |
| 15 | GPIO3 | GPIO45 |
| 16 | GPIO46 | GPIO48 |
| 17 | GPIO9 | GPIO47 |
| 18 | GPIO10 | GPIO21 |
| 19 | GPIO11 | GPIO14 |
| 20 | GPIO12 | GPIO13 |
| 21 | 3V3 | 5V |

Design for two **1 × 21 female sockets**, 2.54 mm pitch, with accepted provisional
25.4 mm row spacing. First-to-last pin span is 20 × 2.54 = **50.80 mm**.
All 14 GPIO signals in the existing HUB75 mapping are present in this table.
GPIO48 is also marked RGB_LED in the seller pinout and drives panel address B;
review onboard LED loading/behavior before sign-off. The remaining peripheral
function annotations have not been independently verified;
this table records header connectivity only. Socket part selection remains open.

## Power connector and supply

- Existing harness has one supply connection splitting to two four-position
  plugs; one powers the panel, the other is intended for the carrier.
- **Selected design candidate: Bossie BX-VH3.96-4PLT / C18077853**, 3.96 mm
  pitch (11.88 mm first-to-fourth span), per the saved manufacturer drawing.
  User confirms Economic and Standard PCBA eligibility. Actual cable fit,
  polarity and stock at ordering remain unverified; see [research](design-preparation.md).
- Historical ruler estimate: 11.3–11.5 mm first-to-fourth led to a 3.81 mm
  hypothesis. The oblique [ruler photo](reference/power-plug-measurement.png)
  was insufficient to select a part. This hypothesis is superseded by the
  Bossie drawing and VH-family identification; retain it only as measurement
  history, not a competing footprint choice.
- New [cable plug mating-face photo](reference/power-plug-face.jpeg) shows four
  female contact openings and a retaining latch. The
  [unplugged panel header photo](reference/panel-power-header.jpeg) shows male
  pins and VCC / VCC / GND / GND labels from top to bottom in that photo.
  The carrier needs a compatible **male PCB header**, matching the panel's mating
  interface. Its physical mounting style may differ if mating geometry is retained.
  Do not translate the photo order directly into footprint pin numbers without
  checking viewing direction, latch orientation and cable continuity.
- User reports generic supply label: **AC input 110/220 V ±15%; DC output
  5 V, 15 A; 75 W**. This is a label transcription, not a measured output or
  verified model specification. Carrier uses only its 5 V DC output.
  Connector/harness current ratings and spare-plug polarity remain unverified.
- Plan local overcurrent protection for the lower-current carrier branch;
  select its rating after calculating dev-board and buffer demand. The supply's
  15 A capacity is not the intended carrier current or its protection rating.

Preferred SMT power-header candidate: **Bossie BX-VH3.96-4PLT / C18077853**.
See [candidate verification notes](design-preparation.md). Manufacturer drawing
is saved and reviewed; user confirms both Economic and Standard PCBA eligibility.
Exact cable fit/polarity and stock at order time remain to be checked.

## Existing signal mapping

GPIO values checked against [main.cpp](../firmware/src/main.cpp); HUB75 pin
numbers are from [firmware README](../firmware/README.md). Verify physical
connector numbering/viewing direction and ribbon-cable continuity before routing.
The carrier connector is a top-side male output header, not an underside socket.

| HUB75 pin | Signal | ESP32 GPIO |
|---|---|---|
| 1 | R1 | 42 |
| 2 | G1 | 41 |
| 3 | B1 | 40 |
| 4 | GND | GND |
| 5 | R2 | 2 |
| 6 | G2 | 1 |
| 7 | B2 | 39 |
| 8 | E | 14 |
| 9 | A | 45 |
| 10 | B | 48 |
| 11 | C | 47 |
| 12 | D | 21 |
| 13 | CLK | 12 |
| 14 | LAT | 11 |
| 15 | OE | 10 |
| 16 | GND | GND |

## Proposed electrical design — not yet validated

- Preserve existing GPIO mapping unless electrical review requires a change.
- Two 8-channel 3.3 V-to-5 V buffers, now SN74AHCT541 candidates, for 14 signals.
  A1 replaces the earlier AHCT245 choice to tolerate powered MCU inputs when
  buffer power is off during USB-only programming.
  Verify panel requirements, boot behaviour, direction/enables, unused inputs,
  power sequencing and ESP32 strapping-pin interactions.
- Decoupling, appropriate input protection, test points and panel blanking at boot.
- Supply the dev board through its verified power input; establish a safe USB
  programming arrangement without backfeeding. Do not infer the clone's circuit
  from official Espressif board documentation.
- Prefer two PCB layers if routing and grounding permit. Select stack-up,
  copper, track widths and protection after confirming electrical requirements.

## Next steps and completion gates

1. **Finish hardware identification:** identify the power header from the supplied
   photos and dimensional drawings; verify spare-plug polarity; obtain dev-board
   underside/power-circuit evidence and HUB75 mating geometry/pin orientation.
   Supply rating, dev-board link and power mating-face photos have been supplied.
2. **Choose carrier mounting and cable length:** establish available board area,
   mounting/support points, underside clearance and ribbon/power cable routing.
   Detailed measurements around the panel input are no longer a prerequisite
   for a direct mating fit. Measure ribs/inserts if mounting on the panel frame.
   A scan is optional.
3. **Choose assembler and available parts:** verify it can source and install
   both sockets, top-side HUB75 male header and power header, including
   through-hole assembly as required. All component bodies must be on one side. JLCPCB is a candidate, not yet selected.
   Establish budget, quantity and delivery destination before comparing quotes.
4. **Set up KiCad/computer use and create schematic:** review pin mapping, supply
   paths, logic levels and startup behaviour; run electrical-rule checks.
5. **Place and route:** enforce top-side-only component placement; keep USB
   and antenna clear, add mechanical support, review 3D fit and a 1:1 print.
   Run design-rule checks and independently verify connector footprints.
6. **Prepare reviewable manufacturing package:** editable KiCad project, schematic
   PDF, board renders, Gerbers/drills, BOM with exact manufacturer/assembler part
   IDs, placement files and assembly notes. Resolve all unexplained rule errors
   and review assembler orientation previews. User approves final order/cost.
7. **Prototype validation:** fit, polarity/continuity, controlled initial power-up,
   boot/reset, USB arrangement, Wi-Fi and display operation. Validate before
   ordering a larger batch.

## References

- [TI SN74AHCT541](https://www.ti.com/product/SN74AHCT541) — current buffer candidate
- [TI LM66100](https://www.ti.com/product/LM66100) — current reverse-current blocker
- [JLCPCB assembly FAQ](https://jlcpcb.com/help/article/pcb-assembly-faqs)
- [Official Espressif DevKitC-1 guide](https://documentation.espressif.com/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html)
  — reference only; not proof of this board variant's dimensions or circuitry.

Saved photos are originals supplied by the user; dimensions above distinguish
observations, approximate measurements and accepted assumptions.
