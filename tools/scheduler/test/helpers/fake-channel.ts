import type { TelegramChannel } from "../../src/telegram/channel.ts";

/** A Telegram channel that records `sendReply` texts; `failNext` makes the next n sends throw. */
export function fakeChannel(): TelegramChannel & { sent: string[]; failNext: number } {
  const ch = {
    sent: [] as string[],
    failNext: 0,
    async sendReply(text: string): Promise<number> {
      if (ch.failNext > 0) { ch.failNext--; throw new Error("send failed"); }
      ch.sent.push(text);
      return ch.sent.length;
    },
  };
  return ch as unknown as TelegramChannel & { sent: string[]; failNext: number };
}
