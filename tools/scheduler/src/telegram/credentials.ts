import { readFile } from "node:fs/promises";
export interface TelegramCredentials {
  bot_token: string;
  chat_id: number;
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
