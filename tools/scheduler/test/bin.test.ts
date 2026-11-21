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

describe("cred-exec for a provider: aws entry (spec 068 AC-1)", () => {
  const credExec = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cred-exec.ts");
  const helpers = join(dirname(fileURLToPath(import.meta.url)), "helpers");
  async function world(opts: { aws?: boolean } = {}) {
    const { symlinkSync, mkdirSync } = await import("node:fs");
    const { CredentialStore } = await import("../src/credentials/store.ts");
    const { defaultConfigPath } = await import("../src/config.ts");
    const root = mkdtempSync(join(tmpdir(), "credexec-aws-"));
    const store = new CredentialStore({ dir: join(root, "store"), systemdCreds: join(helpers, "fake-systemd-creds") });
    await store.writeSecret("aws-sso", "panelator-delivery\n", "maintainer");
    let yaml = readFileSync(defaultConfigPath, "utf8");
    if (opts.aws === false) yaml = yaml.replace(/^aws:[\s\S]*?(?=^decide:)/m, "");
    const config = join(root, "scheduler.yaml");
    writeFileSync(config, yaml + `\ncredentials:\n  dir: ${join(root, "store")}\n`);
    const fx = join(root, "fx");
    mkdirSync(fx);
    writeFileSync(join(fx, "identity.json"), JSON.stringify({ Account: "849692148420" }));
    writeFileSync(join(fx, "calls.log"), "");
    const awsDir = join(root, "awsbin");
    mkdirSync(awsDir);
    symlinkSync(join(helpers, "fake-aws"), join(awsDir, "aws"));
    const shim = join(root, "shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "aws"), "#!/bin/sh\necho SHIM; exit 9\n", { mode: 0o755 });
    const env = { ...process.env, AWS_PROFILE: "leaky", FAKE_AWS_DIR: fx, PANELATOR_SYSTEMD_CREDS: join(helpers, "fake-systemd-creds"), PANELATOR_SHIM_DIR: shim, PATH: `${shim}:${awsDir}:${process.env.PATH}` };
    const exec = (...rest: string[]) => spawnSync(process.execPath, [credExec, "--config", config, "aws-sso", "--", ...rest], { encoding: "utf8", env, timeout: 25_000 });
    const calls = () => readFileSync(join(fx, "calls.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    return { exec, calls, fx };
  }
  it("runs the call through src/aws/cli.ts with the stored profile and prints its JSON", async () => {
    const w = await world();
    const r = w.exec("aws", "sts", "get-caller-identity");
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(JSON.parse(r.stdout)).toEqual({ Account: "849692148420" });
    expect(r.stdout).toContain('\n  "Account"');
    expect(w.calls()).toEqual([["sts", "get-caller-identity", "--profile", "panelator-delivery", "--region", "us-east-2", "--output", "json"]]);
  });
  it("refuses another command, --profile/--region/--output, and a failing call prints the redacted error", async () => {
    const w = await world();
    expect(w.exec("ls")).toMatchObject({ status: 1, stderr: expect.stringContaining("cred-exec: aws-sso wraps aws only") });
    for (const a of [["--profile", "x"], ["--profile=x"], ["--region", "r"], ["--output=text"]]) {
      const r = w.exec("aws", "sts", "get-caller-identity", ...a);
      expect([r.status, r.stderr]).toEqual([1, "cred-exec: --profile, --region and --output are set by the scheduler\n"]);
    }
    expect(w.calls()).toEqual([]);
    writeFileSync(join(w.fx, "fail-sts"), "");
    const f = w.exec("aws", "sts", "get-caller-identity");
    expect(f.status).toBe(1);
    expect(f.stderr).toContain("cred-exec: aws sts get-caller-identity failed");
    expect(f.stderr).not.toContain("FAKESECRET123");
    expect(f.stdout).toBe("");
  });
  it("exits 1 with 'aws: off' when there is no aws block", async () => {
    const w = await world({ aws: false });
    expect(w.exec("aws", "sts", "get-caller-identity")).toMatchObject({ status: 1, stderr: "cred-exec: aws: off\n" });
    expect(w.calls()).toEqual([]);
  });
});
