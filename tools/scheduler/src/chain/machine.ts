import { fixLoopGate, NEEDS_CLARIFICATION, NEEDS_HUMAN, readyGate } from "../gates/index.ts";
import type { AgentStageName } from "../types.ts";
import type { Action, ChainEvent, ChainState } from "./types.ts";

export const CLAIM_LABEL = "in-progress";
export const SECURITY_REVIEW_LABEL = "security-review";
export const PENDING_WAIT_S = 60;
export const POSTPONE_WAIT_S = 1800;

export function initialChainState(issue: number): ChainState {
  return {
    issue, stage: "claimed", attempt: 1, fixes: 0, scopeViolations: 0, planFailures: 0, implementFailures: 0,
    securityFinding: false, sensitive: false, pr: null, plan: null, pendingFixInput: null, postponedUntil: null, resumeStage: null,
  };
}

type Step = { state: ChainState; actions: Action[] };

function invalid(state: ChainState, event: ChainEvent): never {
  throw new Error(`invalid event ${event.type} in stage ${state.stage} (issue ${state.issue})`);
}

function run(state: ChainState, stage: AgentStageName, extra: Partial<Extract<Action, { type: "run_stage" }>> = {}, patch: Partial<ChainState> = {}): Step {
  const attempt = patch.attempt ?? 1;
  return { state: { ...state, ...patch, stage, attempt, resumeStage: null }, actions: [{ type: "run_stage", stage, attempt, ...extra }] };
}

function needsHuman(state: ChainState, gate: string, text: string, extraLabels: string[] = []): Step {
  return {
    state: { ...state, stage: "needs-human" },
    actions: [
      { type: "label", add: [...extraLabels, NEEDS_HUMAN], remove: [CLAIM_LABEL] },
      { type: "notify", gate, label: NEEDS_HUMAN, text },
      { type: "release", reason: gate, savePatch: false },
    ],
  };
}

function toFix(state: ChainState, fixInput: string, patch: Partial<ChainState> = {}): Step {
  if (!fixLoopGate(state.fixes).ok) return needsHuman(state, "fix-loop", `fix loop limit reached after ${state.fixes} fixes: ${fixInput}`);
  return run(state, "fix", { fixInput }, { ...patch, pendingFixInput: fixInput });
}

export function transition(state: ChainState, event: ChainEvent): Step {
  if (event.type === "liveness_expired") {
    return {
      state: { ...state, stage: "released" },
      actions: [
        { type: "comment", text: "Claim released: no run in flight and no activity for the liveness window. Uncommitted work was saved as a patch in the scheduler state directory." },
        { type: "label", add: [], remove: [CLAIM_LABEL] },
        { type: "release", reason: "liveness expired", savePatch: true },
      ],
    };
  }
  if (event.type === "rebase_conflict") {
    if (!["plan", "implement", "review", "fix", "verify", "merge"].includes(state.stage)) invalid(state, event);
    return toFix(state, `Rebase onto main conflicted:\n${event.detail}`);
  }
  if (event.type === "stage_failed") {
    if (event.postpone) {
      if (!["plan", "implement", "review", "fix"].includes(state.stage)) invalid(state, event);
      return { state: { ...state, stage: "waiting", resumeStage: event.stage, postponedUntil: null }, actions: [{ type: "wait", seconds: POSTPONE_WAIT_S }] };
    }
    switch (state.stage) {
      case "plan":
        if (state.planFailures === 0) return run(state, "plan", {}, { planFailures: 1, attempt: 2 });
        return needsHuman(state, "plan", `plan failed twice: ${event.reason}`);
      case "implement":
        if (state.implementFailures === 0) return run(state, "implement", {}, { implementFailures: 1, attempt: 2 });
        return needsHuman(state, "implement", `implement failed twice: ${event.reason}`);
      case "review":
        if (state.attempt === 1) return run(state, "review", {}, { attempt: 2 });
        return needsHuman(state, "review", `review failed twice: ${event.reason}`);
      case "fix":
        return needsHuman(state, "fix", `fix failed: ${event.reason}`);
      default:
        invalid(state, event);
    }
  }

  switch (state.stage) {
    case "claimed":
      if (event.type === "start") return run(state, "plan");
      break;
    case "waiting":
      if (event.type === "start" && state.resumeStage) {
        const extra = state.resumeStage === "fix" && state.pendingFixInput ? { fixInput: state.pendingFixInput }
          : state.resumeStage === "review" && state.sensitive ? { profile: "security" as const } : {};
        return run(state, state.resumeStage, extra, { attempt: state.attempt });
      }
      break;
    case "plan":
      if (event.type === "stage_ok" && event.stage === "plan") {
        const gate = readyGate(event.result);
        if (gate.ok) return run({ ...state, plan: event.result }, "implement");
        const reason = gate.action === "label" ? gate.reason : "spec gap";
        return {
          state: { ...state, stage: "released", plan: event.result },
          actions: [
            { type: "comment", text: reason },
            { type: "label", add: [NEEDS_CLARIFICATION], remove: [CLAIM_LABEL] },
            { type: "notify", gate: "ready", label: NEEDS_CLARIFICATION, text: reason },
            { type: "release", reason: "spec_gap", savePatch: false },
          ],
        };
      }
      break;
    case "implement":
    case "fix":
      if (event.type === "stage_ok" && (event.stage === "implement" || event.stage === "fix")) {
        const pr = event.stage === "implement"
          ? { number: event.result.pr_number, head_sha: event.result.head_sha }
          : state.pr ? { ...state.pr, head_sha: event.result.head_sha } : null;
        const fixes = event.stage === "fix" ? state.fixes + 1 : state.fixes;
        if (!event.scope.ok) {
          const text = `Diff touches files outside the plan's file scope:\n${event.scope.violations.map((v) => `- ${v}`).join("\n")}`;
          if (state.scopeViolations >= 1) return needsHuman({ ...state, pr, fixes }, "scope", text);
          return toFix({ ...state, pr, fixes }, text, { scopeViolations: 1 });
        }
        return { state: { ...state, stage: "verify", pr, fixes, pendingFixInput: null }, actions: [{ type: "verify" }] };
      }
      break;
    case "verify":
      if (event.type === "checks") {
        const checked = { ...state, sensitive: event.sensitive };
        if (event.status === "pending") return { state: checked, actions: [{ type: "wait", seconds: PENDING_WAIT_S }] };
        if (event.status === "failed") return toFix(checked, `A required check failed:\n${event.log ?? "(no log excerpt)"}`);
        return run(checked, "review", checked.sensitive ? { profile: "security" } : {});
      }
      break;
    case "review":
      if (event.type === "stage_ok" && event.stage === "review") {
        const r = event.result;
        const securityHit = event.security && r.findings_on_pr.length > 0;
        if (securityHit) {
          return needsHuman({ ...state, securityFinding: true }, "sensitive-path", `security review returned ${r.findings_on_pr.length} finding(s)`, [SECURITY_REVIEW_LABEL]);
        }
        if (r.verdict === "escalate") return needsHuman(state, "review", "review escalated to the maintainer");
        if (r.verdict === "approve") {
          if (state.securityFinding) return needsHuman(state, "sensitive-path", "an earlier security finding blocks merge");
          return { state: { ...state, stage: "merge" }, actions: [{ type: "merge" }] };
        }
        const text = `Review requested changes:\n${r.findings_on_pr.map((f, i) => `${i}. [${f.criterion}] ${f.file}:${f.line} ${f.scenario}`).join("\n")}`;
        return toFix(state, text);
      }
      break;
    case "merge":
      if (event.type === "merge_result") {
        if (event.status === "merged") return { state: { ...state, stage: "done" }, actions: [{ type: "label", add: [], remove: [CLAIM_LABEL] }, { type: "done" }] };
        return toFix(state, `PR not mergeable:\n${event.detail ?? ""}`);
      }
      break;
    default:
      break;
  }
  invalid(state, event);
}
