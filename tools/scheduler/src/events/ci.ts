import type { CheckSummary } from "../github/types.ts";
import type { StatePaths } from "../state/paths.ts";
import { openIndex } from "./index.ts";
import { record } from "./store.ts";

/**
 * `ci.check` once per (sha, check, status) (spec 012 AC-2). The de-duplication reads the index, so a restart
 * between two reads of the same completed check does not record it twice.
 */
export async function recordChecks(paths: StatePaths, at: Date, ref: { sha: string; pr?: number }, summary: CheckSummary): Promise<void> {
  const completed = summary.runs.filter((r) => r.status === "completed");
  if (!completed.length) return;
  const db = openIndex(paths);
  try {
    const seen = db.prepare("SELECT 1 FROM events WHERE kind = 'ci.check' AND json_extract(payload, '$.sha') = ? AND json_extract(payload, '$.check') = ? AND json_extract(payload, '$.status') = ? LIMIT 1");
    for (const r of completed) {
      const status = r.conclusion ?? "unknown";
      if (seen.get(ref.sha, r.name, status)) continue;
      await record(paths, "ci.check", at, { sha: ref.sha, ...(ref.pr === undefined ? {} : { pr: ref.pr }), check: r.name, status, run_id: r.id });
    }
  } finally {
    db.close();
  }
}
