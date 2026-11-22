# 106. The carrier design lives in `hardware/` under CERN-OHL-S v2, and the frozen predecessor points here

Status: written 2026-11-22 by the spec stage for issue #427, after the
maintainer's answer to question #7076041741 (where the predecessor's files
are, and who freezes the predecessor and when). A spec derived from its
parent design needs no maintainer approval of its own (delivery-system design
section 11).
Class: product. Domain: backend.
Parent: docs/product-spec.md
Derives from: [product spec](../../docs/product-spec.md) section 2 (the
carrier is the custom PCB from `hardware/`; hardware licence CERN-OHL-S,
software Apache-2.0; board-specific pins behind one firmware board
definition) and section 14 (`hardware/` holds the carrier PCB, moved from
`char-matrix-dashboard`; the predecessor is frozen with a pointer here);
[design tree](../../docs/design-tree.md) R1.Q7 (v0 is scoped to the current
hardware), R4.Q12 (hardware moves here, predecessor repo frozen) and R7.Q6
(Apache-2.0 software, CERN-OHL-S hardware);
[ADR 0014](../../docs/decisions/0014-github-first-contact-enforced-by-installation-scope.md)
(the App's token reaches this repository only).

## 1. Goal

`hardware/` is an empty directory today, the root README says the hardware
licence is "added when the hardware files move in", and the carrier's design
files exist only in the predecessor repository
`adam26davidson/char-matrix-dashboard`, which answers `404` to the App's
token and to an unauthenticated request (checked 2026-11-22), so no stage
can read it.

The maintainer supplied the files by hand (section 3, "The source"). What
the predecessor holds is a schematic review draft, revision A1, in KiCad
10.0.6: a schematic, a local symbol library, a netlist, a PDF and an ERC
report, a design brief, connector research, reference photos, three small
schematic tools and a planning log. It holds no PCB layout and no
fabrication outputs, so the layout and the fabrication outputs the issue
names cannot be moved; this spec moves what exists and says plainly in the
new README what does not.

After this spec those files are in `hardware/carrier/` as the predecessor
has them, `hardware/LICENSE` is the CERN-OHL-S v2 text, `hardware/README.md`
names the board, the devkit and the panel, gives the pin mapping the
firmware's board definition takes its pins from, and records what the draft
says about the level shifters, the protection and the keyed HUB75 header;
the root README states both licences; and the maintainer is asked, with the
text to paste, to freeze the predecessor once the change has merged.

## 2. Out of scope

- **Firmware.** No file under `firmware/` changes. The board definition that
  holds these pins is `firmware-panel-driver`'s
  (`docs/designs/product-v0-build.md`); it reads the table of AC-5. The
  predecessor firmware's driver settings (`import/firmware/` on the source
  branch) are that issue's to read; this spec copies no line of them to
  `main` and leaves the branch `hardware-import` in place for it.
- **Any change to the design, and its completion.** No edit inside a KiCad
  file, no new revision, no layout, no fabrication outputs, no closing of the
  open design gates the predecessor's brief lists. A fault noticed while
  reading the schematic is a finding, not a fix.
- **The licence notice on the board itself.** CERN-OHL-S v2 asks for the
  notice and the source location on the documentation and, where practicable,
  on the product. Putting them in the schematic's title block and on a
  silkscreen changes the design, so it belongs to the next revision; this
  spec puts them in `hardware/README.md` (AC-3).
- **The predecessor's software.** Its desktop app and UDP-receiver firmware
  are not moved (product spec section 3: "the UDP-receiver firmware is
  history").
- **EDA checks in CI** (ERC, a rendered schematic), a bill of materials with
  suppliers, and a second board. `hardware/` gets one subdirectory per board
  so that the open-source PCB of product spec section 2 can sit beside this
  one later.
- **A credential that reaches the predecessor.** None is added; see AC-7.

## 3. Acceptance criteria

**The source** (maintainer answer, question #7076041741). The predecessor's
files are on the branch `hardware-import` of this repository, pushed by the
maintainer: commit `a52a4008dc29f180360e3469112c4bf258a08005`, one commit on
top of `main`, copied from `char-matrix-dashboard` at
`6b71a6e7652a0f6b9d462b4cb646abe227ecdd1c`. `import/hardware/` is the
predecessor's complete `hardware/` directory (the KiCad carrier project
under `kicad/carrier/`, its review exports under `kicad/carrier/review/`,
`README.md`, `design-preparation.md`, `reference/`, `tools/`);
`import/firmware/` holds `main.cpp`, `config.example.h`, `platformio.ini`
and `partitions_hub75.csv`; `import/notes/` holds the carrier planning log.
At that commit the carrier is a schematic review draft: there is no PCB
layout and there are no fabrication outputs. The files hold no credentials;
the photos' EXIF data was stripped and an absolute path in
`review/carrier.xml` was made relative before the push. "The source" below
is that commit.

- AC-1. **The design files are moved unchanged.** Given the source, when the
  implementing PR is merged, then every file under `import/hardware/` is at
  `hardware/carrier/<the same relative path>` with the same bytes (so the
  schematic is `hardware/carrier/kicad/carrier/carrier.kicad_sch` and the
  predecessor's design brief is `hardware/carrier/README.md`), and
  `import/notes/2026-09-19-carrier-pcb-planning.md` is at
  `hardware/carrier/notes/2026-09-19-carrier-pcb-planning.md` with the same
  bytes; `hardware/.gitkeep` is gone. Left out, and only these: the three
  files of AC-2, and any editor backup, lock or per-user state (`*-backups/`,
  `*.lck`, `~*`, `_autosave-*`, `*.kicad_prl`, `fp-info-cache`, `.DS_Store`)
  should the source hold one. Nothing under `import/firmware/` is moved.
  Nothing is regenerated, reformatted or re-exported; links inside the moved
  files that pointed at the predecessor's `firmware/` directory or at a
  left-out file stay as they are and are named in the new README (AC-4,
  "Files"). No layout and no fabrication output is made up to stand in for
  the missing ones.
- AC-2. **The licence text, and what it does not cover.** `hardware/LICENSE`
  is the CERN Open Hardware Licence Version 2, Strongly Reciprocal,
  byte-identical to CERN's text at `https://ohwr.org/cern_ohl_s_v2.txt`
  (13419 bytes, sha256
  `253ad3f89603e728abfa60c36fbcaf8225cf55c1eab12725f19fb3d74d647f3a`,
  fetched 2026-11-22). Version 2 is the only version that carries the name
  CERN-OHL-S, so the product spec's "CERN-OHL-S" is SPDX `CERN-OHL-S-2.0`
  *(agent's call)*. The root `LICENSE` (Apache-2.0) is unchanged. Three
  files of the source are another party's work with no licence that lets
  this repository redistribute them, and are left out *(agent's call: an
  open-hardware directory holds only what its licensor can license; they can
  be added later, which a published file cannot be undone)*:
  `reference/C18077853.pdf` (the connector manufacturer's drawing) and
  `reference/dev-board-pinout.png` and `reference/dev-board-pinout.avif`
  (the devkit seller's pinout image). The README names each under "Files"
  with where to get it (the LCSC part number, and the image address the
  design brief gives). The local symbol `Carrier.kicad_sym` derives from a
  KiCad library symbol, which the KiCad libraries' licence allows inside a
  design under the design's own terms; the README's "Licence" section says
  so in one sentence.
- AC-3. **The notice.** The "Licence" section of `hardware/README.md` carries
  this notice, the form CERN's user guide gives, with the holder the author
  of the source commit and the year 2026:

  ```
  Copyright <holder> 2026.

  This source describes Open Hardware and is licensed under the CERN-OHL-S v2.

  You may redistribute and modify this source and make products using it
  under the terms of the CERN-OHL-S v2 (https://ohwr.org/cern_ohl_s_v2.txt).

  This source is distributed WITHOUT ANY EXPRESS OR IMPLIED WARRANTY,
  INCLUDING OF MERCHANTABILITY, SATISFACTORY QUALITY AND FITNESS FOR A
  PARTICULAR PURPOSE. Please see the CERN-OHL-S v2 for applicable conditions.

  Source location: https://github.com/adam26davidson/panelator

  As per CERN-OHL-S v2 section 4, should You produce hardware based on this
  source, You must where practicable maintain the Source Location visible on
  the external case of the panelator carrier board or other products you
  make using this source.
  ```

  followed by one line naming the SPDX identifier `CERN-OHL-S-2.0` and
  linking `LICENSE` beside it, and by AC-2's sentence on the symbol library.
- AC-4. **`hardware/README.md` names the board and what it is for.** It has
  these sections, in this order, each stating only what the source's files
  show; a fact they do not hold is written "not recorded", never guessed,
  and what the predecessor marks as proposed, assumed or unverified keeps
  that word:
  - *What this is*: the carrier for the LED panel, schematic revision A1, a
    review draft; that it takes the ESP32-S3-N16R8 devkit (the 42-pin board
    the design brief describes, two rows of 21) in sockets and connects to
    one 128×64 HUB75E panel, P2.5, 1/32 scan, RGB (product spec section 2)
    by a 16-way ribbon cable; that its files are in `hardware/carrier/`.
  - *Status*: a schematic review draft with a clean ERC report of
    2026-09-19; no PCB layout, no fabrication outputs and no manufactured
    board are in these files; the design gates the predecessor's brief and
    KiCad README leave open, listed by name with a link to where each is
    described.
  - *Pin mapping*: AC-5.
  - *Design notes*: one paragraph each, with the reference designators and
    part numbers the KiCad README and the netlist give, on (1) the level
    shifters: the two SN74AHCT541 buffers U1 and U2 that take the fourteen
    signals from 3.3 V to 5 V, their series resistors, the bias resistors
    and the pull-up that blanks the panel through `OE`; (2) the protection:
    the fuse F1 on the harness 5 V and the LM66100 reverse-current blocker
    U3 between the buffer supply and the devkit's 5 V pin, and the power
    cases they are meant for (external 5 V and USB together; USB alone must
    not energise the panel); (3) the keyed HUB75 header: the shrouded 2×8
    male header J3 and the ribbon cable, with the orientation and pitch
    checks the brief still asks for.
  - *Files*: what each top-level entry of `hardware/carrier/` is; that the
    project opens in KiCad 10.0.6; that there are no layout or fabrication
    files; the three files left out (AC-2); and that the design brief's
    links to `../firmware/` pointed at the predecessor's firmware, which is
    not in this repository.
  - *Provenance*: `char-matrix-dashboard` at
    `6b71a6e7652a0f6b9d462b4cb646abe227ecdd1c`, through the source commit,
    with what the maintainer changed before the push (EXIF data stripped,
    one path made relative), and the date of the move.
  - *Licence*: AC-3.
- AC-5. **The pin mapping.** The "Pin mapping" section opens with the
  sentence that the firmware's board definition takes its HUB75 pins from
  this table (product spec section 2), and has one table with these fourteen
  rows and these columns: signal, pin on the HUB75 header, ESP32-S3 GPIO
  (written `GPIO<n>`), devkit socket pin, buffer.

  | Signal | HUB75 pin | GPIO | Socket pin |
  |---|---|---|---|
  | R1 | 1 | GPIO42 | J2.6 |
  | G1 | 2 | GPIO41 | J2.7 |
  | B1 | 3 | GPIO40 | J2.8 |
  | R2 | 5 | GPIO2 | J2.3 |
  | G2 | 6 | GPIO1 | J2.2 |
  | B2 | 7 | GPIO39 | J2.9 |
  | E | 8 | GPIO14 | J2.19 |
  | A | 9 | GPIO45 | J2.15 |
  | B | 10 | GPIO48 | J2.16 |
  | C | 11 | GPIO47 | J2.17 |
  | D | 12 | GPIO21 | J2.18 |
  | CLK | 13 | GPIO12 | J1.20 |
  | LAT | 14 | GPIO11 | J1.19 |
  | OE | 15 | GPIO10 | J1.18 |

  HUB75 pins 4 and 16 are ground. The values above are those of the
  predecessor's design brief, its firmware (`import/firmware/main.cpp`,
  `R1_PIN` to `OE_PIN`) and the netlist (`kicad/carrier/review/carrier.xml`,
  nets `MCU_<signal>`, with J1 the devkit's left row and J2 its right row as
  the brief's header table numbers them), which agree (checked by the spec
  stage, 2026-11-22). The implement stage fills the buffer column (`U1` or
  `U2` and the channel) from the netlist and checks every row against it
  again; given a row the netlist contradicts, then it stops with a spec gap
  rather than choosing. Below the table: the devkit's other connections from
  the netlist (`DEV_5V` at J2.21, `DEV_3V3`, ground, the unconnected socket
  pins as a group), and the two cautions the brief records for the board
  definition: GPIO48 also drives the devkit's RGB LED, and GPIO45 is a
  strapping pin without a bias resistor.
- AC-6. **The root README states the licences.** In `README.md`: the layout
  line for `hardware/` reads `Carrier board design (CERN-OHL-S v2)`; the
  "Licence" section says the software is Apache-2.0 (`LICENSE`) and
  everything under `hardware/` is CERN-OHL-S v2 (`hardware/LICENSE`, with a
  link to `hardware/README.md`), without the words "added when the hardware
  files move in"; the "Predecessor" section keeps its description of
  `char-matrix-dashboard` and adds that it is no longer developed and that
  its carrier design now lives in `hardware/`. It does not say the
  repository is archived, which happens after the merge (AC-7). The
  repository's name stays a link only if its address answers an
  unauthenticated request with `200` when the stage runs; otherwise it is
  written as plain code text, since a link that answers `404` serves no
  reader. Nothing else in the file changes.
- AC-7. **The freeze is the maintainer's, by hand, after the merge, and the
  pipeline asks for it** (maintainer answer, question #7076041741: "I will
  add the notice and archive char-matrix-dashboard after the hardware PR
  merges; ask for it then."). No stage writes to the predecessor and no
  credential is requested: the App's token cannot write there (ADR 0014).
  No stage runs after a merge, so the asking is the implement stage's last
  act before it returns its result *(agent's call)*: given its work is
  complete and `pnpm test` passes, then it raises one capability question
  with a `first_contact` request (`party` `github:adam26davidson`, `channel`
  `github`, `message` the pointer block of section 4 in full) that says:
  nothing is to be done before the pull request has merged; after the merge,
  put the block at the top of the predecessor's `README.md` and archive the
  repository (Settings, "Archive this repository"); an approval means "I
  will do this once it has merged". Given any answer, then the stage
  continues and returns its result: the answer on the issue is the record,
  and nothing in this repository states that the freeze has happened. Given
  the stage is resumed or retried after that question was answered, then it
  does not ask again.
- AC-8. **Nothing else changes.** The implementing PR touches `hardware/`,
  the root `README.md`, `tools/hardware-check/` and `pnpm-lock.yaml`, and
  nothing else. No file from `import/firmware/` appears in the PR, and the
  branch `hardware-import` is not deleted or changed.
- AC-9. **`pnpm test` holds the result in place.** A vitest test in
  `tools/hardware-check/` (a workspace package, picked up by the root
  `tools/**/*.test.ts` include, so no vitest configuration changes) asserts,
  reading the repository's files: `hardware/LICENSE` has the sha256 of AC-2;
  `hardware/README.md` has the seven sections of AC-4 in order and the notice
  of AC-3; its pin table has exactly the fourteen signals of AC-5 with the
  GPIO and HUB75 pin of each as AC-5 gives them;
  `hardware/carrier/kicad/carrier/carrier.kicad_sch`,
  `hardware/carrier/kicad/carrier/review/carrier.xml` and
  `hardware/carrier/README.md` exist; the three files of AC-2 and
  `hardware/.gitkeep` do not; no path under `hardware/` matches a left-out
  pattern of AC-1; the root `README.md` names `Apache-2.0`, `CERN-OHL-S v2`
  and `hardware/LICENSE` in its "Licence" section and does not contain
  "added when the hardware files move in".

## 4. Interfaces and files

- `hardware/LICENSE`: new, AC-2.
- `hardware/README.md`: new, AC-3 to AC-5.
- `hardware/carrier/`: new, the files of AC-1 (about 21 MB, nearly all of it
  the six reference photos the design brief links to).
- `hardware/.gitkeep`: removed.
- `README.md`: the three places of AC-6.
- `tools/hardware-check/package.json`, `tools/hardware-check/test/`: new,
  AC-9 (a private workspace package named for its directory, no runtime
  dependency).
- `pnpm-lock.yaml`: the new workspace package's entry.

No sensitive path is touched: the root test configuration already picks up
a new package under the tools directory, so none of the test wiring changes.

The pointer block for the predecessor's `README.md` (AC-7), to be placed
above everything else in that file:

```
> **This repository is frozen.** The project continues as
> [panelator](https://github.com/adam26davidson/panelator), an open-source,
> fully configurable LED dashboard for the same panel. The carrier design is
> maintained there, in
> [`hardware/`](https://github.com/adam26davidson/panelator/tree/main/hardware),
> under CERN-OHL-S v2. Nothing here is developed further; issues and pull
> requests belong in panelator.
```

## 5. Verification

- `pnpm test` from the repository root passes, with the test of AC-9 in it.
- Byte identity (AC-1), by the implement stage and again by the review:
  `git ls-tree -r a52a4008dc29f180360e3469112c4bf258a08005:import/hardware`
  and `git ls-tree -r HEAD:hardware/carrier` list the same paths with the
  same blob ids, apart from the three files of AC-2 on the one side and
  `notes/` on the other, whose one file has the blob id of
  `a52a4008dc29f180360e3469112c4bf258a08005:import/notes/2026-09-19-carrier-pcb-planning.md`.
- The pin table (AC-5), by the review: three signals chosen by the reviewer
  are traced in `review/carrier.xml` from the socket pin through the buffer
  and the series resistor to the HUB75 header pin, and agree with the table.
- `git diff --stat origin/main...HEAD` lists only the paths of AC-8.
- The question of AC-7 is on the issue with the pointer block quoted in
  full.

## 6. Open decisions

None.
