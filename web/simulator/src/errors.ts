export interface ErrorContext {
  /** The rule that failed (a load rule, a scene field) or the kind of run failure. */
  rule?: string;
  placement?: number;
  module?: string;
  export?: string;
  tick?: number;
  cause?: unknown;
}

/** The engine's one error type: it names the rule, or the placement, module, export and tick. */
export class SimulatorError extends Error {
  readonly rule: string | undefined;
  readonly placement: number | undefined;
  readonly module: string | undefined;
  readonly export: string | undefined;
  readonly tick: number | undefined;

  constructor(message: string, context: ErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "SimulatorError";
    this.rule = context.rule;
    this.placement = context.placement;
    this.module = context.module;
    this.export = context.export;
    this.tick = context.tick;
  }
}
