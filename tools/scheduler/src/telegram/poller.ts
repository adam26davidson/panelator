import { readFile, writeFile, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { UpdateDeferred } from "./answers.ts";
import { TelegramClient, type TelegramUpdate } from "./client.ts";
export async function saveJson(path: string, value: unknown) {
  await writeFile(path + ".tmp", JSON.stringify(value));
  await rename(path + ".tmp", path);
}
export const HANDLER_RETRY_MS = 2000;
export class TelegramPoller {
  private controller = new AbortController();
  private running: Promise<void> | null = null;
  private foreign = new Set<number>();
  private deferred = new Set<number>();
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
  private async pause(ms: number) {
    try {
      if (this.sleep) await this.sleep(ms);
      else await delay(ms, undefined, { signal: this.controller.signal });
    } catch {
      /* stopping */
    }
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
        let handlerFailed = false;
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
          } else {
            try {
              await this.onUpdate(u);
            } catch (e) {
              if (e instanceof UpdateDeferred) {
                if (!this.deferred.has(u.update_id)) {
                  this.deferred.add(u.update_id);
                  this.log({
                    kind: "telegram-update-deferred",
                    update_id: u.update_id,
                  });
                }
              } else
                this.log({
                  kind: "telegram-handler-failed",
                  update_id: u.update_id,
                  error: e instanceof Error ? e.message : String(e),
                });
              handlerFailed = true;
              break;
            }
          }
          if (this.controller.signal.aborted) break;
          await saveJson(this.offsetPath, { next_update_id: u.update_id + 1 });
          offset = u.update_id + 1;
          await this.afterConfirm?.(u);
        }
        if (handlerFailed) await this.pause(HANDLER_RETRY_MS);
      } catch {
        if (this.controller.signal.aborted) break;
        if (!outage) {
          outage = true;
          this.log({ kind: "telegram-outage" });
        }
        await this.pause(backoff * 1000);
        backoff = Math.min(60, backoff * 2);
      }
    }
  }
}
