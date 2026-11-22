import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshot } from "./fixtures.ts";

// The built app in a real browser at the design's three viewports (390x844, 820x1180, 1440x900), with the API faked.
const dist = join(import.meta.dirname, "..", "dist");
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
const ROUTES = ["/", "/questions", "/history", "/actions", "/agents", "/parameters"];

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  await build({ root: join(import.meta.dirname, ".."), logLevel: "silent" });
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

async function open(width: number, height: number, route: string) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route("http://console.test/**", async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === "/state") {
      return r.fulfill({ json: { login: "maintainer", snapshot, received_at: snapshot.generated_at, age_s: 18 } });
    }
    const file = join(dist, url.pathname);
    if (url.pathname.startsWith("/assets/") && existsSync(file)) {
      return r.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
    }
    return r.fulfill({ body: readFileSync(join(dist, "index.html")), contentType: "text/html" });
  });
  await page.goto(`http://console.test${route}`);
  await page.waitForSelector("h1");
  await page.waitForSelector(".c-fresh:not(.loading)");
  return page;
}

describe.each(VIEWPORTS)("$name ($width px)", ({ width, height }) => {
  it("shows the tab bar below 720px and the rail from it, with no sideways scroll", async () => {
    for (const route of ROUTES) {
      const page = await open(width, height, route);
      const visible = (sel: string) => page.locator(sel).first().isVisible();
      expect(await visible(".c-tabs"), `${route} tabs`).toBe(width < 720);
      expect(await visible(".c-rail"), `${route} rail`).toBe(width >= 720);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${route} overflow`,
      ).toBe(true);
      await page.close();
    }
  }, 60_000);

  it("lays tables out as tables only from 1200px, blocks below", async () => {
    for (const route of ["/actions", "/agents", "/parameters"]) {
      const page = await open(width, height, route);
      expect(await page.locator(".c-thead").first().isVisible(), route).toBe(width >= 1200);
      await page.close();
    }
  }, 60_000);

  it("keeps text at 14px or more and, on mobile, tap targets at 44px or more", async () => {
    for (const route of ROUTES) {
      const page = await open(width, height, route);
      const small = await page.evaluate(() => {
        const bad: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("body *")) {
          if (el.closest("svg") || !el.offsetParent) continue;
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
          if (own && Number.parseFloat(getComputedStyle(el).fontSize) < 14) bad.push(`${el.tagName}.${el.className}`);
        }
        return bad;
      });
      expect(small, `${route} small text`).toEqual([]);
      if (width < 720) {
        const targets = await page.evaluate(() => {
          const bad: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>("a, button, input")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.height < 44 || r.width < 44)
              bad.push(`${el.tagName}.${el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
          return bad;
        });
        expect(targets, `${route} tap targets`).toEqual([]);
      }
      await page.close();
    }
  }, 60_000);
});
