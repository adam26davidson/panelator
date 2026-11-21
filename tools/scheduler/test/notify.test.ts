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
    const n = TelegramNotifier(new Log099(join099(dir, "service.log")), { telegram: () => chan, alertsPath: join099(dir, "alerts.json"), outboxPath: join099(dir, "outbox.json"), now: () => new Date(), log: (r) => logs.push(r) });
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
  it("queues a refused send, once per outage", async () => {
    const t = await setup099(true);
    try {
      t.server.fail("sendMessage", 500, 2);
      expect(await t.n.notify({ issue: 0, gate: "infra", label: "a", text: "t" })).toEqual({ channel: "queued" });
      expect(await t.n.notify({ issue: 0, gate: "infra", label: "b", text: "t" })).toEqual({ channel: "queued" });
      expect(t.logs.filter((l) => l.kind === "telegram-send-failed")).toHaveLength(1);
      expect(read099(join099(t.dir, "service.log"), "utf8").match(/"kind":"notify"/g)).toHaveLength(2);
    } finally { await t.server.close(); }
  });
  it("queues with Telegram off, and the limiter reports suppressed", async () => {
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
import { existsSync as ex102, readFileSync as rd102, writeFileSync as wr102 } from "node:fs";
import { recordedNotifier } from "../src/notify/recorded.ts";
import { readOutbox, type OutboxEntry } from "../src/notify/telegram.ts";
import type { TelegramChannel } from "../src/telegram/channel.ts";
import { statePaths } from "../src/state/paths.ts";

describe("rateLimited per gate, persisted and re-armed (spec 102 AC-5, AC-6)", () => {
  const H = 3_600_000;
  const t0 = Date.parse("2026-11-21T00:00:00Z");
  function mk(path: string, at: { v: number }, calls: Notification[] = []) {
    const inner: Notifier = { notify: async (x) => { calls.push(x); } };
    return { calls, rl: rateLimited(inner, { hours: 4, repeatHours: 24, path }, () => new Date(at.v)) };
  }
  const dir = () => mkdtempSync(join(tmpdir(), "rl102-"));
  it("a lasting gate repeats after 24 hours, another after 4", async () => {
    const at = { v: t0 };
    const { rl, calls } = mk(join(dir(), "s.json"), at);
    const st = { issue: 0, gate: "standing", label: "f:failed:x", text: "t" };
    const ab = { issue: 3, gate: "abandoned", label: "a", text: "t" };
    await rl.notify(st); await rl.notify(ab);
    at.v = t0 + 5 * H;
    expect(await rl.notify(st)).toEqual({ channel: "suppressed" });
    await rl.notify(ab);
    at.v = t0 + 23 * H;
    await rl.notify(st);
    at.v = t0 + 25 * H;
    await rl.notify(st);
    expect(calls.filter((c) => c.gate === "standing")).toHaveLength(2);
    expect(calls.filter((c) => c.gate === "abandoned")).toHaveLength(2);
  });
  it("survives a restart on the same path and prunes old entries", async () => {
    const path = join(dir(), "s.json");
    const at = { v: t0 };
    await mk(path, at).rl.notify({ issue: 0, gate: "infra", label: "host", text: "t" });
    await mk(path, at).rl.notify({ issue: 0, gate: "abandoned", label: "old", text: "t" });
    at.v = t0 + 2 * H;
    const b = mk(path, at);
    expect(await b.rl.notify({ issue: 0, gate: "infra", label: "host", text: "t" })).toEqual({ channel: "suppressed" });
    expect(Object.keys(JSON.parse(rd102(path, "utf8")))).toContain("0:infra:host");
    at.v = t0 + 30 * H;
    await b.rl.notify({ issue: 1, gate: "abandoned", label: "z", text: "t" });
    expect(Object.keys(JSON.parse(rd102(path, "utf8")))).toEqual(["1:abandoned:z"]);
  });
  it("clear re-arms by label prefix and touches nothing else, writing only on a match", async () => {
    const path = join(dir(), "s.json");
    const at = { v: t0 };
    const { rl, calls } = mk(path, at);
    const st = { issue: 0, gate: "standing", label: "f:failed:x", text: "t" };
    await rl.notify(st);
    const before = rd102(path, "utf8");
    wr102(path, before + " ");
    await rl.clear!({ issue: 0, gate: "infra", label: "f:failed:x" });
    await rl.clear!({ issue: 1, gate: "standing", labelPrefix: "f:failed:" });
    await rl.clear!({ issue: 0, gate: "standing", labelPrefix: "g:" });
    expect(rd102(path, "utf8")).toBe(before + " ");
    expect(await rl.notify(st)).toEqual({ channel: "suppressed" });
    await rl.clear!({ issue: 0, gate: "standing", labelPrefix: "f:failed:" });
    await rl.notify(st);
    expect(calls).toHaveLength(2);
  });
  it("forwards flush and clear through rateLimited and recordedNotifier", async () => {
    const seen: string[] = [];
    const inner: Notifier = { notify: async () => {}, flush: async () => { seen.push("flush"); return 3; }, clear: async (s) => { seen.push(`clear:${s.gate}`); } };
    const paths = statePaths(dir());
    const chain = rateLimited(recordedNotifier(inner, paths), { hours: 4, repeatHours: 24, path: join(dir(), "s.json") });
    expect(await chain.flush!()).toBe(3);
    await chain.clear!({ issue: 0, gate: "x" });
    expect(seen).toEqual(["flush", "clear:x"]);
  });
});

describe("TelegramNotifier outbox (spec 102 AC-1 to AC-3, AC-6, AC-8)", () => {
  function stub(opts: { failAfter?: number; failAll?: boolean } = {}) {
    const sent: { text: string; replyTo?: number; markup?: unknown }[] = [];
    let calls = 0;
    const state = { ...opts };
    const chan = { sendReply: async (text: string, replyTo?: number, markup?: unknown) => {
      calls++;
      if (state.failAll || (state.failAfter !== undefined && calls > state.failAfter)) throw new Error("boom");
      sent.push({ text, replyTo, markup });
      return 100 + sent.length;
    } } as unknown as TelegramChannel;
    return { chan, sent, state, calls: () => calls };
  }
  function setup(c: { current: TelegramChannel | null }) {
    const dir = mkdtempSync(join(tmpdir(), "ob102-"));
    const logs: Record<string, unknown>[] = [];
    const service = join(dir, "service.log");
    const clock = { v: Date.parse("2026-11-21T10:00:00Z") };
    const tn = TelegramNotifier(new LogNotifier(service), { telegram: () => c.current, alertsPath: join(dir, "alerts.json"), outboxPath: join(dir, "outbox.json"), now: () => new Date(clock.v), log: (r) => logs.push(r) });
    const box = () => readOutbox(join(dir, "outbox.json"));
    const lines = () => rd102(service, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { dir, logs, tn, box, lines, clock };
  }
  const ab = (label: string, text = "t", gate = "abandoned") => ({ issue: 5, gate, label, text });

  it("AC-1: the question gates are logged only", async () => {
    const s = stub(); const t = setup({ current: s.chan });
    expect(await t.tn.notify(ab("q", "t", "question"))).toEqual({ channel: "log" });
    expect(await t.tn.notify(ab("q", "t", "question-reminder"))).toEqual({ channel: "log" });
    expect(s.calls()).toBe(0);
    expect(await t.box()).toEqual([]);
    expect(t.lines().map((l) => l.channel)).toEqual(["log", "log"]);
    expect(await t.tn.notify(ab("x"))).toEqual({ channel: "telegram" });
    expect(s.calls()).toBe(1);
  });
  it("AC-2: Telegram off queues with the seven fields; the same identity updates the entry", async () => {
    const t = setup({ current: null });
    expect(await t.tn.notify(ab("x", "one"))).toEqual({ channel: "queued" });
    t.clock.v += 1000;
    await t.tn.notify(ab("x", "two"));
    expect(await t.box()).toEqual([{ identity: "5:abandoned:x", issue: 5, gate: "abandoned", label: "x", text: "two", queued_at: "2026-11-21T10:00:00.000Z", repeats: 2 }]);
    expect(t.lines().map((l) => l.channel)).toEqual(["queued", "queued"]);
  });
  it("AC-2: a throwing channel queues, logs one failure per outage, and a success resets the flag", async () => {
    const s = stub({ failAll: true }); const t = setup({ current: s.chan });
    expect(await t.tn.notify(ab("a"))).toEqual({ channel: "queued" });
    expect(await t.tn.notify(ab("b"))).toEqual({ channel: "queued" });
    expect(t.logs.filter((l) => l.kind === "telegram-send-failed")).toHaveLength(1);
    expect((await t.box()).map((e) => e.label)).toEqual(["a", "b"]);
    s.state.failAll = false;
    expect(await t.tn.flush!()).toBe(2);
    s.state.failAll = true;
    await t.tn.notify(ab("c"));
    expect(t.logs.filter((l) => l.kind === "telegram-send-failed")).toHaveLength(2);
  });
  it("AC-2: the 101st entry drops the oldest", async () => {
    const t = setup({ current: null });
    for (let i = 0; i < 101; i++) await t.tn.notify(ab(`l${i}`));
    const box = await t.box();
    expect(box).toHaveLength(100);
    expect(box[0]!.label).toBe("l1");
    expect(t.logs.filter((l) => l.kind === "telegram-outbox-dropped")).toMatchObject([{ identity: "5:abandoned:l0" }]);
  });
  it("AC-3, AC-8: flush sends oldest first with the queued line, records ids, logs, no markup", async () => {
    const c = { current: null as TelegramChannel | null };
    const t = setup(c);
    await t.tn.notify(ab("a", "ta")); await t.tn.notify(ab("a", "ta")); await t.tn.notify(ab("b", "tb"));
    const s = stub(); c.current = s.chan;
    expect(await t.tn.flush!()).toBe(2);
    expect(s.sent.map((m) => m.text)).toEqual([
      "abandoned: a #5\nqueued 2026-11-21T10:00:00.000Z, repeated 2 times\n\nta",
      "abandoned: b #5\nqueued 2026-11-21T10:00:00.000Z\n\ntb",
    ]);
    for (const m of s.sent) { expect(m.markup).toBeUndefined(); expect(m.replyTo).toBeUndefined(); expect(m.text).not.toContain("@"); }
    expect(await t.box()).toEqual([]);
    expect(await readAlertIds(join(t.dir, "alerts.json"))).toEqual([101, 102]);
    expect(t.logs.filter((l) => l.kind === "telegram-outbox-sent")).toHaveLength(2);
    expect(await t.tn.flush!()).toBe(0);
  });
  it("AC-3: a throw on the second send leaves only the second queued; a later flush sends it", async () => {
    const c = { current: null as TelegramChannel | null };
    const t = setup(c);
    await t.tn.notify(ab("a")); await t.tn.notify(ab("b"));
    const s = stub({ failAfter: 1 }); c.current = s.chan;
    expect(await t.tn.flush!()).toBe(1);
    expect((await t.box()).map((e) => e.label)).toEqual(["b"]);
    expect(t.logs.filter((l) => l.kind === "telegram-send-failed")).toHaveLength(1);
    const ok = stub(); c.current = ok.chan;
    expect(await t.tn.flush!()).toBe(1);
    expect(await t.box()).toEqual([]);
  });
  it("AC-3: flush with Telegram off returns 0; a new notice goes after the queued ones, or behind them when the flush fails", async () => {
    const c = { current: null as TelegramChannel | null };
    const t = setup(c);
    expect(await t.tn.flush!()).toBe(0);
    await t.tn.notify(ab("a"));
    const s = stub(); c.current = s.chan;
    expect(await t.tn.notify(ab("b"))).toEqual({ channel: "telegram" });
    expect(s.sent.map((m) => m.text.split("\n")[0])).toEqual(["abandoned: a #5", "abandoned: b #5"]);
    c.current = null;
    await t.tn.notify(ab("c"));
    const bad = stub({ failAll: true }); c.current = bad.chan;
    expect(await t.tn.notify(ab("d"))).toEqual({ channel: "queued" });
    expect((await t.box()).map((e) => e.label)).toEqual(["c", "d"]);
    expect(bad.calls()).toBe(1);
  });
  it("AC-6: a clear stamps a queued entry and flush says cleared; a repeat before the flush removes the stamp; no match writes nothing", async () => {
    const c = { current: null as TelegramChannel | null };
    const t = setup(c);
    await t.tn.notify({ issue: 0, gate: "infra", label: "host", text: "paused" });
    t.clock.v += 60_000;
    await t.tn.clear!({ issue: 0, gate: "infra", label: "host" });
    const box = await t.box();
    expect(box).toHaveLength(1);
    expect(box[0]!.cleared_at).toBe("2026-11-21T10:01:00.000Z");
    const file = join(t.dir, "outbox.json");
    const before = rd102(file, "utf8");
    wr102(file, before + " ");
    await t.tn.clear!({ issue: 0, gate: "infra", label: "other" });
    await t.tn.clear!({ issue: 0, gate: "infra", label: "host" });
    expect(rd102(file, "utf8")).toBe(before + " ");
    await t.tn.notify({ issue: 0, gate: "infra", label: "host", text: "again" });
    const again = (await t.box())[0] as OutboxEntry;
    expect(again.repeats).toBe(2);
    expect(again.cleared_at).toBeUndefined();
    await t.tn.clear!({ issue: 0, gate: "infra", label: "host" });
    const s = stub(); c.current = s.chan;
    await t.tn.flush!();
    expect(s.sent[0]!.text).toBe("infra: host\nqueued 2026-11-21T10:00:00.000Z, repeated 2 times, cleared 2026-11-21T10:01:00.000Z\n\nagain");
  });
  it("AC-6: the standing clear leaves the filer's queued notice and its sent entry alone", async () => {
    const c = { current: null as TelegramChannel | null };
    const dir = mkdtempSync(join(tmpdir(), "chain102-"));
    const paths = statePaths(dir);
    const { ensureStateDirs } = await import("../src/state/paths.ts");
    await ensureStateDirs(paths);
    const tn = TelegramNotifier(new LogNotifier(paths.serviceLog), { telegram: () => c.current, alertsPath: paths.telegramAlerts, outboxPath: paths.telegramOutbox, now: () => new Date(), log: () => {} });
    const chain = rateLimited(recordedNotifier(tn, paths), { hours: 4, repeatHours: 24, path: paths.notifySent });
    const f = { issue: 0, gate: "standing", label: "findings-filer:ref1", text: "advisory" };
    expect(await chain.notify(f)).toEqual({ channel: "queued" });
    const before = await readOutbox(paths.telegramOutbox);
    await chain.clear!({ issue: 0, gate: "standing", labelPrefix: "findings-filer:failed:" });
    expect(await readOutbox(paths.telegramOutbox)).toEqual(before);
    expect(before[0]!.cleared_at).toBeUndefined();
    expect(await chain.notify(f)).toEqual({ channel: "suppressed" });
    const s = stub(); c.current = s.chan;
    expect(await chain.flush!()).toBe(1);
    expect(s.sent[0]!.text).not.toContain("cleared");
  });
  it("AC-2, AC-3: the event store holds only the two queued contacts after a flush", async () => {
    const c = { current: null as TelegramChannel | null };
    const dir = mkdtempSync(join(tmpdir(), "ev102-"));
    const paths = statePaths(dir);
    const { ensureStateDirs } = await import("../src/state/paths.ts");
    await ensureStateDirs(paths);
    const tn = TelegramNotifier(new LogNotifier(paths.serviceLog), { telegram: () => c.current, alertsPath: paths.telegramAlerts, outboxPath: paths.telegramOutbox, now: () => new Date(), log: () => {} });
    const chain = rateLimited(recordedNotifier(tn, paths), { hours: 4, repeatHours: 24, path: paths.notifySent });
    await chain.notify({ issue: 5, gate: "abandoned", label: "a", text: "one" });
    await chain.notify({ issue: 6, gate: "abandoned", label: "b", text: "two" });
    const s = stub(); c.current = s.chan;
    expect(await chain.flush!()).toBe(2);
    const { readdirSync } = await import("node:fs");
    const contacts = readdirSync(paths.events).filter((f) => f.endsWith(".jsonl")).flatMap((f) => rd102(join(paths.events, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((e) => e.kind === "maintainer.contact");
    expect(contacts.map((e) => e.payload.channel)).toEqual(["queued", "queued"]);
  });
});
