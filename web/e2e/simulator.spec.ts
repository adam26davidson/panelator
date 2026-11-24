import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const root = join(import.meta.dirname, "..", "..");
const scene = JSON.parse(readFileSync(join(root, "sdk", "conformance", "scenes", "spike.json"), "utf8")) as {
  panel: { width: number; height: number };
};
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const tickOf = async (page: Page) =>
  Number(await page.getByText("Tick", { exact: true }).locator("xpath=following-sibling::span").textContent());
const canvasLit = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
    for (let i = 0; i < data.length; i += 4)
      if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 0) return true;
    return false;
  });

test("/simulator reaches running: the panel of the scene, ticks advancing, pixels drawn, no errors, no sideways scroll", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  await page.goto("/simulator");
  await expect(page.getByRole("status")).toHaveText("Running", { timeout: 15_000 });
  const canvas = page.getByRole("img");
  await expect(canvas).toHaveJSProperty("width", scene.panel.width);
  await expect(canvas).toHaveJSProperty("height", scene.panel.height);
  await expect.poll(() => tickOf(page), { timeout: 5000 }).toBeGreaterThan(120);
  expect(await canvasLit(page)).toBe(true);
  const { scrollWidth, innerWidth, css } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    css: (document.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect().width,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  expect(css % scene.panel.width).toBe(0);
  expect(css).toBeGreaterThanOrEqual(scene.panel.width);
  expect(problems).toEqual([]);
});

test("the page received exactly the three modules, byte for byte", async ({ page }) => {
  const received: string[] = [];
  page.on("response", async (r) => {
    if (r.url().endsWith(".wasm"))
      received.push(
        createHash("sha256")
          .update(await r.body())
          .digest("hex"),
      );
  });
  await page.goto("/simulator");
  await expect(page.getByRole("status")).toHaveText("Running", { timeout: 15_000 });
  const want = ["spike-clock", "spike-scroll", "spike-image"].map((m) =>
    sha(join(root, "target", "widgets", `${m}.wasm`)),
  );
  expect(received.sort()).toEqual(want.sort());
});

test("the pause control stops the tick and resumes it", async ({ page }) => {
  await page.goto("/simulator");
  await expect(page.getByRole("status")).toHaveText("Running", { timeout: 15_000 });
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("status")).toHaveText("Paused");
  const at = await tickOf(page);
  await page.waitForTimeout(400);
  expect(await tickOf(page)).toBe(at);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("status")).toHaveText("Running");
  await expect.poll(() => tickOf(page)).toBeGreaterThan(at + 5);
});

test("with reduced motion the page starts paused at tick 0 with the frame shown", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/simulator");
  await expect(page.getByRole("status")).toHaveText("Paused", { timeout: 15_000 });
  expect(await tickOf(page)).toBe(0);
  await expect(page.getByText(/asks for reduced motion/)).toBeVisible();
  expect(await canvasLit(page)).toBe(true);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("status")).toHaveText("Running");
  await expect(page.getByText(/asks for reduced motion/)).toHaveCount(0);
});

test("a module request answered with an error shows failed, and the control leads back to running", async ({
  page,
}) => {
  await page.route("**/spike-clock.wasm", (route) => route.fulfill({ status: 500, body: "no" }));
  await page.goto("/simulator");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("spike-clock.wasm: could not be fetched (500)");
  await page.unroute("**/spike-clock.wasm");
  await page.getByRole("button", { name: "Load the simulator again" }).click();
  await expect(page.getByRole("status")).toHaveText("Running", { timeout: 15_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
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

test("every link and button of the simulator page is at least 44 CSS pixels, running and failed", async ({ page }) => {
  const check = async () => {
    const targets = page.getByRole("link").or(page.getByRole("button"));
    const count = await targets.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      const box = await targets.nth(i).boundingBox();
      expect(box?.width, `target ${i} width`).toBeGreaterThanOrEqual(44);
      expect(box?.height, `target ${i} height`).toBeGreaterThanOrEqual(44);
    }
  };
  await page.goto("/simulator");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 15_000 });
  await check();
  await page.route("**/spike-clock.wasm", (route) => route.fulfill({ status: 500, body: "no" }));
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByRole("button", { name: "Resume" }).click();
  await page.reload();
  await expect(page.getByRole("alert")).toBeVisible();
  await check();
});
