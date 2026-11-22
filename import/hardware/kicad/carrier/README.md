# Carrier schematic A1 — review draft

Open `carrier.kicad_pro` in KiCad 10.0.6. Readable export:
[schematic PDF](review/carrier.pdf). No PCB or manufacturing release yet.

The schematic preserves the 14 firmware GPIO assignments and the recorded
42-pin dev-board socket mapping. U1/U2 are now proposed **SN74AHCT541PWR**
unidirectional buffers, replacing the A0 AHCT245s. Both output enables are
tied low in this review draft. The local symbol derives from KiCad's 74LS541
geometry with AHCT identity and manufacturer's one-based A/Y channel names.
Pin numbering and input tolerance were checked against
[TI's datasheet, sections 3 and 4.5](https://www.ti.com/lit/ds/symlink/sn74ahct541.pdf).
Input leakage is specified at VCC = 0 to 5.5 V (±1 microamp for the selected
commercial temperature range), permitting USB-powered MCU inputs while buffer
power is off. This is input tolerance, not a guarantee of arbitrary powered-off
output loading or complete system sequencing.

R1–R14 provide 33-ohm series-resistor starting values; final values need actual
cable/signal testing. R15–R26 bias non-strapping inputs low; R27 pulls MCU_OE
to the dev board's 3.3 V rail. This blanks the panel when GPIO10 is high impedance
**and both supplies are valid**. It does not guarantee blanking during power
ramps or with the dev board missing/unpowered. GPIO45 has no added bias resistor.
U2's unused inputs are tied low; its unused outputs are unconnected.
C2/C3 must be placed at their respective buffer supply pins during layout.

## Carrier power circuit

The power block now uses direct wires:

`J4 harness -> F1 -> +5V_BUF -> U3 LM66100 -> DEV_5V -> J2.21`

- Buffers remain on external +5V_BUF, upstream of U3, so USB is not intended
  to energize the panel or buffers through the dev-board 5 V header.
- U3 is LM66100DCKR, proposed SC-70-6 ideal diode. VIN = pin 1, VOUT = pin 6,
  GND = pin 2. CE (pin 3) connects directly to VOUT for reverse-current blocking,
  per TI section 8.3.2. CE must **not** be tied low in this application.
- ST (pin 5) has a 100k pull-up R28 to DEV_5V; it is a diagnostic net only,
  with no connection to the MCU. Pin 4 is NC. C4 is 1uF output decoupling.
- The old JP1 manual power link has been removed.

[LM66100 datasheet](https://www.ti.com/lit/ds/symlink/lm66100.pdf): 1.5–5.5 V
operating range, 1.5 A maximum continuous current and 79 milliohm typical
on-resistance at 5 V. The component is a reverse-current blocker, **not a fuse,
regulator, current limiter or overvoltage protector**. At an illustrative 0.5 A,
the on-state typical resistive drop is about 40 mV and dissipation about 20 mW;
these are not worst-case guarantees or a verified load budget. Review actual
clone load/inrush, worst-case resistance/temperature, regulator dropout and supply
tolerance before selecting F1 or releasing the circuit. Reverse blocking has
finite detection time and leakage; it is not galvanic isolation.

## Unresolved before layout sign-off

**Confirmed requirement:** USB and external 5 V must be allowed to remain
connected together. No unplugging procedure or manual power-link selection
is acceptable as the final solution. JP1 from A0 has been removed. A1 is still conditional on dev-board USB isolation.

Required operating cases:

| Panel supply | Carrier supply | USB / controller | Required check |
|---|---|---|---|
| On | On | USB disconnected | Normal display operation |
| On | On | USB connected | Programming/display; no source backfeed; check both USB ports |
| Off | Off | USB connected | Controller operates; no panel or buffer back-powering |
| On | Off (plug removed or F1 open) | Either | Panel-side pull-ups must not inject damaging current into unpowered buffer outputs |
| Off (panel plug removed) | On | Either | Buffer outputs must not back-power the panel |
| On | On | Controller absent, reset or 3V3 failed | Defined buffer inputs and reliable blanking without feeding unpowered GPIOs |
| On / transitioning | On / transitioning | USB connected | Sweep near-equal sources and harness drop; check source takeover, dropout and reverse transient |

Power-source isolation must account for the actual dev board's internal USB
VBUS-to-5V-header circuit. A diode or mux on the carrier's incoming 5 V alone
cannot stop current from the dev board's 5 V rail into its USB socket if that
connection is direct. Obtain clone schematic or inspect/measure the unpowered
board before selecting the final topology. USB data and ground must remain
available. Do not infer protection from the official Espressif board schematic.

**Two possible outcomes of the dev-board inspection:**

1. Each USB VBUS path already blocks current from DEV_5V toward the host:
   validate that circuit together with U3, including both USB-C ports and their
   USB-UART/native-USB behavior. The proposed carrier topology may then suffice.
2. A USB VBUS is directly tied to DEV_5V: no circuit placed solely between the
   harness and the 5 V header can isolate that USB socket while feeding the header.
   Use an assembled USB power/data interposer or move USB power entry onto the
   carrier with an isolated downstream connection, or select a dev board with
   documented source isolation. Do not require user soldering or silently replace
   this with a data-only cable that breaks USB-only programming.

Required evidence: underside/USB-area board photos and, if traces remain hidden,
schematic or unpowered continuity/diode tests using a USB breakout. Check **both**
ports; a photo or diode mode alone may not fully establish an active power circuit.

- Design power-ramp, reset and missing-controller blanking; verify all powered
  and unpowered combinations, including panel off / carrier on.
- Select F1 from measured/estimated carrier demand, inrush, voltage-drop and
  fault-current requirements. Its value and footprint are deliberately TBD.
- J4 pins 1/2 = +5 V and 3/4 = ground are a **provisional design assignment**,
  pending cable continuity and latch/view verification. The selected part is
  BX-VH3.96-4PLT / C18077853, but its footprint has not yet been assigned.
- Select exact assembled socket and ribbon header parts; verify U3 and buffer assembly stock. Connector
  footprints are deliberately empty; this is not an orderable BOM.
- Check physical header orientation, row spacing, support and antenna clearance.

## Additional electrical review gates

- **GPIO48 / onboard RGB LED:** the seller pinout marks GPIO48 as RGB_LED;
  our firmware uses it as address B (J2.16). The LED input is an additional load
  and can respond to address traffic. Check the actual LED connection and any
  optional isolation bridge. Existing display operation is evidence of basic
  compatibility, not a signal-integrity measurement. No firmware remapping or
  user soldering is assumed.
- **U3 reverse transients:** LM66100 lists a 0–80 mV turn-off threshold
  (VOUT minus VIN), reverse activation current of 0.5 A typical / 1 A maximum,
  and a 2 microsecond typical turn-off time under specified test conditions.
  Those values are not a guaranteed peak-current ceiling or worst-case pulse
  duration. On external-supply collapse, current can briefly flow from DEV_5V
  back toward +5V_BUF/harness, possibly drawing from USB. External-to-host
  backfeed through the clone is a separate path. Test droop and reconnect
  behavior with the actual source impedances and capacitances.
- **U3 takeover:** its turn-on threshold requires VOUT to be 80–250 mV below
  VIN. With near-equal sources, harness loss or a low external setting, USB
  may continue powering the controller. Validate USB load budget, brownout and
  source transitions; do not assume external-source priority.
- **Blanking:** R27 currently loses its pull-up source if DEV_3V3 disappears.
  Do not simply replace it with a 5 V divider. A 20k upper / 10k lower divider
  gives 1.67 V; the reversed arrangement gives 3.33 V nominal, but rail tolerance
  and GPIO injection during startup/regulator failure must still be addressed.
  Select a blanking/enable circuit covering absent and unpowered controllers
  before layout sign-off.
- **Powered panel / dead buffers:** AHCT541 input tolerance does not imply
  output power-off tolerance. Its output clamp path and any panel-side pull-ups
  can inject current into the dead buffer rail through the series resistors.
  Identify panel pulls and check powered-off output limits; consider isolation
  or a buffer with suitable specified output behavior. Do not classify this
  case as low risk without evidence.
- **F1 coordination:** a 1 A-hold PTC is only a candidate, not a 1 A current
  limiter or assurance that U3 stays below 1.5 A. Review trip-current/time curves,
  ambient derating, resistance, fault capacity and U3 transient limits. The
  photographed AMS1117 does not establish controller peak demand. Estimate or
  measure Wi-Fi/inrush load; buffer consumption depends on switching activity,
  capacitive load and TTL input levels, not simply 14 lines times 33 ohms.

Sources: [LM66100 sections 6.5–6.6 and 8.3.2](https://www.ti.com/lit/ds/symlink/lm66100.pdf),
[AHCT541 limits and electrical characteristics](https://www.ti.com/lit/ds/symlink/sn74ahct541.pdf),
[Littelfuse PTC selection guidance](https://www.littelfuse.com/assetdocs/littelfuse-fundamentals-of-resettable-functionality-in-pptc-devices-technical-paper?assetguid=7b82f0c7-cde5-4d89-9219-45b30d0fc2a5).

## Reproduce and verify

From the repository root, refresh exports from the current native schematic:

```sh
bash hardware/tools/review_schematic.sh
```

To explicitly rebuild the schematic and local symbol from the generator first:

```sh
bash hardware/tools/review_schematic.sh --regenerate
```

The default preserves GUI edits. `--regenerate` overwrites the schematic and
local symbol, so preserve manual edits first. The generator creates the project
file only if missing; KiCad owns its settings thereafter. Both modes regenerate
ERC, XML netlist and PDF and fail on ERC violations or connectivity-check failure.
The outputs under `review/` are derived snapshots; run this command after edits
before committing them. A failed run may leave partial exports and must not be
used as a release. No automated check establishes manufacturing readiness.

ERC currently has **zero errors and zero warnings**, without rule suppression.
Netlist checks include all 14 firmware paths, U3 VIN/VOUT/CE connections, grounds,
status pull-up, separate supply nets and absence of JP1. These checks do not prove
unknown dev-board USB isolation or analog behavior.
