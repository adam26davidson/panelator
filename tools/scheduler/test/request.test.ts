import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requestProblem } from "../src/decide/request.ts";
import { applyRequestAnswer, outcomeOf } from "../src/contacts/approve.ts";
import { readParties } from "../src/contacts/gate.ts";
import { renderRequest } from "../src/chain/question.ts";
import { buttonLabel, fixedButtons, questionMessage, matchUpdate } from "../src/telegram/questions.ts";
import { checkCredential } from "../src/credentials/check.ts";
import { CredentialStore } from "../src/credentials/store.ts";
import { parseCatalogue } from "../src/credentials/catalogue.ts";
import { statePaths, ensureStateDirs } from "../src/state/paths.ts";
import type { Question, Request } from "../src/types.ts";
import type { PausedRecord } from "../src/state/paused.ts";
import { fakeCreds } from "./helpers/fake-creds.ts";

const q = (over: Partial<Question> = {}): Question => ({ kind: "capability", question: "Need a token for the vendor API", options: [{ label: "grant", cost: "5 min" }], recommendation: "grant", ...over });
const cred: Request = { type: "credential", name: "demo", provider: "demo", access: ["read"], setup: ["step one", "step two"] };
const contact: Request = { type: "first_contact", party: "github:other", channel: "github", why: "report a bug", message: "Hello,\nbug here" };

describe("requestProblem (spec 030 AC-6)", () => {
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

describe("rendering and keyboards (spec 030 AC-7)", () => {
  it("renders labelled fields, numbered steps and the quoted message", () => {
    expect(renderRequest(cred)).toEqual(["Credential request", "Name: demo", "Provider: demo", "Access: read", "Setup:", "1. step one", "2. step two"]);
    expect(renderRequest(contact).slice(-2)).toEqual(["> Hello,", "> bug here"]);
    expect(renderRequest({ type: "funds", amount_usd: 20, purpose: "domain", charter_goal: "ship" })[1]).toBe("Amount: $20");
  });
  it("uses the fixed keyboards, whose buttons answer with their own label", () => {
    expect(fixedButtons(cred)).toEqual(["Done", "Can't do this"]);
    expect(fixedButtons(contact)).toEqual(["Approve", "Deny"]);
    expect(fixedButtons({ type: "funds", amount_usd: 1, purpose: "p", charter_goal: "c" })).toEqual(["Approved", "Declined"]);
    const rec = { issue: 9, nonce: "n1", phase: "paused", question: q({ request: contact }), telegram: { message_id: 5, thread_message_ids: [] } } as unknown as PausedRecord;
    const m = questionMessage({ number: 9, title: "t" }, rec, "http://c");
    expect(m.text).toContain("Message that would be sent:");
    expect(m.reply_markup.inline_keyboard.map((r) => r[0].text)).toEqual(["Approve", "Deny"]);
    expect(buttonLabel(rec.question, 2)).toBe("Deny");
    const res = matchUpdate({ update_id: 1, callback_query: { id: "c", data: "q:n1:1", message: { message_id: 5, date: 1, chat: { id: 1 } } } }, [rec], null);
    expect(res).toMatchObject({ kind: "answer", text: "Approve" });
  });
});

describe("acting on the answer (spec 030 AC-8)", () => {
  async function deps() {
    const root = mkdtempSync(join(tmpdir(), "req-"));
    const paths = statePaths(join(root, "s"));
    await ensureStateDirs(paths);
    const store = new CredentialStore(join(root, "creds"), fakeCreds);
    const catalogue = parseCatalogue(`demo:\n  provider: demo\n  purpose: p\n  access: [a]\n  used_by: [scheduler]\n  wrapper: none\n  expiry: none\n  check: test -n "$X"\n  renew: manual\n  setup: [s]\n`, { profiles: [], agents: [] });
    const credentialDeps = { store, catalogue, paths, binDir: "", now: () => new Date("2026-11-04T00:00:00Z") };
    return { paths, store, credentialDeps, now: () => new Date("2026-11-04T00:00:00Z") };
  }
  const rec = (request: Request) => ({ question: q({ request }), issue: 39, question_comment_id: 77 });
  it("registers a party on approval and only then", async () => {
    const d = await deps();
    for (const t of ["Deny", "maybe later", "No"]) expect(await applyRequestAnswer(d, rec(contact), t)).toBe(t);
    expect(await readParties(d.paths)).toEqual([]);
    expect(await applyRequestAnswer(d, rec(contact), "OK, go ahead")).toBe("OK, go ahead");
    expect(await readParties(d.paths)).toEqual([{ party: "github:other", channel: "github", approved_at: "2026-11-04T00:00:00.000Z", question_comment_id: 77, issue: 39 }]);
    expect(outcomeOf(q({ request: contact }), "Approve")).toBe("approved");
    expect(outcomeOf(q({ request: contact }), "Deny")).toBe("denied");
    expect(outcomeOf(q({ request: contact }), "hmm")).toBe("text");
  });
  it("verifies a credential on Done, reports a failed or missing check, and passes other answers through", async () => {
    const d = await deps();
    expect(await applyRequestAnswer(d, rec(cred), "Done")).toBe("done (check failed: credential is not set; run cred set)");
    await d.store.writeSecret("demo", "v", "maintainer");
    const failing = { ...d, credentialDeps: { ...d.credentialDeps, run: async () => ({ code: 1, stdout: "", stderr: "nope\n" }) } };
    expect(await applyRequestAnswer(failing, rec(cred), "done, I set it")).toBe("done (check failed: exit 1: nope)");
    const passing = { ...d, credentialDeps: { ...d.credentialDeps, run: async () => ({ code: 0, stdout: "", stderr: "" }) } };
    expect(await applyRequestAnswer(passing, rec(cred), "Done")).toBe("done (verified)");
    expect(await applyRequestAnswer(passing, rec(cred), "Can't do this")).toBe("Can't do this");
    expect(outcomeOf(q({ request: cred }), "done (verified)")).toBe("verified");
    expect(outcomeOf(q({ request: cred }), "done (check failed: x)")).toBe("check_failed");
    expect(outcomeOf(q({ request: cred }), "Can't do this")).toBe("declined");
    expect(outcomeOf(q({ request: { type: "funds", amount_usd: 1, purpose: "p", charter_goal: "c" } }), "Approved")).toBe("approved");
    expect(outcomeOf(q(), "anything")).toBeUndefined();
    void checkCredential;
  });
});
