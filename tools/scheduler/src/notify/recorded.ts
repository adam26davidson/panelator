import type { Notifier } from "./types.ts";
import type { StatePaths } from "../state/paths.ts";
import { record } from "../events/store.ts";

/** Records a `maintainer.contact` event for each notification, then delegates (spec 012 AC-2). */
export function recordedNotifier(inner: Notifier, paths: StatePaths, clock: () => Date = () => new Date()): Notifier {
  return {
    async notify(n) {
      await inner.notify(n);
      await record(paths, "maintainer.contact", clock(), { channel: "log", kind: "notification", issue: n.issue, label: n.label || n.gate, text: n.text }, n.issue ? { issue: n.issue } : {});
    },
  };
}
