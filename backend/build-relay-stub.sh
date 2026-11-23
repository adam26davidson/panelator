#!/usr/bin/env bash
# Builds the relay stub (spec 111) in release mode and prints its path on stdout.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
cargo build --release --locked -p panelator-relay --bin panelator-relay-stub --target-dir "$here/target" >&2
bin="$here/target/release/panelator-relay-stub"
[ -f "$bin" ] || { echo "missing $bin" >&2; exit 1; }
echo "$bin"
