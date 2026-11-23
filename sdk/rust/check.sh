#!/usr/bin/env bash
# The Rust checks of product spec 13. Fails when any step fails.
# Needs the toolchain of rust-toolchain.toml (with wasm32-unknown-unknown), cargo-nextest and cargo-deny.
set -euo pipefail
cd "$(dirname "$0")/../.."

step() { printf '\n== %s\n' "$*"; }
PEDANTIC=(-D warnings -D clippy::pedantic)
HOST=x86_64-unknown-linux-gnu
if command -v rustc >/dev/null; then HOST=$(rustc -vV | sed -n 's/^host: //p'); fi

step "cargo fmt --all --check"
cargo fmt --all --check

step "clippy, host and SDK, build machine target ($HOST), all targets"
cargo clippy -p panelator-test-host -p panelator-widget --all-targets --target "$HOST" -- "${PEDANTIC[@]}"

step "clippy, SDK and widgets, wasm32-unknown-unknown"
cargo clippy -p panelator-widget -p spike-clock -p spike-scroll -p spike-image --target wasm32-unknown-unknown -- "${PEDANTIC[@]}"

step "cargo deny check"
cargo deny check

step "build the spike widgets"
sdk/rust/build-widgets.sh

step "cargo nextest run (workspace)"
cargo nextest run --workspace
