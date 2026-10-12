import { label, pass, type GateResult } from "./types.ts";

export const NEEDS_HUMAN = "needs-human";
export const MAX_FIXES = 2;

export function fixLoopGate(fixes: number): GateResult {
  return fixes >= MAX_FIXES ? label(NEEDS_HUMAN, `fix loop limit reached (${fixes} fixes)`) : pass;
}
