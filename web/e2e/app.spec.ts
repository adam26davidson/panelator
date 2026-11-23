import { expect, test } from "@playwright/test";

test("Home loads at / with its banner and heading, fits the width and logs no error", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  await page.goto("/");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  expect(problems).toEqual([]);
});

test("an unknown address loaded directly shows the not-found page, whose link leads home", async ({ page }) => {
  await page.goto("/no/such/place");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "Go to the home page" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "An LED dashboard you configure yourself" })).toBeVisible();
});

test("every link and button is at least 44 CSS pixels in both dimensions, mobile included", async ({ page }) => {
  for (const address of ["/", "/no/such/place"]) {
    await page.goto(address);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const targets = page.getByRole("link").or(page.getByRole("button"));
    const count = await targets.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await targets.nth(i).boundingBox();
      expect(box?.width, `${address} target ${i} width`).toBeGreaterThanOrEqual(44);
      expect(box?.height, `${address} target ${i} height`).toBeGreaterThanOrEqual(44);
    }
  }
});
