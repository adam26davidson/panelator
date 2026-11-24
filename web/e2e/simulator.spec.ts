import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const repo = join(import.meta.dirname, "..", "..");
const widgets = join(repo, "target", "widgets");
const scene = JSON.parse(readFileSync(join(repo, "sdk", "conformance", "scenes", "spike.json"), "utf8")) as {
  panel: { width: number; height: number };
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const tick = (page: Page) => page.locator("p", { hasText: /^Tick/ }).locator(".font-mono");
const readTick = async (page: Page) => Number(await tick(page).textContent());

test("/simulator reaches running: the panel's canvas, ticks, pixels, no errors, no sideways scroll", async ({
  page,
}) => {
  const problems: string[] = [];
  const wasm: { url: string; sha: string }[] = [];
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("response", async (r) => {
    if (r.url().endsWith(".wasm")) wasm.push({ url: r.url(), sha: sha256(await r.body()) });
  });
  await page.goto("/simulator");
  await expect(page).toHaveTitle("Simulator · panelator");
  await expect(page.getByRole("heading", { level: 1, name: "Simulator" })).toBeVisible();
  const canvas = page.getByRole("img", { name: /^LED panel/ });
  expect(await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([
    scene.panel.width,
    scene.panel.height,
  ]);
  await expect(page.getByRole("status")).toHaveText("Running");
  await expect.poll(() => readTick(page), { timeout: 5000 }).toBeGreaterThan(120);
  const lit = await canvas.evaluate((c: HTMLCanvasElement) => {
    const data = (c.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
    return data.some((v, i) => i % 4 !== 3 && v !== 0);
  });
  expect(lit).toBe(true);
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  const cssWidth = await canvas.evaluate((c) => c.getBoundingClientRect().width);
  expect(cssWidth % scene.panel.width).toBe(0);
  expect(cssWidth).toBeGreaterThanOrEqual(scene.panel.width);
  expect(problems).toEqual([]);
  // the three modules, as the build wrote them
  const want = ["spike-clock", "spike-scroll", "spike-image"].map((n) =>
    sha256(readFileSync(join(widgets, `${n}.wasm`))),
  );
  expect(wasm.map((w) => w.sha).sort()).toEqual(want.sort());
});

test("the pause control stops the tick and resumes it", async ({ page }) => {
  await page.goto("/simulator");
  await expect.poll(() => readTick(page)).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("status")).toHaveText("Paused");
  const stopped = await readTick(page);
  await page.waitForTimeout(400);
  expect(await readTick(page)).toBe(stopped);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("status")).toHaveText("Running");
  await expect.poll(() => readTick(page)).toBeGreaterThan(stopped + 5);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("the page starts paused at tick 0 and Resume starts the panel", async ({ page }) => {
    await page.goto("/simulator");
    await expect(page.getByRole("status")).toHaveText("Paused");
    await expect(page.getByText("Paused because your system asks for reduced motion.")).toBeVisible();
    expect(await readTick(page)).toBe(0);
    await page.waitForTimeout(300);
    expect(await readTick(page)).toBe(0);
    await page.getByRole("button", { name: "Resume" }).click();
    await expect.poll(() => readTick(page)).toBeGreaterThan(3);
  });
});

test("a module request answered with an error shows failed, and its control leads back to running", async ({
  page,
}) => {
  await page.route("**/sim/modules/spike-clock.wasm", (route) => route.fulfill({ status: 500, body: "no" }));
  await page.goto("/simulator");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The simulator stopped");
  await expect(alert).toContainText("spike-clock.wasm: could not be fetched (500)");
  await page.unroute("**/sim/modules/spike-clock.wasm");
  const again = page.getByRole("button", { name: "Load the simulator again" });
  const box = await again.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await again.click();
  await expect(page.getByRole("status")).toHaveText("Running");
  await expect.poll(() => readTick(page)).toBeGreaterThan(1);
});

test("Home's link leads to /simulator without a page load", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    (window as unknown as { marker: number }).marker = 1;
  });
  await page.getByRole("link", { name: "Open the simulator" }).click();
  await expect(page).toHaveURL(/\/simulator$/);
  await expect(page.getByRole("heading", { level: 1, name: "Simulator" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
});

test("every link and button of /simulator is at least 44 CSS pixels in both dimensions", async ({ page }) => {
  await page.goto("/simulator");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  const targets = page.getByRole("link").or(page.getByRole("button"));
  const count = await targets.count();
  expect(count).toBeGreaterThan(1);
  for (let i = 0; i < count; i++) {
    const box = await targets.nth(i).boundingBox();
    expect(box?.width, `target ${i} width`).toBeGreaterThanOrEqual(44);
    expect(box?.height, `target ${i} height`).toBeGreaterThanOrEqual(44);
  }
});
