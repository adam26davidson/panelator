# Carrier PCB planning

Current status: A1 schematic review draft; ERC/connectivity pass. USB isolation,
blanking, power-state validation, protection sizing and connector fit remain open.
Earlier entries below preserve superseded decisions chronologically.

Collected hardware observations, user measurements, photographs and remaining
design steps in [hardware/README.md](../hardware/README.md).

Current agreed architecture: carrier connects to panel HUB75E input through a
preassembled 16-conductor ribbon cable and sockets the existing ESP32-S3 dev board.
All connectors and other components are placed on the top side. Existing split power harness powers panel and
carrier separately. Order fully assembled, including connectors; no user soldering.

User accepted 25.4 mm dev-board header row spacing as a working assumption.
Power connector pitch is provisionally 3.81 mm; mating family remains unknown.
Actual panel chip markings appear SM16208SF, despite the working firmware's
FM6126A configuration. No firmware changes made on that basis.

Design is still at hardware-definition stage; no KiCad or fabrication files yet.

Follow-up: saved unplugged panel power-header and cable mating-face photos.
User reports supply rating 5 V / 15 A / 75 W, AC input 110/220 V ±15%, and supplied
dev-board listing 1005007184856577. User confirms 42 pins, matching the archived listing and supplied pinout.
Earlier assistant count of 44 was incorrect. Carrier needs
the male header matching the panel, and local branch protection will be sized
for carrier demand. Exact power-connector family remains unresolved.

Saved seller pinout (original AVIF and readable PNG) and transcribed all 21
positions per row with explicit component-side orientation in hardware/README.md.
Carrier sockets are 1 × 21, not 1 × 22; end-to-end pin span is 50.80 mm.

Design update: ribbon-cable connection supersedes direct panel mating. Select a
keyed 2 × 8 male output header and matching female-to-female IDC cable, verifying
pin 1, key orientation and continuity. Single-side placement is a user preference;
some PCBA services also offer double-side assembly. Detailed input-area geometry
is no longer needed for a direct mating fit; independent mounting, underside
clearance and cable routing still need defining. Two copper layers remain allowed.

## Schematic implementation and tooling

KiCad 10.0.6 installed with standard and 3D libraries. Desktop MCP 0.7.1
installed/registered and tested on KDE/Wayland (screenshot, keyboard menus,
coordinate mouse click). User now prefers programmatic/CLI work where possible,
using desktop control only when useful. JLCAPI application remains under review.

Created `hardware/kicad/carrier/carrier.kicad_pro` and `.kicad_sch` as an A0
review draft, with project-local AHCT245 symbol, PDF export and XML netlist.
Generator uses installed KiCad symbols and deterministic UUIDs. All 14 signal
paths are independently checked against current firmware GPIO constants and
the recorded physical socket/HUB75 pin map by `hardware/tools/check_connectivity.py`.
No firmware changes. Exported PDF visually inspected using a local render;
no desktop interaction needed for schematic generation.

Circuit draft includes two AHCT245s, 14 provisional 33-ohm series resistors,
12 input pulldowns, OE pull-up to dev-board 3V3, decoupling/bulk capacitance,
and placeholder carrier fuse / removable dev-power link. GPIO45 has no added
pull resistor. All components are intended for top-side placement.

ERC: zero errors, two unsuppressed warnings for grounded unused bidirectional
buffer pins A7/A8 on U2; DIR is permanently A-to-B. Connectivity assertions pass.
These results verify the drawn topology, not completeness of the design.

Important unresolved electrical findings: AHCT245 data pins are bidirectional
and have powered-off voltage limits; USB-powered GPIOs must not drive unpowered
buffers. USB/header backfeed, buffer/panel sequencing and blanking during power
ramps/controller removal require an explicit design before release. OE pull-up
only defines high-Z idle with valid supplies. User asked asynchronously about
desired simultaneous USB/external-power support; no answer assumed.

Power-header selection has advanced to Bossie BX-VH3.96-4PLT / C18077853,
3.96 mm pitch, per saved drawing and user-confirmed PCBA eligibility. Earlier
3.81 mm estimate is superseded as the leading choice. Physical mating, polarity,
pin-number orientation and a verified footprint remain pre-order gates.

User answered power-workflow question: **support USB and external power
connected together**. Recorded operating-case matrix in schematic README;
manual power-link/unplugging concept is superseded. A0 still represents the
previous provisional circuit, not an implemented simultaneous-power solution.
Investigating unidirectional AHCT541 inputs for USB-only signal tolerance.
Actual clone USB-to-header power topology remains necessary: a carrier input
diode alone cannot isolate a directly connected USB VBUS inside the dev board.

## A1 carrier-side power circuit

Replaced manual JP1 with U3 LM66100DCKR, VIN on fused external +5V_BUF and
VOUT on DEV_5V. CE is tied to VOUT per TI section 8.3.2 for reverse-current
blocking. Added C4 1uF output decoupling and R28 100k status pull-up; status is
not connected to the MCU. F1 and current/inrush budget remain unresolved.
This blocks sustained USB-to-harness power through the header rail, but cannot
block header-to-USB backfeed inside a directly wired clone. Need evidence of
both USB port power paths before declaring simultaneous operation safe.

Changed U1/U2 to SN74AHCT541PWR: TI specifies input leakage for VCC = 0 to 5.5 V,
unlike the AHCT245 bidirectional data-pin limit. Signal pin mapping remains
unchanged; pin 1 is now /OE1 and tied low, not DIR tied high. Pin 19 is /OE2 low.
Output/panel sequencing and blanking remain separate review gates.

Power block redrawn with direct wires in response to the user's readability
feedback. Regenerated PDF/netlist, visually reviewed the export, and verified
all 14 firmware signal paths plus U3 feedback/power nets. ERC now has zero
errors and zero warnings with no exclusions. A1 is a conditional review draft,
not a completed USB-host isolation design or manufacturing release.

## Review cleanup checkpoint

Fixed pasted diff markers, refreshed active component references, made the
3.96 mm Bossie choice primary and retained the old pitch estimate as history.
Ignored Python caches and added a single review command with explicit optional
schematic regeneration; existing project settings are now preserved.
Expanded power-state gates for both panel/carrier disconnect orders, controller
3V3 loss, shared GPIO48 LED load, U3 transient/takeover behavior and protection
coordination. Corrected reverse-current direction, divider arithmetic and the
PTC hold-current interpretation. No unverified divider or fuse selection was
implemented; circuit topology remains A1. Preparing a review-draft commit.
