import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Catalogue } from "./catalogue.ts";

export interface SchedulerCmd {
  node: string;
  script: string;
  config: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Spec 030 AC-3: a per-run directory with the `panelator-scheduler` launcher and one shim per listed credential
 * that has a wrapper. A shim only calls `cred exec`; the secret is read there, in the child's environment.
 * Returns the directory (to put first on PATH) and the launcher path.
 */
export async function writeShims(dir: string, names: readonly string[], catalogue: Catalogue, cmd: SchedulerCmd, agent = "stage"): Promise<{ dir: string; launcher: string }> {
  await mkdir(dir, { recursive: true });
  const launcher = join(dir, "panelator-scheduler");
  await writeFile(launcher, `#!/bin/sh\nPANELATOR_AGENT=${q(agent)} exec ${q(cmd.node)} ${q(cmd.script)} --config ${q(cmd.config)} "$@"\n`);
  await chmod(launcher, 0o755);
  for (const name of names) {
    const e = catalogue[name];
    if (!e) throw new Error(`credential ${name} is not in the catalogue`);
    if (e.wrapper === "none") continue;
    const shim = join(dir, e.wrapper.command);
    await writeFile(shim, `#!/bin/sh\nPANELATOR_SHIM_DIR=${q(dir)} exec ${q(launcher)} cred exec ${q(name)} -- "$@"\n`);
    await chmod(shim, 0o755);
  }
  return { dir, launcher };
}
