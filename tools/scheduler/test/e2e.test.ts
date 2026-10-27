import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapters/types.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { Scheduler, type SchedulerDeps } from "../src/service/loop.ts";
import { ServiceLog } from "../src/service/log.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { listClaims } from "../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { Notification } from "../src/notify/types.ts";
import { mockGitHub, pageLink, type Route } from "./helpers/mock-github.ts";
import { git, repoPair, withTopDesign } from "./helpers/repo-pair.ts";

const script = join(import.meta.dirname, "fixtures", "stage-script.ts");
const events = join(import.meta.dirname, "fixtures", "streams", "claude-success.jsonl");
const spec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");
const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };

function scripted(results: Record<string, unknown[]>): Adapter & { ran: string[] } {
  const ran: string[] = [];
  return {
    harness: "fake", ran,
    buildCommand(run) {
      ran.push(run.stage);
      const r = results[run.stage]?.shift();
      const argv = [process.execPath, script, events, run.resultPath, r === undefined ? "1" : "0", "0"];
      if (r !== undefined) argv.push(JSON.stringify(r));
      return { argv, env: {} };
    },
    judge: (_e, exit, t) => t ? { outcome: "timeout", reason: "t", apiErrorStatus: null, finalText: null } : exit === 0 ? { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "x" } : { outcome: "failed", reason: "exit", apiErrorStatus: null, finalText: null },
    usage: () => ({ cost_usd: 0.1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 }),
  };
}

describe("end to end: one issue through the whole chain with the fake adapter and a mocked GitHub", () => {
  it("claims, plans, implements, verifies, reviews, merges, and leaves the records (AC-1, AC-3, AC-24, AC-29 shape)", async () => {
    const pair = repoPair(withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": spec }, "specs/010-thing/spec.md"));
    // PR binding compares head_sha with the issue worktree HEAD, which the loop creates from origin/main
    const SHA = git(pair.repo, "rev-parse", "origin/main").trim();
    const paths = statePaths(join(pair.root, "state"));
    await ensureStateDirs(paths);
    const labels = new Set(["validated", "class:product"]);
    const comments: string[] = [];
    const labelLog: string[] = [];
    const issue = () => ({ number: 7, title: "Thing", body: "Spec: specs/010-thing/spec.md", user: BOT, labels: [...labels].map((name) => ({ name })), created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" });
    const routes: Route[] = [
      { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: [issue()], headers: pageLink(url, 1, 1) }) },
      { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: 1 } } } } }) },
      { method: "GET", path: /^\/repos\/o\/r\/issues\/7\/timeline$/, reply: () => ({ body: [] }) },
      { method: "GET", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: issue() }) },
      { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/labels$/, reply: (_m, b) => { for (const l of (b as { labels: string[] }).labels) { labels.add(l); labelLog.push(`+${l}`); } return { body: [] }; } },
      { method: "DELETE", path: /^\/repos\/o\/r\/issues\/7\/labels\/([^/]+)$/, reply: (m) => { labels.delete(m[1]); labelLog.push(`-${m[1]}`); return { body: {} }; } },
      { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/comments$/, reply: (_m, b) => { comments.push((b as { body: string }).body); return { status: 201, body: {} }; } },
      // PR labels: the merge step refuses on a security-review label on the PR too (AC-11)
      { method: "GET", path: /^\/repos\/o\/r\/issues\/9$/, reply: () => ({ body: { number: 9, labels: [] } }) },
      { method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: { number: 9, base: { ref: "main" }, head: { ref: "issue-7", sha: SHA }, html_url: "u", mergeable: true, mergeable_state: "clean", merged: false, state: "open" } }) },
      { method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } }) },
      { method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ body: { merged: true, message: "ok" } }) },
    ];
    const gh = mockGitHub(routes);
    const notifications: Notification[] = [];
    const logs: Record<string, unknown>[] = [];
    const adapter = scripted({
      plan: [{ verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.txt"] }], findings: [{ what: "w", where: "a.txt:1", evidence: "e", noticed_how: "n" }] }],
      implement: [{ pr_number: 9, head_sha: SHA, tasks_done: ["T1"] }],
      review: [{ verdict: "approve", findings_on_pr: [], declined_to_judge: [] }],
    });
    const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", required_checks: ["test"], state_dir: paths.root, slots: 1 };
    const deps: SchedulerDeps = {
      cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"),
      notifier: { notify: async (n) => { notifications.push(n); } },
      stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
      adapterFor: () => adapter, systemdScope: false, now: () => new Date(), log: (rec) => { logs.push(rec); },
      fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
      unitActive: async () => false, stopUnit: async () => {},
      botLogin: "panelator-pipeline[bot]", serviceLog: new ServiceLog(paths.serviceLog), inhibitor: new SleepInhibitor({ enabled: false }),
      fastForward: async () => ({ moved: false, changedPaths: [] }), sleep: async () => {}, monotonic: () => 0, requestRestart: () => {},
    };
    const s = new Scheduler(deps);
    const t = await s.tick();
    expect(t.claimed).toEqual([7]);
    // wait for the background chain to finish
    for (let i = 0; i < 200 && s.active > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(s.active).toBe(0);
    expect(logs.filter((r) => r.kind === "error")).toEqual([]);
    expect(gh.unmatched).toEqual([]);

    expect(adapter.ran).toEqual(["plan", "implement", "review"]);
    expect(labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(comments).toEqual([]);
    expect(notifications).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
    expect(existsSync(join(paths.worktrees, "issue-7"))).toBe(false);
    const usage = readdirSync(paths.usage).sort();
    expect(usage).toHaveLength(3);
    for (const f of usage) {
      const rec = JSON.parse(readFileSync(join(paths.usage, f), "utf8"));
      expect(rec).toMatchObject({ issue: 7, outcome: "ok", harness: "fake", cost_usd: 0.1 });
      expect(existsSync(join(paths.root, rec.events_path))).toBe(true);
    }
    expect(readFileSync(paths.findingsQueue, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(paths.root, "merges.jsonl"), "utf8")).toContain('"issue":7');
    const ticks = readFileSync(paths.serviceLog, "utf8").split("\n").filter((l) => l.includes('"kind":"tick"'));
    expect(ticks).toHaveLength(1);
  }, 120_000);
});
