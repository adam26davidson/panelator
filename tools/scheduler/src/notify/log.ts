import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Notification, Notifier } from "./types.ts";
import type { StatePaths } from "../state/paths.ts";
import { record } from "../events/store.ts";

/** v0 implementation (spec section 15): one JSON line per notification in the service log. */
export class LogNotifier implements Notifier {
  readonly path: string;
  readonly paths: StatePaths | undefined;
  constructor(logPath: string, paths?: StatePaths) {
    this.path = logPath;
    this.paths = paths;
  }
  async notify(n: Notification): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify({ kind: "notify", at: new Date().toISOString(), ...n }) + "\n");
    if (this.paths) await record(this.paths, "maintainer.contact", new Date(), { channel: "log", kind: "notification", issue: n.issue, label: n.label || n.gate, text: n.text }, n.issue ? { issue: n.issue } : {});
  }
}
