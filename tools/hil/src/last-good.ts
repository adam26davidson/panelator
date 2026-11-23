// The last-good image (spec 106 AC-12 step 6, AC-13): the flashed files, their flasher_args.json and the commit,
// stored by writing a new directory and renaming it over <cache>/last-good/.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFlasherArgs } from "./flasher-args.ts";

export function cacheDir(env: Record<string, string | undefined> = process.env): string {
  return env.PANELATOR_HIL_CACHE || join(homedir(), ".cache", "panelator-hil");
}

export interface LastGood {
  dir: string;
  commit: string;
}

export function storeLastGood(cache: string, buildDir: string, commit: string): void {
  const next = join(cache, `last-good.new-${process.pid}`);
  const old = join(cache, `last-good.old-${process.pid}`);
  const live = join(cache, "last-good");
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  const args = readFlasherArgs(buildDir);
  for (const rel of Object.values(args.flash_files)) {
    mkdirSync(dirname(join(next, rel)), { recursive: true });
    cpSync(join(buildDir, rel), join(next, rel));
  }
  cpSync(join(buildDir, "flasher_args.json"), join(next, "flasher_args.json"));
  writeFileSync(join(next, "commit.txt"), `${commit}\n`);
  if (existsSync(live)) renameSync(live, old);
  renameSync(next, live);
  rmSync(old, { recursive: true, force: true });
}

export function readLastGood(cache: string): LastGood | null {
  const dir = join(cache, "last-good");
  try {
    const commit = readFileSync(join(dir, "commit.txt"), "utf8").trim();
    readFlasherArgs(dir);
    return commit ? { dir, commit } : null;
  } catch {
    return null;
  }
}
