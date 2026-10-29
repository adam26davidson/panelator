import { appendFile, readFile } from "node:fs/promises";
import { validate } from "../schema/validate.ts";
import type { AskingStage, Question } from "../types.ts";
import type { StatePaths } from "./paths.ts";

export interface QuestionLogEntry {
  channel?: 'telegram'|'issue';
  telegram_message_id?: number;
  issue: number;
  at: string;
  event: "asked" | "checked" | "sent" | "reminded" | "answered";
  asking_stage: AskingStage;
  question_comment_id?: number;
  question?: Question;
  verdict?: string;
  reasoning?: string;
  reply_comment_id?: number;
  answer?: string;
}

export async function appendQuestionLog(p: StatePaths, entry: QuestionLogEntry): Promise<void> {
  const v = validate("question-log-entry", entry);
  if (!v.ok) throw new Error(`invalid question-log entry: ${v.errors.join("; ")}`);
  await appendFile(p.questionsLog, JSON.stringify(entry) + "\n");
}

/** Every `answered` line of the log, oldest first. */
async function answeredEntries(p: StatePaths): Promise<QuestionLogEntry[]> {
  let text: string;
  try {
    text = await readFile(p.questionsLog, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: QuestionLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: QuestionLogEntry;
    try {
      e = JSON.parse(line) as QuestionLogEntry;
    } catch {
      continue; // a line torn by a crash mid-append verifies nothing
    }
    if (e.event === "answered") out.push(e);
  }
  return out;
}

/** The `answered` line for a question comment, if any: the citation check and the resume's no-duplicate rule use it. */
export async function answeredEntry(p: StatePaths, questionCommentId: number): Promise<QuestionLogEntry | null> {
  return (await answeredEntries(p)).find((e) => e.question_comment_id === questionCommentId) ?? null;
}

/** C8: the issue's answered questions, oldest first, for the question check. */
export async function answeredForIssue(p: StatePaths, issue: number): Promise<QuestionLogEntry[]> {
  return (await answeredEntries(p)).filter((e) => e.issue === issue);
}
