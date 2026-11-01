import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { writePngText } from "./png-text.ts";
import { VIEWPORTS, type Viewport } from "./viewports.ts";

const run = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export interface RenderedScreen {
  name: string;
  stories: string[];
  renders: string[];
}

export interface RenderOptions {
  specDir: string;
  screen?: string;
  /** Where the PNGs go; default is the spec's design/ directory. */
  outDir?: string;
}

interface IndexEntry {
  id: string;
  type: string;
  importPath: string;
  name: string;
}

export function namedScreens(specText: string): string[] {
  const m = /^Screens:\s*(.+)$/m.exec(specText);
  return (m?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function commit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: pkgDir, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png",
};

function serve(root: string): Promise<{ server: Server; port: number }> {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
      try {
        if (!file.startsWith(root)) throw new Error("outside");
        const body = readFileSync(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => ok({ server, port: (server.address() as { port: number }).port }));
  });
}

async function buildStorybook(designDir: string, outDir: string): Promise<void> {
  const bin = join(dirname(require.resolve("storybook/package.json")), "dist", "bin", "dispatcher.js");
  try {
    await run(process.execPath, [bin, "build", "--config-dir", join(pkgDir, ".storybook"), "--output-dir", outDir, "--disable-telemetry"], {
      cwd: pkgDir,
      env: { ...process.env, PANELATOR_DESIGN_DIR: designDir, STORYBOOK_DISABLE_TELEMETRY: "1" },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`storybook build failed: ${(err.stderr || err.message).slice(-2000)}`);
  }
}

/** Renders every named screen of the spec's design/ at each viewport; throws naming the screen or story that failed. */
export async function render(opts: RenderOptions): Promise<RenderedScreen[]> {
  const specDir = resolve(opts.specDir);
  const designDir = join(specDir, "design");
  const outDir = opts.outDir ? resolve(opts.outDir) : designDir;
  const screens = namedScreens(readFileSync(join(specDir, "spec.md"), "utf8"));
  if (screens.length === 0) throw new Error(`${join(specDir, "spec.md")} has no Screens: line`);
  const wanted = opts.screen ? [opts.screen] : screens;
  if (opts.screen && !screens.includes(opts.screen)) throw new Error(`screen ${opts.screen} is not named in the spec`);

  const stories = readdirSync(designDir).filter((f) => f.endsWith(".stories.tsx"));
  for (const s of wanted) if (!stories.includes(`${s}.stories.tsx`)) throw new Error(`screen ${s} has no story (${s}.stories.tsx)`);

  const build = mkdtempSync(join(tmpdir(), "panelator-storybook-"));
  let server: Server | undefined;
  try {
    await buildStorybook(designDir, build);
    const index = JSON.parse(readFileSync(join(build, "index.json"), "utf8")) as { entries: Record<string, IndexEntry> };
    const byScreen = new Map<string, IndexEntry[]>();
    for (const e of Object.values(index.entries)) {
      if (e.type !== "story") continue;
      const screen = basename(e.importPath).replace(/\.stories\.tsx$/, "");
      byScreen.set(screen, [...(byScreen.get(screen) ?? []), e]);
    }
    for (const s of wanted) if (!byScreen.has(s)) throw new Error(`screen ${s} has no story (${s}.stories.tsx)`);

    const started = await serve(build);
    server = started.server;
    const browser = await chromium.launch();
    const sha = commit();
    const results: RenderedScreen[] = [];
    try {
      for (const screen of wanted) {
        const entries = byScreen.get(screen) ?? [];
        const def = entries.find((e) => e.name === "Default") ?? entries[0];
        const result: RenderedScreen = { name: screen, stories: entries.map((e) => e.id), renders: [] };
        for (const entry of entries) {
          const state = entry === def ? null : entry.id.split("--").slice(1).join("--");
          const stem = state === null ? screen : `${screen}--${state}`;
          for (const vp of VIEWPORTS) {
            const file = join(outDir, `${stem}${vp.suffix}.png`);
            writeFileSync(file, await shoot(browser, started.port, entry.id, vp, sha));
            result.renders.push(file);
          }
        }
        results.push(result);
      }
    } finally {
      await browser.close();
    }
    return results;
  } finally {
    server?.close();
    rmSync(build, { recursive: true, force: true });
  }
}

async function shoot(browser: Awaited<ReturnType<typeof chromium.launch>>, port: number, id: string, vp: Viewport, sha: string): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    const overlay = await page.evaluate(() => document.body.classList.contains("sb-show-errordisplay"));
    if (overlay || errors.length) {
      const detail = errors[0] ?? (await page.locator("#error-message").innerText().catch(() => "story error"));
      throw new Error(`story ${id} threw: ${detail}`);
    }
    const png = await page.screenshot({ fullPage: true, type: "png" });
    return writePngText(png, "panelator-render", JSON.stringify({ viewport: vp.name, story: id, commit: sha }));
  } finally {
    await context.close();
  }
}
