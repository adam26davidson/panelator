import type { CredentialStore } from "../credentials/store.ts";
import type { Config } from "../config.ts";
import { readTelegramCredentials, type TelegramCredentials } from "../telegram/credentials.ts";

/** Spec 030 AC-2: the `telegram-bot` secret from the encrypted store first, the plain file while it still exists. */
async function readCredentials(cfg: Config, store?: CredentialStore): Promise<TelegramCredentials | { off: string }> {
  if (!store || !(await store.has("telegram-bot"))) return readTelegramCredentials(cfg.telegram!.credentials_path);
  let raw: unknown;
  try {
    raw = JSON.parse(await store.readSecret("telegram-bot"));
  } catch {
    return { off: "credentials missing, unreadable or invalid JSON" };
  }
  const r = raw as Partial<TelegramCredentials> | null;
  if (!r || typeof r.bot_token !== "string" || !r.bot_token.trim() || !Number.isSafeInteger(r.chat_id)) return { off: "invalid credentials shape" };
  return { bot_token: r.bot_token, chat_id: r.chat_id! };
}
import { TelegramClient, isAuthError } from "../telegram/client.ts";
import { telegramChannel } from "../telegram/channel.ts";
export async function startTelegram(
  cfg: Config,
  log: (r: Record<string, unknown>) => void,
  baseUrl?: string,
  store?: CredentialStore,
) {
  const credentials = await readCredentials(cfg, store);
  if ("off" in credentials) {
    log({ kind: "telegram", status: "off", reason: credentials.off });
    return null;
  }
  const client = new TelegramClient(
    credentials.bot_token,
    credentials.chat_id,
    baseUrl,
  );
  try {
    const me = await client.getMe();
    log({ kind: "telegram", status: "connected", username: me.username });
    return telegramChannel(client);
  } catch (e) {
    log({
      kind: "telegram",
      status: "off",
      reason: isAuthError(e)
        ? "getMe: unauthorized"
        : "getMe: connection failed",
    });
    return null;
  }
}
export async function telegramCheck(
  cfg: Config,
  baseUrl?: string,
  store?: CredentialStore,
): Promise<string> {
  const credentials = await readCredentials(cfg, store);
  if ("off" in credentials) throw Error(`credentials: ${credentials.off}`);
  const client = new TelegramClient(
    credentials.bot_token,
    credentials.chat_id,
    baseUrl,
  );
  let username: string;
  try {
    username = (await client.getMe()).username;
  } catch {
    throw Error("getMe: failed");
  }
  try {
    await client.sendMessage({ text: "panelator: Telegram channel connected" });
  } catch {
    throw Error("sendMessage: failed");
  }
  return `bot @${username}, chat ${credentials.chat_id}`;
}
