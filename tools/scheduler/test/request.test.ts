import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actOnAnswer, formatQuestion, questionBody } from "../src/chain/question.ts";
import { applyRequestAnswer } from "../src/chain/driver.ts";
import { readParties } from "../src/contacts/gate.ts";
import { loadCatalogue } from "../src/credentials/catalogue.ts";
import { CredentialStore } from "../src/credentials/store.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { matchUpdate, questionMessage } from "../src/telegram/questions.ts";
import type { PausedRecord } from "../src/state/paused.ts";
import type { Question } from "../src/types.ts";

const fake = join(import.meta.dirname, "helpers", "fake-systemd-creds");
const fixture = join(import.meta.dirname, "fixtures", "test-catalogue.yaml");
const cred = { type: "credential", name: "fake-token", provider: "test", access: ["read"], setup: ["do a", "do b"] };
const fc = { type: "first_contact", party: "example.org", channel: "email", why: "w", message: "line one\nline two" };
const funds = { type: "funds", amount_usd: 5, purpose: "p", charter_goal: "g" };
const q = (request: unknown): Question => ({ kind: "capability", question: "Need it", options: [{ label: "A", cost: "c" }], recommendation: "A", request } as unknown as Question);
const rec = (request: unknown): PausedRecord => ({ issue: 3, phase: "paused", nonce: "nn", question: q(request), telegram: { message_id: 9, thread_message_ids: [9] } } as unknown as PausedRecord);

describe("actOnAnswer (spec 099 AC-5)", () => {
  it("maps every answer form", () => {
    expect(actOnAnswer(fc, "Approve")).toEqual({ action: "approve_party", outcome: "approved" });
    expect(actOnAnswer(fc, "Yes, go ahead")).toEqual({ action: "approve_party", outcome: "approved" });
    expect(actOnAnswer(fc, "OK")).toEqual({ action: "approve_party", outcome: "approved" });
    expect(actOnAnswer(fc, "Deny")).toEqual({ action: "none", outcome: "denied" });
    expect(actOnAnswer(fc, "maybe later")).toEqual({ action: "none", outcome: "text" });
    expect(actOnAnswer(cred, "Done")).toEqual({ action: "run_check", outcome: "verified" });
    expect(actOnAnswer(cred, "done, set it")).toEqual({ action: "run_check", outcome: "verified" });
    expect(actOnAnswer(cred, "Can't do this")).toEqual({ action: "none", outcome: "declined" });
    expect(actOnAnswer(cred, "later")).toEqual({ action: "none", outcome: "text" });
    expect(actOnAnswer(funds, "Approved")).toEqual({ action: "none", outcome: "approved" });
    expect(actOnAnswer(funds, "Declined")).toEqual({ action: "none", outcome: "declined" });
    expect(actOnAnswer(undefined, "Done")).toEqual({ action: "none", outcome: null });
  });
});

describe("request rendering (spec 099 AC-4)", () => {
  it("renders fixed buttons and the fields; the issue comment keeps spec 067's list", () => {
    const m = questionMessage({ number: 3, title: "t" }, rec(cred), "url");
    expect(m.reply_markup.inline_keyboard.map((r) => r[0]!.text)).toEqual(["Done", "Can't do this"]);
    expect(m.reply_markup.inline_keyboard[0]![0]!.callback_data).toBe("r:nn:1");
    expect(m.text).toContain("1. do a");
    expect(m.text).toContain("2. do b");
    expect(m.text).toContain("1. A — c");
    const f = questionMessage({ number: 3, title: "t" }, rec(fc), "url");
    expect(f.text).toContain("> line one\n> line two");
    expect(f.reply_markup.inline_keyboard.map((r) => r[0]!.text)).toEqual(["Approve", "Deny"]);
    expect(questionMessage({ number: 3, title: "t" }, rec(funds), "u").reply_markup.inline_keyboard.map((r) => r[0]!.text)).toEqual(["Approved", "Declined"]);
    expect(questionMessage({ number: 3, title: "t" }, rec(undefined), "u").reply_markup.inline_keyboard[0]![0]!.callback_data).toBe("q:nn:1");
    expect(questionBody(q(cred), "m")).toContain("Request (credential):");
    expect(formatQuestion(q(cred), "m", "nn")).toContain("- name: fake-token");
  });
  it("a request button resolves to its label as the answer", () => {
    const r = rec(cred);
    const u = { update_id: 1, callback_query: { id: "c", data: "r:nn:1", message: { message_id: 9, date: 1, chat: { id: 1 } } } };
    expect(matchUpdate(u as never, [r], null)).toMatchObject({ kind: "answer", text: "Done" });
    expect(matchUpdate({ ...u, callback_query: { ...u.callback_query, data: "r:nn:2" } } as never, [r], null)).toMatchObject({ text: "Can't do this" });
  });
});

describe("applyRequestAnswer (spec 099 AC-5)", () => {
  const setup = async (check: string) => {
    const root = mkdtempSync(join(tmpdir(), "req-"));
    const paths = statePaths(join(root, "state"));
    await ensureStateDirs(paths);
    const store = new CredentialStore({ dir: join(root, "store"), systemdCreds: fake });
    await store.writeSecret("fake-token", "s", "maintainer");
    const catalogue = loadCatalogue(fixture, { profiles: ["backend"], agents: [] });
    // a check that exits 0 or 1 without any real command: replace the entry's check by a builtin-free command via a stub
    const entry = { ...catalogue["fake-token"]!, check: check };
    return { paths, store, deps: { paths, catalogue: { "fake-token": entry }, checkContext: { store, app: { id: 1, installation_id: 1, private_key_path: "", bot_login: "" }, now: () => new Date("2026-11-20T10:00:00Z") }, now: () => new Date("2026-11-20T10:00:00Z") } };
  };
  it("approves a party and tells the stage no channel can reach it; deny leaves it unapproved", async () => {
    const t = await setup("x");
    const r = { issue: 3, question: q(fc), question_comment_id: 77 };
    expect(await applyRequestAnswer(t.deps as never, r, "Deny")).toEqual({ answer: "Deny", outcome: "denied" });
    expect(await readParties(t.paths)).toEqual([]);
    const out = await applyRequestAnswer(t.deps as never, r, "Approve");
    expect(out).toEqual({ answer: "approved (recorded; no channel can reach example.org yet: a credential that can is a credential request)", outcome: "approved" });
    expect(await readParties(t.paths)).toEqual([{ party: "example.org", channel: "email", approved_at: "2026-11-20T10:00:00.000Z", question_comment_id: 77, issue: 3 }]);
  });
  it("Done on a wrapped entry is skipped (no command check yet), on an unknown name unverified; funds passes through", async () => {
    const t = await setup("fakecmd --check");
    const r = (name: string) => ({ issue: 3, question: q({ ...cred, name }), question_comment_id: 1 });
    expect(await applyRequestAnswer(t.deps as never, r("fake-token"), "Done")).toEqual({ answer: "done (not checked: wrapper not built)", outcome: "text" });
    expect(await applyRequestAnswer(t.deps as never, r("nope"), "Done")).toEqual({ answer: "done (unverified: nope is not in the catalogue)", outcome: "text" });
    expect(await applyRequestAnswer(t.deps as never, { issue: 3, question: q(funds), question_comment_id: 1 }, "Approved")).toEqual({ answer: "Approved", outcome: "approved" });
    expect(await applyRequestAnswer(t.deps as never, { issue: 3, question: q(undefined), question_comment_id: 1 }, "hi")).toEqual({ answer: "hi" });
  });
});
