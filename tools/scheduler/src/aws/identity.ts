import type { AwsContext } from "./context.ts";

export const NO_BLOCK_REASON = "no aws block in agents/scheduler.yaml";

/**
 * Spec 022 AC-2: `aws sts get-caller-identity`; AWS is on only when it returns the configured account. A change of
 * state is logged once, and a change to off sends one `aws-access` notification. Nothing else is called while off.
 */
export async function checkIdentity(ctx: AwsContext): Promise<{ on: boolean; reason: string | null; arn?: string; account?: string }> {
  const { state } = ctx;
  let on = false;
  let reason: string | null = null;
  let arn: string | undefined;
  let account: string | undefined;
  if (!ctx.config || !ctx.cli) reason = NO_BLOCK_REASON;
  else {
    try {
      const id = (await ctx.cli.run(["sts", "get-caller-identity"])) as { Account?: string; Arn?: string };
      arn = id.Arn;
      account = id.Account;
      if (id.Account === ctx.config.account_id) on = true;
      else reason = `profile ${ctx.config.profile} is in account ${id.Account ?? "unknown"}, not ${ctx.config.account_id}`;
    } catch (e) {
      reason = (e as Error).message;
    }
  }
  state.identityAt = ctx.now().getTime();
  const changed = state.on !== on || state.reason !== reason;
  state.on = on;
  state.reason = reason;
  if (changed) {
    ctx.log(on ? { kind: "aws-on", account_id: ctx.config?.account_id } : { kind: "aws-off", reason });
    if (!on && ctx.config) await ctx.notifier.notify({ issue: 0, gate: "aws", label: "aws-access", text: `AWS is off for the delivery system: ${reason}. Nothing is launched until this is fixed; the scheduler keeps running. If the SSO session expired, run: aws sso login --sso-session default` });
  }
  return { on, reason, arn, account };
}

/** AWS is on when the identity has been checked and matched; checks it first when it never was. */
export async function ensureOn(ctx: AwsContext): Promise<boolean> {
  if (ctx.state.identityAt === null) await checkIdentity(ctx);
  return ctx.state.on === true;
}
