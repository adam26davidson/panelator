import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ledgerOf, type LedgerCounts } from "../chain/machine.ts";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "./paths.ts";

const file = (p: StatePaths, issue: number) => join(p.escalations, `${issue}.json`);

/** A ledger written before T4 and C7 reads with their fields defaulted. */
export async function readLedger(p: StatePaths, issue: number): Promise<LedgerCounts | null> {
  try {
    return ledgerOf(JSON.parse(await readFile(file(p, issue), "utf8")) as Parameters<typeof ledgerOf>[0]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeLedger(p: StatePaths, issue: number, input: Parameters<typeof ledgerOf>[0]): Promise<void> {
  const counts = ledgerOf(input);
  const v = validate("escalation-ledger", counts);
  if (!v.ok) throw new Error(`invalid escalation ledger: ${v.errors.join("; ")}`);
  const tmp = file(p, issue) + ".tmp";
  await writeFile(tmp, JSON.stringify(counts, null, 2));
  await rename(tmp, file(p, issue));
}

/** Keeps an abandoned issue's ledger out of the way: if the `abandoned` label is removed, the next claim starts fresh. */
export async function archiveLedger(p: StatePaths, issue: number, now: Date): Promise<void> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  await rename(file(p, issue), join(p.escalations, `${issue}.abandoned-${stamp}.json`)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}
