import { recordEvent } from "../events/store.ts";
import type { StatePaths } from "../state/paths.ts";
import type { Notification, Notifier } from "./types.ts";

/**
 * Spec 012 AC-2: every notification the notifier is handed is a maintainer contact. Installed around the configured
 * notifier, so the log channel today and any later channel record the same way.
 */
export function recordingNotifier(inner: Notifier, paths: StatePaths, channel = "log", clock: () => Date = () => new Date()): Notifier {
  return {
    async notify(n: Notification): Promise<void> {
      await recordEvent(paths, {
        kind: "maintainer.contact", at: clock().toISOString(), ...(n.issue > 0 ? { issue: n.issue } : {}),
        payload: { channel, kind: "notification", ...(n.issue > 0 ? { issue: n.issue } : {}), label: n.label || n.gate, text: n.text },
      });
      await inner.notify(n);
    },
  };
}
