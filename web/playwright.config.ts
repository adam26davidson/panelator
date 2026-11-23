import { createServer } from "node:net";
import { defineConfig } from "@playwright/test";

// A free port, found once when the run starts. Playwright loads this file again in every worker, so the port is
// handed on in the environment: a worker finds it set and computes the same baseURL as the server's.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

process.env.PANELATOR_WEB_E2E_PORT ??= String(await freePort());
const port = process.env.PANELATOR_WEB_E2E_PORT;

// The three viewports of spec 029 AC-5; one Chromium (the one @playwright/browser-chromium installed) for all of them.
const viewports = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
};

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: "chromium" },
  projects: Object.entries(viewports).map(([name, viewport]) => ({ name, use: { viewport } })),
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
