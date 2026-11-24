import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The simulator's inputs (spec 115 AC-2), served at /sim/ in dev and emitted into the build exactly as they are on disk:
// the modules `sdk/rust/build-widgets.sh` wrote, and the suite's fonts and asset (the scene is in the bundle). Nothing is copied under web/.
const repo = fileURLToPath(new URL("..", import.meta.url));
const SIMULATOR_FILES: Record<string, string> = {
  "sim/modules/spike-clock.wasm": "target/widgets/spike-clock.wasm",
  "sim/modules/spike-scroll.wasm": "target/widgets/spike-scroll.wasm",
  "sim/modules/spike-image.wasm": "target/widgets/spike-image.wasm",
  "sim/fonts/spleen-5x8.bdf": "sdk/conformance/fonts/spleen-5x8.bdf",
  "sim/fonts/spleen-8x16.bdf": "sdk/conformance/fonts/spleen-8x16.bdf",
  "sim/fonts/LICENSE-spleen": "sdk/conformance/fonts/LICENSE-spleen",
  "sim/assets/spike-image.rgb": "sdk/conformance/assets/spike-image.rgb",
};

function simulatorInputs(): Plugin {
  const read = (name: string): Buffer => {
    const path = join(repo, SIMULATOR_FILES[name] as string);
    if (!existsSync(path))
      throw new Error(
        `${path} is missing: run sdk/rust/build-widgets.sh (it needs the toolchain of rust-toolchain.toml)`,
      );
    return readFileSync(path);
  };
  return {
    name: "panelator-simulator-inputs",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? "").split("?")[0]?.slice(1) ?? "";
        if (!Object.hasOwn(SIMULATOR_FILES, name)) return next();
        try {
          res.setHeader("content-type", name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
          res.end(read(name));
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error));
        }
      });
    },
    generateBundle() {
      for (const name of Object.keys(SIMULATOR_FILES))
        this.emitFile({ type: "asset", fileName: name, source: read(name) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), simulatorInputs()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist" },
});
