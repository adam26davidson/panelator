import { ignore, pass, type GateResult } from "./types.ts";

/**
 * Fix rounds per PR, growing with the escalation ladder (maintainer direction 2026-11-22, spec 006 AC-6). Fixed in code:
 * no stage definition or prompt changes them.
 */
export const MAX_FIXES = 2;
export const RESCUE_FIXES = 3;
export const REPLAN_FIXES = 3;
export const SPEC_REVISION_FIXES = 4;
/** Conflict rounds per PR (spec 024 as amended): their own budget, never spent from the fix bound. */
export const MAX_CONFLICT_ROUNDS = 20;

/** The chain state the fix bound reads. */
export interface FixBoundState { fixes: number; rescueActive: boolean; replans: number; specRevisions: number }

/**
 * The fix rounds the PR the chain works on may spend: 2 on a first attempt, 3 while a rescue is in effect or after a
 * re-plan, 4 after a spec revision; a later step never lowers it.
 */
export function fixBound(s: Omit<FixBoundState, "fixes">): number {
  let bound = MAX_FIXES;
  if (s.rescueActive) bound = Math.max(bound, RESCUE_FIXES);
  if (s.replans > 0) bound = Math.max(bound, REPLAN_FIXES);
  if (s.specRevisions > 0) bound = Math.max(bound, SPEC_REVISION_FIXES);
  return bound;
}

/** At the bound the chain escalates (spec 006 AC-1); no label is applied. */
export function fixLoopGate(s: FixBoundState): GateResult {
  return s.fixes >= fixBound(s) ? ignore(`fix loop limit reached (${s.fixes} fixes)`) : pass;
}
