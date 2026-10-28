import type { CheckRun } from "../github/types.ts";
import type { StatePaths } from "../state/paths.ts";
import { recordEvent } from "./store.ts";

const seen = new Set<string>();

/** Spec 012 AC-2: `ci.check` for each completed check run read for a head or `main`, once per (sha, check, status). */
export async function recordCiChecks(paths: StatePaths, runs: CheckRun[], at: Date, ctx: { sha: string; pr?: number; issue?: number }): Promise<void> {
  for (const r of runs) {
    if (r.status !== "completed") continue;
    const status = r.conclusion ?? "unknown";
    const key = `${paths.root}|${ctx.sha}|${r.name}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await recordEvent(paths, {
      kind: "ci.check", at: at.toISOString(), ...(ctx.issue ? { issue: ctx.issue } : {}),
      payload: { sha: ctx.sha, ...(ctx.pr === undefined ? {} : { pr: ctx.pr }), check: r.name, status, run_id: r.id },
    });
  }
}
