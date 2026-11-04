import type { Question, Request } from "../types.ts";

const FIELDS: Record<Request["type"], string[]> = {
  credential: ["name", "provider", "access", "setup"],
  funds: ["amount_usd", "purpose", "charter_goal"],
  first_contact: ["party", "channel", "why", "message"],
};

const FUNDS = /\b(funds?|budget|spend|payment|pay for|usd|\$\s?\d)/i;
const CREDENTIAL = /\b(credentials?|api[ -]?keys?|tokens?|secrets?|passwords?|permissions?|access to)\b/i;
const CONTACT = /\b(first contact|outside party|email(?:ing)?|support case|contact (?:the|a|an) )/i;

const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" ? !v.trim() : Array.isArray(v) ? v.length === 0 || v.some((x) => typeof x !== "string" || !x.trim()) : typeof v === "number" ? !(v > 0) : false);

/** Which kind of request a capability question is about, from its request or else its words; null when it names none. */
function requestType(q: Question): Request["type"] | null {
  if (q.request) return q.request.type;
  if (q.kind !== "capability") return null;
  const text = [q.question, q.recommendation, ...q.options.map((o) => `${o.label} ${o.cost}`)].join("\n");
  if (FUNDS.test(text)) return "funds";
  if (CONTACT.test(text)) return "first_contact";
  if (CREDENTIAL.test(text)) return "credential";
  return null;
}

/** Spec 030 AC-6: the reason to send a capability question back, or null when its request is complete or not needed. */
export function requestProblem(q: Question): string | null {
  const type = requestType(q);
  if (!type) return null;
  const r = (q.request ?? {}) as unknown as Record<string, unknown>;
  const missing = FIELDS[type].filter((f) => empty(r[f]));
  return missing.length ? `a ${type} request must give ${missing.join(", ")}` : null;
}
