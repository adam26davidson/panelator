Widget profile. The WebAssembly widgets under `widgets/` and the SDKs and
hosts under `sdk/`: the Rust SDK and the Rust test host in `sdk/rust/`, the
conformance suite in `sdk/conformance/`, and the AssemblyScript SDK in
`sdk/assemblyscript/`. `docs/widget-abi.md` is the contract every host and
SDK implements: a widget imports only what it lists, from the module it
names, and exports exactly what it requires; nothing reaches the network,
a filesystem, another widget or the framebuffer (product spec 3.3). A
change to the ABI is a change the spec makes, with the version moved as
the document's versioning rule says.

Build with the toolchain `rust-toolchain.toml` pins and its
`wasm32-unknown-unknown` target, through `sdk/rust/build-widgets.sh`; the
SDK and the widgets are `no_std`. Built-in widgets use the Rust SDK
(product spec 11). A frame depends only on what the host gives the widget
(time, timezone, config, data, its random sequence), so the same module
gives identical frames in every host (product spec 13). The golden frames
under `sdk/conformance/golden/` are that contract: change one only when the
spec changes what the frame shows, write it with `PANELATOR_BLESS=1` and say
in your result which frames changed and why; never bless a frame to make a
failing test pass. When the spec has a merged `design/`, its renders are
what the frames show; where the design is silent, follow the nearest render
and record the gap as a finding. Add no dependency the spec does not name,
and do not loosen `deny.toml`, the clippy settings or a module's size and
memory caps. Each widget declares an OSI-approved licence (product spec
9.1).

When your stage has a shell (implement and fix), run `pnpm test` from the
repo root before writing your result, and `sdk/rust/check.sh` when it exists
and your change touches `sdk/` or `widgets/`. If a tool it needs is missing
on this machine (the pinned toolchain or its target, `cargo-nextest`,
`cargo-deny`), install it without root (`rustup` reads
`rust-toolchain.toml`; `cargo install --locked` at the version CI pins) and
say how in your result; a check you could not run is named in your result
with the reason, never skipped silently or reported as passed. A stage
without a shell (plan and review) judges by reading: do not try to run the
suite, and a command you could not run is not a missing verification. Do
not touch files outside the plan's file scope; lockfiles and `schemas/` are
the only exceptions. Record anything you notice but must not fix as a
finding in your result, then continue with your task.
