import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { checkCredentialNames, loadCatalogue, parseCatalogue } from "../src/credentials/catalogue.ts";
import { CredentialStore } from "../src/credentials/store.ts";
import { checkAll, checkCredential, dueExpiryEvents, type CredDeps, type Runner } from "../src/credentials/check.ts";
import { credExec, credImport, credList, credRemove, credSet } from "../src/credentials/commands.ts";
import { writeShims } from "../src/credentials/shims.ts";
import { ActionLog } from "../src/actions/log.ts";
import { statePaths } from "../src/state/paths.ts";
import { listProfiles, resolveProfile } from "../src/profiles/resolve.ts";
import { loadRegistry } from "../src/standing/registry.ts";
import { EVENT_NAMES } from "../src/standing/events.ts";
import { registryActionsCheck } from "../src/actions/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The fake `systemd-creds` of spec 030 section 3: reversible, not plaintext. */
const fakeCreds = join(here, "helpers", "fake-systemd-creds");
const SECRET = "s3cr3t-value-0123456789";
const known = { profiles: ["backend"], agents: ["credential-check"] };
const ENTRY = (extra = "") => `
demo:
  provider: demo
  purpose: a demo credential
  access: [read the demo]
  used_by: [backend]
  wrapper: { command: democmd, env: DEMO_SECRET }
  expiry: index
  check: test "$DEMO_SECRET" = ${SECRET}
  renew: manual
  setup: [do the thing]
${extra}`;

function fixture(catalogueText = ENTRY()) {
  const root = mkdtempSync(join(tmpdir(), "cred-"));
  const paths = statePaths(join(root, "state"));
  mkdirSync(paths.actionsLog.replace(/\/[^/]+$/, ""), { recursive: true });
  const store = new CredentialStore(join(root, "store"), fakeCreds);
  const catalogue = parseCatalogue(catalogueText, known);
  const now = { t: new Date("2026-11-04T10:00:00Z") };
  const d: CredDeps = { store, catalogue, paths, binDir: join(here, "..", "bin"), now: () => now.t };
  return { root, paths, store, catalogue, d, log: new ActionLog(paths.actionsLog), now };
}
function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("catalogue (spec 030 AC-2)", () => {
  it("loads the repository file and every name used by a profile or agent is in it", () => {
    const profiles = listProfiles(agentsDir);
    const kinds = registryActionsCheck(join(agentsDir, "actions.yaml"));
    const registry = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, kinds);
    const c = loadCatalogue(join(agentsDir, "credentials.yaml"), { profiles, agents: Object.keys(registry) });
    expect(Object.keys(c).sort()).toEqual(["github-app-key", "telegram-bot"]);
    for (const p of profiles) checkCredentialNames(c, resolveProfile(agentsDir, p).credentials ?? [], p);
    for (const a of Object.values(registry)) checkCredentialNames(c, a.credentials ?? [], a.name);
    expect(() => checkCredentialNames(c, ["nope"], "x")).toThrow(/not in the catalogue/);
  });
  it("rejects unknown keys, missing keys, a wrapper wrapped twice, an unknown used_by and aws", () => {
    expect(() => parseCatalogue(ENTRY("  extra: 1\n"), known)).toThrow();
    expect(() => parseCatalogue(ENTRY().replace("  purpose: a demo credential\n", ""), known)).toThrow(/purpose/);
    expect(() => parseCatalogue(ENTRY() + ENTRY().replace("demo:", "demo2:"), known)).toThrow();
    expect(() => parseCatalogue(ENTRY().replace("demo:", "a:") + ENTRY().replace("demo:", "b:").replace("[read the demo]", "[x]"), known)).toThrow(/already wrapped by a/);
    expect(() => parseCatalogue(ENTRY().replace("[backend]", "[ghost]"), known)).toThrow(/unknown profile or agent ghost/);
    expect(() => parseCatalogue(ENTRY().replace("provider: demo", "provider: aws"), known)).toThrow(/aws/);
  });
});

describe("store (spec 030 AC-1)", () => {
  it("round-trips, keeps the blob and index free of plaintext, and creates the directory 0700", async () => {
    const f = fixture();
    await f.store.writeSecret("demo", SECRET, "maintainer", f.now.t);
    expect(await f.store.readSecret("demo")).toBe(SECRET);
    expect(statSync(f.store.dir).mode & 0o777).toBe(0o700);
    for (const file of allFiles(f.store.dir)) expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    expect((await f.store.readIndex()).demo).toMatchObject({ set_by: "maintainer", expires_at: null, last_check: null });
    await expect(f.store.readSecret("missing")).rejects.toThrow(/not set/);
    await f.store.removeSecret("demo");
    expect(await f.store.readIndex()).toEqual({});
  });
  it("defaults the credentials block when absent and rejects bad values", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "s.yaml");
    const base = "repo: a/b\nmaintainer: a\napp: {bot_login: bot}\n";
    writeFileSync(p, base);
    expect(loadConfig(p).credentials.warn_days).toBe(7);
    expect(loadConfig(p).credentials.dir).toMatch(/\.config\/panelator\/credentials$/);
    expect(loadConfig(defaultConfigPath).credentials.warn_days).toBe(7);
    for (const b of ["credentials: {warn_days: 0}", "credentials: {x: 1}", "credentials: []"]) {
      writeFileSync(p, base + b);
      expect(() => loadConfig(p)).toThrow(/credentials/);
    }
  });
});

describe("commands, checks and wrappers (spec 030 AC-3 to AC-5)", () => {
  it("sets, checks, lists and removes; logs the maintainer with the name only; leaks no secret", async () => {
    const f = fixture();
    expect(await credSet(f.d, f.log, "demo", SECRET + "\n")).toBe("demo: stored, check ok");
    await expect(credSet(f.d, f.log, "unknown", "x")).rejects.toThrow(/not in agents\/credentials.yaml/);
    expect(await credList(f.d)).toMatch(/^demo\tset\texpires never\tcheck ok$/);
    const rows = await f.log.list();
    expect(rows.every((r) => r.agent === "maintainer" && JSON.stringify(r.args) === '{"name":"demo"}')).toBe(true);
    // a failing check is recorded as failed without the secret
    const bad: Runner = async () => ({ code: 1, stdout: "", stderr: `bad ${SECRET}\n` });
    const r = await checkCredential({ ...f.d, run: bad }, "demo");
    expect(r.status).toBe("failed: exit 1: bad ***");
    expect((await f.store.readIndex()).demo.last_check).toBe("failed: exit 1: bad ***");
    for (const file of [...allFiles(f.root).filter((x) => !x.includes("/store/")), ...allFiles(f.paths.root)]) expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    expect(await credRemove(f.d, f.log, "demo")).toBe("demo: removed");
    expect((await checkAll(f.d))[0].status).toBe("missing");
  });
  it("imports the two plain files and says which to delete", async () => {
    const f = fixture(`${ENTRY().replace("demo:", "github-app-key:").replace("wrapper: { command: democmd, env: DEMO_SECRET }", "wrapper: none")}${ENTRY().replace("demo:", "telegram-bot:").replace("wrapper: { command: democmd, env: DEMO_SECRET }", "wrapper: none").replace(/check: .*/, "check: 'true'")}`);
    f.catalogue["github-app-key"].check = "true";
    const a = join(f.root, "a.pem");
    writeFileSync(a, "PEM");
    const out = await credImport(f.d, f.log, { app_key: a, telegram: join(f.root, "t.json") });
    expect(out).toContain("github-app-key: imported");
    expect(out).toContain("t.json not found");
    expect(out).toContain("Delete these by hand");
    expect((await f.store.readIndex())["github-app-key"].set_by).toBe("import");
  });
  it("gives the wrapped child the variable and the stage environment nothing", async () => {
    const f = fixture();
    await credSet(f.d, f.log, "demo", SECRET);
    // a stand-in scheduler launcher that calls credExec, and a real command to wrap
    const bin = join(f.root, "real");
    mkdirSync(bin);
    writeFileSync(join(bin, "democmd"), '#!/bin/sh\necho "got=$DEMO_SECRET"; echo "args=$*"; exit 3\n');
    chmodSync(join(bin, "democmd"), 0o755);
    const shims = await writeShims(join(f.root, "shims"), ["demo"], f.catalogue, { node: process.execPath, script: join(f.root, "x.ts"), config: "c.yaml" }, "implement");
    expect(readFileSync(join(shims.dir, "democmd"), "utf8")).toContain("cred exec 'demo' --");
    expect(readFileSync(join(shims.dir, "democmd"), "utf8")).not.toContain(SECRET);
    expect(readFileSync(shims.launcher, "utf8")).toContain("PANELATOR_AGENT='implement'");
    // credExec inherits stdio, so run it in a child that prints the status
    const script = join(f.root, "run.mts");
    writeFileSync(script, `import {credExec} from ${JSON.stringify(resolve(here, "../src/credentials/commands.ts"))};
import {CredentialStore} from ${JSON.stringify(resolve(here, "../src/credentials/store.ts"))};
import {parseCatalogue} from ${JSON.stringify(resolve(here, "../src/credentials/catalogue.ts"))};
import {readFileSync} from "node:fs";
const cat=parseCatalogue(readFileSync(${JSON.stringify(join(f.root, "cat.yaml"))},"utf8"),{profiles:["backend"],agents:[]});
const code=await credExec({store:new CredentialStore(${JSON.stringify(f.store.dir)},${JSON.stringify(fakeCreds)}),catalogue:cat,paths:{} as never,binDir:"",now:()=>new Date()},"demo",["a","b"]);
console.log("exit="+code+" ambient="+(process.env.DEMO_SECRET||"none"));`);
    writeFileSync(join(f.root, "cat.yaml"), ENTRY());
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, DEMO_SECRET: "", PANELATOR_SHIM_DIR: shims.dir, PATH: `${shims.dir}:${bin}:${process.env.PATH}` } });
    expect(r.stdout).toContain(`got=${SECRET}`);
    expect(r.stdout).toContain("args=a b");
    expect(r.stdout).toContain("exit=3 ambient=none");
    expect(r.stdout.split("\n").some((l) => l.startsWith("exit=") && l.includes(SECRET))).toBe(false);
  });
  it("emits credential_expiry once per credential per day, never for expiry none", async () => {
    const f = fixture();
    await credSet(f.d, f.log, "demo", SECRET);
    const emitted: unknown[] = [];
    const emit = (n: string, p: unknown) => void emitted.push([n, p]);
    await f.store.updateIndex("demo", (e) => ({ ...e!, expires_at: "2026-11-20T00:00:00Z" }));
    expect(await dueExpiryEvents(f.d, 7, emit)).toEqual([]);
    await f.store.updateIndex("demo", (e) => ({ ...e!, expires_at: "2026-11-07T00:00:00Z" }));
    expect(await dueExpiryEvents(f.d, 7, emit)).toEqual(["demo"]);
    expect(await dueExpiryEvents(f.d, 7, emit)).toEqual([]);
    expect(emitted).toEqual([["credential_expiry", { name: "demo", expires_at: "2026-11-07T00:00:00Z", last_check: "ok" }]]);
    f.now.t = new Date("2026-11-05T10:00:00Z");
    expect(await dueExpiryEvents(f.d, 7, emit)).toEqual(["demo"]);
    const none = fixture(ENTRY().replace("expiry: index", "expiry: none"));
    await credSet(none.d, none.log, "demo", SECRET);
    await none.store.updateIndex("demo", (e) => ({ ...e!, last_check: "failed: x" }));
    expect(await dueExpiryEvents(none.d, 7, emit)).toEqual([]);
  });
  it("reads an expiry probe's stdout", async () => {
    const f = fixture(ENTRY().replace("expiry: index", "expiry: { probe: 'echo 2026-12-01T00:00:00Z' }"));
    await credSet(f.d, f.log, "demo", SECRET);
    expect((await f.store.readIndex()).demo.expires_at).toBe("2026-12-01T00:00:00.000Z");
  });
});
