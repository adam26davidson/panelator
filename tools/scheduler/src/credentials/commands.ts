import { readFile } from "node:fs/promises";
import type { ActionLog } from "../actions/log.ts";
import type { Config } from "../config.ts";
import type { CatalogueEntry } from "./catalogue.ts";
import { runCheck, type CheckContext, type CheckResult } from "./check.ts";
import type { CredentialStore } from "./store.ts";

export interface CredContext {
  cfg: Config;
  store: CredentialStore;
  catalogue: CatalogueEntry[];
  actionLog: ActionLog;
  /** the secret text for `cred set`, read from stdin by the caller */
  stdin: () => Promise<string>;
  fetch?: typeof fetch;
  telegramBaseUrl?: string;
  now?: () => Date;
}

export interface CredOutcome {
  exitCode: number;
  lines: string[];
}

export const CRED_USAGE = "usage: cred set <name> (secret on stdin) | list | check [<name>] | import | remove <name>";

const describe = (r: CheckResult): string => (r.status === "ok" ? "check ok" : `check ${r.status}: ${r.reason}`);

function setupSteps(e: CatalogueEntry): string[] {
  return e.setup.map((s, i) => `  ${i + 1}. ${s}`);
}

/** Spec 069 AC-3, AC-10: the maintainer's commands over the store; each is one row in the action log with the name only. */
export async function credCommand(args: string[], ctx: CredContext): Promise<CredOutcome> {
  const [verb, name] = args;
  const kinds: Record<string, string> = { set: "cred_set", list: "cred_list", check: "cred_check", import: "cred_import", remove: "cred_remove" };
  const kind = kinds[verb ?? ""];
  if (!kind) return { exitCode: 1, lines: [CRED_USAGE] };
  const named = ["set", "remove"].includes(verb);
  if (named && !name) return { exitCode: 1, lines: [CRED_USAGE] };
  const row = await ctx.actionLog.writePending({ agent: "maintainer", run_id: "command", kind, args: name && (named || verb === "check") ? { name } : {}, why: `Maintainer cred ${verb} command`, undo: null });
  let out: CredOutcome;
  try {
    out = await dispatch(verb, name, ctx);
  } catch (e) {
    out = { exitCode: 1, lines: [(e as Error).message] };
  }
  await ctx.actionLog.settle(row.id, out.exitCode === 0 ? "applied" : "failed", out.exitCode === 0 ? undefined : out.lines[0]);
  return out;
}

async function dispatch(verb: string, name: string | undefined, ctx: CredContext): Promise<CredOutcome> {
  const checkCtx: CheckContext = { store: ctx.store, cfg: ctx.cfg, fetch: ctx.fetch, telegramBaseUrl: ctx.telegramBaseUrl, now: ctx.now };
  const find = (n: string): CatalogueEntry => {
    const e = ctx.catalogue.find((x) => x.name === n);
    if (!e) throw new Error(`unknown credential ${n}`);
    return e;
  };
  if (verb === "set") {
    const e = find(name!);
    const secret = (await ctx.stdin()).replace(/\r?\n$/, "");
    if (!secret) throw new Error("no secret on stdin");
    await ctx.store.writeSecret(e.name, secret, "maintainer");
    const r = await runCheck(e, checkCtx);
    const lines = [`${e.name}: ${describe(r)}`];
    if (r.status === "failed") lines.push("setup steps:", ...setupSteps(e));
    return { exitCode: r.status === "failed" ? 1 : 0, lines };
  }
  if (verb === "list") {
    const index = await ctx.store.readIndex();
    return {
      exitCode: 0,
      lines: ctx.catalogue.map((e) => {
        const i = index.find((x) => x.name === e.name);
        if (!i) return `${e.name}: missing`;
        const expiry = e.expiry === "index" ? (i.expires_at ?? "unknown") : "none";
        return `${e.name}: set (by ${i.set_by}, ${i.created_at}), expiry ${expiry}, last check ${i.last_check ?? "never"}${i.last_checked_at ? ` at ${i.last_checked_at}` : ""}`;
      }),
    };
  }
  if (verb === "check") {
    const entries = name ? [find(name)] : ctx.catalogue;
    const lines: string[] = [];
    let failed = false;
    for (const e of entries) {
      const r = await runCheck(e, checkCtx);
      failed ||= r.status === "failed";
      lines.push(`${e.name}: ${describe(r)}`);
      if (typeof e.expiry === "object") lines.push(`${e.name}: expiry probe skipped: wrapper not built`);
    }
    return { exitCode: failed ? 1 : 0, lines };
  }
  if (verb === "import") {
    const sources: [string, string | undefined][] = [["github-app-key", ctx.cfg.app.private_key_path], ["telegram-bot", ctx.cfg.telegram?.credentials_path]];
    const lines: string[] = [];
    let failed = false;
    for (const [credential, path] of sources) {
      const e = find(credential);
      let text: string;
      try {
        text = await readFile(path ?? "", "utf8");
      } catch (err) {
        lines.push(`${credential}: not imported, cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
        continue;
      }
      await ctx.store.writeSecret(credential, text.replace(/\r?\n$/, ""), "import");
      const r = await runCheck(e, checkCtx);
      failed ||= r.status === "failed";
      lines.push(`${credential}: imported from ${path}, ${describe(r)}`);
    }
    lines.push(
      `${ctx.cfg.app.private_key_path}: safe to delete after the service has restarted and minted from the store`,
      `${ctx.cfg.telegram?.credentials_path}: keep it, the Telegram poller still reads it until a later spec moves it`,
    );
    return { exitCode: failed ? 1 : 0, lines };
  }
  // remove
  if (!(await ctx.store.removeSecret(find(name!).name))) throw new Error(`${name} is not set`);
  return { exitCode: 0, lines: [`${name}: removed`] };
}
