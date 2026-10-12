import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
