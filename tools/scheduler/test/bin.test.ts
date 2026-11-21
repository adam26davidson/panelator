import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";

// Spec 088: the service entry point's configuration-error path (exit 78), run as systemd runs it.
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "scheduler.ts");
const PREFIX = "panelator-scheduler: ";

function run(edit: (agents: string) => void = () => {}, appId = 1) {
  const root = mkdtempSync(join(tmpdir(), "bin-test-"));
  const agents = join(root, "agents");
  cpSync(agentsDir, agents, { recursive: true });
  edit(agents);
  const stateDir = join(root, "state");
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({
    repo: "o/r", maintainer: "m", state_dir: stateDir,
    app: { id: appId, installation_id: appId, private_key_path: join(root, "key.pem"), bot_login: "bot[bot]" },
    credentials: { dir: join(root, "credentials") },
    telegram: { credentials_path: join(root, "telegram.json") },
  }));
  const r = spawnSync(process.execPath, [bin, "--config", config, "--agents-dir", agents], { encoding: "utf8", timeout: 25_000, env: { ...process.env, HOME: root } });
  const logFile = join(stateDir, "log", "service.jsonl");
  const serviceLog = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { status: r.status, stderr: r.stderr, serviceLog, agents, stateDir };
}

/** Asserts exit 78 and a config-error record whose reason is the stderr line; returns the reason. */
function expectConfigError(r: ReturnType<typeof run>): string {
  expect(r.status).toBe(78);
  const line = r.stderr.trim().split("\n").at(-1)!;
  expect(line.startsWith(PREFIX)).toBe(true);
  const reason = line.slice(PREFIX.length);
  const last = r.serviceLog.at(-1);
  expect(last.kind).toBe("config-error");
  expect(last.reason).toBe(reason);
  return reason;
}

describe("bin/scheduler.ts configuration errors", () => {
  it("AC-1: a bad standing definition exits 78", () => {
    const r = run((a) => {
      const f = join(a, "standing", "findings-filer.md");
      const text = readFileSync(f, "utf8");
      writeFileSync(f, text.replace(/^---\n/, "---\nunknown: true\n"));
    });
    const reason = expectConfigError(r);
    expect(reason.startsWith(`${r.agents}/standing/findings-filer.md: `)).toBe(true);
    expect(reason).toContain("must NOT have additional properties");
  }, 30_000);

  it.each([
    ["actions.yaml", (a: string) => writeFileSync(join(a, "actions.yaml"), "[]"), "actions.yaml: expected action map"],
    ["parameters.yaml", (a: string) => writeFileSync(join(a, "parameters.yaml"), JSON.stringify([{ name: "Bad Name" }])), "parameters.yaml: parameter 0: "],
    ["credentials.yaml", (a: string) => writeFileSync(join(a, "credentials.yaml"), "- {name: x, extra: 1}\n"), "credentials.yaml: "],
    ["a metrics definition", (a: string) => appendFileSync(join(a, "metrics", "issue_to_merge_days.yaml"), "\nextra: 1\n"), "issue_to_merge_days.yaml: extra"],
  ])("AC-2: a broken %s exits 78", (_n, edit, fragment) => {
    const reason = expectConfigError(run(edit));
    expect(reason).toContain(fragment);
  }, 30_000);

  it("AC-3: a valid tree loads and stops at the App-ids check", () => {
    const r = run(() => {}, 0);
    const reason = expectConfigError(r);
    expect(reason).toBe("GitHub App ids not set in agents/scheduler.yaml");
    const names = readdirSync(join(r.agents, "standing")).filter((f) => f.endsWith(".md")).map((f) => `${f.slice(0, -3)}.json`).sort();
    expect(readdirSync(join(r.stateDir, "agents")).sort()).toEqual(names);
  }, 30_000);
});

describe("panelator-scheduler aws sso-expiry (spec 068 AC-2)", () => {
  const fixtureHome = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "aws-home");
  function sso(extra: string[], env: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), "bin-sso-"));
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({
      repo: "o/r", maintainer: "m", state_dir: join(root, "state"),
      app: { id: 1, installation_id: 1, private_key_path: join(root, "key.pem"), bot_login: "bot[bot]" },
      credentials: { dir: join(root, "credentials") }, telegram: { credentials_path: join(root, "telegram.json") },
    }));
    const clean = { ...process.env, HOME: fixtureHome, ...env };
    delete clean.AWS_PROFILE;
    return spawnSync(process.execPath, [bin, "aws", "sso-expiry", ...extra, "--config", config], { encoding: "utf8", timeout: 25_000, env: { ...clean, ...env } });
  }
  it("prints the cached expiry, none for a non-SSO profile, and exits 1 with a reason otherwise", () => {
    const ok = sso(["--profile", "panelator-delivery"]);
    expect([ok.status, ok.stdout.trim(), ok.stderr]).toEqual([0, "2027-01-01T00:00:00Z", ""]); expect([ok.status, ok.stdout.trim()]).toEqual([0, "2027-01-01T00:00:00Z"]);
    expect(ok.stdout + ok.stderr).not.toContain("SSOSECRET");
    expect(sso([], { AWS_PROFILE: "legacy" }).stdout.trim()).toBe("2027-02-01T00:00:00Z");
    expect(sso(["--profile", "plain"]).stdout.trim()).toBe("none");
    const missing = sso(["--profile", "nope"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no profile nope in");
    expect(sso([]).status).toBe(1);
  });
});
