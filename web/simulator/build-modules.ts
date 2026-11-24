import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Builds the three spike modules the engine's tests and the app need (spec 115 AC-2). The script is incremental.
const root = join(import.meta.dirname, "..", "..");
const r = spawnSync(join(root, "sdk", "rust", "build-widgets.sh"), { cwd: root, encoding: "utf8" });
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
if (r.status !== 0) {
  console.error(
    "The spike modules could not be built. This needs the Rust toolchain that rust-toolchain.toml pins, with its wasm32-unknown-unknown target (rustup toolchain install).",
  );
  process.exit(r.status ?? 1);
}
