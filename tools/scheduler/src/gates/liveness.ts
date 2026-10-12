import { ignore, pass, type GateResult } from "./types.ts";

export function livenessGate(lastActivityAt: string, runInFlight: boolean, now: Date, hours: number): GateResult {
  if (runInFlight) return pass;
  const ageMs = now.getTime() - new Date(lastActivityAt).getTime();
  return ageMs > hours * 3_600_000 ? ignore(`liveness expired: no activity for ${hours} h`) : pass;
}
