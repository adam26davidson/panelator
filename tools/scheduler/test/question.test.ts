import { describe, expect, it } from "vitest";
import { checkRequest, questionBody } from "../src/chain/question.ts";
import type { Question } from "../src/types.ts";

const base: Question = { kind: "capability", question: "q", options: [{ label: "a", cost: "b" }], recommendation: "a" };
const complete: Record<string, Record<string, unknown>> = {
  credential: { type: "credential", name: "n", provider: "p", access: ["repo"], setup: ["1. open"] },
  funds: { type: "funds", amount_usd: 5, purpose: "p", charter_goal: "g" },
  first_contact: { type: "first_contact", party: "p", channel: "c", why: "w", message: "m" },
};
const q = (request: unknown): Question => ({ ...base, request } as Question);

describe("checkRequest (spec 067 AC-1)", () => {
  it("is null without a request", () => expect(checkRequest(base)).toBeNull());

  for (const [type, req] of Object.entries(complete)) {
    it(`is null for a complete ${type} request`, () => expect(checkRequest(q(req))).toBeNull());

    for (const field of Object.keys(req).filter((k) => k !== "type")) {
      const empties: unknown[] = field === "amount_usd" ? [undefined, 0, -1, NaN, "5"]
        : field === "access" || field === "setup" ? [undefined, [], [""], ["  "], "x"]
        : [undefined, "", "   ", 3];
      for (const empty of empties) {
        it(`names ${field} of a ${type} request when it is ${JSON.stringify(empty) ?? "absent"}`, () => {
          const r = { ...req, [field]: empty };
          expect(checkRequest(q(r))).toBe(`a ${type} request must give ${field}`);
        });
      }
    }
  }

  it("lists two empty fields in the spec's order", () => {
    expect(checkRequest(q({ ...complete.credential, setup: [], access: [] }))).toBe("a credential request must give access, setup");
  });

  it("rejects an unknown type", () => {
    expect(checkRequest(q({ type: "bribe" }))).toBe("a request's type must be credential, funds or first_contact");
  });
});

describe("questionBody shows the request to the question check (spec 067 AC-3)", () => {
  it("renders the type and every field, joining arrays", () => {
    const body = questionBody(q(complete.credential), "m");
    expect(body).toContain("Request (credential):");
    expect(body).toContain("- name: n");
    expect(body).toContain("- access: repo");
    expect(body).toContain("- setup: 1. open");
  });
  it("renders a funds amount and leaves a question without a request unchanged", () => {
    expect(questionBody(q(complete.funds), "m")).toContain("- amount_usd: 5");
    expect(questionBody(base, "m")).not.toContain("Request (");
  });
});
