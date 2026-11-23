import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { loadCatalogue, profileNames } from "../src/credentials/catalogue.ts";
import { CredentialStore } from "../src/credentials/store.ts";
import { runStandingAgent } from "../src/standing/run.ts";
import { readAgentState } from "../src/standing/state.ts";
import { standingWorld } from "./helpers/e2e-routes.ts";

// Spec 068 AC-2: a renewable session's notice is one heads-up per distinct expires_at, inside warn_days only.
const FAKE_CREDS = join(import.meta.dirname, "helpers", "fake-systemd-creds");
const DAY = 86_400_000;
const T0 = new Date("2026-11-15T12:00:00Z");
const warning = { name: "aws-sso", expires_at: "2026-11-18T12:00:00Z", steps: ["scripted step that must not be used"] };

async function setup(failing = false) {
  const w = await standingWorld({ "credential-check": Array.from({ length: 8 }, () => ({ summary: "warn", warnings: [warning] })) } as never);
  const store = new CredentialStore({ dir: join(w.pair.root, "cred-store"), systemdCreds: FAKE_CREDS });
  await store.writeSecret("aws-sso", "panelator-delivery", "maintainer");
  const catalogue = loadCatalogue(join(agentsDir, "credentials.yaml"), { profiles: profileNames(agentsDir), agents: ["action-audit", "charter-reflection", "credential-check", "delivery-reflection", "findings-filer", "infra-health", "meta-reflection"] });
  const deps = { ...w.deps, parameters: w.parameters, catalogue, checkContext: { store, app: w.deps.cfg.app, now: () => w.deps.now(), ...(failing ? { aws: { config: { profile: "panelator-delivery", account_id: "123456789012", region: "us-east-2", pull_interval_h: 24 }, cli: () => ({ run: async () => { throw new Error("the SSO session has expired"); } }) as never, env: { HOME: join(w.pair.root, "no-home") } } } : {}) }, scope: async () => ({ status: "ok" as const }) };
  const wake = async (at: Date) => { w.setNow(at); await runStandingAgent(deps as never, w.registry["credential-check"]!, (await readAgentState(w.paths, "credential-check"))!); };
  const notes = () => w.notifications.filter((n) => n.gate === "credential-expiry" && n.label === "aws-sso");
  const set = async (expires: Date, check = "ok") => { await store.writeExpiry("aws-sso", expires.toISOString(), true); await store.writeCheck("aws-sso", { last_checked_at: w.deps.now().toISOString(), last_check: check }); };
  return { w, store, wake, notes, set };
}

describe("a renewable session's heads-up (spec 068 AC-2)", () => {
  it("a registration changed to a later time, outside warn_days, gives no notice and leaves heads_up_for; inside warn_days it warns once for the new time", async () => {
    const { store, wake, notes, set } = await setup();
    w0: {
      await set(new Date(T0.getTime() + 3 * DAY));
      await wake(T0);
      expect(notes()).toHaveLength(1);
      expect(notes()[0]!.text).toContain("the CLI's login registration ends");
      expect(notes()[0]!.text).toContain("1. Run `aws sso login --sso-session default`");
      const first = (await store.readIndex())["aws-sso"]!;
      expect(first.heads_up_for).toBe(first.expires_at);
      break w0;
    }
    const heads = (await store.readIndex())["aws-sso"]!.heads_up_for;
    // a login after the registration ended: a new registration 90 days ahead; the scripted result still lists aws-sso
    const day2 = new Date(T0.getTime() + 4 * DAY);
    await set(new Date(day2.getTime() + 90 * DAY));
    await wake(day2);
    expect(notes()).toHaveLength(1);
    expect((await store.readIndex())["aws-sso"]!.heads_up_for).toBe(heads);
    // the same registration, now inside warn_days: one more notice for the new expires_at
    const later = new Date(day2.getTime() + 85 * DAY);
    await wake(later);
    expect(notes()).toHaveLength(2);
    const idx = (await store.readIndex())["aws-sso"]!;
    expect(idx.heads_up_for).toBe(idx.expires_at);
    expect(notes()[1]!.text).toContain(idx.expires_at!);
    await wake(new Date(later.getTime() + 2 * DAY));
    expect(notes()).toHaveLength(2);
  }, 60_000);

  it("a failing check on the second day warns once with the renew steps, whatever heads_up_for holds", async () => {
    const { w, store, wake, notes, set } = await setup(true);
    await set(new Date(T0.getTime() + 3 * DAY));
    await wake(T0);
    expect(notes()).toHaveLength(1);
    const day2 = new Date(T0.getTime() + 2 * DAY);
    await set(new Date(T0.getTime() + 3 * DAY), "failed: the identity call failed");
    await store.writeHeadsUp("aws-sso", (await store.readIndex())["aws-sso"]!.expires_at!);
    await wake(day2);
    expect(notes()).toHaveLength(2);
    expect(notes()[1]!.text).toContain("1. Run `aws sso login --sso-session default`");
    expect(notes()[1]!.text).toContain("needs renewal by hand");
    await wake(new Date(day2.getTime() + 3_600_000));
    expect(notes()).toHaveLength(2);
  }, 60_000);
});
