import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stageEnv } from "../src/runner/credentials.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { writeToken } from "../src/state/token.ts";

const binDir = join(import.meta.dirname, "..", "bin");

async function stateWithToken() {
  const p = statePaths(mkdtempSync(join(tmpdir(), "tok-")));
  await ensureStateDirs(p);
  await writeToken(p, { token: "ghs_secret", expires_at: "2099-01-01T00:00:00Z" });
  return p;
}

function fakeGh(root: string): string {
  const fakeBin = join(root, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "gh"), "#!/bin/sh\necho \"token=$GH_TOKEN args=$*\"\n");
  chmodSync(join(fakeBin, "gh"), 0o755);
  return fakeBin;
}

describe("gh shim", () => {
  it("exports GH_TOKEN from token.json and execs the next gh on PATH", async () => {
    const p = await stateWithToken();
    const fakeBin = join(p.root, "fakebin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "gh"), "#!/bin/sh\necho \"token=$GH_TOKEN args=$*\"\n");
    chmodSync(join(fakeBin, "gh"), 0o755);
    const env = { ...process.env, ...stageEnv(binDir, p.root), PATH: `${binDir}:${fakeBin}:/usr/bin:/bin` };
    const out = execFileSync("gh", ["pr", "list"], { env, encoding: "utf8" });
    expect(out.trim()).toBe("token=ghs_secret args=pr list");
  });
  it("removes its own directory from PATH even when the entry has a trailing slash", async () => {
    const p = await stateWithToken();
    const fakeBin = fakeGh(p.root);
    const env = { ...process.env, ...stageEnv(binDir, p.root), PATH: `${binDir}/:${fakeBin}:/usr/bin:/bin` };
    const out = execFileSync("gh", ["pr", "list"], { env, encoding: "utf8", timeout: 5000 });
    expect(out.trim()).toBe("token=ghs_secret args=pr list");
  });
  it("fails closed without token.json: exits non-zero and never runs the real gh", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "tok-")));
    await ensureStateDirs(p);
    const fakeBin = fakeGh(p.root);
    const env = { ...process.env, ...stageEnv(binDir, p.root), PATH: `${binDir}:${fakeBin}:/usr/bin:/bin`, GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient" };
    const r = spawnSync("gh", ["pr", "list"], { env, encoding: "utf8", timeout: 5000 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("token=");
    expect(r.stderr).toContain("panelator gh shim: no token in");
  });
});

describe("git credential helper", () => {
  it("answers github.com over https with the token and stays silent for other hosts and plain http", async () => {
    const p = await stateWithToken();
    const env = { ...process.env, PANELATOR_STATE_DIR: p.root };
    const gh = execFileSync(process.execPath, [join(binDir, "git-credential-panelator.ts"), "get"], { env, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
    expect(gh).toBe("username=x-access-token\npassword=ghs_secret\n");
    const other = execFileSync(process.execPath, [join(binDir, "git-credential-panelator.ts"), "get"], { env, input: "protocol=https\nhost=gitlab.com\n\n", encoding: "utf8" });
    expect(other).toBe("");
    const http = execFileSync(process.execPath, [join(binDir, "git-credential-panelator.ts"), "get"], { env, input: "protocol=http\nhost=github.com\n\n", encoding: "utf8" });
    expect(http).toBe("");
  });
  it("takes precedence over a credential helper in the user's global git config", async () => {
    const p = await stateWithToken();
    const GIT_CONFIG_GLOBAL = join(p.root, "gitconfig");
    writeFileSync(GIT_CONFIG_GLOBAL, "[credential \"https://github.com\"]\n\thelper = \"!printf 'username=human\\\\npassword=gho_human\\\\n'\"\n");
    const env = { ...process.env, ...stageEnv(binDir, p.root), GIT_CONFIG_GLOBAL, GIT_TERMINAL_PROMPT: "0" };
    const out = execFileSync("git", ["credential", "fill"], { env, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
    expect(out).toContain("password=ghs_secret");
    expect(out).not.toContain("gho_human");
  });
  it("stageEnv resets inherited helpers, then wires ours through GIT_CONFIG_* and PATH", () => {
    const e = stageEnv("/b", "/s");
    expect(e.PATH.startsWith("/b:")).toBe(true);
    expect(e.PANELATOR_STATE_DIR).toBe("/s");
    expect(e.GIT_CONFIG_COUNT).toBe("2");
    expect(e.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(e.GIT_CONFIG_VALUE_0).toBe("");
    expect(e.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(e.GIT_CONFIG_VALUE_1).toBe("/b/git-credential-panelator.ts");
  });
});
