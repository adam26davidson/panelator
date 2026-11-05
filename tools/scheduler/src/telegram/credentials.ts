import { readFile } from "node:fs/promises";
import type { CredentialStore } from "../credentials/store.ts";
export interface TelegramCredentials {
  bot_token: string;
  chat_id: number;
}
/**
 * Spec 030 AC-2: the `telegram-bot` secret from the encrypted store first, the plain file while it still exists.
 * Never return parser/OS errors: those may contain credential data.
 */
export async function readTelegramCredentials(
  path: string,
  store?: CredentialStore,
): Promise<TelegramCredentials | { off: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(store && (await store.has("telegram-bot")) ? await store.readSecret("telegram-bot") : await readFile(path, "utf8"));
  } catch {
    return { off: "credentials missing, unreadable or invalid JSON" };
  }
  const r = raw as Partial<TelegramCredentials> | null;
  if (
    !r ||
    typeof r.bot_token !== "string" ||
    !r.bot_token.trim() ||
    !Number.isSafeInteger(r.chat_id)
  )
    return { off: "invalid credentials shape" };
  return { bot_token: r.bot_token, chat_id: r.chat_id! };
}
