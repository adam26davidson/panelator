import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { appendContactLog, readContactLog, redactCommand, type ContactLogLine } from "../src/contacts/log.ts";
import { KINDS } from "../src/actions/index.ts";
import { runStage, type RunnerContext, type StageRequest } from "../src/runner/run.ts";
import { stageEnv } from "../src/runner/credentials.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { StageDefinition } from "../src/types.ts";
import { standingWorld } from "./helpers/e2e-routes.ts";

const tmp = () => statePaths(mkdtempSync(join(tmpdir(), "contacts-")));
const refused = (at: string): ContactLogLine => ({ at, event: "refused", actor: "implement", run_id: "r1", party: "github:other", command: ["issue", "create", "--body", "<omitted>"] });
const removed: ContactLogLine = {
  at: "2026-11-19T02:00:00.000Z", event: "removed", actor: "maintainer", party: "github:other",
  entry: { party: "github:other", channel: "github", approved_at: "2026-11-18T00:00:00.000Z", question_comment_id: 5, issue: 3 },
};

describe("contacts log (spec 083 AC-3, AC-4)", () => {
  it("appends valid lines and never rewrites earlier ones", async () => {
    const paths = tmp();
    await appendContactLog(paths, refused("2026-11-19T01:00:00.000Z"));
    const first = readFileSync(paths.contactsLog, "utf8");
    await appendContactLog(paths, removed);
    const text = readFileSync(paths.contactsLog, "utf8");
    expect(text.startsWith(first)).toBe(true);
    expect(text.trim().split("\n")).toHaveLength(2);
  });
  it("throws and writes nothing on a line failing the schema", async () => {
    const paths = tmp();
    await appendContactLog(paths, refused("2026-11-19T01:00:00.000Z"));
    const before = readFileSync(paths.contactsLog, "utf8");
    await expect(appendContactLog(paths, { ...refused("not a time") })).rejects.toThrow(/invalid contacts log entry/);
    await expect(appendContactLog(paths, { event: "refused" } as unknown as ContactLogLine)).rejects.toThrow();
    expect(readFileSync(paths.contactsLog, "utf8")).toBe(before);
    const empty = tmp();
    await expect(appendContactLog(empty, { event: "x" } as unknown as ContactLogLine)).rejects.toThrow();
    expect(existsSync(empty.contactsLog)).toBe(false);
  });
  it("reads by --since and returns [] for a missing file", async () => {
    const paths = tmp();
    expect(await readContactLog(paths)).toEqual([]);
    await appendContactLog(paths, refused("2026-11-19T01:00:00.000Z"));
    await appendContactLog(paths, removed);
    expect(await readContactLog(paths)).toHaveLength(2);
    expect(await readContactLog(paths, "2026-11-19T01:30:00.000Z")).toEqual([removed]);
  });
  it("the contacts log command prints the array and writes nothing", async () => {
    const w = await standingWorld({});
    const config = join(w.pair.root, "cli-config.json");
    writeFileSync(config, JSON.stringify({ ...w.deps.cfg, state_dir: w.paths.root, app: { ...w.deps.cfg.app, id: 0, installation_id: 0 } }));
    const run = (...a: string[]) => execFileSync(process.execPath, [join("tools", "scheduler", "bin", "scheduler.ts"), "contacts", "log", ...a, "--config", config], { encoding: "utf8" });
    expect(JSON.parse(run())).toEqual([]);
    expect(existsSync(w.paths.contactsLog)).toBe(false);
    await appendContactLog(w.paths, refused("2026-11-19T01:00:00.000Z"));
    await appendContactLog(w.paths, removed);
    expect(JSON.parse(run())).toHaveLength(2);
    expect(JSON.parse(run("--since", "2026-11-19T01:30:00.000Z"))).toEqual([removed]);
  }, 30000);
});

describe("redactCommand (AC-1)", () => {
  it("omits the value of every content flag, in both forms", () => {
    for (const f of ["--body", "-b", "--body-file", "--title", "-t", "--field", "-f", "--raw-field", "-F", "--input"]) {
      expect(redactCommand(["issue", "create", "-R", "o/r", f, "secret"])).toEqual(["issue", "create", "-R", "o/r", f, "<omitted>"]);
    }
    expect(redactCommand(["issue", "create", "--body=secret", "--title=t"])).toEqual(["issue", "create", "--body=<omitted>", "--title=<omitted>"]);
  });
});

describe("a run's environment names its actor (AC-5)", () => {
  it("stageEnv carries the actor and run id only when given", () => {
    expect(stageEnv("/b", "/s")).not.toHaveProperty("PANELATOR_ACTOR");
    expect(stageEnv("/b", "/s", undefined, { actor: "implement", runId: "r1" })).toMatchObject({ PANELATOR_ACTOR: "implement", PANELATOR_RUN_ID: "r1" });
  });
  it("a stage run and a standing run both pass them to the agent", async () => {
    for (const [name, kind] of [["plan", "agent"], ["operator", "standing"]] as const) {
      const root = mkdtempSync(join(tmpdir(), "run-"));
      const paths = statePaths(root);
      await ensureStateDirs(paths);
      const eventsFile = join(root, "ev.jsonl");
      writeFileSync(eventsFile, readFileSync(join(import.meta.dirname, "fixtures", "streams", "claude-success.jsonl")));
      const adapter = fakeAdapter({ events: [], result: {}, scriptPath: join(import.meta.dirname, "fixtures", "stage-script.ts"), eventsFile });
      const worktree = join(root, "wt");
      mkdirSync(worktree);
      const dump = join(root, "env.json");
      const wrapped = { ...adapter, buildCommand: (r: Parameters<typeof adapter.buildCommand>[0]) => { const c = adapter.buildCommand(r); return { ...c, env: { ...c.env, ENV_DUMP_FILE: dump } }; } };
      const ctx: RunnerContext = { paths, adapter: wrapped, systemdScope: false, binDir: join(root, "bin"), now: () => new Date("2026-10-12T00:00:00Z"), sessionId: () => "s" };
      const def = { name, kind, harness: "claude", model: "claude-fable-5-1", tier: "strong", bounds: { timeout_min: 1, max_turns: 10, max_cost_usd: 1 }, permission: "no-prompt", worktree: "issue", profile: "none", input: "stage-input", output: "plan-result", prompt: "p {{result_path}}" } as unknown as StageDefinition;
      const req = { def, input: { issue: { number: 7, title: "t", body: "b" }, spec: "", result_path: "", profile_instructions: "" }, issue: 7, attempt: 1, worktree, profile: null, runId: `run-${name}-1` } as unknown as StageRequest;
      await runStage(ctx, req);
      expect(JSON.parse(readFileSync(dump, "utf8"))).toEqual({ actor: name, run_id: `run-${name}-1` });
    }
  });
});

describe("no contacts kind exists (AC-6)", () => {
  const needle = ["contact", "refused"].join("_");
  it("has no kind containing 'contact' and no reference to the old kind", () => {
    expect(Object.keys(KINDS).filter((k) => k.includes("contact"))).toEqual([]);
    expect(readFileSync("agents/actions.yaml", "utf8")).not.toContain("contact");
    for (const dir of ["tools/scheduler", "agents", "schemas"]) {
      for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
        const p = join(dir, f);
        if (p.includes("node_modules") || !/\.(ts|yaml|json|md)$/.test(p)) continue;
        expect(readFileSync(p, "utf8"), p).not.toContain(needle);
      }
    }
  });
  it("only src/contacts/log.ts writes the contacts log", () => {
    const writers: string[] = [];
    for (const dir of ["tools/scheduler/src", "tools/scheduler/bin"]) {
      for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
        const p = join(dir, f);
        if (!/\.ts$/.test(p) && !p.endsWith("/gh")) continue;
        const src = readFileSync(p, "utf8");
        if (/(contactsLog|contacts\/log\.jsonl)/.test(src) && /(appendFile|writeFile|rename|unlink|rm\(|createWriteStream)/.test(src)) writers.push(p);
      }
    }
    expect(writers).toEqual(["tools/scheduler/src/contacts/log.ts"]);
  });
});
