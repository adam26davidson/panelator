import { createPrivateKey } from "node:crypto";
import type { Config } from "../config.ts";
import { createAppClient } from "../github/auth.ts";
import { TelegramApiError, TelegramClient } from "../telegram/client.ts";
import { PROBE_NAMES, type CatalogueEntry, type ProbeName } from "./catalogue.ts";
import type { CredentialStore } from "./store.ts";

export { PROBE_NAMES };

export type CheckResult = { status: "ok" } | { status: "failed"; reason: string } | { status: "skipped"; reason: string };

export interface CheckContext {
  store: CredentialStore;
  cfg: Config;
  /** the fetch the scheduler injects for tests */
  fetch?: typeof fetch;
  telegramBaseUrl?: string;
  now?: () => Date;
}

const failed = (reason: string): CheckResult => ({ status: "failed", reason });

/** A reason for an unexpected error, with no line of the secret in it. */
function describe(e: unknown, secret: string): string {
  const status = (e as { status?: unknown })?.status;
  if (typeof status === "number") return String(status);
  let msg = e instanceof Error ? e.message : "error";
  for (const line of secret.split(/\s+/)) if (line.length >= 8) msg = msg.split(line).join("[redacted]");
  return msg.slice(0, 200) || "error";
}

/** `GET /app` with an App JWT signed by the stored key; passes only when GitHub answers with the configured App. */
async function githubApp(ctx: CheckContext): Promise<CheckResult> {
  const key = await ctx.store.readSecret("github-app-key");
  try {
    if (createPrivateKey(key).asymmetricKeyType !== "rsa") return failed("key does not parse");
  } catch {
    return failed("key does not parse");
  }
  try {
    const info = await createAppClient(ctx.cfg.app, key, ctx.fetch).appInfo();
    if (info.id !== ctx.cfg.app.id) return failed(`key belongs to App ${info.id}, configured App is ${ctx.cfg.app.id}`);
    return { status: "ok" };
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    if (status === 401) return failed("GitHub refused the JWT (401)");
    return failed(describe(e, key));
  }
}

/** `getMe` with the stored bot token. */
async function telegramGetMe(ctx: CheckContext): Promise<CheckResult> {
  const text = await ctx.store.readSecret("telegram-bot");
  let token: string;
  let chat: number;
  try {
    const v = JSON.parse(text) as { bot_token?: unknown; chat_id?: unknown };
    if (typeof v.bot_token !== "string" || !v.bot_token || typeof v.chat_id !== "number" || !Number.isSafeInteger(v.chat_id)) throw new Error("shape");
    token = v.bot_token;
    chat = v.chat_id;
  } catch {
    return failed("secret is not { bot_token, chat_id }");
  }
  try {
    await new TelegramClient(token, chat, ctx.telegramBaseUrl).getMe();
    return { status: "ok" };
  } catch (e) {
    if (e instanceof TelegramApiError) return failed(e.error_code === 401 ? "unauthorized" : e.error_code ? String(e.error_code) : e.description.split(token).join("[redacted]"));
    return failed(describe(e, token));
  }
}

const PROBES: Record<ProbeName, (ctx: CheckContext) => Promise<CheckResult>> = { "github-app": githubApp, "telegram-get-me": telegramGetMe };

/** Runs the entry's check and writes `last_checked_at` and `last_check` to the index: the only place those are written. */
export async function runCheck(entry: CatalogueEntry, ctx: CheckContext): Promise<CheckResult> {
  let result: CheckResult;
  if (typeof entry.check === "string") result = { status: "skipped", reason: "wrapper not built" };
  else if (!(await ctx.store.has(entry.name))) result = { status: "skipped", reason: "not set" };
  else {
    try {
      result = await PROBES[entry.check.builtin](ctx);
    } catch (e) {
      // a store failure (decrypt): its message never carries the secret
      result = failed((e as Error).message);
    }
  }
  const at = (ctx.now?.() ?? new Date()).toISOString();
  await ctx.store.updateCheck(entry.name, at, result.status === "ok" ? "ok" : result.status === "failed" ? `failed: ${result.reason}` : null);
  return result;
}
