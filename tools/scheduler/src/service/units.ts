import { execFile } from "node:child_process";
import { promisify } from "node:util";

type ExecFn = (cmd: string, args: string[]) => Promise<unknown>;
const execFileP: ExecFn = promisify(execFile);

export interface UnitOptions {
  /** cfg.systemd.scope: with scopes off there are no stage units to ask about or stop. */
  enabled: boolean;
  exec?: ExecFn;
}

/** I2: whether a stage scope (`panelator-stage-<run id>`) survived a scheduler crash; `is-active` exits 0 only for an active unit. */
export async function systemdUnitActive(unit: string, opts: UnitOptions): Promise<boolean> {
  if (!opts.enabled) return false;
  try {
    await (opts.exec ?? execFileP)("systemctl", ["--user", "is-active", unit]);
    return true;
  } catch {
    return false;
  }
}

/** I2: best-effort stop of a stage scope after a timeout or bound; errors (unit already gone) are swallowed. */
export async function systemdStopUnit(unit: string, opts: UnitOptions): Promise<void> {
  if (!opts.enabled) return;
  try {
    await (opts.exec ?? execFileP)("systemctl", ["--user", "stop", unit]);
  } catch {
    /* already gone */
  }
}
