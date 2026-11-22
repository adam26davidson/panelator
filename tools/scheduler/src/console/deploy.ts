import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AwsContext } from "../aws/context.ts";
import { readLedger } from "../aws/book.ts";
import { releaseSpend, reserveSpend } from "../aws/ledger.ts";
import type { ConsoleConfig } from "../config.ts";

/**
 * What the console costs a month, in USD (spec 051 AC-7). CloudFront, S3, Lambda, API Gateway and DynamoDB at one user's
 * traffic sit in or near the free tiers; the held change poll is the largest line: about 3,000 requests a day at 25 s each,
 * each reading DynamoDB every 2 seconds (about 40,000 reads a day, on-demand, well under 0.50 USD a month), plus a hosted
 * zone at 0.50 USD when a domain is used, plus the rest of the lines rounded up. The reservation holds the ledger to it.
 */
export const CONSOLE_MONTHLY_USD = 2;
export const CONSOLE_WHAT = "maintainer console (CloudFront, Lambda, DynamoDB)";
export const STACK_NAME = "panelator-console";

export interface DeployOptions {
  ctx: AwsContext;
  console?: ConsoleConfig;
  /** The maintainer login and the OAuth client id (empty before the OAuth app exists). */
  maintainer: string;
  clientId: string;
  credentialsPath: string;
  domain?: string;
  hostedZoneId?: string;
  templatePath: string;
  /** Builds the app and the Lambda bundle; returns the directory of the app and the zip of the function. */
  build: () => Promise<{ appDir: string; lambdaZip: string }>;
  print: (line: string) => void;
}

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

async function readKey(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const j = JSON.parse(await readFile(path, "utf8")) as { api_key?: unknown };
  return typeof j.api_key === "string" && j.api_key ? j.api_key : null;
}

async function held(ctx: AwsContext): Promise<string | null> {
  const l = await readLedger(ctx.paths);
  return l.reservations.find((r) => r.what === CONSOLE_WHAT && r.released_at === null)?.id ?? null;
}

/**
 * The stack's outputs, or null when the stack does not exist. Any other failure (an expired SSO session, the network,
 * throttling) is thrown: it says nothing about whether the stack exists.
 */
async function outputs(ctx: AwsContext): Promise<Record<string, string> | null> {
  try {
    const r = (await ctx.cli!.run(["cloudformation", "describe-stacks", "--stack-name", STACK_NAME])) as { Stacks?: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] };
    return Object.fromEntries((r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  } catch (e) {
    if (/does not exist/i.test((e as Error).message)) return null;
    throw e;
  }
}

/** `console deploy`: reserve inside the cap, then deploy the stack, upload the code and the app. Throws with the reason when refused. */
export async function deployConsole(o: DeployOptions): Promise<{ url: string }> {
  const { ctx } = o;
  if (!ctx.cli) throw new Error("aws is off: no aws block in agents/scheduler.yaml");
  // CloudFront takes certificates only from us-east-1 and the console is one stack, so a domain needs that region.
  if (o.domain && ctx.config?.region !== "us-east-1") throw new Error(`a domain needs the aws region us-east-1 (CloudFront takes certificates only from there); the configured region is ${ctx.config?.region ?? "unset"}`);
  let reservation = await held(ctx);
  if (!reservation) {
    const r = await reserveSpend(ctx, { what: CONSOLE_WHAT, expected_monthly_usd: CONSOLE_MONTHLY_USD, why: "The charter requires a secure, hosted, mobile-friendly interface for the maintainer; the console is that interface.", by: "console deploy" });
    if (!r.ok) throw new Error(`reservation refused: ${r.reason}`);
    reservation = r.id;
  }
  const key = (await readKey(o.credentialsPath)) ?? randomBytes(32).toString("hex");
  const overrides = [`MaintainerLogin=${o.maintainer}`, `GithubClientId=${o.clientId}`, `ApiKeyHash=${hashOf(key)}`, ...(o.domain ? [`DomainName=${o.domain}`, `HostedZoneId=${o.hostedZoneId ?? ""}`] : [])];
  await ctx.cli.runText(["cloudformation", "deploy", "--stack-name", STACK_NAME, "--template-file", o.templatePath, "--capabilities", "CAPABILITY_NAMED_IAM", "--no-fail-on-empty-changeset", "--parameter-overrides", ...overrides], { timeoutMs: 30 * 60_000 });
  const out = await outputs(ctx);
  if (!out?.BucketName || !out.DistributionId || !out.FunctionName || !out.ConsoleUrl) throw new Error("the stack did not report its outputs");
  const built = await o.build();
  await ctx.cli.run(["lambda", "update-function-code", "--function-name", out.FunctionName, "--zip-file", `fileb://${built.lambdaZip}`]);
  await ctx.cli.runText(["s3", "sync", built.appDir, `s3://${out.BucketName}`, "--delete"], { timeoutMs: 10 * 60_000 });
  await ctx.cli.run(["cloudfront", "create-invalidation", "--distribution-id", out.DistributionId, "--paths", "/*"]);
  await mkdir(dirname(o.credentialsPath), { recursive: true });
  await writeFile(o.credentialsPath, JSON.stringify({ api_key: key }), { mode: 0o600 });
  await chmod(o.credentialsPath, 0o600);
  o.print(out.ConsoleUrl);
  return { url: out.ConsoleUrl };
}

/** `console destroy`: delete the stack (emptying the bucket first), then release the reservation. */
export async function destroyConsole(ctx: AwsContext): Promise<void> {
  if (!ctx.cli) throw new Error("aws is off: no aws block in agents/scheduler.yaml");
  const out = await outputs(ctx); // throws unless the answer is the stack's outputs or "no such stack": the reservation stays then
  if (out?.BucketName) await ctx.cli.runText(["s3", "rm", `s3://${out.BucketName}`, "--recursive"], { timeoutMs: 10 * 60_000 });
  if (out) {
    await ctx.cli.run(["cloudformation", "delete-stack", "--stack-name", STACK_NAME]);
    await ctx.cli.runText(["cloudformation", "wait", "stack-delete-complete", "--stack-name", STACK_NAME], { timeoutMs: 30 * 60_000 });
  }
  const id = await held(ctx);
  if (id) await releaseSpend(ctx, id);
}
