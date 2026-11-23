import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsCli } from "../../src/aws/cli.ts";
import { newAwsState, type AwsContext } from "../../src/aws/context.ts";
import type { AwsConfig } from "../../src/config.ts";
import type { Notification } from "../../src/notify/types.ts";
import { recordedNotifier } from "../../src/notify/recorded.ts";
import { ensureStateDirs, statePaths } from "../../src/state/paths.ts";

export const ACCOUNT = "123456789012";
export const fakeAwsCommand = join(import.meta.dirname, "fake-aws");

export interface AwsWorld {
  dir: string;
  ctx: AwsContext;
  notes: Notification[];
  logs: Record<string, unknown>[];
  alarms: unknown[];
  cap: { value: number };
  clock: { now: Date };
  /** every `aws` invocation's argv */
  calls: () => string[][];
  setIdentity: (account: string) => void;
  setCost: (amount: number) => void;
  fail: (what: "sts" | "ce" | "lambda" | "cloudfront" | "dynamodb", on: boolean) => void;
  events: (kind: string) => Record<string, any>[];
  cleanup: () => void;
}

/** A context over a temp state directory, the fake `aws` command and a recorded notifier whose sends are collected. */
export async function awsWorld(opts: { start?: string; cap?: number; config?: Partial<AwsConfig> | null } = {}): Promise<AwsWorld> {
  const dir = mkdtempSync(join(tmpdir(), "aws-"));
  const fixtures = join(dir, "fixtures");
  mkdirSync(fixtures);
  const paths = statePaths(join(dir, "state"));
  await ensureStateDirs(paths);
  const world = { cap: { value: opts.cap ?? 100 }, clock: { now: new Date(opts.start ?? "2026-11-10T12:00:00Z") } };
  const write = (name: string, v: unknown) => writeFileSync(join(fixtures, name), JSON.stringify(v));
  write("identity.json", { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/PanelatorDelivery/adam`, UserId: "AROAFAKE:adam" });
  write("ce.json", { ResultsByTime: [{ Total: { UnblendedCost: { Amount: "0", Unit: "USD" } } }] });
  writeFileSync(join(fixtures, "calls.log"), "");
  const config: AwsConfig | undefined = opts.config === null ? undefined : { profile: "panelator-delivery", account_id: ACCOUNT, region: "us-east-2", pull_interval_h: 24, ...opts.config };
  const notes: Notification[] = [];
  const logs: Record<string, unknown>[] = [];
  const alarms: unknown[] = [];
  const clock = () => world.clock.now;
  const ctx: AwsContext = {
    config, paths,
    cli: config ? awsCli(config, { command: fakeAwsCommand, env: { ...process.env, FAKE_AWS_DIR: fixtures } }) : undefined,
    parameters: { read: async () => ({ value: world.cap.value }) },
    notifier: recordedNotifier({ notify: async (n) => { notes.push(n); } }, paths, clock),
    notifyHours: 4, now: clock, log: (r) => logs.push(r),
    emitEvent: async (event, payload) => { if (event === "infra_alarm") alarms.push(payload); },
    state: newAwsState(),
  };
  return {
    dir, ctx, notes, logs, alarms, ...world,
    calls: () => readFileSync(join(fixtures, "calls.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    setIdentity: (account) => write("identity.json", { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/Other/x`, UserId: "x" }),
    setCost: (amount) => write("ce.json", { ResultsByTime: [{ Total: { UnblendedCost: { Amount: String(amount), Unit: "USD" } } }] }),
    fail: (what, on) => (on ? writeFileSync(join(fixtures, `fail-${what}`), "") : existsSync(join(fixtures, `fail-${what}`)) && rmSync(join(fixtures, `fail-${what}`))),
    events: (kind) => {
      const file = join(paths.events, `${world.clock.now.toISOString().slice(0, 7)}.jsonl`);
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind) : [];
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
