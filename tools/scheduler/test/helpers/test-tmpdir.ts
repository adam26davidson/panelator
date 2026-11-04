import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PREFIX = "panelator-test-";
const STALE_MS = 24 * 3600_000;

/**
 * Vitest global setup: points TMPDIR at a root of this run's own, removed at teardown, so no test
 * has to clean up after itself and a run cannot fill /tmp with its fixtures. A run that was killed
 * never reaches teardown, so each run also removes roots a day old.
 */
export default function setup(): () => void {
  const parent = tmpdir();
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(parent, name);
    if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
  }
  const before = process.env.TMPDIR;
  const root = mkdtempSync(join(parent, PREFIX));
  process.env.TMPDIR = root;
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    rmSync(root, { recursive: true, force: true });
  };
}
