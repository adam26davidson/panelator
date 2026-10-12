import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAppClient } from "../src/github/auth.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { readToken } from "../src/state/token.ts";
import { appRoute, mockGitHub, tokenRoute, type Route } from "./helpers/mock-github.ts";

export const testKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
const app = { id: 123, installation_id: 456, private_key_path: "/x", bot_login: "panelator-pipeline[bot]" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createAppClient", () => {
  it("mints an installation token with a JWT and reports the bot login", async () => {
    const gh = mockGitHub([tokenRoute, appRoute]);
    const c = createAppClient(app, testKey, gh.fetch);
    const t = await c.installationToken();
    expect(t).toEqual({ token: "ghs_mock", expires_at: "2099-01-01T00:00:00Z" });
    expect(gh.calls[0]).toMatchObject({ method: "POST", url: "/app/installations/456/access_tokens" });
    expect(await c.botLogin()).toBe("panelator-pipeline[bot]");
  });

  // Real timers throughout: octokit queues requests on Bottleneck's real setTimeout, and @octokit/auth-app
  // merges concurrent in-flight token requests, so fake-clock tick counting is not deterministic.
  it("writes token.json, refreshes on the interval, and stop() ends the refresh (review focus 5)", async () => {
    const gh = mockGitHub([tokenRoute, appRoute]);
    const c = createAppClient(app, testKey, gh.fetch);
    const p = statePaths(mkdtempSync(join(tmpdir(), "auth-")));
    await ensureStateDirs(p);
    await c.refreshTokenFile(p);
    expect((await readToken(p))?.token).toBe("ghs_mock");
    const count = () => gh.calls.filter((x) => x.url.endsWith("/access_tokens")).length;
    const before = count();
    const stop = c.startTokenRefresh(p, 30, 10);
    await vi.waitFor(() => expect(count() - before).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    stop();
    await sleep(100); // let a tick that fired just before stop() reach the mock
    const atStop = count();
    await sleep(150); // five intervals: a live timer would mint again
    expect(count()).toBe(atStop);
  });

  it("retries a failed refresh before the next interval tick", async () => {
    let failNext = false;
    const flakyTokenRoute: Route = {
      ...tokenRoute,
      reply: (m, body, url) => {
        if (!failNext) return tokenRoute.reply(m, body, url);
        failNext = false;
        // 401 is not retried by octokit's own retry plugin, so the tick fails exactly once.
        return { status: 401, body: { message: "boom" } };
      },
    };
    const gh = mockGitHub([flakyTokenRoute, appRoute]);
    const c = createAppClient(app, testKey, gh.fetch);
    const p = statePaths(mkdtempSync(join(tmpdir(), "auth-")));
    await ensureStateDirs(p);
    await c.refreshTokenFile(p);
    const count = () => gh.calls.filter((x) => x.url.endsWith("/access_tokens")).length;
    const before = count();
    rmSync(p.token); // only the retry can recreate it
    failNext = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // First tick at 2 s fails; its retry 10 ms later succeeds. The 3.5 s wait ends before the 4 s tick,
      // so only the retry (not the next interval tick) can produce the second mint.
      const stop = c.startTokenRefresh(p, 2000, 10);
      await vi.waitFor(() => expect(count() - before).toBe(2), { timeout: 3500 });
      stop();
      await vi.waitFor(async () => expect((await readToken(p))?.token).toBe("ghs_mock"));
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toMatch(/^token refresh failed \(attempt 1\/3\): /);
    } finally {
      err.mockRestore();
    }
  });
});
