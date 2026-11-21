import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { applyAction, loadActionLevels, registryActionsCheck, KINDS, type ActionContext } from "../src/actions/index.ts";
import { ActionLog } from "../src/actions/log.ts";
import { undoAction } from "../src/actions/undo.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { loadCatalogue, profileNames, validateSchema } from "../src/credentials/catalogue.ts";
import { validate } from "../src/schema/validate.ts";
import { runCheck, type CheckContext } from "../src/credentials/check.ts";
import { credCommand } from "../src/credentials/commands.ts";
import { appPrivateKey, appPrivateKeySource, CredentialStore } from "../src/credentials/store.ts";
import { createAppClient } from "../src/github/auth.ts";
import { loadParameterDefinitions } from "../src/parameters/definitions.ts";
import { ParameterStore } from "../src/parameters/store.ts";
import { loadRegistry } from "../src/standing/registry.ts";
import { EVENT_NAMES } from "../src/standing/events.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { fakeTelegram } from "./helpers/fake-telegram.ts";
import { appRouteSignedBy, mockGitHub, type Route } from "./helpers/mock-github.ts";

const fake = join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-systemd-creds");
const genKey = () => {
  const k = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  return { priv: k.privateKey, pub: k.publicKey };
};
const keys = genKey();
const other = genKey();
const bodyLine = (pem: string) => pem.split("\n")[2];
const APP_ID = 4242;
const TOKEN = "123456:SECRET-bot-token-value";
const TELEGRAM_SECRET = JSON.stringify({ bot_token: TOKEN, chat_id: 5 });
const known = () => ({ profiles: profileNames(agentsDir), agents: Object.keys(loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")))) });
const repoCatalogue = () => loadCatalogue(join(agentsDir, "credentials.yaml"), known());
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { delete process.env.FAKE_SYSTEMD_CREDS_FAIL; while (closers.length) await closers.pop()!(); });

async function setup(routes?: Route[], withTelegram = false) {
  const root = mkdtempSync(join(tmpdir(), "cred-"));
  const store = new CredentialStore({ dir: join(root, "store"), systemdCreds: fake });
  const paths = statePaths(join(root, "state"));
  await ensureStateDirs(paths);
  const log = new ActionLog(paths.actionsLog, paths);
  const parameters = new ParameterStore(paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), { slots: 1 } as never, {}));
  const app = { id: APP_ID, installation_id: 7, private_key_path: join(root, "path.pem"), bot_login: "bot" };
  writeFileSync(app.private_key_path, other.priv);
  const tgFile = join(root, "telegram.json");
  writeFileSync(tgFile, TELEGRAM_SECRET);
  const gh = mockGitHub(routes ?? [appRouteSignedBy(keys.pub, APP_ID, "panelator-pipeline")]);
  const tg = withTelegram ? await fakeTelegram() : undefined;
  if (tg) closers.push(() => tg.close());
  const probe: CheckContext = { store, app, fetch: gh.fetch, now: () => new Date(), telegramBaseUrl: tg?.url };
  const catalogue = repoCatalogue();
  const ctx: ActionContext = {
    paths, parameters, log, levels: loadActionLevels(join(agentsDir, "actions.yaml")), now: () => new Date(),
    gh: { rerunWorkflowRun: async () => {}, cancelWorkflowRun: async () => {} },
    credentials: { store, catalogue, probe, configPaths: { "github-app-key": app.private_key_path, "telegram-bot": tgFile } },
  };
  const cred = (verb: string, name: string | undefined, stdin = "") => credCommand(verb, name, { ctx, readStdin: async () => stdin });
  return { root, store, paths, log, app, gh, tg, probe, catalogue, ctx, cred, tgFile };
}
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const entry = (c: Record<string, ReturnType<typeof repoCatalogue>[string]>, n: string) => c[n];

describe("catalogue (AC-1, AC-8)", () => {
  it("loads the repository file with the two forms of check and validates against the schema", () => {
    const c = repoCatalogue();
    expect(Object.keys(c)).toEqual(["github-app-key", "telegram-bot", "aws-sso"]);
    expect(c["github-app-key"].check).toEqual({ builtin: "github-app" });
    expect(c["telegram-bot"].check).toEqual({ builtin: "telegram-get-me" });
    expect(c["aws-sso"].check).toBe("aws sts get-caller-identity");
    expect(validate("credential-catalogue", parse(readFileSync(join(agentsDir, "credentials.yaml"), "utf8"))).ok).toBe(true);
    expect(c["github-app-key"].setup.at(-1) + c["github-app-key"].setup.join("")).toContain("cred set github-app-key <");
  });
  const mutate = (fn: (e: any[]) => void) => {
    const entries = parse(readFileSync(join(agentsDir, "credentials.yaml"), "utf8")) as any[];
    fn(entries);
    const p = join(mkdtempSync(join(tmpdir(), "cat-")), "credentials.yaml");
    writeFileSync(p, stringify(entries));
    return () => loadCatalogue(p, known());
  };
  it.each([
    ["a string check on a wrapper: none entry", (e: any[]) => { e[0].check = "gh api /app"; }, /github-app-key: .*wrapper: none/],
    ["a builtin check on a wrapped entry", (e: any[]) => { e[2].check = { builtin: "github-app" }; }, /aws-sso: .*wrapper/],
    ["a builtin the code does not implement", (e: any[]) => { e[0].check = { builtin: "nope" }; }, /github-app-key/],
    ["an unknown key", (e: any[]) => { e[1].extra = 1; }, /telegram-bot/],
    ["a missing required key", (e: any[]) => { delete e[1].purpose; }, /telegram-bot/],
    ["a command wrapped twice", (e: any[]) => { e.push({ ...e[2], name: "aws-other" }); }, /aws-other: .*already wrapped by aws-sso/],
    ["a used_by naming nothing", (e: any[]) => { e[2].used_by = ["nobody"]; }, /aws-sso: .*nobody/],
    ["scheduler on a wrapped entry", (e: any[]) => { e[2].used_by = ["scheduler"]; }, /aws-sso: .*scheduler/],
  ])("fails loading for %s", (_n, fn, re) => {
    expect(mutate(fn)).toThrow(re);
  });
  it("describes the index", async () => {
    const t = await setup();
    await t.store.writeSecret("github-app-key", keys.priv, "maintainer");
    expect(validate("credential-index", await t.store.readIndex()).ok).toBe(true);
  });
});

describe("the github-app probe (AC-2)", () => {
  it("is ok for the stored key with exactly one GET /app, no token.json, and ignores the configured path", async () => {
    const t = await setup();
    await t.store.writeSecret("github-app-key", keys.priv, "maintainer");
    const r = await runCheck(entry(t.catalogue, "github-app-key"), t.probe);
    expect(r).toEqual({ status: "ok" });
    expect(t.gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /app"]);
    expect(t.gh.unmatched).toEqual([]);
    expect(() => statSync(t.paths.token)).toThrow();
    const index = await t.store.readIndex();
    expect(index["github-app-key"].last_check).toBe("ok");
    expect(index["github-app-key"].last_checked_at).not.toBeNull();
  });
  it("leaves an existing token.json byte for byte and mtime unchanged", async () => {
    const t = await setup();
    writeFileSync(t.paths.token, '{"token":"x","expires_at":"2099-01-01T00:00:00Z"}');
    const before = [readFileSync(t.paths.token, "utf8"), statSync(t.paths.token).mtimeMs];
    await t.store.writeSecret("github-app-key", keys.priv, "maintainer");
    await runCheck(entry(t.catalogue, "github-app-key"), t.probe);
    expect([readFileSync(t.paths.token, "utf8"), statSync(t.paths.token).mtimeMs]).toEqual(before);
  });
  it.each([["garbage", "not a key"], ["a truncated PEM", keys.priv.slice(0, 120)], ["a public key", keys.pub]])("fails %s as key does not parse", async (_n, text) => {
    const t = await setup();
    await t.store.writeSecret("github-app-key", text, "maintainer");
    expect(await runCheck(entry(t.catalogue, "github-app-key"), t.probe)).toEqual({ status: "failed", reason: "key does not parse" });
    expect(t.gh.calls).toEqual([]);
  });
  it("fails a key GitHub refuses, a wrong App id and a 5xx, with no key text in the reason", async () => {
    const t = await setup();
    await t.store.writeSecret("github-app-key", other.priv, "maintainer");
    expect(await runCheck(entry(t.catalogue, "github-app-key"), t.probe)).toEqual({ status: "failed", reason: "GitHub refused the JWT (401)" });
    const wrong = await setup([appRouteSignedBy(keys.pub, APP_ID, "s", 999)]);
    await wrong.store.writeSecret("github-app-key", keys.priv, "maintainer");
    expect(await runCheck(entry(wrong.catalogue, "github-app-key"), wrong.probe)).toEqual({ status: "failed", reason: `key belongs to App 999, configured App is ${APP_ID}` });
    const down = await setup([{ method: "GET", path: /^\/app$/, reply: () => ({ status: 503, body: { message: "down" } }) }]);
    await down.store.writeSecret("github-app-key", keys.priv, "maintainer");
    const r = await runCheck(entry(down.catalogue, "github-app-key"), down.probe);
    expect(r.status === "failed" && r.reason).toContain("503");
    for (const x of [t, wrong, down]) expect(JSON.stringify(await x.store.readIndex())).not.toContain(bodyLine(keys.priv));
  });
});

describe("cred set and cred check (AC-3, AC-5, AC-10, AC-11)", () => {
  it("reports ok and exits 0 for the right key; the row is applied with args { name } only", async () => {
    const t = await setup();
    const out = await t.cred("set", "github-app-key", keys.priv);
    expect(out).toEqual({ lines: ["github-app-key: check ok"], exitCode: 0 });
    const index = (await t.store.readIndex())["github-app-key"];
    expect(index.set_by).toBe("maintainer");
    expect(index.last_check).toBe("ok");
    const rows = await t.log.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "maintainer", kind: "cred_set", args: { name: "github-app-key" }, status: "applied", undo: null });
    expect(rows[0].reason).toBeUndefined();
  });
  it("stores a key GitHub refuses, prints the failure and the setup steps and exits 1 (the row is still applied)", async () => {
    const t = await setup();
    const out = await t.cred("set", "github-app-key", other.priv);
    expect(out.exitCode).toBe(1);
    expect(out.lines[0]).toBe("github-app-key: check failed: GitHub refused the JWT (401)");
    expect(out.lines.slice(1)).toEqual(t.catalogue["github-app-key"].setup);
    expect((await t.store.readIndex())["github-app-key"].last_check).toBe("failed: GitHub refused the JWT (401)");
    expect(await t.store.readSecret("github-app-key")).toBe(other.priv);
    expect((await t.log.list())[0].status).toBe("applied");
    expect((await t.cred("check", "github-app-key")).exitCode).toBe(1);
  });
  it("refuses an unknown credential, a standing agent and an unreadable import; a failing store is a failed row", async () => {
    const t = await setup();
    expect((await t.cred("set", "nope", "x")).exitCode).toBe(1);
    const req = (agent: string, kind: string, name: string) => applyAction(t.ctx, { agent, run_id: "r", kind, args: { name }, why: "A reason that is long enough" }, agent === "maintainer" ? "maintainer" : [kind]);
    expect((await req("test", "cred_set", "github-app-key"))).toMatchObject({ status: "refused", reason: "maintainer only" });
    expect(await req("maintainer", "cred_set", "nope")).toMatchObject({ status: "refused", reason: "unknown credential nope" });
    t.ctx.credentials!.configPaths["github-app-key"] = join(t.root, "missing.pem");
    expect(await req("maintainer", "cred_import", "github-app-key")).toMatchObject({ status: "refused", reason: `cannot read ${join(t.root, "missing.pem")}` });
    process.env.FAKE_SYSTEMD_CREDS_FAIL = "1";
    const out = await t.cred("set", "github-app-key", keys.priv);
    expect(out.exitCode).toBe(1);
    const row = (await t.log.list()).at(-1)!;
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("systemd-creds");
    expect(await t.store.readIndex()).toEqual({});
    expect(JSON.stringify(await t.log.list())).not.toContain(bodyLine(keys.priv));
  });
  it("writes one row per credential for check, import and remove, and none for list; undo of a cred row is refused", async () => {
    const t = await setup(undefined, true);
    t.probe.telegramBaseUrl = t.tg!.url;
    await t.cred("set", "github-app-key", keys.priv);
    await t.cred("set", "telegram-bot", TELEGRAM_SECRET);
    const before = (await t.log.list()).length;
    await t.cred("list", undefined);
    expect((await t.log.list()).length).toBe(before);
    const checked = await t.cred("check", undefined);
    expect(checked.exitCode).toBe(0);
    expect(checked.lines).toContain("aws-sso: check skipped: wrapper not built");
    expect((await t.store.readIndex())["aws-sso"]).toBeUndefined();
    writeFileSync(t.ctx.credentials!.configPaths["github-app-key"], keys.priv);
    const imported = await t.cred("import", undefined);
    expect(imported.exitCode).toBe(0);
    expect(imported.lines.join("\n")).toContain(`${t.ctx.credentials!.configPaths["github-app-key"]}: safe to delete after the service has restarted; the scheduler reminds you while it remains`);
    expect(imported.lines.join("\n")).toContain(`${t.ctx.credentials!.configPaths["telegram-bot"]}: safe to delete after the service has restarted; the scheduler reminds you while it remains`);
    expect(imported.lines.join("\n")).not.toContain("still read by the Telegram poller");
    expect((await t.store.readIndex())["github-app-key"].set_by).toBe("import");
    expect((await t.cred("remove", "telegram-bot")).lines).toEqual(["telegram-bot: removed"]);
    expect((await t.store.readIndex())["telegram-bot"]).toBeUndefined();
    const rows = await t.log.list();
    expect(rows.map((r) => r.kind)).toEqual(["cred_set", "cred_set", "cred_check", "cred_check", "cred_check", "cred_import", "cred_import", "cred_remove"]);
    for (const r of rows) expect(r).toMatchObject({ agent: "maintainer", args: { name: expect.any(String) }, status: "applied", undo: null });
    for (const r of rows) expect(Object.keys(r.args)).toEqual(["name"]);
    const undone = await undoAction(t.ctx, rows[0].id, "maintainer");
    expect(undone.status).toBe("refused");
    expect(undone.reason).toBe("action is not undoable");
    expect(registryActionsCheck(join(agentsDir, "actions.yaml")).sort()).toEqual(Object.keys(KINDS).sort());
  });
});

describe("the telegram-get-me probe (AC-4)", () => {
  it("is ok for getMe, unauthorized on 401, failed otherwise, and fails a secret of another shape", async () => {
    const t = await setup(undefined, true);
    const e = entry(t.catalogue, "telegram-bot");
    await t.store.writeSecret("telegram-bot", TELEGRAM_SECRET, "maintainer");
    expect(await runCheck(e, t.probe)).toEqual({ status: "ok" });
    t.tg!.fail("getMe", 401);
    expect(await runCheck(e, t.probe)).toEqual({ status: "failed", reason: "unauthorized" });
    t.tg!.fail("getMe", 500);
    const r = await runCheck(e, t.probe);
    expect(r.status).toBe("failed");
    await t.store.writeSecret("telegram-bot", "not json", "maintainer");
    expect(await runCheck(e, t.probe)).toEqual({ status: "failed", reason: "secret is not { bot_token, chat_id }" });
    await t.store.writeSecret("telegram-bot", TELEGRAM_SECRET, "maintainer");
    await runCheck(e, t.probe);
    expect(JSON.stringify(await t.store.readIndex())).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("the store (AC-7)", () => {
  it("encrypts, keeps the secret out of the index, the logs and the state directory, and creates the directory 0700", async () => {
    const t = await setup();
    await t.cred("set", "github-app-key", keys.priv);
    await t.cred("check", "github-app-key");
    expect(statSync(t.store.dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(t.store.dir, "github-app-key.cred"), "utf8")).not.toContain(bodyLine(keys.priv));
    expect(readFileSync(join(t.store.dir, "index.json"), "utf8")).not.toContain(bodyLine(keys.priv));
    for (const f of walk(t.paths.root ?? dirname(t.paths.actionsLog))) expect(readFileSync(f, "utf8")).not.toContain(bodyLine(keys.priv));
  });
  it("loads the credentials block with defaults and rejects an unknown key or warn_days under 1", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cfg-")), "s.yaml");
    const base = "repo: a/b\nmaintainer: a\napp: {bot_login: bot}\n";
    writeFileSync(p, base);
    expect(loadConfig(p).credentials).toEqual({ dir: expect.stringMatching(/^\/.*\/credentials$/), warn_days: 7 });
    writeFileSync(p, base + "credentials: {dir: /x/y, warn_days: 3}\n");
    expect(loadConfig(p).credentials).toEqual({ dir: "/x/y", warn_days: 3 });
    for (const block of ["credentials: {warn_days: 0}", "credentials: {extra: 1}"]) { writeFileSync(p, base + block); expect(() => loadConfig(p)).toThrow(/credentials/); }
    expect(loadConfig(defaultConfigPath).credentials.warn_days).toBe(7);
  });
});

describe("the App key at start-up (AC-9)", () => {
  it("reads the store once set, never the path, and signs with it", async () => {
    const t = await setup();
    const cfg = { app: { ...t.app, private_key_path: join(t.root, "does-not-exist.pem") } };
    await expect(appPrivateKey(cfg, t.store)).rejects.toThrow(/does-not-exist/);
    await t.store.writeSecret("github-app-key", keys.priv, "maintainer");
    expect(await appPrivateKey(cfg, t.store)).toBe(keys.priv);
    expect((await appPrivateKeySource(cfg, t.store)).source).toBe("store");
    const withPath = { app: t.app };
    const key = await appPrivateKey(withPath, t.store);
    expect(await createAppClient(t.app, key, t.gh.fetch).botLogin()).toBe("panelator-pipeline[bot]");
  });
  it("reads the path while the index has no entry, and fails with the credential name and no key text when the blob will not decrypt", async () => {
    const t = await setup();
    expect(await appPrivateKey({ app: t.app }, t.store)).toBe(other.priv);
    await t.store.writeSecret("github-app-key", keys.priv, "maintainer");
    process.env.FAKE_SYSTEMD_CREDS_FAIL = "1";
    const err = await appPrivateKey({ app: t.app }, t.store).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/github-app-key/);
    expect((err as Error).message).toMatch(/cred set/);
    expect((err as Error).message).not.toContain(bodyLine(keys.priv));
  });
});

// ---- spec 099 AC-2: shims and cred-exec ----
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeShims } from "../src/credentials/shims.ts";
import { stageEnv } from "../src/runner/credentials.ts";
import { buildCredentialCheckInput } from "../src/standing/credential-check-input.ts";

const helpers = join(dirname(fileURLToPath(import.meta.url)), "helpers");
const testCataloguePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "test-catalogue.yaml");
const testCatalogue = () => loadCatalogue(testCataloguePath, known());
const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

async function shimEnv(secret = "S3CRET-fake-value") {
  const root = mkdtempSync(join(tmpdir(), "shim-"));
  const store = new CredentialStore({ dir: join(root, "store"), systemdCreds: fake });
  await store.writeSecret("fake-token", secret, "maintainer");
  const state = join(root, "state");
  mkdirSync(state);
  const config = join(root, "scheduler.yaml");
  writeFileSync(config, readFileSync(defaultConfigPath, "utf8") + `\ncredentials:\n  dir: ${join(root, "store")}\n`);
  const runDir = join(root, "run");
  mkdirSync(runDir);
  const shimDir = await writeShims(runDir, Object.values(testCatalogue()), { configPath: config, binDir, cataloguePath: testCataloguePath });
  const env = { ...process.env, PANELATOR_SYSTEMD_CREDS: fake, PATH: `${shimDir}:${helpers}:${process.env.PATH}` };
  return { root, state, shimDir: shimDir!, env, runDir };
}

describe("shims (spec 099 AC-2)", () => {
  it("rejects a wrapper command with a slash and writes no shim for a run without credentials", async () => {
    const entries = parse(readFileSync(testCataloguePath, "utf8")) as any[];
    entries[0].wrapper.command = "bin/fakecmd";
    const p = join(mkdtempSync(join(tmpdir(), "cat-")), "c.yaml");
    writeFileSync(p, stringify(entries));
    expect(() => loadCatalogue(p, known())).toThrow(/fake-token/);
    const run = mkdtempSync(join(tmpdir(), "run-"));
    expect(await writeShims(run, [], { configPath: "x", binDir })).toBeNull();
    expect(existsSync(join(run, "bin"))).toBe(false);
  });
  it("puts the shim directory first on PATH only when there is one", () => {
    expect(stageEnv("/b", "/s", undefined, undefined, "/r/bin").PATH.startsWith("/r/bin:/b:")).toBe(true);
    expect(stageEnv("/b", "/s").PATH.startsWith("/b:")).toBe(true);
  });
  it("gives the wrapped child the secret and nobody else; writes nothing and leaks nothing", async () => {
    const t = await shimEnv();
    const r = spawnSync("fakecmd", ["--env"], { env: t.env, encoding: "utf8" });
    expect(r.stdout.trim()).toBe("FAKE_SECRET=set");
    expect(r.status).toBe(0);
    const echoed = spawnSync("fakecmd", ["--echo-secret"], { env: t.env, encoding: "utf8" });
    expect(echoed.stdout.trim()).toBe("S3CRET-fake-value");
    const own = spawnSync("sh", ["-c", 'echo "${FAKE_SECRET-unset}"'], { env: t.env, encoding: "utf8" });
    expect(own.stdout.trim()).toBe("unset");
    const exit = spawnSync("fakecmd", ["x", "y"], { env: { ...t.env, FAKECMD_EXIT: "3" }, encoding: "utf8" });
    expect(exit.status).toBe(3);
    expect(exit.stdout.trim()).toBe("args: x y");
    expect(readdirSync(t.state)).toEqual([]);
    for (const f of walk(t.runDir)) expect(readFileSync(f, "utf8")).not.toContain("S3CRET-fake-value");
  });
  it("fails without the secret in its text when the secret is missing", async () => {
    const t = await shimEnv();
    const r = spawnSync("fakecmd", ["--env"], { env: { ...t.env, FAKE_SYSTEMD_CREDS_FAIL: "1" }, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cred-exec");
    expect(r.stderr).not.toContain("S3CRET");
  });
});


{

const helpers = join(import.meta.dirname, "helpers");
const fixture = join(import.meta.dirname, "fixtures", "test-catalogue.yaml");
const binDir = join(import.meta.dirname, "..", "bin");
const fake = join(helpers, "fake-systemd-creds");
const SECRET = "S3CRET-renew-value";

async function setup(entryPatch: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cc-"));
  const paths = statePaths(join(root, "state"));
  await ensureStateDirs(paths);
  const store = new CredentialStore({ dir: join(root, "store"), systemdCreds: fake });
  await store.writeSecret("fake-token", SECRET, "maintainer");
  const config = join(root, "scheduler.yaml");
  writeFileSync(config, readFileSync(defaultConfigPath, "utf8") + `\ncredentials:\n  dir: ${join(root, "store")}\n`);
  const catalogue = loadCatalogue(fixture, { profiles: ["backend"], agents: [] });
  const entry = { ...catalogue["fake-token"]!, ...entryPatch } as (typeof catalogue)[string];
  const failures: string[] = [];
  const log = new ActionLog(paths.actionsLog, paths);
  const parameters = new ParameterStore(paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), { slots: 1 } as never, {}));
  const probe = { store, app: { id: 1, installation_id: 1, private_key_path: "", bot_login: "" }, now: () => new Date("2026-11-20T10:00:00Z") };
  process.env.PANELATOR_SYSTEMD_CREDS = fake;
  process.env.PATH = `${helpers}:${process.env.PATH!.split(":").filter((p) => p !== helpers).join(":")}`;
  const ctx: ActionContext = {
    paths, parameters, log, levels: loadActionLevels(join(agentsDir, "actions.yaml")), now: () => new Date("2026-11-20T10:00:00Z"),
    gh: { rerunWorkflowRun: async () => {}, cancelWorkflowRun: async () => {} },
    credentials: { store, catalogue: { "fake-token": entry }, probe, configPaths: { "github-app-key": "", "telegram-bot": "" }, shim: { configPath: config, binDir, cataloguePath: fixture, runDir: join(root, "run") }, onRenewFailure: (n, r) => failures.push(`${n}: ${r}`) },
  };
  const renew = (args: Record<string, unknown> = { name: "fake-token" }) => applyAction(ctx, { agent: "credential-check", run_id: "r", kind: "renew_credential", args, why: "expiring within seven days, renew it" }, ["renew_credential"]);
  return { root, paths, store, ctx, entry, failures, renew, probe };
}

describe("renew_credential (spec 099 AC-13)", () => {
  it("renews through the shim, records the expiry from the probe, and has no undo", async () => {
    const t = await setup();
    process.env.FAKECMD_EXPIRES = "2031-02-03T04:05:06Z";
    const row = await t.renew();
    delete process.env.FAKECMD_EXPIRES;
    expect(row.status).toBe("applied");
    expect((await t.store.readIndex())["fake-token"]!.expires_at).toBe("2031-02-03T04:05:06.000Z");
    expect(row.undo).toBeNull();
    expect(t.failures).toEqual([]);
  });
  it("fails with the reason for a manual entry, a failing command and an unknown name", async () => {
    const manual = await setup({ renew: "manual" });
    expect(await manual.renew()).toMatchObject({ status: "failed", reason: expect.stringContaining("by hand") });
    expect(manual.failures).toHaveLength(1);
    const bad = await setup();
    process.env.FAKECMD_RENEW_FAIL = "1";
    const row = await bad.renew();
    delete process.env.FAKECMD_RENEW_FAIL;
    expect(row).toMatchObject({ status: "failed", reason: expect.stringContaining("renew command failed") });
    expect(await bad.renew({ name: "nope" })).toMatchObject({ status: "refused" });
    expect(await bad.renew({ name: "fake-token", extra: 1 })).toMatchObject({ status: "refused" });
  });
});

describe("credential check input (spec 099 AC-12)", () => {
  it("runs runCheck per entry and the scope check once, validates, and holds no secret", async () => {
    const t = await setup();
    let scopeCalls = 0;
    const input = await buildCredentialCheckInput({ paths: t.paths, catalogue: t.ctx.credentials!.catalogue, probe: t.probe, warnDays: 7, scope: async () => (scopeCalls++, { status: "failed", reason: "also o/other" }), now: new Date("2026-11-20T10:00:00Z") }, [], null);
    expect(scopeCalls).toBe(1);
    expect(Object.keys(input.checks)).toEqual(["fake-token"]);
    expect(input.scope).toEqual({ status: "failed", reason: "also o/other" });
    expect(input.entries[0]).toMatchObject({ name: "fake-token", set: true, renew: "command", expiry: "probe" });
    expect(validateSchema("credential-check-input", input)).toEqual({ ok: true });
    expect(JSON.stringify(input)).not.toContain(SECRET);
    expect(JSON.stringify(input)).not.toContain("plain");
    expect(readdirSync(t.paths.root)).toBeDefined();
  });
  it("the checked-in agent loads with its limits and the result schema accepts warnings", () => {
    const def = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")))["credential-check"]!;
    expect(def).toMatchObject({ tier: "standard", worktree: "none", profile: "none", input: "credential-check-input", output: "credential-check-result", actions: ["renew_credential"], trigger: { schedule: "1d", events: ["credential_expiry"] } });
    expect(def.credentials ?? []).toEqual([]);
    expect(validateSchema("credential-check-result", { summary: "s", warnings: [{ name: "a", expires_at: null, steps: ["x"] }] })).toEqual({ ok: true });
    expect(validateSchema("credential-check-result", { summary: "s", warnings: [{ name: "a" }] })).toMatchObject({ ok: false });
  });
});

}
