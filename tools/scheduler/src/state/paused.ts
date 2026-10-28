import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeChainState } from "../chain/machine.ts";
import type { ChainState } from "../chain/types.ts";
import type { IssueComment } from "../github/types.ts";
import { validate } from "../schema/validate.ts";
import type { AskingStage, Question } from "../types.ts";
import type { StatePaths } from "./paths.ts";

export type { IssueComment } from "../github/types.ts";

export interface AskingSession { harness: import('../types.ts').Harness; model:string; session_id:string; worktree:string }
export interface TelegramThread {
 message_id:number|null; sent:boolean; sent_at:string|null; send_failures:number; reminder_message_id:number|null;
 thread_message_ids:number[]; thread_last_message_id:number|null; answer_update_id:number|null; ack_sent:boolean; channel:'telegram'|'issue'|null;
}
export const emptyTelegram = ():TelegramThread=>({message_id:null,sent:false,sent_at:null,send_failures:0,reminder_message_id:null,thread_message_ids:[],thread_last_message_id:null,answer_update_id:null,ack_sent:false,channel:null});
export interface PausedRecord {
  issue_title?:string;
  session?: AskingSession|null;
  telegram?: TelegramThread|null;
  issue: number;
  phase: "pausing" | "paused" | "resuming";
  state: ChainState;
  question: Question;
  asking_stage: AskingStage;
  /** Random, written in phase pausing and embedded in the question comment, so recovery can tell which comment is ours. */
  nonce: string;
  /** From GitHub's response to the question comment. */
  question_comment_id: number | null;
  asked_at: string | null;
  reminded: boolean;
  answer: string | null;
  reply_comment_id: number | null;
}

export const REMINDER_AFTER_H = 24;

const file = (p: StatePaths, issue: number) => join(p.paused, `${issue}.json`);

export async function writePaused(p: StatePaths, r: PausedRecord): Promise<void> {
  const v = validate("paused", r);
  if (!v.ok) throw new Error(`invalid paused record: ${v.errors.join("; ")}`);
  const tmp = file(p, r.issue) + ".tmp";
  await writeFile(tmp, JSON.stringify(r, null, 2));
  await rename(tmp, file(p, r.issue));
}

export async function listPaused(p: StatePaths): Promise<PausedRecord[]> {
  const names = (await readdir(p.paused)).filter((n) => /^\d+\.json$/.test(n));
  const out: PausedRecord[] = [];
  for (const n of names) {
    const r = JSON.parse(await readFile(join(p.paused, n), "utf8")) as PausedRecord;
    out.push({ ...r, session:r.session??null, telegram:r.telegram??null, state: normalizeChainState(r.state) });
  }
  return out.sort((a, b) => a.issue - b.issue);
}

export async function removePaused(p: StatePaths, issue: number): Promise<void> {
  await unlink(file(p, issue)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}

/**
 * Resume on the earliest comment by the maintainer that follows the question comment by id and by time
 * (the id guard stops an edited or back-dated earlier comment counting). Otherwise remind once after 24h.
 */
export function pausedDecision(
  r: PausedRecord,
  comments: IssueComment[],
  maintainer: string,
  now: Date,
): { kind: "resume"; answer: string; replyId: number } | { kind: "remind" } | { kind: "wait" } {
  if (r.question_comment_id === null || r.asked_at === null) return { kind: "wait" };
  const askedId = r.question_comment_id;
  const askedAt = r.asked_at;
  const replies = comments
    .filter((c) => c.author === maintainer && c.id > askedId && Date.parse(c.at) > Date.parse(askedAt))
    .sort((a, b) => a.id - b.id);
  if (replies.length) return { kind: "resume", answer: replies[0].body, replyId: replies[0].id };
  if (!r.reminded && now.getTime() - Date.parse(askedAt) >= REMINDER_AFTER_H * 3600_000) return { kind: "remind" };
  return { kind: "wait" };
}
