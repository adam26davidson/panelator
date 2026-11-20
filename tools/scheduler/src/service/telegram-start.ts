import type { Config } from "../config.ts";
import type { CredentialStore } from "../credentials/store.ts";
import { telegramCredentials } from "../telegram/credentials.ts";
import { TelegramClient } from "../telegram/client.ts";
import { telegramChannel } from "../telegram/channel.ts";
/** The channel, with `source` naming where its credentials came from (spec 072 AC-2); `store` absent reads the file. */
export async function startTelegram(
  cfg: Config,
  log: (r: Record<string, unknown>) => void,
  baseUrl?: string,
  store?: CredentialStore,
) {
  const credentials = await telegramCredentials(
    cfg.telegram!.credentials_path,
    store,
  );
  if ("off" in credentials) {
    log({ kind: "telegram", status: "off", reason: credentials.off });
    return null;
  }
  const client = new TelegramClient(
    credentials.bot_token,
    credentials.chat_id,
    baseUrl,
  );
  return Object.assign(telegramChannel(client), { source: credentials.source });
}
export async function telegramCheck(
  cfg: Config,
  baseUrl?: string,
  store?: CredentialStore,
): Promise<string> {
  const credentials = await telegramCredentials(
    cfg.telegram!.credentials_path,
    store,
  );
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
