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

describe("TelegramNotifier (spec 030 AC-9, AC-10)", () => {
  it("sends one message headed by gate and label, then logs channel telegram; a failure logs channel log, warns once per outage and does not retry", async () => {
    const { TelegramNotifier, alertText, readAlertIds } = await import("../src/notify/telegram.ts");
    const dir = mkdtempSync(join(tmpdir(), "notify-tg-"));
    const log = join(dir, "service.log");
    const alerts = join(dir, "alerts.json");
    const sent: string[] = [];
    const warns: unknown[] = [];
    let fail = false;
    const t = new TelegramNotifier(new LogNotifier(log), async (text) => {
      if (fail) throw new Error("down");
      sent.push(text);
      return 100 + sent.length;
    }, alerts, (r) => warns.push(r));
    await t.notify({ issue: 4, gate: "infra", label: "outage", text: "GitHub unreachable" });
    expect(sent).toEqual(["infra / outage (#4)\n\nGitHub unreachable"]);
    expect(alertText({ issue: 0, gate: "standing", label: "x", text: "y" })).toBe("standing / x\n\ny");
    expect(await readAlertIds(alerts)).toEqual([101]);
    fail = true;
    await t.notify({ ...n, issue: 5 });
    await t.notify({ ...n, issue: 6 });
    expect(sent).toHaveLength(1);
    expect(warns).toHaveLength(1);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.channel)).toEqual(["telegram", "log", "log"]);
  });
  it("LogNotifier writes channel log by default", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "notify-")), "s.log");
    await new LogNotifier(p).notify(n);
    expect(JSON.parse(readFileSync(p, "utf8")).channel).toBe("log");
  });
});
