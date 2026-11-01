import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it('defaults Telegram and rejects unknown keys and invalid timeouts',()=>{
    const dir=mkdtempSync(join(tmpdir(),'cfg-'));const p=join(dir,'s.yaml');const base='repo: a/b\nmaintainer: a\napp: {bot_login: bot}\n';
    writeFileSync(p,base);expect(loadConfig(p).telegram?.long_poll_timeout_s).toBe(50);expect(loadConfig(p).telegram?.credentials_path).not.toContain('~');
    for(const block of ['telegram: {extra: 1}','telegram: {long_poll_timeout_s: 0}','telegram: {long_poll_timeout_s: nope}','telegram: []']){writeFileSync(p,base+block);expect(()=>loadConfig(p)).toThrow(/telegram/);}
  });
  it("loads the committed agents/scheduler.yaml with defaults", () => {
    const c = loadConfig(defaultConfigPath);
    expect(c.repo).toBe("adam26davidson/panelator");
    expect(c.slots).toBe(1);
    expect(c.poll_interval_s).toBe(45);
    expect(c.liveness_hours).toBe(2);
    expect(c.state_dir.startsWith("/")).toBe(true);
    expect(c.required_checks).toEqual(["test"]);
    expect(c.rescue_model).toBe("claude-fable-5-1");
  });
  it("reads bounds.design_revisions, default 2, a positive integer (spec 029 AC-4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "s.yaml");
    const base = "repo: a/b\nmaintainer: a\napp: {bot_login: bot}\n";
    expect(loadConfig(defaultConfigPath).bounds.design_revisions).toBe(2);
    writeFileSync(p, base);
    expect(loadConfig(p).bounds.design_revisions).toBe(2);
    writeFileSync(p, base + "bounds: {design_revisions: 5}\n");
    expect(loadConfig(p).bounds.design_revisions).toBe(5);
    for (const bad of ["0", "1.5", "nope", "-1"]) {
      writeFileSync(p, base + `bounds: {design_revisions: ${bad}}\n`);
      expect(() => loadConfig(p), bad).toThrow(/design_revisions/);
    }
  });
  it("defaults rescue_model when the key is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "s.yaml");
    writeFileSync(p, "repo: a/b\nmaintainer: a\napp: {id: 1, installation_id: 1, private_key_path: /k, bot_login: \"x[bot]\"}\n");
    expect(loadConfig(p).rescue_model).toBe("claude-fable-5-1");
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
