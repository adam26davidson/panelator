import { TelegramClient } from '../src/telegram/client.ts';
import { telegramChannel } from '../src/telegram/channel.ts';
import { fakeTelegram } from './helpers/fake-telegram.ts';
import { emptyTelegram, listPaused, type PausedRecord } from '../src/state/paused.ts';
import { completePause } from "../src/chain/driver.ts";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, StageRun } from "../src/adapters/types.ts";
import { initialChainState, ledgerOf, transition } from "../src/chain/machine.ts";
import { applyActions, CHARTER_REVERT_LINE, CLOSING_KEYWORD, designTop, step, type DriverDeps } from "../src/chain/driver.ts";
import { agentsDir } from "../src/config.ts";
import { readClaim, writeClaim, type Claim } from "../src/state/claims.ts";
import { statePaths } from "../src/state/paths.ts";
import { writeLedger } from "../src/state/ledger.ts";
import { appendQuestionLog } from "../src/state/questions.ts";
import type { Question } from "../src/types.ts";
import type { Route } from "./helpers/mock-github.ts";
import { ParameterStore } from "../src/parameters/store.ts";
import { loadParameterDefinitions } from "../src/parameters/definitions.ts";
import { observeRun } from "../src/quota/book.ts";
import { validate } from "../src/schema/validate.ts";
import { git, repoPair, withTopDesign } from "./helpers/repo-pair.ts";
import { script, events, spec, type Scripted, type RouteOver, ghRoutes, setup, plan, settled, outside, approve, conflicting, steps, Q, at, writes, inputOf, commitIn, head, branchIn, ledgerFile, logEvents, onSpec7, prBehindMain, mergeMainResolved } from "./helpers/driver-harness.ts";

describe('Telegram pause and conversation protection',()=>{
 const q:Question={kind:'product',question:'Which layout?',options:[{label:'second',cost:'none'}],recommendation:'second'};
 function pausing():PausedRecord{return {issue:7,phase:'pausing',nonce:'nonce',state:initialChainState(7),question:q,asking_stage:'plan',question_comment_id:null,asked_at:null,reminded:false,answer:null,reply_comment_id:null,telegram:emptyTelegram()};}
 it('posts the record then sends once, and a pausing record with a message id is not resent',async()=>{
  const {deps,paths,gh}=await setup(()=>({}));const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('SECRET',42,server.url));try{
   await completePause(deps,pausing());const [r]=await listPaused(paths);expect(r.telegram?.message_id).toBe(1);expect(r.telegram?.sent).toBe(true);expect(gh.calls.find(c=>c.method==='POST'&&c.url.endsWith('/comments'))?.body).toEqual({body:expect.stringContaining('asked on Telegram')});await completePause(deps,{...r,phase:'pausing'});expect(server.sent).toHaveLength(1);
  }finally{await server.close();}
 },30000);
 it('completes a pause even when Telegram fails, retaining the retry state',async()=>{
  const {deps,paths}=await setup(()=>({}));const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('SECRET',42,server.url));try{server.fail('sendMessage',500);await completePause(deps,pausing());const [r]=await listPaused(paths);expect(r.phase).toBe('paused');expect(r.telegram?.send_failures).toBe(1);expect(r.telegram?.sent).toBe(false);}finally{await server.close();}
 },30000);
 it('reverts a conversation write while preserving the work already present when it asked',async()=>{
  const {deps,claim}=await setup(()=>({plan:[(run:StageRun)=>{writeFileSync(join(run.worktree,'a.txt'),'forbidden\n');return {conversation:'settled',decision:'second'};}]}));
  writeFileSync(join(claim.worktree,'a.txt'),'kept\n');writeFileSync(join(claim.worktree,'untracked.txt'),'kept untracked\n');
  const paused={...claim.state,stage:'paused' as const,question:q,askingStage:'plan' as const,resumeSession:{harness:'fake' as const,model:'m',session_id:'s',worktree:claim.worktree}};
  claim.state=transition(paused,{type:'answered',answer:'second',questionId:1}).state;
  const r=await step(deps,claim);expect(r.claim.state.conversation?.retried).toBe(true);expect(r.claim.state.rescues).toBe(0);expect(readFileSync(join(claim.worktree,'a.txt'),'utf8')).toBe('kept\n');expect(readFileSync(join(claim.worktree,'untracked.txt'),'utf8')).toBe('kept untracked\n');
 },30000);
});
describe("driver: final review cycle 2", () => {
  it("a spec-PR fix recording answer #556 fails when only #555's mark, from an earlier commit, is on the PR; its own #556 mark passes (TI1)", async () => {
    for (const [mark, ok] of [[555, false], [556, true]] as const) {
      let wt = "";
      const t = await setup(() => ({ fix: [(run: StageRun) => ({ head_sha: commitIn(run.worktree, { "specs/010-thing/spec.md": `${spec}\nUse lru (maintainer answer, question #${mark}).\n` }, "fix"), addressed: [] })] }),
        (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: () => head(wt) } } }), (_p, w) => {
          wt = w;
          git(w, "checkout", "-q", "-b", "spec-7");
          commitIn(w, { "docs/product-spec.md": "# Product\n\nLocal only (maintainer answer, question #555).\n" }, "record 555");
          git(w, "push", "-q", "-u", "origin", "spec-7");
        });
      const c = at(t.claim, {
        stage: "fix", track: "spec", pr: { number: 12, head_sha: t.sha }, answerQuestionId: 556, answerQuestionIds: [555, 556], answerKind: "product", recordIds: [556], recordKind: "technical",
        pendingFixInput: "Record the decision.",
      });
      await writeClaim(t.paths, c);
      const r = await step(t.deps, c);
      // Past the mark check (the fixture's parent design then fails the spec-PR scope, which is not under test here).
      if (ok) {
        expect(r.claim.state.history.some((h) => h.includes("answer not marked"))).toBe(false);
        expect(r.claim.state).toMatchObject({ recordIds: [], answerKind: "product" });
      }
      else expect(r.claim.state.history).toContain("fix attempt 1 failed: result: answer not marked");
    }
  }, 60_000);

  it("a spec stage with two answers to record must mark both (TI1)", async () => {
    for (const [text, ok] of [["Use a (maintainer answer, question #555).", false], ["Use a (maintainer answer, question #555); local (maintainer answer, question #556).", true]] as const) {
      let wt = "";
      const t = await setup(() => ({ spec: [(run: StageRun) => ({ verdict: "revised", spec_path: "specs/010-thing/spec.md", pr_number: 12, head_sha: commitIn(run.worktree, { "specs/010-thing/spec.md": `${spec}\n${text}\n` }) })] }),
        (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } } }), (_p, w) => { wt = w; });
      const c = at(t.claim, { stage: "spec", track: "spec", specMode: "write", answer: "Question #555: a\n\nQuestion #556: local", answerQuestionId: 556, answerQuestionIds: [555, 556], answerKind: "product", recordIds: [555, 556], recordKind: "product" });
      await writeClaim(t.paths, c);
      const r = await step(t.deps, c);
      if (ok) expect(r.claim.state.recordIds).toEqual([]);
      else expect(r.claim.state.history).toContain("spec attempt 1 failed: result: answer not marked");
    }
  }, 60_000);

  it("the question check of a decide-mode new blocker gets the question sent back and its reasoning (CM2)", async () => {
    const { deps, claim, paths } = await setup(() => ({ "question-check": [{ verdict: "decide_yourself", reasoning: "same question" }] }));
    const c = at(claim, { stage: "question-check", question: { ...Q, question: "Which index?", new_blocker: true }, askingStage: "plan", decideInput: "pick a", decidedQuestion: Q, decideReturns: 1 });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(inputOf(paths, "7-question-check-").decide_input).toBe("Sent back earlier for the asking stage to decide: Which store?\nIt decides the schema.\nThe reasoning given: pick a");
  }, 60_000);

  it("a transition that goes through resets the chain-failure count (Tm3)", async () => {
    const { deps, claim, paths } = await setup(() => ({ plan: [plan] }));
    const c = at(claim, { stage: "plan", chainFailures: { count: 2, last: "boom" } });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.claim.state).toMatchObject({ stage: "implement", chainFailures: null });
    expect(JSON.parse(readFileSync(ledgerFile(paths), "utf8")).chainFailures).toBeNull();
  }, 60_000);

  it("an abandonment carries an unrecorded answer into the fresh ledger (Tm4)", async () => {
    const pending = { ids: [555], kind: "product" as const, text: "Question #555: yes" };
    const { deps, claim, paths } = await setup(() => ({ fix: [] }));
    const c = at(claim, { stage: "fix", track: "spec", pr: null, rescues: 1, replans: 1, specRevisions: 1, specRescues: 1, pendingFixInput: "x", pendingAnswer: pending });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(readdirSync(paths.escalations).some((f) => f.startsWith("7.abandoned-"))).toBe(true);
    expect(JSON.parse(readFileSync(ledgerFile(paths), "utf8"))).toMatchObject({ rescues: 0, replans: 0, history: [], pendingAnswer: pending });
  }, 60_000);
});
describe("driver: a branch left on origin by a failed attempt (final review T2)", () => {
  /** Pushes a commit to issue-7 on origin from a scratch clone, as an implement that failed after its push would. */
  function leaveStaleBranch(pair: ReturnType<typeof repoPair>): void {
    const scratch = join(pair.root, "stale-clone");
    git(pair.root, "clone", "-q", pair.origin, scratch);
    git(scratch, "checkout", "-q", "-b", "issue-7");
    writeFileSync(join(scratch, "stale.txt"), "stale attempt\n");
    git(scratch, "add", "stale.txt");
    git(scratch, "commit", "-q", "-m", "stale attempt");
    git(scratch, "push", "-q", "origin", "issue-7");
  }
  const originHas = (pair: ReturnType<typeof repoPair>, branch: string) => git(pair.origin, "branch", "--list", branch).trim() !== "";

  it("saves the stale branch as a patch, closes its open PR with a comment and deletes it before a stage with no PR runs", async () => {
    let pair!: ReturnType<typeof repoPair>;
    const routes = (sha: string): Route[] => [
      { method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: (_m, _b, url) => ({ body: url.searchParams.get("head") === "o:issue-7" && url.searchParams.get("state") === "open" ? [{ number: 9 }] : [] }) },
      { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/, reply: (m) => { git(pair.origin, "update-ref", "-d", `refs/heads/${decodeURIComponent(m[1])}`); return { status: 204, body: null }; } },
      ...ghRoutes(sha),
    ];
    const t = await setup(() => ({ implement: [] }), routes, (p) => { pair = p; leaveStaleBranch(p); });
    const { deps, claim, gh, paths, adapter } = t;
    const c = at(claim, { stage: "implement", plan: plan as never });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(adapter.heads).toEqual(["issue-7"]);
    expect(git(claim.worktree, "rev-parse", "HEAD").trim()).toBe(git(pair.repo, "rev-parse", "origin/main").trim());
    expect(originHas(pair, "issue-7")).toBe(false);
    const writes = gh.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.url}`);
    const close = writes.indexOf("PATCH /repos/o/r/pulls/9");
    expect(writes.indexOf("POST /repos/o/r/issues/9/comments")).toBeLessThan(close);
    expect(close).toBeLessThan(writes.indexOf("DELETE /repos/o/r/git/refs/heads/issue-7"));
    expect(gh.calls.find((call) => call.method === "PATCH" && call.url === "/repos/o/r/pulls/9")?.body).toEqual({ state: "closed" });
    const saved = readdirSync(paths.patches).filter((f) => f.includes("stale-branch"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(paths.patches, saved[0]), "utf8")).toContain("stale attempt");
  }, 60_000);

  it("asks GitHub nothing when origin has no such branch", async () => {
    const { deps, claim, gh, paths } = await setup(() => ({ implement: [] }));
    const c = at(claim, { stage: "implement", plan: plan as never });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(gh.calls.some((call) => (call.url.startsWith("/repos/o/r/pulls?") && call.url.includes("head=")) || call.url.includes("/git/refs/heads/"))).toBe(false);
  }, 60_000);

  it("drops a stale spec-7 the same way before the spec stage runs (re-claim after a release)", async () => {
    let pair!: ReturnType<typeof repoPair>;
    const routes = (sha: string): Route[] => [
      { method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: () => ({ body: [] }) },
      { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/, reply: (m) => { git(pair.origin, "update-ref", "-d", `refs/heads/${decodeURIComponent(m[1])}`); return { status: 204, body: null }; } },
      ...ghRoutes(sha),
    ];
    const t = await setup(() => ({ spec: [] }), routes, (p) => {
      pair = p;
      const scratch = join(p.root, "stale-spec");
      git(p.root, "clone", "-q", p.origin, scratch);
      git(scratch, "push", "-q", "origin", "HEAD:refs/heads/spec-7");
    });
    const c = at(t.claim, { stage: "spec", track: "spec", specMode: "write" });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(t.adapter.heads).toEqual(["spec-7"]);
    expect(originHas(pair, "spec-7")).toBe(false);
  }, 60_000);
});
describe("driver: quota (spec 013)", () => {
  const SESSION = "You've hit your session limit · resets 8:10am (Europe/Berlin)";
  const FABLE = "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage, to continue.";
  /** Each model answers from its own list: a string is a 429 with that message, `{ crash: r }` writes r and exits 1, any other object a result. */
  function quotaAdapter(answers: Record<string, unknown[]>): Adapter & { ran: string[] } {
    const ran: string[] = [];
    let last: unknown;
    return {
      harness: "fake", quotaHarness: "claude", ran,
      buildCommand: (run) => {
        ran.push(`${run.stage}:${run.model}`);
        last = answers[run.model]?.shift();
        const crash = typeof last === "object" && last !== null && "crash" in last;
        const argv = [process.execPath, script, events, run.resultPath, typeof last === "string" ? "2" : crash ? "1" : "0", "0"];
        if (typeof last !== "string" && last !== undefined) argv.push(JSON.stringify(crash ? (last as { crash: unknown }).crash : last));
        return { argv, env: {} };
      },
      judge: (_e, exit) => exit === 2 ? { outcome: "failed", reason: String(last), apiErrorStatus: 429, finalText: null }
        : exit === 1 ? { outcome: "failed", reason: "harness crashed", apiErrorStatus: null, finalText: null } : { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "x" },
      usage: () => ({ cost_usd: 0.5, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 }),
    };
  }
  async function world(answers: Record<string, unknown[]>, now: string) {
    const t = await setup(() => ({}));
    const adapter = quotaAdapter(answers);
    let clock = new Date(now);
    const logs: Record<string, unknown>[] = [];
    t.deps.adapterFor = () => adapter;
    t.deps.now = () => clock;
    t.deps.log = (r) => { logs.push(r); };
    t.deps.parameters = new ParameterStore(t.paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), t.deps.cfg, {}));
    return { ...t, adapter, logs, setNow: (v: string) => { clock = new Date(v); } };
  }

  it("postpones a strong stage to the stated reset and starts no run before it (AC-4, AC-5, AC-6)", async () => {
    const w = await world({ "claude-fable-5-2": [SESSION, plan] }, "2026-10-29T02:58:53Z");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    let r = await step(w.deps, c);
    expect(r.status).toBe("waiting");
    expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "plan", postponedUntil: "2026-10-29T07:10:00.000Z" });
    expect(w.logs.find((l) => l.kind === "quota-limit")).toMatchObject({ key: "claude", scope: "session", resets_at: "2026-10-29T07:10:00.000Z", source: "stated" });
    // Before the reset nothing runs; at the reset a fresh plan run would be blocked no more.
    w.setNow("2026-10-29T05:00:00Z");
    r = await step(w.deps, r.claim);
    expect(r.status).toBe("waiting");
    // Even when the wait is bypassed (a restart, a manual start), the launch decision runs no blocked stage.
    const again = at(r.claim, { stage: "plan", postponedUntil: null });
    r = await step(w.deps, again);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-10-29T07:10:00.000Z" });
    expect(w.logs.find((l) => l.kind === "quota-wait")).toMatchObject({ issue: 7, stage: "plan", key: "claude" });
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2"]);
    expect(readdirSync(w.paths.usage)).toHaveLength(1);
    w.setNow("2026-10-29T07:11:00Z");
    r = await step(w.deps, r.claim);
    r = await step(w.deps, r.claim);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-fable-5-2"]);
    expect(r.claim.state.stage).toBe("implement");
  }, 60_000);

  describe("an answered resume that meets a limit (issue #467)", () => {
    const SETTLED = { conversation: "settled", decision: "The maintainer replied done.", findings: [] };
    const CAP: Question = { kind: "capability", question: "Can you renew the SSO login?", options: [{ label: "done", cost: "a login" }], recommendation: "done" };
    const asking = (worktree: string) => ({ harness: "fake" as const, model: "claude-sonnet-5-5", session_id: "asking-session", worktree });
    /** The #130 state: implement asked a capability question in its own session, and the maintainer answered it. */
    function answered(claim: Claim): Claim {
      const paused = { ...claim.state, stage: "paused" as const, plan: plan as never, question: CAP, askingStage: "implement" as const, resumeSession: asking(claim.worktree) };
      return { ...claim, state: transition(paused, { type: "answered", answer: "done", questionId: 1 }).state };
    }

    it("waits for the reset instead of failing implement when the fallback returns the conversation shape, and resumes the asking session after it", async () => {
      const w = await world({ "claude-sonnet-5-5": [SESSION], "openai/gpt-6.1-sol": [SETTLED, SETTLED] }, "2026-10-29T02:58:53Z");
      const c = answered(w.claim);
      expect(c.state).toMatchObject({ stage: "implement", attempt: 1, answer: "Question #1: done" });
      expect(c.state.conversation ?? null).toBeNull();
      await writeClaim(w.paths, c);
      let r = await step(w.deps, c);
      // The resume met the session limit, and its fallback returned a conversation turn it was never asked for.
      expect(w.adapter.ran).toEqual(["implement:claude-sonnet-5-5", "implement:openai/gpt-6.1-sol"]);
      expect(w.logs.find((l) => l.kind === "fallback-wrong-kind")).toMatchObject({ issue: 7, stage: "implement", attempt: 1, resume_session: "asking-session" });
      // No attempt is spent and nothing is failed: the claim waits for the primary's reset with the asking session kept.
      expect(r.status).toBe("waiting");
      expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "implement", attempt: 1, rescues: 0, postponedUntil: "2026-10-29T07:10:00.000Z", resumeSession: asking(w.claim.worktree), answer: "Question #1: done", fallbackWrongKind: true });
      expect(r.claim.state.history.filter((h) => /failed/.test(h))).toEqual([]);
      expect(w.logs.filter((l) => l.kind === "stale-branch-dropped")).toEqual([]);
      // After the reset the asking session is resumed on its own model, with the reply prompt.
      w.setNow("2026-10-29T07:11:00Z");
      for (let i = 0; i < 3 && w.adapter.ran.length < 3; i++) r = await step(w.deps, r.claim);
      expect(w.adapter.ran).toEqual(["implement:claude-sonnet-5-5", "implement:openai/gpt-6.1-sol", "implement:claude-sonnet-5-5"]);
      const last = readdirSync(w.paths.runs).filter((d) => d.startsWith("7-implement-")).sort().at(-1)!;
      expect(readFileSync(join(w.paths.runs, last, "prompt.md"), "utf8")).toMatch(/^Question #1: done\n\nContinue implement in work mode\./);
      // That run met no limit, so the next limit may take the fallback again.
      expect(r.claim.state.fallbackWrongKind).toBeUndefined();
    }, 60_000);

    it("after one wrong-kind fallback, a later limit waits for the reset without running the fallback again", async () => {
      const LATER = "You've hit your session limit · resets 2pm (Europe/Berlin)";
      const w = await world({ "claude-sonnet-5-5": [SESSION, LATER], "openai/gpt-6.1-sol": [SETTLED, SETTLED] }, "2026-10-29T02:58:53Z");
      const c = answered(w.claim);
      await writeClaim(w.paths, c);
      let r = await step(w.deps, c);
      expect(r.claim.state).toMatchObject({ stage: "waiting", fallbackWrongKind: true });
      // After the reset the resume meets a new limit: no second fallback run, the claim waits again with the session kept.
      w.setNow("2026-10-29T07:11:00Z");
      for (let i = 0; i < 3 && w.adapter.ran.length < 3; i++) r = await step(w.deps, r.claim);
      expect(w.adapter.ran).toEqual(["implement:claude-sonnet-5-5", "implement:openai/gpt-6.1-sol", "implement:claude-sonnet-5-5"]);
      const reset = JSON.parse(readFileSync(w.paths.quota, "utf8")).limits.claude.resets_at as string;
      expect(Date.parse(reset)).toBeGreaterThan(Date.parse("2026-10-29T07:11:00Z"));
      expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "implement", attempt: 1, resumeSession: asking(w.claim.worktree), fallbackWrongKind: true, postponedUntil: reset });
      expect(r.claim.state.history.filter((h) => /failed/.test(h))).toEqual([]);
      expect(w.logs.filter((l) => l.kind === "fallback-wrong-kind")).toHaveLength(1);
      // A launch the book would move to the fallback waits too.
      const planned = at(r.claim, { stage: "implement", postponedUntil: null, resumeSession: null });
      r = await step(w.deps, planned);
      expect(w.adapter.ran).toHaveLength(3);
      expect(r.claim.state).toMatchObject({ stage: "waiting", fallbackWrongKind: true, postponedUntil: reset });
      expect(w.logs.filter((l) => l.kind === "quota-wait").at(-1)).toMatchObject({ stage: "implement", model: "claude-sonnet-5-5", reason: "fallback returned a conversation turn before; waiting for the primary" });
    }, 60_000);

    it("a fallback run that wrote the conversation shape but failed for another reason still fails the stage", async () => {
      const w = await world({ "claude-sonnet-5-5": [SESSION], "openai/gpt-6.1-sol": [{ crash: SETTLED }] }, "2026-10-29T02:58:53Z");
      const c = answered(w.claim);
      await writeClaim(w.paths, c);
      const r = await step(w.deps, c);
      expect(w.adapter.ran).toEqual(["implement:claude-sonnet-5-5", "implement:openai/gpt-6.1-sol"]);
      expect(r.claim.state.history.at(-1)).toBe("implement attempt 1 failed: harness crashed");
      expect(r.claim.state.fallbackWrongKind).toBeUndefined();
      expect(w.logs.filter((l) => l.kind === "fallback-wrong-kind")).toEqual([]);
    }, 60_000);

    it("a planned fallback run of an answered stage that returns the conversation shape waits too, and spends no attempt", async () => {
      const w = await world({ "claude-sonnet-5-5": [SESSION], "openai/gpt-6.1-sol": [SETTLED] }, "2026-10-29T02:58:53Z");
      // The limit is already in the book: the book launches implement on its fallback directly.
      await observeRun(w.paths, {
        run_id: "u", issue: 7, stage: "implement", attempt: 1, outcome: "failed", harness: "claude", model: "claude-sonnet-5-5", cost_usd: 0, input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0, wall_seconds: 1, started_at: "2026-10-29T02:58:00Z", ended_at: "2026-10-29T02:58:01Z", events_path: "",
      }, { outcome: "failed", reason: SESSION, apiErrorStatus: 429, finalText: null }, new Date("2026-10-29T02:58:53Z"));
      const c = at(w.claim, { stage: "implement", attempt: 1, plan: plan as never, answer: "Question #1: done", answerQuestionId: 1, answerQuestionIds: [1], answerKind: "capability", resumeSession: null });
      await writeClaim(w.paths, c);
      const r = await step(w.deps, c);
      expect(w.adapter.ran).toEqual(["implement:openai/gpt-6.1-sol"]);
      expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "implement", attempt: 1, resumeSession: null });
      expect(r.claim.state.history.filter((h) => /failed/.test(h))).toEqual([]);
    }, 60_000);

    it("a fallback run with no answer that returns the conversation shape still fails the stage (spec 044 AC-3)", async () => {
      const w = await world({ "claude-sonnet-5-5": [SESSION], "openai/gpt-6.1-sol": [SETTLED] }, "2026-10-29T02:58:53Z");
      const c = at(w.claim, { stage: "implement", attempt: 1, plan: plan as never });
      await writeClaim(w.paths, c);
      const r = await step(w.deps, c);
      expect(w.adapter.ran).toEqual(["implement:claude-sonnet-5-5", "implement:openai/gpt-6.1-sol"]);
      expect(r.claim.state.history.at(-1)).toBe("implement attempt 1 failed: result: invalid: conversation turn outside a conversation");
      expect(w.logs.filter((l) => l.kind === "fallback-wrong-kind")).toEqual([]);
    }, 60_000);
  });

  it("moves a strong stage to the next-best Claude model on a model-only limit, then launches there directly (AC-9)", async () => {
    const w = await world({ "claude-fable-5-2": [FABLE], "claude-opus-5-5": [plan, plan] }, "2026-10-29T07:15:00Z");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    const r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-opus-5-5"]);
    expect(r.claim.state.stage).toBe("implement");
    expect(w.logs.filter((l) => l.kind === "quota-fallback")).toEqual([{ kind: "quota-fallback", issue: 7, stage: "plan", from: "claude-fable-5-2", to: "claude-opus-5-5", key: "claude:fable" }]);
    const again = at(r.claim, { stage: "plan" });
    await step(w.deps, again);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-opus-5-5", "plan:claude-opus-5-5"]);
    const usage = readdirSync(w.paths.usage).map((f) => JSON.parse(readFileSync(join(w.paths.usage, f), "utf8")).model).sort();
    expect(usage).toEqual(["claude-fable-5-2", "claude-opus-5-5", "claude-opus-5-5"]);
  }, 60_000);

  it("moves a rescue to the next-best Claude model under a Fable limit, then launches there directly (AC-9; ADR 0003 amendment 2026-11-17)", async () => {
    const w = await world({ "claude-fable-5-2": [FABLE], "claude-opus-5-5": [plan, plan] }, "2026-10-29T07:15:00Z");
    const c = at(w.claim, { stage: "plan", rescueRun: true, rescues: 1 });
    await writeClaim(w.paths, c);
    let r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-opus-5-5"]);
    expect(r.claim.state).toMatchObject({ stage: "implement", rescueRun: false, rescues: 1 });
    expect(w.logs.filter((l) => l.kind === "quota-fallback")).toEqual([{ kind: "quota-fallback", issue: 7, stage: "plan", from: "claude-fable-5-2", to: "claude-opus-5-5", key: "claude:fable" }]);
    expect(w.logs.filter((l) => l.kind === "stage").at(-1)).toMatchObject({ outcome: "ok", rescue: true, fallback: "claude-opus-5-5", run_id: expect.stringMatching(/-rescue-fallback$/) });
    // Started again while the Fable limit holds, the rescue launches on Opus without a 429 first.
    w.setNow("2026-10-29T07:20:00Z");
    r = await step(w.deps, at(r.claim, { stage: "plan", rescueRun: true }));
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-opus-5-5", "plan:claude-opus-5-5"]);
    expect(r.claim.state).toMatchObject({ stage: "implement", rescueRun: false, rescues: 1 });
    expect(w.logs.filter((l) => l.kind === "stage").at(-1)).toMatchObject({ outcome: "ok", rescue: true, fallback: "claude-opus-5-5", run_id: expect.stringMatching(/-rescue-fallback$/) });
  }, 60_000);

  it("postpones a rescue when the fallback model is limited too (AC-9, spec 006 AC-27)", async () => {
    const w = await world({ "claude-fable-5-2": [FABLE], "claude-opus-5-5": ["You've hit your Opus limit · resets 9pm (UTC)"] }, "2026-10-29T07:15:00Z");
    const c = at(w.claim, { stage: "plan", rescueRun: true, rescues: 1 });
    await writeClaim(w.paths, c);
    let r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-opus-5-5"]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "plan", rescueRun: true, rescues: 1, postponedUntil: "2026-10-29T07:30:00.000Z" });
    // Started again while both limits hold, the rescue waits and runs nothing.
    r = await step(w.deps, at(r.claim, { stage: "plan", postponedUntil: null }));
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-opus-5-5"]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", rescueRun: true, rescues: 1 });
    expect(w.logs.filter((l) => l.kind === "quota-wait").at(-1)).toMatchObject({ stage: "plan", key: "claude:fable" });
  }, 60_000);

  it("caps a session wait at quota.session_window as set in the parameter store (AC-1, AC-8)", async () => {
    // 8:10 Berlin read an hour after it passed would be tomorrow; with a 2h window the wait is 2h.
    const w = await world({ "claude-fable-5-2": ["You've hit your session limit · resets 8:10am (Europe/Berlin)"] }, "2026-10-29T08:10:00Z");
    await w.deps.parameters!.setParameter("quota.session_window", "2h", "maintainer");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    const r = await step(w.deps, c);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-10-29T10:10:00.000Z" });
    const book = JSON.parse(readFileSync(w.paths.quota, "utf8"));
    expect(book.window).toMatchObject({ start: "2026-10-29T08:10:00.000Z" });
    expect(book.limits.claude.resets_at).toBe("2026-10-29T10:10:00.000Z");
  }, 60_000);

  it("never moves a strong stage to another Claude model on a weekly limit (AC-9)", async () => {
    const w = await world({ "claude-fable-5-2": ["You've hit your weekly limit · resets Nov 3, 9am (Europe/Berlin)"] }, "2026-10-29T07:15:00Z");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    const r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2"]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-11-03T08:00:00.000Z" });
    expect(w.logs.filter((l) => l.kind === "quota-fallback")).toEqual([]);
  }, 60_000);

  it("defers a strong stage to the window's end once, then runs it (AC-8)", async () => {
    const w = await world({ "claude-fable-5-2": [plan] }, "2026-10-29T03:00:00Z");
    const u = (over: Record<string, unknown>) => ({
      run_id: `u${Math.random()}`, issue: 1, stage: "plan", attempt: 1, outcome: "ok" as const, harness: "claude" as const, model: "claude-fable-5-2", cost_usd: 4, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0, wall_seconds: 1, started_at: "", ended_at: "", events_path: "", ...over,
    });
    const okJ = { outcome: "ok" as const, reason: null, apiErrorStatus: null, finalText: null };
    for (const [start, reset] of [["2026-10-28T12:00:00Z", "6pm"], ["2026-10-28T18:00:00Z", "12am"]]) {
      for (let i = 0; i < 5; i++) await observeRun(w.paths, u({ started_at: start }), okJ, new Date(start));
      await observeRun(w.paths, u({ outcome: "failed", cost_usd: 0, started_at: start }), { outcome: "failed", reason: `You've hit your session limit · resets ${reset} (UTC)`, apiErrorStatus: 429, finalText: null }, new Date(start));
    }
    for (let i = 0; i < 5; i++) await observeRun(w.paths, u({ started_at: "2026-10-29T00:01:00Z" }), okJ, new Date("2026-10-29T00:01:00Z"));
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    let r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual([]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-10-29T05:01:00.000Z" });
    expect(w.logs.find((l) => l.kind === "quota-defer")).toMatchObject({ issue: 7, stage: "plan", estimate: 4, spent: 20, capacity: 20, until: "2026-10-29T05:01:00.000Z" });
    // Started again before the end (a restart), it is not deferred a second time in the same window.
    r = await step(w.deps, at(r.claim, { stage: "plan", postponedUntil: null }));
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2"]);
    expect(r.claim.state.stage).toBe("implement");
  }, 60_000);

  it("waits instead when the model-limit fallback parameter is off (AC-9)", async () => {
    const w = await world({ "claude-fable-5-2": [FABLE] }, "2026-10-29T07:15:00Z");
    await w.deps.parameters!.setParameter("quota.model_limit_fallback", false, "maintainer");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    const r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-2"]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-10-29T07:30:00.000Z" });
  }, 60_000);
});
describe("driver: questions (spec 006 AC-12, AC-13, AC-17)", () => {
  it("sends a plan escalation to the question check even when its domain has no profile (review focus 9)", async () => {
    const { deps, claim, paths } = await setup(() => ({ plan: [{ ...plan, domain: "firmware", escalation: Q }] }));
    const c = await steps(deps, claim, 2);
    expect(c.state).toMatchObject({ stage: "question-check", askingStage: "plan", question: Q });
    expect(logEvents(paths)).toEqual(["asked"]);
  }, 60_000);

  it("pauses on send: the paused record, the question comment with its nonce, labels, one notification, no claim, worktree kept, log asked/checked/sent (AC-13, AC-18)", async () => {
    const { deps, claim, gh, paths, notifications } = await setup(() => ({ plan: [plan], implement: [{ escalation: Q }], "question-check": [{ verdict: "send", reasoning: "a real choice" }] }));
    const r = await (async () => { let c = claim; let res; for (let i = 0; i < 4; i++) { res = await step(deps, c); c = res.claim; if (res.status !== "continue") break; } return res!; })();
    expect(r.status).toBe("ended");
    const rec = JSON.parse(readFileSync(join(paths.paused, "7.json"), "utf8"));
    expect(rec).toMatchObject({ phase: "paused", question_comment_id: 5001, asked_at: "2026-10-20T10:00:00Z", asking_stage: "implement", question: Q, reminded: false });
    const body = String((gh.calls.find((x) => x.url === "/repos/o/r/issues/7/comments")?.body as { body: string }).body);
    expect(body.split("\n").at(-1)).toBe(`<!-- panelator-question:${rec.nonce} -->`);
    expect(body.startsWith("### Question for the maintainer\n@adam26davidson")).toBe(true);
    expect(writes(gh).filter((w) => w.includes("/labels"))).toEqual(["POST /repos/o/r/issues/7/labels", "DELETE /repos/o/r/issues/7/labels/in-progress"]);
    expect(gh.calls.find((x) => x.url === "/repos/o/r/issues/7/labels")?.body).toEqual({ labels: ["needs-decision"] });
    expect(notifications.map((n) => n.gate)).toEqual(["question"]);
    expect(existsSync(join(paths.claims, "7.json"))).toBe(false);
    expect(existsSync(claim.worktree)).toBe(true);
    expect(logEvents(paths)).toEqual(["asked", "checked", "sent"]);
  }, 60_000);

  it("gives the question check the issue's answered questions and posts the check's wording (C8, C10)", async () => {
    const worded = { kind: "technical", question: "Store a or b? The schema follows.", options: [{ label: "a", cost: "cheap" }], recommendation: "a" };
    const { deps, claim, gh, paths } = await setup(() => ({ "question-check": [{ verdict: "send", reasoning: "real choice", question: worded }] }));
    await appendQuestionLog(paths, { issue: 7, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 501, reply_comment_id: 502, answer: "keep it\nlocal", question: { ...Q, question: "Where does data live?" } });
    await appendQuestionLog(paths, { issue: 8, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 601, reply_comment_id: 602, answer: "other issue" });
    const c = at(claim, { stage: "question-check", question: Q, askingStage: "plan" });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(inputOf(paths, "7-question-check-").answered_questions).toBe("#501 (technical): Question: Where does data live? Answer: keep it local");
    expect(inputOf(paths, "7-question-check-").reported_actions).toBe("(none)");
    expect(readFileSync(join(paths.runs, readdirSync(paths.runs).find((d) => d.startsWith("7-question-check-"))!, "prompt.md"), "utf8")).toContain("#501 (technical): Question: Where does data live?");
    const body = String((gh.calls.find((x) => x.url === "/repos/o/r/issues/7/comments")?.body as { body: string }).body);
    expect(body).toContain("Store a or b? The schema follows.");
    expect(body).not.toContain("Which store?");
    expect(JSON.parse(readFileSync(join(paths.paused, "7.json"), "utf8")).question).toEqual(worded);
  }, 60_000);

  it("lists decisions and reported actions apart for the question check (spec 062 AC-1)", async () => {
    const { deps, claim, paths } = await setup(() => ({ "question-check": [{ verdict: "send", reasoning: "x", question: { kind: "technical", question: "q", options: [{ label: "a", cost: "c" }], recommendation: "a" } }] }));
    const log = (issue: number, id: number, at: string, answer: string, kind?: string) =>
      appendQuestionLog(paths, { issue, at, event: "answered", asking_stage: "plan", question_comment_id: id, reply_comment_id: id + 1, answer, ...(kind ? { question: { ...Q, kind: kind as never, question: `Q${id}?` } } : {}) });
    await log(7, 701, "2026-10-20T01:00:00Z", "p", "product");
    await log(7, 703, "2026-10-20T02:00:00Z", "t", "technical");
    await log(7, 705, "2026-10-20T03:00:00Z", "reclaim space", "capability");
    await log(7, 707, "2026-10-20T04:00:00Z", "n");
    await log(8, 801, "2026-10-20T05:00:00Z", "other", "capability");
    const c = at(claim, { stage: "question-check", question: Q, askingStage: "plan" });
    await writeClaim(paths, c);
    await step(deps, c);
    const input = inputOf(paths, "7-question-check-");
    expect(input.answered_questions).toBe(["#701 (product): Question: Q701? Answer: p", "#703 (technical): Question: Q703? Answer: t", "#707 (unknown): Question: (not logged) Answer: n"].join("\n"));
    expect(input.reported_actions).toBe("#705 (capability, answered 2026-10-20T03:00:00Z): Question: Q705? Answer: reclaim space");
    const prompt = readFileSync(join(paths.runs, readdirSync(paths.runs).find((d) => d.startsWith("7-question-check-"))!, "prompt.md"), "utf8");
    expect(prompt).toContain(input.answered_questions);
    expect(prompt).toContain(input.reported_actions);
    expect(prompt).not.toContain("#801");
  }, 60_000);

  it("logs a follow-up as asked when it pauses without the check (T-minor 5)", async () => {
    const fu = { ...Q, follow_up: true, reply_quote: "Which store do you mean?" };
    const { deps, claim, paths } = await setup(() => ({ plan: [{ escalation: fu }] }));
    const c = at(claim, { stage: "plan", answer: "Question #555: Which store do you mean?", answerQuestionId: 555, answerQuestionIds: [555], answerKind: "capability" });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.status).toBe("ended");
    expect(logEvents(paths)).toEqual(["asked", "sent"]);
  }, 60_000);

  it("re-runs a check pending six hours, then runs a fix whose input names it (AC-17)", async () => {
    const { deps, claim, gh, paths, sha } = await setup(() => ({ fix: [] }), (sha) => ghRoutes(sha, { checks: [{ id: 42, name: "test", status: "queued", conclusion: null }] }));
    const c = at(claim, { stage: "verify", plan: plan as never, pr: { number: 9, head_sha: sha }, pendingSince: new Date(Date.now() - 7 * 3_600_000).toISOString() });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(writes(gh)).toContain("POST /repos/o/r/check-runs/42/rerequest");
    expect(r.claim.state).toMatchObject({ stage: "fix", checksRerun: true });
    await step(deps, r.claim);
    expect(inputOf(paths, "7-fix-").fix_input).toMatch(/Required checks test have been pending for 6 hours/);
  }, 60_000);

  it("lists the review's cited answers, verified only from the questions log (AC-10, C7)", async () => {
    const { deps, claim, paths, sha } = await setup(() => ({ review: [approve] }), undefined, (_pair, wt) => {
      commitIn(wt, { "notes.md": "per (maintainer answer, question #101)\nsee question #102\nand question #103\nand question #104\n" });
    });
    await appendQuestionLog(paths, { issue: 7, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 101, reply_comment_id: 111, answer: "use a\nplease", question: Q });
    await appendQuestionLog(paths, { issue: 7, at: "2026-10-20T00:00:00Z", event: "sent", asking_stage: "plan", question_comment_id: 102 });
    // An answer to another issue's question verifies nothing here.
    await appendQuestionLog(paths, { issue: 8, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 104, reply_comment_id: 114, answer: "other", question: Q });
    const c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(inputOf(paths, "7-review-").reported_actions).toBeUndefined();
    expect(inputOf(paths, "7-review-").answered_questions).toBe([
      "#101: verified. Question: Which store?. Answer: use a please",
      "#102: NOT verified; treat as no citation",
      "#103: NOT verified; treat as no citation",
      "#104: NOT verified; treat as no citation",
    ].join("\n"));
  }, 60_000);
});
describe("driver: spec track (spec 006 AC-4, AC-19, AC-21, AC-22)", () => {
  it("fails a spec-PR fix that records a product answer without its mark (AC-18)", async () => {
    const { deps, claim, paths, sha } = await setup((sha) => ({ fix: [{ head_sha: sha, addressed: [] }] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7);
    const c = at(claim, { stage: "fix", track: "spec", pr: { number: 12, head_sha: sha }, answer: "keep it local", answerQuestionId: 555, answerQuestionIds: [555], answerKind: "product", recordIds: [555], recordKind: "product", pendingFixInput: "Record the decision." });
    await writeClaim(paths, c);
    expect((await step(deps, c)).claim.state.history).toContain("fix attempt 1 failed: result: answer not marked");
  }, 60_000);

  it("runs the spec stage on spec-7 for a claim with a missing spec (review focus 12)", async () => {
    const { deps, claim, adapter, paths } = await setup(() => ({ spec: [] }));
    const c = { ...claim, state: initialChainState(7, "specs/010-thing/spec.md has no Parent: line") };
    await writeClaim(paths, c);
    const r = await steps(deps, c, 2);
    expect(adapter.heads).toEqual(["spec-7"]);
    expect(r.state).toMatchObject({ stage: "spec", track: "spec", specMode: "write", attempt: 2 });
    expect(inputOf(paths, "7-spec-")).toMatchObject({ mode: "write", spec_problem: "specs/010-thing/spec.md has no Parent: line" });
  }, 60_000);

  it("sends a spec_gap to the spec stage in answer mode on spec-7, with no needs-clarification label (AC-19, review focus 12)", async () => {
    const gap = { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Which store?"] };
    const { deps, claim, adapter, gh, paths } = await setup(() => ({ plan: [gap], spec: [] }));
    const c = await steps(deps, claim, 3);
    expect(adapter.heads).toEqual(["issue-7", "spec-7"]);
    expect(c.state).toMatchObject({ track: "spec", specMode: "answer", specAnswers: 1 });
    expect(inputOf(paths, "7-spec-").mode).toBe("answer");
    expect(gh.calls.some((x) => x.method === "POST" && x.url.endsWith("/labels"))).toBe(false);
  }, 60_000);

  it("after a spec-track merge deletes spec-7 locally and on GitHub, records no merge, and implements on issue-7 (AC-4, review focus 7)", async () => {
    const { deps, claim, adapter, gh, paths, sha } = await setup(() => ({ plan: [plan], implement: [] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), (pair, wt) => {
      onSpec7(pair, wt);
      // The squash merge: the spec PR's content lands on main as a new commit.
      commitIn(pair.repo, { "specs/010-thing/notes.md": "notes\n" }, "spec PR (squash)");
      git(pair.repo, "push", "-q", "origin", "main");
    });
    const c = at(claim, { stage: "merge", track: "spec", pr: { number: 12, head_sha: sha } });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(writes(gh)).toContain("PUT /repos/o/r/pulls/12/merge");
    expect(writes(gh)).toContain("DELETE /repos/o/r/git/refs/heads/spec-7");
    expect(r.claim.state).toMatchObject({ stage: "plan", track: "issue", pr: null });
    expect(branchIn(claim.worktree)).toBe("issue-7");
    expect(git(claim.worktree, "branch", "--list", "spec-7").trim()).toBe("");
    expect(existsSync(join(paths.root, "merges.jsonl"))).toBe(false);
    expect(readdirSync(paths.patches).filter((f) => f.includes("deleted-branch"))).toEqual([]);
    await steps(deps, r.claim, 2);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2", "implement:claude-sonnet-5-5"]);
    expect(adapter.heads).toEqual(["issue-7", "issue-7"]);
  }, 60_000);

  it("runs the spec stage again on the rescue model in write mode when spec-present fails on main after the merge (AC-4)", async () => {
    const { deps, claim, adapter, paths, sha } = await setup(() => ({ spec: [] }), (sha) => ghRoutes(sha, { issueBody: "Spec: specs/011-gone/spec.md", prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7);
    deps.cfg = { ...deps.cfg, rescue_model: "claude-rescue-test" };
    const c = at(claim, { stage: "merge", track: "spec", pr: { number: 12, head_sha: sha } });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.claim.state).toMatchObject({ stage: "spec", track: "spec", specMode: "write", rescueRun: true, specRescues: 1 });
    await step(deps, r.claim);
    expect(adapter.ran).toEqual(["spec:claude-rescue-test"]);
    expect(adapter.heads).toEqual(["spec-7"]);
    expect(inputOf(paths, "7-spec-")).toMatchObject({ mode: "write", spec_problem: "specs/011-gone/spec.md not found on main" });
  }, 60_000);

  describe("a split spec merged (spec 031 AC-9)", () => {
    const design = "Parent: docs/delivery-system-design.md\n\n## Children\n\n- planned: a\n  title: A\n  brief: Part a.\n- planned: b\n  title: B\n  brief: Part b.\n  after: a\n";
    const splitFiles = { "docs/designs/split.md": design, "specs/011-split/README.md": "This spec was split: see docs/designs/split.md.\n" };
    const onSplit7 = (pair: ReturnType<typeof repoPair>, wt: string) => {
      git(wt, "checkout", "-q", "-b", "spec-7");
      commitIn(wt, splitFiles, "spec work: a split");
      git(wt, "push", "-q", "-u", "origin", "spec-7");
      // The squash merge: the spec PR's content lands on main.
      commitIn(pair.repo, splitFiles, "spec PR (squash)");
      git(pair.repo, "push", "-q", "origin", "main");
    };
    const route = (sha: string) => ghRoutes(sha, { issueBody: "Spec: specs/011-split/spec.md", prs: { 12: { headRef: "spec-7", head: sha } } });

    it("comments, closes the issue, removes the claim label, records a debt system merge and ends done", async () => {
      const { deps, claim, gh, paths, sha } = await setup(() => ({}), route, onSplit7);
      const c = at(claim, { stage: "merge", track: "spec", pr: { number: 12, head_sha: sha } });
      await writeClaim(paths, c);
      const r = await step(deps, c);
      expect(r.status).toBe("ended");
      expect(await readClaim(paths, 7)).toBeNull();
      const w = writes(gh);
      expect(w).toContain("PUT /repos/o/r/pulls/12/merge");
      expect(w).toContain("DELETE /repos/o/r/git/refs/heads/spec-7");
      expect(w.indexOf("POST /repos/o/r/issues/7/comments")).toBeLessThan(w.indexOf("PATCH /repos/o/r/issues/7"));
      expect(w).toContain("DELETE /repos/o/r/issues/7/labels/in-progress");
      const comment = gh.calls.find((x) => x.url === "/repos/o/r/issues/7/comments");
      expect(JSON.stringify(comment?.body)).toContain("docs/designs/split.md");
      const merges = readFileSync(join(paths.root, "merges.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(merges).toEqual([expect.objectContaining({ issue: 7, pr: 12, cls: "debt", work: "system" })]);
    }, 60_000);

    it("still reruns the spec stage without the README.md pointer, and without a design in the diff", async () => {
      for (const files of [{ "docs/designs/split.md": design }, { "specs/011-split/README.md": "pointer\n" }] as Record<string, string>[]) {
        const prepare = (pair: ReturnType<typeof repoPair>, wt: string) => {
          git(wt, "checkout", "-q", "-b", "spec-7");
          commitIn(wt, files, "spec work");
          git(wt, "push", "-q", "-u", "origin", "spec-7");
          commitIn(pair.repo, files, "spec PR (squash)");
          git(pair.repo, "push", "-q", "origin", "main");
        };
        const { deps, claim, paths, sha } = await setup(() => ({ spec: [] }), route, prepare);
        const c = at(claim, { stage: "merge", track: "spec", pr: { number: 12, head_sha: sha } });
        await writeClaim(paths, c);
        const r = await step(deps, c);
        expect(r.claim.state).toMatchObject({ stage: "spec", specMode: "write" });
        expect(existsSync(join(paths.root, "merges.jsonl"))).toBe(false);
      }
    }, 60_000);
  });

  it("starts the design stage, not a park, when the UI-design gate fails after the spec merge (spec 029 AC-1)", async () => {
    const ui = "specs/011-ui/spec.md";
    const files = {
      "a.txt": "a\n", "specs/010-thing/spec.md": spec, [ui]: readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-webui.md"), "utf8"),
      "docs/top.md": `# Top design\n\n## Children\n\n- \`specs/010-thing/spec.md\`\n- \`${ui}\`\n`,
    };
    const { deps, claim, gh, paths, sha } = await setup(() => ({}), (sha) => ghRoutes(sha, { issueBody: `Spec: ${ui}`, prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7, files);
    const c = at(claim, { stage: "merge", track: "spec", pr: { number: 12, head_sha: sha }, specRescues: 1 });
    await writeClaim(paths, c);
    await writeLedger(paths, 7, ledgerOf(c.state));
    const r = await step(deps, c);
    expect(r.status).toBe("continue");
    expect(r.claim.state).toMatchObject({ stage: "design", track: "design", pr: null, specRescues: 1 });
    expect(r.claim.state.designProblem).toMatch(/editor-empty\.mobile\.png/);
    expect(gh.calls.some((x) => x.url === "/repos/o/r/issues/7/labels" && x.method === "POST")).toBe(false);
    expect(writes(gh)).not.toContain("DELETE /repos/o/r/issues/7/labels/in-progress");
    expect(await readClaim(paths, 7)).not.toBeNull();
  }, 60_000);

  describe("design track (spec 029)", () => {
    const uiSpec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-webui.md"), "utf8");
    const uiFiles = withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": uiSpec }, "specs/010-thing/spec.md");
    const onDesign7 = (_pair: ReturnType<typeof repoPair>, wt: string) => {
      git(wt, "checkout", "-q", "-b", "design-7");
      commitIn(wt, { "specs/010-thing/design/editor.stories.tsx": "export default {};\n" }, "design work");
      git(wt, "push", "-q", "-u", "origin", "design-7");
    };
    const screens = [
      { name: "editor-empty", stories: ["editor-empty--default"], renders: ["a.png", "a.mobile.png", "a.tablet.png"] },
      { name: "editor-populated", stories: ["editor-populated--default"], renders: ["b.png", "b.mobile.png", "b.tablet.png"] },
    ];
    const designed = (sha: string, extra: Record<string, unknown> = {}) => ({ verdict: "designed", spec_path: "specs/010-thing/spec.md", pr_number: 12, head_sha: sha, screens, ...extra });
    async function designRun(result: Scripted, over: RouteOver = {}, prepare?: (pair: ReturnType<typeof repoPair>, wt: string) => void) {
      const env = await setup(() => ({ design: [result], fix: [] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "design-7", head: sha, body: "Refs #7\n\n![a](a.png)" } }, ...over }), prepare, uiFiles);
      const c = at(env.claim, { stage: "design", track: "design", designProblem: "the design is incomplete: missing editor-empty.png" });
      await writeClaim(env.paths, c);
      return { ...env, r: await step(env.deps, c) };
    }

    it("gives the design stage the spec path, the problem and the viewports, valid against stage-input (AC-1)", async () => {
      const { paths, adapter } = await designRun((run: StageRun) => designed(head(run.worktree)));
      const input = inputOf(paths, "7-design-");
      expect(input).toMatchObject({ spec_path: "specs/010-thing/spec.md", design_problem: "the design is incomplete: missing editor-empty.png", viewports: expect.stringContaining("tablet 820x1180") });
      expect(validate("stage-input", input).ok).toBe(true);
      expect(adapter.heads).toEqual(["design-7"]);
      expect(adapter.ran).toEqual(["design:claude-fable-5-2"]);
    }, 60_000);

    it("fails a result with a screen of two renders, or without stories, as an invalid result (AC-2)", async () => {
      const two = await designRun((run: StageRun) => designed(head(run.worktree), { screens: [{ ...screens[0], renders: ["a.png", "a.mobile.png"] }, screens[1]] }));
      expect(two.r.claim.state.history).toContain("design attempt 1 failed: result: invalid");
      const none = await designRun((run: StageRun) => designed(head(run.worktree), { screens: [{ ...screens[0], stories: [] }, screens[1]] }));
      expect(none.r.claim.state.history).toContain("design attempt 1 failed: result: invalid");
    }, 60_000);

    it("fails a result that leaves a named screen out (AC-2)", async () => {
      const { r } = await designRun((run: StageRun) => designed(head(run.worktree), { screens: [screens[0]] }));
      expect(r.claim.state.history).toContain("design attempt 1 failed: result: invalid: screen editor-populated has no story");
    }, 60_000);

    it("fails a design PR body that closes an issue or does not start with Refs (AC-2)", async () => {
      let wt = "";
      const prepare = (_p: ReturnType<typeof repoPair>, w: string) => { wt = w; };
      const closes = await designRun((run: StageRun) => designed(head(run.worktree)), { prs: { 12: { headRef: "design-7", head: () => head(wt), body: "Refs #7\nCloses #7" } } }, prepare);
      expect(closes.r.claim.state.history).toContain("design attempt 1 failed: result: design PR body closes an issue");
      const bare = await designRun((run: StageRun) => designed(head(run.worktree)), { prs: { 12: { headRef: "design-7", head: () => head(wt), body: "The design" } } }, prepare);
      expect(bare.r.claim.state.history.join("\n")).toContain("does not start with Refs #7");
    }, 60_000);

    it("reports a design PR diff outside design/ as a scope violation, handled as a spec PR's (AC-2)", async () => {
      let wt = "";
      const edit = (run: StageRun) => designed(commitIn(run.worktree, { "docs/x.md": "x\n", "specs/010-thing/design/editor.stories.tsx": "export default {};\n" }));
      const { r } = await designRun(edit, { prs: { 12: { headRef: "design-7", head: () => head(wt), body: "Refs #7" } } }, (_p, w) => { wt = w; });
      expect(r.claim.state).toMatchObject({ stage: "fix", track: "design", scopeViolations: 1 });
      expect(r.claim.state.pendingFixInput).toContain("docs/x.md: outside design PR scope");
    }, 60_000);

    it("runs the fix on the design PR under the design profile and the design stage's model (AC-3)", async () => {
      const env = await setup(() => ({ fix: [(run: StageRun) => ({ head_sha: head(run.worktree), addressed: [0] })] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "design-7", head: sha } } }), onDesign7, uiFiles);
      const c = at(env.claim, { stage: "fix", track: "design", pr: { number: 12, head_sha: env.sha }, pendingFixInput: "Review requested changes" });
      await writeClaim(env.paths, c);
      await step(env.deps, c);
      expect(env.adapter.ran).toEqual(["fix:claude-fable-5-2"]);
      expect(env.adapter.heads).toEqual(["design-7"]);
      expect(inputOf(env.paths, "7-fix-").profile_instructions).toContain("Design profile");
    }, 60_000);

    it("reports the gate on main after a design merge: a still-missing render is another design run (AC-4)", async () => {
      const env = await setup(() => ({}), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "design-7", head: sha } } }), onDesign7, uiFiles);
      const c = at(env.claim, { stage: "merge", track: "design", pr: { number: 12, head_sha: env.sha } });
      await writeClaim(env.paths, c);
      const r = await step(env.deps, c);
      expect(writes(env.gh)).toContain("PUT /repos/o/r/pulls/12/merge");
      expect(writes(env.gh)).toContain("DELETE /repos/o/r/git/refs/heads/design-7");
      expect(existsSync(join(env.paths.root, "merges.jsonl"))).toBe(false);
      expect(r.claim.state).toMatchObject({ stage: "design", track: "design", designRevisions: 1, pr: null });
      expect(r.claim.state.designProblem).toMatch(/missing editor-empty\.png/);
    }, 60_000);
  });

  async function specRun(result: Scripted, over: RouteOver = {}, prepare?: (pair: ReturnType<typeof repoPair>, wt: string) => void) {
    const env = await setup(() => ({ spec: [result], fix: [] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } }, ...over }), prepare);
    const c = at(env.claim, { stage: "spec", track: "spec", specMode: "write" });
    await writeClaim(env.paths, c);
    return { ...env, r: await step(env.deps, c) };
  }
  const revised = (sha: string, extra: Record<string, unknown> = {}) => ({ verdict: "revised", spec_path: "specs/010-thing/spec.md", pr_number: 12, head_sha: sha, ...extra });

  it("fails a revised result whose spec_path leaves specs/ on the schema, without touching the issue body (review focus 4, D5)", async () => {
    const { r, gh, paths } = await specRun(revised("a".repeat(40), { spec_path: "specs/../docs/charter.md" }));
    expect(r.claim.state).toMatchObject({ stage: "spec", attempt: 2 });
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: invalid");
    const run = readdirSync(paths.runs).find((d) => d.startsWith("7-spec-1-"))!;
    expect(JSON.parse(readFileSync(join(paths.runs, run, "outcome.json"), "utf8")).resultErrors.join(" ")).toMatch(/spec_path.*pattern/);
    expect(gh.calls.some((x) => x.method === "PATCH" && x.url === "/repos/o/r/issues/7")).toBe(false);
  }, 60_000);

  it("fails a spec run returning the conversation shape with the same reason, not pr mismatch (spec 044 AC-3)", async () => {
    const { r, gh } = await specRun(settled);
    expect(r.claim.state).toMatchObject({ stage: "spec", attempt: 2 });
    expect(r.claim.state.history).toContain(`spec attempt 1 failed: result: invalid: ${outside}`);
    expect(r.claim.state.history).not.toContain("spec attempt 1 failed: result: pr mismatch");
    expect(gh.calls.some((x) => x.method === "PATCH" && x.url === "/repos/o/r/issues/7")).toBe(false);
  }, 60_000);

  it("fails a revised result whose spec_path differs from the Spec: line of a spec on main (AC-21, amended by spec 071 AC-2 item 2)", async () => {
    const { r } = await specRun((run: StageRun) => revised(head(run.worktree), { spec_path: "specs/011-other/spec.md" }));
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: the spec at specs/010-thing/spec.md is on main and cannot move");
  }, 60_000);

  it("fails a spec PR whose body closes an issue, by number, owner/repo#N or URL (AC-21, D8)", async () => {
    // A PR from issue-7 is not the spec PR (the spec stage binds to spec-7).
    const { r } = await specRun((run: StageRun) => revised(head(run.worktree)), { prs: { 12: { headRef: "issue-7" } } });
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: pr mismatch");
    let wt = "";
    const closes = await specRun((run: StageRun) => revised(head(run.worktree)), { prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Closes #7" } } }, (_p, w) => { wt = w; });
    expect(closes.r.claim.state.history).toContain("spec attempt 1 failed: result: spec PR body closes an issue");
    for (const body of ["Fixes o/r#7", "resolves https://github.com/o/r/issues/7", "Closed: #3"]) expect(CLOSING_KEYWORD.test(body)).toBe(true);
    for (const body of ["Refs #7", "Fixed the parser for #7's spec? no: refs only"]) expect(CLOSING_KEYWORD.test(body)).toBe(false);
  }, 60_000);

  it("hands a spec PR that touches the charter to the machine as a scope violation, and the fix is told to revert it (AC-22, AC-10)", async () => {
    let wt = "";
    const edit = (run: StageRun) => revised(commitIn(run.worktree, { "docs/charter.md": "changed\n", "specs/010-thing/notes.md": "n\n" }));
    const { r, deps, paths } = await specRun(edit, { prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } } }, (_p, w) => { wt = w; });
    expect(r.claim.state).toMatchObject({ stage: "fix", scopeViolations: 1 });
    expect(r.claim.state.pendingFixInput).toContain("docs/charter.md: the charter is never changed by a spec PR");
    await step(deps, r.claim);
    expect(inputOf(paths, "7-fix-").fix_input?.startsWith(`${CHARTER_REVERT_LINE}\n`)).toBe(true);
  }, 60_000);

  it("accepts a spec PR that lists its new sub-design in the top design's Children (spec 052 AC-4)", async () => {
    let wt = "";
    const top = "docs/delivery-system-design.md";
    const files = {
      ...withTopDesign({ "a.txt": "a\n" }, "specs/010-thing/spec.md"),
      [top]: "Parent: docs/charter.md\n\n## Children\n\n- `docs/designs/old.md`\n",
    };
    const edit = (run: StageRun) => revised(commitIn(run.worktree, {
      "specs/010-thing/spec.md": spec.replace(/^Parent:.*$/m, "Parent: docs/designs/new.md"),
      "docs/designs/new.md": "Parent: docs/delivery-system-design.md\n\n## Children\n\n- `specs/010-thing/spec.md`\n- planned: other\n",
      [top]: "Parent: docs/charter.md\n\n## Children\n\n- `docs/designs/old.md`\n- `docs/designs/new.md`\n",
    }));
    const env = await setup(() => ({ spec: [edit], fix: [] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } } }), (_p, w) => { wt = w; }, files);
    const c = at(env.claim, { stage: "spec", track: "spec", specMode: "write" });
    await writeClaim(env.paths, c);
    const r = await step(env.deps, c);
    expect(r.claim.state.stage).not.toBe("fix");
    expect(r.claim.state.pendingFixInput ?? "").not.toContain(top);
  }, 60_000);

  it("finds the top design by following Parent: lines, and none on a loop (spec 052 AC-4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "top-"));
    mkdirSync(join(dir, "docs", "designs"), { recursive: true });
    const put = (f: string, t: string) => writeFileSync(join(dir, f), t);
    put("docs/designs/inner.md", "Parent: docs/designs/outer.md\n");
    put("docs/designs/outer.md", "Parent: docs/delivery-system-design.md\n");
    put("docs/designs/a.md", "Parent: docs/designs/b.md\n");
    put("docs/designs/b.md", "Parent: docs/designs/a.md\n");
    expect(await designTop(dir, "docs/designs/inner.md")).toBe("docs/delivery-system-design.md");
    expect(await designTop(dir, "docs/designs/a.md")).toBeNull();
    expect(await designTop(dir, "docs/designs/missing.md")).toBeNull();
    expect(await designTop(dir, "docs/product-spec.md")).toBeNull();
  });

  it("appends the Spec: line to an issue body that has none (AC-21)", async () => {
    let wt = "";
    // Main holds specs/010, so the scheduler reserves 011 and the result takes it (spec 065 AC-3).
    const { gh, r } = await specRun((run: StageRun) => revised(commitIn(run.worktree, { "specs/011-thing/spec.md": spec }), { spec_path: "specs/011-thing/spec.md" }), { issueBody: "Do the thing.", prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } } }, (_p, w) => { wt = w; });
    expect(gh.calls.find((x) => x.method === "PATCH" && x.url === "/repos/o/r/issues/7")?.body).toEqual({ body: "Do the thing.\n\nSpec: specs/011-thing/spec.md" });
    expect(r.claim.state.reserved).toEqual({ spec: null, adr: null });
  }, 60_000);

  it("fails a spec PR recording a technical answer without its mark, and accepts it with the mark (AC-18)", async () => {
    let wt = "";
    const routes = { prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } } };
    const unmarked = await setup(() => ({ spec: [(run: StageRun) => revised(commitIn(run.worktree, { "specs/010-thing/spec.md": spec + "\nUse a.\n" })), (run: StageRun) => revised(commitIn(run.worktree, { "specs/010-thing/spec.md": spec + "\nUse a. (maintainer answer, question #555)\n" }))] }), (sha) => ghRoutes(sha, routes), (_p, w) => { wt = w; });
    const c = at(unmarked.claim, { stage: "spec", track: "spec", specMode: "write", answer: "use a", answerQuestionId: 555, answerQuestionIds: [555], answerKind: "technical", recordIds: [555], recordKind: "technical" });
    await writeClaim(unmarked.paths, c);
    const r = await step(unmarked.deps, c);
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: answer not marked");
    const r2 = await step(unmarked.deps, r.claim);
    expect(r2.claim.state.history.some((h) => h.includes("answer not marked") && h.startsWith("spec attempt 2"))).toBe(false);
    expect(r2.claim.state.stage).not.toBe("spec");
  }, 60_000);

  it("reviews a spec PR that touches a top design under the spec profile, then under the security profile; else under the spec profile only (AC-4, AC-21, C5)", async () => {
    const sensitive = await setup(() => ({ review: [approve, approve] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), (_p, wt) => {
      git(wt, "checkout", "-q", "-b", "spec-7");
      commitIn(wt, { "docs/delivery-system-design.md": "# Design\n" });
      git(wt, "push", "-q", "-u", "origin", "spec-7");
    });
    const c = at(sensitive.claim, { stage: "review", track: "spec", pr: { number: 12, head_sha: sensitive.sha } });
    await writeClaim(sensitive.paths, c);
    const first = await step(sensitive.deps, c);
    expect(inputOf(sensitive.paths, "7-review-").profile_instructions).toMatch(/^Spec profile\./);
    expect(first.claim.state).toMatchObject({ stage: "review", securityPass: true });
    const second = await step(sensitive.deps, first.claim);
    const reviews = readdirSync(sensitive.paths.runs).filter((d) => d.startsWith("7-review-")).sort();
    expect(reviews).toHaveLength(2);
    const profiles = reviews.map((d) => JSON.parse(readFileSync(join(sensitive.paths.runs, d, "input.json"), "utf8")).profile_instructions as string);
    expect(profiles.some((p) => p.startsWith("Security review profile."))).toBe(true);
    expect(profiles.some((p) => p.startsWith("Spec profile."))).toBe(true);
    expect(second.claim.state.stage).toBe("merge");

    const plain = await setup(() => ({ review: [approve] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7);
    const c2 = at(plain.claim, { stage: "review", track: "spec", pr: { number: 12, head_sha: plain.sha } });
    await writeClaim(plain.paths, c2);
    await step(plain.deps, c2);
    expect(inputOf(plain.paths, "7-review-").profile_instructions).toMatch(/^Spec profile\./);
  }, 60_000);

  it("saves spec-7's unpushed commits before a release without a spec PR deletes the branch (spec 005, AC-21)", async () => {
    const { deps, claim, gh, paths } = await setup(() => ({}), undefined, (_p, wt) => {
      git(wt, "checkout", "-q", "-b", "spec-7");
      commitIn(wt, { "specs/010-thing/draft.md": "draft\n" });
    });
    const c = at(claim, { stage: "spec", track: "spec", specMode: "write" });
    await writeClaim(paths, c);
    const { state, actions } = transition(c.state, { type: "liveness_expired" });
    await applyActions(deps, { ...c, state }, actions);
    expect(writes(gh)).toContain("DELETE /repos/o/r/git/refs/heads/spec-7");
    expect(git(claim.worktree, "branch", "--list", "spec-7").trim()).toBe("");
    const saved = readdirSync(paths.patches).filter((f) => f.includes("deleted-branch"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(paths.patches, saved[0]), "utf8")).toContain("draft.md");
  }, 60_000);

  it("a liveness release on the spec track closes spec PR 12 and deletes spec-7, and closes the parked issue PR too (AC-21)", async () => {
    const { deps, claim, gh, paths, sha } = await setup(() => ({}));
    const c = at(claim, { stage: "verify", track: "spec", pr: { number: 12, head_sha: sha }, parkedPr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    const { state, actions } = transition(c.state, { type: "liveness_expired" });
    expect(await applyActions(deps, { ...c, state }, actions)).toBe("ended");
    expect(writes(gh)).toEqual(expect.arrayContaining(["PATCH /repos/o/r/pulls/12", "DELETE /repos/o/r/git/refs/heads/spec-7", "PATCH /repos/o/r/pulls/9", "DELETE /repos/o/r/git/refs/heads/issue-7"]));
    expect(await readClaim(paths, 7)).toBeNull();
  }, 60_000);
});
describe("driver: a stage that asks a question keeps its work (spec 011)", () => {
  const prRoutes = (state: { pair?: ReturnType<typeof repoPair> }) => (sha: string): Route[] => [
    { method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: (_m, _b, url) => ({ body: url.searchParams.get("head") === "o:issue-7" && url.searchParams.get("state") === "open" ? [{ number: 9 }] : [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/, reply: (m) => { git(state.pair!.origin, "update-ref", "-d", `refs/heads/${decodeURIComponent(m[1])}`); return { status: 204, body: null }; } },
    ...ghRoutes(sha),
  ];
  const originHas = (pair: ReturnType<typeof repoPair>, branch: string) => git(pair.origin, "branch", "--list", branch).trim() !== "";
  const capability: Question = { ...Q, kind: "capability" };
  const logsOf = (deps: DriverDeps) => {
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    return logs;
  };

  it("saves a held patch, logs held-work and puts the head on the question-check state when implement asks after pushing (AC-1)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let pushed = "";
    const t = await setup(() => ({
      implement: [(run: StageRun) => { pushed = commitIn(run.worktree, { "work.txt": "w\n" }); git(run.worktree, "push", "-q", "origin", "issue-7"); return { escalation: capability }; }],
    }), prRoutes(state), (p) => { state.pair = p; });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never });
    await writeClaim(t.paths, c);
    const r = await step(t.deps, c);
    expect(r.claim.state).toMatchObject({ stage: "question-check", askingStage: "implement", heldWork: [{ branch: "issue-7", head: pushed }] });
    const saved = readdirSync(t.paths.patches).filter((f) => f.includes("held"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(t.paths.patches, saved[0]), "utf8")).toContain("work.txt");
    expect(logs).toContainEqual({ kind: "held-work", issue: 7, stage: "implement", branch: "issue-7", head: pushed, pushed: true, prs: [9], patch: join(t.paths.patches, saved[0]) });
  }, 60_000);

  it("writes no held patch when the asking stage committed nothing (AC-1)", async () => {
    const t = await setup(() => ({ plan: [{ escalation: capability }] }));
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "plan" });
    await writeClaim(t.paths, c);
    const r = await step(t.deps, c);
    expect(r.claim.state.heldWork).toEqual([{ branch: "issue-7", head: head(t.claim.worktree) }]);
    expect(readdirSync(t.paths.patches)).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "held-work", stage: "plan", pushed: false, patch: null }));
  }, 60_000);

  it("leaves the pushed branch, its open PR and HEAD alone when the question check is prepared (AC-2)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    const t = await setup(() => ({ "question-check": [{ verdict: "decide_yourself", reasoning: "r" }] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "question-check", question: capability, askingStage: "implement", heldWork: [{ branch: "issue-7", head: held }] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    expect(originHas(state.pair!, "issue-7")).toBe(true);
    expect(writes(t.gh).filter((w) => w.startsWith("PATCH") || w.startsWith("DELETE"))).toEqual([]);
    expect(logs.find((r) => r.kind === "recovered-commits" || r.kind === "stale-branch-dropped")).toBeUndefined();
    expect(logs).toContainEqual({ kind: "held-work-kept", issue: 7, branch: "issue-7", head: held });
    expect(readdirSync(t.paths.patches)).toEqual([]);
  }, 60_000);

  it("tells the resumed implement about the work, and not the question check (AC-4)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    const t = await setup(() => ({ "question-check": [{ verdict: "decide_yourself", reasoning: "r" }], implement: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const heldWork = () => [{ branch: "issue-7", head: held }];
    const qc = at(t.claim, { stage: "question-check", question: capability, askingStage: "implement", heldWork: heldWork(), plan: plan as never });
    await writeClaim(t.paths, qc);
    await step(t.deps, qc);
    expect(inputOf(t.paths, "7-question-check-").held_work).toBeUndefined();
    const im = at(t.claim, { stage: "implement", plan: plan as never, heldWork: heldWork() });
    await writeClaim(t.paths, im);
    await step(t.deps, im);
    const text = inputOf(t.paths, "7-implement-").held_work!;
    expect(text).toContain("issue-7");
    expect(text).toContain(held);
    expect(text).toContain("on origin");
    expect(text).toContain("#9");
    expect(t.adapter.heads).toEqual(["issue-7", "issue-7"]);
    expect(head(t.claim.worktree)).toBe(held);
  }, 60_000);

  it("puts a lost worktree back at the held head from the object store, or from origin (AC-5)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    const t = await setup(() => ({ implement: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "reset", "-q", "--hard", "origin/main");
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [{ branch: "issue-7", head: held }] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    expect(logs).toContainEqual({ kind: "held-work-restored", issue: 7, branch: "issue-7", head: held, source: "local", patch: null });

    // The commit exists nowhere in this repository, but the branch is on origin.
    const lost = "1".repeat(40);
    const scratch = join(state.pair!.root, "scratch");
    git(state.pair!.root, "clone", "-q", state.pair!.origin, scratch);
    git(scratch, "checkout", "-q", "-b", "issue-7");
    const remoteHead = commitIn(scratch, { "other.txt": "o\n" });
    git(scratch, "push", "-q", "origin", "issue-7");
    git(t.claim.worktree, "checkout", "-q", "--detach", "origin/main");
    git(t.claim.worktree, "branch", "-D", "issue-7");
    const again = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [{ branch: "issue-7", head: lost }] });
    await writeClaim(t.paths, again);
    const r = await step(t.deps, again);
    expect(head(t.claim.worktree)).toBe(remoteHead);
    expect(logs).toContainEqual({ kind: "held-work-restored", issue: 7, branch: "issue-7", head: remoteHead, source: "origin" });
    expect(r.claim.state.heldWork).toEqual([{ branch: "issue-7", head: remoteHead, carried: "exit 1" }]);
  }, 60_000);

  it("logs held-work-lost, clears the held work and prepares as without it when the commit is nowhere (AC-5)", async () => {
    const t = await setup(() => ({ implement: [] }));
    const logs = logsOf(t.deps);
    const lost = "1".repeat(40);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [{ branch: "issue-7", head: lost }] });
    await writeClaim(t.paths, c);
    const r = await step(t.deps, c);
    expect(logs).toContainEqual({ kind: "held-work-lost", issue: 7, branch: "issue-7", head: lost });
    expect(r.claim.state.heldWork).toEqual([]);
    expect(head(t.claim.worktree)).toBe(git(t.pair.repo, "rev-parse", "origin/main").trim());
  }, 60_000);

  it("keeps commits the resumed stage added on top of the held head, and advances the held head to them (AC-2)", async () => {
    let held = "";
    let added = "";
    const t = await setup(() => ({ implement: [] }), (sha) => ghRoutes(sha), (_p, wt) => {
      held = commitIn(wt, { "work.txt": "w\n" });
      added = commitIn(wt, { "more.txt": "m\n" });
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [{ branch: "issue-7", head: held }] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(added);
    expect(logs).toContainEqual({ kind: "held-work-advanced", issue: 7, branch: "issue-7", from: held, to: added });
    expect(inputOf(t.paths, "7-implement-").held_work).toContain(added);
    // The scripted run then fails: the stopped run saves its work as one held patch (spec 053 AC-1), and nothing else is patched.
    expect(readdirSync(t.paths.patches).filter((f) => !f.includes("held"))).toEqual([]);
  }, 60_000);

  it("leaves main's commits out of the held-diverged patch when the diverged branch sits on a moved main (AC-5)", async () => {
    let held = "";
    const t = await setup(() => ({ implement: [] }), (sha) => ghRoutes(sha), (p, wt) => {
      held = commitIn(wt, { "work.txt": "w\n" });
      writeFileSync(join(p.repo, "main.txt"), "main moved\n");
      git(p.repo, "add", "main.txt");
      git(p.repo, "commit", "-q", "-m", "main moved");
      git(p.repo, "push", "-q", "origin", "main");
      git(wt, "fetch", "-q", "origin");
      git(wt, "reset", "-q", "--hard", "origin/main");
      commitIn(wt, { "other.txt": "o\n" }, "own");
    });
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [{ branch: "issue-7", head: held }] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    const saved = readdirSync(t.paths.patches).filter((f) => f.includes("held-diverged"));
    expect(saved).toHaveLength(1);
    const text = readFileSync(join(t.paths.patches, saved[0]), "utf8");
    expect(text).toContain("other.txt");
    expect(text).not.toContain("main.txt");
  }, 60_000);

  it("saves a held-diverged patch of the local branch's own commits before putting it back at the held head (AC-5)", async () => {
    let held = "";
    const t = await setup(() => ({ implement: [] }), (sha) => ghRoutes(sha), (_p, wt) => {
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "reset", "-q", "--hard", "origin/main");
      commitIn(wt, { "other.txt": "o\n" });
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [{ branch: "issue-7", head: held }] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    const saved = readdirSync(t.paths.patches).filter((f) => f.includes("held-diverged"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(t.paths.patches, saved[0]), "utf8")).toContain("other.txt");
    expect(logs).toContainEqual(expect.objectContaining({ kind: "held-work-restored", source: "local", head: held, patch: join(t.paths.patches, saved[0]) }));
  }, 60_000);

  it("with a PR bound, keeps an unpushed held commit on the remote head and does not rebase it away (AC-2)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let remote = "";
    let held = "";
    const t = await setup(() => ({ fix: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      remote = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
      held = commitIn(wt, { "fix.txt": "f\n" });
    });
    // main moves on, so a rebase would rewrite the held commit.
    const scratch = join(t.pair.root, "scratch");
    git(t.pair.root, "clone", "-q", t.pair.origin, scratch);
    commitIn(scratch, { "main.txt": "m\n" });
    git(scratch, "push", "-q", "origin", "HEAD:main");
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: remote }, pendingFixInput: "x", heldWork: [{ branch: "issue-7", head: held }] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    expect(logs.find((r) => r.kind === "worktree-synced")).toBeUndefined();
    expect(logs).toContainEqual({ kind: "held-work-kept", issue: 7, branch: "issue-7", head: held });
    expect(inputOf(t.paths, "7-fix-").held_work).toContain(held);
  }, 60_000);

  it("with a PR bound, a held head the remote diverged from is dropped as today, and the stage is not told it is there (AC-5)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    let remote = "";
    const t = await setup(() => ({ fix: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
      held = commitIn(wt, { "fix.txt": "f\n" });
    });
    const scratch = join(t.pair.root, "scratch");
    git(t.pair.root, "clone", "-q", "-b", "issue-7", t.pair.origin, scratch);
    remote = commitIn(scratch, { "elsewhere.txt": "e\n" });
    git(scratch, "push", "-q", "origin", "issue-7");
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: remote }, pendingFixInput: "x", heldWork: [{ branch: "issue-7", head: held }] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "worktree-synced", dropped: held }));
    expect(logs).toContainEqual({ kind: "held-work-lost", issue: 7, branch: "issue-7", head: held });
    expect(inputOf(t.paths, "7-fix-").held_work).toBeUndefined();
  }, 60_000);

  it("says unknown, not 'not on origin' or '(none)', when the branch and PR lookups fail (AC-4)", async () => {
    let held = "";
    const failing = (sha: string): Route[] => [{ method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: (_m, _b, url) => url.searchParams.has("head") ? { status: 422, body: { message: "lookup failed" } } : { body: [] } }, ...ghRoutes(sha)];
    const t = await setup(() => ({ implement: [] }), failing, (_p, wt) => { held = commitIn(wt, { "work.txt": "w\n" }); });
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [{ branch: "issue-7", head: held }] });
    await writeClaim(t.paths, c);
    t.deps.fetchOrigin = async () => {};
    git(t.claim.worktree, "remote", "set-url", "origin", join(t.pair.root, "nonexistent.git"));
    try {
      await step(t.deps, c);
    } finally {
      git(t.claim.worktree, "remote", "set-url", "origin", t.pair.origin);
    }
    const text = inputOf(t.paths, "7-implement-").held_work!;
    expect(text).toContain(held);
    expect(text).toMatch(/on origin: unknown/);
    expect(text).toMatch(/pull requests from it: unknown/i);
    expect(text).not.toContain("not on origin");
    expect(text).not.toContain("(none)");
  }, 60_000);

  it("a recorded escalation checked again after the step threw saves one held patch and logs held-work once (AC-1, spec 015 AC-10)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    const t = await setup(() => ({
      implement: [(run: StageRun) => { commitIn(run.worktree, { "work.txt": "w\n" }); return { escalation: capability }; }],
    }), prRoutes(state), (p) => { state.pair = p; });
    const logs: Record<string, unknown>[] = [];
    let failures = 1;
    t.deps.log = (r) => {
      logs.push(r);
      if (r.kind === "transition" && failures-- > 0) throw new Error("getaddrinfo EAI_AGAIN api.github.com");
    };
    const c = at(t.claim, { stage: "implement", plan: plan as never });
    await writeClaim(t.paths, c);
    await expect(step(t.deps, c)).rejects.toThrow(/EAI_AGAIN/);
    const kept = (await readClaim(t.paths, 7))!;
    expect(kept.stageRun?.stage).toBe("implement");
    const r = await step(t.deps, kept);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "stage-result-kept", stage: "implement" }));
    expect(r.claim.state).toMatchObject({ stage: "question-check", heldWork: [{ branch: "issue-7" }] });
    expect(readdirSync(t.paths.patches).filter((f) => f.includes("held"))).toHaveLength(1);
    expect(logs.filter((l) => l.kind === "held-work")).toHaveLength(1);
  }, 60_000);

  it("a network failure fetching the held branch fails the step and keeps the held work untouched (AC-5)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    const t = await setup(() => ({ implement: [] }), prRoutes(state), (p) => { state.pair = p; });
    const logs = logsOf(t.deps);
    const scratch = join(t.pair.root, "scratch");
    git(t.pair.root, "clone", "-q", t.pair.origin, scratch);
    git(scratch, "checkout", "-q", "-b", "issue-7");
    const remoteHead = commitIn(scratch, { "other.txt": "o\n" });
    git(scratch, "push", "-q", "origin", "issue-7");
    const lost = "1".repeat(40);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [{ branch: "issue-7", head: lost }] });
    await writeClaim(t.paths, c);
    // The service's own fetch got through; the branch fetch then hits the outage.
    t.deps.fetchOrigin = async () => {};
    git(t.claim.worktree, "remote", "set-url", "origin", join(t.pair.root, "nonexistent.git"));
    try {
      await expect(step(t.deps, c)).rejects.toThrow();
    } finally {
      git(t.claim.worktree, "remote", "set-url", "origin", t.pair.origin);
    }
    expect(logs.find((r) => r.kind === "held-work-lost")).toBeUndefined();
    expect(logs.find((r) => r.kind === "stale-branch-dropped")).toBeUndefined();
    expect((await readClaim(t.paths, 7))?.state.heldWork).toEqual([{ branch: "issue-7", head: lost }]);
    expect(git(t.pair.origin, "rev-parse", "refs/heads/issue-7").trim()).toBe(remoteHead);
  }, 60_000);

  it("runs as without held work when the held head is already on main (AC-5)", async () => {
    const t = await setup(() => ({ implement: [] }));
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [{ branch: "issue-7", head: head(t.claim.worktree) }] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(logs.find((r) => r.kind === "held-work-kept")).toBeUndefined();
  }, 60_000);

  it("keeps issue-7 locally and on origin while the spec track records an answer, and delete_branch puts the worktree back on it (AC-6)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    const t = await setup(() => ({ spec: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const logs = logsOf(t.deps);
    const heldWork = [{ branch: "issue-7", head: held }];
    const c = at(t.claim, { stage: "spec", track: "spec", specMode: "record", heldWork });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(t.adapter.heads).toEqual(["spec-7"]);
    expect(logs.find((r) => r.kind === "recovered-commits" || r.kind === "stale-branch-dropped")).toBeUndefined();
    expect(originHas(state.pair!, "issue-7")).toBe(true);
    expect(git(t.claim.worktree, "rev-parse", "issue-7").trim()).toBe(held);
    expect(head(t.claim.worktree)).toBe(git(state.pair!.repo, "rev-parse", "origin/main").trim());

    await applyActions(t.deps, at(t.claim, { track: "issue", heldWork }), [{ type: "delete_branch", branch: "spec-7" }]);
    expect(branchIn(t.claim.worktree)).toBe("issue-7");
    expect(head(t.claim.worktree)).toBe(held);
  }, 60_000);

  it("with holds on issue-7 and spec-7, the spec track keeps spec-7 and leaves issue-7 alone (spec 040 AC-5)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let issueHead = "";
    let specHead = "";
    const t = await setup(() => ({ spec: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      issueHead = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
      git(wt, "checkout", "-q", "-b", "spec-7", "origin/main");
      specHead = commitIn(wt, { "spec.txt": "s\n" });
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "spec", track: "spec", specMode: "record", heldWork: [{ branch: "issue-7", head: issueHead }, { branch: "spec-7", head: specHead }] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(logs).toContainEqual({ kind: "held-work-kept", issue: 7, branch: "spec-7", head: specHead });
    expect(logs.find((r) => r.kind === "recovered-commits" || r.kind === "stale-branch-dropped")).toBeUndefined();
    expect(inputOf(t.paths, "7-spec-").held_work).toContain("spec-7");
    expect(inputOf(t.paths, "7-spec-").held_work).toContain(specHead);
    expect(inputOf(t.paths, "7-spec-").held_work).not.toContain("issue-7");
    expect(t.adapter.heads).toEqual(["spec-7"]);
    expect(head(t.claim.worktree)).toBe(specHead);
    expect(originHas(state.pair!, "issue-7")).toBe(true);
    expect(git(t.claim.worktree, "rev-parse", "issue-7").trim()).toBe(issueHead);
    expect(readdirSync(t.paths.patches)).toEqual([]);
  }, 60_000);

  it("a spec-7 hold the preparation cannot keep is removed alone (spec 040 AC-5)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let issueHead = "";
    const t = await setup(() => ({ spec: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      issueHead = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const logs = logsOf(t.deps);
    const lost = "1".repeat(40);
    const c = at(t.claim, { stage: "spec", track: "spec", specMode: "record", heldWork: [{ branch: "issue-7", head: issueHead }, { branch: "spec-7", head: lost }] });
    await writeClaim(t.paths, c);
    const r = await step(t.deps, c);
    expect(logs).toContainEqual({ kind: "held-work-lost", issue: 7, branch: "spec-7", head: lost });
    expect(r.claim.state.heldWork).toEqual([{ branch: "issue-7", head: issueHead }]);
    expect(logs.find((l) => l.kind === "recovered-commits" || l.kind === "stale-branch-dropped")).toBeUndefined();
    expect(originHas(state.pair!, "issue-7")).toBe(true);
  }, 60_000);

  it("delete_branch reads the issue-7 hold wherever it sits in the list, and resets without one (spec 040 AC-6)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    const t = await setup(() => ({ spec: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const logs = logsOf(t.deps);
    const main = git(state.pair!.repo, "rev-parse", "origin/main").trim();
    const issueHold = { branch: "issue-7", head: held };
    const cases: [string, { branch: string; head: string }[], string][] = [
      ["second", [{ branch: "spec-7", head: "2".repeat(40) }, issueHold], held],
      ["only", [issueHold], held],
      ["none", [{ branch: "spec-7", head: "2".repeat(40) }], main],
    ];
    for (const [name, heldWork, expected] of cases) {
      await applyActions(t.deps, at(t.claim, { track: "issue", heldWork }), [{ type: "delete_branch", branch: "spec-7" }]);
      expect(branchIn(t.claim.worktree), name).toBe("issue-7");
      expect(head(t.claim.worktree), name).toBe(expected);
      if (expected === held) expect(logs, name).toContainEqual({ kind: "held-work-kept", issue: 7, branch: "issue-7", head: held });
      git(t.claim.worktree, "checkout", "-q", "-B", "issue-7", held);
    }
  }, 60_000);

  it("still drops the stale branch and resets when there is no held work (AC-8)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    const t = await setup(() => ({ implement: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: [] });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(logs.map((r) => r.kind)).toEqual(expect.arrayContaining(["recovered-commits", "stale-branch-dropped"]));
    expect(originHas(state.pair!, "issue-7")).toBe(false);
    expect(head(t.claim.worktree)).toBe(git(state.pair!.repo, "rev-parse", "origin/main").trim());
  }, 60_000);

  describe("an implement run stopped before it finished keeps its work (spec 053)", () => {
    it("saves a held patch, logs held-work with carried and puts the head on the event (AC-1)", async () => {
      const state: { pair?: ReturnType<typeof repoPair> } = {};
      let pushed = "";
      const t = await setup(() => ({
        implement: [(run: StageRun) => { pushed = commitIn(run.worktree, { "work.txt": "w\n" }); git(run.worktree, "push", "-q", "origin", "issue-7"); return undefined; }],
      }), prRoutes(state), (p) => { state.pair = p; });
      const logs = logsOf(t.deps);
      const c = at(t.claim, { stage: "implement", plan: plan as never });
      await writeClaim(t.paths, c);
      const r = await step(t.deps, c);
      expect(r.claim.state).toMatchObject({ stage: "implement", attempt: 2, heldWork: [{ branch: "issue-7", head: pushed, carried: "exit 1" }] });
      const saved = readdirSync(t.paths.patches).filter((f) => f.includes("held"));
      expect(saved).toHaveLength(1);
      expect(readFileSync(join(t.paths.patches, saved[0]), "utf8")).toContain("work.txt");
      expect(logs).toContainEqual({ kind: "held-work", issue: 7, stage: "implement", branch: "issue-7", head: pushed, pushed: true, prs: [9], patch: join(t.paths.patches, saved[0]), carried: "exit 1" });
    }, 60_000);

    it("a stopped run that committed nothing carries nothing and logs nothing (AC-1)", async () => {
      const t = await setup(() => ({ implement: [undefined] }));
      const logs = logsOf(t.deps);
      const c = at(t.claim, { stage: "implement", plan: plan as never });
      await writeClaim(t.paths, c);
      const r = await step(t.deps, c);
      expect(r.claim.state).toMatchObject({ stage: "implement", attempt: 2, heldWork: [] });
      expect(logs.find((l) => l.kind === "held-work")).toBeUndefined();
      expect(readdirSync(t.paths.patches).filter((f) => f.includes("held"))).toEqual([]);
    }, 60_000);

    it("a run that finished with an invalid result is a wrong attempt: nothing is carried (AC-1)", async () => {
      const t = await setup(() => ({ implement: [(run: StageRun) => { commitIn(run.worktree, { "work.txt": "w\n" }); return {}; }] }));
      const logs = logsOf(t.deps);
      const c = at(t.claim, { stage: "implement", plan: plan as never });
      await writeClaim(t.paths, c);
      const r = await step(t.deps, c);
      expect(r.claim.state).toMatchObject({ stage: "implement", attempt: 2, heldWork: [] });
      expect(logs.find((l) => l.kind === "held-work")).toBeUndefined();
    }, 60_000);

    it("the retry continues from the carried head, leaves the branch and its PR, and is told (AC-2, AC-4)", async () => {
      const state: { pair?: ReturnType<typeof repoPair> } = {};
      let held = "";
      const t = await setup(() => ({ implement: [] }), prRoutes(state), (p, wt) => {
        state.pair = p;
        held = commitIn(wt, { "work.txt": "w\n" });
        git(wt, "push", "-q", "origin", "issue-7");
      });
      const logs = logsOf(t.deps);
      const c = at(t.claim, { stage: "implement", attempt: 2, implementFailures: 1, plan: plan as never, heldWork: [{ branch: "issue-7", head: held, carried: "max budget reached" }] });
      await writeClaim(t.paths, c);
      await step(t.deps, c);
      expect(t.adapter.heads).toEqual(["issue-7"]);
      expect(head(t.claim.worktree)).toBe(held);
      expect(originHas(state.pair!, "issue-7")).toBe(true);
      expect(writes(t.gh).filter((w) => w.startsWith("PATCH") || w.startsWith("DELETE"))).toEqual([]);
      expect(logs.find((r) => r.kind === "recovered-commits" || r.kind === "stale-branch-dropped")).toBeUndefined();
      expect(logs).toContainEqual({ kind: "held-work-kept", issue: 7, branch: "issue-7", head: held });
      const text = inputOf(t.paths, "7-implement-").held_work!;
      expect(text).toContain(held);
      expect(text).toContain("on origin");
      expect(text).toContain("#9");
      expect(text).toContain("max budget reached");
      expect(text).toMatch(/earlier attempt/);
      expect(text).toMatch(/stopped before it finished/);
      expect(text).not.toMatch(/before your question/);
    }, 60_000);
  });
});
describe("driver: a rebase respects merged main (spec 024)", () => {
  const fixInputs = (paths: ReturnType<typeof statePaths>) => readdirSync(paths.runs).filter((d) => d.startsWith("7-fix-")).sort()
    .map((d) => JSON.parse(readFileSync(join(paths.runs, d, "input.json"), "utf8")).fix_input as string);

  it("a branch that merged main runs its review on the same head, with no conflict raised (AC-1; PR #77)", async () => {
    const { deps, claim, adapter, sha } = await setup(() => ({ review: [approve] }), undefined, (pair, wt) => { conflicting(pair, wt); mergeMainResolved(wt); });
    const atReview: Claim = { ...claim, state: { ...claim.state, stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } } };
    const r = await step(deps, atReview);
    expect(adapter.ran).toEqual(["review:claude-fable-5-2"]);
    expect(r.claim.state).toMatchObject({ stage: "merge", fixes: 0, conflictPending: false, history: [] });
    expect(head(claim.worktree)).toBe(sha);
  }, 60_000);

  it("a fix that returns the unchanged head fails, a rescue is told the real state, and a second one closes the PR (AC-3, AC-5; PR #77)", async () => {
    const unchanged = (sha: string) => ({ head_sha: sha, addressed: [0, 1] });
    const { deps, claim, adapter, paths, sha } = await setup((sha) => ({ fix: [unchanged(sha), unchanged(sha)] }), undefined, conflicting);
    const atReview: Claim = { ...claim, state: { ...claim.state, stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } } };
    let r = await step(deps, atReview);
    expect(r.claim.state).toMatchObject({ stage: "fix", conflictPending: true });
    expect(r.claim.state.history.at(-1)).toMatch(/origin\/main conflicted before review[\s\S]*CONFLICT/);
    r = await step(deps, r.claim);
    expect(r.claim.state).toMatchObject({ stage: "fix", fixes: 0, conflictPending: true, rescues: 1, rescueRun: true });
    r = await step(deps, r.claim);
    expect(adapter.ran).toHaveLength(2);
    expect(fixInputs(paths)[1]).toMatch(/unchanged/);
    expect(fixInputs(paths)[1]).toContain(sha);
    expect(r.claim.state).toMatchObject({ stage: "plan", replans: 1, pr: null, conflictPending: false });
  }, 60_000);

  it("a branch holding a merge with a real conflict is told to merge, not rebase, and its merge survives (AC-2, AC-3)", async () => {
    let wtPath = "";
    const resolve = (run: StageRun) => { mergeMainResolved(run.worktree); return { head_sha: head(run.worktree), addressed: [] }; };
    const { deps, claim, adapter, paths, sha } = await setup(() => ({ fix: [resolve], review: [approve] }), (sha) => ghRoutes(sha, { prs: { 9: { head: () => head(wtPath) } } }), (pair, wt) => {
      wtPath = wt;
      conflicting(pair, wt);
      mergeMainResolved(wt);
      writeFileSync(join(pair.repo, "a.txt"), "main again\n");
      git(pair.repo, "commit", "-q", "-am", "main again");
      git(pair.repo, "push", "-q", "origin", "main");
    });
    const atReview: Claim = { ...claim, state: { ...claim.state, stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } } };
    let r = await step(deps, atReview);
    expect(r.claim.state).toMatchObject({ stage: "fix", conflictPending: true });
    expect(head(claim.worktree)).toBe(sha);
    r = await step(deps, r.claim);
    const [input] = fixInputs(paths);
    expect(input).toMatch(/^Bring this branch up to date with origin\/main/);
    expect(input).not.toMatch(/rebase this branch|rebase onto/i);
    expect(input).toMatch(/merge origin\/main into it rather than rebasing/);
    expect(r.claim.state).toMatchObject({ stage: "verify", fixes: 1, conflictPending: false });
    expect((await steps(deps, r.claim, 2)).state.stage).toBe("merge");
    expect(adapter.ran).toEqual(["fix:claude-sonnet-5-5", "review:claude-fable-5-2"]);
    expect(git(claim.worktree, "rev-list", "--merges", "--count", "origin/main..HEAD").trim()).toBe("2");
  }, 60_000);

  it("a conflict pending on a head that already holds main runs no agent and goes to verify (AC-4)", async () => {
    const { deps, claim, adapter, sha } = await setup(() => ({}), undefined, (pair, wt) => { conflicting(pair, wt); mergeMainResolved(wt); });
    const atFix: Claim = { ...claim, state: { ...claim.state, stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, conflictPending: true, pendingFixInput: "Rebase onto main conflicted:\nCONFLICT a.txt" } };
    const r = await step(deps, atFix);
    expect(adapter.ran).toEqual([]);
    expect(r.claim.state).toMatchObject({ stage: "verify", conflictPending: false, fixes: 1 });
    expect(head(claim.worktree)).toBe(sha);
  }, 60_000);

  it("a conflict pending that no longer conflicts leaves no unpushed rebase behind (AC-4)", async () => {
    const { deps, claim, adapter, sha } = await setup(() => ({}), undefined, prBehindMain);
    const atFix: Claim = { ...claim, state: { ...claim.state, stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, conflictPending: true, pendingFixInput: "stale" } };
    const r = await step(deps, atFix);
    expect(adapter.ran).toEqual([]);
    expect(r.claim.state).toMatchObject({ stage: "verify", conflictPending: false });
    expect(head(claim.worktree)).toBe(sha);
  }, 60_000);

  it("a conflict still real is left to the fix agent, with the worktree where the sync put it (AC-4, C1)", async () => {
    const { deps, claim, adapter, sha } = await setup((sha) => ({ fix: [{ head_sha: sha, addressed: [] }] }), undefined, conflicting);
    const atFix: Claim = { ...claim, state: { ...claim.state, stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, conflictPending: true, pendingFixInput: "Rebase onto main conflicted:\nCONFLICT a.txt" } };
    await step(deps, atFix);
    expect(adapter.ran).toEqual(["fix:claude-sonnet-5-5"]);
    expect(git(claim.worktree, "status", "--porcelain").trim()).toBe("");
    expect(head(claim.worktree)).toBe(sha);
  }, 60_000);
});
