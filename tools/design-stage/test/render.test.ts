import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readPngText } from "../src/png-text.ts";
import { render } from "../src/render.ts";
import { VIEWPORTS } from "../src/viewports.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "specs", "900-fixture");
const temp = mkdtempSync(join(tmpdir(), "panelator-design-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function copyFixture(name: string): string {
  const dir = join(temp, name);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe("design-stage render", () => {
  it("renders the fixture at three viewports with a signed PNG each", { timeout: 300_000 }, async () => {
    const dir = copyFixture("ok");
    const result = await render({ specDir: dir });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("sample");
    expect(result[0].stories.length).toBe(2);
    expect(result[0].renders).toHaveLength(6);
    const files = [
      "sample.png", "sample.mobile.png", "sample.tablet.png",
      "sample--empty.png", "sample--empty.mobile.png", "sample--empty.tablet.png",
    ];
    for (const f of files) expect(existsSync(join(dir, "design", f)), f).toBe(true);
    for (const vp of VIEWPORTS) {
      const png = readFileSync(join(dir, "design", `sample${vp.suffix}.png`));
      expect(png.readUInt32BE(16)).toBe(vp.width * 2);
      expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(vp.height * 2);
      const chunk = JSON.parse(readPngText(png).get("panelator-render") ?? "null");
      expect(chunk.viewport).toBe(vp.name);
      expect(chunk.story).toBe("sample--default");
      expect(typeof chunk.commit).toBe("string");
    }
  });

  it("fails naming a screen that has no story", { timeout: 300_000 }, async () => {
    const dir = copyFixture("missing");
    rmSync(join(dir, "design", "sample.stories.tsx"));
    await expect(render({ specDir: dir })).rejects.toThrow(/screen sample has no story/);
  });
});
