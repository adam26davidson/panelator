import { readFile } from "node:fs/promises";
import type { CredentialStore } from "../credentials/store.ts";
export interface TelegramCredentials {
  bot_token: string;
  chat_id: number;
}
function shaped(raw: unknown): TelegramCredentials | null {
  const r = raw as Partial<TelegramCredentials> | null;
  if (!r || typeof r.bot_token !== "string" || !r.bot_token.trim() || !Number.isSafeInteger(r.chat_id)) return null;
  return { bot_token: r.bot_token, chat_id: r.chat_id! };
}
/** Never return parser/OS errors: those may contain credential data. */
export async function readTelegramCredentials(
  path: string,
): Promise<TelegramCredentials | { off: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { off: "credentials missing, unreadable or invalid JSON" };
  }
  return shaped(raw) ?? { off: "invalid credentials shape" };
}
/** Spec 072 AC-1: the stored `telegram-bot` secret once the index holds it (never falling back to the file), else the file; without a store, the file. */
export async function telegramCredentials(
  path: string,
  store?: CredentialStore,
): Promise<(TelegramCredentials & { source: "store" | "file" }) | { off: string }> {
  let held: boolean;
  try {
    held = !!store && !!(await store.readIndex())["telegram-bot"];
  } catch {
    return { off: "stored telegram-bot credential unreadable" };
  }
  if (!held) {
    const f = await readTelegramCredentials(path);
    return "off" in f ? f : { ...f, source: "file" };
  }
  let text: string;
  try {
    text = await store!.readSecret("telegram-bot");
  } catch {
    return { off: "stored telegram-bot credential unreadable" };
  }
  let parsed: TelegramCredentials | null = null;
  try {
    parsed = shaped(JSON.parse(text));
  } catch {
    /* fall through */
  }
  return parsed ? { ...parsed, source: "store" } : { off: "stored telegram-bot credential has an invalid shape" };
}
