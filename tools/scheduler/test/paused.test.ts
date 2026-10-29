import { mkdtempSync } from "node:fs";
import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialChainState } from "../src/chain/machine.ts";
import { archiveLedger, readLedger, writeLedger } from "../src/state/ledger.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { emptyTelegram,listPaused, pausedDecision, removePaused, writePaused, type IssueComment, type PausedRecord } from "../src/state/paused.ts";
import { answeredEntry, appendQuestionLog } from "../src/state/questions.ts";
import { validate } from "../src/schema/validate.ts";

const Q = { kind: "product" as const, question: "Which?", options: [{ label: "A", cost: "cheap" }, { label: "B", cost: "dear" }], recommendation: "A" };
const ASKED = "2026-10-20T00:00:00Z";
const rec = (over: Partial<PausedRecord> = {}): PausedRecord => ({
  issue: 7, phase: "paused", state: initialChainState(7), question: Q, asking_stage: "plan", nonce: "n1",
  question_comment_id: 100, asked_at: ASKED, reminded: false, answer: null, reply_comment_id: null, ...over,
});
const c = (id: number, author: string, at: string, body = "b"): IssueComment => ({ id, author, at, body });
const H = 3600_000;
const at = (hours: number) => new Date(Date.parse(ASKED) + hours * H);

describe("pausedDecision (AC-16)", () => {
  it("resumes on the maintainer's earliest later comment", () => {
    const d = pausedDecision(rec(), [c(103, "adam", "2026-10-20T02:00:00Z", "second"), c(101, "adam", "2026-10-20T01:00:00Z", "go with A")], "adam", at(2));
    expect(d).toEqual({ kind: "resume", answer: "go with A", replyId: 101 });
  });
  it("ignores a maintainer comment at or below the question id even when later in time", () => {
    const comments = [c(100, "adam", "2026-10-20T05:00:00Z"), c(99, "adam", "2026-10-20T05:00:00Z")];
    expect(pausedDecision(rec(), comments, "adam", at(6)).kind).toBe("wait");
  });
  it("ignores a comment not after asked_at", () => {
    expect(pausedDecision(rec(), [c(101, "adam", ASKED)], "adam", at(1)).kind).toBe("wait");
  });
  it("ignores the bot and other users", () => {
    const comments = [c(101, "panelator-pipeline[bot]", "2026-10-20T01:00:00Z"), c(102, "someone", "2026-10-20T01:00:00Z")];
    expect(pausedDecision(rec(), comments, "adam", at(2)).kind).toBe("wait");
  });
  it("reminds at 24h once, waits just before, and waits at 48h when already reminded", () => {
    expect(pausedDecision(rec(), [], "adam", at(24)).kind).toBe("remind");
    expect(pausedDecision(rec(), [], "adam", new Date(at(24).getTime() - 60_000)).kind).toBe("wait");
    expect(pausedDecision(rec({ reminded: true }), [], "adam", at(48)).kind).toBe("wait");
  });
  it("always waits while the question comment is not recorded", () => {
    expect(pausedDecision(rec({ question_comment_id: null, asked_at: null }), [c(5, "adam", "2030-01-01T00:00:00Z")], "adam", at(100)).kind).toBe("wait");
  });
});

function fresh() {
  return statePaths(mkdtempSync(join(tmpdir(), "paused-")));
}

describe("paused records", () => {
  it('round-trips the asking session and Telegram thread fields',async()=>{
    const p=fresh();await ensureStateDirs(p);const r=rec({session:{harness:'pi',model:'m',session_id:'s',worktree:'/w'},telegram:{...emptyTelegram(),message_id:10,sent:true,sent_at:ASKED,thread_message_ids:[10,11],thread_last_message_id:11,answer_update_id:99,ack_sent:true,channel:'telegram'}});await writePaused(p,r);expect(await listPaused(p)).toEqual([r]);
  });
  it("round-trips, lists and removes", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    const r = rec();
    await writePaused(p, r);
    expect(await listPaused(p)).toEqual([{...r,session:null,telegram:null}]);
    await removePaused(p, 7);
    expect(await listPaused(p)).toEqual([]);
    await removePaused(p, 7);
  });
  it("normalizes a pre-006 state inside a paused record", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    const { track: _t, rescues: _r, history: _h, ...old } = initialChainState(7);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(p.paused, "7.json"), JSON.stringify({ ...rec(), state: { ...old, securityFinding: null } }));
    const [got] = await listPaused(p);
    expect(got.state.track).toBe("issue");
    expect(got.state.rescues).toBe(0);
    expect(got.state.history).toEqual([]);
    expect(got.state.heldWork).toBeNull();
    expect("securityFinding" in got.state).toBe(false);
  });
  it("rejects an invalid record", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    await expect(writePaused(p, rec({ nonce: "" }))).rejects.toThrow(/paused/);
  });
});

describe("escalation ledger", () => {
  const counts = { rescues: 1, specRescues: 0, replans: 2, specRevisions: 0, specAnswers: 1, decideReturns: 0, history: ["rescue: x"] };
  it("round-trips and archiving makes the next read null", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    expect(await readLedger(p, 7)).toBeNull();
    await writeLedger(p, 7, counts);
    expect(await readLedger(p, 7)).toEqual({ ...counts, pendingAnswer: null, chainFailures: null, chainErrors: 0 });
    await archiveLedger(p, 7, new Date("2026-10-27T01:02:03Z"));
    expect(await readLedger(p, 7)).toBeNull();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(p.escalations).filter((n) => n.startsWith("7.abandoned-"))).toHaveLength(1);
  });
  it("archiving a missing ledger is a no-op", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    await archiveLedger(p, 9, new Date());
  });
});

describe("questions log", () => {
  it("appends one valid line per call and finds the answered entry by question comment id", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    await appendQuestionLog(p, { issue: 7, at: "2026-10-20T00:00:00Z", event: "sent", asking_stage: "plan", question_comment_id: 100, question: Q });
    await appendQuestionLog(p, { issue: 7, at: "2026-10-20T01:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 100, reply_comment_id: 101, answer: "A" });
    await appendQuestionLog(p, { issue: 7, at: "2026-10-20T01:00:00Z", event: "sent", asking_stage: "plan", question_comment_id: 200 });
    const lines = readFileSync(p.questionsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(validate("question-log-entry", l).ok).toBe(true);
    expect((await answeredEntry(p, 100))?.reply_comment_id).toBe(101);
    expect(await answeredEntry(p, 200)).toBeNull();
    expect(await answeredEntry(p, 999)).toBeNull();
  });
  it("skips an unparsable (torn) line and still finds a later answered entry", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    await appendQuestionLog(p, { issue: 7, at: "2026-10-20T00:00:00Z", event: "sent", asking_stage: "plan", question_comment_id: 100 });
    appendFileSync(p.questionsLog, '{"issue":7,"at":"2026-10-20T00:30:00Z","ev\n');
    await appendQuestionLog(p, { issue: 7, at: "2026-10-20T01:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 100, reply_comment_id: 101, answer: "A" });
    expect((await answeredEntry(p, 100))?.answer).toBe("A");
    expect(await answeredEntry(p, 5)).toBeNull();
  });
  it("returns null when there is no log, and rejects an invalid entry", async () => {
    const p = fresh();
    await ensureStateDirs(p);
    expect(await answeredEntry(p, 1)).toBeNull();
    await expect(appendQuestionLog(p, { issue: 0, at: "x", event: "sent", asking_stage: "plan" })).rejects.toThrow(/question-log/);
  });
});
