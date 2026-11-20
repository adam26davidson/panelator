import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialEntry } from "./catalogue.ts";

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Spec 099 AC-2: one executable shim per wrapped entry in `<runDir>/bin/`; each runs `bin/cred-exec.ts`, which alone reads the secret. Returns the shim directory, or null when no entry has a wrapper. */
export async function writeShims(runDir: string, entries: CredentialEntry[], opts: { configPath: string; binDir: string; cataloguePath?: string }): Promise<string | null> {
  const wrapped = entries.filter((e) => e.wrapper !== "none");
  if (!wrapped.length) return null;
  const dir = join(runDir, "bin");
  await mkdir(dir, { recursive: true });
  for (const e of wrapped) {
    const w = e.wrapper as { command: string; env: string };
    if (!/^[a-z][a-z0-9._-]*$/.test(w.command)) throw new Error(`${e.name}: wrapper command ${w.command} is not a bare command name`);
    const file = join(dir, w.command);
    await writeFile(file, `#!/bin/sh\nPANELATOR_SHIM_DIR="$(cd "$(dirname "$0")" && pwd)"\nexport PANELATOR_SHIM_DIR\nexec ${sq(join(opts.binDir, "cred-exec.ts"))} --config ${sq(opts.configPath)} ${opts.cataloguePath ? `--catalogue ${sq(opts.cataloguePath)} ` : ""}${sq(e.name)} -- ${sq(w.command)} "$@"\n`);
    await chmod(file, 0o755);
  }
  return dir;
}
