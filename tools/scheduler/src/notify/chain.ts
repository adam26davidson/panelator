import type { StatePaths } from "../state/paths.ts";
import type { TelegramChannel } from "../telegram/channel.ts";
import { LogNotifier } from "./log.ts";
import { rateLimited } from "./rate-limit.ts";
import { recordedNotifier } from "./recorded.ts";
import { TelegramNotifier } from "./telegram.ts";
import type { Notifier } from "./types.ts";

export interface NotifierChainDeps {
  paths: StatePaths;
  telegram: () => TelegramChannel | null;
  now?: () => Date;
  log: (rec: Record<string, unknown>) => void;
  hours: number;
  repeatHours: number;
}

/** Spec 099 AC-6 and spec 114 AC-5: the one chain every notification goes through; the bin and the tests build the same one. */
export function notifierChain(deps: NotifierChainDeps): Notifier {
  const now = deps.now ?? (() => new Date());
  const { paths } = deps;
  return rateLimited(
    recordedNotifier(
      TelegramNotifier(new LogNotifier(paths.serviceLog), { telegram: deps.telegram, alertsPath: paths.telegramAlerts, outboxPath: paths.telegramOutbox, now, log: deps.log }),
      paths, now, deps.log,
    ),
    { hours: deps.hours, repeatHours: deps.repeatHours, path: paths.notifySent },
    now,
  );
}
