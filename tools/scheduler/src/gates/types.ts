export type GateResult =
  | { ok: true }
  | { ok: false; action: "ignore"; reason: string }
  | { ok: false; action: "label"; label: string; reason: string };

export const pass: GateResult = { ok: true };
export const ignore = (reason: string): GateResult => ({ ok: false, action: "ignore", reason });
export const label = (label: string, reason: string): GateResult => ({ ok: false, action: "label", label, reason });
