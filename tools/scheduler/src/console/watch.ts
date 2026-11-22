import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { StatePaths } from "../state/paths.ts";

/**
 * Spec 051 AC-3: a question asked, answered or reminded, a claim change, an action applied and a parameter change
 * each trigger a push outside the tick. The console learns of them by watching the state files those writers
 * already keep (the questions log, the claims directory, the action log, the parameter history), so the writers
 * themselves know nothing of the console. `onChange` is the pusher's debounced `notify`.
 */
export function watchConsoleSources(paths: StatePaths, onChange: () => void, log: (rec: Record<string, unknown>) => void = () => {}): { close(): void } {
  const targets: Array<{ dir: string; match: (name: string) => boolean }> = [
    { dir: dirname(paths.questionsLog), match: (n) => n === basename(paths.questionsLog) },
    { dir: paths.claims, match: (n) => n.endsWith(".json") },
    { dir: dirname(paths.actionsLog), match: (n) => n === basename(paths.actionsLog) },
    { dir: dirname(paths.parametersHistory), match: (n) => n === basename(paths.parametersHistory) },
  ];
  const watchers: FSWatcher[] = [];
  for (const t of targets) {
    try {
      const w = watch(t.dir, { persistent: false }, (_event, name) => {
        // A platform that reports no file name still gets its push; the pusher debounces.
        if (name !== null && !t.match(String(name))) return;
        try { onChange(); } catch { /* the console never blocks anything */ }
      });
      w.on("error", (e) => { log({ kind: "console", status: "watch-failed", dir: t.dir, reason: (e as Error).message }); w.close(); });
      watchers.push(w);
    } catch (e) {
      // Without a watch the tick's push still carries the change (AC-3: at least every tick).
      log({ kind: "console", status: "watch-failed", dir: t.dir, reason: (e as Error).message });
    }
  }
  return { close: () => { for (const w of watchers) w.close(); } };
}
