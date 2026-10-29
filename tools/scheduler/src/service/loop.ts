import {TelegramAnswers} from '../telegram/answers.ts';
import {questionMessage,reminderText} from '../telegram/questions.ts';
import { applyActions, sendPausedQuestion, completePause, driveChain as defaultDriveChain, step, type DriverDeps } from "../chain/driver.ts";
import { CLAIM_LABEL, ENDED, HISTORY_ENTRY_MAX, NEEDS_DECISION_LABEL, initialChainState, ledgerOf, stuckOf as stuckStage, transition } from "../chain/machine.ts";
import {emit} from '../standing/events.ts';
import { appendFindings, onFindingsQueued } from "../state/findings.ts";
import { livenessGate } from "../gates/index.ts";
import { ensureWorktree, uncommittedPatch } from "../runner/worktree.ts";
import { buildSelectContext } from "../shortlist/fetch.ts";
import {initializeAgents,readAgentState} from '../standing/state.ts';
import {runStandingAgent} from '../standing/run.ts';
import type {StandingDefinition} from '../types.ts';
import type {ParameterStore} from '../parameters/store.ts';
import {watchMainChecks} from '../standing/events.ts';
import {execFileSync} from 'node:child_process';
import { rankIssues, classifyWork } from "../shortlist/rank.ts";
import { selectEligible } from "../shortlist/select.ts";
import { listClaims, readClaim, removeClaim, writeClaim, type Claim } from "../state/claims.ts";
import { readLedger, writeLedger } from "../state/ledger.ts";
import { listPaused, pausedDecision, removePaused, writePaused, type PausedRecord } from "../state/paused.ts";
import { answeredEntry, appendQuestionLog } from "../state/questions.ts";
import { recentMerges } from "../state/merges.ts";
import { savePatch } from "../state/patches.ts";
import { pruneUsage } from "../state/runs.ts";
import { readToken } from "../state/token.ts";
import type { SleepInhibitor } from "./inhibit.ts";
import type { ServiceLog } from "./log.ts";
import { schedulerChanged } from "./git.ts";

export interface SchedulerDeps extends DriverDeps {
  registry?:Record<string,StandingDefinition>;
  parameters?:ParameterStore;
  runStanding?:typeof runStandingAgent;
  botLogin: string;
  serviceLog: ServiceLog;
  inhibitor: SleepInhibitor;
  fastForward: () => Promise<{ moved: boolean; changedPaths: string[] }>;
  sleep: (ms: number) => Promise<void>;
  monotonic: () => number;
  requestRestart: () => void;
  /** I3: rewrites token.json now; the 50-minute timer does not fire across a laptop sleep. */
  refreshToken?: () => Promise<void>;
}

/** I3: a token this close to expiry is refreshed at the start of a tick. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export interface TickInfo {
  eligible: number;
  claimed: number[];
  released: number[];
  /** Claims holding a slot this tick (spec 009): every claim on disk whose issue is not paused. */
  held: number;
  /** Standing agents started this tick (spec 016). */
  standing: string[];
  errors: string[];
  restartPending: boolean;
}

/**
 * Ruling 7b, C7: a chain whose driveChain rejects this many times in a row gets a `chain_error` event (a release with the
 * error, then abandonment); a claim carrying pending work that fails this often is reported once.
 */
export const MAX_CHAIN_FAILURES = 3;

type DriveFn = (deps: DriverDeps, claim: Claim, isStopping: () => boolean) => Promise<Claim>;

/** A claim whose next step applies a resume's answer or finishes an abandonment: only the driver finishes it, never liveness. */
const carriesPending = (c: Claim): boolean => c.pendingEvent !== undefined || Boolean(c.pendingActions?.length);
/** `liveness_expired` is valid only in a stage the chain is still working in. */
const expirable = (c: Claim): boolean => !carriesPending(c) && !ENDED.includes(c.state.stage);

export class Scheduler {
  #deps: SchedulerDeps;
  #drive: DriveFn;
  #active = new Map<number, Promise<void>>();
  #activeStanding = new Map<string,Promise<void>>();
  #stopping = false;
  #stopReason = "";
  #ticking = false;
  #restartPending = false;
  /** Spec 016: the kind of the last running slot granted; a standing agent goes first after a start. */
  #lastGrant: "standing" | "chain" = "chain";
  #questionOperation:Promise<unknown>=Promise.resolve();
  #serializeQuestions<T>(fn:()=>Promise<T>):Promise<T>{const p=this.#questionOperation.then(fn);this.#questionOperation=p.catch(()=>{});return p;}
  #wakeRequested=false;
  #wakeSleep:(()=>void)|null=null;
  telegramAnswers:TelegramAnswers;
  wake():void{this.#wakeRequested=true;this.#wakeSleep?.();}
  handleTelegramUpdate(u:import('../telegram/client.ts').TelegramUpdate){return this.#serializeQuestions(()=>this.telegramAnswers.handle(u));}
  confirmTelegramUpdate(u:import('../telegram/client.ts').TelegramUpdate){return this.#serializeQuestions(()=>this.telegramAnswers.confirmed(u));}

  constructor(deps: SchedulerDeps, opts: { driveChain?: DriveFn } = {}) {
    this.#deps = deps;
    this.telegramAnswers=new TelegramAnswers(deps,()=>this.wake());
    if(deps.registry) {
      deps.emitEvent ??= (event,payload)=>emit(deps.paths,deps.registry!,event,payload,deps.now());
      onFindingsQueued(deps.paths,(count,offset)=>deps.emitEvent!('finding_queued',{count,offset}));
    }
    this.#drive = opts.driveChain ?? defaultDriveChain;
  }

  get active(): number {
    return this.#active.size + this.#activeStanding.size;
  }

  stop(reason: string): void {
    this.#stopping = true;
    this.#stopReason = reason;
    this.wake();
  }

  #start(claim: Claim): void {
    if (this.#active.has(claim.issue)) return;
    const d = this.#deps;
    d.inhibitor.acquire();
    const p = this.#drive(d, claim, () => this.#stopping)
      .then(() => this.#countFailure(claim.issue, null))
      .catch(async (e) => {
        d.log({ kind: "error", issue: claim.issue, error: (e as Error).message });
        await this.#countFailure(claim.issue, (e as Error).message);
      })
      .catch((e) => d.log({ kind: "error", issue: claim.issue, error: `failure count: ${(e as Error).message}` }))
      .finally(() => {
        this.#active.delete(claim.issue);
        if(d.telegram)this.wake();
        if (this.active === 0) {
          d.inhibitor.release();
          // Mid-tick, the tick's own finally requests the restart once it is done.
          if (this.#restartPending && !this.#ticking) d.requestRestart();
        }
      });
    this.#active.set(claim.issue, p);
  }

  /**
   * C7: the consecutive driver errors live in the claim's state and the ledger, so a restart keeps them. `error` null
   * (a drive that returned) resets them. A claim carrying pending work is never expired; it is reported once instead.
   */
  async #countFailure(issue: number, error: string | null): Promise<void> {
    const d = this.#deps;
    const claim = await readClaim(d.paths, issue);
    if (!claim) return;
    const before = claim.state.chainFailures;
    if (error === null && before === null) return;
    const chainFailures = error === null ? null : { count: (before?.count ?? 0) + 1, last: error.slice(0, HISTORY_ENTRY_MAX) };
    const state = { ...claim.state, chainFailures };
    await writeClaim(d.paths, { ...claim, state });
    await writeLedger(d.paths, issue, ledgerOf(state));
    if (chainFailures?.count === MAX_CHAIN_FAILURES && carriesPending(claim)) {
      const text = `Issue #${issue}: the scheduler failed ${MAX_CHAIN_FAILURES} times in a row finishing work it must not drop (${claim.pendingEvent ? `the ${claim.pendingEvent.type} event` : "an abandonment"}); it keeps retrying. Last error: ${error}`;
      d.serviceLog.write({ kind: "pending-work-failing", issue, failures: chainFailures.count, error });
      // CM3: a problem the system must be able to resolve: a finding, as well as the notification.
      await appendFindings(d.paths, { issue, stage: stuckStage(claim.state), run_id: "chain-error", timestamp: d.now().toISOString() }, [{
        what: "pending work keeps failing", where: `issue #${issue}, ${claim.pendingEvent ? `pending ${claim.pendingEvent.type} event` : "pending abandonment actions"}`,
        evidence: chainFailures.last, noticed_how: "scheduler chain error",
      }]);
      await d.notifier.notify({ issue, gate: "chain_error", label: "", text });
    }
  }

  /** C7: the chain's `chain_error` event, written into the claim first so a crash finishes it, then applied by the driver. */
  async #chainError(claim: Claim): Promise<void> {
    const d = this.#deps;
    const error = claim.state.chainFailures?.last ?? "unknown error";
    const pending: Claim = { ...claim, state: { ...claim.state, chainFailures: null }, pendingEvent: { type: "chain_error", error } };
    await writeClaim(d.paths, pending);
    await step(d, pending);
  }

  async #liveness(claim: Claim, errors: string[]): Promise<boolean> {
    const d = this.#deps;
    const labels = await d.gh.issueLabels(claim.issue).catch((e) => { errors.push(`labels ${claim.issue}: ${(e as Error).message}`); return null; });
    if (labels === null) return false;
    if (!labels.includes(CLAIM_LABEL)) {
      d.log({ kind: "stale-claim", issue: claim.issue });
      await savePatch(d.paths, claim.issue, await uncommittedPatch(claim.worktree).catch(() => ""));
      await removeClaim(d.paths, claim.issue);
      return true;
    }
    const ghActivity = await d.gh.issueActivityAt(claim.issue).catch(() => claim.last_activity_at);
    const last = ghActivity > claim.last_activity_at ? ghActivity : claim.last_activity_at;
    const g = livenessGate(last, claim.run_id !== null, d.now(), d.cfg.liveness_hours);
    if (g.ok || !expirable(claim)) return false;
    await this.#expire(claim);
    return true;
  }

  async #refreshToken(): Promise<void> {
    const d = this.#deps;
    await d.refreshToken?.().catch((e) => d.log({ kind: "error", error: `token refresh: ${(e as Error).message}` }));
  }

  async #expire(claim: Claim): Promise<void> {
    const { state, actions } = transition(claim.state, { type: "liveness_expired" });
    await applyActions(this.#deps, { ...claim, state }, actions);
  }

  /** Step 2 of a tick, for one paused record of an issue not running in this process (AC-13, AC-15, AC-16). True when it resumed the issue into a slot. */
  async #handlePaused(rec: PausedRecord, isOpen: boolean, slotFree: boolean, info: TickInfo): Promise<boolean> {
    return this.#serializeQuestions(()=>this.#handlePausedLocked(rec,isOpen,slotFree,info));
  }
  async #handlePausedLocked(rec:PausedRecord,isOpen:boolean,slotFree:boolean,info:TickInfo):Promise<boolean>{
    const d=this.#deps;
    // A Telegram handler may have answered while this tick was reading GitHub.
    rec=(await listPaused(d.paths)).find(r=>r.issue===rec.issue)??rec;
    if (!isOpen) {
      // Review focus 5: a closed paused issue is dropped, with any claim a crash mid-pause or mid-resume left.
      await removePaused(d.paths, rec.issue);
      await removeClaim(d.paths, rec.issue);
      d.serviceLog.write({ kind: "paused-dropped", issue: rec.issue, phase: rec.phase });
      return false;
    }
    if (rec.phase === "pausing") {
      // Review focus 8: a crash mid-pause, completed from the record without a second question comment.
      await completePause(d, rec, d.botLogin);
      return false;
    }
    if (rec.phase === "resuming") {
      if (!slotFree) return false;
      if(rec.telegram?.channel==='telegram'&&!rec.telegram.ack_sent){
        const {readFile}=await import('node:fs/promises');
        const offset=JSON.parse(await readFile(d.paths.telegramOffset,'utf8').catch(()=>'{"next_update_id":0}')).next_update_id;
        if(offset<=(rec.telegram.answer_update_id??0))return false;
        await this.telegramAnswers.acknowledge(rec);
      }
      await this.#resume(rec, info);
      return true;
    }
    if(d.telegram&&rec.telegram&&!rec.telegram.sent&&rec.telegram.send_failures===1)rec=await sendPausedQuestion(d,rec);
    // A crash between the record saying `paused` and the claim's removal.
    await removeClaim(d.paths, rec.issue);
    const decision = pausedDecision(rec, await d.gh.listComments(rec.issue), d.cfg.maintainer, d.now());
    if (decision.kind === "resume") {
      const resuming: PausedRecord = { ...rec, phase: "resuming", answer: decision.answer, reply_comment_id: decision.replyId,telegram:rec.telegram?{...rec.telegram,channel:'issue'}:null };
      await writePaused(d.paths, resuming);
      if(!slotFree)return false;
      await this.#resume(resuming, info);
      return true;
    }
    if (decision.kind === "remind") {
      // C15: the mark is written first, so a crash costs the reminder rather than sending a second one (AC-16).
      await writePaused(d.paths, { ...rec, reminded: true });
      const text = `@${d.cfg.maintainer} Still waiting on your answer: ${rec.question.question}`;
      if(d.telegram&&rec.telegram?.message_id){
        const id=await d.telegram.sendReply(reminderText(rec),rec.telegram.message_id,questionMessage({number:rec.issue,title:''},rec,'').reply_markup);
        rec={...rec,reminded:true,telegram:{...rec.telegram,reminder_message_id:id,thread_message_ids:[...rec.telegram.thread_message_ids,id]}};await writePaused(d.paths,rec);
      }else await d.gh.comment(rec.issue, text);
      await d.notifier.notify({ issue: rec.issue, gate: "question-reminder", label: NEEDS_DECISION_LABEL, text });
      await appendQuestionLog(d.paths, { issue: rec.issue, at: d.now().toISOString(), event: "reminded", asking_stage: rec.asking_stage,channel:rec.telegram?.message_id?'telegram':'issue',...(rec.telegram?.reminder_message_id?{telegram_message_id:rec.telegram.reminder_message_id}:{}), ...(rec.question_comment_id === null ? {} : { question_comment_id: rec.question_comment_id }) });
    }
    return false;
  }

  /**
   * AC-15 from the record marked `resuming`; each step is guarded, so a resume a crash interrupted is finished here
   * with one claim and one `answered` line. The chain's first step applies the `answered` event.
   */
  async #resume(rec: PausedRecord, info: TickInfo): Promise<void> {
    const d = this.#deps;
    if (rec.question_comment_id === null || rec.answer === null || rec.reply_comment_id === null) throw new Error("resuming record without its question or reply");
    const questionId = rec.question_comment_id;
    if (!(await answeredEntry(d.paths, questionId))) {
      // C8: the question text goes with the answer, for the review input of AC-10.
      await appendQuestionLog(d.paths, {
        issue: rec.issue, at: d.now().toISOString(), event: "answered", asking_stage: rec.asking_stage,
        question_comment_id: questionId, reply_comment_id: rec.reply_comment_id, answer: rec.answer, question: rec.question,channel:rec.telegram?.channel??'issue',
      });
    }
    let claim = await readClaim(d.paths, rec.issue);
    if (!claim) {
      const wt = await ensureWorktree(d.repoDir, d.paths.worktrees, rec.issue);
      claim = {
        issue: rec.issue, slot: this.#active.size, state:{...rec.state,resumeSession:d.telegram?rec.session??null:null}, worktree: rec.session?.worktree??wt.path,
        telegram_thread:rec.telegram??null,
        started_at: d.now().toISOString(), last_activity_at: d.now().toISOString(), run_id: null,
        pendingEvent: { type: "answered", answer: rec.answer, questionId },
      };
      await d.emitEvent?.('maintainer_reply',{issue:rec.issue,question_id:questionId});
      await writeClaim(d.paths, claim);
    }
    await d.gh.addLabels(rec.issue, [CLAIM_LABEL]);
    await d.gh.removeLabel(rec.issue, NEEDS_DECISION_LABEL);
    await this.telegramAnswers.archive(rec);
    await removePaused(d.paths, rec.issue);
    info.claimed.push(rec.issue);
    this.#start(claim);
  }

  async tick(): Promise<TickInfo> {
    if (this.#ticking) return { eligible: 0, claimed: [], released: [], held: 0, standing: [], errors: ["tick already in progress"], restartPending: this.#restartPending };
    this.#ticking = true;
    const d = this.#deps;
    const info: TickInfo = { eligible: 0, claimed: [], released: [], held: 0, standing: [], errors: [], restartPending: this.#restartPending };
    try {
      const slots = d.parameters ? Number((await d.parameters.read('slots')).value) : d.cfg.slots;
      if(d.registry && d.parameters)await initializeAgents(d.paths,d.registry,d.parameters,d.now());
      const token = await readToken(d.paths).catch(() => null);
      if (token && new Date(token.expires_at).getTime() - d.now().getTime() < TOKEN_REFRESH_MARGIN_MS) await this.#refreshToken();
      try {
        await d.fetchOrigin();
        const ff = await d.fastForward();
        if (ff.moved && schedulerChanged(ff.changedPaths)) {
          this.#restartPending = true;
          info.restartPending = true;
        }
      } catch (e) {
        info.errors.push(`freshness: ${(e as Error).message}`);
      }
      if(d.registry && Object.keys(d.registry).length)try {
        const sha=execFileSync('git',['rev-parse','origin/main'],{cwd:d.repoDir,encoding:'utf8'}).trim();
        await watchMainChecks(d.gh,d.paths,d.registry,sha,d.cfg.required_checks,d.now());
      }catch(e){info.errors.push(`main checks: ${(e as Error).message}`);}
      await pruneUsage(d.paths, d.now()).catch((e) => info.errors.push(`prune: ${(e as Error).message}`));

      if(d.telegram)await this.#serializeQuestions(async()=>this.telegramAnswers.auditLateIssueReplies((await listClaims(d.paths)).map(c=>c.issue))).catch(()=>d.log({kind:'telegram-issue-audit-failed'}));
      // Step 2 owns the claims of paused issues (a crash mid-pause or mid-resume); a claim carrying pending work is the driver's.
      const pausedIssues = new Set((await listPaused(d.paths)).map((r) => r.issue));
      for (const claim of await listClaims(d.paths)) {
        if (this.#active.has(claim.issue) || pausedIssues.has(claim.issue) || carriesPending(claim)) continue;
        if (await this.#liveness(claim, info.errors)) info.released.push(claim.issue);
      }
      // A pending self-update stops resuming and claiming, like a stop, so the restart is not held up by new chains.
      if (this.#stopping || this.#restartPending) return info;

      // Claims that may start, in listing order; chain errors are handed out first, whatever the slots.
      const startable: Claim[] = [];
      for (const claim of await listClaims(d.paths)) {
        if (this.#active.has(claim.issue) || pausedIssues.has(claim.issue)) continue;
        const failures = claim.state.chainFailures?.count ?? 0;
        if (failures >= MAX_CHAIN_FAILURES && expirable(claim)) {
          d.serviceLog.write({ kind: "chain-error", issue: claim.issue, failures, error: claim.state.chainFailures?.last });
          try {
            await this.#chainError(claim);
          } catch (e) {
            // The claim holds the event now; the driver applies it on a later tick.
            info.errors.push(`chain error ${claim.issue}: ${(e as Error).message}`);
          }
          info.released.push(claim.issue);
          continue;
        }
        if (!(claim.state.stage === "waiting" && claim.state.postponedUntil && new Date(claim.state.postponedUntil) > d.now())) startable.push(claim);
      }

      let issues: Awaited<ReturnType<typeof d.gh.listOpenIssues>> | null = null;
      let listed = false;
      const openIssues = async () => {
        if (listed) return issues;
        listed = true;
        try {
          issues = await d.gh.listOpenIssues();
        } catch (e) {
          info.errors.push((e as Error).message);
        }
        return issues;
      };

      // Spec 016 AC-1 to AC-3 (spec 006 AC-15): an answered question takes a free running slot before anything else.
      const paused = await listPaused(d.paths);
      if (paused.length && (await openIssues())) {
        const open = new Set(issues!.map((i) => i.number));
        for (const rec of paused) {
          if (this.#active.has(rec.issue) || this.#stopping) continue;
          try {
            await this.#handlePaused(rec, open.has(rec.issue), this.active < slots, info);
          } catch (e) {
            info.errors.push(`paused ${rec.issue}: ${(e as Error).message}`);
          }
        }
      }

      // Spec 009: every claim on disk of an issue not paused holds a slot against new claims, and so does a chain
      // still running in this process after a pause removed its claim file.
      const stillPaused = new Set((await listPaused(d.paths)).map((r) => r.issue));
      let held = new Set([...(await listClaims(d.paths)).filter((c) => !stillPaused.has(c.issue)).map((c) => c.issue), ...this.#active.keys()]).size;
      info.held = held;

      const dueStanding: { def: StandingDefinition; state: NonNullable<Awaited<ReturnType<typeof readAgentState>>> }[] = [];
      if (d.registry && d.parameters) {
        const states = await Promise.all(Object.values(d.registry).map(async (def) => ({ def, state: (await readAgentState(d.paths, def.name))! })));
        states.sort((a, b) => (a.state.next_run ?? "").localeCompare(b.state.next_run ?? ""));
        for (const s of states) {
          const due = (s.state.next_run && Date.parse(s.state.next_run) <= d.now().getTime()) || s.state.pending_events.length;
          if (!s.state.paused && !this.#activeStanding.has(s.def.name) && due) dueStanding.push(s);
        }
      }
      const grantStanding = async (): Promise<boolean> => {
        for (let next = dueStanding.shift(); next; next = dueStanding.shift()) {
          const { def, state } = next;
          if (state.running && await d.unitActive(`panelator-stage-${state.running.run_id}`)) continue;
          d.inhibitor.acquire();
          const p = (d.runStanding ?? runStandingAgent)({ ...d, parameters: d.parameters! }, def, state)
            .catch((e) => d.log({ kind: "standing-error", agent: def.name, error: String(e) }))
            .finally(() => { this.#activeStanding.delete(def.name); if (this.active === 0) { d.inhibitor.release(); if (this.#restartPending && !this.#ticking) d.requestRestart(); } });
          this.#activeStanding.set(def.name, p);
          info.standing.push(def.name);
          return true;
        }
        return false;
      };

      // The ranked shortlist, computed once and only when a new claim fits under the held count.
      let ranked: Awaited<ReturnType<typeof d.gh.listOpenIssues>> | null = null;
      let specProblems = new Map<number, string>();
      const shortlist = async () => {
        if (ranked) return ranked;
        if (!(await openIssues())) return (ranked = []);
        // AC-13: the shortlist treats an issue with a paused record as claimed.
        const claimed = new Set([...(await listClaims(d.paths)).map((c) => c.issue), ...(await listPaused(d.paths)).map((r) => r.issue)]);
        const ctx = buildSelectContext(d.repoDir, d.cfg, claimed, d.botLogin);
        const sel = selectEligible(issues!, ctx);
        specProblems = sel.specProblems;
        info.eligible = sel.eligible.length;
        // Only needs-design-stage labels now (AC-20); the needs- prefix then hides the issue, so it is applied once.
        for (const dec of sel.decisions) {
          if (dec.result.ok || dec.result.action !== "label") continue;
          const r = dec.result;
          await d.gh.addLabels(dec.issue, [r.label]).catch((e) => info.errors.push(`label ${dec.issue}: ${(e as Error).message}`));
          await d.gh.comment(dec.issue, `${r.label}: ${r.reason}`).catch((e) => info.errors.push(`comment ${dec.issue}: ${(e as Error).message}`));
          await d.notifier.notify({ issue: dec.issue, gate: dec.gate, label: r.label, text: r.reason });
        }
        const share = d.parameters ? Number((await d.parameters.read('system_work_share')).value) : 0.75;
        return (ranked = rankIssues(sel.eligible, d.cfg.labels, await recentMerges(d.paths, d.now()), share, (i) => classifyWork(i, ctx.readSpec)));
      };
      const grantChain = async (): Promise<boolean> => {
        const claim = startable.shift();
        if (claim) {
          this.#start(claim);
          return true;
        }
        if (held + this.#activeStanding.size >= slots) return false;
        for (let issue = (await shortlist()).shift(); issue; issue = ranked!.shift()) {
          if (this.#stopping) return false;
          try {
            // Claim file before the label: a failure in between leaves a claim without in-progress, which the
            // next tick's stale-claim check drops (GitHub wins), never an in-progress label with no claim file.
            const wt = await ensureWorktree(d.repoDir, d.paths.worktrees, issue.number);
            // AC-19: a spec-present failure starts at the spec stage; AC-7: the counters and history carry over.
            const state = initialChainState(issue.number, specProblems.get(issue.number) ?? null, await readLedger(d.paths, issue.number));
            const c: Claim = {
              issue: issue.number, slot: this.#active.size, state, worktree: wt.path,
              started_at: d.now().toISOString(), last_activity_at: d.now().toISOString(), run_id: null,
            };
            await writeClaim(d.paths, c);
            held++;
            await d.gh.addLabels(issue.number, [CLAIM_LABEL]);
            info.claimed.push(issue.number);
            this.#start(c);
            return true;
          } catch (e) {
            info.errors.push(`claim ${issue.number}: ${(e as Error).message}`);
          }
        }
        return false;
      };

      // Spec 016 AC-4 to AC-8: standing agents and chains take turns for the running slots, one grant each; the
      // kind whose turn it is passes the slot on when it has nothing ready.
      while (this.active < slots && !this.#stopping) {
        const order: ("standing" | "chain")[] = this.#lastGrant === "chain" ? ["standing", "chain"] : ["chain", "standing"];
        let granted: "standing" | "chain" | null = null;
        for (const kind of order) {
          if (await (kind === "standing" ? grantStanding() : grantChain())) { granted = kind; break; }
        }
        if (!granted) break;
        this.#lastGrant = granted;
      }
      return info;
    } finally {
      this.#ticking = false;
      d.serviceLog.tick({ ...info, active: [...this.#active.keys()] });
      if (this.#restartPending && this.active === 0) d.requestRestart();
    }
  }

  async run(): Promise<void> {
    const d = this.#deps;
    const intervalMs = d.cfg.poll_interval_s * 1000;
    let lastWall = d.now().getTime();
    let lastMono = d.monotonic();
    while (!this.#stopping) {
      await this.tick().catch((e) => d.log({ kind: "error", error: (e as Error).message }));
      lastWall = d.now().getTime();
      lastMono = d.monotonic();
      if(!this.#wakeRequested)await Promise.race([d.sleep(intervalMs),new Promise<void>(r=>{this.#wakeSleep=r;})]);
      this.#wakeSleep=null;
      this.#wakeRequested=false;
      const wall = d.now().getTime() - lastWall;
      const mono = d.monotonic() - lastMono;
      if (wall - mono > intervalMs) {
        d.serviceLog.write({ kind: "resumed", slept_ms: wall - mono });
        await this.#refreshToken();
      }
    }
    await Promise.allSettled([...this.#active.values(),...this.#activeStanding.values()]);
    d.inhibitor.release();
    d.serviceLog.stopped(this.#stopReason);
  }
}
