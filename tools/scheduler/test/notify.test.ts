import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LogNotifier } from "../src/notify/log.ts";
import { rateLimited } from "../src/notify/rate-limit.ts";
import type { Notification, Notifier } from "../src/notify/types.ts";

const n: Notification = { issue: 4, gate: "spec-present", label: "needs-spec", text: "missing Verification section" };

describe("LogNotifier", () => {
  it("appends one JSON line per notification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-"));
    const p = join(dir, "service.log");
    const log = new LogNotifier(p);
    await log.notify(n);
    await log.notify({ ...n, issue: 5 });
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: "notify", issue: 4, gate: "spec-present", label: "needs-spec" });
  });
});

describe("rateLimited (AC-27)", () => {
  function recorder(): Notifier & { calls: Notification[] } {
    const calls: Notification[] = [];
    return { calls, notify: async (x) => { calls.push(x); } };
  }
  it("delivers once per identity within the window, then again after it", async () => {
    let now = new Date("2026-10-12T00:00:00Z");
    const inner = recorder();
    const rl = rateLimited(inner, 4, () => now);
    await rl.notify(n);
    await rl.notify({ ...n, text: "different text, same identity" });
    expect(inner.calls).toHaveLength(1);
    now = new Date("2026-10-12T03:59:00Z");
    await rl.notify(n);
    expect(inner.calls).toHaveLength(1);
    now = new Date("2026-10-12T04:01:00Z");
    await rl.notify(n);
    expect(inner.calls).toHaveLength(2);
  });
  it("treats a different issue, gate or label as a different identity", async () => {
    const inner = recorder();
    const rl = rateLimited(inner, 4, () => new Date());
    await rl.notify(n);
    await rl.notify({ ...n, issue: 9 });
    await rl.notify({ ...n, label: "needs-human" });
    expect(inner.calls).toHaveLength(3);
  });
});

// ---- spec 099 AC-6, AC-7 ----
import { mkdtempSync as mkd099 } from "node:fs";
import { tmpdir as tmp099 } from "node:os";
import { join as join099 } from "node:path";
import { readFileSync as read099 } from "node:fs";
import { TelegramNotifier, readAlertIds } from "../src/notify/telegram.ts";
import { telegramChannel } from "../src/telegram/channel.ts";
import { TelegramClient } from "../src/telegram/client.ts";
import { fakeTelegram as fake099 } from "./helpers/fake-telegram.ts";
import { rateLimited as rl099 } from "../src/notify/rate-limit.ts";
import { LogNotifier as Log099 } from "../src/notify/log.ts";

describe("TelegramNotifier (spec 099 AC-6)", () => {
  const setup099 = async (on: boolean) => {
    const dir = mkd099(join099(tmp099(), "tgn-"));
    const server = await fake099();
    const logs: Record<string, unknown>[] = [];
    const chan = on ? telegramChannel(new TelegramClient("secret", 42, server.url)) : null;
    const n = TelegramNotifier(new Log099(join099(dir, "service.log")), { telegram: () => chan, alertsPath: join099(dir, "alerts.json"), log: (r) => logs.push(r) });
    return { dir, server, logs, n };
  };
  it("delivers to the chat as `<gate>: <label> #<issue>`, records the id, and logs the channel", async () => {
    const t = await setup099(true);
    try {
      expect(await t.n.notify({ issue: 7, gate: "infra", label: "disk", text: "full" })).toEqual({ channel: "telegram" });
      const sent = t.server.sent.at(-1)!;
      expect(sent.text).toBe("infra: disk #7\n\nfull");
      expect((await readAlertIds(join099(t.dir, "alerts.json"))).length).toBe(1);
      expect(read099(join099(t.dir, "service.log"), "utf8")).toContain('"channel":"telegram"');
      expect(await t.n.notify({ issue: 0, gate: "infra", label: "x", text: "y" })).toEqual({ channel: "telegram" });
      expect(t.server.sent.at(-1)!.text).toBe("infra: x\n\ny");
    } finally { await t.server.close(); }
  });
  it("falls back to the log on a refused send, once per outage, retrying nothing", async () => {
    const t = await setup099(true);
    try {
      t.server.fail("sendMessage", 500, 2);
      expect(await t.n.notify({ issue: 0, gate: "infra", label: "a", text: "t" })).toEqual({ channel: "log" });
      expect(await t.n.notify({ issue: 0, gate: "infra", label: "b", text: "t" })).toEqual({ channel: "log" });
      expect(t.logs.filter((l) => l.kind === "telegram-send-failed")).toHaveLength(1);
      expect(read099(join099(t.dir, "service.log"), "utf8").match(/"kind":"notify"/g)).toHaveLength(2);
    } finally { await t.server.close(); }
  });
  it("is the log chain with Telegram off, and the limiter reports suppressed", async () => {
    const t = await setup099(false);
    try {
      const lim = rl099(t.n, 1);
      expect(await lim.notify({ issue: 0, gate: "g", label: "l", text: "t" })).toEqual({ channel: "log" });
      expect(await lim.notify({ issue: 0, gate: "g", label: "l", text: "t" })).toEqual({ channel: "suppressed" });
    } finally { await t.server.close(); }
  });
  it("keeps the last 200 alert ids", async () => {
    const t = await setup099(true);
    try {
      for (let i = 0; i < 203; i++) await t.n.notify({ issue: 0, gate: "g", label: String(i), text: "t" });
      expect((await readAlertIds(join099(t.dir, "alerts.json"))).length).toBe(200);
    } finally { await t.server.close(); }
  });
});
