import type { AwsCli } from "./cli.ts";

/** Spec 068 AC-6: how a reservation gets smaller, written by its launcher. */
export const SCALE_KINDS = ["lambda-concurrency", "cloudfront-distribution", "dynamodb-throughput"] as const;
export type ScaleKind = (typeof SCALE_KINDS)[number];
export type ScaleSetting =
  | { reserved_concurrency: number }
  | { enabled: boolean }
  | { billing_mode: "PAY_PER_REQUEST" }
  | { billing_mode: "PROVISIONED"; read_capacity_units: number; write_capacity_units: number };
export interface ScaleState { expected_monthly_usd: number; setting: ScaleSetting }
export interface ScaleDescriptor { kind: ScaleKind; id: string; up: ScaleState; down: ScaleState; state?: "up" | "down" }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const keysAre = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);

function settingProblem(kind: ScaleKind, s: unknown): string | null {
  if (!isObj(s)) return "setting must be an object";
  if (kind === "lambda-concurrency") return keysAre(s, ["reserved_concurrency"]) && Number.isInteger(s.reserved_concurrency) && (s.reserved_concurrency as number) >= 0 ? null : "setting must be { reserved_concurrency: an integer of at least 0 }";
  if (kind === "cloudfront-distribution") return keysAre(s, ["enabled"]) && typeof s.enabled === "boolean" ? null : "setting must be { enabled: a boolean }";
  if (s.billing_mode === "PAY_PER_REQUEST" && keysAre(s, ["billing_mode"])) return null;
  if (s.billing_mode === "PROVISIONED" && keysAre(s, ["billing_mode", "read_capacity_units", "write_capacity_units"]) && Number.isInteger(s.read_capacity_units) && (s.read_capacity_units as number) >= 1 && Number.isInteger(s.write_capacity_units) && (s.write_capacity_units as number) >= 1) return null;
  return "setting must be { billing_mode: PAY_PER_REQUEST } or { billing_mode: PROVISIONED, read_capacity_units, write_capacity_units }";
}

/** The reason a descriptor is unusable, or null. `expectedUp` is the reservation's own expected cost. */
export function scaleProblem(scale: unknown, expectedUp: number): string | null {
  if (!isObj(scale)) return "scale must be an object";
  if (!(SCALE_KINDS as readonly string[]).includes(scale.kind as string)) return `scale.kind must be one of ${SCALE_KINDS.join(", ")}`;
  if (typeof scale.id !== "string" || !scale.id) return "scale.id is required";
  const kind = scale.kind as ScaleKind;
  for (const side of ["up", "down"] as const) {
    const st = scale[side];
    if (!isObj(st) || !nonNeg(st.expected_monthly_usd)) return `scale.${side}.expected_monthly_usd must be a number of at least 0`;
    const bad = settingProblem(kind, st.setting);
    if (bad) return `scale.${side}.${bad}`;
  }
  const up = (scale.up as ScaleState).expected_monthly_usd;
  const down = (scale.down as ScaleState).expected_monthly_usd;
  if (up !== expectedUp) return "scale.up.expected_monthly_usd must equal the reservation's expected_monthly_usd";
  if (!(down < up)) return "scale.down.expected_monthly_usd must be below scale.up.expected_monthly_usd";
  return null;
}

/**
 * Spec 068 AC-7: the one place the kinds' `aws` calls are made (through src/aws/cli.ts). Sets the resource to the
 * given state's setting; throws the CLI's error on failure.
 */
export async function applyScale(cli: AwsCli, scale: ScaleDescriptor, target: "up" | "down"): Promise<void> {
  const setting = scale[target].setting;
  if (scale.kind === "lambda-concurrency") {
    await cli.run(["lambda", "put-function-concurrency", "--function-name", scale.id, "--reserved-concurrent-executions", String((setting as { reserved_concurrency: number }).reserved_concurrency)]);
  } else if (scale.kind === "cloudfront-distribution") {
    const got = (await cli.run(["cloudfront", "get-distribution-config", "--id", scale.id])) as { ETag?: string; DistributionConfig?: Record<string, unknown> };
    if (!got.ETag || !got.DistributionConfig) throw new Error("aws cloudfront get-distribution-config returned no ETag or DistributionConfig");
    const config = { ...got.DistributionConfig, Enabled: (setting as { enabled: boolean }).enabled };
    await cli.run(["cloudfront", "update-distribution", "--id", scale.id, "--if-match", got.ETag, "--distribution-config", JSON.stringify(config)]);
  } else {
    const s = setting as { billing_mode: string; read_capacity_units?: number; write_capacity_units?: number };
    const args = ["dynamodb", "update-table", "--table-name", scale.id, "--billing-mode", s.billing_mode];
    if (s.billing_mode === "PROVISIONED") args.push("--provisioned-throughput", `ReadCapacityUnits=${s.read_capacity_units},WriteCapacityUnits=${s.write_capacity_units}`);
    await cli.run(args);
  }
}
