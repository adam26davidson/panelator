import { monthOf, readCap, type AwsContext } from "./context.ts";
import { readCost, readLedger, readNotices } from "./book.ts";
import { fetchActual, pull } from "./cost.ts";
import { checkIdentity } from "./identity.ts";
import { ssoExpiry, ssoExpiryText, type SsoExpiry } from "./sso.ts";

export interface CommandResult {
  lines: string[];
  exitCode: number;
}

const ssoLine = (r: SsoExpiry): string => ("none" in r ? "not SSO" : ssoExpiryText(r));

/** `panelator-scheduler aws-check` (spec 022 AC-3; spec 050 AC-7: no paid call at cap 0). */
export async function awsCheck(ctx: AwsContext, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  if (!ctx.config) return { lines: ["aws: off: no aws block in agents/scheduler.yaml"], exitCode: 1 };
  const id = await checkIdentity(ctx);
  const cap = await readCap(ctx);
  const lines = [`caller: ${id.arn ?? "unknown"} (account ${id.account ?? "unknown"})`, `matches configuration (account ${ctx.config.account_id}): ${id.on ? "yes" : `no${id.reason ? ` (${id.reason})` : ""}`}`];
  let costOk = true;
  if (cap === 0) lines.push("cost call skipped: aws_cap_usd is 0; panelator-scheduler aws pull makes one (about one cent)");
  else if (!id.on) {
    costOk = false;
    lines.push("month-to-date cost: not read (identity does not match)");
  } else {
    try {
      lines.push(`month-to-date cost: ${(await fetchActual(ctx)).toFixed(2)} USD`);
    } catch (e) {
      costOk = false;
      lines.push(`month-to-date cost: failed: ${(e as Error).message}`);
    }
  }
  lines.push(`cap: ${cap} USD`, `sso session expires: ${ssoLine(ssoExpiry(ctx.config.profile, env))}`);
  return { lines, exitCode: id.on && costOk ? 0 : 1 };
}

/** `panelator-scheduler aws [--json]` (spec 022 AC-10; spec 050 AC-8). */
export async function awsStatus(ctx: AwsContext, json: boolean): Promise<CommandResult> {
  const now = ctx.now();
  if (ctx.state.identityAt === null) await checkIdentity(ctx);
  const cap = await readCap(ctx);
  const cost = await readCost(ctx.paths);
  const ledger = await readLedger(ctx.paths);
  const month = monthOf(now);
  const open = ledger.reservations.filter((r) => r.released_at === null);
  const released = ledger.reservations.filter((r) => r.released_at !== null && r.released_at.startsWith(month));
  const notices = await readNotices(ctx.paths, month);
  const view = { on: ctx.state.on === true, off_reason: ctx.state.on ? null : ctx.state.reason, cap_usd: cap, last_pull: cost?.as_of ?? null, cost, open, released, pull_skipped: ctx.state.on === true && cap === 0, pull_failures_today: notices.pull_failures };
  if (json) return { lines: [JSON.stringify(view, null, 2)], exitCode: 0 };
  const lines = [view.on ? "aws: on" : `aws: off: ${view.off_reason}`, `cap: ${cap} USD`, `last pull: ${view.last_pull ?? "never"}`];
  if (view.pull_skipped) lines.push("scheduled pulls skipped: aws_cap_usd is 0");
  if (cost) lines.push(`month ${cost.month}: actual ${cost.actual_usd} USD, forecast ${cost.forecast_usd} USD, reserved ${cost.reserved_usd} USD (${cost.days_elapsed}/${cost.days_in_month} days)`);
  lines.push(`open reservations (${open.length}):`, ...open.map((r) => `  ${r.id}  ${r.expected_monthly_usd} USD/month  ${r.what}  (by ${r.by}, ${r.at})`));
  lines.push(`released this month (${released.length}):`, ...released.map((r) => `  ${r.id}  ${r.expected_monthly_usd} USD/month  ${r.what}  (released ${r.released_at})`));
  return { lines, exitCode: 0 };
}

/** `panelator-scheduler aws pull`: a forced pull, with a word first when the cap is 0 (spec 050 AC-6). */
export async function awsPull(ctx: AwsContext): Promise<CommandResult> {
  if (!ctx.config) return { lines: ["aws: off: no aws block in agents/scheduler.yaml"], exitCode: 1 };
  const lines: string[] = [];
  if ((await readCap(ctx)) === 0) lines.push("aws_cap_usd is 0: this pull makes a Cost Explorer call (about one cent) although the scheduled pulls are skipped.");
  const res = await pull(ctx);
  if (!res.ok) return { lines: [...lines, `pull failed: ${res.reason}`], exitCode: 1 };
  lines.push(JSON.stringify(res.cost, null, 2));
  return { lines, exitCode: 0 };
}
