import { readFile, writeFile, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { TelegramClient, type TelegramUpdate } from "./client.ts";
export async function saveJson(path: string, value: unknown) {
  await writeFile(path + ".tmp", JSON.stringify(value));
  await rename(path + ".tmp", path);
}
export class TelegramPoller {
  private controller = new AbortController();
  private running: Promise<void> | null = null;
  private foreign = new Set<number>();
  private client: TelegramClient;
  private offsetPath: string;
  private timeout: number;
  private onUpdate: (u: TelegramUpdate) => Promise<void>;
  private log: (r: Record<string, unknown>) => void;
  private sleep?: (ms: number) => Promise<void>;
  private afterConfirm?: (u: TelegramUpdate) => Promise<void>;
  constructor(
    client: TelegramClient,
    offsetPath: string,
    timeout: number,
    onUpdate: (u: TelegramUpdate) => Promise<void>,
    log: (r: Record<string, unknown>) => void,
    sleep?: (ms: number) => Promise<void>,
    afterConfirm?: (u: TelegramUpdate) => Promise<void>,
  ) {
    this.sleep = sleep;
    this.afterConfirm = afterConfirm;
    this.client = client;
    this.offsetPath = offsetPath;
    this.timeout = timeout;
    this.onUpdate = onUpdate;
    this.log = log;
  }
  start() {
    this.running ??= this.loop();
  }
  async stop() {
    this.controller.abort();
    await this.running;
  }
  private async loop() {
    let offset = JSON.parse(
      await readFile(this.offsetPath, "utf8").catch(
        () => '{"next_update_id":0}',
      ),
    ).next_update_id as number;
    let backoff = 1;
    let outage = false;
    while (!this.controller.signal.aborted) {
      try {
        const updates = await this.client.getUpdates({
          offset,
          timeout: this.timeout,
          signal: this.controller.signal,
        });
        if (outage) {
          this.log({ kind: "telegram-recovered" });
          outage = false;
        }
        backoff = 1;
        for (const u of updates.sort((a, b) => a.update_id - b.update_id)) {
          if (this.controller.signal.aborted) break;
          if (u.update_id < offset) continue;
          const chat =
            u.message?.chat.id ??
            u.callback_query?.message?.chat.id ??
            u.edited_message?.chat.id;
          if (chat !== this.client.chatId) {
            if (chat !== undefined && !this.foreign.has(chat)) {
              this.foreign.add(chat);
              this.log({ kind: "telegram-foreign-chat", chat_id: chat });
            }
          } else await this.onUpdate(u);
          if (this.controller.signal.aborted) break;
          await saveJson(this.offsetPath, { next_update_id: u.update_id + 1 });
          offset = u.update_id + 1;
          await this.afterConfirm?.(u);
        }
      } catch {
        if (this.controller.signal.aborted) break;
        if (!outage) {
          outage = true;
          this.log({ kind: "telegram-outage" });
        }
        try {
          if (this.sleep) await this.sleep(backoff * 1000);
          else
            await delay(backoff * 1000, undefined, {
              signal: this.controller.signal,
            });
        } catch {
          /* stopping */
        }
        backoff = Math.min(60, backoff * 2);
      }
    }
  }
}
