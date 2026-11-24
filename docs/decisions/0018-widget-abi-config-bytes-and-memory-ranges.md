# 0018. Widget ABI 0.1: a config's bytes are its RFC 8785 form, and a range in memory follows WebAssembly's rule

Status: accepted
Date: 2026-11-24
Decided by: the spec stage of issue #522 (design section 3: decisions other
code is written against, each with one clearly right answer under what
[ADR 0017](0017-widget-abi-v0-shape.md) already fixes, recorded with their
reasoning). Carried by
[specs/116-widget-abi-host-rules/spec.md](../../specs/116-widget-abi-host-rules/spec.md).

## Context

ADR 0017 decided that a config is one JSON document the widget reads as
bytes, and that everything a frame depends on is an integer rule or
committed bytes. `docs/widget-abi.md` did not say which bytes. The reference
host served compact JSON with names in UTF-8 byte order and numbers as
`serde_json` prints them; spec 115 gave the browser engine the bytes of
`JSON.stringify`; a host passing the scene file's text would serve a third
form. `config_len` and a truncated `config_read` make the difference
visible to a module, so two hosts could draw different frames from one
scene.

The document was also silent on a negative string length, on an empty
range past the end of memory, and on how large a panel and a layer may be,
and it disagreed with the reference host on `config_read` with a negative
`cap` and a pointer past memory. Two more hosts are being written from the
document (the firmware runtime and the browser engine).

## Decision

1. **A config's bytes are its canonical form by RFC 8785** (the JSON
   Canonicalization Scheme): no whitespace, the members of every object
   sorted by name as UTF-16 code units, strings and numbers written as
   ECMAScript's `JSON.stringify` writes them. A repeated member name keeps
   the last member; a number outside a double's range or a string with an
   unpaired surrogate is refused.
2. **A range `ptr`, `n` lies inside the memory when `n >= 0` and
   `ptr + n <= size`**, `ptr` unsigned, the sum not wrapping, `size` the
   memory's length at the time of the call. So a negative length is a trap,
   an empty range is legal up to and including the end of memory and a trap
   past it, and the check comes before anything else an import does.
3. **`config_read` with a negative `cap` returns 0 and never traps**,
   whatever the pointer: a negative capacity names no buffer. The document
   already said so; the reference host is corrected.
4. **A layer is 1 to 4096 LEDs a side and a panel 1 to 16384**, the
   reference host's limits, now in the document.
5. **The version stays 0.1.** It is a draft, and no module or committed
   frame that conformed stops conforming.

## Alternatives considered

- **The reference host's form as written** (names in UTF-8 byte order,
  `serde_json`'s numbers): `1.0` stays `1.0`, which a browser cannot
  reproduce from a parsed value, and the number format would be defined by
  one Rust crate.
- **`JSON.stringify` of the parsed object**: member order is the engine's
  insertion order, which moves names that look like array indices to the
  front, so it is neither the file's order nor a rule a C or Rust host can
  state simply.
- **The scene file's own text**: whitespace and escapes chosen by whoever
  edited the file become part of what a module reads, a browser cannot get
  the text back from `JSON.parse`, and a config stored as typed data has no
  text.
- **A canonical form of our own** (sorted by code point, integers only): no
  published text, no test values and no libraries, and a config could not
  hold a fraction.
- **Leaving the bytes to each host** and requiring widgets not to depend on
  them: `config_len` and truncation are visible, so identical frames would
  rest on every widget's care, not on the hosts.
- **An empty range is legal anywhere**: a special case in every host's
  check, and different from what `memory.copy` does with the same
  arguments.
- **A negative length is an empty string**: hides a module's bug that both
  existing hosts report as a trap.
- **A negative `cap` is a trap**, for symmetry: changes a result the
  document states, for no gain.
- **No bounds on a panel or a layer**: a scene could ask a host for an
  allocation no board or browser can make, and each host would fail in its
  own way.

## Consequences

- A host needs a canonical writer. In the browser it is a sort over
  `JSON.stringify`'s parts; in Rust the number form needs ECMAScript's
  `Number::toString` (a small crate, or a layout over the shortest
  round-trip digits); a board need not write JSON at all if it is handed
  the canonical bytes.
- `sdk/conformance/config/vectors.json` holds configs and their canonical
  bytes; every host checks its writer against it.
- A scene file may be reformatted, and its members reordered, without
  changing a frame.
- An integer above 2^53 in a config loses precision, as in a browser; a
  larger number is written as a string.
- Whoever stores or sends configs for the product (the screen-config
  children) can keep the canonical bytes as the stored form.
