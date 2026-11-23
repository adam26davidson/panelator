import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { standingWorld } from "./helpers/e2e-routes.ts";
import { fakeAwsCommand, ACCOUNT } from "./helpers/aws.ts";
import { awsCli } from "../src/aws/cli.ts";
import { forecastUsd, writeLedger, type AwsLedger } from "../src/aws/book.ts";
import { newAwsState, type AwsContext } from "../src/aws/context.ts";
import { reserveSpend } from "../src/aws/ledger.ts";
import { readJsonLines } from "../src/filer/input.ts";
import { readAgentState, writeAgentState } from "../src/standing/state.ts";
import { recordedNotifier } from "../src/notify/recorded.ts";
import { rateLimited } from "../src/notify/rate-limit.ts";
import { TelegramNotifier } from "../src/notify/telegram.ts";
import { LogNotifier } from "../src/notify/log.ts";
import type { TelegramChannel } from "../src/telegram/channel.ts";
import type { LogEntry } from "../src/actions/log.ts";
import { agentsDir } from "../src/config.ts";
import { CredentialStore } from "../src/credentials/store.ts";
import { loadCatalogue, profileNames } from "../src/credentials/catalogue.ts";
import { expiryEvents, runCheck } from "../src/credentials/check.ts";

// Spec 068 AC-10: recorded worlds for the AWS half of row F2. The real scheduler loop, the real standing runner and the
// fake `aws`, `systemd-creds` and Telegram channel.
const FAKE_CREDS = join(import.meta.dirname, "helpers", "fake-systemd-creds");
const NOW = new Date("2026-11-15T12:00:00Z");
const CONFIG = { profile: "panelator-delivery", account_id: ACCOUNT, region: "us-east-2", pull_interval_h: 24 };
const why = "Forecast 11 USD against a cap of 10 USD; the saving is 5 USD";

async function world(results: Record<string, unknown[]>, opts: { cap?: number; block?: boolean; home?: string; repeatHours?: number } = {}) {
  const w = await standingWorld(results as never);
  for (const name of Object.keys(w.registry).filter((n) => n !== "infra-health")) await writeAgentState(w.paths, name, { ...(await readAgentState(w.paths, name))!, paused: true, paused_by: "maintainer" });
  await writeAgentState(w.paths, "infra-health", { ...(await readAgentState(w.paths, "infra-health"))!, paused: false, paused_by: null, next_run: "2099-01-01T00:00:00.000Z" });
  w.setNow(NOW);
  const fx = mkdtempSync(join(tmpdir(), "e2e-aws-"));
  const write = (name: string, v: unknown) => writeFileSync(join(fx, name), JSON.stringify(v));
  write("identity.json", { Account: ACCOUNT, Arn: "arn:x" });
  write("ce.json", { ResultsByTime: [{ Total: { UnblendedCost: { Amount: "4", Unit: "USD" } } }] });
  writeFileSync(join(fx, "calls.log"), "");
  const cap = { value: opts.cap ?? 10 };
  const env = { ...process.env, FAKE_AWS_DIR: fx, ...(opts.home ? { HOME: opts.home } : {}) };
  const sent: { text: string; markup?: unknown }[] = [];
  const chan = { fail: false };
  const channel = { sendReply: async (text: string, _r?: number, markup?: unknown) => { if (chan.fail) throw new Error("boom"); sent.push({ text, markup }); return 100 + sent.length; } } as unknown as TelegramChannel;
  const chain = rateLimited(recordedNotifier(TelegramNotifier(new LogNotifier(w.paths.serviceLog), { telegram: () => channel, alertsPath: w.paths.telegramAlerts, outboxPath: w.paths.telegramOutbox, now: () => w.deps.now(), log: () => {} }), w.paths, () => w.deps.now()), { hours: 4, repeatHours: opts.repeatHours ?? 24, path: w.paths.notifySent });
  w.deps.notifier = chain;
  const aws: AwsContext = {
    config: opts.block === false ? undefined : CONFIG, paths: w.paths, cli: opts.block === false ? undefined : awsCli(CONFIG, { command: fakeAwsCommand, env }),
    parameters: { read: async (name: string) => (name === "aws_cap_usd" ? { value: cap.value } : w.parameters.read(name)) } as never,
    notifier: chain, notifyHours: 4, now: () => w.deps.now(), log: () => {}, emitEvent: (e, p) => w.deps.emitEvent!(e, p), state: newAwsState(),
  };
  w.deps.aws = aws;
  const calls = () => readFileSync(join(fx, "calls.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  const events = (kind: string): Record<string, any>[] => readdirSync(w.paths.events).filter((f) => f.endsWith(".jsonl")).sort()
    .flatMap((f) => readFileSync(join(w.paths.events, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((e) => e.kind === kind);
  const idle = async () => { for (let i = 0; i < 1000 && w.scheduler.active; i++) await new Promise((r) => setTimeout(r, 25)); };
  const run = async () => { await w.scheduler.tick(); await idle(); };
  const actions = () => readJsonLines<LogEntry>(w.paths.actionsLog);
  const cost = () => JSON.parse(readFileSync(w.paths.awsCost, "utf8"));
  const ledger = () => (JSON.parse(readFileSync(w.paths.awsLedger, "utf8")) as AwsLedger).reservations as any[];
  const serviceLog = () => readJsonLines<Record<string, any>>(w.paths.serviceLog);
  return { ...w, aws, fx, write, cap, calls, events, idle, run, actions, cost, ledger, sent, chan, serviceLog, env };
}

const lambda = (up: number, down: number) => ({ kind: "lambda-concurrency" as const, id: "panelator-console-api", up: { expected_monthly_usd: up, setting: { reserved_concurrency: 100 } }, down: { expected_monthly_usd: down, setting: { reserved_concurrency: 0 } } });
const base = { why: "charter: a console the maintainer can reach", by: "spec-e", at: "2026-11-01T00:00:00Z" };
const fixtureLedger = (): AwsLedger => ({ reservations: [
  { id: "A", what: "the console api functions", expected_monthly_usd: 6, ...base, released_at: null, scale: { ...lambda(6, 1), state: "up" } },
  { id: "B", what: "the console storage and so on", expected_monthly_usd: 8, ...base, released_at: null },
  { id: "R", what: "a released console thing", expected_monthly_usd: 2, ...base, released_at: "2026-11-10T00:00:00Z", scale: { ...lambda(2, 1), state: "up" } },
] });
const scale = (id: string, direction: string) => ({ kind: "aws_scale", args: { reservation_id: id, direction }, why });

describe("end to end: infra health scales the ledger (spec 068 AC-10)", () => {
  it("scales A down on the alarm, recovers, and later scales it up when the cap allows", async () => {
    let seen = "";
    const w = await world({ "infra-health": [
      (run: { prompt: string }) => { seen = run.prompt; return { summary: "scaled A down", actions: [scale("A", "down")], findings: [{ what: "reservation B cannot scale: no descriptor", where: "aws/ledger.json", evidence: "B is 8 USD a month with no scale descriptor; forecast was 11 USD against 10 USD", noticed_how: "infra health sweep" }] }; },
      { summary: "tried up under the cap", actions: [scale("A", "up")] },
      { summary: "cap raised", actions: [scale("A", "up"), scale("A", "up"), scale("R", "up")] },
    ] }); // the limiter runs with its default windows, as the service does
    await writeLedger(w.paths, fixtureLedger());
    // the pull: actual 4 USD on the 15th of a 30-day month, reserved 14 USD (the released R counts for nothing)
    await w.run();
    // the pull recorded the forecast of the fixture: trend 8, ledger view 4 + 14 x 15 / 30 = 11
    expect(w.events("aws.cost")[0]!.payload).toMatchObject({ actual_usd: 4, reserved_usd: 14, forecast_usd: forecastUsd(4, 14, 15, 30) });
    expect(w.events("aws.cost")[0]!.payload.forecast_usd).toBe(11);
    expect(w.adapter.ran).toEqual(["infra-health"]);
    expect(seen).toContain("aws_forecast_over_cap");
    expect(seen).toContain('"forecast_usd":11');
    expect(seen).toContain("panelator-console-api");
    expect(w.calls().filter((c) => c[0] === "lambda")).toHaveLength(1);
    expect(w.calls().find((c) => c[0] === "lambda")!.slice(0, 6)).toEqual(["lambda", "put-function-concurrency", "--function-name", "panelator-console-api", "--reserved-concurrent-executions", "0"]);
    expect(w.ledger()[0]).toMatchObject({ id: "A", expected_monthly_usd: 1, scale: { state: "down" } });
    expect(w.cost()).toMatchObject({ reserved_usd: 9, forecast_usd: forecastUsd(4, 9, 15, 30) });
    expect(w.cost().forecast_usd).toBe(8.5);
    expect(w.cost().forecast_usd).toBeLessThanOrEqual(10);
    const forecasts = w.sent.filter((n) => n.text.startsWith("aws: aws-forecast"));
    expect(forecasts).toHaveLength(2);
    expect(forecasts[1]!.text).toContain("back under the cap");
    expect(w.events("aws.reserve").filter((e) => e.payload.outcome === "scaled")).toHaveLength(1);
    expect(w.events("aws.reserve").find((e) => e.payload.outcome === "scaled")!.payload).toMatchObject({ id: "A", direction: "down", expected_monthly_usd: 1 });
    const row = (await w.actions()).find((r) => r.kind === "aws_scale")!;
    expect(row).toMatchObject({ status: "applied", agent: "infra-health", undo: { kind: "aws_scale", args: { reservation_id: "A", direction: "up" } } });
    const findings = await readJsonLines<{ finding: { what: string } }>(w.paths.findingsQueue);
    expect(findings.map((f) => f.finding.what)).toEqual(["reservation B cannot scale: no descriptor"]);

    // The next sweep under the same cap: scaling up would put the forecast back over it.
    const wake = async () => { w.setNow(new Date(w.deps.now().getTime() + 60_000)); const s = (await readAgentState(w.paths, "infra-health"))!; await writeAgentState(w.paths, "infra-health", { ...s, next_run: w.deps.now().toISOString() }); await w.run(); };
    await wake();
    expect((await w.actions()).filter((r) => r.kind === "aws_scale").at(-1)).toMatchObject({ status: "refused", reason: "scaling up would put the forecast over the cap" });

    // Cap raised to 20 USD, same clock date and the same pulled actual: A goes back up and the forecast is the formula's.
    w.cap.value = 20;
    await wake();
    const rows = (await w.actions()).filter((r) => r.kind === "aws_scale").slice(-3);
    expect(rows.map((r) => [r.status, r.reason])).toEqual([["applied", undefined], ["refused", "already up"], ["refused", expect.stringContaining("is released")]]);
    expect(w.ledger()[0]).toMatchObject({ expected_monthly_usd: 6, scale: { state: "up" } });
    expect(w.cost().forecast_usd).toBe(forecastUsd(4, 14, 15, 30));
    expect(w.cost().cap_usd).toBe(20);
    expect(w.calls().filter((c) => c[0] === "lambda").map((c) => c[5])).toEqual(["0", "100"]);
  }, 120_000);
});

describe("end to end: the funds request over Telegram (spec 068 AC-10)", () => {
  it("sends one message with the request's lines and records one funds event; a refused send is still one funds event on the channel the log names", async () => {
    const w = await world({}, { cap: 10 });
    w.write("ce.json", { ResultsByTime: [{ Total: { UnblendedCost: { Amount: "4", Unit: "USD" } } }] });
    await w.run();
    const ask = (what: string) => ({ what, expected_monthly_usd: 20, why: "charter: a console the maintainer can reach", by: "spec-e" });
    expect(await reserveSpend(w.aws, ask("a larger console instance"))).toMatchObject({ ok: false });
    expect(w.sent).toHaveLength(1);
    const text = w.sent[0]!.text;
    expect(text).toMatch(/^aws-funds:a-larger-console-instance: aws-funds\n\nAmount: 4 USD a month\nPurpose: a larger console instance \(expected 20 USD a month\)\nCharter goal: charter: a console the maintainer can reach\n/);
    expect(text).toContain("panelator-scheduler param set aws_cap_usd 14");
    expect(text).toContain("budget amount in the management account");
    expect(w.sent[0]!.markup).toBeUndefined();
    const funds = () => w.events("maintainer.contact").map((e) => e.payload).filter((p) => p.kind === "funds");
    expect(funds()).toHaveLength(1);
    expect(funds()[0]).toMatchObject({ channel: "telegram", label: "aws-funds", request: { type: "funds", amount_usd: 4, purpose: "a larger console instance" } });
    expect(w.events("maintainer.contact").filter((e) => e.payload.label === "aws-funds" && e.payload.kind === "notification")).toEqual([]);

    // The same with the chat refusing: spec 102's implementation is on this base, so the channel is queued.
    w.chan.fail = true;
    expect(await reserveSpend(w.aws, ask("another larger console instance"))).toMatchObject({ ok: false });
    expect(funds()).toHaveLength(2);
    const last = funds()[1]!;
    const line = (await w.serviceLog()).filter((l) => l.kind === "notify" && l.label === "aws-funds").at(-1)!;
    expect(last.channel).toBe(line.channel);
    expect(last.channel).toBe("queued");
    expect(w.sent).toHaveLength(1);
  }, 60_000);
});

describe("end to end: the aws-sso credential (spec 068 AC-10)", () => {
  const catalogue = () => loadCatalogue(join(agentsDir, "credentials.yaml"), { profiles: profileNames(agentsDir), agents: ["action-audit", "charter-reflection", "credential-check", "delivery-reflection", "findings-filer", "infra-health", "meta-reflection"] });
  const cacheFile = (dir: string) => join(dir, ".aws", "sso", "cache", `${createHash("sha1").update("default").digest("hex")}.json`);
  /** The renewable cache a login leaves: an old access token, a refresh token, the registration `registration` away. */
  function home(registration: Date) {
    const expires = registration;
    const dir = mkdtempSync(join(tmpdir(), "e2e-home-"));
    mkdirSync(join(dir, ".aws", "sso", "cache"), { recursive: true });
    writeFileSync(join(dir, ".aws", "config"), "[profile panelator-delivery]\nsso_session = default\nsso_account_id = 123456789012\nregion = us-east-2\n");
    writeFileSync(join(dir, ".aws", "sso", "cache", `${createHash("sha1").update("default").digest("hex")}.json`), JSON.stringify({ expiresAt: new Date(NOW.getTime() - 3_600_000).toISOString(), registrationExpiresAt: expires.toISOString(), accessToken: "SSOSECRET-ACCESS", refreshToken: "SSOSECRET-REFRESH", clientSecret: "SSOSECRET-CLIENT" }));
    return dir;
  }
  async function credWorld(opts: { account?: string; set?: boolean; block?: boolean; due?: boolean } = {}) {
    const w = await world({ "credential-check": [
      { summary: "one warning", warnings: [{ name: "aws-sso", expires_at: "2026-11-18T12:00:00Z", steps: ["scripted step that must not be used"] }] },
      { summary: "again", warnings: [{ name: "aws-sso", expires_at: "2026-11-18T12:00:00Z", steps: ["scripted step that must not be used"] }] },
    ] }, { home: home(new Date(NOW.getTime() + 3 * 86_400_000)), block: opts.block });
    await writeAgentState(w.paths, "credential-check", { ...(await readAgentState(w.paths, "credential-check"))!, paused: false, paused_by: null, next_run: opts.due ? NOW.toISOString() : "2099-01-01T00:00:00.000Z" });
    if (opts.account) w.write("identity.json", { Account: opts.account, Arn: "arn:x" });
    const store = new CredentialStore({ dir: join(w.pair.root, "cred-store"), systemdCreds: FAKE_CREDS });
    const cat = catalogue();
    const probe = { store, app: w.deps.cfg.app, now: () => w.deps.now(), aws: { config: w.aws.config, cli: (profile: string) => awsCli({ profile, region: CONFIG.region }, { command: fakeAwsCommand, env: w.env }), env: w.env } };
    Object.assign(w.deps, { catalogue: cat, checkContext: probe, credentials: { store, catalogue: cat, warnDays: 7 }, scope: async () => ({ status: "ok" as const }) });
    // `cred set aws-sso`: the secret goes in the store, then the entry's check runs (it reads the expiry too).
    if (opts.set !== false) await store.writeSecret("aws-sso", "panelator-delivery\n", "maintainer");
    const result = await runCheck(cat["aws-sso"]!, probe);
    return { ...w, store, cat, result };
  }

  it("a session expiring in three days: the probe writes the expiry, one event, one warning, one Telegram message led by the login step, nothing twice", async () => {
    const w = await credWorld();
    expect(w.result).toEqual({ status: "ok" });
    const entry = (await w.store.readIndex())["aws-sso"]!;
    expect(entry.expires_at).toBe(new Date(NOW.getTime() + 3 * 86_400_000).toISOString());
    await w.run();
    expect(w.adapter.ran).toEqual(["credential-check"]);
    const notes = w.sent.filter((s) => s.text.startsWith("credential-expiry: aws-sso"));
    expect(notes).toHaveLength(1);
    const body = notes[0]!.text;
    expect(body).toContain("1. Run `aws sso login --sso-session default`");
    expect(body).not.toContain("scripted step that must not be used");
    expect(body.indexOf("aws sso login")).toBeLessThan(body.indexOf("cred check aws-sso"));
    expect((await w.serviceLog()).filter((l) => l.kind === "notify" && l.gate === "credential-expiry").map((l) => l.channel)).toEqual(["telegram"]);
    expect(body).toContain("the CLI's login registration ends");
    expect((await w.store.readIndex())["aws-sso"]).toMatchObject({ renewable: true, heads_up_for: entry.expires_at });
    // the maintainer logs in: a new access token, the same registration; the check passes and the next day says nothing
    writeFileSync(cacheFile(w.env.HOME!), JSON.stringify({ expiresAt: new Date(NOW.getTime() + 86_400_000 + 3_600_000).toISOString(), registrationExpiresAt: entry.expires_at!, accessToken: "SSOSECRET-ACCESS2", refreshToken: "SSOSECRET-REFRESH2" }));
    expect(await runCheck(w.cat["aws-sso"]!, w.deps.checkContext as never)).toEqual({ status: "ok" });
    w.setNow(new Date(NOW.getTime() + 25 * 3_600_000));
    const s = (await readAgentState(w.paths, "credential-check"))!;
    await writeAgentState(w.paths, "credential-check", { ...s, next_run: w.deps.now().toISOString() });
    await w.run(); await w.run();
    expect(await expiryEvents({ store: w.store, catalogue: w.cat, warnDays: 7, statePath: w.paths.credentialsExpiryState, now: w.deps.now })).toEqual([]);
    expect(w.sent.filter((x) => x.text.startsWith("credential-expiry: aws-sso"))).toHaveLength(1);
    const everything = JSON.stringify([w.sent, await w.serviceLog(), await w.store.readIndex(), w.events("maintainer.contact")]);
    expect(everything).not.toContain("SSOSECRET");
  }, 120_000);

  it("the identity in another account fails the check, sends aws-access once, and warns once with the renew steps", async () => {
    const w = await credWorld({ account: "999999999999" });
    expect(w.result).toMatchObject({ status: "failed", reason: expect.stringContaining("999999999999") });
    await w.run();
    // the scheduler's own identity check sends aws-access once; the credential warning follows
    expect(w.sent.filter((s) => s.text.startsWith("aws: aws-access"))).toHaveLength(1);
    await w.run();
    const warned = w.sent.filter((s) => s.text.startsWith("credential-expiry: aws-sso"));
    expect(warned).toHaveLength(1);
    expect(warned[0]!.text).toContain("aws sso login --sso-session default");
    expect(w.sent.filter((s) => s.text.startsWith("aws: aws-access"))).toHaveLength(1);
  }, 120_000);

  it("without an aws block the check is skipped and nothing warns; with a block and no credential the warning carries the setup steps", async () => {
    const off = await credWorld({ block: false, set: false });
    expect(off.result).toEqual({ status: "skipped", reason: "aws: off: no aws block in agents/scheduler.yaml" });
    await off.run(); await off.run();
    expect(off.adapter.ran).not.toContain("credential-check");
    expect(off.events("credential_expiry")).toEqual([]);
    expect(off.sent.filter((s) => s.text.includes("aws-sso"))).toEqual([]);
    const input = (await import("../src/standing/credential-check-input.ts")).buildCredentialCheckInput;
    const built = await input({ paths: off.paths, catalogue: off.cat, probe: off.deps.checkContext as never, warnDays: 7, scope: async () => ({ status: "ok" as const }), now: off.deps.now() }, [], null);
    expect((built as any).checks["aws-sso"].status).toBe("skipped");

    const on = await credWorld({ set: false, due: true });
    expect(on.result).toMatchObject({ status: "failed", reason: expect.stringContaining("cred set aws-sso") });
    // No index entry exists, so the warning carries the catalogue's setup steps.
    await on.run(); await on.run();
    expect(on.adapter.ran).toContain("credential-check");
    const body = on.sent.find((s) => s.text.startsWith("credential-expiry: aws-sso"))?.text ?? "";
    expect(body).toContain("PanelatorDelivery");
    expect(body).not.toContain("cred check aws-sso`; it prints");
  }, 120_000);
});
