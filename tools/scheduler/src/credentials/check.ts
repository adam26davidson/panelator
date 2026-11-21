import { createPrivateKey } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AwsConfig, Config } from "../config.ts";
import type { AwsCli } from "../aws/cli.ts";
import { ssoExpiry } from "../aws/sso.ts";
import { createAppClient } from "../github/auth.ts";
import { TelegramClient, TelegramApiError } from "../telegram/client.ts";
import { BUILTINS, type CredentialEntry } from "./catalogue.ts";
import type { CredentialStore } from "./store.ts";

export { BUILTINS };
export type CheckResult = { status: "ok" } | { status: "failed"; reason: string } | { status: "skipped"; reason: string };
export interface CheckContext {
  store: CredentialStore;
  app: Config["app"];
  fetch?: typeof fetch;
  telegramBaseUrl?: string;
  now: () => Date;
  /** Spec 068 AC-1: what a `provider: aws` entry's check needs; absent `config` means AWS is off. */
  aws?: { config?: AwsConfig; cli: (profile: string) => AwsCli; env: NodeJS.ProcessEnv };
}

const failed = (reason: string): CheckResult => ({ status: "failed", reason });

/** Spec 069 AC-2: sign an App JWT with the stored key and call `GET /app`; nothing else is read or written. */
async function githubApp(ctx: CheckContext): Promise<CheckResult> {
  const key = await ctx.store.readSecret("github-app-key");
  try {
    createPrivateKey(key);
  } catch {
    return failed("key does not parse");
  }
  try {
    const me = await createAppClient(ctx.app, key, ctx.fetch ?? fetch, { retry: false }).appIdentity();
    if (me.id === ctx.app.id) return { status: "ok" };
    return failed(`key belongs to App ${me.id}, configured App is ${ctx.app.id}`);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401) return failed("GitHub refused the JWT (401)");
    return failed(String(status ?? (e as Error).message));
  }
}

/** Spec 069 AC-4: `getMe` with the stored bot token. */
async function telegramGetMe(ctx: CheckContext): Promise<CheckResult> {
  const raw = await ctx.store.readSecret("telegram-bot");
  let parsed: { bot_token?: unknown; chat_id?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failed("secret is not { bot_token, chat_id }");
  }
  if (!parsed || typeof parsed.bot_token !== "string" || !parsed.bot_token || (typeof parsed.chat_id !== "number" && typeof parsed.chat_id !== "string")) return failed("secret is not { bot_token, chat_id }");
  const token = parsed.bot_token;
  try {
    await new TelegramClient(token, Number(parsed.chat_id), ctx.telegramBaseUrl).getMe();
    return { status: "ok" };
  } catch (e) {
    if (e instanceof TelegramApiError) return failed(e.error_code === 401 ? "unauthorized" : String(e.error_code || e.description));
    return failed((e as Error).message.split(token).join("<token>"));
  }
}

const PROBES: Record<(typeof BUILTINS)[number], (ctx: CheckContext) => Promise<CheckResult>> = { "github-app": githubApp, "telegram-get-me": telegramGetMe };

/** Spec 068 AC-1: the `aws-sso` check, through src/aws/cli.ts with the stored profile; then the expiry from the CLI's cache. */
async function awsProvider(entry: CredentialEntry, ctx: CheckContext): Promise<CheckResult> {
  const aws = ctx.aws;
  if (!aws?.config) return { status: "skipped", reason: "aws: off: no aws block in agents/scheduler.yaml" };
  let profile: string;
  try {
    profile = (await ctx.store.readSecret(entry.name)).trim();
  } catch (e) {
    return failed((e as Error).message);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(profile)) return failed("not a profile name");
  let result: CheckResult;
  try {
    const id = (await aws.cli(profile).run(["sts", "get-caller-identity"])) as { Account?: string };
    result = id.Account === aws.config.account_id ? { status: "ok" } : failed(`profile ${profile} is in account ${id.Account ?? "unknown"}, not ${aws.config.account_id}`);
  } catch (e) {
    result = failed((e as Error).message.split("\n")[0]);
  }
  const expiry = ssoExpiry(profile, aws.env);
  if ("expires_at" in expiry) await ctx.store.writeExpiry(entry.name, new Date(expiry.expires_at).toISOString());
  else if ("none" in expiry) await ctx.store.writeExpiry(entry.name, null);
  return result;
}

/** The one function that runs an entry's check and the only writer of the index's check fields (spec 069 AC-5). */
export async function runCheck(entry: CredentialEntry, ctx: CheckContext): Promise<CheckResult> {
  let result: CheckResult;
  if (entry.provider === "aws" && typeof entry.check === "string") result = await awsProvider(entry, ctx);
  else if (typeof entry.check === "string") result = { status: "skipped", reason: "wrapper not built" };
  else {
    try {
      result = await PROBES[entry.check.builtin](ctx);
    } catch (e) {
      result = failed((e as Error).message);
    }
  }
  await ctx.store.writeCheck(entry.name, {
    last_checked_at: ctx.now().toISOString(),
    last_check: result.status === "ok" ? "ok" : result.status === "failed" ? `failed: ${result.reason}` : null,
  });
  return result;
}

const DAY_MS = 86_400_000;
export interface ExpiryState { [name: string]: string; }
export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + ".tmp", JSON.stringify(data, null, 2) + "\n");
  await rename(path + ".tmp", path);
}

/** Spec 099 AC-3: `credential_expiry` payloads from the index alone (no check runs), at most one per name per day. */
export async function expiryEvents(ctx: { store: CredentialStore; catalogue: Record<string, CredentialEntry>; warnDays: number; statePath: string; now: () => Date }): Promise<{ name: string; expires_at: string | null; last_check: string | null }[]> {
  const index = await ctx.store.readIndex();
  const now = ctx.now();
  const raw = await readJsonFile<Record<string, unknown>>(ctx.statePath, {});
  const state: ExpiryState = typeof raw.emitted === "object" && raw.emitted ? (raw.emitted as ExpiryState) : (Object.fromEntries(Object.entries(raw).filter(([k, v]) => k !== "notified" && typeof v === "string")) as ExpiryState);
  const out: { name: string; expires_at: string | null; last_check: string | null }[] = [];
  for (const name of Object.keys(ctx.catalogue)) {
    const e = index[name];
    if (!e) continue;
    const expiring = e.expires_at !== null && Date.parse(e.expires_at) - now.getTime() <= ctx.warnDays * DAY_MS;
    const failing = typeof e.last_check === "string" && e.last_check.startsWith("failed");
    if (!expiring && !failing) continue;
    const last = state[name] ? Date.parse(state[name]!) : NaN;
    if (!Number.isNaN(last) && now.getTime() - last < DAY_MS) continue;
    out.push({ name, expires_at: e.expires_at, last_check: e.last_check });
    state[name] = now.toISOString();
  }
  if (out.length) await writeJsonAtomic(ctx.statePath, { ...raw, emitted: state });
  return out;
}
