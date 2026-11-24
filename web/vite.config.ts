import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = join(import.meta.dirname, "..");
// Where the simulator's inputs live and the address each is served at, in dev, in the build output and in Storybook
// (spec 115 AC-2): the modules are written by sdk/rust/build-widgets.sh, the rest is the conformance suite; none is copied
// into web/ and every file is served as it was written.
const SOURCES = [
  {
    dir: join(root, "target", "widgets"),
    prefix: "widgets",
    files: ["spike-clock.wasm", "spike-scroll.wasm", "spike-image.wasm"],
    type: "application/wasm",
  },
  {
    dir: join(root, "sdk", "conformance", "fonts"),
    prefix: "fonts",
    files: ["spleen-5x8.bdf", "spleen-8x16.bdf", "LICENSE-spleen"],
    type: "text/plain",
  },
  {
    dir: join(root, "sdk", "conformance", "assets"),
    prefix: "assets",
    files: ["spike-image.rgb"],
    type: "application/octet-stream",
  },
];
const BASE = "simulator-files";

function simulatorFiles(): Plugin {
  const find = (url: string) => {
    for (const s of SOURCES) {
      for (const f of s.files) if (url === `/${BASE}/${s.prefix}/${f}`) return { path: join(s.dir, f), type: s.type };
    }
    return undefined;
  };
  return {
    name: "panelator-simulator-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const hit = find((req.url ?? "").split("?")[0] ?? "");
        if (!hit) return next();
        if (!existsSync(hit.path)) {
          res.statusCode = 404;
          res.end(
            `${hit.path} is missing: build it with sdk/rust/build-widgets.sh (the toolchain of rust-toolchain.toml)`,
          );
          return;
        }
        res.setHeader("content-type", hit.type);
        res.end(readFileSync(hit.path));
      });
    },
    generateBundle() {
      for (const s of SOURCES) {
        for (const f of s.files) {
          const path = join(s.dir, f);
          if (!existsSync(path))
            this.error(
              `${path} is missing: build it with sdk/rust/build-widgets.sh (the toolchain of rust-toolchain.toml)`,
            );
          this.emitFile({ type: "asset", fileName: `${BASE}/${s.prefix}/${f}`, source: readFileSync(path) });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), simulatorFiles()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist" },
});
