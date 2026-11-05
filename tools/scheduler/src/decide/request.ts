// Spec 030 AC-6: the deterministic part of the question check. A capability question that names a credential, funds
// or an outside party must carry a complete `request`; one that does not is sent back as `decide_yourself` before any
// model runs, with the reason naming the type and the fields it lacks.
import type { Question, Request } from "../types.ts";

const FIELDS: Record<Request["type"], string[]> = {
  credential: ["name", "provider", "access", "setup"],
  funds: ["amount_usd", "purpose", "charter_goal"],
  first_contact: ["party", "channel", "why", "message"],
};

// Narrow on purpose: a physical-action question ("I need physical access to the board") is a capability question
// the maintainer must answer, and must reach the question check, not be bounced as a credential need.
const CREDENTIAL = /\b(credentials?|api[ -]?keys?|access tokens?|personal access tokens?|secrets?|passwords?|private keys?|oauth|service accounts?|cred set)\b/i;
const FUNDS = /(\$\s?\d|\b\d[\d,.]*\s?usd\b|\b(funds|budget|pay for|purchase|subscription|invoice|credit card)\b)/i;
const CONTACT = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b(support case|support ticket|first contact|reach out to)\b|\bcontact\s+(?:\S+\s+){1,3}at\b)/i;
const OWNER_REF = /(?:\bgithub:|(?:-R|--repo)[ =])([\w.-]+)/gi;

const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" ? !v.trim() : Array.isArray(v) ? v.length === 0 || v.some((x) => typeof x !== "string" || !x.trim()) : typeof v === "number" ? !(v > 0) : false);

/** Which kind of request a capability question is about, from its request or else its words; null when it names none. */
export function requestType(q: Question, repo = ""): Request["type"] | null {
  if (q.request) return q.request.type;
  if (q.kind !== "capability") return null;
  const text = [q.question, q.recommendation, ...q.options.map((o) => `${o.label} ${o.cost}`)].join("\n");
  if (FUNDS.test(text)) return "funds";
  const owner = repo.split("/")[0]?.toLowerCase();
  const outsideOwner = [...text.matchAll(OWNER_REF)].some((m) => m[1].toLowerCase() !== owner);
  if (CONTACT.test(text) || outsideOwner) return "first_contact";
  if (CREDENTIAL.test(text)) return "credential";
  return null;
}

/** The reason to send a capability question back, or null when its request is complete or not needed. */
export function requestProblem(q: Question, repo = ""): string | null {
  const type = requestType(q, repo);
  if (!type) return null;
  const r = (q.request ?? {}) as unknown as Record<string, unknown>;
  const missing = FIELDS[type].filter((f) => empty(r[f]));
  return missing.length ? `a ${type} request must give ${missing.join(", ")}` : null;
}
