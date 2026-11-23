#!/usr/bin/env bash
# The Rust checks of product spec 13 for the backend workspace (spec 111). Fails when any step fails.
# Needs the toolchain of ../rust-toolchain.toml, cargo-nextest and cargo-deny.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n== %s\n' "$*"; }

step "cargo fmt --all --check"
cargo fmt --all --check

step "cargo clippy --workspace --all-targets (pedantic as errors)"
cargo clippy --workspace --all-targets --locked -- -D warnings -D clippy::pedantic

step "cargo deny check (the repository's deny.toml)"
cargo deny --manifest-path Cargo.toml --locked --config ../deny.toml check

step "cargo nextest run --workspace"
cargo nextest run --workspace --locked

step "release build of the relay stub"
./build-relay-stub.sh
