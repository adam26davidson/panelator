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
    const rl = rateLimited(inner, { hours: 4, repeatHours: 24, path: join(mkdtempSync(join(tmpdir(), "rl-")), "sent.json") }, () => now);
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
    const rl = rateLimited(inner, { hours: 4, repeatHours: 24, path: join(mkdtempSync(join(tmpdir(), "rl-")), "sent.json") }, () => new Date());
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
import { TelegramNotifier, readAlertIds, readOutbox } from "../src/notify/telegram.ts";
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
    const n = TelegramNotifier(new Log099(join099(dir, "service.log")), { telegram: () => chan, alertsPath: join099(dir, "alerts.json"), outboxPath: join099(dir, "outbox.json"), log: (r) => logs.push(r) });
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
  it("queues a refused send, once per outage, retrying nothing now", async () => {
    const t = await setup099(true);
    try {
      t.server.fail("sendMessage", 500, 2);
      expect(await t.n.notify({ issue: 0, gate: "infra", label: "a", text: "t" })).toEqual({ channel: "queued" });
      expect(await t.n.notify({ issue: 0, gate: "infra", label: "b", text: "t" })).toEqual({ channel: "queued" });
      expect((await readOutbox(join099(t.dir, "outbox.json"))).map((e) => e.label)).toEqual(["a", "b"]);
      expect(t.logs.filter((l) => l.kind === "telegram-send-failed")).toHaveLength(1);
      expect(read099(join099(t.dir, "service.log"), "utf8").match(/"kind":"notify"/g)).toHaveLength(2);
    } finally { await t.server.close(); }
  });
  it("is the log chain with Telegram off, and the limiter reports suppressed", async () => {
    const t = await setup099(false);
    try {
      const lim = rl099(t.n, { hours: 1, repeatHours: 24, path: join099(t.dir, "sent.json") });
      expect(await lim.notify({ issue: 0, gate: "g", label: "l", text: "t" })).toEqual({ channel: "queued" });
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

// ---- spec 102 ----
import { statePaths } from "../src/state/paths.ts";
import { recordedNotifier } from "../src/notify/recorded.ts";
import { readdirSync } from "node:fs";

describe("spec 102 notices", () => {
  const setup = async (on = true) => {
    const dir = mkd099(join099(tmp099(), "tg102-"));
    const server = await fake099();
    const logs: Record<string, unknown>[] = [];
    let chan = on ? telegramChannel(new TelegramClient("secret", 42, server.url)) : null;
    const paths = statePaths(join099(dir, "state"));
    let now = new Date("2026-11-21T00:00:00Z");
    const tn = TelegramNotifier(new Log099(join099(dir, "service.log")), { telegram: () => chan, alertsPath: join099(dir, "alerts.json"), outboxPath: join099(dir, "outbox.json"), log: (r) => logs.push(r), clock: () => now });
    return { dir, server, logs, tn, paths, attach: () => { chan = telegramChannel(new TelegramClient("secret", 42, server.url)); }, tick: (ms: number) => { now = new Date(now.getTime() + ms); }, outbox: () => readOutbox(join099(dir, "outbox.json")), serviceLog: () => read099(join099(dir, "service.log"), "utf8") };
  };
  const nn = (gate: string, label = "l", issue = 3) => ({ issue, gate, label, text: `text ${label}` });

  it("AC-1: question gates go to the log only; abandoned is sent", async () => {
    const t = await setup();
    try {
      expect(await t.tn.notify(nn("question"))).toEqual({ channel: "log" });
      expect(await t.tn.notify(nn("question-reminder"))).toEqual({ channel: "log" });
      expect(t.server.requests.filter((r) => r.method === "sendMessage")).toHaveLength(0);
      expect(t.serviceLog().match(/"channel":"log"/g)).toHaveLength(2);
      expect(await t.tn.notify(nn("abandoned"))).toEqual({ channel: "telegram" });
      expect(t.server.requests.filter((r) => r.method === "sendMessage")).toHaveLength(1);
    } finally { await t.server.close(); }
  });

  it("AC-2: Telegram off queues with channel queued, merges repeats, caps at 100", async () => {
    const t = await setup(false);
    try {
      expect(await t.tn.notify(nn("abandoned", "a"))).toEqual({ channel: "queued" });
      expect(t.serviceLog()).toContain('"channel":"queued"');
      t.tick(60_000);
      await t.tn.notify({ ...nn("abandoned", "a"), text: "newer" });
      const box = await t.outbox();
      expect(box).toEqual([{ identity: "3:abandoned:a", issue: 3, gate: "abandoned", label: "a", text: "newer", queued_at: "2026-11-21T00:00:00.000Z", repeats: 2 }]);
      for (let i = 0; i < 100; i++) await t.tn.notify(nn("abandoned", `x${i}`));
      expect(await t.outbox()).toHaveLength(100);
      expect((await t.outbox())[0].label).toBe("x0");
      expect(t.logs.filter((l) => l.kind === "telegram-outbox-dropped")).toEqual([expect.objectContaining({ identity: "3:abandoned:a" })]);
    } finally { await t.server.close(); }
  });

  it("AC-2: a throwing channel queues with one telegram-send-failed", async () => {
    const t = await setup();
    try {
      t.server.fail("sendMessage", 500, 5);
      expect(await t.tn.notify(nn("infra", "a"))).toEqual({ channel: "queued" });
      expect(await t.tn.notify(nn("infra", "b"))).toEqual({ channel: "queued" });
      expect(t.logs.filter((l) => l.kind === "telegram-send-failed")).toHaveLength(1);
      expect(await t.outbox()).toHaveLength(2);
    } finally { await t.server.close(); }
  });

  it("AC-3, AC-8: flush sends oldest first with the queued line, no markup, no contact event", async () => {
    const t = await setup(false);
    try {
      const rec = recordedNotifier(t.tn, t.paths);
      await rec.notify(nn("abandoned", "a"));
      await rec.notify(nn("abandoned", "a"));
      t.tick(1000);
      await rec.notify(nn("chain_error", "b"));
      expect(await rec.flush!()).toBe(0);
      t.attach();
      expect(await rec.flush!()).toBe(2);
      const sent = t.server.sent;
      expect(sent.map((m) => m.text)).toEqual([
        "abandoned: a #3\n\nqueued 2026-11-21T00:00:00.000Z, repeated 2 times\n\ntext a",
        "chain_error: b #3\n\nqueued 2026-11-21T00:00:01.000Z\n\ntext b",
      ]);
      for (const m of sent) { expect(m.reply_markup).toBeUndefined(); expect(String(m.text)).not.toContain("@"); }
      expect(await t.outbox()).toEqual([]);
      expect((await readAlertIds(join099(t.dir, "alerts.json"))).length).toBe(2);
      expect(t.logs.filter((l) => l.kind === "telegram-outbox-sent")).toHaveLength(2);
      const events = readdirSync(join099(t.paths.root, "events"), { recursive: true }).length;
      expect(events).toBeGreaterThan(0);
      const all = (await import("node:fs")).readdirSync(join099(t.paths.root, "events"), { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => read099(join099(d.parentPath, d.name), "utf8")).join("");
      expect(all.match(/maintainer\.contact/g)).toHaveLength(3);
    } finally { await t.server.close(); }
  });

  it("AC-3: a throw on the second send leaves it queued; a new notice goes after the queue", async () => {
    const t = await setup(false);
    try {
      await t.tn.notify(nn("abandoned", "a"));
      await t.tn.notify(nn("abandoned", "b"));
      t.attach();
      t.server.fail("sendMessage", 500, 1);
      // first send fails: nothing flushed
      expect(await t.tn.flush!()).toBe(0);
      expect((await t.outbox()).map((e) => e.label)).toEqual(["a", "b"]);
      expect(await t.tn.flush!()).toBe(2);
      await t.tn.notify(nn("abandoned", "c"));
      await t.tn.notify(nn("abandoned", "d"));
      expect(t.server.sent.map((m) => String(m.text).split("\n")[0])).toEqual(["abandoned: a #3", "abandoned: b #3", "abandoned: c #3", "abandoned: d #3"]);
    } finally { await t.server.close(); }
  });

  it("AC-3: a new notice with a non-empty outbox is sent after the queued ones", async () => {
    const t = await setup(false);
    try {
      await t.tn.notify(nn("infra", "old"));
      t.attach();
      expect(await t.tn.notify(nn("infra", "new"))).toEqual({ channel: "telegram" });
      expect(t.server.sent.map((m) => String(m.text).split("\n")[0])).toEqual(["infra: old #3", "infra: new #3"]);
    } finally { await t.server.close(); }
  });

  it("AC-6: clear removes matching outbox entries and forwards through the chain", async () => {
    const t = await setup(false);
    try {
      const chain = rateLimited(recordedNotifier(t.tn, t.paths), { hours: 4, repeatHours: 24, path: t.paths.notifySent });
      await chain.notify({ issue: 0, gate: "standing", label: "f:failed:x", text: "t" });
      await chain.notify({ issue: 0, gate: "infra", label: "f:outage", text: "t" });
      await chain.clear!({ issue: 0, gate: "standing", labelPrefix: "f:" });
      expect((await t.outbox()).map((e) => e.gate)).toEqual(["infra"]);
      await chain.clear!({ issue: 0, gate: "abandoned", labelPrefix: "f:" });
      expect(await t.outbox()).toHaveLength(1);
      expect(await chain.notify({ issue: 0, gate: "standing", label: "f:failed:x", text: "t" })).toEqual({ channel: "queued" });
    } finally { await t.server.close(); }
  });
});

describe("spec 102 rateLimited windows (AC-5, AC-6)", () => {
  const rec = () => { const calls: Notification[] = []; return { calls, notify: async (x: Notification) => { calls.push(x); } } as Notifier & { calls: Notification[] }; };
  const mk = () => mkdtempSync(join(tmpdir(), "rl102-"));
  const base = Date.parse("2026-11-21T00:00:00Z");
  const h = (x: number) => new Date(base + x * 3_600_000);
  it("lasting gates repeat at repeatHours, others at hours", async () => {
    const path = join(mk(), "sent.json");
    let now = h(0);
    const inner = rec();
    const rl = rateLimited(inner, { hours: 4, repeatHours: 24, path }, () => now);
    const st = { issue: 0, gate: "standing", label: "f:failed:x", text: "t" };
    const ab = { issue: 1, gate: "abandoned", label: "l", text: "t" };
    const res: string[] = [];
    for (const x of [0, 5, 23, 25]) { now = h(x); res.push((await rl.notify(st))?.channel ?? "sent"); }
    expect(inner.calls).toHaveLength(2);
    expect(res[1]).toBe("suppressed");
    expect(res[2]).toBe("suppressed");
    const inner2 = rec();
    const rl2 = rateLimited(inner2, { hours: 4, repeatHours: 24, path: join(mk(), "s.json") }, () => now);
    now = h(0); await rl2.notify(ab); now = h(5); await rl2.notify(ab);
    expect(inner2.calls).toHaveLength(2);
  });
  it("persists the sent map across instances, prunes, and clear re-arms", async () => {
    const path = join(mk(), "sent.json");
    let now = h(0);
    const a = rateLimited(rec(), { hours: 4, repeatHours: 24, path }, () => now);
    const st = { issue: 0, gate: "standing", label: "f:failed:x", text: "t" };
    await a.notify(st);
    now = h(1);
    const inner = rec();
    const b = rateLimited(inner, { hours: 4, repeatHours: 24, path }, () => now);
    expect(await b.notify(st)).toEqual({ channel: "suppressed" });
    await b.clear!({ issue: 0, gate: "infra", labelPrefix: "f:" });
    expect(await b.notify(st)).toEqual({ channel: "suppressed" });
    await b.clear!({ issue: 0, gate: "standing", labelPrefix: "f:" });
    await b.notify(st);
    expect(inner.calls).toHaveLength(1);
    now = h(100);
    await b.notify({ ...st, label: "other" });
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual(["0:standing:other"]);
  });
});
