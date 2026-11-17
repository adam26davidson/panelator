import type { AwsConfig } from "../config.ts";
import type { Notifier } from "../notify/types.ts";
import type { StatePaths } from "../state/paths.ts";
import type { AwsCli } from "./cli.ts";

/** What the AWS code needs; the service and the commands each build one. `config` absent means AWS is off (spec 022 AC-1). */
export interface AwsContext {
  config?: AwsConfig;
  paths: StatePaths;
  cli?: AwsCli;
  /** The parameter store, read only: this code never sets a parameter (AC-11). */
  parameters: { read(name: string): Promise<{ value: unknown }> };
  notifier: Notifier;
  notifyHours: number;
  now: () => Date;
  log: (rec: Record<string, unknown>) => void;
  /** Wakes the standing agents subscribed to an event (`infra_alarm`). */
  emitEvent?: (event: string, payload: unknown) => Promise<void>;
  state: AwsState;
}

/** In memory, per process: whether AWS is on and when the identity was last checked (spec 022 AC-2, spec 050 AC-5). */
export interface AwsState {
  on: boolean | null;
  reason: string | null;
  identityAt: number | null;
  skipping: boolean;
}

export const newAwsState = (): AwsState => ({ on: null, reason: null, identityAt: null, skipping: false });

export async function readCap(ctx: AwsContext): Promise<number> {
  return Number((await ctx.parameters.read("aws_cap_usd")).value);
}

export const monthOf = (d: Date): string => d.toISOString().slice(0, 7);
export const daysInMonth = (d: Date): number => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
