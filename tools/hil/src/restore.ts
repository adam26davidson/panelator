// The restore of the last-good image (spec 106 AC-13); the harness's own restore in AC-12 is this function.
import { Log, LiveBoard } from "./board.ts";
import type { BoardConfig } from "./config.ts";
import type { Flasher } from "./flasher.ts";
import { type LastGood } from "./last-good.ts";
import { BANNER_PATTERN, parseBanner, parseStatus, STATUS_PATTERN, type Banner, type Status } from "./lines.ts";
import type { Clock } from "./lock.ts";
import type { Serial } from "./serial.ts";

export type RestoreResult =
  | { ok: true; banner: Banner; status: Status | null }
  | { ok: false; why: "flash-failed" | "no-banner"; message: string };

export interface Hardware {
  flasher: Flasher;
  serial: Serial;
  clock: Clock;
  config: BoardConfig;
}

/** Flashes `image`, resets the board and waits for its banner (then, if asked, for one status line). */
export async function flashAndAwaitBanner(
  hw: Hardware,
  port: string,
  image: { dir: string; commit: string },
  log: Log,
  readStatus: boolean,
): Promise<RestoreResult> {
  const flashed = await hw.flasher.flash(port, image.dir);
  log.add(flashed.output);
  if (!flashed.ok) return { ok: false, why: "flash-failed", message: `flashing ${image.commit} failed` };
  const session = await hw.serial.open(port, { reset: true });
  try {
    const board = new LiveBoard(session, hw.clock, log, image.commit, hw.config);
    const line = await board.waitForLine(BANNER_PATTERN, hw.config.timeouts_s.banner * 1000);
    const banner = line === null ? null : parseBanner(line);
    if (!banner) return { ok: false, why: "no-banner", message: `no boot banner within ${hw.config.timeouts_s.banner} s after flashing ${image.commit}` };
    let status: Status | null = null;
    if (readStatus) {
      const sl = await board.waitForLine(STATUS_PATTERN, hw.config.timeouts_s.status * 1000);
      status = sl === null ? null : parseStatus(sl);
    }
    return { ok: true, banner, status };
  } finally {
    await session.close();
  }
}

export async function restoreLastGood(hw: Hardware, port: string, lastGood: LastGood, log: Log, readStatus: boolean): Promise<RestoreResult> {
  return flashAndAwaitBanner(hw, port, lastGood, log, readStatus);
}
