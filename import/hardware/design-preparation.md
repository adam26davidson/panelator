# Connector research and schematic preparation

2026-09-19. Initial [schematic draft](kicad/carrier/README.md) now exists.
No final BOM or PCB layout. Connector footprints remain pending.
Architecture and evidence: [hardware brief](README.md).

## Connector candidates

These are manufacturer references for investigation, not approved substitutes
or confirmed assembler-stock parts. All connector bodies will be on top.

| Function | Candidate | Remaining checks |
|---|---|---|
| HUB75 output | [On Shore 302-S161](https://www.on-shore.com/part/302-s-interconnect-shrouded-box-header-straight/), 16-position 2.54 mm shrouded through-hole header | Drawing, pin 1/key orientation, actual cable fit, assembler sourcing/eligibility |
| Two dev-board sockets | [Samtec SSW-121-01-L-S](https://www.samtec.com/products/ssw-121-01-l-s), single-row 21-position 2.54 mm socket candidate | Configured drawing, mating pin size/engagement, installed board height, sourcing/cost; cheaper verified equivalents may be preferable |
| Power input | **Bossie BX-VH3.96-4PLT / C18077853**, 4-position 3.96 mm SMT header; saved drawing below | Selected design candidate; verify physical fit, polarity, exact footprint and order-time stock |

Historical identification notes (superseded by the Bossie selection below):

The photographed power plug's latch and single-wall panel header suggest a
VH-style connector as a visual hypothesis. This does not establish JST origin
or compatibility. JST's drawing gives **3.96 mm pitch and 11.88 mm between the
first and fourth pins**, versus the earlier rough 11.3–11.5 mm measurement and
3.81 mm hypothesis. Both values remain in the record; neither is silently treated
as confirmed. Need a calibrated measurement or a physical mating sample before
committing. A sample header can be test-fitted without soldering.

Ribbon cable: purchase preassembled female-to-female 16-conductor IDC cable;
verify straight-through pin mapping and key orientation. Choose the shortest
practical length after mounting is established. Cable is separate from PCBA BOM.

## Follow-up: Adafruit reference and Chinese-language search

User identifies [Adafruit cable 4767](https://www.adafruit.com/product/4767)
as the same cable type they own. Adafruit describes it as a replacement power
cable for HUB75 RGB matrices, but publishes neither connector pitch nor a mating
header manufacturer part number on that page. Treat the user's match as useful
identification evidence, not a manufacturer-certified interchangeability claim.

Chinese searches included `LED 显示屏 电源线 4P VH3.96 接插件`.
Useful catalogue terms: `VH3.96 4P 直针座` (four-pin vertical PCB header),
`VH3.96 4P 弯针座` (right-angle PCB header), and `LED显示屏 电源线`
(LED display power cable).

Primary-source references found:

- [Wenda VH3.96 catalogue](https://cn.wendaelectronics.com/product/3-96mm-pitch/3-96mm-pitch-wiretoboard-strip-connector-pcb-mount-plug-and-socket-industrial-electrical-harness-connector-set.html):
  Chinese connector manufacturer's dimensional catalogue; four-position span
  11.88 mm. This documents the family, not a guaranteed match to our harness.
- [Triumph VH3.96-4P power harness](https://www.triumphcoupler.com/index.php?a=index&aid=456&c=View&m=home):
  manufacturer identifies its red/black power cable's connector as VH3.96-4P.
- [JST VH catalogue](https://www.jst-mfg.com/product/pdf/eng/eVH.pdf):
  exact reference family parts are **VHR-4N** cable housing, **B4P-VH** top-entry
  PCB header and **B4PS-VH** side-entry PCB header, with 3.96 mm pitch.

Conclusion: **VH-style 3.96 mm, four-position is the leading identification**,
strengthened by the user-provided Adafruit match and catalogue research. Original
manufacturer and actual mating compatibility remain unverified. Earlier 3.81 mm
inference from a ruler measurement should not be treated as a selected connector.
Proceed with VH-family sourcing/drawing checks, keeping fit verification as a
pre-order gate. No authoritative BOM for the exact AliExpress panel was found
in this search; the above catalogues are component references, not a panel BOM.

## User-proposed SMT power header: BX-VH3.96-4PLT

Preferred SMT candidate for evaluation: **Bossie BX-VH3.96-4PLT**, supplier code
**C18077853**. The [Chinese LCSC listing](https://item.szlcsc.com/19218254.html)
identifies a vertical 1 × 4, 3.96 mm-pitch SMD header supplied in tape packaging,
with auxiliary solder tabs. Listed height is 11.6 mm and current rating is 7 A.
Its specified mating housing is BX-VH3.96-4PJK; compatibility with the user's
existing cable has not yet been physically verified.

The user confirms the supplier page lists **both Economic and Standard PCBA**.
Record this as user-verified service eligibility; recheck stock and pricing at
order time. This supersedes the earlier unresolved service-eligibility note.

The user supplied the [manufacturer drawing, C18077853.pdf](reference/C18077853.pdf),
now saved in the repo and visually inspected. It is Bossie's BX-VH3.96-NPLT
series drawing, revision A, sheet 1/1; use the **4PLT table row**, since the
illustrations show different example pin counts.

| Drawing detail | Four-position part |
|---|---|
| Pitch | 3.96 mm |
| A: first-to-last contact span | 11.88 mm |
| B: overall body width | 19.80 mm |
| C: dimension identified in top-view drawing | 16.52 mm |
| Body depth | 9.30 mm |
| Height | 11.60 mm |
| Suggested contact lands | 2.50 × 6.00 mm, four required |
| Suggested retention lands | 1.50 × 3.00 mm, two required |
| Retention-land outer edge beyond outermost contact centre | 2.70 mm |
| Gap between contact-land end and retention-land start | 1.00 mm |

The land pattern is explicitly a **component-side view**. Its retention pieces
are SMT solder tabs; this drawing does not call for through-hole mounting holes.
Treat retention pads as mechanical anchors, not extra power contacts. Confirm
pad numbering and latch orientation against the cable before assigning polarity.
The drawing specifies LCP UL94V-0 housing and a nominal 7 A rating, but does not
provide a complete reflow profile or a mated-plug clearance envelope. Its 260°C
solderability-test condition is not a reflow recipe.

**Decision:** use BX-VH3.96-4PLT / C18077853 as the selected design candidate for
J4; create its exact SMT footprint from this drawing. Physical fit with the
existing cable and polarity remain pre-order checks. Support the carrier near
this connector to reduce board flex when inserting/removing the locking cable.

## Draft schematic connectivity

Proposed references J1 = left dev-board socket, J2 = right socket, J3 = HUB75
output, J4 = power input. J1/J2 numbering follows the saved seller diagram:
component side, antenna up, USB down, positions 1–21 from top to bottom.
These are design assignments; selected footprint numbering must match them.

| Signal | GPIO | Socket pin | J3 pin |
|---|---:|---|---:|
| R1 | 42 | J2.6 | 1 |
| G1 | 41 | J2.7 | 2 |
| B1 | 40 | J2.8 | 3 |
| R2 | 2 | J2.3 | 5 |
| G2 | 1 | J2.2 | 6 |
| B2 | 39 | J2.9 | 7 |
| E | 14 | J2.19 | 8 |
| A | 45 | J2.15 | 9 |
| B | 48 | J2.16 | 10 |
| C | 47 | J2.17 | 11 |
| D | 21 | J2.18 | 12 |
| CLK | 12 | J1.20 | 13 |
| LAT | 11 | J1.19 | 14 |
| OE | 10 | J1.18 | 15 |

All 14 signal paths go through the proposed 3.3 V-to-5 V buffers (AHCT541 in A1); this table is
not a direct-wire instruction. J3.4/J3.16 and J1.1/J2.1 connect to common ground.
J2.21 is the intended dev-board 5 V input, pending power-circuit verification.
Do not feed 5 V into J1.2 or J1.21 (both 3V3). J4 numbering awaits its drawing
and verified cable polarity.

## Electrical decisions before schematic sign-off

A1 implements a carrier-side LM66100DCKR reverse-current blocker with CE tied
to VOUT, replacing JP1; buffers changed to SN74AHCT541PWR for powered-off input
tolerance. This **does not** establish USB-host isolation inside the clone.
See the [current power circuit and conditional operating cases](kicad/carrier/README.md).

- Assign two 8-channel buffers and verify their exact datasheet pinout,
  direction, enable control, decoupling and unused-input handling.
- Define reset/boot blanking without disturbing GPIO45 strapping. Do not add
  pull resistors to strapping signals without checking module requirements.
- Establish this dev board's USB/header power path. Carrier protection alone
  cannot guarantee the absence of backfeed inside the dev board.
- Size carrier input protection from expected load/inrush and connector ratings.
- Consider source-series resistor footprints near buffer outputs for ribbon
  signal integrity; determine values during design review/prototype testing.
- Review powered/unpowered combinations of panel, buffers and dev board.

## Work that can proceed now

Verify candidate drawings and assembler availability, allocate schematic symbols
and nets, and establish the KiCad computer-use environment. Final power-header
footprint and mechanical placement remain open. No need for a panel 3D scan to
begin schematic work with the ribbon-cable architecture.
