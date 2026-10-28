import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMerge } from "../src/state/merges.ts";
import { openIndex } from "../src/events/index.ts";
import { savePatch } from "../src/state/patches.ts";
import { initialChainState } from "../src/chain/machine.ts";
import { listClaims, readClaim, removeClaim, touchClaim, writeClaim } from "../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { newRunId, pruneUsage, runDir, writeUsageRecord, type UsageRecord } from "../src/state/runs.ts";
import { readToken, writeToken } from "../src/state/token.ts";

function fresh() {
  return statePaths(mkdtempSync(join(tmpdir(), "state-")));
}

describe("statePaths", () => {
  it("lays out spec section 11", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    for (const d of [p.claims, p.runs, p.usage, p.patches, p.findingsRejected, p.log, p.worktrees]) expect(statSync(d).isDirectory()).toBe(true);
    expect(p.findingsQueue).toBe(join(p.root, "findings", "queue.jsonl"));
    expect(p.token).toBe(join(p.root, "token.json"));
    for (const d of [p.paused, p.escalations, join(p.root, "questions")]) expect(statSync(d).isDirectory()).toBe(true);
    expect(p.questionsLog).toBe(join(p.root, "questions", "log.jsonl"));
  });
});

describe("claims", () => {
  it("writes, reads, lists, touches and removes", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    const c = { issue: 7, slot: 0, state: initialChainState(7), worktree: "/w/7", started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T00:00:00Z", run_id: null };
    await writeClaim(p, c);
    expect(await readClaim(p, 7)).toEqual(c);
    expect(await readClaim(p, 8)).toBeNull();
    expect((await listClaims(p)).map((x) => x.issue)).toEqual([7]);
    const t = await touchClaim(p, 7, { run_id: "r1" });
    expect(t.run_id).toBe("r1");
    expect(t.last_activity_at > c.last_activity_at).toBe(true);
    await removeClaim(p, 7);
    expect(await readClaim(p, 7)).toBeNull();
  });
  it("reads a pre-006 claim, normalised, and can rewrite it", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    const { track: _t, rescues: _r, specRescues: _a, replans: _b, specRevisions: _c, specAnswers: _d, decideReturns: _e, history: _h, ...old } = initialChainState(7);
    const raw = { issue: 7, slot: 0, state: { ...old, securityFinding: null }, worktree: "/w/7", started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T00:00:00Z", run_id: null };
    writeFileSync(join(p.claims, "7.json"), JSON.stringify(raw));
    for (const got of [await readClaim(p, 7), (await listClaims(p))[0]]) {
      expect(got?.state.track).toBe("issue");
      expect(got?.state.rescues).toBe(0);
      expect(got?.state.history).toEqual([]);
      expect(got?.state && "securityFinding" in got.state).toBe(false);
    }
    await writeClaim(p, (await readClaim(p, 7))!);
  });
  it("round-trips pendingEvent and pendingActions", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    const c = {
      issue: 7, slot: 0, state: initialChainState(7), worktree: "/w/7", started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T00:00:00Z", run_id: null,
      pendingEvent: { type: "answered" as const, answer: "A", questionId: 100 },
      pendingActions: [{ type: "wait" as const, seconds: 5 }],
    };
    await writeClaim(p, c);
    expect(await readClaim(p, 7)).toEqual(c);
  });
  it("rejects an invalid claim", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    await expect(writeClaim(p, { issue: 0 } as never)).rejects.toThrow(/claim/);
  });
});

describe("runs and usage", () => {
  const rec: UsageRecord = {
    run_id: "7-plan-1-20261012T000000", issue: 7, stage: "plan", attempt: 1, outcome: "ok", harness: "fake", model: "fake",
    cost_usd: null, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0,
    wall_seconds: 1, started_at: "2026-10-12T00:00:00Z", ended_at: "2026-10-12T00:00:01Z", events_path: "runs/x/events.jsonl",
  };
  it("builds run ids and dirs", () => {
    expect(newRunId(7, "plan", 1, new Date("2026-10-12T01:02:03Z"))).toBe("7-plan-1-20261012T010203");
    expect(runDir(fresh(), "r")).toMatch(/runs\/r$/);
  });
  it("writes a validated usage record to both places", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    await writeUsageRecord(p, rec);
    expect(JSON.parse(readFileSync(join(p.usage, `${rec.run_id}.json`), "utf8"))).toEqual(rec);
    expect(JSON.parse(readFileSync(join(runDir(p, rec.run_id), "usage.json"), "utf8"))).toEqual(rec);
    await expect(writeUsageRecord(p, { ...rec, turns: "x" } as never)).rejects.toThrow(/usage/);
  });
  it("prunes usage records older than the retention", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    await writeUsageRecord(p, rec);
    await writeUsageRecord(p, { ...rec, run_id: "7-plan-2-20261012T000000", ended_at: "2026-01-01T00:00:00Z" });
    expect(await pruneUsage(p, new Date("2026-10-12T00:00:00Z"))).toBe(1);
  });
  it("skips unreadable usage files when pruning", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    await writeUsageRecord(p, rec);
    writeFileSync(join(p.usage, "garbage.json"), "not json");
    expect(await pruneUsage(p, new Date("2030-01-01T00:00:00Z"))).toBe(1);
    expect(existsSync(join(p.usage, "garbage.json"))).toBe(true);
  });
});

describe("merge records", () => {
  it("records one raw merge beside the existing merge log write", async () => {
    const p = fresh(); await ensureStateDirs(p);
    const m = { issue: 7, pr: 22, cls: "debt" as const, work: "system" as const, at: "2026-10-12T00:00:00.000Z" };
    await appendMerge(p, m);
    expect(readFileSync(join(p.root, "merges.jsonl"), "utf8")).toBe(JSON.stringify(m) + "\n");
    const db = openIndex(p);
    const rows = db.prepare("SELECT issue, payload FROM events WHERE kind = 'merge'").all();
    expect(rows).toHaveLength(1); expect(rows[0]!.issue).toBe(7);
    expect(JSON.parse(String(rows[0]!.payload))).toEqual(m); db.close();
  });
});

describe("token file", () => {
  it("round-trips with 0600 and returns null when absent", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    expect(await readToken(p)).toBeNull();
    await writeToken(p, { token: "ghs_x", expires_at: "2026-10-12T01:00:00Z" });
    expect(await readToken(p)).toEqual({ token: "ghs_x", expires_at: "2026-10-12T01:00:00Z" });
    expect(statSync(p.token).mode & 0o777).toBe(0o600);
  });
});

describe("savePatch", () => {
  it("never overwrites: a kind suffix separates same-second saves and a true collision gets a numeric suffix (spec 005 review)", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "patches-")));
    await ensureStateDirs(p);
    const now = new Date("2026-10-16T12:00:00Z");
    const a = await savePatch(p, 7, "diff a\n", now, "uncommitted");
    const b = await savePatch(p, 7, "diff b\n", now, "commits");
    const c = await savePatch(p, 7, "diff c\n", now, "commits");
    const d = await savePatch(p, 7, "diff d\n", now);
    expect([a, b, c, d].map((x) => basename(x!))).toEqual(["7-20261016T120000-uncommitted.patch", "7-20261016T120000-commits.patch", "7-20261016T120000-commits-1.patch", "7-20261016T120000.patch"]);
    expect(readFileSync(a!, "utf8")).toBe("diff a\n");
    expect(readFileSync(b!, "utf8")).toBe("diff b\n");
    expect(readFileSync(c!, "utf8")).toBe("diff c\n");
    expect(await savePatch(p, 7, "  \n", now)).toBeNull();
  });
});
