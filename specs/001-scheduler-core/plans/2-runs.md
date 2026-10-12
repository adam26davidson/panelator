# Spec 001, Plan 2 of 3: Runs (state directory, adapters, runner, token plumbing)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything needed to run one agent stage and record it: the state directory, the three adapters (claude, pi, fake) with success judgement and usage extraction from recorded event streams, the runner that owns the process (worktree, timeout, process-group kill, systemd scope, result collection, schema validation, usage record, findings queue), the fallback policy, and the token plumbing that keeps the App token out of agents' hands.

**Architecture:** Adapters are pure over the event stream: `buildCommand(StageRun)` returns argv and env, `judge(events, exit)` returns an outcome, `usage(events)` returns token counts. The runner is the only module that spawns; it is tested with the fake adapter and a tiny throwaway script, never with a real harness. The state directory is plain files (spec section 11) behind small functions with temp-dir tests.

**Tech Stack:** Node 26 `child_process.spawn` (`detached: true` for process groups), `node:fs/promises`, git CLI, `systemd-run --user --scope` (injectable), vitest.

**Spec:** `specs/001-scheduler-core/spec.md`. Plan 1 (`plans/1-core.md`) must be complete first: this plan imports `types.ts`, `schema/validate.ts`, `config.ts`, `stages/*`, `profiles/*`, `gates/*`.

## Global Constraints

- Same as plan 1: pnpm, `pnpm test` from the root before done, commit on the given branch, no push, ESM TypeScript with `.ts` imports, `erasableSyntaxOnly`.
- Adapters are tested only against fixtures; real harness invocations happen once, by hand, in plan 3 (spec section 17).
- Real `claude` or `pi` is never on the PATH a test uses. The runner tests use `node` and a fixture script.
- Agents never handle tokens (spec section 12): the token lives in `token.json` in the state directory, read only by the gh shim and the git credential helper.
- The pi adapter reads stdout continuously (03 F9); the runner streams events to `events.jsonl` as they arrive.
- Recorded on 2026-10-12 with Claude Code 2.1.287 and pi 1.0.0: the fixture shapes below are real field names, trimmed.

## Review Focus

1. **A Claude `result` event whose `subtype` is `error_max_turns` or `error_max_budget_usd` with `is_error: true`**: outcome must be `bounds`, not `failed`, so the chain and the usage record distinguish bound hits from crashes. Pinned in Task 4.
2. **A stage that writes a result file and then keeps running until the timeout**: the run is `timeout`, and the result file is not trusted. Pinned in Task 7.
3. **A stage whose process spawns a grandchild that ignores SIGTERM**: the process-group SIGKILL after the grace period must reap it (AC-23). Pinned in Task 6.
4. **A findings array where one record is valid and one is not**: the valid one is queued, the invalid one lands in `rejected/`, and the run still counts as `ok` (AC-28). Pinned in Task 3.
5. **An events file where the last line is a partial JSON record (process killed mid-write)**: the JSONL reader yields the complete records and reports one malformed tail, never throws away the run. Pinned in Task 4.

## File structure

```
tools/scheduler/
  src/
    state/paths.ts          StatePaths: all directories/files of spec section 11 from a root
    state/claims.ts         readClaim, writeClaim, listClaims, removeClaim, touchClaim
    state/runs.ts           newRunId, runDir, writeUsageRecord, readUsageRecord
    state/findings.ts       appendFindings(paths, envelope, findings[]) -> {queued, rejected}
    state/patches.ts        savePatch(paths, issue, diffText) -> path
    state/token.ts          readToken(paths) -> {token, expires_at} | null; writeToken
    adapters/types.ts       StageRun, RunOutcome, Usage, Adapter, Judgement
    adapters/jsonl.ts       splitJsonl(buffer) streaming splitter + readJsonlFile
    adapters/claude.ts      claudeAdapter
    adapters/pi.ts          piAdapter
    adapters/fake.ts        fakeAdapter(fixtureEvents, cannedResult)
    adapters/index.ts       adapterFor(harness)
    runner/retry.ts         retryDecision(def, failure, costSoFar, limit) -> {kind: "none"|"fallback"|"postpone", model?}
    runner/worktree.ts      ensureWorktree, rebaseOntoMain, removeWorktree, diffFilesAgainstMain, uncommittedPatch
    runner/process.ts       spawnBounded({argv, env, cwd, timeoutMs, onStdoutLine, scope}) -> {exitCode, signal, timedOut}
    runner/run.ts           runStage(ctx, def, input, options) -> StageOutcome
    runner/skills.ts        linkProfileSkills(worktree, harness, profile)
  bin/
    gh                      shell shim: GH_TOKEN from token.json, exec real gh
    git-credential-panelator.ts  git credential helper reading token.json
  test/
    fixtures/streams/claude-success.jsonl, claude-is-error.jsonl, claude-plugin-errors.jsonl,
                     claude-max-turns.jsonl, claude-429.jsonl, claude-partial-tail.jsonl,
                     pi-success.jsonl, pi-error-exit0.jsonl, pi-tool-calls.jsonl
    fixtures/stage-script.ts   the throwaway "harness" the runner tests spawn
    state.test.ts, jsonl.test.ts, adapters-claude.test.ts, adapters-pi.test.ts, adapters-fake.test.ts,
    retry.test.ts, worktree.test.ts, process.test.ts, run.test.ts, token.test.ts
```

---

### Task 1: State directory paths, claims, run ids, usage records, token file

**Files:**
- Create: `tools/scheduler/src/state/paths.ts`, `claims.ts`, `runs.ts`, `token.ts`
- Test: `tools/scheduler/test/state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface StatePaths {
    root: string; claims: string; runs: string; usage: string; patches: string;
    findingsQueue: string; findingsRejected: string; token: string; log: string; serviceLog: string; worktrees: string;
  }
  function statePaths(root: string): StatePaths
  async function ensureStateDirs(p: StatePaths): Promise<void>
  interface Claim { issue: number; slot: number; state: ChainState; worktree: string; started_at: string; last_activity_at: string; run_id: string | null }
  async function writeClaim(p, claim): Promise<void>      // validates against claim.json, atomic rename
  async function readClaim(p, issue): Promise<Claim | null>
  async function listClaims(p): Promise<Claim[]>
  async function removeClaim(p, issue): Promise<void>
  async function touchClaim(p, issue, patch: Partial<Claim>): Promise<Claim>
  function newRunId(issue: number, stage: string, attempt: number, now?: Date): string   // "<issue>-<stage>-<attempt>-<yyyymmddThhmmss>"
  function runDir(p, runId): string
  async function writeUsageRecord(p, rec: UsageRecord): Promise<void>  // validates; writes usage/<run>.json and runs/<run>/usage.json
  async function pruneUsage(p, now: Date, retentionDays = 180): Promise<number>
  interface TokenFile { token: string; expires_at: string }
  async function readToken(p): Promise<TokenFile | null>; async function writeToken(p, t): Promise<void>  // mode 0600
  ```
  `UsageRecord` is the TypeScript shape of `usage-record.json` (define it in `state/runs.ts` and export).

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/state.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/state.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/state/paths.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface StatePaths {
  root: string;
  claims: string;
  runs: string;
  usage: string;
  patches: string;
  findingsQueue: string;
  findingsRejected: string;
  token: string;
  log: string;
  serviceLog: string;
  worktrees: string;
}

export function statePaths(root: string): StatePaths {
  return {
    root,
    claims: join(root, "claims"),
    runs: join(root, "runs"),
    usage: join(root, "usage"),
    patches: join(root, "patches"),
    findingsQueue: join(root, "findings", "queue.jsonl"),
    findingsRejected: join(root, "findings", "rejected"),
    token: join(root, "token.json"),
    log: join(root, "log"),
    serviceLog: join(root, "log", "service.jsonl"),
    worktrees: join(root, "worktrees"),
  };
}

export async function ensureStateDirs(p: StatePaths): Promise<void> {
  for (const d of [p.claims, p.runs, p.usage, p.patches, p.findingsRejected, p.log, p.worktrees]) await mkdir(d, { recursive: true });
}
```

`tools/scheduler/src/state/claims.ts`:

```ts
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChainState } from "../chain/types.ts";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "./paths.ts";

export interface Claim {
  issue: number;
  slot: number;
  state: ChainState;
  worktree: string;
  started_at: string;
  last_activity_at: string;
  run_id: string | null;
}

const file = (p: StatePaths, issue: number) => join(p.claims, `${issue}.json`);

export async function writeClaim(p: StatePaths, claim: Claim): Promise<void> {
  const v = validate("claim", claim);
  if (!v.ok) throw new Error(`invalid claim: ${v.errors.join("; ")}`);
  const tmp = file(p, claim.issue) + ".tmp";
  await writeFile(tmp, JSON.stringify(claim, null, 2));
  await rename(tmp, file(p, claim.issue));
}

export async function readClaim(p: StatePaths, issue: number): Promise<Claim | null> {
  try {
    return JSON.parse(await readFile(file(p, issue), "utf8")) as Claim;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function listClaims(p: StatePaths): Promise<Claim[]> {
  const names = (await readdir(p.claims)).filter((n) => /^\d+\.json$/.test(n));
  const out: Claim[] = [];
  for (const n of names) out.push(JSON.parse(await readFile(join(p.claims, n), "utf8")) as Claim);
  return out.sort((a, b) => a.issue - b.issue);
}

export async function removeClaim(p: StatePaths, issue: number): Promise<void> {
  await unlink(file(p, issue)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}

export async function touchClaim(p: StatePaths, issue: number, patch: Partial<Claim>): Promise<Claim> {
  const c = await readClaim(p, issue);
  if (!c) throw new Error(`no claim for issue ${issue}`);
  const next = { ...c, ...patch, last_activity_at: new Date().toISOString() };
  await writeClaim(p, next);
  return next;
}
```

`tools/scheduler/src/state/runs.ts`:

```ts
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "../schema/validate.ts";
import type { AgentStageName, Harness } from "../types.ts";
import type { StatePaths } from "./paths.ts";

export type RunOutcome = "ok" | "failed" | "timeout" | "bounds";

export interface UsageRecord {
  run_id: string;
  issue: number;
  stage: AgentStageName;
  attempt: number;
  outcome: RunOutcome;
  harness: Harness;
  model: string;
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  turns: number;
  tool_calls: number;
  wall_seconds: number;
  started_at: string;
  ended_at: string;
  events_path: string;
}

export function newRunId(issue: number, stage: string, attempt: number, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  return `${issue}-${stage}-${attempt}-${ts}`;
}

export function runDir(p: StatePaths, runId: string): string {
  return join(p.runs, runId);
}

export async function writeUsageRecord(p: StatePaths, rec: UsageRecord): Promise<void> {
  const v = validate("usage-record", rec);
  if (!v.ok) throw new Error(`invalid usage record: ${v.errors.join("; ")}`);
  await mkdir(runDir(p, rec.run_id), { recursive: true });
  const text = JSON.stringify(rec, null, 2);
  await writeFile(join(p.usage, `${rec.run_id}.json`), text);
  await writeFile(join(runDir(p, rec.run_id), "usage.json"), text);
}

export async function readUsageRecord(p: StatePaths, runId: string): Promise<UsageRecord | null> {
  try {
    return JSON.parse(await readFile(join(p.usage, `${runId}.json`), "utf8")) as UsageRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** 180-day retention (spec section 11). Returns the number of records removed. */
export async function pruneUsage(p: StatePaths, now: Date, retentionDays = 180): Promise<number> {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  for (const n of await readdir(p.usage)) {
    if (!n.endsWith(".json")) continue;
    const rec = JSON.parse(await readFile(join(p.usage, n), "utf8")) as UsageRecord;
    if (new Date(rec.ended_at).getTime() < cutoff) {
      await unlink(join(p.usage, n));
      removed++;
    }
  }
  return removed;
}
```

`tools/scheduler/src/state/token.ts`:

```ts
import { readFile, rename, writeFile } from "node:fs/promises";
import type { StatePaths } from "./paths.ts";

export interface TokenFile {
  token: string;
  expires_at: string;
}

export async function readToken(p: StatePaths): Promise<TokenFile | null> {
  try {
    const t = JSON.parse(await readFile(p.token, "utf8")) as TokenFile;
    return typeof t.token === "string" && typeof t.expires_at === "string" ? t : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeToken(p: StatePaths, t: TokenFile): Promise<void> {
  const tmp = p.token + ".tmp";
  await writeFile(tmp, JSON.stringify(t), { mode: 0o600 });
  await rename(tmp, p.token);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/state.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/state tools/scheduler/test/state.test.ts
git commit -m "scheduler: state directory layout, claims, usage records, token file (spec section 11)"
```

---

### Task 2: Patches and findings queue

**Files:**
- Create: `tools/scheduler/src/state/patches.ts`, `tools/scheduler/src/state/findings.ts`
- Test: `tools/scheduler/test/findings.test.ts`

**Interfaces:**
- Produces: `savePatch(p: StatePaths, issue: number, diffText: string, now?: Date): Promise<string | null>` (null when `diffText` is empty; file `patches/<issue>-<yyyymmddThhmmss>.patch`).
- Produces:
  ```ts
  interface FindingEnvelope { issue: number; stage: AgentStageName; run_id: string; timestamp: string }
  async function appendFindings(p: StatePaths, env: FindingEnvelope, findings: unknown[]): Promise<{ queued: number; rejected: string[] }>
  ```
  Each valid finding is one JSONL line `{...envelope, finding}` in `findings/queue.jsonl`. Each invalid one is written to `findings/rejected/<run_id>-<index>.json` as `{ envelope, finding, errors }`.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/findings.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendFindings } from "../src/state/findings.ts";
import { savePatch } from "../src/state/patches.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

const env = { issue: 7, stage: "implement" as const, run_id: "7-implement-1-x", timestamp: "2026-10-12T00:00:00Z" };
const good = { what: "w", where: "x.ts:1", evidence: "e", noticed_how: "n" };

describe("appendFindings (AC-28)", () => {
  it("queues valid records with the envelope and keeps invalid ones in rejected/ (review focus 4)", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "f-")));
    await ensureStateDirs(p);
    const r = await appendFindings(p, env, [good, { what: "no where" }]);
    expect(r.queued).toBe(1);
    expect(r.rejected).toHaveLength(1);
    const lines = readFileSync(p.findingsQueue, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toEqual({ ...env, finding: good });
    const rejected = readdirSync(p.findingsRejected);
    expect(rejected).toEqual(["7-implement-1-x-1.json"]);
    expect(JSON.parse(readFileSync(join(p.findingsRejected, rejected[0]), "utf8"))).toMatchObject({ envelope: env, errors: expect.any(Array) });
  });
  it("is a no-op for an empty list and does not create the queue file", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "f-")));
    await ensureStateDirs(p);
    expect(await appendFindings(p, env, [])).toEqual({ queued: 0, rejected: [] });
    expect(() => readFileSync(p.findingsQueue)).toThrow();
  });
});

describe("savePatch (AC-15)", () => {
  it("writes the diff with the issue and timestamp in the name, or null for an empty diff", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "p-")));
    await ensureStateDirs(p);
    const path = await savePatch(p, 7, "diff --git a/x b/x\n", new Date("2026-10-12T01:02:03Z"));
    expect(path?.endsWith("patches/7-20261012T010203.patch")).toBe(true);
    expect(await savePatch(p, 7, "", new Date())).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/findings.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/state/patches.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StatePaths } from "./paths.ts";

export async function savePatch(p: StatePaths, issue: number, diffText: string, now: Date = new Date()): Promise<string | null> {
  if (!diffText.trim()) return null;
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const path = join(p.patches, `${issue}-${ts}.patch`);
  await writeFile(path, diffText);
  return path;
}
```

`tools/scheduler/src/state/findings.ts`:

```ts
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "../schema/validate.ts";
import type { AgentStageName } from "../types.ts";
import type { StatePaths } from "./paths.ts";

export interface FindingEnvelope {
  issue: number;
  stage: AgentStageName;
  run_id: string;
  timestamp: string;
}

export async function appendFindings(p: StatePaths, env: FindingEnvelope, findings: unknown[]): Promise<{ queued: number; rejected: string[] }> {
  let queued = 0;
  const rejected: string[] = [];
  let lines = "";
  for (const [i, finding] of findings.entries()) {
    const v = validate("finding", finding);
    if (v.ok) {
      lines += JSON.stringify({ ...env, finding }) + "\n";
      queued++;
    } else {
      const path = join(p.findingsRejected, `${env.run_id}-${i}.json`);
      await writeFile(path, JSON.stringify({ envelope: env, finding, errors: v.errors }, null, 2));
      rejected.push(path);
    }
  }
  if (lines) await appendFile(p.findingsQueue, lines);
  return { queued, rejected };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/findings.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/state/patches.ts tools/scheduler/src/state/findings.ts tools/scheduler/test/findings.test.ts
git commit -m "scheduler: findings queue with rejected/ and release patches (AC-15, AC-28)"
```

---

### Task 3: Adapter types, JSONL splitter, recorded fixtures

**Files:**
- Create: `tools/scheduler/src/adapters/types.ts`, `tools/scheduler/src/adapters/jsonl.ts`
- Create: `tools/scheduler/test/fixtures/streams/*.jsonl` (nine files, contents below)
- Test: `tools/scheduler/test/jsonl.test.ts`

**Interfaces:**
- Produces (`adapters/types.ts`):
  ```ts
  interface StageRun {
    runId: string; stage: AgentStageName; attempt: number; issue: number;
    prompt: string; model: string; bounds: Bounds; worktree: string; sessionId: string; resultPath: string;
    profile: Profile | null; effort?: string;
  }
  interface Usage { cost_usd: number | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; turns: number; tool_calls: number }
  interface Judgement { outcome: RunOutcome; reason: string | null; apiErrorStatus: number | null; finalText: string | null }
  interface Command { argv: string[]; env: Record<string, string> }
  interface Adapter {
    harness: Harness;
    buildCommand(run: StageRun): Command;
    judge(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement;
    usage(events: unknown[]): Usage;
  }
  ```
- Produces (`adapters/jsonl.ts`): `class JsonlSplitter { push(chunk: Buffer | string): unknown[]; end(): { records: unknown[]; malformed: string[] } }` (LF framing only, strips a trailing CR; a line that is not JSON is reported in `malformed`, never thrown); `readJsonlFile(path): Promise<{ records: unknown[]; malformed: string[] }>`.

- [ ] **Step 1: Write the fixtures**

These are trimmed from real runs. Keep each on one line per record exactly as shown.

`tools/scheduler/test/fixtures/streams/claude-success.jsonl`:

```
{"type":"system","subtype":"init","cwd":"/w","session_id":"11111111-1111-4111-8111-111111111111","model":"claude-haiku-4-5-20251001","permissionMode":"dontAsk","claude_code_version":"2.1.287","plugins":[],"mcp_servers":[],"uuid":"u1"}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"m1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/w/a.ts"}}],"usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":200,"output_tokens":6}},"session_id":"11111111-1111-4111-8111-111111111111","uuid":"u2"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"session_id":"11111111-1111-4111-8111-111111111111","uuid":"u3"}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"m2","type":"message","role":"assistant","content":[{"type":"text","text":"pong"}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":300,"output_tokens":6}},"session_id":"11111111-1111-4111-8111-111111111111","uuid":"u4"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"},"uuid":"u5","session_id":"11111111-1111-4111-8111-111111111111"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":4946,"duration_api_ms":4825,"num_turns":2,"result":"pong","stop_reason":"end_turn","session_id":"11111111-1111-4111-8111-111111111111","total_cost_usd":0.0246593,"usage":{"input_tokens":20,"cache_creation_input_tokens":100,"cache_read_input_tokens":500,"output_tokens":12},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":20,"outputTokens":12,"cacheReadInputTokens":500,"cacheCreationInputTokens":100,"costUSD":0.0246593,"costBasis":"list"}},"permission_denials":[],"api_error_status":null,"terminal_reason":"completed","uuid":"u6"}
```

`tools/scheduler/test/fixtures/streams/claude-is-error.jsonl`:

```
{"type":"system","subtype":"init","cwd":"/w","session_id":"s","model":"claude-sonnet-5-5","permissionMode":"dontAsk","claude_code_version":"2.1.287","plugins":[],"mcp_servers":[],"uuid":"u1"}
{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":1200,"duration_api_ms":900,"num_turns":1,"result":"Error: Invalid API key","stop_reason":null,"session_id":"s","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"modelUsage":{},"permission_denials":[],"api_error_status":401,"terminal_reason":"error","uuid":"u2"}
```

`tools/scheduler/test/fixtures/streams/claude-plugin-errors.jsonl`:

```
{"type":"system","subtype":"init","cwd":"/w","session_id":"s","model":"claude-sonnet-5-5","permissionMode":"dontAsk","claude_code_version":"2.1.287","plugins":[{"name":"broken","path":"/p","source":"local","version":"1"}],"plugin_errors":[{"plugin":"broken","error":"hooks.json: unexpected token"}],"mcp_servers":[],"mcp_server_errors":[],"uuid":"u1"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":10,"duration_api_ms":5,"num_turns":1,"result":"done","stop_reason":"end_turn","session_id":"s","total_cost_usd":0.01,"usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1},"modelUsage":{},"permission_denials":[],"api_error_status":null,"terminal_reason":"completed","uuid":"u2"}
```

`tools/scheduler/test/fixtures/streams/claude-max-turns.jsonl`:

```
{"type":"system","subtype":"init","cwd":"/w","session_id":"s","model":"claude-sonnet-5-5","permissionMode":"dontAsk","claude_code_version":"2.1.287","plugins":[],"mcp_servers":[],"uuid":"u1"}
{"type":"assistant","message":{"model":"claude-sonnet-5-5","id":"m1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}},"session_id":"s","uuid":"u2"}
{"type":"result","subtype":"error_max_turns","is_error":true,"duration_ms":10,"duration_api_ms":5,"num_turns":3,"result":"Reached max turns (3)","stop_reason":null,"session_id":"s","total_cost_usd":0.5,"usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5},"modelUsage":{},"permission_denials":[],"api_error_status":null,"terminal_reason":"max_turns","uuid":"u3"}
```

`tools/scheduler/test/fixtures/streams/claude-429.jsonl`:

```
{"type":"system","subtype":"init","cwd":"/w","session_id":"s","model":"claude-fable-5-1","permissionMode":"dontAsk","claude_code_version":"2.1.287","plugins":[],"mcp_servers":[],"uuid":"u1"}
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"error_status":429,"error":"rate_limit","session_id":"s","uuid":"u2"}
{"type":"system","subtype":"api_retry","attempt":2,"max_retries":3,"error_status":429,"error":"rate_limit","session_id":"s","uuid":"u3"}
{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":30000,"duration_api_ms":29000,"num_turns":0,"result":"API Error: 429 rate_limit_error","stop_reason":null,"session_id":"s","total_cost_usd":0.02,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"modelUsage":{},"permission_denials":[],"api_error_status":429,"terminal_reason":"error","uuid":"u4"}
```

`tools/scheduler/test/fixtures/streams/claude-partial-tail.jsonl` (the last line intentionally has no closing brace and no trailing newline):

```
{"type":"system","subtype":"init","cwd":"/w","session_id":"s","model":"claude-sonnet-5-5","permissionMode":"dontAsk","claude_code_version":"2.1.287","plugins":[],"mcp_servers":[],"uuid":"u1"}
{"type":"assistant","message":{"model":"claude-sonnet-5-5","id":"m1","type":"message","role":"assistant","content":[{"type":"text","text":"working"}],"usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}},"session_id":"s","uuid":"u2"}
{"type":"assistant","message":{"model":"claude-sonnet-5-5","id":"m2","type":"mess
```

`tools/scheduler/test/fixtures/streams/pi-success.jsonl`:

```
{"type":"session","version":3,"id":"33333333-3333-4333-8333-333333333333","timestamp":"2026-10-12T07:55:37.000Z","cwd":"/w"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word pong and nothing else."}],"timestamp":1791791737000}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word pong and nothing else."}],"timestamp":1791791737000}}
{"type":"message_start","message":{"role":"assistant","content":[],"api":"openai-responses","provider":"openai","model":"gpt-6-astra","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"pending","timestamp":1791791737500}}
{"type":"message_update","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"pong"}}
{"type":"message_update","usage":{"input":525,"output":5,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":530,"cost":{"input":0.00525,"output":0.00025,"cacheRead":0,"cacheWrite":0,"total":0.0055}},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"pong"}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pong"}],"api":"openai-responses","provider":"openai","model":"gpt-6-astra","usage":{"input":525,"output":5,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":530,"cost":{"input":0.00525,"output":0.00025,"cacheRead":0,"cacheWrite":0,"total":0.0055}},"stopReason":"stop","timestamp":1791791757572,"responseId":"resp_1","rawStopReason":"completed","thinkingLevel":"medium"}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"pong"}],"api":"openai-responses","provider":"openai","model":"gpt-6-astra","usage":{"input":525,"output":5,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":530,"cost":{"input":0.00525,"output":0.00025,"cacheRead":0,"cacheWrite":0,"total":0.0055}},"stopReason":"stop","timestamp":1791791757572},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"pong"}],"stopReason":"stop","usage":{"input":525,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":530,"cost":{"input":0.00525,"output":0.00025,"cacheRead":0,"cacheWrite":0,"total":0.0055}}}],"willRetry":false}
{"type":"agent_settled"}
```

`tools/scheduler/test/fixtures/streams/pi-error-exit0.jsonl` (recorded verbatim shape: pi exited 0):

```
{"type":"session","version":3,"id":"22222222-2222-4222-8222-222222222222","timestamp":"2026-10-12T07:55:16.368Z","cwd":"/w"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word pong and nothing else."}],"timestamp":1791791716444}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word pong and nothing else."}],"timestamp":1791791716444}}
{"type":"message_start","message":{"role":"assistant","content":[],"api":"openai-responses","provider":"openai","model":"gpt-5-nano","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"error","timestamp":1791791717768,"errorMessage":"OpenAI API error (400): 400 {\"detail\":\"The 'gpt-5-nano' model is not supported when using Codex with a ChatGPT account.\"}","thinkingLevel":"medium"}}
{"type":"message_end","message":{"role":"assistant","content":[],"api":"openai-responses","provider":"openai","model":"gpt-5-nano","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"error","timestamp":1791791717768,"errorMessage":"OpenAI API error (400): 400 {\"detail\":\"The 'gpt-5-nano' model is not supported when using Codex with a ChatGPT account.\"}","thinkingLevel":"medium"}}
{"type":"turn_end","message":{"role":"assistant","content":[],"api":"openai-responses","provider":"openai","model":"gpt-5-nano","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"error","timestamp":1791791717768,"errorMessage":"OpenAI API error (400): 400 {\"detail\":\"The 'gpt-5-nano' model is not supported when using Codex with a ChatGPT account.\"}"},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"OpenAI API error (400): 400 {\"detail\":\"The 'gpt-5-nano' model is not supported when using Codex with a ChatGPT account.\"}","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}],"willRetry":false}
{"type":"agent_settled"}
```

`tools/scheduler/test/fixtures/streams/pi-tool-calls.jsonl` (two turns, one tool call, cumulative usage per message):

```
{"type":"session","version":3,"id":"44444444-4444-4444-8444-444444444444","timestamp":"2026-10-12T08:00:00.000Z","cwd":"/w"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"list files"}],"timestamp":1}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"list files"}],"timestamp":1}}
{"type":"message_start","message":{"role":"assistant","content":[],"provider":"openai","model":"gpt-6.1-sol","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"pending","timestamp":2}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls"}}],"provider":"openai","model":"gpt-6.1-sol","usage":{"input":100,"output":10,"cacheRead":50,"cacheWrite":20,"totalTokens":180,"cost":{"input":0.001,"output":0.0001,"cacheRead":0.0001,"cacheWrite":0.0002,"total":0.0014}},"stopReason":"toolUse","timestamp":3}}
{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls"}}
{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"a.ts"}],"details":{}},"isError":false}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls"}}],"stopReason":"toolUse","usage":{"input":100,"output":10,"cacheRead":50,"cacheWrite":20,"totalTokens":180,"cost":{"input":0.001,"output":0.0001,"cacheRead":0.0001,"cacheWrite":0.0002,"total":0.0014}}},"toolResults":[{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":[{"type":"text","text":"a.ts"}],"isError":false}]}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],"provider":"openai","model":"gpt-6.1-sol","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"pending","timestamp":4}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"a.ts"}],"provider":"openai","model":"gpt-6.1-sol","usage":{"input":200,"output":5,"cacheRead":150,"cacheWrite":0,"totalTokens":355,"cost":{"input":0.002,"output":0.00005,"cacheRead":0.0003,"cacheWrite":0,"total":0.00235}},"stopReason":"stop","timestamp":5}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"a.ts"}],"stopReason":"stop","usage":{"input":200,"output":5,"cacheRead":150,"cacheWrite":0,"totalTokens":355,"cost":{"input":0.002,"output":0.00005,"cacheRead":0.0003,"cacheWrite":0,"total":0.00235}}},"toolResults":[]}
{"type":"agent_end","messages":[],"willRetry":false}
{"type":"agent_settled"}
```

- [ ] **Step 2: Write the failing tests**

`tools/scheduler/test/jsonl.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlSplitter, readJsonlFile } from "../src/adapters/jsonl.ts";

const fx = (n: string) => join(import.meta.dirname, "fixtures", "streams", n);

describe("JsonlSplitter", () => {
  it("splits on LF across chunk boundaries and strips CR", () => {
    const s = new JsonlSplitter();
    expect(s.push('{"a":1}\r\n{"b"')).toEqual([{ a: 1 }]);
    expect(s.push(':2}\n')).toEqual([{ b: 2 }]);
    expect(s.end()).toEqual({ records: [], malformed: [] });
  });
  it("does not split on unicode line separators inside strings", () => {
    const s = new JsonlSplitter();
    expect(s.push('{"t":"a b"}\n')).toEqual([{ t: "a b" }]);
  });
  it("reports a malformed tail without throwing (review focus 5)", async () => {
    const r = await readJsonlFile(fx("claude-partial-tail.jsonl"));
    expect(r.records).toHaveLength(2);
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0]).toContain('"id":"m2"');
  });
  it("reads a complete fixture", async () => {
    const r = await readJsonlFile(fx("pi-success.jsonl"));
    expect(r.records).toHaveLength(12);
    expect(r.malformed).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/jsonl.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`tools/scheduler/src/adapters/types.ts`:

```ts
import type { RunOutcome } from "../state/runs.ts";
import type { AgentStageName, Bounds, Harness, Profile } from "../types.ts";

export interface StageRun {
  runId: string;
  stage: AgentStageName;
  attempt: number;
  issue: number;
  prompt: string;
  model: string;
  bounds: Bounds;
  worktree: string;
  sessionId: string;
  resultPath: string;
  profile: Profile | null;
  effort?: string;
}

export interface Usage {
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  turns: number;
  tool_calls: number;
}

export interface Judgement {
  outcome: RunOutcome;
  reason: string | null;
  apiErrorStatus: number | null;
  finalText: string | null;
}

export interface Command {
  argv: string[];
  env: Record<string, string>;
}

export interface Adapter {
  harness: Harness;
  buildCommand(run: StageRun): Command;
  judge(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement;
  usage(events: unknown[]): Usage;
}

export type { RunOutcome };
```

`tools/scheduler/src/adapters/jsonl.ts`:

```ts
import { createReadStream } from "node:fs";

/** Strict LF framing (pi json.md): never use readline, which also splits on U+2028/U+2029. */
export class JsonlSplitter {
  #buf = "";
  #malformed: string[] = [];

  push(chunk: Buffer | string): unknown[] {
    this.#buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const out: unknown[] = [];
    let idx: number;
    while ((idx = this.#buf.indexOf("\n")) >= 0) {
      let line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      const parsed = this.#parse(line);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  }

  end(): { records: unknown[]; malformed: string[] } {
    const records: unknown[] = [];
    const tail = this.#buf.trim();
    this.#buf = "";
    if (tail) {
      const parsed = this.#parse(tail);
      if (parsed !== undefined) records.push(parsed);
    }
    const malformed = this.#malformed;
    this.#malformed = [];
    return { records, malformed };
  }

  #parse(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch {
      this.#malformed.push(line);
      return undefined;
    }
  }
}

export async function readJsonlFile(path: string): Promise<{ records: unknown[]; malformed: string[] }> {
  const s = new JsonlSplitter();
  const records: unknown[] = [];
  for await (const chunk of createReadStream(path)) records.push(...s.push(chunk as Buffer));
  const tail = s.end();
  return { records: [...records, ...tail.records], malformed: tail.malformed };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/jsonl.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add tools/scheduler/src/adapters/types.ts tools/scheduler/src/adapters/jsonl.ts tools/scheduler/test/jsonl.test.ts tools/scheduler/test/fixtures/streams
git commit -m "scheduler: adapter interface, LF-framed JSONL reader, recorded harness streams"
```

---

### Task 4: Claude adapter

**Files:**
- Create: `tools/scheduler/src/adapters/claude.ts`
- Test: `tools/scheduler/test/adapters-claude.test.ts`

**Interfaces:**
- Produces: `claudeAdapter: Adapter` and the helpers `claudeInit(events)`, `claudeResult(events)`.
- Command (AC-18, spec section 13): `claude -p <prompt> --output-format stream-json --verbose --model <model> --max-turns <n> --max-budget-usd <usd> --session-id <uuid> --permission-mode dontAsk --fallback-model <m>` (fallback only when `run.fallbackModel` is set by the runner, see Task 6; not for strong tier). `--allowedTools <profile tools joined by comma>` when a profile is set. Env: `CI=true`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=<timeout_min*60000>`. The prompt is passed as the argument after `-p`; it names the result path.
- Judgement: `ok` when exit 0, the last `result` event has `is_error: false`, and init has empty `plugin_errors` and `mcp_server_errors`. `bounds` when `subtype` is `error_max_turns` or `error_max_budget_usd`. `timeout` when `timedOut`. Otherwise `failed` with the reason (`result` text, or "no result event", or "plugin errors: ...", or `exit <code>`). `apiErrorStatus` from the result's `api_error_status`, else from the last `api_retry` event's `error_status`.
- Usage: from the result event: `total_cost_usd`, `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, `num_turns`; `tool_calls` is the count of `tool_use` content blocks across `assistant` events. Without a result event, sum the `assistant` events' `message.usage` and set cost `null`.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/adapters-claude.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.ts";
import { readJsonlFile } from "../src/adapters/jsonl.ts";
import type { StageRun } from "../src/adapters/types.ts";

const fx = async (n: string) => (await readJsonlFile(join(import.meta.dirname, "fixtures", "streams", n))).records;

const run: StageRun = {
  runId: "r", stage: "review", attempt: 1, issue: 7, prompt: "Review and write /tmp/r.json", model: "claude-fable-5-1",
  bounds: { timeout_min: 40, max_turns: 150, max_cost_usd: 6 }, worktree: "/w", sessionId: "11111111-1111-4111-8111-111111111111",
  resultPath: "/tmp/r.json", profile: null, effort: "high",
};

describe("claudeAdapter.buildCommand (AC-18)", () => {
  it("builds the headless command with bounds, session id and no-prompt permission", () => {
    const { argv, env } = claudeAdapter.buildCommand(run);
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("-p") + 1]).toContain("/tmp/r.json");
    expect(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(argv).toContain("--verbose");
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "claude-fable-5-1"]);
    expect(argv.slice(argv.indexOf("--max-turns"), argv.indexOf("--max-turns") + 2)).toEqual(["--max-turns", "150"]);
    expect(argv.slice(argv.indexOf("--max-budget-usd"), argv.indexOf("--max-budget-usd") + 2)).toEqual(["--max-budget-usd", "6"]);
    expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual(["--session-id", run.sessionId]);
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
    expect(argv).toContain("--effort");
    expect(argv).not.toContain("--bare");
    expect(argv).not.toContain("--fallback-model");
    expect(env.CI).toBe("true");
    expect(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(String(40 * 60_000));
  });
  it("passes the profile tool allowlist and a fallback model when given (AC-26, AC-25)", () => {
    const { argv } = claudeAdapter.buildCommand({ ...run, profile: { name: "backend", dir: "/a", skillsDir: "/a/skills", instructions: "", tools: ["Read", "Bash"] }, fallbackModel: "claude-opus-5-5" } as StageRun & { fallbackModel: string });
    expect(argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", "Read,Bash"]);
    expect(argv.slice(argv.indexOf("--fallback-model"), argv.indexOf("--fallback-model") + 2)).toEqual(["--fallback-model", "claude-opus-5-5"]);
  });
});

describe("claudeAdapter.judge (AC-21)", () => {
  it("ok on a clean result and exit 0", async () => {
    expect(claudeAdapter.judge(await fx("claude-success.jsonl"), 0, false)).toMatchObject({ outcome: "ok", reason: null, finalText: "pong" });
  });
  it("failed on is_error with the result text and api status", async () => {
    expect(claudeAdapter.judge(await fx("claude-is-error.jsonl"), 1, false)).toMatchObject({ outcome: "failed", reason: expect.stringContaining("Invalid API key"), apiErrorStatus: 401 });
  });
  it("failed on non-zero exit even with a clean result", async () => {
    expect(claudeAdapter.judge(await fx("claude-success.jsonl"), 2, false)).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/exit 2/) });
  });
  it("failed on plugin errors in the init event", async () => {
    expect(claudeAdapter.judge(await fx("claude-plugin-errors.jsonl"), 0, false)).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/plugin errors.*hooks\.json/) });
  });
  it("bounds on error_max_turns (review focus 1)", async () => {
    expect(claudeAdapter.judge(await fx("claude-max-turns.jsonl"), 1, false)).toMatchObject({ outcome: "bounds", reason: expect.stringMatching(/max turns/i) });
  });
  it("reports 429 from the result and from api_retry events", async () => {
    expect(claudeAdapter.judge(await fx("claude-429.jsonl"), 1, false)).toMatchObject({ outcome: "failed", apiErrorStatus: 429 });
  });
  it("timeout wins over everything", async () => {
    expect(claudeAdapter.judge(await fx("claude-success.jsonl"), null, true).outcome).toBe("timeout");
  });
  it("failed with 'no result event' on a partial stream", async () => {
    expect(claudeAdapter.judge(await fx("claude-partial-tail.jsonl"), 0, false)).toMatchObject({ outcome: "failed", reason: "no result event" });
  });
});

describe("claudeAdapter.usage (AC-24)", () => {
  it("reads totals from the result event and counts tool calls", async () => {
    expect(claudeAdapter.usage(await fx("claude-success.jsonl"))).toEqual({
      cost_usd: 0.0246593, input_tokens: 20, output_tokens: 12, cache_read_tokens: 500, cache_write_tokens: 100, turns: 2, tool_calls: 1,
    });
  });
  it("sums assistant messages with null cost when there is no result", async () => {
    expect(claudeAdapter.usage(await fx("claude-partial-tail.jsonl"))).toEqual({
      cost_usd: null, input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/adapters-claude.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/adapters/claude.ts`:

```ts
import type { Adapter, Command, Judgement, StageRun, Usage } from "./types.ts";

type Rec = Record<string, unknown>;
const rec = (e: unknown): Rec => (typeof e === "object" && e !== null ? (e as Rec) : {});

export interface ClaudeStageRun extends StageRun {
  fallbackModel?: string;
}

export function claudeInit(events: unknown[]): Rec | null {
  return events.map(rec).find((e) => e.type === "system" && e.subtype === "init") ?? null;
}

export function claudeResult(events: unknown[]): Rec | null {
  const results = events.map(rec).filter((e) => e.type === "result");
  return results.length ? results[results.length - 1] : null;
}

function buildCommand(run: ClaudeStageRun): Command {
  const argv = [
    "claude", "-p", run.prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", run.model,
    "--max-turns", String(run.bounds.max_turns),
    "--max-budget-usd", String(run.bounds.max_cost_usd),
    "--session-id", run.sessionId,
    "--permission-mode", "dontAsk",
  ];
  if (run.effort) argv.push("--effort", run.effort);
  if (run.fallbackModel) argv.push("--fallback-model", run.fallbackModel);
  if (run.profile && run.profile.tools.length) argv.push("--allowedTools", run.profile.tools.join(","));
  return { argv, env: { CI: "true", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(run.bounds.timeout_min * 60_000) } };
}

function judge(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement {
  const result = claudeResult(events);
  const retries = events.map(rec).filter((e) => e.type === "system" && e.subtype === "api_retry");
  const retryStatus = retries.length ? Number(retries[retries.length - 1].error_status) : null;
  const apiErrorStatus = (result && typeof result.api_error_status === "number" ? result.api_error_status : null) ?? retryStatus;
  const finalText = result && typeof result.result === "string" ? result.result : null;
  if (timedOut) return { outcome: "timeout", reason: "stage timeout", apiErrorStatus, finalText };
  if (!result) return { outcome: "failed", reason: "no result event", apiErrorStatus, finalText };
  const subtype = String(result.subtype ?? "");
  if (subtype === "error_max_turns" || subtype === "error_max_budget_usd") {
    return { outcome: "bounds", reason: subtype === "error_max_turns" ? "max turns reached" : "max budget reached", apiErrorStatus, finalText };
  }
  if (result.is_error === true) return { outcome: "failed", reason: finalText ?? subtype, apiErrorStatus, finalText };
  const init = claudeInit(events);
  const pluginErrors = (init?.plugin_errors as unknown[] | undefined) ?? [];
  const mcpErrors = (init?.mcp_server_errors as unknown[] | undefined) ?? [];
  if (pluginErrors.length || mcpErrors.length) {
    return { outcome: "failed", reason: `plugin errors: ${JSON.stringify([...pluginErrors, ...mcpErrors])}`, apiErrorStatus, finalText };
  }
  if (exitCode !== 0) return { outcome: "failed", reason: `exit ${exitCode}`, apiErrorStatus, finalText };
  return { outcome: "ok", reason: null, apiErrorStatus, finalText };
}

function usage(events: unknown[]): Usage {
  const assistants = events.map(rec).filter((e) => e.type === "assistant");
  const tool_calls = assistants.reduce((n, e) => {
    const content = (rec(e.message).content as unknown[] | undefined) ?? [];
    return n + content.filter((c) => rec(c).type === "tool_use").length;
  }, 0);
  const result = claudeResult(events);
  if (result) {
    const u = rec(result.usage);
    return {
      cost_usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
      input_tokens: Number(u.input_tokens ?? 0),
      output_tokens: Number(u.output_tokens ?? 0),
      cache_read_tokens: Number(u.cache_read_input_tokens ?? 0),
      cache_write_tokens: Number(u.cache_creation_input_tokens ?? 0),
      turns: Number(result.num_turns ?? 0),
      tool_calls,
    };
  }
  const sum = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  for (const e of assistants) {
    const u = rec(rec(e.message).usage);
    sum.input_tokens += Number(u.input_tokens ?? 0);
    sum.output_tokens += Number(u.output_tokens ?? 0);
    sum.cache_read_tokens += Number(u.cache_read_input_tokens ?? 0);
    sum.cache_write_tokens += Number(u.cache_creation_input_tokens ?? 0);
  }
  return { cost_usd: null, ...sum, turns: assistants.length, tool_calls };
}

export const claudeAdapter: Adapter = { harness: "claude", buildCommand, judge, usage };
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/adapters-claude.test.ts`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/adapters/claude.ts tools/scheduler/test/adapters-claude.test.ts
git commit -m "scheduler: claude adapter with command construction, judgement and usage (AC-18, AC-21, AC-24)"
```

---

### Task 5: pi adapter and fake adapter

**Files:**
- Create: `tools/scheduler/src/adapters/pi.ts`, `tools/scheduler/src/adapters/fake.ts`, `tools/scheduler/src/adapters/index.ts`
- Test: `tools/scheduler/test/adapters-pi.test.ts`, `tools/scheduler/test/adapters-fake.test.ts`

**Interfaces:**
- Produces: `piAdapter: Adapter`. Command (AC-19, section 13): `pi --mode json --model <provider/model> --session-id <id> --approve --no-context-files <prompt>` plus `--tools <list>` when a profile has tools, `-e <path>` for each entry in `run.extensions` (optional field on `PiStageRun`), `--thinking <effort>` when `effort` is set, and `--skill <profile.skillsDir>` when a profile is set. Env: `CI=true`, `PI_OFFLINE` unset. The runner wraps it in a timeout (Task 6).
  Judgement: `timeout` if timed out; `failed` if no `agent_end`; `failed` with `errorMessage` if the last assistant message (from the last `message_end` with role assistant, else from `agent_end.messages`) has `stopReason` `error` or `aborted`, regardless of exit code (AC-20); `failed` on non-zero exit; `bounds` when the runner passed `turnsExceeded` via events of shape `{type: "scheduler_bounds", reason}` (the runner appends that synthetic record when it kills on `max_turns`); else `ok`. `finalText` is the concatenated text blocks of the last assistant message.
  Usage: sum over assistant `message_end` events of `message.usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `cost.total`); `turns` = count of `turn_end`; `tool_calls` = count of `tool_execution_start`. Cost is a number (0 is a number; the pi stream always carries cost, possibly zero).
- Produces: `fakeAdapter(opts: { events: unknown[]; result?: unknown; exitCode?: number; scriptPath: string }): Adapter` whose command is `node <scriptPath> <eventsFile> <resultPath> <exitCode>`; the runner tests use it with `test/fixtures/stage-script.ts`, which prints the events file to stdout line by line, writes the canned result (if any) to the result path, then exits with the code. `judge`: `ok` iff exit 0 and not timed out. `usage`: zeros with `cost_usd: null`, `turns: 1`.
- Produces: `adapterFor(harness: Harness, fake?: Adapter): Adapter`.

- [ ] **Step 1: Write the fixture script and the failing tests**

`tools/scheduler/test/fixtures/stage-script.ts`:

```ts
// Throwaway "harness" for runner tests: replays an events file to stdout, optionally writes a result, exits.
// argv: <eventsFile> <resultPath|-> <exitCode> [sleepMs] [resultJson]
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [eventsFile, resultPath, exitCode, sleepMs, resultJson] = process.argv.slice(2);
for (const line of readFileSync(eventsFile, "utf8").split("\n")) if (line.trim()) process.stdout.write(line + "\n");
if (resultPath && resultPath !== "-" && resultJson) writeFileSync(resultPath, resultJson);
if (process.env.SPAWN_GRANDCHILD === "1") {
  // a grandchild that ignores SIGTERM, to prove process-group kill (AC-23)
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.GRANDCHILD_PID_FILE ?? "/dev/null", String(child.pid));
}
const ms = Number(sleepMs ?? 0);
if (ms > 0) setTimeout(() => process.exit(Number(exitCode)), ms);
else process.exit(Number(exitCode));
```

`tools/scheduler/test/adapters-pi.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonlFile } from "../src/adapters/jsonl.ts";
import { piAdapter } from "../src/adapters/pi.ts";
import type { StageRun } from "../src/adapters/types.ts";

const fx = async (n: string) => (await readJsonlFile(join(import.meta.dirname, "fixtures", "streams", n))).records;
const run: StageRun = {
  runId: "r", stage: "implement", attempt: 1, issue: 7, prompt: "Implement; write /tmp/r.json", model: "openai/gpt-6.1-sol",
  bounds: { timeout_min: 90, max_turns: 300, max_cost_usd: 10 }, worktree: "/w", sessionId: "s-1", resultPath: "/tmp/r.json",
  profile: { name: "backend", dir: "/a", skillsDir: "/a/skills", instructions: "", tools: ["read", "bash", "edit", "write"] }, effort: "medium",
};

describe("piAdapter.buildCommand (AC-19)", () => {
  it("selects json mode, provider/model, session id, non-interactive approval and the profile tools", () => {
    const { argv, env } = piAdapter.buildCommand(run);
    expect(argv[0]).toBe("pi");
    expect(argv.slice(argv.indexOf("--mode"), argv.indexOf("--mode") + 2)).toEqual(["--mode", "json"]);
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "openai/gpt-6.1-sol"]);
    expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual(["--session-id", "s-1"]);
    expect(argv).toContain("--approve");
    expect(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2)).toEqual(["--tools", "read,bash,edit,write"]);
    expect(argv.slice(argv.indexOf("--skill"), argv.indexOf("--skill") + 2)).toEqual(["--skill", "/a/skills"]);
    expect(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2)).toEqual(["--thinking", "medium"]);
    expect(argv[argv.length - 1]).toContain("/tmp/r.json");
    expect(env.CI).toBe("true");
  });
  it("adds -e for each extension", () => {
    const { argv } = piAdapter.buildCommand({ ...run, extensions: ["/x/container.ts"] } as StageRun & { extensions: string[] });
    expect(argv.slice(argv.indexOf("-e"), argv.indexOf("-e") + 2)).toEqual(["-e", "/x/container.ts"]);
  });
});

describe("piAdapter.judge (AC-20)", () => {
  it("ok on a clean stream", async () => {
    expect(piAdapter.judge(await fx("pi-success.jsonl"), 0, false)).toMatchObject({ outcome: "ok", finalText: "pong" });
  });
  it("failed when the last assistant message is in error state even though exit is 0", async () => {
    expect(piAdapter.judge(await fx("pi-error-exit0.jsonl"), 0, false)).toMatchObject({ outcome: "failed", reason: expect.stringContaining("not supported"), apiErrorStatus: 400 });
  });
  it("failed without agent_end", async () => {
    const ev = (await fx("pi-success.jsonl")).slice(0, 5);
    expect(piAdapter.judge(ev, 0, false)).toMatchObject({ outcome: "failed", reason: "no agent_end event" });
  });
  it("bounds on the runner's synthetic bounds record", async () => {
    const ev = [...(await fx("pi-success.jsonl")), { type: "scheduler_bounds", reason: "max_turns" }];
    expect(piAdapter.judge(ev, null, false)).toMatchObject({ outcome: "bounds", reason: "max_turns" });
  });
  it("timeout wins", async () => {
    expect(piAdapter.judge(await fx("pi-success.jsonl"), null, true).outcome).toBe("timeout");
  });
});

describe("piAdapter.usage (AC-24)", () => {
  it("sums assistant message_end usage, counts turns and tool calls", async () => {
    expect(piAdapter.usage(await fx("pi-tool-calls.jsonl"))).toEqual({
      cost_usd: 0.00375, input_tokens: 300, output_tokens: 15, cache_read_tokens: 200, cache_write_tokens: 20, turns: 2, tool_calls: 1,
    });
  });
});
```

`tools/scheduler/test/adapters-fake.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { adapterFor } from "../src/adapters/index.ts";

describe("fakeAdapter", () => {
  const a = fakeAdapter({ events: [{ type: "x" }], scriptPath: "/s.ts" });
  it("builds a node command and judges on exit code only", () => {
    const { argv } = a.buildCommand({ runId: "r", stage: "plan", attempt: 1, issue: 1, prompt: "p", model: "fake", bounds: { timeout_min: 1, max_turns: 1, max_cost_usd: 1 }, worktree: "/w", sessionId: "s", resultPath: "/r.json", profile: null });
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe("/s.ts");
    expect(a.judge([], 0, false).outcome).toBe("ok");
    expect(a.judge([], 1, false).outcome).toBe("failed");
    expect(a.judge([], 0, true).outcome).toBe("timeout");
  });
  it("adapterFor returns claude, pi, or the supplied fake", () => {
    expect(adapterFor("claude").harness).toBe("claude");
    expect(adapterFor("pi").harness).toBe("pi");
    expect(adapterFor("fake", a)).toBe(a);
    expect(() => adapterFor("fake")).toThrow(/fake adapter/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/adapters-pi.test.ts tools/scheduler/test/adapters-fake.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/adapters/pi.ts`:

```ts
import type { Adapter, Command, Judgement, StageRun, Usage } from "./types.ts";

type Rec = Record<string, unknown>;
const rec = (e: unknown): Rec => (typeof e === "object" && e !== null ? (e as Rec) : {});

export interface PiStageRun extends StageRun {
  extensions?: string[];
}

function buildCommand(run: PiStageRun): Command {
  const argv = ["pi", "--mode", "json", "--model", run.model, "--session-id", run.sessionId, "--approve"];
  if (run.effort) argv.push("--thinking", run.effort);
  if (run.profile) {
    if (run.profile.tools.length) argv.push("--tools", run.profile.tools.join(","));
    argv.push("--skill", run.profile.skillsDir);
  }
  for (const e of run.extensions ?? []) argv.push("-e", e);
  argv.push(run.prompt);
  return { argv, env: { CI: "true" } };
}

function lastAssistant(events: unknown[]): Rec | null {
  const ends = events.map(rec).filter((e) => e.type === "message_end" && rec(e.message).role === "assistant");
  if (ends.length) return rec(ends[ends.length - 1].message);
  const end = events.map(rec).find((e) => e.type === "agent_end");
  const msgs = ((end?.messages as unknown[] | undefined) ?? []).map(rec).filter((m) => m.role === "assistant");
  return msgs.length ? msgs[msgs.length - 1] : null;
}

function textOf(msg: Rec | null): string | null {
  if (!msg) return null;
  const content = (msg.content as unknown[] | undefined) ?? [];
  const text = content.map(rec).filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
  return text || null;
}

function judge(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement {
  const last = lastAssistant(events);
  const finalText = textOf(last);
  const errorMessage = last && typeof last.errorMessage === "string" ? last.errorMessage : null;
  const statusMatch = errorMessage ? /\((\d{3})\)/.exec(errorMessage) : null;
  const apiErrorStatus = statusMatch ? Number(statusMatch[1]) : null;
  if (timedOut) return { outcome: "timeout", reason: "stage timeout", apiErrorStatus, finalText };
  const bounds = events.map(rec).find((e) => e.type === "scheduler_bounds");
  if (bounds) return { outcome: "bounds", reason: String(bounds.reason), apiErrorStatus, finalText };
  if (!events.map(rec).some((e) => e.type === "agent_end")) return { outcome: "failed", reason: "no agent_end event", apiErrorStatus, finalText };
  const stop = last ? String(last.stopReason ?? "") : "";
  if (stop === "error" || stop === "aborted") return { outcome: "failed", reason: errorMessage ?? `assistant ${stop}`, apiErrorStatus, finalText };
  if (!last) return { outcome: "failed", reason: "no assistant message", apiErrorStatus, finalText };
  if (exitCode !== 0) return { outcome: "failed", reason: `exit ${exitCode}`, apiErrorStatus, finalText };
  return { outcome: "ok", reason: null, apiErrorStatus, finalText };
}

function usage(events: unknown[]): Usage {
  const u = { cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 0, tool_calls: 0 };
  for (const e of events.map(rec)) {
    if (e.type === "turn_end") u.turns++;
    if (e.type === "tool_execution_start") u.tool_calls++;
    if (e.type === "message_end" && rec(e.message).role === "assistant") {
      const m = rec(rec(e.message).usage);
      u.input_tokens += Number(m.input ?? 0);
      u.output_tokens += Number(m.output ?? 0);
      u.cache_read_tokens += Number(m.cacheRead ?? 0);
      u.cache_write_tokens += Number(m.cacheWrite ?? 0);
      u.cost_usd += Number(rec(m.cost).total ?? 0);
    }
  }
  u.cost_usd = Math.round(u.cost_usd * 1e8) / 1e8;
  return u;
}

export const piAdapter: Adapter = { harness: "pi", buildCommand, judge, usage };
```

`tools/scheduler/src/adapters/fake.ts`:

```ts
import type { Adapter, StageRun } from "./types.ts";

export interface FakeOptions {
  events: unknown[];
  result?: unknown;
  exitCode?: number;
  scriptPath: string;
  sleepMs?: number;
  eventsFile?: string;
}

/** Replays a recorded stream through a throwaway script and writes a canned result (spec section 13). */
export function fakeAdapter(opts: FakeOptions): Adapter & { opts: FakeOptions } {
  return {
    harness: "fake",
    opts,
    buildCommand(run: StageRun) {
      const argv = [
        process.execPath, opts.scriptPath, opts.eventsFile ?? "", run.resultPath, String(opts.exitCode ?? 0), String(opts.sleepMs ?? 0),
      ];
      if (opts.result !== undefined) argv.push(JSON.stringify(opts.result));
      return { argv, env: {} };
    },
    judge(_events, exitCode, timedOut) {
      if (timedOut) return { outcome: "timeout", reason: "stage timeout", apiErrorStatus: null, finalText: null };
      if (exitCode !== 0) return { outcome: "failed", reason: `exit ${exitCode}`, apiErrorStatus: null, finalText: null };
      return { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "fake" };
    },
    usage() {
      return { cost_usd: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 };
    },
  };
}
```

`tools/scheduler/src/adapters/index.ts`:

```ts
import type { Harness } from "../types.ts";
import { claudeAdapter } from "./claude.ts";
import { piAdapter } from "./pi.ts";
import type { Adapter } from "./types.ts";

export function adapterFor(harness: Harness, fake?: Adapter): Adapter {
  if (harness === "claude") return claudeAdapter;
  if (harness === "pi") return piAdapter;
  if (fake) return fake;
  throw new Error("fake adapter requested but none supplied");
}

export { claudeAdapter, piAdapter };
export type { Adapter } from "./types.ts";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/adapters-pi.test.ts tools/scheduler/test/adapters-fake.test.ts`
Expected: 10 passed. The pi usage expectation: input 100+200, output 10+5, cacheRead 50+150, cacheWrite 20+0, cost 0.0014+0.00235.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/adapters tools/scheduler/test/adapters-pi.test.ts tools/scheduler/test/adapters-fake.test.ts tools/scheduler/test/fixtures/stage-script.ts
git commit -m "scheduler: pi adapter judging from the event stream, fake adapter, adapter registry (AC-19, AC-20)"
```

---

### Task 6: Bounded process spawn with process-group kill and systemd scope

**Files:**
- Create: `tools/scheduler/src/runner/process.ts`
- Test: `tools/scheduler/test/process.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface SpawnOptions {
    argv: string[]; env: Record<string, string>; cwd: string; timeoutMs: number;
    onStdoutChunk: (chunk: Buffer) => void; onStderrChunk?: (chunk: Buffer) => void;
    graceMs?: number;                 // SIGTERM to SIGKILL, default 10_000
    scope?: { enabled: boolean; unitName: string; systemdRunBin?: string }; // wraps argv in systemd-run --user --scope ...
    killOnEvent?: () => boolean;      // runner's max_turns check; polled after each stdout chunk
  }
  interface SpawnResult { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; killedByEvent: boolean; pgid: number; wallMs: number }
  async function spawnBounded(o: SpawnOptions): Promise<SpawnResult>
  function scopeArgv(argv: string[], unitName: string, bin = "systemd-run"): string[]
  function isProcessGroupAlive(pgid: number): boolean
  ```
  `scopeArgv` returns `[bin, "--user", "--scope", "--quiet", "--unit", unitName, "-p", "MemoryMax=50%", "-p", "OOMPolicy=continue", "-p", "KillMode=control-group", "--", ...argv]` (AC-30). The child is spawned with `detached: true` so it leads its own process group; on timeout or `killOnEvent`, `process.kill(-pgid, "SIGTERM")`, then after `graceMs` `process.kill(-pgid, "SIGKILL")`. The promise resolves once the child exited and `isProcessGroupAlive(pgid)` is false (polled every 200 ms, up to 30 s; after that it resolves anyway with `timedOut` and the pgid, and the runner records a finding).

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/process.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessGroupAlive, scopeArgv, spawnBounded } from "../src/runner/process.ts";

const script = join(import.meta.dirname, "fixtures", "stage-script.ts");
function eventsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "proc-"));
  const p = join(dir, "events.jsonl");
  writeFileSync(p, '{"type":"a"}\n{"type":"b"}\n');
  return p;
}

describe("scopeArgv (AC-30)", () => {
  it("wraps the command in a transient scope with the memory and OOM properties", () => {
    expect(scopeArgv(["claude", "-p", "x"], "panelator-stage-r1")).toEqual([
      "systemd-run", "--user", "--scope", "--quiet", "--unit", "panelator-stage-r1",
      "-p", "MemoryMax=50%", "-p", "OOMPolicy=continue", "-p", "KillMode=control-group", "--", "claude", "-p", "x",
    ]);
  });
});

describe("spawnBounded", () => {
  it("streams stdout and returns the exit code", async () => {
    const chunks: string[] = [];
    const r = await spawnBounded({ argv: [process.execPath, script, eventsFile(), "-", "3"], env: {}, cwd: tmpdir(), timeoutMs: 10_000, onStdoutChunk: (c) => chunks.push(c.toString()) });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(chunks.join("")).toBe('{"type":"a"}\n{"type":"b"}\n');
  });
  it("kills the whole process group on timeout, including a grandchild that ignores SIGTERM (AC-23, review focus 3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proc-"));
    const pidFile = join(dir, "grandchild.pid");
    const r = await spawnBounded({
      argv: [process.execPath, script, eventsFile(), "-", "0", "60000"], env: { SPAWN_GRANDCHILD: "1", GRANDCHILD_PID_FILE: pidFile },
      cwd: dir, timeoutMs: 1_000, graceMs: 500, onStdoutChunk: () => {},
    });
    expect(r.timedOut).toBe(true);
    const gpid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(() => process.kill(gpid, 0)).toThrow();
    expect(isProcessGroupAlive(r.pgid)).toBe(false);
  }, 20_000);
  it("kills when killOnEvent returns true", async () => {
    let seen = 0;
    const r = await spawnBounded({
      argv: [process.execPath, script, eventsFile(), "-", "0", "60000"], env: {}, cwd: tmpdir(), timeoutMs: 30_000, graceMs: 200,
      onStdoutChunk: () => { seen++; }, killOnEvent: () => seen > 0,
    });
    expect(r.killedByEvent).toBe(true);
    expect(r.timedOut).toBe(false);
  }, 20_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/process.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/runner/process.ts`:

```ts
import { spawn } from "node:child_process";

export interface SpawnOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  onStdoutChunk: (chunk: Buffer) => void;
  onStderrChunk?: (chunk: Buffer) => void;
  graceMs?: number;
  scope?: { enabled: boolean; unitName: string; systemdRunBin?: string };
  killOnEvent?: () => boolean;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killedByEvent: boolean;
  pgid: number;
  wallMs: number;
}

export function scopeArgv(argv: string[], unitName: string, bin = "systemd-run"): string[] {
  return [bin, "--user", "--scope", "--quiet", "--unit", unitName, "-p", "MemoryMax=50%", "-p", "OOMPolicy=continue", "-p", "KillMode=control-group", "--", ...argv];
}

export function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* already gone */
  }
}

async function waitGroupGone(pgid: number, maxMs: number): Promise<void> {
  const start = Date.now();
  while (isProcessGroupAlive(pgid) && Date.now() - start < maxMs) await new Promise((r) => setTimeout(r, 200));
}

export function spawnBounded(o: SpawnOptions): Promise<SpawnResult> {
  const argv = o.scope?.enabled ? scopeArgv(o.argv, o.scope.unitName, o.scope.systemdRunBin) : o.argv;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pgid = child.pid!;
    let timedOut = false;
    let killedByEvent = false;
    let killing = false;
    const grace = o.graceMs ?? 10_000;

    const kill = (why: "timeout" | "event") => {
      if (killing) return;
      killing = true;
      if (why === "timeout") timedOut = true;
      else killedByEvent = true;
      killGroup(pgid, "SIGTERM");
      setTimeout(() => killGroup(pgid, "SIGKILL"), grace).unref();
    };

    const timer = setTimeout(() => kill("timeout"), o.timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      o.onStdoutChunk(c);
      if (o.killOnEvent?.()) kill("event");
    });
    child.stderr.on("data", (c: Buffer) => o.onStderrChunk?.(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", async (exitCode, signal) => {
      clearTimeout(timer);
      if (killing || isProcessGroupAlive(pgid)) {
        killGroup(pgid, "SIGKILL");
        await waitGroupGone(pgid, 30_000);
      }
      resolve({ exitCode, signal, timedOut, killedByEvent, pgid, wallMs: Date.now() - started });
    });
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/process.test.ts`
Expected: 4 passed (the timeout test takes about 2 s).

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/runner/process.ts tools/scheduler/test/process.test.ts
git commit -m "scheduler: bounded spawn with process-group kill and systemd scope wrapper (AC-23, AC-30)"
```

---

### Task 7: Worktrees, diffs, retry policy, skills linking

**Files:**
- Create: `tools/scheduler/src/runner/worktree.ts`, `tools/scheduler/src/runner/retry.ts`, `tools/scheduler/src/runner/skills.ts`
- Test: `tools/scheduler/test/worktree.test.ts`, `tools/scheduler/test/retry.test.ts`

**Interfaces:**
- Produces (`worktree.ts`, all shell out to `git` with `execFile`, never through a shell string):
  ```ts
  async function ensureWorktree(repo: string, worktreesDir: string, issue: number, base = "origin/main"): Promise<{ path: string; branch: string; created: boolean }>  // branch "issue-<n>"; `git worktree add -B issue-<n> <path> <base>` when missing, else reuses
  async function rebaseOntoMain(worktree: string, base = "origin/main"): Promise<{ ok: true; moved: boolean } | { ok: false; conflict: string }>  // `git fetch` by caller; `git rebase <base>`; on failure `git rebase --abort` and return the conflict output
  async function diffFilesAgainstBase(worktree: string, base = "origin/main"): Promise<string[]>   // `git diff --name-only <base>...HEAD` plus untracked/uncommitted (`git status --porcelain`)
  async function uncommittedPatch(worktree: string): Promise<string>  // `git add -N . && git diff` style: `git diff HEAD` with intent-to-add for untracked files, then reset the intent
  async function removeWorktree(repo: string, path: string): Promise<void>  // `git worktree remove --force` + `git branch -D` is NOT done (the PR branch stays on the remote)
  ```
- Produces (`retry.ts`): `retryDecision(def: StageDefinition, judgement: Judgement, costSoFar: number, retryCostLimit: number): { kind: "none" } | { kind: "fallback"; model: string; harness: Harness } | { kind: "postpone" }`. Rule (AC-25): only when `judgement.outcome === "failed"` and `apiErrorStatus === 429`; if `def.tier === "strong"` return `postpone`; else if `def.fallback` and `costSoFar <= retryCostLimit` return `fallback` with harness `pi` when the model contains `/`, else `claude`; else `none`.
- Produces (`skills.ts`): `linkProfileSkills(worktree: string, harness: Harness, profile: Profile): Promise<string>`: creates `<worktree>/.claude/skills` (claude) or `<worktree>/.agents/skills` (pi) as a symlink to `profile.skillsDir`, replacing an existing symlink, and appends that path to `<worktree>/.git/info/exclude` so it never enters a commit (AC-26).

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/worktree.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkProfileSkills } from "../src/runner/skills.ts";
import { diffFilesAgainstBase, ensureWorktree, rebaseOntoMain, removeWorktree, uncommittedPatch } from "../src/runner/worktree.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** origin (bare) + a checkout that stands in for the scheduler's repo. */
function repoPair() {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  const repo = join(root, "repo");
  git(root, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  return { root, origin, repo, worktrees: join(root, "worktrees") };
}

describe("worktrees (AC-16)", () => {
  it("creates a worktree on branch issue-N and reuses it", async () => {
    const { repo, worktrees } = repoPair();
    const w1 = await ensureWorktree(repo, worktrees, 7);
    expect(w1.created).toBe(true);
    expect(w1.branch).toBe("issue-7");
    expect(git(w1.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("issue-7");
    const w2 = await ensureWorktree(repo, worktrees, 7);
    expect(w2.created).toBe(false);
    expect(w2.path).toBe(w1.path);
  });
  it("rebases onto a moved main and reports conflicts", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 7);
    writeFileSync(join(w.path, "b.txt"), "b\n");
    git(w.path, "add", "b.txt");
    git(w.path, "commit", "-q", "-m", "b");
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", "c.txt");
    git(repo, "commit", "-q", "-m", "c");
    git(repo, "push", "-q", "origin", "main");
    git(w.path, "fetch", "-q", "origin");
    expect(await rebaseOntoMain(w.path)).toEqual({ ok: true, moved: true });
    expect(existsSync(join(w.path, "c.txt"))).toBe(true);
    writeFileSync(join(repo, "b.txt"), "other\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "conflict");
    git(repo, "push", "-q", "origin", "main");
    git(w.path, "fetch", "-q", "origin");
    const r = await rebaseOntoMain(w.path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflict).toMatch(/CONFLICT/);
    expect(git(w.path, "status", "--porcelain").trim()).toBe("");
  });
  it("lists committed and uncommitted files against base and builds a patch of uncommitted work", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 8);
    writeFileSync(join(w.path, "d.txt"), "d\n");
    git(w.path, "add", "d.txt");
    git(w.path, "commit", "-q", "-m", "d");
    writeFileSync(join(w.path, "e.txt"), "e\n");
    expect((await diffFilesAgainstBase(w.path)).sort()).toEqual(["d.txt", "e.txt"]);
    const patch = await uncommittedPatch(w.path);
    expect(patch).toContain("e.txt");
    expect(git(w.path, "status", "--porcelain").trim()).toBe("?? e.txt");
  });
  it("removes a worktree", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 9);
    await removeWorktree(repo, w.path);
    expect(existsSync(w.path)).toBe(false);
  });
});

describe("linkProfileSkills (AC-26)", () => {
  it("links the skills dir per harness and excludes it from git", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 10);
    const profile = { name: "backend", dir: "/p", skillsDir: join(repo, "agents-skills"), instructions: "", tools: [] };
    const link = await linkProfileSkills(w.path, "claude", profile);
    expect(link).toBe(join(w.path, ".claude", "skills"));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(await linkProfileSkills(w.path, "pi", profile)).toBe(join(w.path, ".agents", "skills"));
    const exclude = readFileSync(join(repo, ".git", "worktrees", "issue-10", "info", "exclude"), "utf8");
    expect(exclude).toContain(".claude/skills");
    expect(exclude).toContain(".agents/skills");
    expect(git(w.path, "status", "--porcelain").trim()).toBe("");
  });
});
```

`tools/scheduler/test/retry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { retryDecision } from "../src/runner/retry.ts";
import type { StageDefinition } from "../src/types.ts";

const base: StageDefinition = {
  name: "implement", kind: "agent", harness: "claude", model: "claude-sonnet-5-5", fallback: "openai/gpt-6.1-sol", tier: "standard",
  bounds: { timeout_min: 1, max_turns: 1, max_cost_usd: 1 }, permission: "no-prompt", worktree: "issue", profile: "from-issue", input: "stage-input", output: "implement-result", prompt: "",
};
const j429 = { outcome: "failed" as const, reason: "429", apiErrorStatus: 429, finalText: null };

describe("retryDecision (AC-25)", () => {
  it("falls back once on 429 within the cost limit, picking the harness from the model id", () => {
    expect(retryDecision(base, j429, 0.5, 1)).toEqual({ kind: "fallback", model: "openai/gpt-6.1-sol", harness: "pi" });
    expect(retryDecision({ ...base, fallback: "claude-opus-5-5" }, j429, 0.5, 1)).toEqual({ kind: "fallback", model: "claude-opus-5-5", harness: "claude" });
  });
  it("does nothing above the cost limit, without a fallback, or on other failures", () => {
    expect(retryDecision(base, j429, 1.5, 1)).toEqual({ kind: "none" });
    expect(retryDecision({ ...base, fallback: undefined }, j429, 0, 1)).toEqual({ kind: "none" });
    expect(retryDecision(base, { ...j429, apiErrorStatus: 500 }, 0, 1)).toEqual({ kind: "none" });
    expect(retryDecision(base, { ...j429, outcome: "timeout" }, 0, 1)).toEqual({ kind: "none" });
  });
  it("postpones a strong-tier stage instead of downgrading", () => {
    expect(retryDecision({ ...base, name: "review", tier: "strong", fallback: undefined }, j429, 0, 1)).toEqual({ kind: "postpone" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/worktree.test.ts tools/scheduler/test/retry.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/runner/worktree.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export async function ensureWorktree(repo: string, worktreesDir: string, issue: number, base = "origin/main"): Promise<{ path: string; branch: string; created: boolean }> {
  const branch = `issue-${issue}`;
  const path = join(worktreesDir, branch);
  if (existsSync(join(path, ".git"))) return { path, branch, created: false };
  await mkdir(worktreesDir, { recursive: true });
  await git(repo, "worktree", "add", "-B", branch, path, base);
  return { path, branch, created: true };
}

export async function rebaseOntoMain(worktree: string, base = "origin/main"): Promise<{ ok: true; moved: boolean } | { ok: false; conflict: string }> {
  const before = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  try {
    await git(worktree, "rebase", base);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    await git(worktree, "rebase", "--abort").catch(() => {});
    return { ok: false, conflict: `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() };
  }
  const after = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  return { ok: true, moved: before !== after };
}

export async function diffFilesAgainstBase(worktree: string, base = "origin/main"): Promise<string[]> {
  const committed = (await git(worktree, "diff", "--name-only", `${base}...HEAD`)).stdout.split("\n");
  const status = (await git(worktree, "status", "--porcelain", "--untracked-files=all")).stdout.split("\n");
  const dirty = status.filter(Boolean).map((l) => l.slice(3).trim().replace(/^.* -> /, ""));
  return [...new Set([...committed, ...dirty].filter(Boolean))].sort();
}

export async function uncommittedPatch(worktree: string): Promise<string> {
  const untracked = (await git(worktree, "ls-files", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean);
  if (untracked.length) await git(worktree, "add", "--intent-to-add", "--", ...untracked);
  try {
    return (await git(worktree, "diff", "HEAD")).stdout;
  } finally {
    if (untracked.length) await git(worktree, "reset", "-q", "--", ...untracked);
  }
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, "worktree", "remove", "--force", path).catch(async () => {
    await rm(path, { recursive: true, force: true });
    await git(repo, "worktree", "prune");
  });
}
```

`tools/scheduler/src/runner/retry.ts`:

```ts
import type { Judgement } from "../adapters/types.ts";
import type { Harness, StageDefinition } from "../types.ts";

export type RetryDecision = { kind: "none" } | { kind: "fallback"; model: string; harness: Harness } | { kind: "postpone" };

export function harnessForModel(model: string): Harness {
  return model.includes("/") ? "pi" : "claude";
}

/** AC-25: cost-capped fallback on 429 only; strong tier is postponed, never downgraded. */
export function retryDecision(def: StageDefinition, judgement: Judgement, costSoFar: number, retryCostLimit: number): RetryDecision {
  if (judgement.outcome !== "failed" || judgement.apiErrorStatus !== 429) return { kind: "none" };
  if (def.tier === "strong") return { kind: "postpone" };
  if (!def.fallback || costSoFar > retryCostLimit) return { kind: "none" };
  return { kind: "fallback", model: def.fallback, harness: harnessForModel(def.fallback) };
}
```

`tools/scheduler/src/runner/skills.ts`:

```ts
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Harness, Profile } from "../types.ts";

const exec = promisify(execFile);

export function skillsLinkPath(worktree: string, harness: Harness): string {
  return join(worktree, harness === "pi" ? ".agents" : ".claude", "skills");
}

/** AC-26: expose the profile's skills to the harness without ever committing them. */
export async function linkProfileSkills(worktree: string, harness: Harness, profile: Profile): Promise<string> {
  const link = skillsLinkPath(worktree, harness);
  await mkdir(dirname(link), { recursive: true });
  const existing = await lstat(link).catch(() => null);
  if (existing) await rm(link, { recursive: true, force: true });
  await symlink(profile.skillsDir, link, "dir");
  const gitDir = (await exec("git", ["rev-parse", "--git-dir"], { cwd: worktree, encoding: "utf8" })).stdout.trim();
  const excludePath = join(gitDir.startsWith("/") ? gitDir : join(worktree, gitDir), "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  const rel = link.slice(worktree.length + 1);
  const current = await readFile(excludePath, "utf8").catch(() => "");
  if (!current.split("\n").includes(rel)) await appendFile(excludePath, `${rel}\n`);
  return link;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/worktree.test.ts tools/scheduler/test/retry.test.ts`
Expected: 8 passed. If the exclude-file assertion fails, print `git rev-parse --git-dir` from the worktree: for a linked worktree it is `<repo>/.git/worktrees/issue-10`, which is where `info/exclude` must land.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/runner/worktree.ts tools/scheduler/src/runner/retry.ts tools/scheduler/src/runner/skills.ts tools/scheduler/test/worktree.test.ts tools/scheduler/test/retry.test.ts
git commit -m "scheduler: worktree management, diff listing, release patches, 429 retry policy, profile skills linking (AC-16, AC-25, AC-26)"
```

---

### Task 8: The runner

**Files:**
- Create: `tools/scheduler/src/runner/run.ts`
- Test: `tools/scheduler/test/run.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface RunnerContext {
    paths: StatePaths; adapter: Adapter; systemdScope: boolean; systemdRunBin?: string;
    now?: () => Date; sessionId?: () => string; binDir: string;   // binDir is prepended to PATH (gh shim, Task 9)
  }
  interface StageRequest {
    def: StageDefinition; input: StageInput; issue: number; attempt: number; worktree: string; profile: Profile | null;
    model?: string;          // override (fallback retry)
    harness?: Harness;       // override (fallback retry)
  }
  interface StageOutcome {
    runId: string; outcome: RunOutcome; reason: string | null; result: unknown | null; resultErrors: string[];
    judgement: Judgement; usage: UsageRecord; findings: { queued: number; rejected: string[] }; eventsPath: string;
  }
  async function runStage(ctx: RunnerContext, req: StageRequest): Promise<StageOutcome>
  ```
  Behaviour, in order:
  1. `runId = newRunId(issue, def.name, attempt)`; create `runs/<runId>/`; `resultPath = runs/<runId>/result.json`; `sessionId` from ctx (default `crypto.randomUUID()`).
  2. Render the prompt with `result_path` set; write `runs/<runId>/prompt.md` and `input.json` (validated against `stage-input`).
  3. If `profile`, `linkProfileSkills(worktree, harness, profile)`.
  4. `adapter.buildCommand(...)`; write `command.txt` (argv JSON and env keys); spawn with `spawnBounded` (`timeoutMs = bounds.timeout_min * 60_000`, scope unit `panelator-stage-<runId>` when `systemdScope`), streaming stdout into `events.jsonl` through a `JsonlSplitter` and stderr into `stderr.log`. For pi, `killOnEvent` returns true once the count of `turn_end` records exceeds `bounds.max_turns`; the runner then appends `{"type":"scheduler_bounds","reason":"max_turns"}` to the events before judging.
  5. Judge. If `ok`, read `result.json`; if missing or invalid against `def.output`, outcome becomes `failed` with `reason: "result: invalid"` and `resultErrors` (AC-22). If the result file exists but the outcome is `timeout`, it is ignored (review focus 2).
  6. Findings: if the result has a `findings` array, `appendFindings` with the envelope (AC-28). Also when the run failed but a result parsed.
  7. Write the usage record (AC-24) with `outcome`, `events_path` relative to the state root, timestamps from `ctx.now`.
  8. Return.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/run.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { runStage, type RunnerContext, type StageRequest } from "../src/runner/run.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { StageDefinition } from "../src/types.ts";

const script = join(import.meta.dirname, "fixtures", "stage-script.ts");
const planDef: StageDefinition = {
  name: "plan", kind: "agent", harness: "claude", model: "claude-fable-5-1", tier: "strong",
  bounds: { timeout_min: 1, max_turns: 10, max_cost_usd: 1 }, permission: "no-prompt", worktree: "issue", profile: "none",
  input: "stage-input", output: "plan-result", prompt: "Plan {{issue}}\n{{spec}}\nWrite {{result_path}}",
};
const goodPlan = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.ts"] }], findings: [{ what: "w", where: "x", evidence: "e", noticed_how: "n" }, { what: "bad" }] };

function setup(opts: { result?: unknown; exitCode?: number; sleepMs?: number; timeoutMin?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "run-"));
  const paths = statePaths(root);
  const eventsFile = join(root, "fixture-events.jsonl");
  writeFileSync(eventsFile, readFileSync(join(import.meta.dirname, "fixtures", "streams", "claude-success.jsonl")));
  const adapter = fakeAdapter({ events: [], result: opts.result, exitCode: opts.exitCode, scriptPath: script, sleepMs: opts.sleepMs, eventsFile });
  const worktree = join(root, "wt");
  mkdirSync(worktree); // the stage's cwd must exist
  const ctx: RunnerContext = { paths, adapter, systemdScope: false, binDir: join(root, "bin"), now: () => new Date("2026-10-12T00:00:00Z"), sessionId: () => "sess-1" };
  const req: StageRequest = {
    def: { ...planDef, bounds: { ...planDef.bounds, timeout_min: opts.timeoutMin ?? 1 } },
    input: { issue: { number: 7, title: "t", body: "b" }, spec: "# s", result_path: "", profile_instructions: "" },
    issue: 7, attempt: 1, worktree, profile: null,
  };
  return { paths, ctx, req, root };
}

describe("runStage", () => {
  it("records a successful run: events, command, result, usage record, findings (AC-22, AC-24, AC-28)", async () => {
    const { paths, ctx, req } = setup({ result: goodPlan });
    await ensureStateDirs(paths);
    const out = await runStage(ctx, req);
    expect(out.outcome).toBe("ok");
    expect(out.result).toMatchObject({ verdict: "ready" });
    const dir = join(paths.runs, out.runId);
    for (const f of ["command.txt", "events.jsonl", "stderr.log", "result.json", "usage.json", "prompt.md", "input.json"]) expect(existsSync(join(dir, f))).toBe(true);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(6);
    expect(readFileSync(join(dir, "prompt.md"), "utf8")).toContain(join(dir, "result.json"));
    expect(out.usage).toMatchObject({ run_id: out.runId, issue: 7, stage: "plan", attempt: 1, outcome: "ok", harness: "fake", events_path: `runs/${out.runId}/events.jsonl` });
    expect(existsSync(join(paths.usage, `${out.runId}.json`))).toBe(true);
    expect(out.findings).toEqual({ queued: 1, rejected: [expect.stringContaining("rejected")] });
  });
  it("fails with result: invalid when the result file is missing", async () => {
    const { paths, ctx, req } = setup({});
    await ensureStateDirs(paths);
    const out = await runStage(ctx, req);
    expect(out.outcome).toBe("failed");
    expect(out.reason).toBe("result: invalid");
    expect(out.resultErrors[0]).toMatch(/missing/);
  });
  it("fails with result: invalid and the schema errors when the result does not validate", async () => {
    const { paths, ctx, req } = setup({ result: { verdict: "ready" } });
    await ensureStateDirs(paths);
    const out = await runStage(ctx, req);
    expect(out.outcome).toBe("failed");
    expect(out.resultErrors.join(" ")).toMatch(/domain|tasks/);
  });
  it("records failed on a non-zero exit", async () => {
    const { paths, ctx, req } = setup({ result: goodPlan, exitCode: 1 });
    await ensureStateDirs(paths);
    expect((await runStage(ctx, req)).outcome).toBe("failed");
  });
  it("records timeout and ignores a result written before the kill (review focus 2)", async () => {
    const { paths, ctx, req } = setup({ result: goodPlan, sleepMs: 5000 });
    await ensureStateDirs(paths);
    req.def = { ...req.def, bounds: { ...req.def.bounds, timeout_min: 1 / 60 } }; // 1 second
    const out = await runStage(ctx, req);
    expect(out.outcome).toBe("timeout");
    expect(out.result).toBeNull();
    expect(out.usage.outcome).toBe("timeout");
  }, 20_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/run.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`tools/scheduler/src/runner/run.ts`:

```ts
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { JsonlSplitter } from "../adapters/jsonl.ts";
import type { Adapter, Judgement, RunOutcome, StageRun } from "../adapters/types.ts";
import { validate, type SchemaName } from "../schema/validate.ts";
import { renderPrompt, type StageInput } from "../stages/prompt.ts";
import { appendFindings } from "../state/findings.ts";
import type { StatePaths } from "../state/paths.ts";
import { newRunId, runDir, writeUsageRecord, type UsageRecord } from "../state/runs.ts";
import type { Harness, Profile, StageDefinition } from "../types.ts";
import { spawnBounded } from "./process.ts";
import { linkProfileSkills } from "./skills.ts";

export interface RunnerContext {
  paths: StatePaths;
  adapter: Adapter;
  systemdScope: boolean;
  systemdRunBin?: string;
  now?: () => Date;
  sessionId?: () => string;
  binDir: string;
}

export interface StageRequest {
  def: StageDefinition;
  input: StageInput;
  issue: number;
  attempt: number;
  worktree: string;
  profile: Profile | null;
  model?: string;
  harness?: Harness;
}

export interface StageOutcome {
  runId: string;
  outcome: RunOutcome;
  reason: string | null;
  result: unknown | null;
  resultErrors: string[];
  judgement: Judgement;
  usage: UsageRecord;
  findings: { queued: number; rejected: string[] };
  eventsPath: string;
}

const rec = (e: unknown): Record<string, unknown> => (typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {});

export async function runStage(ctx: RunnerContext, req: StageRequest): Promise<StageOutcome> {
  const now = ctx.now ?? (() => new Date());
  const startedAt = now();
  const runId = newRunId(req.issue, req.def.name, req.attempt, startedAt);
  const dir = runDir(ctx.paths, runId);
  await mkdir(dir, { recursive: true });
  const resultPath = join(dir, "result.json");
  const eventsPath = join(dir, "events.jsonl");
  // The fake adapter replays fixtures for any stage definition; the record must say so (AC-24 harness field).
  const harness: Harness = ctx.adapter.harness === "fake" ? "fake" : (req.harness ?? req.def.harness);
  const model = req.model ?? req.def.model;

  const profileInstructions = req.profile
    ? [req.profile.instructions, req.profile.reviewCriteria].filter(Boolean).join("\n\n")
    : req.input.profile_instructions ?? "";
  const input: StageInput = { ...req.input, result_path: resultPath, profile_instructions: profileInstructions };
  const iv = validate("stage-input", input);
  if (!iv.ok) throw new Error(`stage input invalid: ${iv.errors.join("; ")}`);
  const prompt = renderPrompt(req.def.prompt, input);
  await writeFile(join(dir, "prompt.md"), prompt);
  await writeFile(join(dir, "input.json"), JSON.stringify(input, null, 2));

  if (req.profile && harness !== "fake") await linkProfileSkills(req.worktree, harness, req.profile);

  const stageRun: StageRun = {
    runId, stage: req.def.name, attempt: req.attempt, issue: req.issue, prompt, model, bounds: req.def.bounds,
    worktree: req.worktree, sessionId: (ctx.sessionId ?? randomUUID)(), resultPath, profile: req.profile, effort: req.def.effort,
  };
  const cmd = ctx.adapter.buildCommand(stageRun);
  await writeFile(join(dir, "command.txt"), JSON.stringify({ argv: cmd.argv, env: Object.keys(cmd.env), cwd: req.worktree }, null, 2));

  const splitter = new JsonlSplitter();
  const events: unknown[] = [];
  let turnEnds = 0;
  const eventsOut = createWriteStream(eventsPath);
  const stderrOut = createWriteStream(join(dir, "stderr.log"));
  const spawned = await spawnBounded({
    argv: cmd.argv,
    env: { ...cmd.env, PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`, PANELATOR_STATE_DIR: ctx.paths.root },
    cwd: req.worktree,
    timeoutMs: req.def.bounds.timeout_min * 60_000,
    scope: { enabled: ctx.systemdScope, unitName: `panelator-stage-${runId}`, systemdRunBin: ctx.systemdRunBin },
    onStdoutChunk: (c) => {
      eventsOut.write(c);
      for (const e of splitter.push(c)) {
        events.push(e);
        if (rec(e).type === "turn_end") turnEnds++;
      }
    },
    onStderrChunk: (c) => stderrOut.write(c),
    killOnEvent: () => harness === "pi" && turnEnds > req.def.bounds.max_turns,
  });
  const tail = splitter.end();
  events.push(...tail.records);
  if (spawned.killedByEvent) {
    const b = { type: "scheduler_bounds", reason: "max_turns" };
    events.push(b);
    eventsOut.write(JSON.stringify(b) + "\n");
  }
  await new Promise<void>((r) => eventsOut.end(r));
  await new Promise<void>((r) => stderrOut.end(r));

  let judgement = ctx.adapter.judge(events, spawned.exitCode, spawned.timedOut);
  let result: unknown | null = null;
  let resultErrors: string[] = [];
  if (judgement.outcome !== "timeout") {
    const raw = await readFile(resultPath, "utf8").catch(() => null);
    if (raw === null) resultErrors = ["result file missing"];
    else {
      try {
        const parsed = JSON.parse(raw);
        const v = validate(req.def.output as SchemaName, parsed);
        if (v.ok) result = parsed;
        else resultErrors = v.errors;
      } catch (e) {
        resultErrors = [`result file is not JSON: ${(e as Error).message}`];
      }
    }
    if (judgement.outcome === "ok" && resultErrors.length) judgement = { ...judgement, outcome: "failed", reason: "result: invalid" };
  }

  const findingsIn = Array.isArray(rec(result).findings) ? (rec(result).findings as unknown[]) : [];
  const findings = await appendFindings(ctx.paths, { issue: req.issue, stage: req.def.name, run_id: runId, timestamp: now().toISOString() }, findingsIn);

  const endedAt = now();
  const u = ctx.adapter.usage(events);
  const usage: UsageRecord = {
    run_id: runId, issue: req.issue, stage: req.def.name, attempt: req.attempt, outcome: judgement.outcome, harness, model,
    ...u, wall_seconds: Math.max(0.001, spawned.wallMs / 1000), started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(),
    events_path: relative(ctx.paths.root, eventsPath),
  };
  await writeUsageRecord(ctx.paths, usage);

  return { runId, outcome: judgement.outcome, reason: judgement.reason, result, resultErrors, judgement, usage, findings, eventsPath };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run tools/scheduler/test/run.test.ts && pnpm -F @panelator/scheduler typecheck`
Expected: 5 passed; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/src/runner/run.ts tools/scheduler/test/run.test.ts
git commit -m "scheduler: runner that owns the process, validates results, records usage and queues findings (AC-22 to AC-24, AC-28)"
```

---

### Task 9: Token plumbing: gh shim and git credential helper

**Files:**
- Create: `tools/scheduler/bin/gh` (shell, executable)
- Create: `tools/scheduler/bin/git-credential-panelator.ts` (executable)
- Create: `tools/scheduler/src/runner/credentials.ts`
- Test: `tools/scheduler/test/token.test.ts`

**Interfaces:**
- `bin/gh`: reads `$PANELATOR_STATE_DIR/token.json`, exports `GH_TOKEN`, execs the next `gh` on PATH after removing its own directory. Agents call `gh` as usual and never see the token in their prompt or argv.
- `bin/git-credential-panelator.ts`: git credential helper protocol on stdin (`protocol=https`, `host=github.com`); prints `username=x-access-token` and `password=<token>` for github.com, nothing otherwise.
- Produces (`credentials.ts`): `gitCredentialConfig(binDir: string): string[]` returning the `-c` arguments the runner passes (via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` env) so that `credential.helper` is the helper script with `PANELATOR_STATE_DIR` set; and `stageEnv(binDir, stateDir): Record<string,string>` merging `PATH`, `PANELATOR_STATE_DIR`, `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=credential.helper`, `GIT_CONFIG_VALUE_0=<binDir>/git-credential-panelator.ts`. Update `runStage` (Task 8) to spread `stageEnv(ctx.binDir, ctx.paths.root)` into the spawn env instead of setting `PATH` and `PANELATOR_STATE_DIR` by hand.

- [ ] **Step 1: Write the failing tests**

`tools/scheduler/test/token.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tools/scheduler/test/token.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`tools/scheduler/bin/gh`:

```sh
#!/bin/sh
# gh shim for pipeline stages (spec 001 section 12): the App installation token never
# appears in a prompt or argv; it is read here from the scheduler's state directory.
set -eu
self_dir=$(cd "$(dirname "$0")" && pwd)
state="${PANELATOR_STATE_DIR:?PANELATOR_STATE_DIR is not set}"
token_file="$state/token.json"
if [ -r "$token_file" ]; then
  GH_TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$token_file")
  export GH_TOKEN
fi
# drop our own directory from PATH and exec the real gh
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx "$self_dir" | paste -sd: -)
export PATH
exec gh "$@"
```

`chmod +x tools/scheduler/bin/gh`.

`tools/scheduler/bin/git-credential-panelator.ts`:

```ts
#!/usr/bin/env node
// git credential helper: answers github.com with the App installation token from token.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const op = process.argv[2];
const input = readFileSync(0, "utf8");
const fields = Object.fromEntries(input.split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2) as [string, string]));
if (op === "get" && fields.host === "github.com") {
  const stateDir = process.env.PANELATOR_STATE_DIR;
  if (stateDir) {
    try {
      const t = JSON.parse(readFileSync(join(stateDir, "token.json"), "utf8")) as { token?: string };
      if (t.token) process.stdout.write(`username=x-access-token\npassword=${t.token}\n`);
    } catch {
      /* no token: say nothing, git falls through to other helpers */
    }
  }
}
```

`chmod +x tools/scheduler/bin/git-credential-panelator.ts`.

`tools/scheduler/src/runner/credentials.ts`:

```ts
import { join } from "node:path";

/** Environment every stage gets so gh and git authenticate as the App without seeing the token (spec section 12). */
export function stageEnv(binDir: string, stateDir: string): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PANELATOR_STATE_DIR: stateDir,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: join(binDir, "git-credential-panelator.ts"),
  };
}
```

In `tools/scheduler/src/runner/run.ts`, replace

```ts
    env: { ...cmd.env, PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`, PANELATOR_STATE_DIR: ctx.paths.root },
```

with

```ts
    env: { ...cmd.env, ...stageEnv(ctx.binDir, ctx.paths.root) },
```

and add `import { stageEnv } from "./credentials.ts";`.

Note: git runs the helper as `<value>` via `sh -c`, so the `.ts` file must be executable and its shebang must resolve to a Node that strips types (Node 26 does). If `#!/usr/bin/env node` finds an older Node on the service's PATH, the plan-3 systemd unit sets `PATH` to the Node 26 directory first.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tools/scheduler/test/token.test.ts tools/scheduler/test/run.test.ts`
Expected: 3 + 5 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scheduler/bin tools/scheduler/src/runner/credentials.ts tools/scheduler/src/runner/run.ts tools/scheduler/test/token.test.ts
git commit -m "scheduler: gh shim and git credential helper so agents never handle the App token (spec section 12)"
```

---

### Task 10: Plan-2 wrap-up

- [ ] **Step 1: Run the full suite and typecheck**

Run: `pnpm test && pnpm -F @panelator/scheduler typecheck`
Expected: all test files pass; tsc clean.

- [ ] **Step 2: Record the fixture provenance**

Create `tools/scheduler/test/fixtures/streams/README.md`:

```markdown
Recorded event streams used by the adapter tests (spec 001 section 17).

- `claude-*.jsonl`: Claude Code 2.1.287, `claude -p ... --output-format stream-json --verbose`, recorded 2026-10-12 and trimmed to the fields the adapter reads. `claude-success` is a real run with the hook and thinking records removed; the error, bounds and 429 variants are the real `result` shape with `subtype`, `is_error`, `api_error_status` set as the CLI emits them.
- `pi-*.jsonl`: pi 1.0.0, `pi --mode json`, recorded 2026-10-12. `pi-error-exit0` is a real run (pi exited 0 with `stopReason: "error"`, 03 F8); `pi-success` is a real run against `openai/gpt-6-astra`; `pi-tool-calls` is synthetic in the documented shape (pi `docs/json.md`).

Re-record when a harness changes its event shape; keep the file names, the tests key on them.
```

- [ ] **Step 3: Commit**

```bash
git add tools/scheduler/test/fixtures/streams/README.md
git commit -m "scheduler: fixture provenance for recorded harness streams"
```

---

## Self-review against the spec

- Section 4 modules in this plan: `adapters/` (Tasks 3 to 5), `runner/` (Tasks 6 to 9), `state/` (Tasks 1, 2).
- Section 11 state directory: every path in the listing exists in `statePaths` and `ensureStateDirs`; `token.json` mode 0600; 180-day usage retention.
- Section 12: token plumbing in Task 9; token refresh itself is plan 3 (`github/auth.ts`).
- Section 13 adapters: claude flags and judgement (Task 4), pi flags, stream-based judgement, runner-enforced turns (Tasks 5, 8), fake (Task 5), cross-harness fallback rule (Task 7 `retryDecision`), continuous stdout reading (Task 8 streams chunks as they arrive).
- Section 14: transient scope properties in `scopeArgv` (Task 6); the sleep inhibitor and `CI=true` for every stage are in the adapters' env (Tasks 4, 5) and plan 3's service.
- AC coverage: AC-18, AC-19, AC-20, AC-21, AC-22, AC-23, AC-24, AC-25 (policy), AC-26, AC-28, AC-30 (scope part). AC-16's rebase is Task 7, driven by plan 3.
- Review focus items 1 to 5 each have a named test.
