import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { agentsDir, defaultConfigPath, loadConfig, type Config } from "../src/config.ts";
import { loadCatalogue, loadCatalogueFor } from "../src/credentials/catalogue.ts";
import { credCommand, type CredContext } from "../src/credentials/commands.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { runCheck } from "../src/credentials/check.ts";
import { CredentialStore, appPrivateKey } from "../src/credentials/store.ts";
import { createAppClient } from "../src/github/auth.ts";
import { fakeTelegram } from "./helpers/fake-telegram.ts";
import { appRouteFor, mockGitHub } from "./helpers/mock-github.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const fakeCreds = join(here, "helpers", "fake-systemd-creds");
const APP_ID = 4242;

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  return { privateKey, publicKey };
};
const testKey = pair();
const otherKey = pair();

const tmp = () => mkdtempSync(join(tmpdir(), "cred-"));
const entry = (name: string) => loadCatalogueFor(agentsDir).find((e) => e.name === name)!;

function setup() {
  const root = tmp();
  const cfg: Config = { ...loadConfig(defaultConfigPath), credentials: { dir: join(root, "store"), warn_days: 7 } };
  cfg.app = { ...cfg.app, id: APP_ID, private_key_path: join(root, "path.pem") };
  const store = new CredentialStore({ dir: cfg.credentials.dir, systemdCreds: fakeCreds });
  return { root, cfg, store };
}

afterEach(() => {
  delete process.env.FAKE_SYSTEMD_CREDS_FAIL;
});

const filesUnder = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(d, e.name)) : [join(d, e.name)]));

describe("store (spec 069 AC-7)", () => {
  it("keeps no plaintext in the blob or the index, makes the dir 0700 and round-trips", async () => {
    const { cfg, store } = setup();
    const secret = "TOP-SECRET-VALUE-12345";
    await store.writeSecret("github-app-key", secret, "maintainer");
    expect(statSync(cfg.credentials.dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(cfg.credentials.dir, "github-app-key.cred"), "utf8")).not.toContain(secret);
    const index = readFileSync(join(cfg.credentials.dir, "index.json"), "utf8");
    expect(index).not.toContain(secret);
    expect((await store.readIndex())[0]).toMatchObject({ name: "github-app-key", set_by: "maintainer", expires_at: null, last_checked_at: null, last_check: null });
    expect(await store.readSecret("github-app-key")).toBe(secret);
    expect(await store.removeSecret("github-app-key")).toBe(true);
    expect(await store.readIndex()).toEqual([]);
    expect(await store.removeSecret("github-app-key")).toBe(false);
  });
  it("picks the stored App key over the path, the path when unset, and names the credential when decrypting fails", async () => {
    const { cfg, store, root } = setup();
    writeFileSync(cfg.app.private_key_path, "PATH-KEY");
    expect(await appPrivateKey(cfg, store)).toEqual({ source: "path", key: "PATH-KEY" });
    await store.writeSecret("github-app-key", "STORE-KEY", "maintainer");
    expect(await appPrivateKey(cfg, store)).toEqual({ source: "store", key: "STORE-KEY" });
    process.env.FAKE_SYSTEMD_CREDS_FAIL = "1";
    const err = await appPrivateKey(cfg, store).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/github-app-key.*cred set github-app-key/);
    expect((err as Error).message).not.toContain("STORE-KEY");
    void root;
  });
});

describe("catalogue (spec 069 AC-1, AC-8)", () => {
  it("loads the repository file with the three entries and their checks", () => {
    const c = loadCatalogueFor(agentsDir);
    expect(c.map((e) => e.name)).toEqual(["github-app-key", "telegram-bot", "aws-sso"]);
    expect(entry("github-app-key").check).toEqual({ builtin: "github-app" });
    expect(entry("telegram-bot").check).toEqual({ builtin: "telegram-get-me" });
    expect(entry("aws-sso").check).toBe("aws sts get-caller-identity");
  });
  const known = { profiles: ["backend"], standingAgents: ["infra-health"] };
  const base = (over: Record<string, unknown> = {}, drop: string[] = []) => {
    const e: Record<string, unknown> = { name: "x", provider: "p", purpose: "u", access: ["a"], used_by: ["scheduler"], wrapper: "none", expiry: "none", check: { builtin: "github-app" }, renew: "manual", setup: ["s"], ...over };
    for (const k of drop) delete e[k];
    return e;
  };
  const load = (...entries: Record<string, unknown>[]) => {
    const p = join(tmp(), "c.json");
    writeFileSync(p, JSON.stringify(entries)); // JSON is YAML
    return loadCatalogue(p, known);
  };
  it("accepts a valid entry and rejects each broken rule, naming the entry", () => {
    expect(load(base())).toHaveLength(1);
    const wrapped = { command: "aws", env: "E" };
    const cases: [Record<string, unknown>[], RegExp][] = [
      [[base({ extra: 1 })], /x: invalid/],
      [[base({}, ["purpose"])], /x: invalid/],
      [[base({ wrapper: wrapped, check: "aws x", used_by: ["infra-health"] }), { ...base({ wrapper: wrapped, check: "aws y", used_by: ["infra-health"] }), name: "y" }], /already wrapped by x/],
      [[base({ used_by: ["nobody"] })], /used_by nobody/],
      [[base({ check: "gh api /app" })], /wrapper: none.*builtin/],
      [[base({ wrapper: wrapped, check: { builtin: "github-app" }, used_by: ["infra-health"] })], /wrapper has a command string|with a wrapper/],
      [[base({ check: { builtin: "no-such-probe" } })], /x: invalid/],
      [[base({ check: "gh api /installation/repositories --jq .total_count" })], /command string/],
      [[base({ wrapper: wrapped, check: "aws x", used_by: ["scheduler"] })], /used_by scheduler/],
    ];
    for (const [entries, re] of cases) expect(() => load(...entries)).toThrow(re);
  });
});

function route(over: { replyId?: number; key?: { publicKey: string } } = {}) {
  return mockGitHub([appRouteFor((over.key ?? testKey).publicKey, APP_ID, "bot", over.replyId)]);
}

describe("github-app probe (spec 069 AC-2)", () => {
  it("is ok with the stored key, makes exactly one GET /app, and touches no token.json", async () => {
    const { cfg, store, root } = setup();
    await store.writeSecret("github-app-key", testKey.privateKey, "maintainer");
    const tokenFile = join(root, "token.json");
    writeFileSync(tokenFile, '{"token":"t"}');
    utimesSync(tokenFile, 1000, 1000);
    const gh = route();
    const r = await runCheck(entry("github-app-key"), { store, cfg, fetch: gh.fetch });
    expect(r).toEqual({ status: "ok" });
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /app"]);
    expect(readFileSync(tokenFile, "utf8")).toBe('{"token":"t"}');
    expect(statSync(tokenFile).mtimeMs).toBe(1000000);
    const idx = (await store.readIndex())[0];
    expect(idx.last_check).toBe("ok");
    expect(idx.last_checked_at).not.toBeNull();
  });
  it("reports each failure with a reason that holds no key text", async () => {
    const reasons: Record<string, string> = {};
    const cases: [string, string, ReturnType<typeof route>, string][] = [
      ["garbage", "not a key at all", route(), "failed: key does not parse"],
      ["truncated", testKey.privateKey.slice(0, 120), route(), "failed: key does not parse"],
      ["public", testKey.publicKey, route(), "failed: key does not parse"],
      ["refused", otherKey.privateKey, route(), "failed: GitHub refused the JWT (401)"],
      ["other app", testKey.privateKey, route({ replyId: 999 }), "failed: key belongs to App 999, configured App is 4242"],
    ];
    for (const [label, key, gh, want] of cases) {
      const { cfg, store } = setup();
      await store.writeSecret("github-app-key", key, "maintainer");
      const r = await runCheck(entry("github-app-key"), { store, cfg, fetch: gh.fetch });
      expect(r.status).toBe("failed");
      expect((await store.readIndex())[0].last_check).toBe(want);
      reasons[label] = want;
      for (let i = 0; i + 20 < key.length; i += 7) expect(want).not.toContain(key.slice(i, i + 20));
    }
    // a 5xx and a network error
    for (const [fetchFn, re] of [
      [(async () => new Response('{"message":"boom"}', { status: 503, headers: { "content-type": "application/json" } })) as typeof fetch, /^failed: 503$/],
      [(async () => { throw new TypeError("fetch failed"); }) as typeof fetch, /^failed: /],
    ] as const) {
      const { cfg, store } = setup();
      await store.writeSecret("github-app-key", testKey.privateKey, "maintainer");
      await runCheck(entry("github-app-key"), { store, cfg, fetch: fetchFn });
      expect((await store.readIndex())[0].last_check).toMatch(re);
    }
  });
  it("never reads app.private_key_path", async () => {
    const { cfg, store } = setup();
    await store.writeSecret("github-app-key", testKey.privateKey, "maintainer");
    writeFileSync(cfg.app.private_key_path, otherKey.privateKey);
    const gh = route();
    expect(await runCheck(entry("github-app-key"), { store, cfg, fetch: gh.fetch })).toEqual({ status: "ok" });
  });
  it("runCheck over a refused key returns the failed reason and the index shows it", async () => {
    const { cfg, store } = setup();
    await store.writeSecret("github-app-key", otherKey.privateKey, "maintainer");
    const r = await runCheck(entry("github-app-key"), { store, cfg, fetch: route().fetch });
    expect(r).toEqual({ status: "failed", reason: "GitHub refused the JWT (401)" });
    expect((await store.readIndex())[0].last_check).toBe("failed: GitHub refused the JWT (401)");
  });
  it("skips a command check whose wrapper is not built, leaving last_check null", async () => {
    const { cfg, store } = setup();
    await store.writeSecret("aws-sso", "panelator-delivery", "maintainer");
    expect(await runCheck(entry("aws-sso"), { store, cfg })).toEqual({ status: "skipped", reason: "wrapper not built" });
    expect((await store.readIndex())[0].last_check).toBeNull();
  });
  it("composes with createAppClient for the start-up key: the store's key signs the first GET /app (AC-9)", async () => {
    const { cfg, store } = setup();
    writeFileSync(cfg.app.private_key_path, otherKey.privateKey);
    await store.writeSecret("github-app-key", testKey.privateKey, "maintainer");
    const gh = route();
    const { key, source } = await appPrivateKey(cfg, store);
    expect(source).toBe("store");
    expect(await createAppClient(cfg.app, key, gh.fetch).botLogin()).toBe("bot[bot]");
    // with an empty index the path key is used, which the route refuses
    const fresh = setup();
    writeFileSync(fresh.cfg.app.private_key_path, otherKey.privateKey);
    const k2 = await appPrivateKey(fresh.cfg, fresh.store);
    expect(k2.source).toBe("path");
    await expect(createAppClient(fresh.cfg.app, k2.key, route().fetch).botLogin()).rejects.toMatchObject({ status: 401 });
  });
});

describe("telegram-get-me probe (spec 069 AC-4)", () => {
  it("is ok on getMe, unauthorized on 401, the status otherwise, and rejects another shape", async () => {
    const tg = await fakeTelegram();
    try {
      const { cfg, store } = setup();
      const secret = JSON.stringify({ bot_token: "123456:SECRET-TOKEN-ABCDEF", chat_id: 77 });
      await store.writeSecret("telegram-bot", secret, "import");
      const ctx = { store, cfg, telegramBaseUrl: tg.url };
      expect(await runCheck(entry("telegram-bot"), ctx)).toEqual({ status: "ok" });
      tg.fail("getMe", 401);
      expect(await runCheck(entry("telegram-bot"), ctx)).toEqual({ status: "failed", reason: "unauthorized" });
      tg.fail("getMe", 500);
      expect(await runCheck(entry("telegram-bot"), ctx)).toEqual({ status: "failed", reason: "500" });
      expect((await store.readIndex())[0].last_check).toBe("failed: 500");
      await store.writeSecret("telegram-bot", "not json", "import");
      expect(await runCheck(entry("telegram-bot"), ctx)).toEqual({ status: "failed", reason: "secret is not { bot_token, chat_id }" });
      await store.writeSecret("telegram-bot", '{"bot_token":"x"}', "import");
      expect((await runCheck(entry("telegram-bot"), ctx)).status).toBe("failed");
    } finally {
      await tg.close();
    }
  });
});

describe("cred commands (spec 069 AC-3, AC-10)", () => {
  async function world(key = testKey.privateKey, gh = route()) {
    const w = setup();
    const paths = statePaths(join(w.root, "state"));
    await ensureStateDirs(paths);
    const ctx = (stdin = key): CredContext => ({ cfg: w.cfg, store: w.store, catalogue: loadCatalogueFor(agentsDir), stdin: async () => stdin, fetch: gh.fetch });
    return { ...w, paths, ctx, gh };
  }
  const secretsIn = (dir: string, text: string) => filesUnder(dir).filter((f) => !f.includes("/store/") && readFileSync(f, "utf8").includes(text));

  it("set with the test key stores, checks ok and exits 0", async () => {
    const w = await world();
    const out = await credCommand(["set", "github-app-key"], w.ctx(testKey.privateKey + "\n"));
    expect(out).toEqual({ exitCode: 0, lines: ["github-app-key: check ok"] });
    expect((await w.store.readIndex())[0]).toMatchObject({ name: "github-app-key", set_by: "maintainer", last_check: "ok" });
    expect((await w.store.readIndex())[0].last_checked_at).not.toBeNull();
    expect(w.gh.calls.map((c) => c.url)).toEqual(["/app"]);
  });
  it("set with a key GitHub refuses still stores it, prints the failure and the setup steps, and exits 1", async () => {
    const w = await world();
    const out = await credCommand(["set", "github-app-key"], w.ctx(otherKey.privateKey));
    expect(out.exitCode).toBe(1);
    expect(out.lines[0]).toBe("github-app-key: check failed: GitHub refused the JWT (401)");
    expect(out.lines.join("\n")).toMatch(/1\. In GitHub/);
    expect(await w.store.readSecret("github-app-key")).toBe(otherKey.privateKey.trimEnd());
    expect((await w.store.readIndex())[0].last_check).toBe("failed: GitHub refused the JWT (401)");
  });
  it("set rejects an unknown name and an empty stdin", async () => {
    const w = await world();
    expect((await credCommand(["set", "nope"], w.ctx())).lines[0]).toBe("unknown credential nope");
    expect((await credCommand(["set", "github-app-key"], w.ctx("\n"))).exitCode).toBe(1);
    expect(await w.store.readIndex()).toEqual([]);
  });
  it("check exits 1 only when a check failed; skipped does not count; list never shows the secret", async () => {
    const w = await world();
    await credCommand(["set", "github-app-key"], w.ctx());
    await credCommand(["set", "aws-sso"], w.ctx("panelator-delivery"));
    const all = await credCommand(["check"], w.ctx());
    expect(all.exitCode).toBe(0);
    expect(all.lines).toContain("aws-sso: check skipped: wrapper not built");
    expect(all.lines).toContain("telegram-bot: check skipped: not set");
    await w.store.writeSecret("github-app-key", otherKey.privateKey, "maintainer");
    expect((await credCommand(["check", "github-app-key"], w.ctx())).exitCode).toBe(1);
    expect((await credCommand(["check"], w.ctx())).exitCode).toBe(1);
    const list = await credCommand(["list"], w.ctx());
    expect(list.lines).toHaveLength(3);
    expect(list.lines[0]).toMatch(/^github-app-key: set \(by maintainer.*last check failed: GitHub refused/);
    expect(list.lines.join("\n")).not.toContain("PRIVATE KEY");
    expect((await credCommand(["check", "nope"], w.ctx())).exitCode).toBe(1);
  });
  it("import stores the two files with set_by import, tolerates a missing one and says what to delete", async () => {
    const w = await world();
    const tgFile = join(w.root, "telegram.json");
    w.cfg.telegram = { credentials_path: tgFile, long_poll_timeout_s: 50 };
    writeFileSync(w.cfg.app.private_key_path, testKey.privateKey);
    let out = await credCommand(["import"], w.ctx());
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toMatch(/^github-app-key: imported from .*check ok$/);
    expect(out.lines[1]).toMatch(/^telegram-bot: not imported, cannot read .*ENOENT/);
    expect(out.lines.join("\n")).toMatch(/safe to delete after the service has restarted/);
    expect(out.lines.join("\n")).toMatch(/poller still reads it/);
    expect((await w.store.readIndex()).map((e) => [e.name, e.set_by])).toEqual([["github-app-key", "import"]]);
    const tg = await fakeTelegram();
    try {
      writeFileSync(tgFile, JSON.stringify({ bot_token: "1:TOKEN-ABCDEFGH", chat_id: 5 }));
      const c = w.ctx();
      c.telegramBaseUrl = tg.url;
      out = await credCommand(["import"], c);
      expect(out.lines[1]).toMatch(/^telegram-bot: imported from .*check ok$/);
    } finally {
      await tg.close();
    }
  });
  it("remove deletes the blob and the entry, and a name not set exits 1", async () => {
    const w = await world();
    await credCommand(["set", "github-app-key"], w.ctx());
    expect(await credCommand(["remove", "github-app-key"], w.ctx())).toEqual({ exitCode: 0, lines: ["github-app-key: removed"] });
    expect(filesUnder(w.cfg.credentials.dir).filter((f) => f.endsWith(".cred"))).toEqual([]);
    expect((await credCommand(["remove", "github-app-key"], w.ctx())).exitCode).toBe(1);
  });
  it("leaks the secret nowhere under the state directory after every command", async () => {
    const w = await world();
    await credCommand(["set", "github-app-key"], w.ctx());
    await credCommand(["set", "github-app-key"], w.ctx(otherKey.privateKey));
    await credCommand(["list"], w.ctx());
    await credCommand(["check", "github-app-key"], w.ctx());
    await credCommand(["remove", "github-app-key"], w.ctx());
    const body = testKey.privateKey.split("\n")[1];
    expect(secretsIn(join(w.root, "state"), body)).toEqual([]);
    expect(secretsIn(join(w.root, "state"), otherKey.privateKey.split("\n")[1])).toEqual([]);
  });
});
