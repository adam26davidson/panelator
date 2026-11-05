import { describe, expect, it } from "vitest";
import { requestProblem, requestType } from "../src/decide/request.ts";
import type { Question, Request } from "../src/types.ts";

const REPO = "adam26davidson/panelator";
const q = (over: Partial<Question> = {}): Question => ({ kind: "capability", question: "Need an API key for the vendor", options: [{ label: "grant", cost: "5 min" }], recommendation: "grant", ...over });
const cred: Request = { type: "credential", name: "demo", provider: "demo", access: ["read"], setup: ["step one", "step two"] };
const contact: Request = { type: "first_contact", party: "github:other", channel: "github", why: "report a bug", message: "Hello,\nbug here" };
const type = (question: string) => requestType(q({ question }), REPO);

describe("requestProblem: the question check's deterministic part (spec 030 AC-6)", () => {
  it("does not call a physical-action question a credential need (review item 1)", () => {
    const question = "Could you plug the test board in? I need physical access to it to run the HIL check";
    expect(requestType(q({ question }), REPO)).toBeNull();
    expect(requestProblem(q({ question }), REPO)).toBeNull();
    for (const t of ["I need access to the lab", "Which permissions does the board need?", "the token ring is down", "grant permission to flash"]) expect(type(t)).toBeNull();
  });
  it("classifies each positive form", () => {
    for (const t of ["Need credentials", "an API key", "an access token", "a personal access token", "the secret", "a password", "the private key", "set up OAuth", "a service account", "run cred set x"]) expect(type(t)).toBe("credential");
    for (const t of ["we need $20", "about 20 USD", "funds for a domain", "the budget", "pay for a plan", "purchase a domain", "a subscription", "an invoice", "a credit card"]) expect(type(t)).toBe("funds");
    for (const t of ["write to bob@example.com", "open a support case", "a support ticket", "first contact with them", "reach out to the vendor", "contact the vendor at their forum", "file in github:acme", "file with -R acme/x"]) expect(type(t)).toBe("first_contact");
  });
  it("does not treat the configured owner as an outside party, and ignores non-capability questions", () => {
    expect(type("see github:adam26davidson and -R adam26davidson/panelator")).toBeNull();
    expect(requestType(q({ kind: "technical", question: "We need funds of $20" }), REPO)).toBeNull();
    expect(requestType(q({ question: "x", request: contact }), REPO)).toBe("first_contact");
  });
  it("names the missing fields", () => {
    expect(requestProblem(q(), REPO)).toBe("a credential request must give name, provider, access, setup");
    expect(requestProblem(q({ question: "We need funds of $20 for a domain" }), REPO)).toMatch(/^a funds request must give amount_usd, purpose, charter_goal/);
    expect(requestProblem(q({ question: "May we email bob@example.com?" }), REPO)).toMatch(/^a first_contact request/);
    expect(requestProblem(q({ request: { ...cred, setup: [] } }), REPO)).toBe("a credential request must give setup");
    expect(requestProblem(q({ request: { ...contact, message: " " } }), REPO)).toBe("a first_contact request must give message");
    expect(requestProblem(q({ request: { type: "funds", amount_usd: 0, purpose: "x", charter_goal: "y" } }), REPO)).toBe("a funds request must give amount_usd");
  });
  it("lets a complete request and unrelated questions through", () => {
    expect(requestProblem(q({ request: cred }), REPO)).toBeNull();
    expect(requestProblem(q({ question: "Which database engine?", kind: "technical" }), REPO)).toBeNull();
    expect(requestProblem(q({ question: "Rotate the firmware layout?" }), REPO)).toBeNull();
  });
});
