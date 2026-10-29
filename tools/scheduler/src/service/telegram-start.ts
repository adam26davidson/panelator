import type { Config } from "../config.ts";
import { readTelegramCredentials } from "../telegram/credentials.ts";
import { TelegramClient, isAuthError } from "../telegram/client.ts";
import { telegramChannel } from "../telegram/channel.ts";
export async function startTelegram(
  cfg: Config,
  log: (r: Record<string, unknown>) => void,
  baseUrl?: string,
) {
  const credentials = await readTelegramCredentials(
    cfg.telegram!.credentials_path,
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
): Promise<string> {
  const credentials = await readTelegramCredentials(
    cfg.telegram!.credentials_path,
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
