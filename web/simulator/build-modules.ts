// Builds the three spike modules with sdk/rust/build-widgets.sh (incremental), from the repository root. The modules are
// never copied or transformed; a missing toolchain fails here with a message naming rust-toolchain.toml (spec 115 AC-2).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const hint =
  "The widget modules are built with the toolchain pinned in rust-toolchain.toml, with its wasm32-unknown-unknown target " +
  "(run `rustup toolchain install` in the repository root).";

const probe = spawnSync("cargo", ["--version"], { cwd: root, encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.error(`cargo is not available or the toolchain is missing. ${hint}\n${probe.stderr ?? ""}`);
  process.exit(1);
}
const r = spawnSync("bash", ["sdk/rust/build-widgets.sh"], { cwd: root, encoding: "utf8" });
if (r.status !== 0) {
  process.stderr.write(`${r.stdout}${r.stderr}`);
  console.error(`sdk/rust/build-widgets.sh failed. ${hint}`);
  process.exit(1);
}
