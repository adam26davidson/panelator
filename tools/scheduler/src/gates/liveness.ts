import { ignore, pass, type GateResult } from "./types.ts";

export function livenessGate(lastActivityAt: string, runInFlight: boolean, now: Date, hours: number, downtimeMs = 0): GateResult {
  if (runInFlight) return pass;
  // Spec 100 AC-6: only time the scheduler was running and not paused counts.
  const ageMs = now.getTime() - new Date(lastActivityAt).getTime() - downtimeMs;
  return ageMs > hours * 3_600_000 ? ignore(`liveness expired: no activity for ${hours} h`) : pass;
}
