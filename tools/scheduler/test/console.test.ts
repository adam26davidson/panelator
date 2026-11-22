import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionLog } from "../src/actions/log.ts";
import { loadConfig } from "../src/config.ts";
import { buildConsoleState } from "../src/console/state.ts";
import { ParameterStore } from "../src/parameters/store.ts";
import { validate } from "../src/schema/validate.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

export async function consoleCtx() {
  const dir = mkdtempSync(join(tmpdir(), "console-"));
  const cfgPath = join(dir, "s.yaml");
  writeFileSync(cfgPath, `repo: a/b\nmaintainer: me\napp: {bot_login: bot}\nstate_dir: ${dir}/state\n`);
  const cfg = loadConfig(cfgPath);
  const paths = statePaths(cfg.state_dir);
  await ensureStateDirs(paths);
  const parameters = new ParameterStore(paths, {
    aws_cap_usd: { name: "aws_cap_usd", type: "number", default: 0, min: 0, max: 100, mode: "locked", description: "The monthly AWS cap" },
    batch: { name: "batch", type: "number", default: 3, min: 1, max: 9, mode: "auto", description: "Batch size for tests" },
  });
  await parameters.initialize();
  const log = new ActionLog(paths.actionsLog, paths);
  const base = { cfg, paths, parameters, log, registry: {}, metrics: {}, now: () => new Date("2026-11-22T10:00:00Z") };
  return { dir, cfg, paths, parameters, log, base };
}

describe("buildConsoleState (spec 051 AC-2)", () => {
  it("is valid with every optional source missing", async () => {
    const { base } = await consoleCtx();
    const s = await buildConsoleState(base);
    expect(validate("console-state", s)).toEqual({ ok: true });
    expect(s).toMatchObject({ questions: [], current: [], up_next: [], metrics: null, actions: [], changes: [], tick_s: 45 });
    expect(s.tiles.aws).toEqual({ actual_usd: null, forecast_usd: null, cap_usd: 0 });
    expect(s.next_tick_at).toBe("2026-11-22T10:00:45.000Z");
    expect(s.parameters.map((p) => p.name).sort()).toEqual(["aws_cap_usd", "batch"]);
  });
  it("folds the questions log to one entry per comment, newest event deciding", async () => {
    const { base, paths } = await consoleCtx();
    const q = { kind: "product", question: "Which?", options: [{ label: "A", cost: "c" }], recommendation: "A" };
    const lines = [
      { issue: 5, at: "2026-11-20T00:00:00Z", event: "asked", asking_stage: "plan", question_comment_id: 11, question: q },
      { issue: 5, at: "2026-11-21T00:00:00Z", event: "reminded", asking_stage: "plan", question_comment_id: 11 },
      { issue: 6, at: "2026-11-20T01:00:00Z", event: "asked", asking_stage: "plan", question_comment_id: 12, question: q },
      { issue: 6, at: "2026-11-21T01:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 12, reply_comment_id: 99, answer: "A" },
    ];
    writeFileSync(paths.questionsLog, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const s = await buildConsoleState({ ...base, telegramUsername: () => "panel_bot" });
    expect(validate("console-state", s)).toEqual({ ok: true });
    expect(s.questions.map((x) => [x.question_comment_id, x.status])).toEqual([[11, "reminded"], [12, "answered"]]);
    expect(s.questions[1]).toMatchObject({ decision_url: "https://github.com/a/b/issues/6#issuecomment-99", question_url: "https://github.com/a/b/issues/6#issuecomment-12", telegram_url: "https://t.me/panel_bot", text: "Which?", options: [{ label: "A", cost: "c", recommended: true }] });
    expect(s.questions[0]).toMatchObject({ reminded_at: "2026-11-21T00:00:00Z" });
  });
  it("carries the last 50 changes and the cost record", async () => {
    const { base, paths } = await consoleCtx();
    mkdirSync(join(paths.root, "aws"), { recursive: true });
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, at: "2026-11-22T00:00:00Z", by: "me", kind: "pause_agent", args: { name: "x" }, status: "applied" }));
    writeFileSync(paths.consoleChanges, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const s = await buildConsoleState(base);
    expect(s.changes).toHaveLength(50);
    expect(s.changes[0].id).toBe(11);
    expect(validate("console-state", s)).toEqual({ ok: true });
  });
});

import { readFileSync } from "node:fs";
import { KINDS, type ActionContext } from "../src/actions/index.ts";
import { loadParameterDefinitions } from "../src/parameters/definitions.ts";
import { applyChange, cursor } from "../src/console/apply.ts";
import { readAgentState, writeAgentState } from "../src/standing/state.ts";

async function applyCtx() {
  const c = await consoleCtx();
  const parameters = new ParameterStore(c.paths, loadParameterDefinitions("agents/parameters.yaml", { slots: 1 }, {}));
  await parameters.initialize();
  const ctx: ActionContext = {
    paths: c.paths, parameters, log: c.log, levels: Object.fromEntries(Object.keys(KINDS).map((k) => [k, 1])), now: () => new Date("2026-11-22T10:00:00Z"),
    gh: { rerunWorkflowRun: async () => {}, cancelWorkflowRun: async () => {} },
  };
  await writeAgentState(c.paths, "audit", { last_run: null, next_run: null, pending_events: [], paused: false, paused_by: null, failures: 0 });
  const change = (id: number, kind: string, args: Record<string, unknown>) => ({ id, at: "2026-11-22T09:59:00Z", by: "me", kind, args });
  return { ...c, ctx, parameters, change };
}

describe("applyChange (spec 051 AC-4)", () => {
  it("applies set_parameter as the maintainer with run_id console:<id>, and the same id once", async () => {
    const { ctx, change, log, paths } = await applyCtx();
    const r = await applyChange(ctx, change(1, "set_parameter", { name: "system_work_share", value: 0.5 }));
    expect(r.change.status).toBe("applied");
    expect((await ctx.parameters.read("system_work_share")).value).toBe(0.5);
    const rows = await log.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "maintainer", run_id: "console:1", kind: "set_parameter" });
    expect(r.change.action_id).toBe(rows[0].id);
    const again = await applyChange(ctx, change(1, "set_parameter", { name: "system_work_share", value: 0.9 }));
    expect(again.fresh).toBe(false);
    expect(again.change).toEqual(r.change);
    expect(await log.list()).toHaveLength(1);
    expect((await ctx.parameters.read("system_work_share")).value).toBe(0.5);
    expect(await cursor(ctx)).toBe(1);
    expect(readFileSync(paths.consoleChanges, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("applies a locked parameter change, since the maintainer may", async () => {
    const { ctx, change } = await applyCtx();
    expect((await applyChange(ctx, change(2, "set_parameter", { name: "aws_cap_usd", value: 5 }))).change.status).toBe("applied");
  });
  it("pauses, resumes and undoes", async () => {
    const { ctx, change, paths, log } = await applyCtx();
    const p = await applyChange(ctx, change(3, "pause_agent", { name: "audit" }));
    expect(p.change.status).toBe("applied");
    expect((await readAgentState(paths, "audit"))?.paused).toBe(true);
    const u = await applyChange(ctx, change(4, "undo", { action_id: p.change.action_id }));
    expect(u.change.status).toBe("applied");
    expect((await readAgentState(paths, "audit"))?.paused).toBe(false);
    expect((await log.list()).find((r) => r.id === u.change.action_id)?.run_id).toBe("console:4");
    expect((await applyChange(ctx, change(5, "pause_agent", { name: "audit" }))).change.status).toBe("applied");
    expect((await applyChange(ctx, change(6, "resume_agent", { name: "audit" }))).change.status).toBe("applied");
    expect((await readAgentState(paths, "audit"))?.paused).toBe(false);
  });
  it("records a mode change in the parameter history and not in the action log", async () => {
    const { ctx, change, paths, log } = await applyCtx();
    const r = await applyChange(ctx, change(7, "set_parameter_mode", { name: "system_work_share", mode: "locked" }));
    expect(r.change.status).toBe("applied");
    expect(readFileSync(paths.parametersHistory, "utf8")).toContain('"field":"mode"');
    expect(await log.list()).toHaveLength(0);
  });
  it("refuses unknown kinds, malformed args, unknown names and bad values, applying nothing", async () => {
    const { ctx, change, log } = await applyCtx();
    for (const [i, c] of [["run_agent", { name: "audit" }], ["set_parameter", { name: "system_work_share" }], ["set_parameter", { name: "nope", value: 1 }], ["set_parameter", { name: "system_work_share", value: 99 }], ["undo", { action_id: "missing" }], ["set_parameter_mode", { name: "nope", mode: "locked" }], ["set_parameter_mode", { name: "system_work_share", mode: "x" }]].entries()) {
      const r = await applyChange(ctx, change(20 + i, c[0] as string, c[1] as Record<string, unknown>));
      expect(r.change.status, String(c[0])).toBe("refused");
      expect(r.change.reason).toBeTruthy();
    }
    expect((await ctx.parameters.read("system_work_share")).value).toBe(0.75);
    expect((await log.list()).every((r) => r.status !== "applied")).toBe(true);
  });
});

import { ConsolePusher } from "../src/console/push.ts";
import { ConsolePoller } from "../src/console/poll.ts";
import { handle } from "../../../console/api/handlers.ts";
import { MemoryTable } from "../../../console/api/table.ts";

const ccfg = { url: "https://c.example", credentials_path: "/none", github_client_id: "id", push_min_s: 30, long_poll_s: 25 };
const SECRET = "sekrit-key-123";

function fakeNet() {
  const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
  let failPut = false;
  const queue: unknown[][] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (method === "PUT" && failPut) return new Response("no", { status: 500 });
    if (url.includes("/changes?")) return new Response(JSON.stringify({ changes: queue.shift() ?? [] }));
    return new Response("{}");
  };
  return { calls, fetch, queue, fail: (v: boolean) => { failPut = v; } };
}

describe("push (spec 051 AC-3)", () => {
  it("pushes on the first tick, not again inside push_min_s without change, again on change or after push_min_s", async () => {
    const net = fakeNet();
    let t = 1_000_000, n = 0;
    const logs: Record<string, unknown>[] = [];
    const p = new ConsolePusher({ cfg: ccfg, fetch: net.fetch, readKey: async () => SECRET, now: () => new Date(t), log: (r) => logs.push(r), build: async () => ({ generated_at: String(t), v: 1 + (n > 0 ? 1 : 0) }) });
    const puts = () => net.calls.filter((c) => c.method === "PUT").length;
    await p.tick(); expect(puts()).toBe(1);
    t += 10_000; await p.tick(); expect(puts()).toBe(1);
    n = 1; t += 1000; await p.tick(); expect(puts()).toBe(2);
    t += 31_000; await p.tick(); expect(puts()).toBe(3);
    expect(net.calls[0].auth).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
  it("logs a failed push once per change of outcome and retries at the next tick", async () => {
    const net = fakeNet();
    let t = 0;
    const logs: Record<string, unknown>[] = [];
    const p = new ConsolePusher({ cfg: ccfg, fetch: net.fetch, readKey: async () => SECRET, now: () => new Date(t), log: (r) => logs.push(r), build: async () => ({ generated_at: "x" }) });
    net.fail(true);
    await p.tick(); t += 1000; await p.tick(); await p.tick();
    expect(logs.filter((l) => l.status === "push-failed")).toHaveLength(1);
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(3);
    net.fail(false); t += 1000; await p.tick();
    expect(logs.at(-1)).toMatchObject({ status: "push-recovered" });
  });
  it("debounces event pushes to one per push_min_s", async () => {
    const net = fakeNet();
    let t = 100_000;
    const timers: (() => void)[] = [];
    const p = new ConsolePusher({ cfg: ccfg, fetch: net.fetch, readKey: async () => SECRET, now: () => new Date(t), log: () => {}, build: async () => ({ generated_at: "x" }), setTimer: (f) => { timers.push(f); return 1; } });
    await p.tick();
    p.notify(); p.notify(); p.notify();
    expect(timers).toHaveLength(1);
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    t += 30_000; timers[0](); await new Promise((r) => setTimeout(r, 5));
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });
});

describe("event push debounce and hung console (spec 051 AC-3)", () => {
  it("a burst of events after a quiet minute shares one timer and one push; a failing API is not hit per event", async () => {
    const net = fakeNet();
    const t = 1_000_000;
    const timers: (() => void)[] = [];
    const p = new ConsolePusher({ cfg: ccfg, fetch: net.fetch, readKey: async () => SECRET, now: () => new Date(t), log: () => {}, build: async () => ({ generated_at: "x" }), setTimer: (f) => { timers.push(f); return 1; } });
    p.notify(); p.notify(); p.notify();
    expect(timers).toHaveLength(1);
    net.fail(true);
    timers[0](); await p.idle();
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    p.notify(); p.notify();
    expect(timers).toHaveLength(2); // counted from the failed attempt: it waits push_min_s, not zero
  });
  it("a PUT that never answers is aborted by its timeout", async () => {
    const p = new ConsolePusher({ cfg: ccfg, fetch: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))), readKey: async () => SECRET, now: () => new Date(0), log: () => {}, build: async () => ({ generated_at: "x" }), timeout_ms: 20 });
    await p.now();
  });
});

describe("event pushes (spec 051 AC-3)", () => {
  it("a question, claim, action or parameter write is seen on its state file and notifies the pusher", async () => {
    const { watchConsoleSources } = await import("../src/console/watch.ts");
    const { appendQuestionLog } = await import("../src/state/questions.ts");
    const { writeFile } = await import("node:fs/promises");
    const { ctx, paths } = await applyCtx();
    let n = 0;
    const w = watchConsoleSources(paths, () => { n += 1; });
    const seen = async (what: string, act: () => Promise<unknown>) => {
      const before = n;
      await act();
      for (let i = 0; i < 200 && n === before; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(n, what).toBeGreaterThan(before);
    };
    try {
      await seen("parameter", () => ctx.parameters.setParameter("system_work_share", 0.4, "maintainer"));
      await seen("action", () => ctx.log.writePending({ kind: "pause_agent", args: { name: "x" }, agent: "maintainer", run_id: "r", why: "a reason of enough length", undo: null }));
      await seen("claim", () => writeFile(join(paths.claims, "999.json"), "{}"));
      await seen("question", () => appendQuestionLog(paths, { issue: 1, at: "2026-11-22T10:00:00Z", event: "asked", asking_stage: "plan" as never, question: { question: "q?", options: [] } as never }).catch(() => writeFile(paths.questionsLog, "\n", { flag: "a" })));
      const quiet = n;
      await writeFile(join(paths.claims, "999.json.tmp"), "{}");
      await new Promise((r) => setTimeout(r, 100));
      expect(n).toBe(quiet);
    } finally { w.close(); }
    const closed = n;
    await writeFile(join(paths.claims, "1000.json"), "{}");
    await new Promise((r) => setTimeout(r, 100));
    expect(n).toBe(closed);
  });
});

describe("poll result POST failure (spec 051 AC-4)", () => {
  it("retries the outcome of a recorded change instead of losing it with the cursor", async () => {
    const { ctx, change } = await applyCtx();
    const net = fakeNet();
    let failPost = true;
    const f = async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && failPost) { net.calls.push({ url, method: "POST", body: init?.body as string }); return new Response("no", { status: 503 }); }
      return net.fetch(url, init);
    };
    const pusher = new ConsolePusher({ cfg: ccfg, fetch: net.fetch, readKey: async () => SECRET, now: () => new Date(), log: () => {}, build: async () => ({ generated_at: "x" }) });
    const poller = new ConsolePoller({ cfg: ccfg, fetch: f, readKey: async () => SECRET, action: () => ctx, pusher, log: () => {} });
    net.queue.push([change(1, "set_parameter", { name: "system_work_share", value: 0.5 })]);
    expect(await poller.once()).toBe(1);
    await pusher.idle();
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(1); // the push after the change still happened
    failPost = false;
    await poller.once();
    const posts = net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/changes/1/result"));
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1].body!)).toMatchObject({ status: "applied" });
    expect((await ctx.parameters.read("system_work_share")).value).toBe(0.5);
  });
});

describe("poll result POST outcomes (spec 051 AC-4)", () => {
  const mk = async (post: (url: string) => Response | Promise<Response>) => {
    const { ctx, change } = await applyCtx();
    const net = fakeNet();
    const f = async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") { net.calls.push({ url, method: "POST", body: init?.body as string }); return post(url); }
      return net.fetch(url, init);
    };
    const logs: Record<string, unknown>[] = [];
    const pusher = new ConsolePusher({ cfg: ccfg, fetch: net.fetch, readKey: async () => SECRET, now: () => new Date(), log: () => {}, build: async () => ({ generated_at: "x" }) });
    const poller = new ConsolePoller({ cfg: ccfg, fetch: f, readKey: async () => SECRET, action: () => ctx, pusher, log: (r) => logs.push(r) });
    return { net, poller, logs, change };
  };
  it("a failing result retry does not stop the poll from asking for changes", async () => {
    const t = await mk(() => new Response("no", { status: 503 }));
    t.net.queue.push([t.change(1, "pause_agent", { name: "audit" })]);
    await t.poller.once();
    t.net.calls.length = 0;
    await t.poller.once();
    expect(t.net.calls.some((c) => c.method === "GET" && c.url.includes("after=1"))).toBe(true);
    expect(t.logs.filter((l) => l.status === "result-failed")).toHaveLength(1);
  });
  it("a 404 on a result POST is permanent: logged once, dropped, never retried", async () => {
    const t = await mk(() => new Response("no such change", { status: 404 }));
    t.net.queue.push([t.change(1, "pause_agent", { name: "audit" })]);
    await t.poller.once();
    await t.poller.once();
    await t.poller.once();
    expect(t.net.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(t.logs.filter((l) => l.status === "result-dropped")).toHaveLength(1);
  });
  it("a 429 is retried", async () => {
    let n = 0;
    const t = await mk(() => (n++ === 0 ? new Response("slow", { status: 429 }) : new Response("{}")));
    t.net.queue.push([t.change(1, "pause_agent", { name: "audit" })]);
    await t.poller.once();
    await t.poller.once();
    expect(t.net.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });
  it("an old cursor from an earlier table is below every id of a fresh one: its first change is applied", async () => {
    const { ctx, change } = await applyCtx();
    await applyChange(ctx, change(7, "pause_agent", { name: "audit" })); // the laptop's old cursor is 7
    const table = new MemoryTable();
    const hash = createHash("sha256").update(SECRET).digest("hex");
    const d = { table, keyHash: hash, maintainer: "me", clientId: "c", clientSecret: async () => "s", fetch: async () => new Response("{}"), now: () => 1_800_000_000_000, sleep: async () => {} };
    await table.addChange({ at: "2026-11-22T09:59:00Z", by: "me", kind: "resume_agent", args: { name: "audit" } }, d.now());
    const f = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const r = await handle(d, { method: init?.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init?.headers as Record<string, string>, body: (init?.body as string) ?? "" });
      return new Response(r.body, { status: r.status });
    };
    const pusher = new ConsolePusher({ cfg: ccfg, fetch: f, readKey: async () => SECRET, now: () => new Date(), log: () => {}, build: async () => ({ generated_at: "x" }) });
    const poller = new ConsolePoller({ cfg: ccfg, fetch: f, readKey: async () => SECRET, action: () => ctx, pusher, log: () => {} });
    expect(await poller.once()).toBe(1);
    expect((await readAgentState(ctx.paths, "audit"))?.paused).toBe(false);
  });
});

describe("poll (spec 051 AC-4)", () => {
  it("applies a pulled set_parameter, posts its outcome and pushes after it", async () => {
    const { ctx, change } = await applyCtx();
    const net = fakeNet();
    const pusher = new ConsolePusher({ cfg: ccfg, fetch: net.fetch, readKey: async () => SECRET, now: () => new Date(), log: () => {}, build: async () => ({ generated_at: "x" }) });
    const logs: Record<string, unknown>[] = [];
    const poller = new ConsolePoller({ cfg: ccfg, fetch: net.fetch, readKey: async () => SECRET, action: () => ctx, pusher, log: (r) => logs.push(r) });
    net.queue.push([change(1, "set_parameter", { name: "system_work_share", value: 0.5 }), change(2, "bogus", {})]);
    expect(await poller.once()).toBe(2);
    expect(net.calls[0].url).toBe("https://c.example/changes?after=0&wait=25");
    const posts = net.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual(["https://c.example/changes/1/result", "https://c.example/changes/2/result"]);
    expect(JSON.parse(posts[0].body!)).toMatchObject({ status: "applied" });
    expect(JSON.parse(posts[1].body!)).toMatchObject({ status: "refused" });
    await pusher.idle();
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    expect((await ctx.parameters.read("system_work_share")).value).toBe(0.5);
    net.queue.push([]);
    await poller.once();
    expect(net.calls.at(-1)!.url).toContain("after=2");
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});

import { existsSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { CONSOLE_MONTHLY_USD, CONSOLE_WHAT, deployConsole, destroyConsole } from "../src/console/deploy.ts";
import { awsWorld } from "./helpers/aws.ts";

const stackJson = { Stacks: [{ Outputs: [{ OutputKey: "BucketName", OutputValue: "bkt" }, { OutputKey: "DistributionId", OutputValue: "DIST1" }, { OutputKey: "FunctionName", OutputValue: "fn" }, { OutputKey: "ConsoleUrl", OutputValue: "https://d.example" }] }] };

describe("console deploy (spec 051 AC-7)", () => {
  const opts = (w: Awaited<ReturnType<typeof awsWorld>>, printed: string[] = []) => ({
    ctx: w.ctx, maintainer: "me", clientId: "cid", credentialsPath: join(w.dir, "cred", "console.json"), templatePath: "console/infra/stack.yaml",
    build: async () => ({ appDir: "/tmp/app", lambdaZip: "/tmp/lambda.zip" }), print: (l: string) => printed.push(l),
  });
  const stack = (w: Awaited<ReturnType<typeof awsWorld>>) => writeFileSync(join(w.dir, "fixtures", "stack.json"), JSON.stringify(stackJson));
  const ledger = (w: Awaited<ReturnType<typeof awsWorld>>) => JSON.parse(readFileSync(w.ctx.paths.awsLedger, "utf8")).reservations as { what: string; released_at: string | null }[];

  it("is refused at cap 0 and with AWS off, deploying and calling nothing but the identity check", async () => {
    const w = await awsWorld({ cap: 0 });
    await expect(deployConsole(opts(w))).rejects.toThrow(/cap is 0|aws_cap_usd is 0/);
    expect(w.calls().every((c) => c[0] === "sts")).toBe(true);
    const off = await awsWorld({ config: null });
    await expect(deployConsole(opts(off))).rejects.toThrow(/aws is off/);
    expect(off.calls()).toEqual([]);
  });

  it("reserves, deploys with the hash and never the key, writes the key 0600, and a second deploy keeps both", async () => {
    const w = await awsWorld({ cap: 100 });
    stack(w);
    const printed: string[] = [];
    const o = opts(w, printed);
    const r = await deployConsole(o);
    expect(r.url).toBe("https://d.example");
    expect(printed).toEqual(["https://d.example"]);
    const key = (JSON.parse(readFileSync(o.credentialsPath, "utf8")) as { api_key: string }).api_key;
    expect(statSync(o.credentialsPath).mode & 0o777).toBe(0o600);
    const hash = createHash("sha256").update(key).digest("hex");
    const calls = w.calls();
    const dep = calls.find((c) => c[0] === "cloudformation" && c[1] === "deploy")!;
    expect(dep).toContain(`ApiKeyHash=${hash}`);
    expect(dep).toContain("MaintainerLogin=me");
    expect(JSON.stringify(calls)).not.toContain(key);
    expect(JSON.stringify(w.logs)).not.toContain(key);
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(expect.arrayContaining(["lambda update-function-code", "s3 sync", "cloudfront create-invalidation"]));
    const rs = ledger(w);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ what: CONSOLE_WHAT, expected_monthly_usd: CONSOLE_MONTHLY_USD });
    await deployConsole(o);
    expect(ledger(w)).toHaveLength(1);
    expect((JSON.parse(readFileSync(o.credentialsPath, "utf8")) as { api_key: string }).api_key).toBe(key);
  });

  it("destroy deletes the stack and releases the reservation", async () => {
    const w = await awsWorld({ cap: 100 });
    stack(w);
    await deployConsole(opts(w));
    await destroyConsole(w.ctx);
    expect(w.calls().map((c) => c.slice(0, 2).join(" "))).toEqual(expect.arrayContaining(["cloudformation delete-stack", "cloudformation wait"]));
    expect(ledger(w)[0].released_at).not.toBeNull();
  });
});

describe("console destroy and domain (spec 051 AC-7)", () => {
  const w0 = async () => {
    const w = await awsWorld({ cap: 100 });
    writeFileSync(join(w.dir, "fixtures", "stack.json"), JSON.stringify(stackJson));
    await deployConsole({ ctx: w.ctx, maintainer: "me", clientId: "c", credentialsPath: join(w.dir, "cred", "console.json"), templatePath: "t.yaml", build: async () => ({ appDir: "/tmp/app", lambdaZip: "/tmp/l.zip" }), print: () => {} });
    return w;
  };
  const open = (w: Awaited<ReturnType<typeof awsWorld>>) => (JSON.parse(readFileSync(w.ctx.paths.awsLedger, "utf8")).reservations as { released_at: string | null }[]).filter((r) => r.released_at === null).length;
  it("fails with the reservation kept when describe-stacks fails for any reason but a missing stack", async () => {
    const w = await w0();
    writeFileSync(join(w.dir, "fixtures", "fail-cf"), "");
    await expect(destroyConsole(w.ctx)).rejects.toThrow(/describe-stacks failed/);
    expect(w.calls().some((c) => c[1] === "delete-stack")).toBe(false);
    expect(open(w)).toBe(1);
  });
  it("releases the reservation when the stack is already absent, deleting nothing", async () => {
    const w = await w0();
    rmSync(join(w.dir, "fixtures", "stack.json"));
    await destroyConsole(w.ctx);
    expect(w.calls().some((c) => c[1] === "delete-stack")).toBe(false);
    expect(open(w)).toBe(0);
  });
  it("refuses a domain outside us-east-1 before reserving anything", async () => {
    const w = await awsWorld({ cap: 100 });
    await expect(deployConsole({ ctx: w.ctx, maintainer: "me", clientId: "c", domain: "x.example", credentialsPath: join(w.dir, "c.json"), templatePath: "t", build: async () => ({ appDir: "a", lambdaZip: "z" }), print: () => {} })).rejects.toThrow(/us-east-1/);
    expect(w.calls()).toEqual([]);
  });
});

describe("console/infra/stack.yaml routing", () => {
  it("has no distribution-wide error response, and the API paths have behaviours of their own", () => {
    const yaml = readFileSync("console/infra/stack.yaml", "utf8");
    expect(yaml).not.toContain("CustomErrorResponses");
    for (const p of ["/auth/*", "/state", "/changes*"]) expect(yaml).toContain(`PathPattern: ${p}`);
    expect(yaml).toContain("sign-in-refused");
  });
  it("stays inside the IAM actions of spec 051 section 9 step 2 and creates the domain's hosted zone", () => {
    const yaml = readFileSync("console/infra/stack.yaml", "utf8");
    expect(yaml).not.toContain("ManagedPolicyArns"); // would need iam:AttachRolePolicy
    expect(yaml).toContain("logs:PutLogEvents");
    expect(yaml).toContain("AWS::Route53::HostedZone");
  });
});

describe("console/infra/stack.yaml", () => {
  it("parses and declares the resources and the NoEcho key hash", () => {
    const yaml = readFileSync("console/infra/stack.yaml", "utf8");
    const t = parseYaml(yaml, { customTags: ["!Ref", "!Sub", "!GetAtt", "!If", "!Not", "!Equals"].map((tag) => ({ tag, resolve: (v: unknown) => v })) as never }) as { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, { Type: string }> };
    const types = Object.values(t.Resources).map((r) => r.Type);
    for (const need of ["AWS::S3::Bucket", "AWS::CloudFront::Distribution", "AWS::ApiGatewayV2::Api", "AWS::Lambda::Function", "AWS::DynamoDB::Table", "AWS::IAM::Role", "AWS::Route53::RecordSet", "AWS::CertificateManager::Certificate"]) expect(types).toContain(need);
    expect(t.Parameters.ApiKeyHash.NoEcho).toBe(true);
    expect(existsSync("console/infra/stack.yaml")).toBe(true);
  });
});

import { initialChainState } from "../src/chain/machine.ts";
import { writeClaim } from "../src/state/claims.ts";
import { writeUsageRecord } from "../src/state/runs.ts";

describe("current claims and agent cost (spec 051 AC-2)", () => {
  const usage = (run_id: string, issue: number, stage: string, started_at: string, cost: number) => ({
    run_id, issue, stage, attempt: 1, outcome: "ok" as const, harness: "claude" as const, model: "claude-opus-5-5", cost_usd: cost, input_tokens: 1, output_tokens: 1,
    cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 1, wall_seconds: 5, started_at, ended_at: started_at, events_path: "x",
  });
  it("sums the cost of a claim's runs, names its stages and its model, and counts a standing agent's 30 days", async () => {
    const { base, paths } = await consoleCtx();
    const started = "2026-11-22T09:00:00Z";
    await writeClaim(paths, { issue: 7, state: { ...initialChainState(7), stage: "implement", track: "issue", pr: { number: 21, head_sha: "a".repeat(40) } }, worktree: "/w", started_at: started, last_activity_at: started, run_id: null });
    await writeUsageRecord(paths, usage("7-plan-1-20261122T090100", 7, "plan", "2026-11-22T09:01:00Z", 1.25));
    await writeUsageRecord(paths, usage("7-implement-1-20261122T091000", 7, "implement", "2026-11-22T09:10:00Z", 2));
    await writeUsageRecord(paths, usage("8-plan-1-20261122T090100", 8, "plan", "2026-11-22T09:01:00Z", 9));
    await writeUsageRecord(paths, usage("standing-audit-20261121T000000", 0, "audit", "2026-11-21T00:00:00Z", 0.5));
    const s = await buildConsoleState({ ...base, registry: { audit: {} as never }, issues: () => new Map([[7, { title: "Seven", class: "tooling" }]]), upNext: () => [7] });
    expect(validate("console-state", s)).toEqual({ ok: true });
    expect(s.current).toHaveLength(1);
    expect(s.current[0]).toMatchObject({ issue: 7, title: "Seven", stage: "implement", model: "claude-opus-5-5", cost_usd: 3.25, pr: 21, elapsed_s: 3600 });
    expect(s.current[0].stages.map((x) => [x.name, x.status])).toEqual([["plan", "done"], ["implement", "running"], ["verify", "pending"], ["review", "pending"], ["fix", "pending"], ["merge", "pending"]]);
    expect(s.next_tick_at).toBeNull();
    expect(s.up_next).toEqual([{ issue: 7, title: "Seven", class: "tooling" }]);
    expect(s.agents.find((a) => a.name === "audit")?.cost_30d_usd).toBe(0.5);
  });

  const claim = (paths: Parameters<typeof writeClaim>[0], issue: number, over: Record<string, unknown>, started = "2026-11-22T09:00:00Z") =>
    writeClaim(paths, { issue, state: { ...initialChainState(issue), track: "issue", ...over } as never, worktree: "/w", started_at: started, last_activity_at: started, run_id: null });
  const names = (c: { stages: { name: string; status: string }[] }) => c.stages.map((x) => `${x.name}:${x.status}`).join(" ");
  it("leaves out a waiting claim, so with nothing else running current is empty and the next tick is set", async () => {
    const { base, paths } = await consoleCtx();
    await claim(paths, 50, { stage: "waiting", resumeStage: "review" }, "2026-11-20T09:00:00Z");
    for (const [n, st] of [[51, "paused"], [52, "blocked"], [53, "done"], [54, "released"], [55, "abandoned"]] as const) await claim(paths, n, { stage: st });
    const s = await buildConsoleState(base);
    expect(s.current).toEqual([]);
    expect(s.next_tick_at).toBe("2026-11-22T10:00:45.000Z");
    expect(validate("console-state", s)).toEqual({ ok: true });
  });
  it("puts a running claim first although a waiting one is older", async () => {
    const { base, paths } = await consoleCtx();
    await claim(paths, 50, { stage: "waiting" }, "2026-11-20T09:00:00Z");
    await claim(paths, 60, { stage: "verify" });
    const s = await buildConsoleState(base);
    expect(s.current.map((c) => c.issue)).toEqual([60]);
    expect(names(s.current[0])).toBe("plan:done implement:done verify:running review:pending fix:pending merge:pending");
  });
  it("marks plan running for a claimed chain", async () => {
    const { base, paths } = await consoleCtx();
    await claim(paths, 61, { stage: "claimed" });
    expect(names((await buildConsoleState(base)).current[0])).toBe("plan:running implement:pending verify:pending review:pending fix:pending merge:pending");
  });
  it("marks the stage that asked as running during a question check", async () => {
    const { base, paths } = await consoleCtx();
    await claim(paths, 62, { stage: "question-check", askingStage: "review", resumeStage: "review" });
    expect(names((await buildConsoleState(base)).current[0])).toBe("plan:done implement:done verify:done review:running fix:pending merge:pending");
  });
  it("marks an earlier stage whose newest run did not succeed as failed, and shows a spec track as one stage", async () => {
    const { base, paths } = await consoleCtx();
    await claim(paths, 63, { stage: "fix" });
    await writeUsageRecord(paths, { ...usage("63-review-1-20261122T090100", 63, "review", "2026-11-22T09:01:00Z", 1), outcome: "failed" });
    await claim(paths, 64, { stage: "spec", track: "spec" }, "2026-11-22T09:30:00Z");
    const s = await buildConsoleState(base);
    expect(names(s.current[0])).toBe("plan:done implement:done verify:done review:failed fix:running merge:pending");
    expect(names(s.current[1])).toBe("spec:running");
    expect(validate("console-state", s)).toEqual({ ok: true });
  });
  it("reports the agent's summary and its last run with the outcome", async () => {
    const { base, paths } = await consoleCtx();
    await writeAgentState(paths, "audit", { last_run: { at: "2026-11-22T06:00:00Z", run_id: "r", outcome: "failed" }, next_run: null, pending_events: [], paused: false, paused_by: null, failures: 1, summary: "Reviews actions" });
    const s = await buildConsoleState({ ...base, registry: { audit: {} as never, fresh: {} as never } });
    expect(s.agents.find((a) => a.name === "audit")).toMatchObject({ summary: "Reviews actions", last_run: { at: "2026-11-22T06:00:00Z", outcome: "failed" } });
    expect(s.agents.find((a) => a.name === "fresh")).toMatchObject({ summary: "", last_run: null });
    expect(validate("console-state", s)).toEqual({ ok: true });
  });
  it("marks the option a recommendation names", async () => {
    const { base, paths } = await consoleCtx();
    const q = { kind: "product", question: "Which?", options: [{ label: "Wait", cost: "a day" }, { label: "Ship now", cost: "risk" }], recommendation: "Ship now, because it is cheap" };
    writeFileSync(paths.questionsLog, JSON.stringify({ issue: 5, at: "2026-11-20T00:00:00Z", event: "asked", asking_stage: "plan", question_comment_id: 11, question: q }) + "\n");
    expect((await buildConsoleState(base)).questions[0].options).toEqual([{ label: "Wait", cost: "a day", recommended: false }, { label: "Ship now", cost: "risk", recommended: true }]);
  });
});
