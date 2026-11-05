import { describe, expect, it } from "vitest";
import { requestProblem } from "../src/decide/client.ts";
import type { Question, Request } from "../src/types.ts";

const q = (over: Partial<Question> = {}): Question => ({ kind: "capability", question: "Need a token for the vendor API", options: [{ label: "grant", cost: "5 min" }], recommendation: "grant", ...over });
const cred: Request = { type: "credential", name: "demo", provider: "demo", access: ["read"], setup: ["step one", "step two"] };
const contact: Request = { type: "first_contact", party: "github:other", channel: "github", why: "report a bug", message: "Hello,\nbug here" };

describe("requestProblem: the question check's deterministic part (spec 030 AC-6)", () => {
  it("sends back a capability question that names a need without a complete request", () => {
    expect(requestProblem(q())).toBe("a credential request must give name, provider, access, setup");
    expect(requestProblem(q({ question: "We need funds of $20 for a domain" }))).toMatch(/^a funds request must give amount_usd, purpose, charter_goal/);
    expect(requestProblem(q({ question: "May we contact the vendor by email?" }))).toMatch(/^a first_contact request/);
    expect(requestProblem(q({ request: { ...cred, setup: [] } }))).toBe("a credential request must give setup");
    expect(requestProblem(q({ request: { ...contact, message: " " } }))).toBe("a first_contact request must give message");
    expect(requestProblem(q({ request: { type: "funds", amount_usd: 0, purpose: "x", charter_goal: "y" } }))).toBe("a funds request must give amount_usd");
  });
  it("lets a complete request and unrelated questions through", () => {
    expect(requestProblem(q({ request: cred }))).toBeNull();
    expect(requestProblem(q({ question: "Which database engine?", kind: "technical" }))).toBeNull();
    expect(requestProblem(q({ question: "Rotate the firmware layout?" }))).toBeNull();
  });
});
