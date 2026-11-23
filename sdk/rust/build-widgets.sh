#!/usr/bin/env bash
# Builds the three spike widgets for wasm32-unknown-unknown in release mode and copies them to
# target/widgets/. The toolchain and target come from rust-toolchain.toml; the stack and memory
# limits from .cargo/config.toml. Modules are not committed: the golden frames are the contract.
set -euo pipefail
cd "$(dirname "$0")/../.."
cargo build --release --target wasm32-unknown-unknown -p spike-clock -p spike-scroll -p spike-image
mkdir -p target/widgets
for w in clock scroll image; do
  cp "target/wasm32-unknown-unknown/release/spike_$w.wasm" "target/widgets/spike-$w.wasm"
  size=$(stat -c %s "target/widgets/spike-$w.wasm")
  echo "target/widgets/spike-$w.wasm: $size bytes"
  if [ "$size" -gt 65536 ]; then echo "spike-$w.wasm is over 64 KiB" >&2; exit 1; fi
done
