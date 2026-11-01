import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Octokit } from "octokit";
import type { Adapter, StageRun } from "../../src/adapters/types.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../../src/config.ts";
import { GitHubClient } from "../../src/github/client.ts";
import type { Notification } from "../../src/notify/types.ts";
import { Scheduler, type SchedulerDeps } from "../../src/service/loop.ts";
import { ServiceLog } from "../../src/service/log.ts";
import { SleepInhibitor } from "../../src/service/inhibit.ts";
import { loadStageDefinitions } from "../../src/stages/definition.ts";
import type { StageInput } from "../../src/stages/prompt.ts";
import { ensureStateDirs, statePaths, type StatePaths } from "../../src/state/paths.ts";
import { mockGitHub, pageLink, type Route } from "./mock-github.ts";
import { git, repoPair } from "./repo-pair.ts";

import {loadRegistry} from '../../src/standing/registry.ts';
import {EVENT_NAMES} from '../../src/standing/events.ts';
import {initializeAgents,readAgentState,writeAgentState} from '../../src/standing/state.ts';
import {ParameterStore} from '../../src/parameters/store.ts';
import {loadParameterDefinitions} from '../../src/parameters/definitions.ts';
import {registryActionsCheck} from '../../src/actions/index.ts';

const script = join(import.meta.dirname, "..", "fixtures", "stage-script.ts");
const events = join(import.meta.dirname, "..", "fixtures", "streams", "claude-success.jsonl");
export const BOT = "panelator-pipeline[bot]";

/** A scripted result: a value, `undefined` for a failed run, `RATE_LIMITED` for a 429, or a function of the run that does the agent's git work first. */
export type Scripted = unknown | ((run: StageRun) => unknown);
/** A scripted run the vendor rate-limited: the fake harness exits 2 and `judge` reports a 429. */
export const RATE_LIMITED = Symbol("rate-limited");

export interface RunSeen {
  resume?:{sessionId:string};
  sessionId:string;
  conversation?:boolean;
  stage: string;
  model: string;
  /** The branch the worktree was on when the run started. */
  branch: string;
  profile: string | null;
  input: StageInput;
}

/** A fake adapter that answers each stage from its script, in order; a missing or `undefined` entry is a failed run. */
export function scripted(results: Record<string, Scripted[]>): Adapter & { ran: string[]; runs: RunSeen[] } {
  const ran: string[] = [];
  const runs: RunSeen[] = [];
  return {
    harness: "fake", quotaHarness: "claude", ran, runs,
    buildCommand(run) {
      ran.push(run.stage);
      runs.push({
        resume:run.resume,sessionId:run.sessionId,conversation:run.conversation,
        stage: run.stage, model: run.model, branch: git(run.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim(), profile: run.profile?.name ?? null,
        input: JSON.parse(readFileSync(join(dirname(run.resultPath), "input.json"), "utf8")) as StageInput,
      });
      const next = results[run.stage]?.shift();
      const r = typeof next === "function" ? (next as (run: StageRun) => unknown)(run) : next;
      const argv = [process.execPath, script, events, run.resultPath, r === RATE_LIMITED ? "2" : r === undefined ? "1" : "0", "0"];
      if (r !== undefined && r !== RATE_LIMITED) argv.push(JSON.stringify(r));
      return { argv, env: {} };
    },
    judge: (_e, exit, t) => t ? { outcome: "timeout", reason: "t", apiErrorStatus: null, finalText: null } : exit === 0 ? { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "x" } : exit === 2 ? { outcome: "failed", reason: "429", apiErrorStatus: 429, finalText: null } : { outcome: "failed", reason: "exit", apiErrorStatus: null, finalText: null },
    usage: () => ({ cost_usd: 0.1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 }),
  };
}

export async function standingWorld(results:Record<string,Scripted[]>) {
  const pair=repoPair({'README.md':'standing fixture'}),paths=statePaths(join(pair.root,'state'));await ensureStateDirs(paths);
  const registry=loadRegistry(join(agentsDir,'standing'),EVENT_NAMES,registryActionsCheck(join(agentsDir,'actions.yaml')));
  registry.operator={...registry['action-audit'],name:'operator',trigger:{schedule:'1h'},actions:['set_parameter','rerun_workflow'],input:'audit-input'};
  const cfg={...loadConfig(defaultConfigPath),repo:'o/r',required_checks:['test'],slots:1};
  const parameters=new ParameterStore(paths,loadParameterDefinitions(join(agentsDir,'parameters.yaml'),cfg,registry));
  let now=new Date('2026-10-01T00:00:00Z');await initializeAgents(paths,registry,parameters,now);
  const issues:{number:number;title:string;body:string;user:{login:string};labels:{name:string}[];created_at:string}[]=[];
  const comments=new Map<number,unknown[]>();
  const routes:Route[]=[
    {method:'GET',path:/^\/repos\/o\/r\/issues$/,reply:()=>({body:issues})},
    {method:'POST',path:/^\/graphql$/,reply:()=>({body:{data:{repository:{issues:{totalCount:issues.length}}}}})},
    {method:'GET',path:/^\/repos\/o\/r\/issues\/(\d+)\/timeline$/,reply:()=>({body:[]})},
    {method:'GET',path:/^\/repos\/o\/r\/issues\/(\d+)\/comments$/,reply:m=>({body:comments.get(Number(m[1]))??[]})},
    {method:'POST',path:/^\/repos\/o\/r\/issues\/(\d+)\/comments$/,reply:(m,b)=>{const cs=comments.get(Number(m[1]))??[];const c={id:cs.length+1,body:(b as {body:string}).body,user:{login:BOT},created_at:now.toISOString()};cs.push(c);comments.set(Number(m[1]),cs);return {body:c};}},
    {method:'POST',path:/^\/repos\/o\/r\/issues$/,reply:(_m,b)=>{const i=b as {title:string;body:string;labels:string[]};const number=100+issues.length;issues.push({number,title:i.title,body:i.body,user:{login:BOT},labels:i.labels.map(name=>({name})),created_at:now.toISOString()});return {status:201,body:{number}};}},
    {method:'DELETE',path:/^\/repos\/o\/r\/issues\/(\d+)\/labels\/abandoned$/,reply:m=>{const i=issues.find(i=>i.number===Number(m[1]));if(i)i.labels=i.labels.filter(l=>l.name!=='abandoned');return {status:204,body:null};}},
    {method:'PATCH',path:/^\/repos\/o\/r\/issues\/(\d+)$/,reply:m=>{const i=issues.findIndex(i=>i.number===Number(m[1]));if(i>=0)issues.splice(i,1);return {body:{}};}},
    {method:'POST',path:/^\/repos\/o\/r\/actions\/runs\/\d+\/(rerun|cancel)$/,reply:()=>({status:202,body:{}})},
    {method:'GET',path:/^\/repos\/o\/r\/security-advisories$/,reply:()=>({body:[]})},
    {method:'POST',path:/^\/repos\/o\/r\/security-advisories$/,reply:()=>({status:201,body:{ghsa_id:'GHSA-fixture'}})},
    {method:'GET',path:/^\/repos\/o\/r\/commits\/[^/]+\/check-runs$/,reply:()=>({body:{total_count:1,check_runs:[{id:1,name:'test',status:'completed',conclusion:'success'}]}})},
  ];
  const mock=mockGitHub(routes),gh=new GitHubClient(new Octokit({auth:'x',request:{fetch:mock.fetch}}),'o/r'),adapter=scripted(results),notifications:Notification[]=[];
  const deps:SchedulerDeps={cfg,paths,registry,parameters,gh,botLogin:BOT,notifier:{notify:async n=>{notifications.push(n);}},stages:loadStageDefinitions(join(agentsDir,'stages')),agentsDir,repoDir:pair.repo,binDir:join(pair.root,'bin'),adapterFor:()=>adapter,systemdScope:false,now:()=>now,log:()=>{},fetchOrigin:async()=>{},unitActive:async()=>false,stopUnit:async()=>{},serviceLog:new ServiceLog(paths.serviceLog),inhibitor:new SleepInhibitor({enabled:false}),fastForward:async()=>({moved:false,changedPaths:[]}),sleep:async()=>{},monotonic:()=>0,requestRestart:()=>{}};
  const scheduler=new Scheduler(deps);
  return {pair,paths,registry,parameters,deps,scheduler,adapter,mock,gh,issues,comments,notifications,setNow:(value:Date)=>{now=value;}};
}

export interface MockPr { number: number; head: string; sha: string; body: string; state: "open" | "closed"; merged: boolean }
export interface MockComment { id: number; author: string; body: string; at: string }

/**
 * One issue (#7) on a mocked GitHub backed by a real bare origin: stages commit and push in their worktree and open
 * PRs here; a merge squashes the PR's branch into origin's main, a branch DELETE removes it from origin.
 */
export async function chainWorld(opts: { files: Record<string, string>; issueBody?: string; labels?: string[]; results: Record<string, Scripted[]> }) {
  const pair = repoPair(opts.files);
  const paths: StatePaths = statePaths(join(pair.root, "state"));
  await ensureStateDirs(paths);
  // GitHub's side of a merge: a clone that squashes a PR branch into main and pushes it.
  const side = join(pair.root, "github-side");
  execFileSync("git", ["clone", "-q", pair.origin, side], { stdio: "ignore" });

  const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", required_checks: ["test"], state_dir: paths.root, slots: 1, rescue_model: "claude-rescue-test" };
  // A rescue model distinct from every stage model, so a run shows whether it was the rescue (AC-1).
  const labels = new Set(opts.labels ?? ["validated", "class:product"]);
  const labelLog: string[] = [];
  const comments: MockComment[] = [];
  const prComments: { pr: number; body: string }[] = [];
  const prs = new Map<number, MockPr>();
  const mergeRequests: number[] = [];
  let issueBody = opts.issueBody ?? "Spec: specs/010-thing/spec.md";
  let issueOpen = true;
  let nextId = 100;

  const originRef = (branch: string): string | null => {
    try {
      return git(pair.origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).trim();
    } catch {
      return null;
    }
  };
  /** An open PR's head follows its branch on origin, as on GitHub. */
  const headOf = (pr: MockPr) => (pr.state === "open" ? originRef(pr.head) ?? pr.sha : pr.sha);
  const issue = () => ({
    number: 7, title: "Thing", body: issueBody, user: { login: BOT, type: "Bot" }, labels: [...labels].map((name) => ({ name })),
    created_at: "2026-10-01T00:00:00Z", updated_at: new Date().toISOString(),
  });
  const logLabel = (n: number, entry: string) => labelLog.push(n === 7 ? entry : `#${n} ${entry}`);
  const commentJson = (c: MockComment) => ({ id: c.id, user: { login: c.author }, body: c.body, created_at: c.at });

  const routes: Route[] = [
    { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: issueOpen ? [issue()] : [], headers: pageLink(url, 1, 1) }) },
    { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: issueOpen ? 1 : 0 } } } } }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/7\/timeline$/, reply: () => ({ body: [] }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: issue() }) },
    { method: "PATCH", path: /^\/repos\/o\/r\/issues\/7$/, reply: (_m, b) => { issueBody = (b as { body: string }).body; return { body: issue() }; } },
    {
      method: "POST", path: /^\/repos\/o\/r\/issues\/(\d+)\/labels$/, reply: (m, b) => {
        for (const l of (b as { labels: string[] }).labels) {
          if (m[1] === "7") labels.add(l);
          logLabel(Number(m[1]), `+${l}`);
        }
        return { body: [] };
      },
    },
    {
      method: "DELETE", path: /^\/repos\/o\/r\/issues\/(\d+)\/labels\/([^/]+)$/, reply: (m) => {
        const name = decodeURIComponent(m[2]);
        if (m[1] === "7") labels.delete(name);
        logLabel(Number(m[1]), `-${name}`);
        return { body: {} };
      },
    },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/7\/comments$/, reply: (_m, _b, url) => ({ body: comments.map(commentJson), headers: pageLink(url, 1, 1) }) },
    {
      method: "POST", path: /^\/repos\/o\/r\/issues\/(\d+)\/comments$/, reply: (m, b) => {
        const body = (b as { body: string }).body;
        const c: MockComment = { id: nextId++, author: BOT, body, at: new Date().toISOString() };
        if (m[1] === "7") comments.push(c);
        else prComments.push({ pr: Number(m[1]), body });
        return { status: 201, body: commentJson(c) };
      },
    },
    {
      method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: (_m, _b, url) => {
        const head = url.searchParams.get("head")?.replace(/^o:/, "");
        return { body: [...prs.values()].filter((pr) => pr.state === "open" && pr.head === head).map((pr) => ({ number: pr.number })) };
      },
    },
    {
      method: "GET", path: /^\/repos\/o\/r\/pulls\/(\d+)$/, reply: (m) => {
        const pr = prs.get(Number(m[1]));
        if (!pr) return { status: 404, body: { message: "Not Found" } };
        return { body: { number: pr.number, base: { ref: "main" }, head: { ref: pr.head, sha: headOf(pr) }, html_url: "u", body: pr.body, mergeable: true, mergeable_state: "clean", merged: pr.merged, state: pr.state } };
      },
    },
    {
      method: "PATCH", path: /^\/repos\/o\/r\/pulls\/(\d+)$/, reply: (m, b) => {
        const pr = prs.get(Number(m[1]))!;
        if ((b as { state?: string }).state === "closed") Object.assign(pr, { sha: headOf(pr), state: "closed" });
        return { body: {} };
      },
    },
    {
      method: "PUT", path: /^\/repos\/o\/r\/pulls\/(\d+)\/merge$/, reply: (m, b) => {
        const pr = prs.get(Number(m[1]))!;
        mergeRequests.push(pr.number);
        const sha = headOf(pr);
        if (pr.state !== "open" || (b as { sha?: string }).sha !== sha) return { status: 409, body: { message: "head moved or PR closed" } };
        git(side, "fetch", "-q", "origin");
        git(side, "checkout", "-q", "-B", "main", "origin/main");
        git(side, "merge", "-q", "--squash", `origin/${pr.head}`);
        git(side, "commit", "-q", "-m", `PR #${pr.number}`);
        git(side, "push", "-q", "origin", "main");
        Object.assign(pr, { sha, state: "closed", merged: true });
        // The issue PR's "Closes #7" closes the issue; a spec PR closes nothing (AC-21).
        if (pr.head === "issue-7") issueOpen = false;
        return { body: { merged: true, message: "ok" } };
      },
    },
    {
      method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/, reply: (m) => {
        const branch = decodeURIComponent(m[1]);
        if (originRef(branch) === null) return { status: 422, body: { message: "Reference does not exist" } };
        git(pair.origin, "update-ref", "-d", `refs/heads/${branch}`);
        return { status: 204, body: null };
      },
    },
    { method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } }) },
  ];
  const gh = mockGitHub(routes);
  const adapter = scripted(opts.results);
  const notifications: Notification[] = [];
  const logs: Record<string, unknown>[] = [];
  const registry=loadRegistry(join(agentsDir,'standing'),EVENT_NAMES,registryActionsCheck(join(agentsDir,'actions.yaml')));
  const parameters=new ParameterStore(paths,loadParameterDefinitions(join(agentsDir,'parameters.yaml'),cfg,registry));
  await initializeAgents(paths,registry,parameters,new Date());
  // AC-7: the recorded issue chains are unchanged when no standing agent can run.
  // Keep the filer paused here; separate recorded runs below exercise its event delivery.
  await writeAgentState(paths,'findings-filer',{...(await readAgentState(paths,'findings-filer'))!,paused:true,paused_by:'maintainer'});
  const deps: SchedulerDeps = {
    cfg, paths, registry, parameters, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"),
    notifier: { notify: async (n) => { notifications.push(n); } },
    stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
    adapterFor: () => adapter, systemdScope: false, now: () => new Date(), log: (rec) => { logs.push(rec); },
    fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
    unitActive: async () => false, stopUnit: async () => {},
    botLogin: BOT, serviceLog: new ServiceLog(paths.serviceLog), inhibitor: new SleepInhibitor({ enabled: false }),
    fastForward: async () => ({ moved: false, changedPaths: [] }), sleep: async () => {}, monotonic: () => 0, requestRestart: () => {},
  };
  const scheduler = new Scheduler(deps);

  return {
    deps,scheduler,pair, paths, cfg, gh, adapter, notifications, logs, labels, labelLog, comments, prComments, prs, mergeRequests,
    get issueOpen() { return issueOpen; },
    get issueBody() { return issueBody; },
    /** One tick, then wait for the chains it started to stop (ended, paused or waiting). */
    async tick() {
      const t = await scheduler.tick();
      for (let i = 0; i < 600 && scheduler.active > 0; i++) await new Promise((r) => setTimeout(r, 50));
      if (scheduler.active > 0) throw new Error("chain still running after 30s");
      return t;
    },
    /** A maintainer comment on the issue, a minute after now so it follows the question by id and by time. */
    reply(body: string): MockComment {
      const c: MockComment = { id: nextId++, author: cfg.maintainer, body, at: new Date(Date.now() + 60_000).toISOString() };
      comments.push(c);
      return c;
    },
    /** The bot's question comments, oldest first. */
    questions(): MockComment[] {
      return comments.filter((c) => c.author === BOT && c.body.startsWith("### Question for the maintainer"));
    },
    /** A file on origin's main, or null. */
    onMain(path: string): string | null {
      try {
        return git(pair.origin, "show", `main:${path}`);
      } catch {
        return null;
      }
    },
    /** A stage's git work: write `files`, commit and push the worktree's branch; the new head. */
    push(run: StageRun, files: Record<string, string>, msg = "work"): string {
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(join(run.worktree, p, ".."), { recursive: true });
        writeFileSync(join(run.worktree, p), c);
      }
      git(run.worktree, "add", "-A");
      git(run.worktree, "commit", "-q", "-m", msg);
      const branch = git(run.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim();
      git(run.worktree, "push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`);
      return git(run.worktree, "rev-parse", "HEAD").trim();
    },
    /** A stage opening PR `n` from the worktree's branch at `sha`. */
    openPr(run: StageRun, n: number, sha: string, body = "Closes #7"): void {
      const head = git(run.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim();
      prs.set(n, { number: n, head, sha, body, state: "open", merged: false });
    },
    /** Every non-GET call, as `METHOD path`, in order. */
    writes(): string[] {
      return gh.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);
    },
  };
}

export type ChainWorld = Awaited<ReturnType<typeof chainWorld>>;
