import {startTelegram,telegramCheck} from '../src/service/telegram-start.ts';
import {loadConfig,defaultConfigPath} from '../src/config.ts';
import {fakeTelegram} from './helpers/fake-telegram.ts';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fastForwardMain, fetchOrigin, schedulerChanged } from "../src/service/git.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { systemdStopUnit, systemdUnitActive } from "../src/service/units.ts";
import { ServiceLog } from "../src/service/log.ts";
import { git, repoPair } from "./helpers/repo-pair.ts";

describe('Telegram startup and delivery check',()=>{
 it('fails closed for missing/unauthorized credentials and never logs the token',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tg-start-'));const path=join(dir,'telegram.json');const cfg={...loadConfig(defaultConfigPath),telegram:{credentials_path:path,long_poll_timeout_s:50}};const logs:unknown[]=[];
  expect(await startTelegram(cfg,r=>logs.push(r))).toBeNull();
  writeFileSync(path,JSON.stringify({bot_token:'PRIVATE-TOKEN',chat_id:42}));const server=await fakeTelegram();try{
   server.fail('getMe',401);expect(await startTelegram(cfg,r=>logs.push(r),server.url)).toBeNull();
   expect(await telegramCheck(cfg,server.url)).toBe('bot @test_bot, chat 42');expect(server.sent[0].text).toBe('panelator: Telegram channel connected');
   expect(await startTelegram(cfg,r=>logs.push(r),server.url)).not.toBeNull();expect(JSON.stringify(logs)).not.toContain('PRIVATE-TOKEN');
   server.fail('sendMessage',500);await expect(telegramCheck(cfg,server.url)).rejects.toThrow('sendMessage');
  }finally{await server.close();}
 });
});

describe("fastForwardMain (AC-17)", () => {
  it("fast-forwards and reports changed paths", async () => {
    const pair = repoPair();
    const other = join(pair.root, "other");
    git(pair.root, "clone", "-q", pair.origin, other);
    mkdirSync(join(other, "tools", "scheduler", "src"), { recursive: true });
    writeFileSync(join(other, "tools", "scheduler", "src", "x.ts"), "export {};\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "change");
    git(other, "push", "-q", "origin", "main");
    expect(await fastForwardMain(pair.repo)).toEqual({ moved: false, changedPaths: [] });
    await fetchOrigin(pair.repo);
    const r = await fastForwardMain(pair.repo);
    expect(r).toEqual({ moved: true, changedPaths: ["tools/scheduler/src/x.ts"] });
    expect(schedulerChanged(r.changedPaths)).toBe(true);
    expect(schedulerChanged(["web/a.ts"])).toBe(false);
  });
  it("counts agents/ changes as scheduler changes, so stage and profile edits restart it (I6)", () => {
    expect(schedulerChanged(["agents/stages/review.yaml"])).toBe(true);
    expect(schedulerChanged(["agents/profiles/backend/profile.yaml"])).toBe(true);
    expect(schedulerChanged(["docs/agents/x.md", "specs/001-scheduler-core/spec.md"])).toBe(false);
  });
});

describe("stage scope units (I2)", () => {
  it("asks systemctl --user is-active and treats a non-zero exit as inactive", async () => {
    const calls: string[][] = [];
    const ok = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return {}; };
    const fail = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); throw new Error("inactive"); };
    expect(await systemdUnitActive("panelator-stage-r1", { enabled: true, exec: ok })).toBe(true);
    expect(await systemdUnitActive("panelator-stage-r1", { enabled: true, exec: fail })).toBe(false);
    expect(calls[0]).toEqual(["systemctl", "--user", "is-active", "panelator-stage-r1"]);
  });
  it("stops a unit and swallows errors", async () => {
    const calls: string[][] = [];
    await systemdStopUnit("panelator-stage-r1", { enabled: true, exec: async (cmd, args) => { calls.push([cmd, ...args]); throw new Error("not loaded"); } });
    expect(calls).toEqual([["systemctl", "--user", "stop", "panelator-stage-r1"]]);
  });
  it("does nothing when scopes are disabled", async () => {
    const exec = async () => { throw new Error("must not run"); };
    expect(await systemdUnitActive("u", { enabled: false, exec })).toBe(false);
    await systemdStopUnit("u", { enabled: false, exec });
  });
});

describe("SleepInhibitor (AC-30)", () => {
  it("spawns one inhibitor while held and kills it on release", () => {
    const spawned: string[][] = [];
    let killed = 0;
    const fakeSpawn = ((cmd: string, args: string[]) => { spawned.push([cmd, ...args]); return { kill: () => { killed++; return true; }, unref() {}, on() {} }; }) as never;
    const i = new SleepInhibitor({ enabled: true, spawn: fakeSpawn });
    i.acquire();
    i.acquire();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual(["systemd-inhibit", "--what=sleep:idle", "--who=panelator-scheduler", "--why=stage in flight", "--mode=block", "sleep", "infinity"]);
    expect(i.held).toBe(true);
    i.release();
    expect(killed).toBe(1);
    expect(i.held).toBe(false);
  });
  it("drops the hold on a spawn error (missing binary) and spawns again on the next acquire", () => {
    let spawns = 0;
    const handlers: Record<string, (arg: unknown) => void> = {};
    const fakeSpawn = (() => { spawns++; return { kill: () => true, unref() {}, on(ev: string, fn: (arg: unknown) => void) { handlers[ev] = fn; } }; }) as never;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const i = new SleepInhibitor({ enabled: true, spawn: fakeSpawn });
      i.acquire();
      expect(i.held).toBe(true);
      handlers.error!(new Error("ENOENT"));
      expect(i.held).toBe(false);
      expect(errSpy).toHaveBeenCalledWith("sleep inhibitor unavailable: ENOENT");
      i.acquire();
      expect(spawns).toBe(2);
    } finally {
      errSpy.mockRestore();
    }
  });
  it("does nothing when disabled", () => {
    const i = new SleepInhibitor({ enabled: false, spawn: (() => { throw new Error("no"); }) as never });
    i.acquire();
    expect(i.held).toBe(false);
  });
});

describe("ServiceLog (AC-31)", () => {
  it("writes tick and stopped trailers as JSONL", () => {
    const p = join(mkdtempSync(join(tmpdir(), "log-")), "service.jsonl");
    const log = new ServiceLog(p);
    log.tick({ claimed: [7], eligible: 2 });
    log.stopped("SIGTERM");
    const lines = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: "tick", claimed: [7], eligible: 2, at: expect.any(String) });
    expect(lines[1]).toMatchObject({ kind: "stopped", reason: "SIGTERM" });
  });
});
