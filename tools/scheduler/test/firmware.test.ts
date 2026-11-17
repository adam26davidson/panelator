import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyHilToBoard, confirmBack, markBricked, readBoard, remindBoard, type BoardCtx } from "../src/firmware/board.ts";
import { hilFixLines, hilVerdict, parseHilOutput, type HilResult } from "../src/firmware/hil.ts";
import { isFirmwarePr, specNamesFirmwarePath } from "../src/firmware/paths.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

export const hil = (over: Omit<Partial<HilResult>, "board"> & { board?: Partial<HilResult["board"]> } = {}): HilResult => ({
  outcome: "pass", kind: "pr", sha: "a".repeat(40), run_id: 7, tests: [{ name: "provision", status: "pass", duration_ms: 5 }], log: "boot ok",
  ...over, board: { status: "ok", firmware_sha: "a".repeat(40), uptime_s: 100, resets: 0, free_heap: 1, free_psram: 2, ...over.board },
});

async function world(telegram = true) {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "board-")));
  await ensureStateDirs(paths);
  const sent: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let t = Date.parse("2026-11-17T10:00:00Z");
  const ctx: BoardCtx = { paths, repo: "o/r", now: () => new Date(t), log: (r) => logs.push(r), telegram: telegram ? { sendReply: async (x) => (sent.push(x), 1) } : null };
  return { paths, ctx, sent, logs, advance: (h: number) => (t += h * 3_600_000) };
}
const events = (paths: ReturnType<typeof statePaths>, kind: string) =>
  readdirSync(paths.events).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(paths.events, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((e) => e.kind === kind);

describe("firmware paths (spec 070 AC-1, AC-5)", () => {
  it("matches a firmware PR by its files and a spec by its interfaces", () => {
    expect(isFirmwarePr(["README.md", "firmware/main/app.c"], ["firmware/**"])).toBe(true);
    expect(isFirmwarePr(["web/a.ts"], ["firmware/**"])).toBe(false);
    expect(specNamesFirmwarePath(["firmware/main/app.c"], ["firmware/**"])).toBe(true);
    expect(specNamesFirmwarePath(["tools/x.ts"], ["firmware/**"])).toBe(false);
  });
});

describe("HIL results (AC-2)", () => {
  it("validates the output and reports the first error", () => {
    expect(parseHilOutput(JSON.stringify(hil())).ok).toBe(true);
    const bad = parseHilOutput(JSON.stringify({ outcome: "pass" }));
    expect(bad.ok).toBe(false);
    expect(parseHilOutput("not json").ok).toBe(false);
  });
  it("builds fix lines: failed tests, then the last 200 log lines", () => {
    const log = Array.from({ length: 250 }, (_, i) => `l${i}`).join("\n");
    const lines = hilFixLines(hil({ outcome: "fail", tests: [{ name: "claim", status: "fail", duration_ms: 1, message: "timeout" }, { name: "x", status: "pass", duration_ms: 1 }], log })).split("\n");
    expect(lines[0]).toBe("claim: timeout");
    expect(lines).toHaveLength(201);
    expect(lines[1]).toBe("l50");
  });
  const run = (over: Record<string, unknown>) => ({ id: 1, name: "hil", status: "completed", conclusion: "success", completed_at: "t", html_url: "", output_text: JSON.stringify(hil()), ...over });
  it("reads the verdict of the latest HIL run", () => {
    expect(hilVerdict([]).state).toBe("pending");
    expect(hilVerdict([run({ status: "in_progress" })]).state).toBe("pending");
    expect(hilVerdict([run({})]).state).toBe("passed");
    expect(hilVerdict([run({ conclusion: "failure", output_text: JSON.stringify(hil({ outcome: "fail" })) })]).state).toBe("failed");
    expect(hilVerdict([run({ conclusion: "failure", output_text: JSON.stringify(hil({ outcome: "bricked" })) })]).state).toBe("board");
    const invalid = hilVerdict([run({ output_text: "{}" })]);
    expect(invalid.state === "failed" && invalid.lines).toMatch(/^HIL result invalid: /);
  });
});

describe("the board (AC-4, AC-7)", () => {
  it("reads unknown without a file, and ok is set from unknown by a result that sees the board", async () => {
    const w = await world();
    expect((await readBoard(w.paths)).status).toBe("unknown");
    await applyHilToBoard(w.ctx, hil(), 5);
    expect((await readBoard(w.paths)).status).toBe("ok");
    expect(events(w.paths, "board.changed")).toHaveLength(1);
  });
  it("a brick is announced once, with the steps, and only the maintainer's confirmation clears it", async () => {
    const w = await world();
    await applyHilToBoard(w.ctx, hil({ outcome: "bricked", reason: "no boot banner", board: { status: "bricked" } }), 9, 12);
    await applyHilToBoard(w.ctx, hil({ outcome: "bricked", board: { status: "bricked" } }), 10, 12);
    await applyHilToBoard(w.ctx, hil(), 11);
    await applyHilToBoard(w.ctx, hil({ outcome: "absent", board: { status: "absent" } }), 12);
    expect((await readBoard(w.paths)).status).toBe("bricked");
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toContain("hold BOOT".replace("hold", "Hold"));
    expect(w.sent[0]).toContain("When the board is back, run `panelator-scheduler board back` on the laptop. Firmware work waits until then; other work continues.");
    expect(w.logs.filter((l) => l.kind === "board-alert")).toHaveLength(1);
    expect(events(w.paths, "maintainer.contact")[0].payload).toMatchObject({ channel: "telegram", label: "board-bricked" });
    const back = await confirmBack(w.ctx);
    expect(back.changed).toBe(true);
    expect(back.state).toMatchObject({ status: "ok", confirmed_by: "maintainer" });
    expect((await confirmBack(w.ctx)).changed).toBe(false);
  });
  it("an absent board clears itself when a later result sees it, and the log carries the alert without Telegram", async () => {
    const w = await world(false);
    await applyHilToBoard(w.ctx, hil({ outcome: "absent", board: { status: "absent" } }), 3);
    expect((await readBoard(w.paths)).status).toBe("absent");
    expect(w.logs.some((l) => l.kind === "board-alert" && /USB cable to the laptop/.test(String(l.text)))).toBe(true);
    expect(events(w.paths, "maintainer.contact")[0].payload.channel).toBe("log");
    await applyHilToBoard(w.ctx, hil({ kind: "soak" }), 4);
    expect((await readBoard(w.paths)).status).toBe("ok");
  });
  it("sends one reminder after 24 hours, and no more; a hand-set brick follows the same path", async () => {
    const w = await world();
    await markBricked(w.ctx, "unplugged by hand");
    w.advance(23);
    await remindBoard(w.ctx);
    expect(w.sent).toHaveLength(1);
    w.advance(2);
    await remindBoard(w.ctx);
    await remindBoard(w.ctx);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]).toBe(w.sent[0]);
  });
});

import { mkdirSync, writeFileSync } from "node:fs";
import { firmwareGate, markHilRead } from "../src/firmware/gate.ts";
import { loadConfig, defaultConfigPath } from "../src/config.ts";
import type { CheckRunDetail } from "../src/github/types.ts";

describe("the gate of verify (AC-2, AC-3, AC-5)", () => {
  const cfg = loadConfig(defaultConfigPath);
  const run = (id: number, r: HilResult | null, over: Partial<CheckRunDetail> = {}): CheckRunDetail =>
    ({ id, name: "hil", status: "completed", conclusion: r?.outcome === "pass" ? "success" : "failure", completed_at: "t", html_url: "", output_text: r ? JSON.stringify(r) : null, ...over });
  async function gateWorld(runs: CheckRunDetail[], workflow = true) {
    const w = await world();
    const worktree = mkdtempSync(join(tmpdir(), "wt-"));
    if (workflow) {
      mkdirSync(join(worktree, ".github", "workflows"), { recursive: true });
      writeFileSync(join(worktree, ".github", "workflows", "hil.yml"), "name: hil\n");
    }
    const deps = { cfg, paths: w.paths, gh: { checkRunsNamed: async () => runs }, now: w.ctx.now, board: w.ctx };
    const args = { worktree, head: "h".repeat(40), pr: 9, files: ["firmware/a.c"], sensitive: false, mainSha: async () => "m".repeat(40) };
    return { w, deps, args };
  }
  it("is not involved for a PR without firmware files", async () => {
    const { deps, args } = await gateWorld([]);
    expect(await firmwareGate(deps, { ...args, files: ["web/a.ts"] })).toEqual({ kind: "none" });
  });
  it("blocks on a missing HIL workflow, naming the firmware files", async () => {
    const { deps, args } = await gateWorld([], false);
    expect(await firmwareGate(deps, args)).toMatchObject({ kind: "event", event: { type: "hil_missing", path: ".github/workflows/hil.yml", files: ["firmware/a.c"] } });
  });
  it("waits while the check is absent or running, passes on pass, fails on fail", async () => {
    const absent = await gateWorld([]);
    expect(await firmwareGate(absent.deps, absent.args)).toMatchObject({ kind: "hil", state: "pending" });
    const running = await gateWorld([run(1, null, { status: "in_progress", conclusion: null })]);
    expect(await firmwareGate(running.deps, running.args)).toMatchObject({ state: "pending" });
    const pass = await gateWorld([run(2, hil())]);
    expect(await firmwareGate(pass.deps, pass.args)).toMatchObject({ state: "passed" });
    expect(events(pass.w.paths, "hil.result")).toHaveLength(1);
    expect(events(pass.w.paths, "ci.check")).toHaveLength(1);
    await firmwareGate(pass.deps, pass.args);
    expect(events(pass.w.paths, "hil.result")).toHaveLength(1);
    const fail = await gateWorld([run(3, hil({ outcome: "fail", tests: [{ name: "claim", status: "fail", duration_ms: 1, message: "no frame" }] }))]);
    expect(await firmwareGate(fail.deps, fail.args)).toMatchObject({ state: "failed", log: expect.stringContaining("claim: no frame"), failedId: 3 });
    const bad = await gateWorld([run(4, null, { output_text: "{}" })]);
    expect(await firmwareGate(bad.deps, bad.args)).toMatchObject({ state: "failed", log: expect.stringMatching(/^HIL result invalid/) });
  });
  it("a bricked result sets the board and blocks, counting a brick once; the stale result then waits for the re-run", async () => {
    const g = await gateWorld([run(5, hil({ outcome: "bricked", reason: "no banner", board: { status: "bricked" } }))]);
    expect(await firmwareGate(g.deps, g.args)).toMatchObject({ kind: "event", event: { type: "hil_board", brick: true, runId: 7 } });
    expect((await readBoard(g.w.paths)).status).toBe("bricked");
    expect(g.w.sent).toHaveLength(1);
    // Down: a firmware PR arriving blocks without a brick.
    expect(await firmwareGate(g.deps, g.args)).toMatchObject({ event: { type: "hil_board", brick: false, runId: null } });
    await confirmBack(g.w.ctx);
    expect(await firmwareGate(g.deps, g.args)).toMatchObject({ kind: "hil", state: "pending" });
  });
  it("reads each check run id once", async () => {
    const w = await world();
    expect(await markHilRead(w.paths, 1)).toBe(true);
    expect(await markHilRead(w.paths, 1)).toBe(false);
  });
});

import { promotionStep, demote, type PromoteDeps } from "../src/firmware/promote.ts";
import { readReleases, releaseStep, writeReleases, type FirmwareRelease, type ReleaseDeps } from "../src/firmware/releases.ts";
import { applyAction, KINDS, loadActionLevels, type ActionContext } from "../src/actions/index.ts";
import { ActionLog } from "../src/actions/log.ts";
import { firmwareCommand } from "../src/firmware/commands.ts";
import { agentsDir } from "../src/config.ts";
import { ParameterStore } from "../src/parameters/store.ts";
import { loadParameterDefinitions } from "../src/parameters/definitions.ts";
import { loadRegistry } from "../src/standing/registry.ts";
import { EVENT_NAMES } from "../src/standing/events.ts";
import { registryActionsCheck } from "../src/actions/index.ts";

const R1 = "1".repeat(40), R2 = "2".repeat(40), MAIN = "9".repeat(40);
const T0 = Date.parse("2026-11-17T00:00:00Z");
const iso = (h: number) => new Date(T0 + h * 3_600_000).toISOString();

async function relWorld(opts: { soakHours?: number; enabled?: boolean } = {}) {
  const w = await world();
  let hours = 0;
  const now = () => new Date(T0 + hours * 3_600_000);
  const board = { ...w.ctx, now };
  const releases: { id: number; tag: string; prerelease: boolean; published_at: string; url: string }[] = [];
  const tags: Record<string, string> = {};
  const runs: CheckRunDetail[] = [];
  const edits: { id: number; prerelease: boolean }[] = [];
  const told: string[] = [];
  let listed = 0;
  const gh = {
    listReleases: async () => (listed++, releases),
    resolveTag: async (t: string) => tags[t]!,
    checkRunsNamed: async () => runs,
    setReleasePrerelease: async (id: number, prerelease: boolean) => { edits.push({ id, prerelease }); },
  };
  const onMain = new Set([R1, R2]);
  const rd: ReleaseDeps = { prefix: "firmware-v", hilCheck: "hil", paths: w.paths, gh, now, log: (r) => w.logs.push(r), board, onMain: (s) => onMain.has(s), mainHead: () => MAIN };
  const pd: PromoteDeps = {
    paths: w.paths, gh, now, log: (r) => w.logs.push(r), soakMs: (opts.soakHours ?? 72) * 3_600_000, enabled: opts.enabled ?? true,
    isAncestor: (a, b) => a === R1 && b === R2, tell: async (t) => { told.push(t); },
  };
  const publish = (n: number, sha: string, prerelease = true, h = 0) => { releases.push({ id: n, tag: `firmware-v${n}`, prerelease, published_at: iso(h), url: "" }); tags[`firmware-v${n}`] = sha; };
  let nextRun = 100;
  const result = (r: HilResult, h: number, conclusion = r.outcome === "pass" ? "success" : "failure") => {
    runs.push({ id: nextRun++, name: "hil", status: "completed", conclusion, completed_at: iso(h), html_url: "", output_text: JSON.stringify(r) });
  };
  return { w, rd, pd, publish, result, runs, edits, told, listed: () => listed, at: (h: number) => { hours = h; }, onMain };
}
const mainPass = (sha: string) => hil({ kind: "main", sha, board: { firmware_sha: sha } });
const soakPass = (sha: string, over: Partial<HilResult> = {}) => hil({ kind: "soak", sha: MAIN, board: { firmware_sha: sha }, ...over });

describe("releases and promotion (AC-8 to AC-10)", () => {
  it("records a published build once, lists at most every 600 s, and follows the soak to promotion", async () => {
    const x = await relWorld();
    x.publish(1, R1);
    x.result(mainPass(R1), 0);
    expect(await releaseStep(x.rd)).toBe(true);
    expect(await releaseStep(x.rd)).toBe(false);
    expect(x.listed()).toBe(1);
    let [rel] = await readReleases(x.w.paths);
    expect(rel).toMatchObject({ tag: "firmware-v1", sha: R1, channel: "beta", hil: { conclusion: "success" }, soak: { results: 0, clean: true } });
    expect(events(x.w.paths, "firmware.published")).toHaveLength(1);
    for (const h of [13, 40]) { x.result(soakPass(R1), h); x.at(h); await releaseStep(x.rd); }
    expect((await promotionStep(x.pd)).next).toEqual({ tag: "firmware-v1", waiting_on: ["soaked"] });
    expect(x.edits).toEqual([]);
    x.result(soakPass(R1), 73); x.at(73); await releaseStep(x.rd);
    expect(await promotionStep(x.pd)).toEqual({ stable: "firmware-v1", next: null });
    expect(x.edits).toEqual([{ id: 1, prerelease: false }]);
    [rel] = await readReleases(x.w.paths);
    expect(rel).toMatchObject({ channel: "stable", promoted_by: "scheduler", criteria: { hil_passed: true, soaked: true, soak_clean: true, board_ok: true, latest: true, not_demoted: true } });
    expect(events(x.w.paths, "firmware.promoted")).toHaveLength(1);
    expect(x.told).toHaveLength(1);
    await promotionStep(x.pd);
    expect(x.edits).toHaveLength(1);
  });

  it("records an off-main release with no HIL and never promotes it; a release first seen stable is recorded, never edited", async () => {
    const x = await relWorld();
    x.publish(3, "3".repeat(40));
    x.publish(4, R1, false);
    await releaseStep(x.rd);
    const rs = await readReleases(x.w.paths);
    expect(rs.find((r) => r.tag === "firmware-v3")).toMatchObject({ hil: null, soak: null });
    expect(rs.find((r) => r.tag === "firmware-v4")).toMatchObject({ channel: "stable", promoted_by: null });
    expect(x.w.logs.filter((l) => l.kind === "firmware-release-off-main")).toEqual([{ kind: "firmware-release-off-main", tag: "firmware-v3" }]);
    await promotionStep(x.pd);
    expect(x.edits).toEqual([]);
  });

  it("an unprefixed release is ignored", async () => {
    const x = await relWorld();
    x.publish(5, R1);
    x.rd.prefix = "other-";
    await releaseStep(x.rd);
    expect(await readReleases(x.w.paths)).toEqual([]);
  });

  const base = (over: Partial<FirmwareRelease> = {}): FirmwareRelease => ({
    tag: "firmware-v1", sha: R1, published_at: iso(0), channel: "beta", hil: { conclusion: "success", check_run_id: 1, at: iso(0) },
    soak: { started_at: iso(0), results: 3, last_at: iso(80), resets: 0, clean: true }, promoted_at: null, promoted_by: null, demoted_at: null, criteria: null, ...over,
  });
  it("each criterion false in turn names itself in waiting_on and edits nothing", async () => {
    const cases: [string, Partial<FirmwareRelease>][] = [
      ["hil_passed", { hil: { conclusion: "failure", check_run_id: 1, at: iso(0) }, soak: null }],
      ["soaked", { soak: { started_at: iso(0), results: 1, last_at: iso(80), resets: 0, clean: true } }],
      ["soak_clean", { soak: { started_at: iso(0), results: 3, last_at: iso(80), resets: 0, clean: false } }],
      ["soak_clean", { soak: { started_at: iso(0), results: 3, last_at: iso(80), resets: 1, clean: true } }],
      ["not_demoted", { demoted_at: iso(50) }],
    ];
    for (const [name, over] of cases) {
      const x = await relWorld();
      await writeReleases(x.w.paths, [base(over)]);
      const line = await promotionStep(x.pd);
      expect(line.next?.waiting_on, name).toContain(name);
      expect(x.edits).toEqual([]);
    }
    // board_ok: the board left ok after the soak began.
    const b = await relWorld();
    await writeReleases(b.w.paths, [base()]);
    b.at(10);
    await applyHilToBoard(b.rd.board, hil(), 1);
    b.at(20);
    await applyHilToBoard(b.rd.board, hil({ outcome: "bricked", board: { status: "bricked" } }), 2);
    b.at(30);
    await confirmBack(b.rd.board);
    expect((await promotionStep(b.pd)).next?.waiting_on).toEqual(["board_ok"]);
    // latest: a newer beta that passed HIL on a descendant commit.
    const l = await relWorld();
    await writeReleases(l.w.paths, [base(), base({ tag: "firmware-v2", sha: R2, published_at: iso(1), soak: null })]);
    expect((await promotionStep(l.pd)).next).toEqual({ tag: "firmware-v2", waiting_on: ["soaked", "soak_clean", "board_ok"] });
    expect(l.edits).toEqual([]);
    expect((await readReleases(l.w.paths))[0]!.criteria?.latest).toBe(false);
  });

  it("a newer build supersedes the older, which is never promoted", async () => {
    const x = await relWorld();
    await writeReleases(x.w.paths, [base(), base({ tag: "firmware-v2", sha: R2, published_at: iso(1) })]);
    x.publish(1, R1); x.publish(2, R2, true, 1);
    x.at(100);
    const board = await applyHilToBoard(x.rd.board, hil(), 1);
    expect(board.status).toBe("ok");
    await promotionStep({ ...x.pd, isAncestor: () => false });
    const rs = await readReleases(x.w.paths);
    expect(rs.map((r) => [r.tag, r.channel, r.promoted_by])).toEqual([["firmware-v1", "beta", "superseded"], ["firmware-v2", "stable", "scheduler"]]);
    expect(x.edits).toEqual([{ id: 2, prerelease: false }]);
  });

  it("promotion_enabled false evaluates and logs but edits nothing", async () => {
    const x = await relWorld({ enabled: false });
    await writeReleases(x.w.paths, [base()]);
    x.publish(1, R1);
    await applyHilToBoard(x.rd.board, hil(), 1);
    expect(await promotionStep(x.pd)).toEqual({ stable: null, next: { tag: "firmware-v1", waiting_on: [] } });
    expect(x.edits).toEqual([]);
    expect((await readReleases(x.w.paths))[0]!.criteria?.soaked).toBe(true);
  });

  it("a failed release edit is retried and the record is written only after it succeeds", async () => {
    const x = await relWorld();
    await writeReleases(x.w.paths, [base()]);
    x.publish(1, R1);
    await applyHilToBoard(x.rd.board, hil(), 1);
    let fail = true;
    const gh = { ...x.pd.gh, setReleasePrerelease: async (id: number, p: boolean) => { if (fail) throw new Error("403"); await x.pd.gh.setReleasePrerelease(id, p); } };
    await promotionStep({ ...x.pd, gh });
    expect((await readReleases(x.w.paths))[0]!.channel).toBe("beta");
    expect(x.w.logs.some((l) => l.kind === "firmware-promote-failed")).toBe(true);
    fail = false;
    await promotionStep({ ...x.pd, gh });
    expect((await readReleases(x.w.paths))[0]!.channel).toBe("stable");
  });

  it("demotion sets the flag back and the release is never promoted again", async () => {
    const x = await relWorld();
    await writeReleases(x.w.paths, [base({ channel: "stable", promoted_by: "scheduler", promoted_at: iso(81) })]);
    x.publish(1, R1, false);
    await demote(x.pd, "firmware-v1", "regression");
    expect(x.edits).toEqual([{ id: 1, prerelease: true }]);
    const [rel] = await readReleases(x.w.paths);
    expect(rel).toMatchObject({ channel: "beta" });
    expect(rel!.demoted_at).not.toBeNull();
    expect(events(x.w.paths, "firmware.demoted")).toHaveLength(1);
    await applyHilToBoard(x.rd.board, hil(), 1);
    await promotionStep(x.pd);
    expect(x.edits).toHaveLength(1);
  });
});

describe("the maintainer's commands (AC-4, AC-12)", () => {
  async function cmdWorld() {
    const x = await relWorld();
    const defs = loadParameterDefinitions(join(agentsDir, "parameters.yaml"), loadConfig(defaultConfigPath), loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml"))));
    const log = new ActionLog(join(x.w.paths.root, "actions", "log.jsonl"), x.w.paths);
    const levels = loadActionLevels(join(agentsDir, "actions.yaml"));
    const ctx: ActionContext = { paths: x.w.paths, parameters: new ParameterStore(x.w.paths, defs), log, levels, gh: { rerunWorkflowRun: async () => {}, cancelWorkflowRun: async () => {} }, now: x.rd.now, firmware: { board: x.rd.board, promote: x.pd } };
    return { x, ctx, log };
  }
  it("board back is the only way out of bricked, and each command writes one action-log row", async () => {
    const { x, ctx, log } = await cmdWorld();
    expect((await firmwareCommand("board", ["bricked", "unplugged", "it"], ctx)).exitCode).toBe(0);
    expect((await readBoard(x.w.paths)).status).toBe("bricked");
    // A standing agent's request of every kind leaves it bricked.
    for (const kind of Object.keys(levels(ctx))) {
      await applyAction(ctx, { agent: "some-agent", run_id: "r", kind, args: {}, why: "a standing agent trying every kind in turn" }, Object.keys(KINDS));
      await applyAction(ctx, { agent: "some-agent", run_id: "r", kind, args: { tag: "firmware-v1", reason: "trying it out", name: "x" }, why: "a standing agent trying every kind in turn" }, Object.keys(KINDS));
    }
    expect((await readBoard(x.w.paths)).status).toBe("bricked");
    expect((await firmwareCommand("board", ["back"], ctx)).exitCode).toBe(0);
    expect((await readBoard(x.w.paths)).status).toBe("ok");
    const again = await firmwareCommand("board", ["back"], ctx);
    expect(again.lines[0]).toMatch(/nothing changed/);
    const rows = (await log.list()).filter((r) => r.agent === "maintainer");
    expect(rows.map((r) => [r.kind, r.args])).toEqual([["board_bricked", { reason: "unplugged it" }], ["board_back", {}]]);
    expect(JSON.parse((await firmwareCommand("board", [], ctx)).lines[0]!)).toMatchObject({ status: "ok", confirmed_by: "maintainer" });
    expect((await log.list()).filter((r) => r.agent === "maintainer")).toHaveLength(2);
  });
  it("firmware promote and demote go through the action log; firmware alone writes nothing", async () => {
    const { x, ctx, log } = await cmdWorld();
    await writeReleases(x.w.paths, [{ tag: "firmware-v1", sha: R1, published_at: iso(0), channel: "beta", hil: null, soak: null, promoted_at: null, promoted_by: null, demoted_at: null, criteria: null }]);
    x.publish(1, R1);
    expect((await firmwareCommand("firmware", ["promote", "firmware-v9"], ctx)).exitCode).toBe(1);
    expect((await firmwareCommand("firmware", ["promote", "firmware-v1"], ctx)).exitCode).toBe(0);
    expect((await readReleases(x.w.paths))[0]).toMatchObject({ channel: "stable", promoted_by: "maintainer" });
    expect((await firmwareCommand("firmware", ["demote", "firmware-v1", "bad", "boot"], ctx)).exitCode).toBe(0);
    expect((await readReleases(x.w.paths))[0]).toMatchObject({ channel: "beta" });
    await firmwareCommand("firmware", [], ctx);
    const rows = (await log.list()).filter((r) => r.status === "applied");
    expect(rows.map((r) => [r.agent, r.kind, r.args])).toEqual([["maintainer", "firmware_promote", { tag: "firmware-v1" }], ["maintainer", "firmware_demote", { tag: "firmware-v1", reason: "bad boot" }]]);
  });
});
const levels = (ctx: ActionContext) => ctx.levels;
