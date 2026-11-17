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
