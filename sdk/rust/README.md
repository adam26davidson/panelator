# Rust SDK, test host and checks

- `panelator-widget/`: the Rust SDK on [widget ABI 0.1](../../docs/widget-abi.md).
- `test-host/`: `panelator-test-host`, the reference host. It runs modules as a scene against the
  retained-layer model and writes or checks frames (`run`, `check`, `inspect`). The conformance
  suite it is tested with is `sdk/conformance/`.
- `build-widgets.sh`: builds the three spike widgets (`widgets/`) to `target/widgets/*.wasm`.
- `check.sh`: the Rust checks of product spec 13: `cargo fmt --check`, clippy with
  `clippy::pedantic` as errors (host and SDK on the build machine's target; SDK and widgets on
  `wasm32-unknown-unknown`), `cargo deny check`, the widget build and `cargo nextest run`.

## Tools

The toolchain `rust-toolchain.toml` pins (rustup installs it, with the `wasm32-unknown-unknown`
target, on first use), `cargo-nextest` and `cargo-deny`, at the versions CI pins:

```
cargo install --locked --version 0.9.152 cargo-nextest
cargo install --locked --version 0.22.0 cargo-deny
```

## Running

```
sdk/rust/check.sh                      # everything CI runs for Rust
sdk/rust/build-widgets.sh              # just the modules
cargo nextest run -p panelator-test-host
```

To regenerate golden frames (only when a spec changes what a frame shows) see
`sdk/conformance/README.md`; CI never sets `PANELATOR_BLESS`.
