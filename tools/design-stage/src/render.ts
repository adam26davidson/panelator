import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { addTextChunk } from "./png-text.ts";
import { DEVICE_SCALE, renderFileName, VIEWPORTS } from "./viewports.ts";

const run = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface RenderedScreen {
  screen: string;
  story: string;
  file: string;
}

interface IndexEntry {
  id: string;
  name: string;
  type?: string;
  importPath: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

/** The `Screens:` line of a UI spec's design section. */
function namedScreens(specText: string): string[] {
  const line = specText.match(/^Screens:\s*(.+)$/m);
  return line
    ? line[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

async function serve(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = join(root, decodeURIComponent((req.url ?? "/").split("?")[0]));
    if (!path.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    stat(path).then(
      (s) => {
        res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "content-length": s.size });
        createReadStream(path).pipe(res);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => server.close(() => ok())) };
}

async function commitOf(dir: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: dir }).catch(() => ({ stdout: "unknown" }));
  return stdout.trim();
}

/**
 * Spec 029 AC-5: builds the Storybook of `<specDir>/design/`, opens each named screen's stories at each viewport and writes
 * the signed PNGs beside the stories. A story that throws, or a named screen with no story, rejects naming it.
 */
export async function render(specDir: string, opts: { screen?: string; outDir?: string; commit?: string } = {}): Promise<RenderedScreen[]> {
  const spec = resolve(specDir);
  const designDir = join(spec, "design");
  const screens = namedScreens(await readFile(join(spec, "spec.md"), "utf8"));
  const selected = opts.screen ? screens.filter((s) => s === opts.screen) : screens;
  if (opts.screen && !selected.length) throw new Error(`screen ${opts.screen} is not named on the spec's Screens: line`);
  const commit = opts.commit ?? (await commitOf(spec));
  const outDir = resolve(opts.outDir ?? designDir);

  const built = await mkdtemp(join(tmpdir(), "design-stage-"));
  try {
    try {
      await run(
        join(packageDir, "node_modules", ".bin", "storybook"),
        ["build", "-c", ".storybook", "-o", built, "--quiet", "--disable-telemetry"],
        {
          cwd: packageDir,
          env: { ...process.env, DESIGN_STAGE_SPEC_DIR: spec },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message: string };
      throw new Error(`storybook build failed:\n${err.stderr || err.stdout || err.message}`);
    }
    const index = JSON.parse(await readFile(join(built, "index.json"), "utf8")) as { entries: Record<string, IndexEntry> };
    const stories = Object.values(index.entries).filter((e) => e.type !== "docs");

    const jobs: { screen: string; entry: IndexEntry; state?: string }[] = [];
    for (const screen of selected) {
      const own = stories.filter((e) => basename(e.importPath) === `${screen}.stories.tsx`);
      if (!own.length) throw new Error(`screen ${screen} has no story: expected design/${screen}.stories.tsx`);
      const main = own.find((e) => e.name === "Default") ?? own[0];
      for (const entry of own) jobs.push({ screen, entry, state: entry === main ? undefined : entry.name });
    }

    const server = await serve(built);
    const browser = await chromium.launch();
    const rendered: RenderedScreen[] = [];
    try {
      await mkdir(outDir, { recursive: true });
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: DEVICE_SCALE,
        });
        for (const job of jobs) {
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(`${server.url}/iframe.html?id=${job.entry.id}&viewMode=story`, { waitUntil: "load" });
          await page.waitForSelector("#storybook-root > *, body.sb-show-errordisplay", { timeout: 30_000 }).catch(() => undefined);
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(
              [...document.images].map((img) =>
                img.complete
                  ? undefined
                  : new Promise((ok) => {
                      img.onload = img.onerror = ok;
                    }),
              ),
            );
          });
          const shown = await page.evaluate(() =>
            document.body.classList.contains("sb-show-errordisplay")
              ? (document.querySelector("#error-message")?.textContent ?? "error")
              : null,
          );
          if (errors.length || shown !== null || (await page.locator("#storybook-root > *").count()) === 0) {
            await page.close();
            throw new Error(
              `story ${job.entry.id} (${job.screen}) failed at ${viewport.name}: ${errors[0] ?? shown ?? "nothing rendered"}`,
            );
          }
          const png = await page.screenshot({ fullPage: true });
          const signed = addTextChunk(png, "panelator-render", `viewport=${viewport.name};story=${job.entry.id};commit=${commit}`);
          const file = join(outDir, renderFileName(job.screen, viewport.name, job.state));
          await writeFile(file, signed);
          rendered.push({ screen: job.screen, story: job.entry.id, file });
          await page.close();
        }
        await context.close();
      }
    } finally {
      await browser.close();
      await server.close();
    }
    return rendered;
  } finally {
    await rm(built, { recursive: true, force: true });
  }
}
