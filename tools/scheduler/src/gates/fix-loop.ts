import { ignore, pass, type GateResult } from "./types.ts";

export const MAX_FIXES = 2;

/** At the bound the chain escalates (spec 006 AC-1); no label is applied. */
export function fixLoopGate(fixes: number): GateResult {
  return fixes >= MAX_FIXES ? ignore(`fix loop limit reached (${fixes} fixes)`) : pass;
}
