import { applyAction, type ActionContext } from "../actions/index.ts";
import type { LogEntry } from "../actions/log.ts";
import type { CheckResult } from "./check.ts";

export interface CredDeps {
  ctx: ActionContext;
  readStdin: () => Promise<string>;
}
export interface CredOutput { lines: string[]; exitCode: 0 | 1 }

const request = (ctx: ActionContext, kind: string, name: string): Promise<LogEntry> =>
  applyAction(ctx, { agent: "maintainer", run_id: "command", kind, args: { name }, why: `Maintainer command line ${kind.replace("_", " ")} request` }, "maintainer");

/** Runs one credential through its kind and returns the lines to print and whether it counts as failed. The row is written by `applyAction`, never here. */
async function act(deps: CredDeps, kind: string, name: string): Promise<{ lines: string[]; failed: boolean; row: LogEntry }> {
  const cr = deps.ctx.credentials!;
  let result: CheckResult | undefined;
  cr.onResult = (n, r) => { if (n === name) result = r; };
  let row: LogEntry;
  try {
    row = await request(deps.ctx, kind, name);
  } finally {
    cr.onResult = undefined;
  }
  if (row.status !== "applied") return { lines: [`${name}: ${row.status}: ${row.reason ?? "unknown"}`], failed: true, row };
  if (!result) return { lines: [], failed: false, row };
  if (result.status === "ok") return { lines: [`${name}: check ok`], failed: false, row };
  if (result.status === "skipped") return { lines: [`${name}: check skipped: ${result.reason}`], failed: false, row };
  return { lines: [`${name}: check failed: ${result.reason}`, ...cr.catalogue[name].setup], failed: true, row };
}

export async function credCommand(verb: string, name: string | undefined, deps: CredDeps): Promise<CredOutput> {
  const cr = deps.ctx.credentials!;
  const known = () => name !== undefined && Object.hasOwn(cr.catalogue, name);
  const lines: string[] = [];
  let bad = false;
  const run = async (kind: string, n: string) => {
    const r = await act(deps, kind, n);
    lines.push(...r.lines);
    bad ||= r.failed;
  };
  if (verb === "set") {
    if (!name) return { lines: ["usage: cred set <name> < secret"], exitCode: 1 };
    if (!known()) return { lines: [`unknown credential ${name}`], exitCode: 1 };
    const text = await deps.readStdin();
    cr.secret = async () => text;
    try { await run("cred_set", name); } finally { cr.secret = undefined; }
  } else if (verb === "check") {
    if (name !== undefined && !known()) return { lines: [`unknown credential ${name}`], exitCode: 1 };
    for (const n of name ? [name] : Object.keys(cr.catalogue)) await run("cred_check", n);
  } else if (verb === "import") {
    for (const n of ["github-app-key", "telegram-bot"]) await run("cred_import", n);
    for (const n of ["github-app-key", "telegram-bot"] as const) lines.push(`${cr.configPaths[n]}: safe to delete after the service has restarted; the scheduler reminds you while it remains`);
  } else if (verb === "remove") {
    if (!name) return { lines: ["usage: cred remove <name>"], exitCode: 1 };
    if (!known()) return { lines: [`unknown credential ${name}`], exitCode: 1 };
    const r = await act(deps, "cred_remove", name);
    lines.push(...(r.failed ? r.lines : [`${name}: removed`]));
    bad ||= r.failed;
  } else if (verb === "list") {
    const index = await cr.store.readIndex();
    for (const e of Object.values(cr.catalogue)) {
      const i = index[e.name];
      const expiry = i?.expires_at ?? (e.expiry === "none" ? "none" : e.expiry === "index" ? "index" : "probe");
      lines.push(`${e.name}: ${i ? "set" : "missing"}, expiry ${expiry}, last check ${i?.last_check ?? "never"}`);
    }
  } else return { lines: ["usage: cred set <name>|list|check [<name>]|import|remove <name>"], exitCode: 1 };
  return { lines, exitCode: bad ? 1 : 0 };
}
