import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { notifierChain } from "../src/notify/chain.ts";
import { CONTACTS_KEPT, recordedNotifier } from "../src/notify/recorded.ts";
import { rateLimited } from "../src/notify/rate-limit.ts";
import { TelegramNotifier } from "../src/notify/telegram.ts";
import type { Notification, Notifier } from "../src/notify/types.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { fakeChannel } from "./helpers/fake-channel.ts";
import { installEnospc, type EnospcSwitch } from "./helpers/enospc-fs.mjs";

let sw: EnospcSwitch | undefined;
afterEach(() => sw?.restore());

const n: Notification = { issue: 0, gate: "infra", label: "host", text: "paused" };
const contacts = (events: string): { at: string; payload: { channel: string } }[] => {
  try {
    return readdirSync(events).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(events, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((e) => e.kind === "maintainer.contact");
  } catch { return []; }
};

async function world(channel: () => ReturnType<typeof fakeChannel> | null) {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "panelator-test-chain-")));
  await ensureStateDirs(paths);
  const logged: Record<string, unknown>[] = [];
  let t = Date.parse("2026-11-22T23:00:00Z");
  const now = () => new Date((t += 1000));
  const chain = notifierChain({ paths, telegram: channel, now, log: (r) => logged.push(r), hours: 6, repeatHours: 24 });
  sw = installEnospc(paths.root);
  return { paths, chain, logged };
}

describe("notifierChain on a volume that takes no writes (spec 114 AC-5)", () => {
  it("a sent message is delivered; its contact event is kept and written later", async () => {
    const ch = fakeChannel();
    const w = await world(() => ch);
    expect(await w.chain.notify(n)).toEqual({ channel: "telegram" });
    expect(await w.chain.notify(n)).toEqual({ channel: "suppressed" });
    expect(ch.sent).toHaveLength(1);
    sw!.on = false;
    await w.chain.flush!();
    await w.chain.flush!();
    const c = contacts(w.paths.events);
    expect(c).toHaveLength(1);
    expect(c[0]!.payload.channel).toBe("telegram");
    expect(c[0]!.at).toMatch(/^2026-11-22T23:00:0\d\./);
  });

  for (const how of ["send throws", "no channel"]) {
    it(`a notice neither sent nor queued rejects and is sent on the next call (${how})`, async () => {
      const ch = fakeChannel();
      let first = true;
      const w = await world(() => {
        if (how === "no channel" && first) return null;
        return ch;
      });
      if (how === "send throws") ch.failNext = 1;
      await expect(w.chain.notify(n)).rejects.toMatchObject({ code: "ENOSPC" });
      first = false;
      expect(await w.chain.notify(n)).toEqual({ channel: "telegram" });
      expect(ch.sent).toHaveLength(1);
      expect(w.logged.filter((r) => String(r.error).startsWith("notify undelivered: 0:infra:host:"))).toHaveLength(1);
      sw!.on = false;
      await w.chain.flush!();
      expect(contacts(w.paths.events)).toHaveLength(1);
    });
  }
});

describe("pieces", () => {
  it("keeps at most CONTACTS_KEPT events and logs a dropped non-space record error once", async () => {
    const paths = statePaths(mkdtempSync(join(tmpdir(), "panelator-test-rec-")));
    await ensureStateDirs(paths);
    const logged: Record<string, unknown>[] = [];
    const inner: Notifier = { notify: async () => ({ channel: "telegram" }) };
    const rec = recordedNotifier(inner, paths, () => new Date("2026-11-22T00:00:00Z"), (r) => logged.push(r));
    sw = installEnospc(paths.root);
    for (let i = 0; i < CONTACTS_KEPT + 5; i++) await rec.notify({ ...n, label: `l${i}` });
    sw.on = false;
    await rec.flush!();
    expect(contacts(paths.events)).toHaveLength(CONTACTS_KEPT);
    expect(logged.filter((r) => String(r.error).startsWith("notify record:"))).toHaveLength(1);
    const bad = recordedNotifier(inner, paths, () => new Date("not a date"), (r) => logged.push(r));
    await expect(bad.notify(n)).resolves.toEqual({ channel: "telegram" });
    expect(logged.at(-1)!.error).toMatch(/^notify record:/);
  });

  it("the rate limiter puts back the entry of an identity whose notify rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panelator-test-rl-"));
    let fail = true;
    const inner: Notifier = { notify: async () => { if (fail) throw new Error("boom"); return { channel: "telegram" }; } };
    const rl = rateLimited(inner, { hours: 1, repeatHours: 1, path: join(dir, "sent.json") });
    await expect(rl.notify(n)).rejects.toThrow("boom");
    fail = false;
    expect(await rl.notify(n)).toEqual({ channel: "telegram" });
    expect(await rl.notify(n)).toEqual({ channel: "suppressed" });
    let t = Date.parse("2026-01-01T00:00:00Z");
    const rl2 = rateLimited(inner, { hours: 1, repeatHours: 1, path: join(dir, "sent2.json") }, () => new Date(t));
    await rl2.notify(n);
    t += 2 * 3600_000;
    fail = true;
    await expect(rl2.notify(n)).rejects.toThrow("boom");
    fail = false;
    expect(await rl2.notify(n)).toEqual({ channel: "telegram" });
  });

  it("an outbox failure that is not a space failure still resolves { channel: log }", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panelator-test-ob-"));
    const logged: Record<string, unknown>[] = [];
    const inner: Notifier = { notify: async () => ({ channel: "log" }) };
    const tn = TelegramNotifier(inner, { telegram: () => null, alertsPath: join(dir, "a.json"), outboxPath: dir, now: () => new Date(), log: (r) => logged.push(r) });
    expect(await tn.notify(n)).toEqual({ channel: "log" });
  });
});
