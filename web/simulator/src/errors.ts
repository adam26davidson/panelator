/** An error of the engine: the rule that failed, and where (spec 115 AC-3, AC-7). */
export class SimulatorError extends Error {
  readonly rule: string;
  readonly placement: number | undefined;
  readonly module: string | undefined;
  readonly export: string | undefined;
  readonly tick: number | undefined;

  constructor(
    rule: string,
    message: string,
    where: { placement?: number; module?: string; export?: string; tick?: number; cause?: unknown } = {},
  ) {
    super(message, where.cause === undefined ? undefined : { cause: where.cause });
    this.name = "SimulatorError";
    this.rule = rule;
    this.placement = where.placement;
    this.module = where.module;
    this.export = where.export;
    this.tick = where.tick;
  }
}
