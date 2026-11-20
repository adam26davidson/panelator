import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { awsCheck, awsPull, awsStatus } from "../src/aws/check.ts";
import { redact } from "../src/aws/cli.ts";
import { awsTick, pull } from "../src/aws/cost.ts";
import { forecastUsd } from "../src/aws/book.ts";
import { checkIdentity } from "../src/aws/identity.ts";
import { releaseSpend, reserveSpend } from "../src/aws/ledger.ts";
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
    const out = await awsCheck(w.ctx, home(sso, "2027-01-01T00:00:00Z"));
    expect(out.exitCode).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain(`(account ${ACCOUNT})`);
    expect(text).toContain("yes");
    expect(text).toContain("month-to-date cost: 12.50 USD");
    expect(text).toContain("cap: 100 USD");
    expect(text).toContain("sso session expires: 2027-01-01T00:00:00Z");
    expect(text).not.toContain("SSOSECRET");
    w.fail("ce", true);
    expect((await awsCheck(w.ctx, home("[profile panelator-delivery]\nregion = us-east-2\n"))).exitCode).toBe(1);
    expect((await awsCheck(w.ctx, home("[profile panelator-delivery]\nregion = us-east-2\n"))).lines.join("\n")).toContain("not SSO");
  });

  it("aws-check exits 1 for another account, and at cap 0 skips the cost call and exits 0 on a match", async () => {
    const w = await awsWorld();
    w.setIdentity("999999999999");
    expect((await awsCheck(w.ctx, home(sso))).exitCode).toBe(1);
    const z = await awsWorld({ cap: 0 });
    const out = await awsCheck(z.ctx, home(sso));
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
    expect(readFileSync(join(srcDir, "..", "..", "..", "agents", "actions.yaml"), "utf8")).not.toMatch(/aws/i);
  });
});
