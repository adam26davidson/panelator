import { BANNER_PATTERN, parseBanner, parseStatus, STATUS_PATTERN } from "../lines.ts";
import type { HilTest } from "./index.ts";

export const bootBanner: HilTest = {
  name: "boot-banner",
  async run(board) {
    const { expected, timeouts_s } = board.config;
    const line = await board.waitForLine(BANNER_PATTERN, timeouts_s.banner * 1000);
    if (line === null) return { status: "fail", message: `no boot banner within ${timeouts_s.banner} s`, noBanner: true };
    const banner = parseBanner(line);
    if (!banner) return { status: "fail", message: `unparsable banner: ${line}` };
    if (banner.sha !== board.commit) return { status: "fail", message: `banner sha ${banner.sha}, expected ${board.commit}: ${line}` };
    if (banner.flash_mb !== expected.flash_mb) return { status: "fail", message: `flash_mb ${banner.flash_mb}, expected ${expected.flash_mb}: ${line}` };
    if (banner.psram_mb !== expected.psram_mb) return { status: "fail", message: `psram_mb ${banner.psram_mb}, expected ${expected.psram_mb}: ${line}` };
    const statusLine = await board.waitForLine(STATUS_PATTERN, timeouts_s.status * 1000);
    if (statusLine === null) return { status: "fail", message: `no status line within ${timeouts_s.status} s of the banner` };
    const status = parseStatus(statusLine);
    if (!status) return { status: "fail", message: `unparsable status line: ${statusLine}` };
    if (status.sha !== board.commit) return { status: "fail", message: `status sha ${status.sha}, expected ${board.commit}: ${statusLine}` };
    return { status: "pass" };
  },
};
