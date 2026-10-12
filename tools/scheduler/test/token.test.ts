import { execFileSync } from "node:child_process";
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
});

describe("git credential helper", () => {
  it("answers github.com with the token and stays silent for other hosts", async () => {
    const p = await stateWithToken();
    const env = { ...process.env, PANELATOR_STATE_DIR: p.root };
    const gh = execFileSync(process.execPath, [join(binDir, "git-credential-panelator.ts"), "get"], { env, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
    expect(gh).toBe("username=x-access-token\npassword=ghs_secret\n");
    const other = execFileSync(process.execPath, [join(binDir, "git-credential-panelator.ts"), "get"], { env, input: "protocol=https\nhost=gitlab.com\n\n", encoding: "utf8" });
    expect(other).toBe("");
  });
  it("stageEnv wires the helper through GIT_CONFIG_* and PATH", () => {
    const e = stageEnv("/b", "/s");
    expect(e.PATH.startsWith("/b:")).toBe(true);
    expect(e.PANELATOR_STATE_DIR).toBe("/s");
    expect(e.GIT_CONFIG_COUNT).toBe("1");
    expect(e.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(e.GIT_CONFIG_VALUE_0).toBe("/b/git-credential-panelator.ts");
  });
});
