import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyAction, loadActionLevels, registryActionsCheck, type ActionContext } from "../src/actions/index.ts";
import { ActionLog } from "../src/actions/log.ts";
import { agentsDir, defaultConfigPath } from "../src/config.ts";
import { loadCatalogue } from "../src/credentials/catalogue.ts";
import { CredentialStore } from "../src/credentials/store.ts";
import { loadParameterDefinitions } from "../src/parameters/definitions.ts";
import { ParameterStore } from "../src/parameters/store.ts";
import { validate } from "../src/schema/validate.ts";
import { buildCredentialCheckInput } from "../src/standing/credential-check-input.ts";
import { loadRegistry } from "../src/standing/registry.ts";
import { EVENT_NAMES } from "../src/standing/events.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

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
    expect(validate("credential-check-input", input)).toEqual({ ok: true });
    expect(JSON.stringify(input)).not.toContain(SECRET);
    expect(JSON.stringify(input)).not.toContain("plain");
    expect(readdirSync(t.paths.root)).toBeDefined();
  });
  it("the checked-in agent loads with its limits and the result schema accepts warnings", () => {
    const def = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")))["credential-check"]!;
    expect(def).toMatchObject({ tier: "standard", worktree: "none", profile: "none", input: "credential-check-input", output: "credential-check-result", actions: ["renew_credential"], trigger: { schedule: "1d", events: ["credential_expiry"] } });
    expect(def.credentials ?? []).toEqual([]);
    expect(validate("credential-check-result", { summary: "s", warnings: [{ name: "a", expires_at: null, steps: ["x"] }] })).toEqual({ ok: true });
    expect(validate("credential-check-result", { summary: "s", warnings: [{ name: "a" }] })).toMatchObject({ ok: false });
  });
});
