import { rateLimited } from "../src/notify/rate-limit.ts";
import type { Notification } from "../src/notify/types.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { awsCheck, awsPull, awsStatus } from "../src/aws/check.ts";
import { ssoExpiry } from "../src/aws/sso.ts";
import { redact } from "../src/aws/cli.ts";
import { awsTick, pull } from "../src/aws/cost.ts";
import { forecastUsd } from "../src/aws/book.ts";
import { checkIdentity } from "../src/aws/identity.ts";
import { releaseSpend, reserveSpend } from "../src/aws/ledger.ts";
import { writeLedger } from "../src/aws/book.ts";
import { applyAction, loadActionLevels, type ActionContext } from "../src/actions/index.ts";
import { awsScaleKind } from "../src/actions/aws-scale.ts";
import { validate } from "../src/schema/validate.ts";
import { ACCOUNT, awsWorld } from "./helpers/aws.ts";

const HOUR = 3_600_000;
const advance = (w: { clock: { now: Date } }, ms: number) => { w.clock.now = new Date(w.clock.now.getTime() + ms); };
const labels = (w: { notes: { label: string }[] }) => w.notes.map((n) => n.label);
const ask = (what = "console hosting on a small instance", usd = 30, by = "spec-e") => ({ what, expected_monthly_usd: usd, why: "charter: a console the maintainer can reach", by });
const ceCalls = (w: { calls: () => string[][] }) => w.calls().filter((c) => c[0] === "ce");

describe("identity (spec 022 AC-2)", () => {
  it("is on for the configured account and calls only through --profile and --region", async () => {
    const w = await awsWorld();
    expect((await checkIdentity(w.ctx)).on).toBe(true);
    expect(w.calls()).toEqual([["sts", "get-caller-identity", "--profile", "panelator-delivery", "--region", "us-east-2", "--output", "json"]]);
    expect(w.notes).toEqual([]);
  });

  it("is off for another account: one aws-access notification, and no call but the identity check", async () => {
    const w = await awsWorld();
    w.setIdentity("999999999999");
    await awsTick(w.ctx);
    advance(w, 25 * HOUR);
    const field = await awsTick(w.ctx);
    expect(field).toMatchObject({ off: expect.stringContaining("999999999999") });
    expect(w.calls().every((c) => c[0] === "sts")).toBe(true);
    expect(labels(w)).toEqual(["aws-access"]);
    expect(w.logs.filter((l) => l.kind === "aws-off")).toHaveLength(1);
    await expect(reserveSpend(w.ctx, ask())).resolves.toMatchObject({ ok: false });
    expect(w.calls().every((c) => c[0] === "sts")).toBe(true);
  });

  it("is off when the command fails (an expired session) and comes back on, logging each change once", async () => {
    const w = await awsWorld();
    w.fail("sts", true);
    await checkIdentity(w.ctx);
    await checkIdentity(w.ctx);
    expect(w.logs.filter((l) => l.kind === "aws-off")).toHaveLength(1);
    expect(labels(w)).toEqual(["aws-access"]);
    w.fail("sts", false);
    expect((await checkIdentity(w.ctx)).on).toBe(true);
    expect(w.logs.map((l) => l.kind)).toEqual(["aws-off", "aws-on"]);
  });

  it("is off with its reason once, and calls nothing, without an aws block (AC-1)", async () => {
    const w = await awsWorld({ config: null });
    expect(await awsTick(w.ctx)).toEqual({ off: "no aws block in agents/scheduler.yaml" });
    await awsTick(w.ctx);
    expect(w.logs).toEqual([{ kind: "aws-off", reason: "no aws block in agents/scheduler.yaml" }]);
    expect(w.notes).toEqual([]);
    expect(w.calls()).toEqual([]);
  });

  it("never puts a secret in the log, a notification or the process environment", async () => {
    const w = await awsWorld();
    const before = JSON.stringify(Object.keys(process.env).sort());
    w.fail("sts", true);
    await checkIdentity(w.ctx);
    w.fail("sts", false);
    w.fail("ce", true);
    await pull(w.ctx);
    const seen = JSON.stringify([w.logs, w.notes]);
    expect(seen).not.toContain("FAKESECRET123");
    expect(seen).not.toContain("AKIAFAKEKEYID123456");
    expect(JSON.stringify(Object.keys(process.env).sort())).toBe(before);
    expect(redact("aws_secret_access_key=abc token: xyz")).toBe("aws_secret_access_key=[redacted] token: [redacted]");
  });
});

describe("the daily pull (spec 022 AC-4)", () => {
  it("writes cost.json and one aws.cost event, filtered to the account, and pulls nothing inside the interval", async () => {
    const w = await awsWorld();
    w.setCost(20);
    const field = await awsTick(w.ctx);
    const cost = JSON.parse(readFileSync(w.ctx.paths.awsCost, "utf8"));
    expect(cost).toEqual({ month: "2026-11", actual_usd: 20, as_of: "2026-11-10T12:00:00.000Z", cap_usd: 100, reserved_usd: 0, forecast_usd: 60, days_elapsed: 10, days_in_month: 30, source: "ce" });
    expect(validate("aws-cost", cost).ok).toBe(true);
    expect(field).toEqual({ actual_usd: 20, forecast_usd: 60, cap_usd: 100, reserved_usd: 0, as_of: "2026-11-10T12:00:00.000Z" });
    const [call] = ceCalls(w);
    expect(call).toContain("MONTHLY");
    expect(call).toContain("UnblendedCost");
    expect(call).toContain("Start=2026-11-01,End=2026-12-01");
    expect(call.join(" ")).toContain(`"Values":["${ACCOUNT}"]`);
    expect(w.events("aws.cost")).toHaveLength(1);
    expect(w.events("aws.cost")[0].payload).toEqual(cost);
    advance(w, 23 * HOUR);
    await awsTick(w.ctx);
    expect(ceCalls(w)).toHaveLength(1);
    advance(w, 2 * HOUR);
    await awsTick(w.ctx);
    expect(ceCalls(w)).toHaveLength(2);
    expect(w.events("aws.cost")).toHaveLength(2);
  });

  it("keeps the old file on a failure and retries after an hour, at most six times a day", async () => {
    const w = await awsWorld();
    w.setCost(20);
    await awsTick(w.ctx);
    const before = readFileSync(w.ctx.paths.awsCost, "utf8");
    w.fail("ce", true);
    advance(w, 25 * HOUR);
    await awsTick(w.ctx);
    expect(ceCalls(w)).toHaveLength(2);
    expect(w.logs.some((l) => l.kind === "aws-pull-failed")).toBe(true);
    advance(w, 30 * 60_000);
    await awsTick(w.ctx);
    expect(ceCalls(w)).toHaveLength(2);
    for (let i = 0; i < 8; i++) { advance(w, HOUR + 1); await awsTick(w.ctx); }
    // 2 earlier calls + the retries until six failures were counted on one UTC day
    expect(readFileSync(w.ctx.paths.awsCost, "utf8")).toBe(before);
    const days = new Map<string, number>();
    for (const l of w.logs.filter((x) => x.kind === "aws-pull-failed")) days.set(String(l.failures_today), 1);
    expect(Math.max(...[...days.keys()].map(Number))).toBeLessThanOrEqual(6);
    w.fail("ce", false);
    w.setCost(30);
    advance(w, 24 * HOUR);
    await awsTick(w.ctx);
    expect(JSON.parse(readFileSync(w.ctx.paths.awsCost, "utf8")).actual_usd).toBe(30);
  });

  it("starts from the new month's figure and resets the month's notices", async () => {
    const w = await awsWorld({ start: "2026-11-30T10:00:00Z" });
    w.setCost(85);
    await awsTick(w.ctx);
    expect(labels(w).filter((l) => l === "aws-cap-80")).toHaveLength(1);
    w.setCost(86);
    advance(w, 15 * HOUR);
    const field = await awsTick(w.ctx);
    expect(field).toMatchObject({ actual_usd: 86 });
    expect(JSON.parse(readFileSync(w.ctx.paths.awsCost, "utf8"))).toMatchObject({ month: "2026-12", days_elapsed: 1, days_in_month: 31 });
    expect(labels(w).filter((l) => l === "aws-cap-80")).toHaveLength(2);
  });
});

describe("the forecast (spec 022 AC-5)", () => {
  it("is the larger of the trend and the ledger view", () => {
    expect(forecastUsd(20, 0, 10, 30)).toBe(60);
    expect(forecastUsd(20, 100, 10, 30)).toBe(86.67);
    expect(forecastUsd(20, 30, 10, 30)).toBe(60);
    expect(forecastUsd(0, 0, 0, 30)).toBe(0);
    expect(forecastUsd(3, 0, 0, 30)).toBe(90);
  });
});

describe("the launch gate (spec 022 AC-6, AC-7)", () => {
  it("reserves what fits and records aws.reserve", async () => {
    const w = await awsWorld();
    w.setCost(20);
    await awsTick(w.ctx);
    const r = await reserveSpend(w.ctx, ask("a big instance for the console", 100));
    expect(r).toMatchObject({ ok: true });
    const ledger = JSON.parse(readFileSync(w.ctx.paths.awsLedger, "utf8"));
    expect(validate("aws-ledger", ledger).ok).toBe(true);
    expect(ledger.reservations[0]).toMatchObject({ expected_monthly_usd: 100, released_at: null, by: "spec-e" });
    expect(w.events("aws.reserve").map((e) => e.payload.outcome)).toEqual(["reserved"]);
    expect(JSON.parse(readFileSync(w.ctx.paths.awsCost, "utf8"))).toMatchObject({ reserved_usd: 100, forecast_usd: 86.67 });
    expect(w.notes).toEqual([]);
  });

  it("refuses what does not fit as a funds request: one notification, one funds contact, nothing written", async () => {
    const w = await awsWorld();
    w.setCost(20);
    await awsTick(w.ctx);
    const r = await reserveSpend(w.ctx, ask("a huge instance for the console", 130));
    expect(r).toMatchObject({ ok: false, shortfall_usd: 6.67 });
    expect(() => readFileSync(w.ctx.paths.awsLedger)).toThrow();
    expect(w.events("aws.reserve").map((e) => e.payload.outcome)).toEqual(["refused"]);
    expect(labels(w)).toEqual(["aws-funds"]);
    expect(w.notes[0].text).toContain("Amount: 6.67 USD a month");
    expect(w.notes[0].text).toContain("param set aws_cap_usd 106.67");
    const contacts = w.events("maintainer.contact");
    expect(contacts).toHaveLength(1);
    expect(contacts[0].payload).toMatchObject({ kind: "funds", label: "aws-funds", request: { type: "funds", amount_usd: 6.67, purpose: "a huge instance for the console" } });
    // the same what is not notified again within the window, another what is
    await reserveSpend(w.ctx, ask("a huge instance for the console", 130));
    expect(labels(w)).toEqual(["aws-funds"]);
    await reserveSpend(w.ctx, ask("a different huge thing for the console", 130));
    expect(labels(w)).toEqual(["aws-funds", "aws-funds"]);
    advance(w, 5 * HOUR);
    await reserveSpend(w.ctx, ask("a huge instance for the console", 130));
    expect(labels(w)).toHaveLength(3);
  });

  it("refuses everything while the cap is 0, whole cost as the shortfall, and makes no cost call", async () => {
    const w = await awsWorld({ cap: 0 });
    const r = await reserveSpend(w.ctx, ask("a tiny thing for the console", 5));
    expect(r).toMatchObject({ ok: false, shortfall_usd: 5 });
    expect(w.notes[0].text).toContain("The cap is 0");
    expect(ceCalls(w)).toEqual([]);
  });

  it("refuses when AWS is off, and validates its input without notifying", async () => {
    const w = await awsWorld({ config: null });
    expect(await reserveSpend(w.ctx, ask())).toMatchObject({ ok: false, reason: expect.stringContaining("aws is off") });
    const w2 = await awsWorld();
    expect(await reserveSpend(w2.ctx, { ...ask(), expected_monthly_usd: -1 })).toMatchObject({ ok: false });
    expect(await reserveSpend(w2.ctx, { ...ask(), what: "short" })).toMatchObject({ ok: false });
    expect(await reserveSpend(w2.ctx, { ...ask(), why: "short" })).toMatchObject({ ok: false });
    expect(w2.notes).toEqual([]);
    expect(w2.events("aws.reserve")).toEqual([]);
  });

  it("accepts a zero-cost reservation and releases one, counting it only while open", async () => {
    const w = await awsWorld();
    w.setCost(20);
    await awsTick(w.ctx);
    const r = await reserveSpend(w.ctx, ask("a free tier thing for the console", 0));
    expect(r.ok).toBe(true);
    const big = await reserveSpend(w.ctx, ask("a big instance for the console", 100));
    if (!big.ok) throw new Error("expected a reservation");
    expect(JSON.parse(readFileSync(w.ctx.paths.awsCost, "utf8")).reserved_usd).toBe(100);
    expect(await releaseSpend(w.ctx, big.id)).toBe(true);
    expect(await releaseSpend(w.ctx, big.id)).toBe(false);
    expect(JSON.parse(readFileSync(w.ctx.paths.awsCost, "utf8")).reserved_usd).toBe(0);
    expect(w.events("aws.reserve").map((e) => e.payload.outcome)).toEqual(["reserved", "reserved", "released"]);
    expect(JSON.parse(readFileSync(w.ctx.paths.awsLedger, "utf8")).reservations[1].released_at).not.toBeNull();
  });

  it("records a notification without a contact as kind notification", async () => {
    const w = await awsWorld();
    w.setIdentity("1");
    await checkIdentity(w.ctx);
    expect(w.events("maintainer.contact").map((e) => e.payload.kind)).toEqual(["notification"]);
  });
});

describe("thresholds (spec 022 AC-8)", () => {
  it("notifies 80% then 100% once each, files one planning-failure finding, and nothing twice", async () => {
    const w = await awsWorld({ start: "2026-11-24T12:00:00Z" });
    w.setCost(85);
    await awsTick(w.ctx);
    expect(labels(w).filter((l) => l.startsWith("aws-cap"))).toEqual(["aws-cap-80"]);
    w.setCost(86);
    advance(w, 25 * HOUR);
    await awsTick(w.ctx);
    expect(labels(w).filter((l) => l.startsWith("aws-cap"))).toEqual(["aws-cap-80"]);
    w.setCost(100);
    advance(w, 25 * HOUR);
    await awsTick(w.ctx);
    expect(labels(w).filter((l) => l.startsWith("aws-cap"))).toEqual(["aws-cap-80", "aws-cap-hit"]);
    expect(w.notes.find((n) => n.label === "aws-cap-hit")?.text).toMatch(/^Incident/);
    w.setCost(110);
    advance(w, 25 * HOUR);
    await awsTick(w.ctx);
    expect(labels(w).filter((l) => l.startsWith("aws-cap"))).toEqual(["aws-cap-80", "aws-cap-hit"]);
    const queue = readFileSync(w.ctx.paths.findingsQueue, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(queue).toHaveLength(1);
    expect(queue[0].finding.what).toMatch(/^AWS cap hit: planning failure/);
    expect(queue[0].finding.evidence).toContain("actual_usd");
  });

  it("sends neither threshold at cap 0", async () => {
    const w = await awsWorld({ cap: 0 });
    w.setCost(500);
    await awsTick(w.ctx);
    await pull(w.ctx);
    expect(labels(w).filter((l) => l.startsWith("aws-cap"))).toEqual([]);
  });
});

describe("the forecast alarm (spec 022 AC-9, AC-11)", () => {
  async function overCap() {
    const w = await awsWorld();
    w.setCost(20);
    await awsTick(w.ctx);
    const r = await reserveSpend(w.ctx, ask("a big instance for the console", 100));
    if (!r.ok) throw new Error("expected a reservation");
    w.cap.value = 80;
    return { w, id: r.id };
  }

  it("emits infra_alarm and notifies once a day while over, refuses reservations, and recovers once", async () => {
    const { w, id } = await overCap();
    await awsTick(w.ctx);
    expect(w.alarms).toEqual([{ kind: "aws_forecast_over_cap", forecast_usd: 86.67, cap_usd: 80, actual_usd: 20, reserved_usd: 100, days_to_cap: 30 }]);
    await awsTick(w.ctx);
    expect(labels(w)).toEqual(["aws-forecast"]);
    expect(await reserveSpend(w.ctx, ask("one more small thing for the console", 1))).toMatchObject({ ok: false, reason: expect.stringContaining("over the cap") });
    advance(w, 25 * HOUR);
    await awsTick(w.ctx);
    expect(labels(w).filter((l) => l === "aws-forecast")).toHaveLength(2);
    expect(w.alarms).toHaveLength(2);
    await releaseSpend(w.ctx, id);
    expect(labels(w).filter((l) => l === "aws-forecast")).toHaveLength(3);
    expect(w.notes.at(-1)?.text).toContain("back under the cap");
    await awsTick(w.ctx);
    expect(labels(w).filter((l) => l === "aws-forecast")).toHaveLength(3);
    expect(await reserveSpend(w.ctx, ask("one more small thing for the console", 1))).toMatchObject({ ok: true });
  });

  it("re-arms the aws-forecast notice on a change of state, so a recovery inside the window is delivered (spec 068 AC-7)", async () => {
    const { w, id } = await overCap();
    const sent: Notification[] = [];
    const limited = rateLimited({ notify: async (n) => { sent.push(n); return { channel: "log" as const }; } }, { hours: 4, repeatHours: 24, path: join(w.dir, "sent.json") }, () => w.ctx.now());
    w.ctx.notifier = limited;
    await awsTick(w.ctx);
    expect(sent.map((n) => n.label)).toEqual(["aws-forecast"]);
    advance(w, HOUR);
    await releaseSpend(w.ctx, id);
    expect(sent.map((n) => n.label)).toEqual(["aws-forecast", "aws-forecast"]);
    expect(sent[1]!.text).toContain("back under the cap");
    await awsTick(w.ctx);
    expect(sent).toHaveLength(2);
  });

  it("sends the notice even when the clear throws, and writes it to the service log", async () => {
    const { w, id } = await overCap();
    const sent: Notification[] = [];
    w.ctx.notifier = { notify: async (n) => { sent.push(n); return { channel: "log" as const }; }, clear: async () => { throw new Error("clear broke"); } };
    await awsTick(w.ctx);
    await releaseSpend(w.ctx, id);
    expect(sent).toHaveLength(2);
    expect(w.logs.some((l) => l.kind === "aws-forecast-clear-failed" && l.error === "clear broke")).toBe(true);
  });

  it("allows what was refused after the cap is raised, with no pull", async () => {
    const { w } = await overCap();
    await awsTick(w.ctx);
    expect(await reserveSpend(w.ctx, ask("one more small thing for the console", 1))).toMatchObject({ ok: false });
    const pulls = ceCalls(w).length;
    w.cap.value = 200;
    await awsTick(w.ctx);
    expect(ceCalls(w)).toHaveLength(pulls);
    expect(JSON.parse(readFileSync(w.ctx.paths.awsCost, "utf8"))).toMatchObject({ cap_usd: 200 });
    expect(labels(w).at(-1)).toBe("aws-forecast");
    expect(await reserveSpend(w.ctx, ask("one more small thing for the console", 1))).toMatchObject({ ok: true });
  });
});

describe("the cap 0 skip (spec 050 AC-5, AC-8)", () => {
  it("runs only the identity check each interval, logs the skip once, and resumes on a non-zero cap", async () => {
    const w = await awsWorld({ cap: 0 });
    const f1 = await awsTick(w.ctx);
    expect(f1).toEqual({ actual_usd: null, forecast_usd: null, cap_usd: 0, reserved_usd: null, as_of: null, pull_skipped: "cap 0" });
    await awsTick(w.ctx);
    expect(w.calls()).toHaveLength(1);
    advance(w, 25 * HOUR);
    await awsTick(w.ctx);
    expect(w.calls().map((c) => c[0])).toEqual(["sts", "sts"]);
    expect(w.logs.filter((l) => l.kind === "aws-pull-skipped")).toEqual([{ kind: "aws-pull-skipped", reason: "aws_cap_usd is 0" }]);
    expect(() => readFileSync(w.ctx.paths.awsCost)).toThrow();
    expect(w.events("aws.cost")).toEqual([]);
    w.cap.value = 50;
    w.setCost(10);
    await awsTick(w.ctx);
    expect(w.logs.filter((l) => l.kind === "aws-pull-resumed")).toHaveLength(1);
    expect(ceCalls(w)).toHaveLength(1);
    expect(w.events("aws.cost")).toHaveLength(1);
  });
});

describe("the commands (spec 022 AC-3, AC-10; spec 050 AC-6 to AC-8)", () => {
  const home = (profileLines: string, expiresAt?: string) => {
    const dir = join(tmpdir(), `aws-home-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, ".aws", "sso", "cache"), { recursive: true });
    writeFileSync(join(dir, ".aws", "config"), profileLines);
    if (expiresAt) writeFileSync(join(dir, ".aws", "sso", "cache", `${createHash("sha1").update("default").digest("hex")}.json`), JSON.stringify({ expiresAt, accessToken: "SSOSECRET" }));
    return dir;
  };
  const sso = "[profile panelator-delivery]\nsso_session = default\nsso_account_id = 123456789012\n";

  it("aws-check prints identity, cost, cap and the SSO expiry, and exits 0 only when both calls succeed", async () => {
    const w = await awsWorld();
    w.setCost(12.5);
    const out = await awsCheck(w.ctx, { HOME: home(sso, "2027-01-01T00:00:00Z") });
    expect(out.exitCode).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain(`(account ${ACCOUNT})`);
    expect(text).toContain("yes");
    expect(text).toContain("month-to-date cost: 12.50 USD");
    expect(text).toContain("cap: 100 USD");
    expect(text).toContain("sso session expires: 2027-01-01T00:00:00Z");
    expect(text).not.toContain("SSOSECRET");
    w.fail("ce", true);
    expect((await awsCheck(w.ctx, { HOME: home("[profile panelator-delivery]\nregion = us-east-2\n") })).exitCode).toBe(1);
    expect((await awsCheck(w.ctx, { HOME: home("[profile panelator-delivery]\nregion = us-east-2\n") })).lines.join("\n")).toContain("not SSO");
  });

  it("aws-check exits 1 for another account, and at cap 0 skips the cost call and exits 0 on a match", async () => {
    const w = await awsWorld();
    w.setIdentity("999999999999");
    expect((await awsCheck(w.ctx, { HOME: home(sso) })).exitCode).toBe(1);
    const z = await awsWorld({ cap: 0 });
    const out = await awsCheck(z.ctx, { HOME: home(sso) });
    expect(out.exitCode).toBe(0);
    expect(out.lines).toContain("cost call skipped: aws_cap_usd is 0; panelator-scheduler aws pull makes one (about one cent)");
    expect(ceCalls(z)).toEqual([]);
  });

  it("aws prints the book with --json and the cap 0 line; aws pull forces a pull with a word first at cap 0", async () => {
    const w = await awsWorld({ cap: 0 });
    const pulled = await awsPull(w.ctx);
    expect(pulled.exitCode).toBe(0);
    expect(pulled.lines[0]).toContain("although the scheduled pulls are skipped");
    expect(w.events("aws.cost")).toHaveLength(1);
    const text = (await awsStatus(w.ctx, false)).lines.join("\n");
    expect(text).toContain("scheduled pulls skipped: aws_cap_usd is 0");
    expect(text).toContain("aws: on");
    const json = JSON.parse((await awsStatus(w.ctx, true)).lines[0]);
    expect(json).toMatchObject({ on: true, pull_skipped: true, cap_usd: 0, open: [], released: [] });
    const off = await awsWorld({ config: null });
    expect((await awsStatus(off.ctx, false)).lines.join("\n")).toContain("aws: off: no aws block");
  });
});

describe("what the AWS code may and may not do (spec 022 AC-1, AC-6, AC-11; spec 050 AC-4)", () => {
  const srcDir = join(import.meta.dirname, "..", "src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
  const all = files(srcDir);
  const outside = all.filter((f) => !relative(srcDir, f).startsWith("aws/"));

  it("spawns `aws` only under src/aws/, and never asks for a forecast", () => {
    const spawn = /(execFile|execFileSync|spawn|spawnSync|exec|execSync)\w*\(\s*["'`]aws["'`]/;
    expect(outside.filter((f) => spawn.test(readFileSync(f, "utf8"))).map((f) => relative(srcDir, f))).toEqual([]);
    expect(all.filter((f) => /get-cost-forecast/.test(readFileSync(f, "utf8")))).toEqual([]);
    expect(all.filter((f) => /@aws-sdk|aws-sdk/.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("never sets a parameter and adds no action kind", () => {
    for (const f of all.filter((f) => relative(srcDir, f).startsWith("aws/"))) expect(readFileSync(f, "utf8"), f).not.toMatch(/setParameter|setParameterMode/);
    // Spec 068 AC-7 adds the one kind that reads the ledger; nothing else under agents/actions.yaml is for AWS.
    const kinds = Object.keys(parse(readFileSync(join(srcDir, "..", "..", "..", "agents", "actions.yaml"), "utf8")) as object);
    expect(kinds.filter((k) => /aws/i.test(k))).toEqual(["aws_scale"]);
  });
});

describe("ssoExpiry (spec 068 AC-2)", () => {
  const FIX = join(import.meta.dirname, "fixtures", "aws-home");
  const env = { HOME: FIX };
  it("reads expiresAt for an sso_session profile and for a legacy start URL, and says none for a plain profile", () => {
    expect(ssoExpiry("panelator-delivery", env)).toEqual({ expires_at: "2027-01-01T00:00:00Z", renewable: false });
    expect(ssoExpiry("legacy", env)).toEqual({ expires_at: "2027-02-01T00:00:00Z", renewable: false });
    expect(ssoExpiry("plain", env)).toEqual({ none: true });
  });
  it("errors for a missing profile, config file, cache file or expiresAt", () => {
    expect(ssoExpiry("nope", env)).toEqual({ error: `no profile nope in ${join(FIX, ".aws", "config")}` });
    expect(ssoExpiry("x", { HOME: join(FIX, "absent") })).toMatchObject({ error: expect.stringContaining("no profile x in") });
    const dir = join(tmpdir(), `sso-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "config");
    writeFileSync(cfg, "[profile p]\nsso_session = s\n");
    const e = { AWS_CONFIG_FILE: cfg, AWS_SSO_CACHE_DIR: dir };
    expect(ssoExpiry("p", e)).toEqual({ error: "no cached SSO token found (run aws sso login)" });
    const file = join(dir, `${createHash("sha1").update("s").digest("hex")}.json`);
    writeFileSync(file, "not json");
    expect(ssoExpiry("p", e)).toEqual({ error: "no cached SSO token found (run aws sso login)" });
    writeFileSync(file, JSON.stringify({ accessToken: "SSOSECRET" }));
    expect(ssoExpiry("p", e)).toEqual({ error: "no expiresAt in the cached token" });
    writeFileSync(file, JSON.stringify({ expiresAt: "garbage" }));
    expect(ssoExpiry("p", e)).toEqual({ error: "no expiresAt in the cached token" });
    writeFileSync(file, JSON.stringify({ expiresAt: "2030-05-05T00:00:00Z", accessToken: "SSOSECRET" }));
    expect(ssoExpiry("p", e)).toEqual({ expires_at: "2030-05-05T00:00:00Z", renewable: false });
  });
  it("a renewable session (sso_session, refreshToken, registrationExpiresAt) says the registration's end, whatever expiresAt is", () => {
    const dir = join(tmpdir(), `sso-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "config");
    writeFileSync(cfg, "[profile p]\nsso_session = s\n[profile q]\nsso_start_url = https://x/start\n");
    const e = { AWS_CONFIG_FILE: cfg, AWS_SSO_CACHE_DIR: dir };
    const file = join(dir, `${createHash("sha1").update("s").digest("hex")}.json`);
    const reg = new Date(Date.now() + 60 * 86400000).toISOString();
    writeFileSync(file, JSON.stringify({ accessToken: "SSOSECRET", refreshToken: "SSOSECRET-R", clientSecret: "SSOSECRET-C", expiresAt: new Date(Date.now() - 3600000).toISOString(), registrationExpiresAt: reg }));
    expect(ssoExpiry("p", e)).toEqual({ expires_at: reg, renewable: true });
    writeFileSync(file, JSON.stringify({ refreshToken: "x", registrationExpiresAt: reg }));
    expect(ssoExpiry("p", e)).toEqual({ expires_at: reg, renewable: true });
    writeFileSync(file, JSON.stringify({ expiresAt: "2030-05-05T00:00:00Z", registrationExpiresAt: reg }));
    expect(ssoExpiry("p", e)).toEqual({ expires_at: "2030-05-05T00:00:00Z", renewable: false });
    writeFileSync(file, JSON.stringify({ expiresAt: "2030-05-05T00:00:00Z", refreshToken: "x", registrationExpiresAt: "garbage" }));
    expect(ssoExpiry("p", e)).toEqual({ expires_at: "2030-05-05T00:00:00Z", renewable: false });
    expect(JSON.stringify(ssoExpiry("p", e))).not.toContain("SSOSECRET");
  });
  it("never returns or prints the token", () => {
    for (const p of ["panelator-delivery", "legacy", "plain", "nope"]) expect(JSON.stringify(ssoExpiry(p, env))).not.toContain("SSOSECRET");
  });
});

const lambda = (up: number, down: number, id = "panelator-console-api", conc = [100, 0]) => ({
  kind: "lambda-concurrency" as const, id,
  up: { expected_monthly_usd: up, setting: { reserved_concurrency: conc[0] } },
  down: { expected_monthly_usd: down, setting: { reserved_concurrency: conc[1] } },
});

describe("the scale descriptor (spec 068 AC-6)", () => {
  const withScale = (scale: unknown, usd = 6) => ({ ...ask("console api functions for the console", usd), scale } as any);
  it("is written with state up for each kind, and a reservation without one is unchanged", async () => {
    const w = await awsWorld();
    const cf = { kind: "cloudfront-distribution", id: "E123", up: { expected_monthly_usd: 3, setting: { enabled: true } }, down: { expected_monthly_usd: 1, setting: { enabled: false } } };
    const ddb = { kind: "dynamodb-throughput", id: "panelator-table", up: { expected_monthly_usd: 4, setting: { billing_mode: "PROVISIONED", read_capacity_units: 5, write_capacity_units: 5 } }, down: { expected_monthly_usd: 1, setting: { billing_mode: "PAY_PER_REQUEST" } } };
    expect(await reserveSpend(w.ctx, withScale(lambda(6, 1)))).toMatchObject({ ok: true });
    expect(await reserveSpend(w.ctx, { ...withScale(cf, 3), what: "the console distribution for the console" })).toMatchObject({ ok: true });
    expect(await reserveSpend(w.ctx, { ...withScale(ddb, 4), what: "the console table for the console data" })).toMatchObject({ ok: true });
    expect(await reserveSpend(w.ctx, ask("a plain thing for the console", 2))).toMatchObject({ ok: true });
    const ledger = JSON.parse(readFileSync(w.ctx.paths.awsLedger, "utf8"));
    expect(validate("aws-ledger", ledger).ok).toBe(true);
    expect(ledger.reservations.map((r: any) => r.scale?.state)).toEqual(["up", "up", "up", undefined]);
    expect("scale" in ledger.reservations[3]).toBe(false);
  });
  it.each([
    ["an unknown kind", { ...lambda(6, 1), kind: "ec2" }, /scale.kind/],
    ["an empty id", lambda(6, 1, ""), /scale.id/],
    ["a negative concurrency", lambda(6, 1, "f", [100, -1]), /reserved_concurrency/],
    ["a fractional concurrency", lambda(6, 1, "f", [1.5, 0]), /reserved_concurrency/],
    ["down not below up", lambda(6, 6), /below/],
    ["up different from the reservation's own cost", lambda(7, 1), /must equal/],
    ["a setting of another kind", { ...lambda(6, 1), down: { expected_monthly_usd: 1, setting: { enabled: false } } }, /setting/],
  ])("refuses %s before anything is written", async (_n, scale, re) => {
    const w = await awsWorld();
    const r = await reserveSpend(w.ctx, withScale(scale));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(re) });
    expect(() => readFileSync(w.ctx.paths.awsLedger)).toThrow();
    expect(w.notes).toEqual([]);
  });
  it("shows scale.kind and scale.state in the open reservations of aws", async () => {
    const w = await awsWorld();
    await reserveSpend(w.ctx, withScale(lambda(6, 1)));
    const out = await awsStatus(w.ctx, false);
    expect(out.lines.join("\n")).toContain("[scale lambda-concurrency: up]");
  });
});

describe("aws_scale (spec 068 AC-7)", () => {
  /** The fixture of AC-10: A (6 USD up, 1 down) and B (8 USD, no descriptor), cap 10, the 15th of a 30-day month, actual 4 USD. */
  async function fixture(cap = 10) {
    const w = await awsWorld({ start: "2026-11-15T12:00:00Z", cap });
    const base = { why: "charter: a console the maintainer can reach", by: "spec-e", at: "2026-11-01T00:00:00Z", released_at: null };
    await writeLedger(w.ctx.paths, { reservations: [
      { id: "A", what: "the console api functions", expected_monthly_usd: 6, ...base, scale: { ...lambda(6, 1), state: "up" } },
      { id: "B", what: "the console storage and so on", expected_monthly_usd: 8, ...base },
    ] });
    w.setCost(4);
    await awsTick(w.ctx);
    const ctx = { aws: w.ctx } as unknown as ActionContext;
    const check = (reservation_id: string, direction: string) => awsScaleKind.check({ reservation_id, direction }, ctx);
    const apply = (reservation_id: string, direction: string) => awsScaleKind.apply({ reservation_id, direction }, ctx);
    const cost = () => JSON.parse(readFileSync(w.ctx.paths.awsCost, "utf8"));
    const ledger = () => JSON.parse(readFileSync(w.ctx.paths.awsLedger, "utf8")).reservations;
    return { w, check, apply, cost, ledger };
  }
  it("starts from forecast 11 over a cap of 10, and the alarm names it", async () => {
    const { w, cost } = await fixture();
    expect(cost()).toMatchObject({ reserved_usd: 14, forecast_usd: forecastUsd(4, 14, 15, 30) });
    expect(cost().forecast_usd).toBe(11);
    expect(w.alarms).toMatchObject([{ kind: "aws_forecast_over_cap", forecast_usd: 11, cap_usd: 10 }]);
  });
  it("scales down through put-function-concurrency, recomputes by the formula, recovers, and returns the opposite undo", async () => {
    const { w, check, apply, cost, ledger } = await fixture();
    expect(await check("A", "down")).toBeNull();
    const out = await apply("A", "down");
    expect(out.undo).toEqual({ kind: "aws_scale", args: { reservation_id: "A", direction: "up" } });
    expect(w.calls().filter((c) => c[0] === "lambda")).toEqual([["lambda", "put-function-concurrency", "--function-name", "panelator-console-api", "--reserved-concurrent-executions", "0", "--profile", "panelator-delivery", "--region", "us-east-2", "--output", "json"]]);
    expect(ledger()[0]).toMatchObject({ expected_monthly_usd: 1, scale: { state: "down" } });
    expect(cost()).toMatchObject({ reserved_usd: 9, forecast_usd: forecastUsd(4, 9, 15, 30) });
    expect(cost().forecast_usd).toBeLessThanOrEqual(10);
    expect(labels(w)).toEqual(["aws-forecast", "aws-forecast"]);
    expect(w.notes.at(-1)!.text).toContain("back under the cap");
    expect(w.events("aws.reserve")).toMatchObject([{ payload: { id: "A", expected_monthly_usd: 1, outcome: "scaled", direction: "down", by: "spec-e" } }]);
    expect(await check("A", "down")).toBe("already down");
  });
  it("scales back up when the cap allows, and refuses up while it would put the forecast over the cap", async () => {
    const { w, check, apply, cost, ledger } = await fixture();
    await apply("A", "down");
    expect(await check("A", "up")).toBe("scaling up would put the forecast over the cap");
    w.cap.value = 20;
    expect(await check("A", "up")).toBeNull();
    await apply("A", "up");
    expect(ledger()[0]).toMatchObject({ expected_monthly_usd: 6, scale: { state: "up" } });
    expect(cost().forecast_usd).toBe(forecastUsd(4, 14, 15, 30));
    expect(w.calls().filter((c) => c[0] === "lambda").map((c) => c[5])).toEqual(["0", "100"]);
    expect(await check("A", "up")).toBe("already up");
  });
  it("refuses an unknown or released reservation, one without a descriptor, a bad direction, bad args and aws off", async () => {
    const { w, check } = await fixture();
    expect(await check("nope", "down")).toContain("not in the ledger");
    expect(await check("B", "down")).toContain("no scale descriptor");
    expect(await check("A", "sideways")).toContain("direction");
    await expect(awsScaleKind.check({ reservation_id: "A" }, { aws: w.ctx } as never)).rejects.toThrow(/args must contain/);
    expect(await awsScaleKind.check({ reservation_id: "A", direction: "down" }, {} as never)).toBe("aws: off");
    expect(await awsScaleKind.check({ reservation_id: "A", direction: "down" }, { aws: { ...w.ctx, config: undefined } } as never)).toBe("aws: off");
    await releaseSpend(w.ctx, "A");
    expect(await check("A", "down")).toContain("is released");
    w.setIdentity("999999999999");
    w.ctx.state.identityAt = null;
    expect(await check("B", "down")).toContain("no scale descriptor");
    const f = await fixture();
    f.w.setIdentity("999999999999");
    f.w.ctx.state.identityAt = null;
    expect(await f.check("A", "down")).toMatch(/^aws: off: profile panelator-delivery is in account 999999999999/);
  });
  it("leaves the ledger and the forecast unchanged when the call fails", async () => {
    const { w, apply, ledger, cost } = await fixture();
    const before = [JSON.stringify(ledger()), JSON.stringify(cost())];
    w.fail("lambda", true);
    await expect(apply("A", "down")).rejects.toThrow(/aws lambda put-function-concurrency failed/);
    expect([JSON.stringify(ledger()), JSON.stringify(cost())]).toEqual(before);
    expect(w.events("aws.reserve")).toEqual([]);
  });
  it("round-trips the CloudFront ETag and sets Enabled, and calls dynamodb update-table with the throughput", async () => {
    const w = await awsWorld({ start: "2026-11-15T12:00:00Z", cap: 100 });
    const base = { why: "charter: a console the maintainer can reach", by: "spec-e", at: "2026-11-01T00:00:00Z", released_at: null };
    await writeLedger(w.ctx.paths, { reservations: [
      { id: "C", what: "the console distribution", expected_monthly_usd: 3, ...base, scale: { kind: "cloudfront-distribution", id: "E123", up: { expected_monthly_usd: 3, setting: { enabled: true } }, down: { expected_monthly_usd: 1, setting: { enabled: false } }, state: "up" } },
      { id: "D", what: "the console table", expected_monthly_usd: 1, ...base, scale: { kind: "dynamodb-throughput", id: "panelator-table", up: { expected_monthly_usd: 4, setting: { billing_mode: "PROVISIONED", read_capacity_units: 5, write_capacity_units: 7 } }, down: { expected_monthly_usd: 1, setting: { billing_mode: "PAY_PER_REQUEST" } }, state: "down" } },
    ] });
    const ctx = { aws: w.ctx } as unknown as ActionContext;
    await awsScaleKind.apply({ reservation_id: "C", direction: "down" }, ctx);
    const cf = w.calls().filter((c) => c[0] === "cloudfront");
    expect(cf[0].slice(0, 4)).toEqual(["cloudfront", "get-distribution-config", "--id", "E123"]);
    expect(cf[1].slice(0, 6)).toEqual(["cloudfront", "update-distribution", "--id", "E123", "--if-match", "ETAG-1"]);
    expect(JSON.parse(cf[1][7])).toEqual({ CallerReference: "r", Enabled: false });
    await awsScaleKind.apply({ reservation_id: "D", direction: "up" }, ctx);
    expect(w.calls().find((c) => c[0] === "dynamodb")!.slice(0, 7)).toEqual(["dynamodb", "update-table", "--table-name", "panelator-table", "--billing-mode", "PROVISIONED", "--provisioned-throughput"]);
    expect(w.calls().find((c) => c[0] === "dynamodb")![7]).toBe("ReadCapacityUnits=5,WriteCapacityUnits=7");
  });
  it("is reached through applyAction only for an allowed agent, and its undo goes back", async () => {
    const { w, ledger } = await fixture();
    const { ActionLog } = await import("../src/actions/log.ts");
    const { ParameterStore } = await import("../src/parameters/store.ts");
    const { loadParameterDefinitions } = await import("../src/parameters/definitions.ts");
    const { agentsDir } = await import("../src/config.ts");
    const log = new ActionLog(w.ctx.paths.actionsLog, w.ctx.paths);
    const ctx = { paths: w.ctx.paths, parameters: new ParameterStore(w.ctx.paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), { slots: 1 } as never, {})), log, levels: loadActionLevels(join(agentsDir, "actions.yaml")), now: () => w.clock.now, gh: { rerunWorkflowRun: async () => {}, cancelWorkflowRun: async () => {} }, aws: w.ctx } as ActionContext;
    const req = { agent: "infra-health", run_id: "r", kind: "aws_scale", args: { reservation_id: "A", direction: "down" }, why: "forecast 11 USD against a cap of 10 USD; saving 5 USD" };
    expect((await applyAction(ctx, req, ["pause_agent"])).reason).toBe("action not allowed");
    const row = await applyAction(ctx, req, ["aws_scale", "undo"]);
    expect(row).toMatchObject({ status: "applied", undo: { kind: "aws_scale", args: { reservation_id: "A", direction: "up" } } });
    expect(ledger()[0].scale.state).toBe("down");
    w.cap.value = 20;
    const undone = await applyAction(ctx, { ...req, kind: "undo", args: { action_id: row.id } }, ["undo"]);
    expect(undone.status).toBe("applied");
    expect(ledger()[0].scale.state).toBe("up");
    expect((await applyAction(ctx, { ...req, args: { reservation_id: "A", direction: "up" } }, ["aws_scale"])).reason).toBe("already up");
  });
});
