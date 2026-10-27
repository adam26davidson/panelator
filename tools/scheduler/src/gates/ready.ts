import type { PlanResult } from "../types.ts";
import { ignore, pass, type GateResult } from "./types.ts";

/** A spec gap goes to the spec stage or escalates (spec 006 AC-19); no label is applied. */
export function readyGate(plan: PlanResult): GateResult {
  if (plan.verdict === "ready") return pass;
  const qs = (plan.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n");
  return ignore(`The plan stage found gaps in the spec:\n${qs}`);
}
