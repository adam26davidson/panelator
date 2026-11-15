import { createPrivateKey } from "node:crypto";
import type { Config } from "../config.ts";
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

/** The one function that runs an entry's check and the only writer of the index's check fields (spec 069 AC-5). */
export async function runCheck(entry: CredentialEntry, ctx: CheckContext): Promise<CheckResult> {
  let result: CheckResult;
  if (typeof entry.check === "string") result = { status: "skipped", reason: "wrapper not built" };
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
