import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { pngSize, readTextChunks } from "../src/png-text.ts";
import { render } from "../src/render.ts";
import { DEVICE_SCALE, VIEWPORTS } from "../src/viewports.ts";

const here = dirname(fileURLToPath(import.meta.url));
let copy: string | undefined;

// Inside the package so the stories resolve react from its node_modules.
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(here, ".tmp-"));
  copy = root;
  await cp(join(here, "fixtures", "specs", "900-fixture"), join(root, "900-fixture"), { recursive: true });
  return join(root, "900-fixture");
}

afterAll(async () => {
  if (copy) await rm(copy, { recursive: true, force: true });
});

describe("render (spec 029 AC-5, AC-6)", () => {
  it("renders the named screen and its state at three viewports, each PNG signed", async () => {
    const dir = await fixture();
    const done = await render(dir, { commit: "test" });
    const names = [
      "sample.png",
      "sample.mobile.png",
      "sample.tablet.png",
      "sample--empty.png",
      "sample--empty.mobile.png",
      "sample--empty.tablet.png",
    ];
    expect(done.map((r) => r.file.slice(dir.length + "/design/".length)).sort()).toEqual([...names].sort());
    for (const name of names) {
      const png = await readFile(join(dir, "design", name));
      const viewport = name.includes(".mobile.") ? "mobile" : name.includes(".tablet.") ? "tablet" : "desktop";
      const story = name.startsWith("sample--empty") ? "fixture-sample--empty" : "fixture-sample--default";
      expect(readTextChunks(png)["panelator-render"]).toBe(`viewport=${viewport};story=${story};commit=test`);
      expect(pngSize(png).width).toBe(VIEWPORTS.find((v) => v.name === viewport)?.width * DEVICE_SCALE);
    }
  }, 240_000);

  it("rejects a named screen with no story, naming it", async () => {
    const dir = await fixture();
    const spec = await readFile(join(dir, "spec.md"), "utf8");
    await writeFile(join(dir, "spec.md"), spec.replace("Screens: sample", "Screens: sample, missing"));
    await expect(render(dir, { commit: "test" })).rejects.toThrow(/missing/);
  }, 240_000);
});
