import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("loads the committed agents/scheduler.yaml with defaults", () => {
    const c = loadConfig(defaultConfigPath);
    expect(c.repo).toBe("adam26davidson/panelator");
    expect(c.slots).toBe(1);
    expect(c.poll_interval_s).toBe(45);
    expect(c.liveness_hours).toBe(2);
    expect(c.state_dir.startsWith("/")).toBe(true);
  });
  it("rejects slots below 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "s.yaml");
    writeFileSync(p, "repo: a/b\nmaintainer: a\napp: {id: 1, installation_id: 1, private_key_path: /k, bot_login: \"x[bot]\"}\nslots: 0\n");
    expect(() => loadConfig(p)).toThrow(/slots/);
  });
  it("expands ~ in paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "s.yaml");
    writeFileSync(p, "repo: a/b\nmaintainer: a\napp: {id: 1, installation_id: 1, private_key_path: ~/k.pem, bot_login: \"x[bot]\"}\nstate_dir: ~/st\n");
    const c = loadConfig(p);
    expect(c.state_dir).not.toContain("~");
    expect(c.app.private_key_path).not.toContain("~");
  });
});
