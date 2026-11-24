# 116. Widget ABI 0.1 fixes five host rules it left open: the config's bytes, negative lengths, ranges at the end of memory, and the size bounds

Status: written 2026-11-24 for issue #522; a spec derived from its parent
design needs no maintainer approval (delivery-system design section 11).
Marks [spec 107](../107-widget-abi-and-rust-sdk/spec.md) AC-9, AC-10 and
AC-11 and [spec 115](../115-simulator-engine/spec.md) AC-6, AC-7 and AC-13
(amended).
Class: bug. Domain: backend *(agent's call: the work lies in `docs/`, `sdk/`
and `web/simulator/`, and the plan stage picks the implementation profile by
where it lies; this line says `backend` because the spec changes no pixel of
any frame and no page, so it has no screen to name, and a `widget` or
`web-ui` line requires a `Screens:` list and a design run; section 4)*.
Parent: docs/designs/product-v0-build.md
Derives from: [v0 build design](../../docs/designs/product-v0-build.md)
section 4 ("One ABI, three hosts": a change to the ABI is a change to the
ABI child's files, in the same PR as the hosts that need it);
[product spec](../../docs/product-spec.md) sections 3.3 (host API) and 13
(the same module produces identical frames on the board, in the Rust test
host and in the browser); [design-tree](../../docs/design-tree.md) R3.Q1
(retained layers) and R5.Q6 (ABI conformance and golden pixel tests);
[ADR 0017](../../docs/decisions/0017-widget-abi-v0-shape.md) decisions 4
(config is one JSON document the widget reads as bytes) and 5 (everything a
frame depends on is an integer rule or committed bytes);
[ADR 0018](../../docs/decisions/0018-widget-abi-config-bytes-and-memory-ranges.md)
(the choices made here); [spec 107](../107-widget-abi-and-rust-sdk/spec.md)
(the document, the reference host, the conformance directory);
[spec 115](../115-simulator-engine/spec.md) (the browser engine).

## 1. Goal

`docs/widget-abi.md` says that where it and a host differ, the document is
right. On five points it is silent, or says something the reference host
does not do, so two hosts written from it can differ:

1. which bytes `config_read` returns for a config (the reference host writes
   compact JSON with sorted keys, spec 115 gives the browser engine
   `JSON.stringify`, and the scene file's own text is a third reading);
2. whether a negative string length is a trap;
3. what `config_read` does with a negative `cap` and a pointer past memory
   (the document says it returns 0; the reference host traps);
4. whether an empty string at a pointer past memory is a trap;
5. how large a panel and a placement may be (the reference host has limits
   the document does not give).

After this spec the document fixes each in a sentence or two, the reference
host and the browser engine do what it says, a test in each host pins each
rule, the two hosts check the config rule against one shared file of
vectors, and the conformance README's regeneration paragraph says what the
command does. No golden frame changes.

## 2. Out of scope

- **Any change to a frame.** No golden PNG or `frames.json` changes, no
  scene is added, and `PANELATOR_BLESS` is not used.
- **The version.** The document stays 0.1 and `pn_abi_version` is unchanged
  (AC-5).
- **The SDK and the widgets.** `sdk/rust/panelator-widget` and `widgets/` do
  not change: the SDK's reader takes any JSON text, and the canonical form is
  one.
- **The firmware runtime** (`firmware-wasm-runtime`). It is written from the
  document after this; nothing under `firmware/` changes here.
- **How a config reaches a board** (the relay's message, storage, who
  canonicalises): `screen-config-and-type-sharing` and its siblings. This
  spec fixes only the bytes a module reads.
- **The bounds of an asset's width, height and frame count**, and whether
  `externref` is refused everywhere (issue #510).
- **The rule that a UI-domain spec names screens.** Section 4 says why this
  spec has none; changing the gate is delivery-system work.

## 3. Acceptance criteria

Definitions. *The document* is `docs/widget-abi.md`. *The host* is the
reference host, the crate `panelator-test-host` in `sdk/rust/test-host/`.
*The engine* is the package `@panelator/simulator` in `web/simulator/`
(spec 115). *The suite* is `sdk/conformance/`. *The memory's size* is the
length in bytes of the module's memory at the time of the call, so after
any `memory.grow` before it. *RFC 8785* is the JSON Canonicalization Scheme.
Everything AC-1 to AC-4 say of the ABI is written in the document, under the
heading named; the document is the normative text and these criteria are
what it must say.

**The document**

- AC-1. **The config's bytes** ("Config"). The bytes `config_len` counts and
  `config_read` copies are the config in the canonical form of RFC 8785:
  no whitespace; the members of every object in ascending order of their
  names compared as sequences of UTF-16 code units; a string written with
  only `"`, `\` and U+0000 to U+001F escaped (`\"`, `\\`, the short forms
  `\b`, `\t`, `\n`, `\f`, `\r`, and `\u00xx` in lowercase hex for the rest)
  and every other character as itself in UTF-8; a number written as
  ECMAScript writes the IEEE 754 double nearest to it (the shortest digits
  that give the same double back: `1.0` and `1e2` are `1` and `100`, `-0`
  is `0`, `1e21` is `1e+21`). The bytes therefore do not depend on how the
  config was written in a scene file or stored, nor on the order in which a
  host's map holds the members. The document also says: where a config's
  text repeats a member name within one object, the last member is the one
  that counts; a config that holds a number outside the range of a double,
  or a string that is not well-formed Unicode (an unpaired surrogate), is
  not a config, and a host refuses its scene, naming the placement. Given
  the document, then it gives these examples, which are four of AC-9's
  vectors:

  ```
  { "text": "panelator 60 Hz" }       {"text":"panelator 60 Hz"}      26 bytes
  {"b":1,"a":2}                       {"a":2,"b":1}                   13 bytes
  {"n":[1.0,1e2,-0,0.5,1e21]}         {"n":[1,100,0,0.5,1e+21]}       25 bytes
  {"a":1,"a":2}                       {"a":2}                          7 bytes
  ```

- AC-2. **A range in memory** ("Imports", in place of the sentence that
  today says only that an argument outside the memory is a trap). A string
  or buffer argument is a pointer `ptr` and a count `n` of bytes. `ptr` is
  read as an unsigned 32-bit number. The range lies inside the module's
  memory when `n >= 0` and `ptr + n <= size`, the sum taken without
  wrapping and `size` being the memory's size. Otherwise the call is a
  trap: it does not return and the placement's run ends in an error. The
  document states the three consequences in so many words:
  - a negative `len` or `name_len` (`draw_text`, `text_width`,
    `draw_image`) is a trap;
  - an empty range (`n == 0`) lies inside the memory when `ptr <= size` and
    is a trap when `ptr > size`, which is WebAssembly's own rule for
    `memory.copy` and `memory.fill`;
  - the check comes before everything else the import does: a call whose
    range is outside the memory traps whatever its other arguments are (an
    unknown font, a missing asset, a frame that does not exist) and draws
    nothing.
- AC-3. **`config_read`'s `cap`** ("Config"). For `cap >= 0` the buffer is
  the range `ptr`, `cap` of AC-2 and all of it must lie inside the memory,
  not only the bytes copied; so `cap == 0` with `ptr > size` is a trap. A
  negative `cap` names no buffer: the call copies nothing, returns 0 and
  does not trap, whatever `ptr` is. The document says both, and no longer
  leaves the second to a parenthesis that is silent about `ptr`.
- AC-4. **Size bounds.** The document says, under "The layer and the
  drawing rules", that a layer's width and height are each 1 to 4096 (the
  range of `pn_width` and `pn_height`); under "Stepping and composition",
  that the panel's width and height are each 1 to 16384; and under "The
  conformance profile", that a host refuses a scene whose `panel` or whose
  placement's `width` or `height` is outside those ranges, naming the field.
  *(agent's call: these are the reference host's limits. With them a
  layer's `width * height * 4` and a frame's `width * height * 3` are below
  2^31, so a host can index both with 32-bit arithmetic, and
  `layer_width` and `layer_height` return what a module can also declare.
  "Geometry is configuration" stands: no host holds a panel size, the
  bound is on what a size may be.)*
- AC-5. **The version stays 0.1.** The document's version line and
  `pn_abi_version` do not change, and the import and export tables keep
  their rows, so the three-way test of spec 107 AC-1 passes unchanged.
  *(agent's call: 0.1 is a draft. AC-2 and AC-4 write down what the one
  host on `main` does, AC-3 what the document already says, and AC-1 gives
  every config the suite holds the bytes it has today, so no module and no
  frame that conformed stops conforming.)*

**The reference host**

- AC-6. **The host follows AC-1 to AC-4.**
  - Given a scene, then the bytes the host serves as a placement's config
    are AC-1's canonical form of the scene's `config`, made by one public
    function of the library that the tests call.
  - Given `config_read(ptr, cap)` with `cap < 0`, then it returns 0 without
    reading `ptr` (today it traps when `ptr` is past the memory).
  - Given a scene whose panel or placement is outside AC-4's ranges, or
    whose config is not a config by AC-1, then `Scene::from_json` fails,
    naming `panel`, `placements[i]` or `placements[i].config`.
  - The `range` helper already computes AC-2; it is kept or rewritten, and
    AC-7 pins it.
  - The number form needs ECMAScript's `Number::toString`. The host may add
    the crate `ryu-js` (Apache-2.0 OR BSL-1.0; `Apache-2.0` is on
    `deny.toml`'s allow-list) as its one new dependency, or lay the digits
    out itself from Rust's shortest round-trip form (`{:e}` of an `f64`).
    Either way `deny.toml` is not changed and `sdk/rust/check.sh` passes.
- AC-7. **The host's tests.** Host tests, with modules written in WAT as
  the existing ones are, cover every row below on a module of one page
  (65536 bytes) with the config `{"a":1}` and no assets; `c` is any colour.
  "Returns" means the run does not end in an error and the import's result
  is the value shown.

  | Call | Result |
  |---|---|
  | `draw_text(1, 0, 0, 65536, 0, c)` | returns 0 |
  | `draw_text(1, 0, 0, 65537, 0, c)` | trap |
  | `draw_text(1, 0, 0, 70000, 0, c)` | trap |
  | `draw_text(1, 0, 0, -1, 0, c)` | trap |
  | `draw_text(1, 0, 0, 16, -1, c)` | trap |
  | `draw_text(9, 0, 0, 70000, 0, c)` (no font 9) | trap, not -1 |
  | `text_width(1, 65536, 0)` | returns 0 |
  | `text_width(1, 65537, 0)` | trap |
  | `text_width(1, 16, -1)` | trap |
  | `draw_image(65536, 0, 0, 0, 0)` | returns -1 |
  | `draw_image(65537, 0, 0, 0, 0)` | trap |
  | `draw_image(16, -1, 0, 0, 0)` | trap |
  | `config_read(65536, 0)` | returns 0 |
  | `config_read(65537, 0)` | trap |
  | `config_read(65530, 6)` | returns 6 |
  | `config_read(65530, 7)` | trap |
  | `config_read(16, -4)` | returns 0, the bytes at 16 unchanged |
  | `config_read(65537, -1)` | returns 0 |
  | `config_read(-1, -1)` | returns 0 |
  | `config_read(16, -2147483648)` | returns 0 |

  And: given a module of one page that may grow, when it calls
  `memory.grow(1)` and then `draw_text(1, 0, 0, 70000, 0, c)`, then the
  call returns 0 (the size is the one at the time of the call). Given
  panels of 0 by 1, 16385 by 1 and 1 by 16385 and placements of 0 by 1,
  4097 by 1 and 1 by 4097, then `Scene::from_json` fails naming the field;
  given panels of 16384 by 1 and 1 by 16384 and placements of 4096 by 1 and
  1 by 4096, then it succeeds. Given each vector of AC-9, then the host's
  canonical form of `config` equals `canonical` byte for byte, and each
  entry of `rejected` fails. Given a scene whose placement has the config
  text `{"b":1,"a":2}` and a module that draws `config_len()` and the first
  bytes read, then the module sees 13 and `{"a":2,"b":1}`. A test reads the
  document and fails when one of AC-1's four example lines is missing from
  it.

**The engine**

- AC-8. **The engine follows AC-1 to AC-4.** Given `web/simulator/` is on
  `main` when this is implemented (the pull request of issue #435 has
  merged), then the same pull request changes it:
  - a placement's config is served as AC-1's canonical form, made by one
    exported function (section 5) that `createScene` uses, in place of
    `JSON.stringify`'s bytes; a config that is not JSON data (anything but
    null, booleans, finite numbers, well-formed strings, arrays and plain
    objects of these) fails `createScene` with an error naming the
    placement;
  - `createScene`, and `readScene` for a scene file, refuse a panel or a
    placement outside AC-4's ranges, naming the field;
  - `config_read` and the range check already follow AC-2 and AC-3; they
    are kept;
  - its unit tests gain every row of AC-7's table and the growth case with
    modules assembled by its test helper, the panel and placement bounds of
    AC-7, the vectors of AC-9 (`config` parsed with `JSON.parse`, then
    canonicalised; each `rejected` entry fails `readScene` or
    `createScene`), and a check that for every vector whose config is an
    object of one member holding no object, the canonical form equals
    `JSON.stringify` of the parsed value (with nothing to sort, the two
    are the same bytes);
  - `web/simulator/README.md` says the config's bytes are the document's
    canonical form.

  Given `web/simulator/` is not on `main` then, the pull request changes
  the document, the host and the suite only, and the engine arrives
  following spec 115 as marked: its AC-6, AC-7 and AC-13 point here, and
  this criterion's list is then part of that work.

**The suite**

- AC-9. **The config vectors.** `sdk/conformance/config/vectors.json` is one
  JSON object with two lists. `cases`: each entry has `name`, `config` (a
  string: the config's text as a scene file could hold it) and `canonical`
  (a string: the canonical form's bytes as text). `rejected`: each entry
  has `name` and `config`. A host parses `config` with the parser it reads
  scenes with. `cases` holds at least these, with the canonical forms
  shown (the escapes below are JSON text, written out in the file as JSON
  strings):

  | `config` | `canonical` |
  |---|---|
  | `{}` | `{}` |
  | `{ "text": "panelator 60 Hz" }` | `{"text":"panelator 60 Hz"}` |
  | `{"b":1,"a":2}` | `{"a":2,"b":1}` |
  | `{"b":{"z":[3,{"y":1,"x":2}],"a":null},"a":true}` | `{"a":true,"b":{"a":null,"z":[3,{"x":2,"y":1}]}}` |
  | `{"10":1,"9":2,"b":3,"B":4,"":5}` | `{"":5,"10":1,"9":2,"B":4,"b":3}` |
  | `{"a":1,"a":2}` | `{"a":2}` |
  | `{"n":[1.0,1e2,-0,0.5,1e21,1e-7,0.000001,9007199254740993,123456789012345680000,4.5e-3,-12]}` | `{"n":[1,100,0,0.5,1e+21,1e-7,0.000001,9007199254740992,123456789012345680000,0.0045,-12]}` |
  | `{"s":"aA\"\\\/\b\f\n\r\t\u0001\u001f\u007fé€😀"}` | `{"s":"aA\"\\/\b\f\n\r\t\u0001\u001f` then U+007F, U+00E9, U+20AC and U+1F600 as themselves in UTF-8, then `"}` (47 bytes) |
  | the sorting example of RFC 8785 section 3.2.3: an object whose names are, in this order, `€`, `\r`, `דּ`, `1`, `😀`, `\u0080`, `ö`, with the values 1 to 7 | the members in the order `\r`, `1`, U+0080, U+00F6, U+20AC, U+1F600, U+FB33 (values 2, 4, 6, 7, 1, 5, 3): U+1F600 comes before U+FB33 because its first UTF-16 unit is D83D; only `\r` is written as an escape (53 bytes) |

  and the number samples of RFC 8785 appendix B that are finite, each as a
  one-member config. `rejected` holds at least `{"a":"\ud800"}` (an
  unpaired surrogate) and `{"a":1e400}` (outside a double's range). The
  canonical forms above were computed with Node's `JSON.stringify` over
  sorted names; where a value written in the file differs from what the
  two hosts compute, the hosts' agreement with RFC 8785 decides and the
  file is corrected, not the hosts bent to it.
- AC-10. **The conformance README.** `sdk/conformance/README.md`:
  - its table gains the row for `config/vectors.json`;
  - step 1 of "Using it from another host" says the placement is given the
    config in the document's canonical form (in place of "the config as its
    JSON document"), and that a host checks its form against the vectors;
  - "Regenerating frames" says the command writes `golden/<scene>/` for
    the four scenes and nothing else, and that `assets/spike-image.rgb` is
    committed and, were it ever missing, is written first by
    `PANELATOR_BLESS=1 cargo nextest run -p panelator-test-host the_spike_image_asset_is_its_formula`
    (the `golden_` filter does not select that test, and the scenes cannot
    load without the asset). The frames' command itself is unchanged.
- AC-11. **No frame changes.** Given the pull request, then nothing under
  `sdk/conformance/golden/`, `sdk/conformance/scenes/`,
  `sdk/conformance/assets/` or `sdk/conformance/fonts/` differs from
  `main`, the four golden tests of the host pass, and so do the engine's
  golden tests when the engine is on `main`.

## 4. Design notes *(agent's calls)*

**Why RFC 8785 for the config.** The three candidates were the reference
host's form (compact, names in UTF-8 byte order, numbers as `serde_json`
prints them), `JSON.stringify` of the parsed object (spec 115), and the
scene file's own text. The file's text makes whitespace part of what a
module reads and cannot be had from `JSON.parse` or from a typed store.
`JSON.stringify`'s member order is the engine's insertion order, which is
not the file's order for names that look like array indices and which a C
or Rust host would have to imitate. The reference host's form is close to
canonical but prints `1.0` where the browser prints `1`. RFC 8785 is the one
form defined outside any of the hosts: it has a published text, test
values, and libraries in each host's language, its string and number rules
are the browser's own, and for every config the suite holds it gives the
bytes both hosts give today. ADR 0018 records this.

**Why the WebAssembly rule for a range.** `ptr + n <= size` with no special
case for `n == 0` is what the engine's own `memory.copy` and `memory.fill`
do, what the reference host and the engine of issue #435 both compute, and
one comparison in C. A negative length read as unsigned is over 2 GiB,
more than any memory the ABI allows, so it is a trap under either reading
of the number.

**Why a negative `cap` returns 0 and a negative `len` traps.** The document
already says the first, and by its own rule the host that traps is the one
at fault. A `len` says how many bytes the host must read, and no count of
bytes is negative; a `cap` says how many it may write at most, and "at most
fewer than none" is none. Making both a trap would change a documented
result for no gain; making both zero would hide a module's bug in a string
call that both hosts report today.

**Why the spec's domain line says `backend`.** The scheduler's gates require
a `Screens:` list and rendered designs for a `widget` or `web-ui` spec
(spec 001 section 10). Nothing here has a look: no frame, no page and no
story changes. The implementation profile is the plan's choice by where
the work lies (`agents/stages/plan.md`), which this line does not bind; the
plan is expected to choose `widget`, whose profile has the pinned toolchain
and the frames' rule, and to list the engine's files in its scope.

## 5. Interfaces and files

New:

- `sdk/conformance/config/vectors.json` (AC-9).
- In the host, a module with the canonical form, for example
  `sdk/rust/test-host/src/config.rs` with
  `pub fn canonical(config: &serde_json::Map<String, serde_json::Value>) -> Result<Vec<u8>, String>`,
  and its tests under `sdk/rust/test-host/tests/`.
- In the engine (AC-8's first case), `web/simulator/src/config.ts` with
  `export function canonicalConfig(config: unknown): Uint8Array`, exported
  from `web/simulator/src/index.ts`, and its test beside it.

Changed:

- `docs/widget-abi.md`: "Imports", "The layer and the drawing rules",
  "Config", "Stepping and composition", "The conformance profile" (AC-1 to
  AC-4).
- `sdk/rust/test-host/src/scene.rs` (the config's bytes, the config's
  refusal), `sdk/rust/test-host/src/host.rs` (`config_read`),
  `sdk/rust/test-host/src/lib.rs`, `sdk/rust/test-host/tests/imports.rs`,
  `sdk/rust/test-host/tests/scene.rs`; `sdk/rust/test-host/Cargo.toml` and
  `Cargo.lock` only if `ryu-js` is added (AC-6).
- `sdk/conformance/README.md` (AC-10).
- In the engine (AC-8's first case): `web/simulator/src/scene.ts`,
  `web/simulator/src/conformance.ts`, their tests, and
  `web/simulator/README.md`.

Not changed: the SDK crate, the widgets, the firmware, the licence and
advisory settings of cargo-deny, the CI workflows, and the golden frames,
scenes, assets and fonts. No sensitive path is touched.

Marks made by this spec's pull request: spec 107 AC-9 (`Amended by [116]
AC-1`), AC-10 (`AC-2`) and AC-11 (`AC-4`); spec 115 AC-6 (`AC-1`), AC-7
(`AC-4`) and AC-13 (`AC-8`).

## 6. Verification

- `pnpm test` from the repository root and `sdk/rust/check.sh` pass; both
  outputs are in the implementation's final message.
- The host's tests of AC-7 and, when the engine is on `main`, the engine's
  tests of AC-8 fail when the rule they pin is broken: the implementation
  says for each of AC-1 to AC-4 which test went red when the rule was
  reversed locally (a sorted-name form swapped for insertion order, the
  negative-`cap` early return removed, `<=` for `<` in the range check, a
  bound moved by one).
- `git diff --stat main -- sdk/conformance/golden sdk/conformance/scenes sdk/conformance/assets sdk/conformance/fonts`
  is empty (AC-11).
- The README's asset command is run once with `assets/spike-image.rgb`
  moved aside, and writes a file identical to the committed one (`git
  status` is clean afterwards) (AC-10).
- A reviewer reads the five changed passages of the document against AC-1
  to AC-4 and finds each of the issue's five points answered in the
  document itself.

## 7. Open decisions

None.
