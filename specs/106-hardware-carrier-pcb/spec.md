# 106. The carrier PCB lives in `hardware/` under CERN-OHL-S v2, and the frozen predecessor points here

Status: draft, written 2026-11-22 by the spec stage for issue #427. Not
eligible: section 6 holds a question to the maintainer, and the parts of
sections 3 and 4 marked *(pending)* stand on its answer. A spec derived from
its parent design needs no maintainer approval of its own (delivery-system
design section 11).
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
licence is "added when the hardware files move in", and the carrier PCB's
design files exist only in the predecessor repository
`adam26davidson/char-matrix-dashboard`, which answers `404` to the App's
token and to an unauthenticated request (checked 2026-11-22), so no stage
can read it.

After this spec the carrier PCB's design files are in `hardware/carrier/`
exactly as the predecessor has them, `hardware/LICENSE` is the CERN-OHL-S v2
text, `hardware/README.md` names the board, the devkit and the panel it is
built for, gives the pin mapping the firmware's board definition takes its
pins from, and records what the board's level shifters, protection and keyed
HUB75 header are; the root README states both licences; and the predecessor
repository is frozen with a pointer to this one.

## 2. Out of scope

- **Firmware.** No file under `firmware/` changes. The board definition that
  holds these pins is `firmware-panel-driver`'s
  (`docs/designs/product-v0-build.md`); it reads the table of AC-5.
- **Any change to the design.** No new board revision, no ERC or DRC fix, no
  re-export of fabrication outputs, no edit inside an EDA file. A fault
  noticed while reading the schematic is a finding, not a fix.
- **The licence notice on the board itself.** CERN-OHL-S v2 asks for the
  notice and the source location on the documentation and, where practicable,
  on the product. Putting them in the schematic's title block and on the
  silkscreen changes the design, so it belongs to the next board revision;
  this spec puts them in `hardware/README.md` (AC-3).
- **The predecessor's software.** Its desktop app and UDP-receiver firmware
  are not moved (product spec section 3: "the UDP-receiver firmware is
  history"). Its firmware is read for its pin constants only (AC-5), and no
  line of it is copied into this repository's `main`.
- **EDA checks in CI** (ERC, DRC, a rendered schematic), a bill of materials
  with suppliers, assembly instructions, and a second board. `hardware/` gets
  one subdirectory per board so that the open-source PCB of product spec
  section 2 can sit beside this one later.
- **A credential that reaches the predecessor.** None is added; see AC-7.

## 3. Acceptance criteria

**The source** *(pending, section 6)*. "The source" below is where the
maintainer's answer puts the predecessor's files. As asked, that is the
branch `hardware-import` of this repository, pushed by the maintainer, with
the predecessor's PCB directory under `import/` (relative paths kept) and the
predecessor firmware's file or files that set the HUB75 pins under
`import/firmware/`, the commit message naming the predecessor commit they
were taken from.

- AC-1. **The design files are moved unchanged.** Given the source's PCB
  directory, when the implementing PR is merged, then every file under it is
  at `hardware/carrier/<the same relative path>` with the same bytes (the
  schematic, the layout, the project and library files they reference, the
  fabrication outputs the predecessor holds, and its notes), and
  `hardware/.gitkeep` is gone. Left out, and only these: editor backups,
  locks and per-user state (for KiCad: `*-backups/`, `*.lck`, `~*`,
  `_autosave-*`, `*.kicad_prl`, `fp-info-cache`; the equivalents of another
  tool), and operating-system files (`.DS_Store`, `Thumbs.db`). Nothing is
  regenerated or reformatted. Given the source lacks something the issue
  names (no fabrication outputs, or no notes file), then nothing is made up
  to stand in for it: `hardware/README.md` says under "Files" that the
  predecessor held none.
- AC-2. **The licence text.** `hardware/LICENSE` is the CERN Open Hardware
  Licence Version 2, Strongly Reciprocal, byte-identical to CERN's text at
  `https://ohwr.org/cern_ohl_s_v2.txt` (13419 bytes, sha256
  `253ad3f89603e728abfa60c36fbcaf8225cf55c1eab12725f19fb3d74d647f3a`,
  fetched 2026-11-22). Version 2 is the only version that has the name
  CERN-OHL-S, so the product spec's "CERN-OHL-S" is SPDX `CERN-OHL-S-2.0`
  *(agent's call)*. The root `LICENSE` (Apache-2.0) is unchanged. Given a
  file in the source that carries another author's copyright or licence
  notice (a vendor's symbol, footprint or 3D model), then it is moved with
  its notice intact and `hardware/README.md` lists it under "Licence" as that
  author's, under that licence, outside the CERN-OHL-S grant. Given such a
  file whose terms do not allow redistribution, then it is left out, the
  README names what is missing and where to get it, and the stage records a
  finding.
- AC-3. **The notice.** The "Licence" section of `hardware/README.md` carries
  this notice, the form CERN's user guide gives, with the holder the author
  of the predecessor's commits to the PCB files (the author of the source's
  commit when that history is not readable) and the year or years of those
  commits:

  ```
  Copyright <holder> <year>.

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
  linking `LICENSE` beside it.
- AC-4. **`hardware/README.md` names the board and what it is for.** It has
  these sections, in this order, each stating only what the source's files
  show (a fact the files do not hold is written "not recorded in the
  predecessor", never guessed):
  - *What this is*: the board's name and revision as the schematic's title
    block gives them; that it carries the ESP32-S3-N16R8 devkit (the devkit
    model as the schematic names it) and drives one 128×64 HUB75E panel, P2.5,
    1/32 scan, RGB (product spec section 2); that the directory is
    `hardware/carrier/`.
  - *Status*: the prototype order of 2026-09-30 (design tree, facts), and
    whether the predecessor records the board as assembled and tested.
  - *Pin mapping*: AC-5.
  - *Design notes*: one paragraph each on the level shifters, the protection
    and the keyed HUB75 header: the parts and reference designators the
    schematic shows, which signals pass through them, the supply voltages on
    each side, and what the predecessor's own notes say about them, quoted or
    paraphrased with the file named.
  - *Files*: what each top-level file or directory under `hardware/carrier/`
    is, the EDA tool and version the files were saved with (from the file
    headers), and which files are the fabrication outputs.
  - *Provenance*: that the files come from `char-matrix-dashboard`, the
    predecessor commit when the source names it, and the date of the move.
  - *Licence*: AC-3, and AC-2's list when it is not empty.
- AC-5. **The pin mapping.** The "Pin mapping" section has one table with one
  row for each of the fourteen HUB75E signals `R1`, `G1`, `B1`, `R2`, `G2`,
  `B2`, `A`, `B`, `C`, `D`, `E`, `CLK`, `LAT`, `OE`, written with these
  names, and these columns: signal, pin number on the HUB75 header, ESP32-S3
  GPIO (written `GPIO<n>`), and the part the signal passes through (the level
  shifter's reference designator and channel). Every signal has exactly one
  GPIO and no GPIO serves two signals. Below it, a second table lists every
  other devkit pin the carrier connects (power, enables, spare headers) with
  its net. The GPIO numbers are read from the schematic's nets: the board is
  what is wired, so the schematic is the source of truth *(agent's call)*.
  Given the source holds the predecessor firmware's pin constants, then each
  is compared with the table; given a difference, then the table keeps the
  schematic's value, a line under it names the firmware's value and file, and
  the stage records a finding. The section's first sentence says that the
  firmware's board definition takes its HUB75 pins from this table (product
  spec section 2).
- AC-6. **The root README states the licences.** In `README.md`: the layout
  line for `hardware/` reads `Carrier PCB (CERN-OHL-S v2)`; the "Licence"
  section says the software is Apache-2.0 (`LICENSE`) and everything under
  `hardware/` is CERN-OHL-S v2 (`hardware/LICENSE`, with a link to
  `hardware/README.md`), without the words "added when the hardware files
  move in"; the "Predecessor" section says that `char-matrix-dashboard` is
  frozen and that its carrier PCB now lives in `hardware/`. Nothing else in
  the file changes.
- AC-7. **The freeze is the maintainer's, by hand** *(pending, section 6)*.
  Freezing the predecessor is two steps on GitHub: the block of section 4
  goes at the top of its `README.md`, and the repository is archived
  (Settings, "Archive this repository"), which makes it read-only. The App's
  token cannot write there (ADR 0014), and a credential that could (contents
  write and administration on that repository) would need a catalogue entry
  and a wrapper built for one edit to a repository that is read-only
  afterwards; so no stage does it and no credential is requested *(agent's
  call)*.
- AC-8. **Nothing else changes.** The implementing PR touches `hardware/`,
  the root `README.md`, `tools/hardware-check/` and `pnpm-lock.yaml`, and
  nothing else. No file from `import/firmware/` and no credential, WiFi name
  or network address from the source appears in the PR.
- AC-9. **`pnpm test` holds the result in place.** A vitest test in
  `tools/hardware-check/` (a workspace package, picked up by the root
  `tools/**/*.test.ts` include, so no vitest configuration changes) asserts,
  reading the repository's files: `hardware/LICENSE` has the sha256 of AC-2;
  `hardware/README.md` has the seven sections of AC-4 in order and the notice
  of AC-3; the pin table has exactly the fourteen signals of AC-5, each with
  one `GPIO<n>` with `n` from 0 to 48, no GPIO twice; `hardware/carrier/`
  exists, is not empty and holds no file of AC-1's left-out kinds;
  `hardware/.gitkeep` does not exist; the root `README.md` names
  `Apache-2.0`, `CERN-OHL-S v2` and `hardware/LICENSE` in its "Licence"
  section and does not contain "added when the hardware files move in".

## 4. Interfaces and files

- `hardware/LICENSE`: new, AC-2.
- `hardware/README.md`: new, AC-3 to AC-5.
- `hardware/carrier/`: new, the design files of AC-1.
- `hardware/.gitkeep`: removed.
- `README.md`: the three places of AC-6.
- `tools/hardware-check/package.json`, `tools/hardware-check/test/`: new,
  AC-9 (`@panelator/hardware-check`, private, no runtime dependency).
- `pnpm-lock.yaml`: the new workspace package's entry.

No sensitive path is touched (`agents/sensitive-paths.txt`): the root
`package.json`, `pnpm-workspace.yaml` and `vitest.config.ts` already cover a
new package under `tools/`.

The pointer block for the predecessor's `README.md` (AC-7), to be placed
above everything else in that file:

```
> **This repository is frozen.** The project continues as
> [panelator](https://github.com/adam26davidson/panelator), an open-source,
> fully configurable LED dashboard for the same panel. The carrier PCB is
> maintained there, in
> [`hardware/`](https://github.com/adam26davidson/panelator/tree/main/hardware),
> under CERN-OHL-S v2. Nothing here is developed further; issues and pull
> requests belong in panelator.
```

## 5. Verification

- `pnpm test` from the repository root passes, with the test of AC-9 in it.
- Byte identity (AC-1), by the review: for the source's PCB directory `<dir>`,
  `git ls-tree -r origin/hardware-import:import/<dir>` and
  `git ls-tree -r HEAD:hardware/carrier` list the same paths with the same
  blob ids, apart from the left-out kinds.
- The pin table (AC-5), by the review: three signals chosen by the reviewer
  are traced in the schematic file from the HUB75 header pin through the
  level shifter to the devkit pin, and agree with the table.
- `git diff --stat origin/main...HEAD` lists only the paths of AC-8.

## 6. Open decisions

One capability question is with the maintainer (asked 2026-11-22, issue
#427): how the predecessor's files reach the pipeline, and who freezes the
predecessor. The source paragraph of section 3 and AC-7 are written for the
recommended answer and are brought in line with the answer when it arrives.
