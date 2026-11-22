import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { MAX_CHAIN_FAILURES, Scheduler } from "../src/service/loop.ts";
import { listClaims, writeClaim } from "../src/state/claims.ts";
import { initialChainState, ledgerOf } from "../src/chain/machine.ts";
import { writeLedger } from "../src/state/ledger.ts";
import { watchTickErrors } from "./helpers/tick-errors.ts";
import { issue, routes, setup, settle, dns, serviceRecords, outageSetup } from "./helpers/loop-harness.ts";

describe("Scheduler.tick: transient failures (spec 015)", () => {

  it("postpones a chain that fails on EAI_AGAIN with backoff, spends no chain-failure count and logs the outage once (AC-5, AC-6; issue #29)", async () => {
    let calls = 0;
    let failing = true;
    const t = await outageSetup(async (_d, c) => { calls++; if (failing) throw dns(); return c; });
    const errors: unknown[] = [];
    t.deps.log = (r) => { if (r.kind === "error") errors.push(r); };
    const waits: number[] = [];
    for (let i = 1; i <= MAX_CHAIN_FAILURES + 2; i++) {
      const tick = await t.s.tick();
      await settle();
      expect(tick.released).toEqual([]);
      expect(calls).toBe(i);
      const c = await t.claim();
      expect(c.state.chainFailures).toBeNull();
      expect(c.outage).toMatchObject({ count: i, since: "2026-10-12T12:00:00.000Z", last: "getaddrinfo EAI_AGAIN api.github.com", alarmed: false });
      expect(c.last_activity_at).toBe(t.deps.now().toISOString());
      waits.push((Date.parse(c.outage!.retry_at) - t.deps.now().getTime()) / 1000);
      // Not started again before retry_at.
      t.advance(waits.at(-1)! - 1);
      await t.s.tick();
      await settle();
      expect(calls).toBe(i);
      t.advance(1);
    }
    expect(waits).toEqual([60, 120, 240, 480, 960]);
    expect(errors).toEqual([]);
    // The ledger was never written: no counter moved.
    expect(existsSync(join(t.paths.escalations, "7.json"))).toBe(false);
    expect(serviceRecords(t.paths).filter((r) => r.kind === "transient-outage")).toEqual([
      expect.objectContaining({ issue: 7, cause: "EAI_AGAIN", error: "getaddrinfo EAI_AGAIN api.github.com" }),
    ]);
    expect(serviceRecords(t.paths).find((r) => r.kind === "chain-error")).toBeUndefined();
    failing = false;
    await t.s.tick();
    await settle();
    expect((await t.claim()).outage).toBeUndefined();
    expect(serviceRecords(t.paths).filter((r) => r.kind === "transient-outage-over")).toEqual([
      expect.objectContaining({ issue: 7, since: "2026-10-12T12:00:00.000Z", failures: MAX_CHAIN_FAILURES + 2 }),
    ]);
  }, 60_000);

  it("counts a genuine error after an outage as today, and transient failures between genuine ones neither count nor reset (AC-7)", async () => {
    const script: (Error | null)[] = [dns(), new Error("boom"), dns(), new Error("boom"), dns(), new Error("boom")];
    const t = await outageSetup(async (_d, c) => { const e = script.shift(); if (e) throw e; return c; });
    const counts: (number | null)[] = [];
    for (let i = 0; i < 6; i++) {
      await t.s.tick();
      await settle();
      const c = await t.claim();
      if (!c) break;
      counts.push(c.state.chainFailures?.count ?? null);
      if (i === 1) expect(c.outage).toBeUndefined();
      t.advance(600);
    }
    expect(counts).toEqual([null, 1, 1, 2, 2, 3]);
    const t7 = await t.s.tick();
    expect(t7.released).toEqual([7]);
    expect(serviceRecords(t.paths).filter((r) => r.kind === "chain-error")).toHaveLength(1);
  }, 60_000);

  it("raises one notification, one finding and one infra_alarm event after two hours of outage (AC-8)", async () => {
    const t = await outageSetup(async () => { throw dns(); });
    for (let i = 0; i < 12; i++) {
      await t.s.tick();
      await settle();
      t.advance(1800);
    }
    const c = await t.claim();
    expect(c.outage?.alarmed).toBe(true);
    expect(t.notifications.filter((n) => n.gate === "infra")).toHaveLength(1);
    expect(t.notifications.find((n) => n.gate === "infra")?.text).toContain("EAI_AGAIN");
    const findings = readFileSync(t.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings).toHaveLength(1);
    expect(findings[0].finding).toMatchObject({ what: "network outage blocks the chain", noticed_how: "scheduler transient error" });
    expect(findings[0].finding).not.toHaveProperty("stops_pipeline");
    expect(t.events.filter((e) => e.event === "infra_alarm")).toEqual([{ event: "infra_alarm", payload: expect.objectContaining({ kind: "network_outage", issue: 7, since: "2026-10-12T12:00:00.000Z", cause: "EAI_AGAIN" }) }]);
    expect(t.notifications.filter((n) => n.gate === "chain_error")).toEqual([]);
  }, 60_000);

  const diskFull = () => Object.assign(new Error("host space low: /tmp has 100 MiB free and 5000 free inodes (floor 512 MiB, 1000 inodes)"), { code: "ENOSPC" });

  it("alarms on the first ENOSPC failure under kind disk_full, and raises nothing more for the same outage (spec 059 AC-4)", async () => {
    const t = await outageSetup(async () => { throw diskFull(); });
    for (let i = 0; i < 3; i++) {
      await t.s.tick();
      await settle();
      t.advance(600);
    }
    const c = await t.claim();
    expect(c.outage).toMatchObject({ count: 3, alarmed: true });
    expect(c.state.chainFailures).toBeNull();
    expect(existsSync(join(t.paths.escalations, "7.json"))).toBe(false);
    expect(serviceRecords(t.paths).filter((r) => r.kind === "transient-outage")).toEqual([expect.objectContaining({ issue: 7, cause: "ENOSPC" })]);
    expect(serviceRecords(t.paths).filter((r) => r.kind === "transient-outage-alarm")).toHaveLength(1);
    expect(t.notifications.filter((n) => n.gate === "infra")).toHaveLength(1);
    expect(t.notifications.find((n) => n.gate === "infra")?.text).toContain("/tmp has 100 MiB free");
    const findings = readFileSync(t.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings).toHaveLength(1);
    expect(findings[0].finding).toMatchObject({ what: "disk space blocks the chain", where: expect.stringContaining("issue #7, stage"), noticed_how: "scheduler transient error", stops_pipeline: true });
    expect(t.events.filter((e) => e.event === "infra_alarm")).toEqual([{ event: "infra_alarm", payload: expect.objectContaining({ kind: "disk_full", issue: 7, cause: "ENOSPC", failures: 1 }) }]);
  }, 60_000);

  it("continues a young network outage when ENOSPC follows, and alarms at once under disk_full (spec 059 AC-5)", async () => {
    const script: Error[] = [dns(), diskFull()];
    const t = await outageSetup(async () => { throw script.shift() ?? diskFull(); });
    for (let i = 0; i < 2; i++) {
      await t.s.tick();
      await settle();
      if (i === 0) expect((await t.claim()).outage).toMatchObject({ count: 1, alarmed: false });
      t.advance(600);
    }
    const c = await t.claim();
    expect(c.outage).toMatchObject({ count: 2, alarmed: true });
    expect(serviceRecords(t.paths).filter((r) => r.kind === "transient-outage")).toEqual([expect.objectContaining({ cause: "EAI_AGAIN" })]);
    expect(t.events.filter((e) => e.event === "infra_alarm")).toEqual([{ event: "infra_alarm", payload: expect.objectContaining({ kind: "disk_full", failures: 2, cause: "ENOSPC" }) }]);
  }, 60_000);

  it("counts the failures of an outage past its 24-hour ceiling as genuine, with one finding, and then releases with chain_error (AC-13)", async () => {
    let open = false;
    const t = await outageSetup(async () => { throw dns(); }, () => (open ? [issue(7)] : []));
    const c0 = await t.claim();
    const since = new Date(t.deps.now().getTime() - 25 * 3600_000).toISOString();
    await writeClaim(t.paths, { ...c0, outage: { since, count: 40, last: "getaddrinfo EAI_AGAIN api.github.com", retry_at: since, alarmed: true } });
    const LAST = "outage past ceiling: getaddrinfo EAI_AGAIN api.github.com";
    // A laptop asleep for a day is not a day of failures: the first failures past the ceiling, until there are three
    // spanning at least 30 minutes, still count nothing.
    for (let i = 1; i <= 2; i++) {
      await t.s.tick();
      await settle();
      const c = await t.claim();
      expect(c.state.chainFailures).toBeNull();
      expect(c.outage).toMatchObject({ since, count: 40 + i, past_ceiling: { failures: i } });
      expect(c.outage?.ceiling).toBeFalsy();
      t.advance(1800);
    }
    for (let i = 1; i <= MAX_CHAIN_FAILURES; i++) {
      expect((await t.s.tick()).released).toEqual([]);
      await settle();
      const c = await t.claim();
      expect(c.state.chainFailures).toEqual({ count: i, last: LAST });
      expect(c.outage).toMatchObject({ since, count: 42 + i, ceiling: true });
      t.advance(1800);
    }
    expect(JSON.parse(readFileSync(join(t.paths.escalations, "7.json"), "utf8")).chainFailures.count).toBe(MAX_CHAIN_FAILURES);
    expect(serviceRecords(t.paths).filter((r) => r.kind === "transient-outage-ceiling")).toHaveLength(1);
    const findings = readFileSync(t.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings.filter((f) => f.finding.what.startsWith("transient failures outlast the retry ceiling while the host probe passes: "))).toHaveLength(1);
    expect((await t.s.tick()).released).toEqual([7]);
    await settle();
    expect(serviceRecords(t.paths).filter((r) => r.kind === "chain-error")).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(join(t.paths.escalations, "7.json"), "utf8"));
    expect(ledger.chainErrors).toBe(1);
    expect(ledger.history.at(-1)).toBe(`chain error in verify (counted): ${LAST}`);
    // Claimed again: the release past the ceiling is not forgiven, so the next one abandons the issue.
    open = true;
    const reclaim = await t.s.tick();
    await settle();
    expect(reclaim).toMatchObject({ claimed: [7] });
    const again = (await listClaims(t.paths)).find((c) => c.issue === 7)!;
    expect(again.state.chainErrors).toBe(1);
    expect(serviceRecords(t.paths).find((r) => r.kind === "chain-errors-forgiven")).toBeUndefined();
  }, 60_000);

  it("reports a claim carrying pending work once when its outage passes the ceiling (AC-13)", async () => {
    const t = await outageSetup(async () => { throw dns(); });
    const c0 = await t.claim();
    const since = new Date(t.deps.now().getTime() - 25 * 3600_000).toISOString();
    await writeClaim(t.paths, { ...c0, pendingEvent: { type: "chain_error", error: "boom" }, outage: { since, count: 40, last: "getaddrinfo EAI_AGAIN api.github.com", retry_at: since, alarmed: true } });
    for (let i = 0; i < 6; i++) {
      await t.s.tick();
      await settle();
      t.advance(1800);
    }
    expect(t.notifications.filter((n) => n.gate === "chain_error")).toHaveLength(1);
    expect(t.notifications.find((n) => n.gate === "chain_error")?.text).toContain("past its 24-hour ceiling");
    expect(serviceRecords(t.paths).filter((r) => r.kind === "pending-work-failing")).toHaveLength(1);
    const queued = readFileSync(t.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l).finding).filter((f) => f.what.startsWith("pending work keeps failing"));
    expect(queued).toHaveLength(1);
    expect(queued[0].what).toBe("pending work keeps failing: EAI_AGAIN");
    expect(queued[0].evidence.startsWith("outage past ceiling: ")).toBe(true);
    expect(await t.claim()).toBeTruthy();
  }, 60_000);

  describe("alerts reach the chat (spec 102 AC-3, AC-4)", () => {
    it("flushes once per tick, paused or not, and a flush that rejects is logged, not the tick's", async () => {
      const t = await outageSetup(async (_d, c) => c);
      let flushes = 0;
      let reject = false;
      t.deps.notifier = { notify: async () => {}, flush: async () => { flushes++; if (reject) throw new Error("outbox broke"); return 0; } };
      t.deps.host = undefined;
      const s = new Scheduler(t.deps, { driveChain: async (_d, c) => c });
      const w2 = watchTickErrors(s);
      onTestFinished(() => w2.check());
      await s.tick();
      expect(flushes).toBe(1);
      t.setProbe("EAI_AGAIN");
      t.deps.fetchOrigin = async () => { throw dns(); };
      w2.allow(/freshness/);
      await s.tick();
      await settle();
      expect(flushes).toBe(2);
      reject = true;
      t.advance(30);
      const info = await s.tick();
      expect(flushes).toBe(3);
      expect(info.errors).toEqual([]);
      expect(serviceRecords(t.paths)).toContainEqual(expect.objectContaining({ kind: "error", error: "notify flush: outbox broke" }));
    }, 60_000);

    it("a host-pause notice queued while the chat is unreachable is sent once, marked cleared, by the tick that resumes; a start-up notice goes out on the first tick after the attach", async () => {
      const { rateLimited } = await import("../src/notify/rate-limit.ts");
      const { recordedNotifier } = await import("../src/notify/recorded.ts");
      const { TelegramNotifier, readOutbox } = await import("../src/notify/telegram.ts");
      const { LogNotifier } = await import("../src/notify/log.ts");
      const t = await outageSetup(async (_d, c) => c);
      const sent: string[] = [];
      let mode: "off" | "reject" | "accept" = "reject";
      const chan = { sendReply: async (text: string) => { if (mode === "reject") throw new Error("down"); sent.push(text); return 500 + sent.length; } } as unknown as import("../src/telegram/channel.ts").TelegramChannel;
      const tn = TelegramNotifier(new LogNotifier(t.paths.serviceLog), { telegram: () => (mode === "off" ? null : chan), alertsPath: t.paths.telegramAlerts, outboxPath: t.paths.telegramOutbox, now: () => t.deps.now(), log: (r) => t.deps.serviceLog.write(r) });
      t.deps.notifier = rateLimited(recordedNotifier(tn, t.paths, () => t.deps.now()), { hours: 4, repeatHours: 24, path: t.paths.notifySent }, () => t.deps.now());
      t.deps.host = undefined;
      let fetchFails = true;
      t.deps.fetchOrigin = async () => { if (fetchFails) throw dns(); };
      const s = new Scheduler(t.deps, { driveChain: async (_d, c) => c });
      const w2 = watchTickErrors(s);
      onTestFinished(() => w2.check());
      w2.allow(/freshness/);
      t.setProbe("EAI_AGAIN");
      await s.tick();
      await settle();
      t.advance(30 * 3600);
      await s.tick();
      await s.tick();
      const hostNotes = () => serviceRecords(t.paths).filter((r) => r.kind === "notify" && r.label === "host");
      expect(hostNotes().map((r) => r.channel)).toEqual(["queued"]);
      expect((await readOutbox(t.paths.telegramOutbox)).map((e) => e.identity)).toEqual(["0:infra:host"]);
      expect(sent).toEqual([]);
      t.advance(1800);
      await s.tick();
      expect(sent).toEqual([]);
      // the chat takes messages again and the probe passes: the resuming tick sends it, once
      mode = "accept";
      fetchFails = false;
      t.setProbe(null);
      t.advance(1800);
      await s.tick();
      await settle();
      expect(serviceRecords(t.paths).filter((r) => r.kind === "host-resumed")).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/^infra: host\nqueued \S+, cleared \S+\n\nThe scheduler is paused: the host cannot work \(EAI_AGAIN\)/);
      expect(sent[0]).toContain("since ");
      expect(await readOutbox(t.paths.telegramOutbox)).toEqual([]);
      t.advance(30);
      await s.tick();
      expect(sent).toHaveLength(1);
      // start-up: raised before the poller attaches the channel, sent on the first tick after it
      mode = "off";
      await t.deps.notifier.notify({ issue: 9, gate: "abandoned", label: "x", text: "gave up" });
      expect((await readOutbox(t.paths.telegramOutbox)).map((e) => e.gate)).toEqual(["abandoned"]);
      t.advance(30);
      await s.tick();
      expect(sent).toHaveLength(1);
      mode = "accept";
      t.advance(30);
      await s.tick();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain("abandoned: x #9");
    }, 60_000);
  });

  it("does not let liveness expire a claim that is retrying through an outage (AC-9)", async () => {
    const t = await outageSetup(async () => { throw dns(); });
    for (let i = 0; i < 4; i++) {
      const tick = await t.s.tick();
      await settle();
      expect(tick.released).toEqual([]);
      t.advance(5400);
    }
    expect(await t.claim()).toBeTruthy();
    expect(serviceRecords(t.paths).find((r) => r.kind === "stale-claim")).toBeUndefined();
  }, 60_000);

  it("forgives a chain-error release recorded for a transient cause when the issue is claimed again (AC-11; issue #13)", async () => {
    const { s, paths } = await setup(routes([issue(1)]));
    await writeLedger(paths, 1, { ...ledgerOf(initialChainState(1)), chainErrors: 1, history: ["chain error in verify: getaddrinfo EAI_AGAIN api.github.com"] });
    const t = await s.tick();
    expect(t.claimed).toEqual([1]);
    const claim = (await listClaims(paths)).find((c) => c.issue === 1)!;
    expect(claim.state.chainErrors).toBe(0);
    const ledger = JSON.parse(readFileSync(join(paths.escalations, "1.json"), "utf8"));
    expect(ledger.chainErrors).toBe(0);
    expect(ledger.history).toEqual(["chain error in verify (transient, not counted): getaddrinfo EAI_AGAIN api.github.com"]);
    expect(serviceRecords(paths)).toContainEqual(expect.objectContaining({ kind: "chain-errors-forgiven", issue: 1, forgiven: 1 }));
  }, 30_000);
});
