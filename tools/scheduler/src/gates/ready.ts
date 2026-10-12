import type { PlanResult } from "../types.ts";
import { label, pass, type GateResult } from "./types.ts";

export const NEEDS_CLARIFICATION = "needs-clarification";

export function readyGate(plan: PlanResult): GateResult {
  if (plan.verdict === "ready") return pass;
  const qs = (plan.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n");
  return label(NEEDS_CLARIFICATION, `The plan stage found gaps in the spec:\n${qs}`);
}
