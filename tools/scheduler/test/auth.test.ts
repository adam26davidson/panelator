import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAppClient } from "../src/github/auth.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { readToken } from "../src/state/token.ts";
import { appRoute, mockGitHub, tokenRoute } from "./helpers/mock-github.ts";

export const testKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
const app = { id: 123, installation_id: 456, private_key_path: "/x", bot_login: "panelator-pipeline[bot]" };

describe("createAppClient", () => {
  it("mints an installation token with a JWT and reports the bot login", async () => {
    const gh = mockGitHub([tokenRoute, appRoute]);
    const c = createAppClient(app, testKey, gh.fetch);
    const t = await c.installationToken();
    expect(t).toEqual({ token: "ghs_mock", expires_at: "2099-01-01T00:00:00Z" });
    expect(gh.calls[0]).toMatchObject({ method: "POST", url: "/app/installations/456/access_tokens" });
    expect(await c.botLogin()).toBe("panelator-pipeline[bot]");
  });
  it("writes token.json and refreshes on the interval (review focus 5)", async () => {
    // Fake only the interval: octokit's throttling/retry plugins schedule every request through
    // Bottleneck's global setTimeout, so faking setTimeout would park the requests forever.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const gh = mockGitHub([tokenRoute, appRoute]);
      const c = createAppClient(app, testKey, gh.fetch);
      const p = statePaths(mkdtempSync(join(tmpdir(), "auth-")));
      await ensureStateDirs(p);
      await c.refreshTokenFile(p);
      expect((await readToken(p))?.token).toBe("ghs_mock");
      const after = () => gh.calls.filter((x) => x.url.endsWith("/access_tokens")).length;
      const before = after();
      const stop = c.startTokenRefresh(p, 1000);
      // One tick at a time: @octokit/auth-app merges concurrent in-flight token requests, so two ticks
      // fired before the first request settles would produce a single POST.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(after() - before).toBe(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(after() - before).toBe(2));
      await vi.advanceTimersByTimeAsync(500);
      stop();
      await vi.waitFor(() => expect(after() - before).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
